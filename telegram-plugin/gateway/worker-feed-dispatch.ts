import type { Subagent } from '../registry/subagents-schema.js'

/**
 * The narrow slice of the worker-activity feed `handleWorkerResume` needs —
 * structurally satisfied by `WorkerActivityFeed` (worker-activity-feed.ts)
 * without importing it (keeps this module dependency-light and the seam
 * trivially mockable in tests).
 */
export interface WorkerFeedForResume {
  resurrect(agentId: string): void
}

/**
 * Issue #3373 (SendMessage-resume feed re-surface) — the gateway's `onResume`
 * handler body, extracted so the seam is unit-testable and gateway.ts keeps
 * only a thin delegation (the line-ratchet drains inline bodies).
 *
 * A worker with a GENUINE terminal completion that is resumed via SendMessage
 * grows its jsonl past the terminal boundary and is re-registered live by the
 * watcher (#3315). This clears the feed's terminal `finalized` latch
 * (`feed.resurrect`) so the resumed worker's next onProgress cue repaints a
 * fresh live row — without it the latch swallows every resumed cue and the
 * worker reads as silence. Distinct from the #3023 `onResurrect` path: no
 * bounded-chain budget (a worker may be stopped/resumed any number of times).
 *
 * Best-effort: a resurrect failure is logged, never thrown back into the
 * watcher's poll loop. `feed` may be null/undefined (feed disabled) — the
 * re-surface log line is still emitted for the audit trail.
 */
export function handleWorkerResume(
  feed: WorkerFeedForResume | null | undefined,
  agentId: string,
  log: (msg: string) => void,
): void {
  try {
    feed?.resurrect(agentId)
  } catch (err) {
    log(`telegram gateway: worker resume feed re-surface error agent=${agentId}: ${(err as Error).message}`)
  }
  log(`telegram gateway: worker ${agentId} card RE-SURFACED — resumed via SendMessage after a genuine terminal (issue #3373)`)
}

/**
 * Worker-feed origin-race defer decision (issue: DM-misrouted worker card).
 *
 * The gateway picks a worker card's destination on the FIRST progress tick of
 * a new sub-agent. That tick can beat the async `jsonl_agent_id` backfill that
 * links the sub-agent's registry row to its origin turn (retried ~every 3s).
 * Until the link lands, origin resolution returns null and the gateway's
 * `resolveWorkerFeedChat` hard-falls back to the owner DM — CREATING the card
 * there. The origin (supergroup + forum topic) resolves ~3s later, but the DM
 * card already exists and stays the visible one.
 *
 * Decision: DEFER card creation while the agent is not yet linked to its
 * origin AND no card exists yet for it. The subagent-watcher re-fires within
 * seconds; once the backfill completes the origin resolves and the card is
 * created in the correct chat+topic. Only CARD CREATION is deferred — if a
 * card already exists, updates always proceed (`defer:false`). A bounded
 * counter caps the wait: after `maxDeferrals` unlinked ticks (pathological
 * backfill failure) it stops deferring so active work always gets a card.
 *
 * Pure so the seam is unit-testable — see worker-feed-dispatch.test.ts. The
 * gateway must never inline this decision again.
 */
export function decideWorkerFeedOriginDefer(input: {
  /** True once `resolveSubagentOriginChat` returns a chat (row linked). */
  originResolved: boolean
  /** True if the feed already has a posted message for this worker. */
  cardExists: boolean
  /** Consecutive prior deferrals for this agent (0 on the first tick). */
  priorDeferrals: number
  /** Max consecutive deferrals before painting anyway. */
  maxDeferrals: number
}): { defer: boolean; deferrals: number } {
  const { originResolved, cardExists, priorDeferrals, maxDeferrals } = input
  // A card already exists, or the origin has resolved: never defer.
  if (originResolved || cardExists) return { defer: false, deferrals: 0 }
  const deferrals = priorDeferrals + 1
  // Bounded: stop deferring once we've waited long enough for the backfill.
  if (deferrals >= maxDeferrals) return { defer: false, deferrals }
  return { defer: true, deferrals }
}

