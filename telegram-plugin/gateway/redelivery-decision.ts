/**
 * Crash-survival redelivery — the PURE decision predicate.
 *
 * When the gateway process crashes (or the hang-watchdog kills it) BEFORE the
 * in-memory flush timer fires, the model's completed final answer — captured
 * only in the in-memory buffer — is lost, and the user gets permanent silence.
 * The answer text is, however, still durable on disk in the claude session
 * transcript. On the next boot we can re-project that trailing text and re-send
 * it. This module owns the "should we re-send, and how" decision so it is
 * unit-testable without booting a gateway (the boot block only wires I/O to it).
 *
 * The delivery oracle is DURABLE TEXT-IDENTITY, not a chat+time window: we
 * redeliver only if the PROJECTED final-answer text was NOT already delivered
 * (matched against delivered `messages` rows — see `hasOutboundWithText`). A
 * time-windowed "any assistant row since started_at" oracle is UNSOUND here:
 * an interim `progress_update` or a streamed partial chunk lands a mid-turn
 * `role='assistant'` row and would false-positive "delivered", suppressing a
 * genuinely-undelivered final answer (the exact MISS this fix exists to close).
 *
 * The redelivered text is FRAMED as a recovered/interrupted draft rather than
 * presented as a clean final answer: the transcript cannot durably distinguish
 * "final answer complete" from "answer-so-far, more tools intended", so we never
 * assert it is the finished answer.
 */

/** The short preamble that frames a redelivered draft. */
export const REDELIVERY_PREFIX = 'Recovered from an interrupted turn:'

export interface RedeliverDecisionInput {
  /**
   * The trailing assistant text re-projected from the interrupted turn's own
   * transcript (after the last tool_use). Empty string when the transcript had
   * no trailing text to redeliver.
   */
  capturedText: string
  /**
   * True when the trailing transcript content AFTER the last tool_use is text
   * (not a dangling tool_use). Bounds the preamble-vs-final ambiguity (R2): a
   * turn whose last on-disk event was a tool_use is mid-stream, not a finished
   * answer, so we do not redeliver it.
   */
  trailingIsText: boolean
  /**
   * Result of the DURABLE text-identity oracle: true iff the projected answer
   * text was already delivered to this chat/thread (`hasOutboundWithText`).
   */
  hasDeliveredText: boolean
  /** True iff `answer_redelivered_at` is already stamped (at-most-once ledger). */
  alreadyRedelivered: boolean
  /** Age of the interrupted turn in ms (`now - started_at`). */
  ageMs: number
  /** Staleness failsafe (`RESUME_MAX_AGE_MS`, default 3h). */
  maxAgeMs: number
}

export type RedeliverSkipReason =
  | 'empty-text'
  | 'trailing-not-text'
  | 'already-delivered'
  | 'already-redelivered'
  | 'stale'

export interface RedeliverDecision {
  redeliver: boolean
  /** Present iff `redeliver` is true — the framed text to send. */
  framedText?: string
  /** Present iff `redeliver` is false — why we declined. */
  skipReason?: RedeliverSkipReason
}

/**
 * Frame a captured draft for redelivery — a short recovered-draft preamble
 * above the model's own words. Pure; exported for the boot wiring + tests.
 */
export function frameRedelivery(capturedText: string): string {
  return `${REDELIVERY_PREFIX}\n\n${capturedText.trim()}`
}

/**
 * Decide whether — and with what framed text — to redeliver an interrupted
 * turn's captured-but-undelivered final answer. Pure: no clock, no I/O.
 *
 * Precedence of skip reasons is deliberate (most-specific first): a turn with
 * no trailing text can never redeliver regardless of delivery/age; a delivered
 * or already-redelivered answer is skipped before the age failsafe so the
 * at-most-once guarantee never depends on staleness.
 */
export function decideRedeliver(input: RedeliverDecisionInput): RedeliverDecision {
  const text = input.capturedText.trim()
  if (text.length === 0) return { redeliver: false, skipReason: 'empty-text' }
  if (!input.trailingIsText) return { redeliver: false, skipReason: 'trailing-not-text' }
  if (input.alreadyRedelivered) return { redeliver: false, skipReason: 'already-redelivered' }
  if (input.hasDeliveredText) return { redeliver: false, skipReason: 'already-delivered' }
  if (input.ageMs > input.maxAgeMs) return { redeliver: false, skipReason: 'stale' }
  return { redeliver: true, framedText: frameRedelivery(text) }
}
