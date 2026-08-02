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
 * Default STAGE window (ms) — the stage-don't-send fix for the live
 * flush-then-late-reply duplicate (2026-08-02, klanker DM, msgs 25843/25844).
 *
 * The quiescence flush used to SEND the composed terminal answer the moment the
 * ~1 s debounce fired. But quiescence is a heuristic, not a completion signal:
 * the model routinely goes quiet for a few seconds BETWEEN its terminal
 * narration and its `reply` tool call (observed gap: 6 s). The flush then posts
 * a PROVISIONAL message that the supersede machinery must claw back — and the
 * claw-back is deliberately conservative (#3429 content gate, #4176 sub-agent
 * liveness hold), so a REWORDED own-answer with a background sub-agent live
 * ships as a visible duplicate even on current main (the accepted residual
 * documented in gateway/subagent-reply-authority.ts).
 *
 * Stage-don't-send removes the provisional send instead of reconciling it:
 * when the quiescence debounce fires, the composed answer is STAGED (held on
 * the still-live turn — the turn is NOT ended, so the typing indicator keeps
 * running) and promoted to a real send only when the completion window closes
 * with no reply:
 *
 *   - the model's `reply` lands → the staged text is DISCARDED (fire-time
 *     re-verify declines on `replyCalled`) — exactly one message, the canonical
 *     reply, on its normal path;
 *   - the REAL turn_end lands first → the turn-flush branch at turn_end
 *     delivers the captured answer (the pre-PR-A path) — promotion at the true
 *     completion signal, usually seconds;
 *   - neither arrives within this window (the KNOWN-UNRELIABLE turn_end case
 *     PR A was built for) → the stage timer promotes through the same
 *     synthetic-turn_end flush path as before.
 *
 * Worst-case added latency for a silent no-op turn whose turn_end never lands
 * is this window (30 s) — still ~5× faster than the ~150 s orphaned-reply
 * backstop PR A replaced, and it buys the hard guarantee that a composing
 * model can no longer race the flush into a duplicate. Env-tunable via
 * SWITCHROOM_ANSWER_STAGE_MS; 0 (or any non-positive value) disables staging
 * and restores the legacy immediate flush.
 */
export const ANSWER_STAGE_MS = 30_000

/**
 * Resolve the stage window from the environment. Returns a positive integer
 * ms, or 0 when explicitly disabled (non-positive value = legacy immediate
 * flush). Unparseable values fail safe to the default.
 */
export function resolveAnswerStageMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.SWITCHROOM_ANSWER_STAGE_MS
  if (raw == null || raw.trim() === '') return ANSWER_STAGE_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) return ANSWER_STAGE_MS
  if (n <= 0) return 0
  return Math.floor(n)
}

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
  /**
   * Stage-don't-send window (ms) — see {@link ANSWER_STAGE_MS}. When > 0 the
   * quiescence expiry STAGES the answer (turn stays live, typing hold) and
   * arms a promotion timer for this many ms instead of flushing immediately;
   * the promotion re-verifies before delivering, so a `reply` that landed in
   * the window discards the staged text, and a real turn_end that landed first
   * delivered it through the turn-flush branch already (its
   * `endCurrentTurnAtomic` → `clear` cancels the promotion). 0 / undefined =
   * legacy immediate flush at quiescence.
   */
  stageWindowMs?: number
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
export class AnswerReadyFlushController<Turn extends object> {
  constructor(private readonly deps: AnswerReadyFlushDeps<Turn>) {}

  /** Turns whose composed answer is currently STAGED (stage-don't-send): the
   *  quiescence debounce fired, but delivery is held for the promotion window.
   *  WeakSet so a superseded/ended turn atom can never leak an entry. */
  private readonly staged = new WeakSet<Turn>()

  private get setTimeoutFn(): (fn: () => void, ms: number) => FlushTimerHandle {
    return this.deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  }

  private get clearTimeoutFn(): (handle: FlushTimerHandle) => void {
    return this.deps.clearTimeoutFn ?? ((h) => clearTimeout(h))
  }

  /** Disarm the flush timer for a turn (idempotent). Clears BOTH phases: a
   *  pending quiescence debounce or a pending staged promotion. */
  clear(turn: Turn | null): void {
    if (turn == null) return
    this.staged.delete(turn)
    const handle = this.deps.getTimerHandle(turn)
    if (handle != null) {
      this.clearTimeoutFn(handle)
      this.deps.setTimerHandle(turn, null)
    }
  }

  /** True IFF `turn`'s composed answer is currently staged (test/diagnostics). */
  isStaged(turn: Turn): boolean {
    return this.staged.has(turn)
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

  /** Timer-expiry callback — BOTH phases share it. Re-pins the turn,
   *  re-verifies quiescence, then either STAGES (first fire, window > 0) or
   *  delivers (legacy immediate mode, or the staged promotion firing after the
   *  completion window closed with no reply). */
  private onExpiry(armedTurn: Turn): void {
    const live = this.deps.getCurrentTurn()
    // Rollover guard: a superseded turn's timer must not fire against a fresh atom.
    if (live == null || live !== armedTurn) return
    this.deps.setTimerHandle(live, null)
    // Fire-time re-verification: a tool that started (or a reply that landed)
    // since the arm deterministically cancels the flush even if the explicit
    // disarm was somehow missed. On a staged promotion this is the DISCARD
    // path: the reply landed inside the window, so the staged provisional text
    // is dropped and the canonical reply is the one message the user sees.
    if (!shouldArmAnswerReadyFlush(this.deps.getArmInput(live))) {
      if (this.staged.delete(live)) {
        this.deps.log?.(
          'answer-ready stage discarded — reply/tool activity landed inside the completion window',
        )
      }
      return
    }
    const stageMs = this.deps.stageWindowMs ?? 0
    if (stageMs > 0 && !this.staged.has(live)) {
      // STAGE-DON'T-SEND (see ANSWER_STAGE_MS): hold the composed answer on
      // the still-live turn instead of posting a provisional message. The turn
      // is NOT ended, so the typing indicator keeps running (the "typing
      // hold") and a real turn_end landing first delivers through the normal
      // turn-flush branch (endCurrentTurnAtomic's `clear` cancels this timer).
      this.staged.add(live)
      this.deps.log?.(
        `answer-ready quiescence — staging composed terminal answer ` +
          `(promotes in ${stageMs}ms unless the reply lands or the turn completes)`,
      )
      const handle = this.setTimeoutFn(() => this.onExpiry(live), stageMs)
      this.deps.setTimerHandle(live, handle)
      return
    }
    if (this.staged.delete(live)) {
      this.deps.log?.(
        'answer-ready stage promoted — completion window closed with no reply; delivering composed terminal answer',
      )
    } else {
      this.deps.log?.('answer-ready quiescence flush — delivering composed terminal answer')
    }
    this.deps.onFlush(live)
  }
}
