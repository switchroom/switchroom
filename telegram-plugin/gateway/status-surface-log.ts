/**
 * Status-surface observability — pure formatters for the gateway's live-status
 * lane (progress card / activity feed / typing indicator).
 *
 * Why a dedicated module: when an agent's live status went dark (marko,
 * 2026-06-05), the lane was nearly silent in the logs — `currentTurn` (the
 * variable that drives the card/feed/typing) was nulled with no breadcrumb, and
 * the activity feed failed every send with no turn-level signal. Two latent
 * bugs were invisible for days: a 300s silence-poke teardown that nulled the
 * card mid-work, and a resume-synthetic whose fabricated 13-digit message_id
 * made every feed send 400. Neither left a greppable "the card went dark and
 * here's why" line.
 *
 * These pure functions give the gateway exactly that: ONE structured line per
 * currentTurn lifecycle transition, and a single DEGRADED warning when a turn
 * did tool work but the feed never opened because its sends failed. Pure
 * formatters + injected transport (the caller owns `process.stderr.write`),
 * mirroring `silence-poke.ts` / `worker-activity-feed.ts`, so they're
 * unit-testable without a live gateway.
 */

/**
 * The `currentTurn` fields the status-surface logs read. The gateway's
 * `CurrentTurn` atom structurally satisfies this (TS structural typing), so the
 * gateway passes the turn directly — no import cycle back into `gateway.ts`.
 */
export interface StatusSurfaceTurnView {
  turnId: string
  sessionChatId: string
  sessionThreadId: number | undefined
  startedAt: number
  toolCallCount: number
  /** Live activity-feed message id; null until the first send captures it. */
  activityMessageId: number | null
  /**
   * Sticky: true once the activity feed ever opened a message this turn. Unlike
   * `activityMessageId` (which `clearActivitySummary` nulls async on the
   * healthy finalize path), this is never reset — so a turn that DID surface
   * the feed can't false-positive as degraded at turn-end.
   */
  activityEverOpened: boolean
  /** Count of real activity-feed send/edit failures this turn (429s and
   *  "message is not modified" excluded). */
  activityDrainFailures: number
  replyCalled: boolean
  finalAnswerDelivered: boolean
}

export type TurnLifecycleAction = 'set' | 'clear'

/**
 * One structured line per `currentTurn` set/clear. `currentTurn` drives the
 * progress card / activity feed / typing; logging every transition — with the
 * topic key, how far the turn got, and the reason it ended — makes a dark card
 * explainable after the fact. Returned WITHOUT the `telegram gateway: ` prefix
 * or trailing newline so the caller owns transport (and tests assert the body).
 *
 * `now` is only consulted for the `clear` age; for `set` it is ignored.
 */
export function formatTurnLifecycle(
  action: TurnLifecycleAction,
  reason: string,
  t: StatusSurfaceTurnView,
  now: number,
): string {
  const ageMs = action === 'clear' ? Math.max(0, now - t.startedAt) : 0
  return (
    `turn-lifecycle ${action} reason=${reason} turnId=${t.turnId} ` +
    `chat=${t.sessionChatId} thread=${t.sessionThreadId ?? '-'} ` +
    `tools=${t.toolCallCount} activityMsgId=${t.activityMessageId ?? 'none'} ` +
    `feedOpened=${t.activityEverOpened} drainFailures=${t.activityDrainFailures} ` +
    `replyCalled=${t.replyCalled} finalAnswer=${t.finalAnswerDelivered} age_ms=${ageMs}`
  )
}

/**
 * Turn-end health check: did the turn do tool work but never get a live feed
 * message onto the screen BECAUSE its sends failed? That is the exact signature
 * of the resume-400 bug (every activity-summary send throws, so the feed never
 * opens) — a single greppable line would have caught it in seconds.
 *
 * Returns null when the surface was healthy or legitimately silent:
 *   - no tool work this turn (nothing to surface), OR
 *   - the feed opened fine (`activityEverOpened`), OR
 *   - the feed never even attempted a send (`activityDrainFailures === 0`, e.g.
 *     an ack-first turn whose feed was intentionally suppressed) — absence of a
 *     send is not a failure.
 */
export function detectStatusSurfaceDegraded(
  t: StatusSurfaceTurnView,
): { reason: string; detail: string } | null {
  if (t.toolCallCount === 0) return null
  if (t.activityEverOpened) return null
  if (t.activityDrainFailures === 0) return null
  return {
    reason: 'feed-never-opened',
    detail:
      `tools=${t.toolCallCount} drainFailures=${t.activityDrainFailures} ` +
      `activityMsgId=none — the live activity feed failed every send this turn ` +
      `(card was dark despite tool work)`,
  }
}
