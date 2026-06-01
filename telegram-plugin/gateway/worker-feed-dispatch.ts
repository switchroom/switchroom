import type { Subagent } from '../registry/subagents-schema.js'

export interface WorkerFeedDispatch {
  /** True when the sub-agent was dispatched with `run_in_background: true`. */
  isBackground: boolean
  /**
   * The human-readable task to render in the feed header
   * ("🛠 Worker · <feedDescription>").
   */
  feedDescription: string
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
export function resolveWorkerFeedDispatch(
  sub: Subagent | null,
  watcherDescription: string,
): WorkerFeedDispatch {
  return {
    isBackground: sub?.background ?? false,
    feedDescription: (sub?.description ?? '') || watcherDescription,
  }
}
