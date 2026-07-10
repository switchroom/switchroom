import type { Subagent } from '../registry/subagents-schema.js'

export interface WorkerFeedDispatch {
  /** True when the sub-agent was dispatched with `run_in_background: true`. */
  isBackground: boolean
  /**
   * The human-readable task to render in the feed header
   * ("🛠 Worker · <feedDescription>").
   */
  feedDescription: string
  /**
   * True when a registry row was found for the worker. A MISSING row must
   * not be silently read as "foreground" by callers deciding the status
   * surface — a row-less worker is most often a nested (depth-2+) dispatch
   * whose row hasn't linked yet, and nesting it into an unrelated live main
   * turn (or dropping it) is exactly the depth-2+ freeze/misroute bug.
   */
  hasRow: boolean
  /**
   * True when the row records a NESTED dispatch (spawned by another
   * sub-agent — `parent_agent_id` set). A nested worker can never nest into
   * the gateway's current turn (its parent is a worker, not a live turn),
   * so callers must surface it via the worker feed regardless of its own
   * background flag, and must not deliver a user handback for it (its
   * result returns to its dispatching worker as the Task tool result).
   */
  isNested: boolean
}

/**
 * Resolve the two registry-derived inputs the worker-activity feed needs:
 * whether the sub-agent was a background dispatch, and the task description
 * to show in the feed header.
 *
 * The live watcher only carries a generic 'sub-agent' label — it never
 * reassigns `description` from the worker jsonl. The real dispatch-time
 * description lives in the registry `subagents` row (written by the pretool
 * hook from the `Agent(description:)` input). Prefer it; fall back to the
 * watcher's label only when the row is missing or its description is empty.
 *
 * Pure + DB-free so it pins the #2002 behavior under both vitest and bun —
 * see worker-feed-dispatch.test.ts. The gateway must never inline this
 * decision again: a regression here silently reverts the feed header to
 * "· sub-agent".
 */
/**
 * `entryBackground` (fix #1(+#2)): the in-memory watcher entry's own cached
 * `background` flag (`WorkerEntry.background`), passed by the gateway as a
 * graceful-degradation fallback for when the registry row (`sub`) is
 * missing — most often because `jsonl_agent_id` never linked (unreadable
 * meta.json, or an ambiguous fuzzy backfill — see fix #3). Without this, a
 * missing row hard-defaults `isBackground` to `false`, silently dropping a
 * completed background worker's handback (the gateway's `onFinish` treats
 * `false` as "nothing to deliver — it returns inline"). Ignored entirely
 * when `sub` resolves — the registry row is always the authoritative
 * source once it links.
 */
export function resolveWorkerFeedDispatch(
  sub: Subagent | null,
  watcherDescription: string,
  entryBackground?: boolean,
): WorkerFeedDispatch {
  return {
    isBackground: sub?.background ?? entryBackground ?? false,
    feedDescription: (sub?.description ?? '') || watcherDescription,
    hasRow: sub != null,
    isNested: sub?.parent_agent_id != null,
  }
}
