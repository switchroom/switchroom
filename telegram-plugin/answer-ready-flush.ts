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

/** Opaque timer handle. Real code passes Node's `setTimeout` return; tests can
 *  inject fake-timer handles. */
export type FlushTimerHandle = ReturnType<typeof setTimeout>

/**
 * Injectable dependencies for {@link AnswerReadyFlushController}. Everything the
 * orchestration needs from the gateway is threaded through here so the REAL
 * arm / debounce / rollover-guard / fire-time-re-verify / disarm logic is
 * unit-testable without importing the 30k-line gateway module (which has a
 * top-level startup IIFE and cannot be imported). `Turn` is the gateway's
 * `CurrentTurn`; the controller only touches it through these accessors.
 */
export interface AnswerReadyFlushDeps<Turn> {
  /** The live turn atom (gateway `currentTurn`). Read at arm time and re-read at
   *  fire time so a superseded turn's timer never fires against a fresh atom. */
  getCurrentTurn(): Turn | null
  /** Resolve the `shouldArmAnswerReadyFlush` inputs for a turn (chat/reply/
   *  captured-text + live tool-flight + pending-async + the window). */
  getArmInput(turn: Turn): AnswerReadyArmInput
  /** Read / write the per-turn timer handle (stored on the `CurrentTurn`). */
  getTimerHandle(turn: Turn): FlushTimerHandle | null
  setTimerHandle(turn: Turn, handle: FlushTimerHandle | null): void
  /**
   * Deliver the composed answer — dispatch the positive `answer-ready-quiescence`
   * synthetic turn_end that routes through the EXISTING turn-flush send path
   * (endCurrentTurnAtomic → send-gated IIFE → PR-B honest record). The controller
   * calls this AT MOST ONCE per turn (guarded by the rollover + timer-cleared
   * checks). endCurrentTurnAtomic then nulls the atom, so a later real turn_end
   * short-circuits — the exactly-once guarantee.
   */
  onFlush(turn: Turn): void
  /** Injectable timer primitives (default to the globals). */
  setTimeoutFn?: (fn: () => void, ms: number) => FlushTimerHandle
  clearTimeoutFn?: (handle: FlushTimerHandle) => void
  log?: (msg: string) => void
}

/**
 * The deterministic answer-ready quiescence flush orchestration, extracted from
 * the gateway so it is testable as a unit (mirrors `withTurnEndGateBackstop`).
 *
 * - `reset()` — called from `case 'text'`: clear any pending timer, then (re)arm
 *   iff the turn currently classifies as a genuine flushable answer AND is
 *   quiescent. Each text chunk re-arms → the debounce.
 * - `clear(turn)` — the DISARM: called on any tool activity and from
 *   `endCurrentTurnAtomic`. A real turn_end that lands first cancels a pending
 *   flush (exactly-once), and a resumed turn (tool started) cancels a stale one.
 *
 * On fire the controller re-pins `getCurrentTurn() === turn` (rollover guard),
 * clears the handle, RE-VERIFIES quiescence (a tool that started / a reply that
 * landed since the arm cancels the flush deterministically), then dispatches
 * exactly one `onFlush`.
 */
export class AnswerReadyFlushController<Turn> {
  constructor(private readonly deps: AnswerReadyFlushDeps<Turn>) {}

  private get setTimeoutFn(): (fn: () => void, ms: number) => FlushTimerHandle {
    return this.deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  }

  private get clearTimeoutFn(): (handle: FlushTimerHandle) => void {
    return this.deps.clearTimeoutFn ?? ((h) => clearTimeout(h))
  }

  /** Disarm the flush timer for a turn (idempotent). */
  clear(turn: Turn | null): void {
    if (turn == null) return
    const handle = this.deps.getTimerHandle(turn)
    if (handle != null) {
      this.clearTimeoutFn(handle)
      this.deps.setTimerHandle(turn, null)
    }
  }

  /** (Re)arm the flush timer for the current turn — the debounce. */
  reset(): void {
    const turn = this.deps.getCurrentTurn()
    this.clear(turn)
    if (turn == null) return
    const armInput = this.deps.getArmInput(turn)
    if (!shouldArmAnswerReadyFlush(armInput)) return
    const handle = this.setTimeoutFn(() => this.onExpiry(turn), armInput.flushWindowMs)
    this.deps.setTimerHandle(turn, handle)
  }

  /** Timer-expiry callback. Re-pins the turn, re-verifies quiescence, fires once. */
  private onExpiry(armedTurn: Turn): void {
    const live = this.deps.getCurrentTurn()
    // Rollover guard: a superseded turn's timer must not fire against a fresh atom.
    if (live == null || live !== armedTurn) return
    this.deps.setTimerHandle(live, null)
    // Fire-time re-verification: a tool that started (or a reply that landed)
    // since the arm deterministically cancels the flush even if the explicit
    // disarm was somehow missed.
    if (!shouldArmAnswerReadyFlush(this.deps.getArmInput(live))) return
    this.deps.log?.('answer-ready quiescence flush — delivering composed terminal answer')
    this.deps.onFlush(live)
  }
}
