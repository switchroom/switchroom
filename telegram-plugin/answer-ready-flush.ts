/**
 * Answer-ready quiescence flush (PR A — "late-delivery" fix).
 *
 * A "silent no-op" turn ends by emitting its final answer as plain transcript
 * `text` (never calling the reply tool). Today that answer is only delivered
 * when claude's `turn_duration`/`turn_end` signal lands — a signal that is
 * KNOWN-UNRELIABLE for terminal-text turns (gateway.ts:13616-13618,
 * 12992-12993). When it doesn't land, delivery falls to the orphaned-reply
 * backstop, whose fuse is itself re-armed by the very answer text it is waiting
 * on (the terminal text stamps `lastStreamEventAt`, so `recentlyStreaming`
 * keeps deferring the ~30 s fuse across the full ~120 s window). Net: a fully
 * composed answer sits ~150-196 s of dead wait AFTER it was ready.
 *
 * This module provides the DETERMINISTIC positive signal that closes that gap:
 * once a turn has a genuine composed terminal answer AND goes quiescent (no
 * in-flight tool, no pending async/background dispatch, no new stream event)
 * for a short debounce (~1 s), a per-turn timer fires and routes the answer
 * into the SAME existing turn-flush send path immediately — instead of waiting
 * on the unreliable turn_end or the multi-minute backstop.
 *
 * The arm/fire decision is factored here as a pure, injectable predicate so the
 * oracle asserts real behavior (mirrors `turn-record-status.ts` /
 * `context-exhaustion.ts`). The gateway feeds it the SAME `decideTurnFlush`
 * classifier the turn-flush branch uses, so a working-preamble, an ack, a tool
 * preamble, or a genuine NO_REPLY turn never arms a spurious flush.
 */

import { decideTurnFlush, type FlushDecisionInput } from './turn-flush-safety.js'

/** Default answer-ready quiescence debounce (ms). Ken approved ~1 s as
 *  "immediate". Env-tunable via SWITCHROOM_ANSWER_READY_FLUSH_MS; 0 (or any
 *  non-positive value) is the kill-switch that disables the flush entirely,
 *  matching the repo's env-flag convention. */
export const ANSWER_READY_FLUSH_MS = 1000

/**
 * Resolve the debounce window from the environment. Returns a positive integer
 * ms, or 0 when disabled (kill-switch) / unparseable / non-positive. The
 * gateway treats 0 as "never arm", so a bad env value fails safe to the default
 * rather than to a hot-loop.
 */
export function resolveAnswerReadyFlushMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.SWITCHROOM_ANSWER_READY_FLUSH_MS
  if (raw == null || raw.trim() === '') return ANSWER_READY_FLUSH_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) return ANSWER_READY_FLUSH_MS
  // Explicit 0 (or negative) = operator kill-switch → disabled.
  if (n <= 0) return 0
  return Math.floor(n)
}

export interface AnswerReadyArmInput {
  /** The exact `decideTurnFlush` inputs the turn-flush branch resolves at
   *  turn_end. Reusing the classifier is what guarantees the debounce only
   *  fires on a genuine composed final answer — never a silent marker, an
   *  empty turn, a reply-already-served turn, or a sub-agent turn. */
  flush: FlushDecisionInput
  /** `toolFlightTracker.inFlightCount()` — a live surface tool means the model
   *  is still working, not quiescent. */
  inFlightToolCount: number
  /** `pendingProgress.hasPendingAsyncDispatch(key)` — a detached background
   *  dispatch (Bash run_in_background, async tool) means work is still pending
   *  even though `inFlightCount` is 0. */
  hasPendingAsyncDispatch: boolean
  /** The resolved debounce window; 0 disables (kill-switch). */
  flushWindowMs: number
}

/**
 * Should the answer-ready quiescence timer be armed / fired right now?
 *
 * True iff the kill-switch is off AND the turn has a genuine flushable answer
 * (`decideTurnFlush` → `flush`) AND the turn is genuinely quiescent (no
 * in-flight surface tool, no pending async/background dispatch). This same
 * predicate gates BOTH the arm (in the `text` handler) AND the fire-time
 * re-verification (in the timer callback) — so a tool that started after the
 * arm, or a reply that landed in the interim, deterministically cancels the
 * flush at fire time even if the explicit disarm was somehow missed.
 */
export function shouldArmAnswerReadyFlush(input: AnswerReadyArmInput): boolean {
  if (input.flushWindowMs <= 0) return false
  if (input.inFlightToolCount > 0) return false
  if (input.hasPendingAsyncDispatch) return false
  return decideTurnFlush(input.flush).kind === 'flush'
}
