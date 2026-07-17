/**
 * Turn-flush pre-delivery suppression decision (S1 fix, fable red-team
 * 2026-07-17 — `~klanker/work/fable-redteam-delivery-20260717/REDTEAM.md`).
 *
 * Before the turn-flush backstop posts the captured terminal answer, it asks:
 * "did a reply already land for this turn in the last ~2s?" (a race guard for
 * a reply whose IPC signal hadn't registered when `decideTurnFlush` ran, and
 * for answer-stream materializations that already delivered the answer text).
 *
 * The OLD predicate — `getRecentOutboundCount(chatId, 2) > 0` — counted ANY
 * assistant row in the WHOLE chat: a background worker's `progress_update`, a
 * command ack / restart notice, or a reply in a DIFFERENT forum topic all
 * suppressed the flush, and the branch then CLOSED the delivery obligation —
 * the user's real answer was dropped with no re-present. This module scopes
 * the predicate to a SUBSTANTIVE (≥ `FINAL_ANSWER_MIN_CHARS`) outbound in the
 * SAME thread, via the injected `hasSubstantiveOutbound` (the gateway wires
 * `hasOutboundDeliveredSince`, whose thread/length semantics are pinned by
 * `history.test.ts`).
 *
 * Residual (documented, accepted): a ≥200-char same-thread non-answer outbound
 * (e.g. an unusually long progress update) inside the 2s window still
 * suppresses — the history schema has no message-kind column to discriminate
 * further. That residual is why the CALLER must NOT close the obligation on
 * suppression: a genuine reply closes its own obligation idempotently, while a
 * false-positive suppression leaves it open for the liveness floor / sweep.
 */

import { FINAL_ANSWER_MIN_CHARS } from '../final-answer-detect.js'

/** How far back a just-landed reply can be and still suppress the flush. */
export const FLUSH_SUPPRESSION_WINDOW_MS = 2000

export interface FlushSuppressionDeps {
  /** Durable substantive-outbound oracle — the gateway passes
   *  `hasOutboundDeliveredSince` (thread-scoped, length-floored). */
  hasSubstantiveOutbound(
    chatId: string,
    sinceMs: number,
    threadId: number | null,
    minChars: number,
  ): boolean
}

export interface FlushSuppressionArgs {
  chatId: string
  /** The turn's origin thread. `null` = chat root / DM (matches the
   *  `hasOutboundDeliveredSince` explicit-null semantics — never pass
   *  `undefined`, which would match ANY thread and re-open the
   *  cross-topic false positive this module exists to close). */
  threadId: number | null
  /** Length of the captured answer the flush is about to deliver. The
   *  length floor is `min(FINAL_ANSWER_MIN_CHARS, answerLength)`: a row
   *  can only suppress the flush if it is at least as long as the answer
   *  itself (up to the 200-char substantive cap). A TERSE captured answer
   *  ("Yes — done.") is therefore still suppressible by its own short
   *  answer-stream materialization (avoiding a duplicate bubble), while a
   *  short progress ping can never suppress a LONG composed answer. */
  answerLength: number
  nowMs: number
}

/**
 * True iff the flush should be suppressed: a substantive same-thread outbound
 * landed within the suppression window. Fails open (no suppression) on oracle
 * errors — delivering a possible duplicate beats dropping the only copy.
 */
export function shouldSuppressTurnFlush(
  deps: FlushSuppressionDeps,
  args: FlushSuppressionArgs,
): boolean {
  const minChars = Math.max(1, Math.min(FINAL_ANSWER_MIN_CHARS, args.answerLength))
  try {
    return deps.hasSubstantiveOutbound(
      args.chatId,
      args.nowMs - FLUSH_SUPPRESSION_WINDOW_MS,
      args.threadId,
      minChars,
    )
  } catch {
    return false
  }
}