/**
 * The FULL worker-feed destination decision for a single onProgress tick,
 * extracted verbatim from the gateway's inline `onProgress` block (issue
 * #3460). It folds two concerns that the gateway used to run inline:
 *
 *  1. the origin-race defer choice (`decideWorkerFeedOriginDefer`), and
 *  2. the chat/thread RESOLUTION the gateway's `resolveWorkerFeedChat`
 *     performed (origin chat → fleet chat / stamp-turn fallback → owner DM),
 *     including the exhausted-defer stamp-turn forum-thread carry (#3458).
 *
 * Returning a plain decision object lets the gateway keep only a thin
 * delegation (defer-map bookkeeping + the two audit logs + the feed.update)
 * and gives this whole path REAL regression coverage — the test drives THIS
 * function, the same code the gateway runs, instead of a hand-rolled replica.
 *
 * Pure and side-effect-free: the two audit-log side effects the gateway used
 * to emit inline (`exhausted`, `ownerDmFallback`) are returned as flags so the
 * caller performs them against its module-level state. Behavior — routing — is
 * identical to the prior inline path; only the seam moved.
 *
 * Precedence for a PAINT (mirrors `resolveWorkerFeedChat`):
 *   origin chat (when resolved, non-empty) → fleet chat, else stamp-turn chat
 *   when no fleet chat is configured (carrying the stamp-turn forum topic) →
 *   owner DM (durable floor). Never returns an empty chat for a paint unless
 *   every source is empty.
 */
export type WorkerFeedDestination =
  | { action: 'defer'; deferrals: number }
  | {
      action: 'paint'
      chatId: string
      threadId: number | undefined
      /** New consecutive-deferral count to persist (0 once painting resumes). */
      deferrals: number
      /** True when painting only because the bounded defer cap was hit and the
       *  origin never linked — the gateway logs the "never linked" audit line. */
      exhausted: boolean
      /** True when the paint fell all the way to the owner DM (origin unresolved
       *  AND no fleet/stamp chat) — the gateway logs the once-per-agent misroute. */
      ownerDmFallback: boolean
    }

export function decideWorkerFeedDestination(input: {
  /** Resolved origin chat/topic (`resolveSubagentOriginChat`), or null if the
   *  `jsonl_agent_id` backfill hasn't linked the row to its origin turn yet. */
  origin: { chatId: string; threadId?: number } | null
  /** True if the feed already has a posted message for this worker. */
  cardExists: boolean
  /** Consecutive prior deferrals for this agent (0 on the first tick). */
  priorDeferrals: number
  /** Max consecutive deferrals before painting anyway. */
  maxDeferrals: number
  /** The gateway's outer `fleetChatId` (may be empty). */
  fleetChatId: string
  /** Live turn's chat (`stampTurn.sessionChatId`) — the stamp-turn fallback
   *  used only when no fleet chat is configured. */
  stampChatId?: string
  /** Live turn's forum topic (`stampTurn.sessionThreadId`), carried on the
   *  stamp-turn fallback so an exhausted-defer paint lands in the origin
   *  topic, not General (#3458). */
  stampThreadId?: number
  /** Owner DM chat id (`loadAccess().allowFrom[0]`) — the durable floor. */
  ownerDm: string
}): WorkerFeedDestination {
  const { origin, cardExists, priorDeferrals, maxDeferrals, fleetChatId, stampChatId, stampThreadId, ownerDm } = input
  const originResolved = origin != null
  const { defer, deferrals } = decideWorkerFeedOriginDefer({
    originResolved,
    cardExists,
    priorDeferrals,
    maxDeferrals,
  })
  if (defer) return { action: 'defer', deferrals }
  // Painting: exhausted-defer iff we're painting despite no origin and no card.
  const exhausted = !originResolved && !cardExists
  // Prefer the live turn's chat/topic over the owner DM when we must fall back
  // (a misroute at least lands near the work) — only when NO fleet chat is set.
  const usingStampFallback = fleetChatId.length === 0
  const workerFleetChatId = usingStampFallback ? stampChatId ?? fleetChatId : fleetChatId
  const fallbackThreadId = usingStampFallback ? stampThreadId : undefined
  // resolveWorkerFeedChat precedence:
  if (origin != null && origin.chatId.length > 0) {
    return { action: 'paint', chatId: origin.chatId, threadId: origin.threadId, deferrals, exhausted, ownerDmFallback: false }
  }
  if (workerFleetChatId.length > 0) {
    return { action: 'paint', chatId: workerFleetChatId, threadId: fallbackThreadId, deferrals, exhausted, ownerDmFallback: false }
  }
  const ownerDmFallback = origin == null && workerFleetChatId.length === 0 && ownerDm.length > 0
  return {
    action: 'paint',
    chatId: ownerDm,
    threadId: origin?.threadId ?? fallbackThreadId,
    deferrals,
    exhausted,
    ownerDmFallback,
  }
}

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
  /**
   * Dispatch-time / last-persisted model for the worker, from the registry
   * row's `model` column (seeded by the pretool hook from `tool_input.model`,
   * later updated by the watcher from the worker's transcript). The FIRST-PAINT
   * fallback the worker card renders before the live watcher entry has observed
   * a transcript model. Null when the row is missing or never carried a model —
   * the card then omits the model rather than guessing from config.
   */
  feedModel: string | null
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
    feedModel: sub?.model ?? null,
  }
}
