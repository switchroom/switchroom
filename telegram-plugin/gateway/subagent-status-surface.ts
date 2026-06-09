/**
 * Where does a sub-agent's live status go?
 *
 * A sub-agent's progress is surfaced on one of four "surfaces". This pure
 * decision picks which, so the routing is provable by total enumeration rather
 * than buried in the gateway's imperative branches.
 *
 *   - `nest`         — a FOREGROUND sub-agent running inside a LIVE parent turn:
 *                      its narrative nests under the parent's activity draft
 *                      (the progress card). The default, unchanged.
 *   - `worker-feed`  — a BACKGROUND worker (the `🛠 Worker` edit-in-place
 *                      message), OR a FOREGROUND sub-agent that has NO live
 *                      parent turn to nest into (dispatched outside a turn, or
 *                      the turn ended while it kept running). The latter is the
 *                      2026-06-09 fix: extended autonomous work was invisible
 *                      because foreground status was turn-scoped and a sub-agent
 *                      with no turn silently returned. It now reuses the worker
 *                      feed (with the same owner-DM fallback background workers
 *                      already use), so post-turn work is always visible.
 *   - `legacy-relay` — a BACKGROUND worker when the worker feed is OFF: fall
 *                      back to the legacy "still working" injected-inbound relay.
 *   - `skip`         — nothing to surface (kill-switch off for an orphaned
 *                      foreground, or no feed to surface it through).
 *
 * Determinism: the input space is 4 booleans = 16 rows, enumerated and proven
 * in subagent-status-surface.test.ts (operator standard
 * feedback_prove_finite_fsm_not_sample). The load-bearing invariant: an
 * orphaned foreground sub-agent (no live turn) is `worker-feed`, never `skip`,
 * whenever the orphan-status flag and the feed are both on.
 */

export type SubagentStatusSurface = 'nest' | 'worker-feed' | 'legacy-relay' | 'skip'

export interface SubagentStatusSurfaceInput {
  /** run_in_background dispatch (registry `subagents.background`). */
  isBackground: boolean
  /**
   * A LIVE parent turn exists to nest this (foreground) sub-agent into.
   * onProgress: `currentTurn != null`. onFinish: `currentTurn != null && it was
   * actually nested` (so a foreground sub-agent that was surfaced via the worker
   * feed — never nested — finalizes through the feed, not a turn collapse).
   * Ignored for background sub-agents.
   */
  liveTurnPresent: boolean
  /** SWITCHROOM_WORKER_ACTIVITY_FEED on. */
  workerFeedEnabled: boolean
  /** SWITCHROOM_ORPHAN_SUBAGENT_STATUS on — surface no-parent-turn foreground
   *  sub-agents via the worker feed. Off = pre-fix behaviour (invisible). */
  orphanStatusEnabled: boolean
}

export function resolveSubagentStatusSurface(
  input: SubagentStatusSurfaceInput,
): SubagentStatusSurface {
  if (!input.isBackground) {
    // Foreground sub-agent.
    if (input.liveTurnPresent) return 'nest'
    // Orphaned foreground: no live turn to nest into — the invisible case.
    if (!input.orphanStatusEnabled) return 'skip' // kill switch: pre-fix behaviour
    return input.workerFeedEnabled ? 'worker-feed' : 'skip' // surfacing needs the feed
  }
  // Background worker.
  return input.workerFeedEnabled ? 'worker-feed' : 'legacy-relay'
}

/** SWITCHROOM_ORPHAN_SUBAGENT_STATUS — default ON; `=0` restores pre-fix (invisible) behaviour. */
export function isOrphanSubagentStatusEnabled(envVal: string | undefined): boolean {
  return envVal !== '0'
}
