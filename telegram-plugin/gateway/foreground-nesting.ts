/**
 * Pure state-transition helpers for Model A foreground sub-agent activity
 * nesting (#2027). Extracted from gateway.ts so the `replyCalled` gate is
 * unit-testable on its own — the exact seam #2027 shipped without, which let
 * the feature silently no-op for every ack-first turn (reply "On it…" then
 * delegate) and go unnoticed in production. See
 * `tests/foreground-nesting.test.ts`.
 *
 * Subscription-honest: every caller is pure jsonl-tail → render, no model
 * call. These functions decide *whether/what* to render; the gateway owns the
 * `currentTurn` mutation and the Telegram edit.
 */

export interface ForegroundProgressGate {
  /** `SWITCHROOM_FOREGROUND_SUBAGENT_NESTING !== '0'` — the kill-switch. */
  nestingEnabled: boolean
  /**
   * Whether the parent turn has already emitted a reply. Accepted as input
   * but intentionally NOT a gate: a foreground `Task` is a *blocking* call,
   * so the parent cannot have issued its FINAL answer while the sub-agent is
   * still running — any `replyCalled === true` observed here is therefore an
   * *interim* ack. The pre-fix code bailed on this flag, which is precisely
   * why ack-first turns showed zero live foreground activity.
   */
  replyCalled: boolean
}

/**
 * Whether a foreground sub-agent progress tick should accumulate its narrative
 * and re-render the activity feed. Gated ONLY by the kill-switch — never by
 * `replyCalled` (see the field doc above).
 */
export function shouldRenderForegroundProgress(g: ForegroundProgressGate): boolean {
  return g.nestingEnabled
}

export type ForegroundFinishAction = 'recompose' | 'handoff-clear' | 'none'

export interface ForegroundFinishInput {
  /** Was this agentId actually an active foreground sub-agent we tracked? */
  removed: boolean
  /** Has the parent turn already emitted a reply (an interim ack)? */
  replyCalled: boolean
  /** Foreground sub-agents still active AFTER removing the finished one. */
  remainingForeground: number
}

/**
 * What the gateway should do when a foreground sub-agent finishes:
 *
 *  - `'none'`         — it wasn't one we were tracking (e.g. background, or a
 *                       stale boot row); leave the feed alone.
 *  - `'handoff-clear'`— it was the LAST foreground sub-agent and the parent
 *                       has already acked. The re-opened post-ack feed now
 *                       hands off to the imminent final answer, mirroring the
 *                       first-reply hand-off. (turn_end is the safety net if
 *                       this is somehow missed.)
 *  - `'recompose'`    — collapse the finished sub-agent's block and re-render
 *                       (pre-ack flow, or other sub-agents still running).
 */
export function foregroundFinishAction(i: ForegroundFinishInput): ForegroundFinishAction {
  if (!i.removed) return 'none'
  if (i.replyCalled && i.remainingForeground === 0) return 'handoff-clear'
  return 'recompose'
}
