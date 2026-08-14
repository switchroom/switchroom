/**
 * `reply-route` telemetry line — the pure formatter behind the gateway's
 * `resolveAnswerThreadWithLog`.
 *
 * The 2026-06-05 triage showed reply routing was the blind spot: `reply:
 * invoked` logged only chat + char count, so a late reply landing in the wrong
 * topic was invisible without hand-correlating raw tg-post threads against
 * turn-lifecycle timestamps. This module builds, per reply: which precedence
 * tier won (`via`), the resolved thread, the owner turn + its thread, whether
 * the reply was late (turn already ended), and the alarm markers.
 *
 * Extracted out of `gateway.ts` (#2996 anti-inflation ratchet) so the string
 * building — which is pure — is unit-testable and the gateway keeps only the
 * stateful wiring.
 *
 * Markers:
 *   - `RECOVERED`                 — a late reply this fix saved from General.
 *   - `QUOTED(framework-origin)`  — origin recovered from the framework-owned
 *     quoted message_id (no model echo).
 *   - `UNROUTED`                  — a supergroup reply that resolved to NO topic
 *     with NO owner turn to attribute it to (genuinely lost). A General-topic
 *     turn legitimately has no thread, so a reply owned by it resolving to `-`
 *     is CORRECT, not lost — hence the `ownerTurn == null` gate (found by the
 *     multi-topic UAT stress, 2026-06-05).
 *   - `MISROUTE_RISK`             — the irreducible determinism residual (HOLE
 *     a): a no-echo, no-quote reply that fell to the LIVE turn while a DIFFERENT
 *     topic recently had a turn. Observability only; routing is unchanged.
 *   - `CROSS_CHAT_ANCHOR_DROPPED` — an anchor turn belonging to another chat was
 *     ignored (see `answer-thread-resolve.ts` bug c). Carries BOTH chat ids so
 *     cross-chat replies stay auditable.
 *   - `EXPLICIT_OVERRIDDEN`       — the model passed an explicit topic and a
 *     framework anchor overrode it (the General→CRM correction).
 */

import { isCrossChatAnchor } from './answer-thread-resolve.js'

/** The structural slice of a turn this formatter reads (`CurrentTurn`). */
export interface RouteLogTurn {
  turnId?: string
  sessionChatId: string
  sessionThreadId: number | undefined
}

export interface ReplyRouteLogInput {
  surface: 'reply' | 'stream_reply'
  /** Chat the reply is being SENT to. */
  chatId: string
  /** What `resolveAnswerThreadId` actually resolved. */
  threadId: number | undefined
  explicitThreadId: number | undefined
  /** RAW anchors as looked up — the cross-chat filter is applied here, with the
   *  same predicate the resolver used, so `via` can never disagree with it. */
  originTurn: RouteLogTurn | null
  originVia: 'echo' | 'quoted' | null
  liveTurn: RouteLogTurn | null
  recovered: RouteLogTurn | null
  frameworkTopicAuthority: boolean
  /** Lazy: only consulted for the MISROUTE_RISK arm, which is the sole caller
   *  that needs the bounded recent-turn scan. */
  hasDifferentThreadedRecentTurn: (liveThreadId: number | undefined) => boolean
}

export function formatReplyRouteLog(i: ReplyRouteLogInput): string {
  const originCrossChat = isCrossChatAnchor(i.chatId, i.originTurn?.sessionChatId)
  const liveCrossChat = isCrossChatAnchor(i.chatId, i.liveTurn?.sessionChatId)
  const crossChatDropped = originCrossChat || liveCrossChat
  const originAnchor = originCrossChat ? null : i.originTurn
  const liveAnchor = liveCrossChat ? null : i.liveTurn
  const explicit = i.explicitThreadId
  // `via` reflects the ACTIVE precedence so telemetry matches routing.
  const via = i.frameworkTopicAuthority
    ? (originAnchor != null ? (i.originVia === 'quoted' ? 'quoted' : 'origin')
      : liveAnchor != null ? 'live'
      : explicit != null ? 'explicit'
      : i.recovered != null ? 'recovered'
      : 'none')
    : (explicit != null ? 'explicit'
      : originAnchor != null ? (i.originVia === 'quoted' ? 'quoted' : 'origin')
      : liveAnchor?.sessionThreadId != null ? 'live'
      : i.recovered != null ? 'recovered'
      : 'none')
  const explicitOverridden =
    i.frameworkTopicAuthority &&
    explicit != null &&
    (originAnchor != null || liveAnchor != null) &&
    i.threadId !== explicit
  const ownerTurn = originAnchor ?? i.recovered ?? liveAnchor
  const isSupergroup = i.chatId.startsWith('-100')
  // A dropped cross-chat anchor is NOT a lost reply — the send is a cross-chat
  // one and the main chat is where it belongs — so it does not raise UNROUTED;
  // CROSS_CHAT_ANCHOR_DROPPED already explains the line.
  const unrouted = isSupergroup && i.threadId == null && ownerTurn == null && !crossChatDropped
  const misrouteRisk =
    isSupergroup && via === 'live' && i.hasDifferentThreadedRecentTurn(liveAnchor?.sessionThreadId)
  return (
    `telegram gateway: reply-route surface=${i.surface} chat=${i.chatId} ` +
    `resolved_thread=${i.threadId ?? '-'} via=${via} late=${liveAnchor == null} ` +
    `originTurn=${ownerTurn?.turnId ?? '-'} origin_thread=${ownerTurn?.sessionThreadId ?? '-'}` +
    (via === 'recovered' ? ' RECOVERED' : '') +
    (via === 'quoted' ? ' QUOTED(framework-origin)' : '') +
    (unrouted ? ' UNROUTED(supergroup→no-topic)' : '') +
    (misrouteRisk ? ' MISROUTE_RISK(no-echo→live-successor)' : '') +
    (crossChatDropped
      ? ` CROSS_CHAT_ANCHOR_DROPPED(target=${i.chatId}` +
        (originCrossChat
          ? `,origin_chat=${i.originTurn?.sessionChatId},origin_thread=${i.originTurn?.sessionThreadId ?? '-'}`
          : '') +
        (liveCrossChat
          ? `,live_chat=${i.liveTurn?.sessionChatId},live_thread=${i.liveTurn?.sessionThreadId ?? '-'}`
          : '') +
        `,routed→${i.threadId ?? '-'})`
      : '') +
    (explicitOverridden
      ? ` EXPLICIT_OVERRIDDEN(model→${explicit},routed→${i.threadId ?? '-'})`
      : '') +
    '\n'
  )
}
