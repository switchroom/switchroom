/**
 * Multitopic reply-routing — gateway/bridge wiring guards.
 *
 * The gateway IIFE is too entangled to instantiate in-process, so these
 * are source-level assertions (the same pattern buffer-gate-broadened.test
 * and reply-terminal-reaction.test use). They pin the load-bearing wiring
 * of components 3 (turn-origin routing), 4 (topic framing), and 5 (queued-
 * status UX) so a future refactor that drops a hook trips here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_INSTRUCTIONS } from '../bridge/mcp-instructions.js'

// #2996 P2: executeReply's body moved VERBATIM to outbound-send-path.ts
// (`sendReply`); the reply-path routing assertions read the window there.
const sendPathSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'outbound-send-path.ts'),
  'utf-8',
)
const sendReplyFn = sendPathSrc.split('export async function sendReply(')[1]?.split('\nexport ')[0] ?? ''
const gatewaySrc =
  readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8') +
  '\n' +
  // P7 PR-10 (#2996): the InboundMessage envelope assembly (origin_turn_id,
  // topic_scope, meta lane) moved verbatim into gateway/inbound-router.ts
  // (buildInboundEnvelope) — include it in the scraped corpus.
  readFileSync(resolve(__dirname, '..', 'gateway', 'inbound-router.ts'), 'utf-8') +
  '\n' +
  // The reply-route telemetry line (via/RECOVERED/UNROUTED/MISROUTE_RISK/
  // CROSS_CHAT_ANCHOR_DROPPED) moved verbatim out of resolveAnswerThreadWithLog
  // into the pure formatReplyRouteLog (#2996 line ratchet) — scrape it too.
  readFileSync(resolve(__dirname, '..', 'gateway', 'reply-route-log.ts'), 'utf-8')
// #2996 P4-A: the enqueue handler (turn ctor: `const turnId = deriveTurnId`,
// `rememberRecentTurn(next)`, `promoteQueuedStatus`) moved VERBATIM into
// stream-render.ts with handleSessionEvent. Enqueue-seam assertions span both.
// #2996 P8 PR-B: the turn-end funnel bodies moved verbatim to turn-end.ts.
const turnEndSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'turn-end.ts'),
  'utf-8',
)
const streamSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'stream-render.ts'),
  'utf-8',
)
const gatewayAndStreamSrc = gatewaySrc + '\n' + streamSrc
// #3562 — the MCP `instructions` string was extracted out of bridge.ts into
// its own module (it must fit the Claude Code client's 2048-char truncation
// limit, so it is now length-guarded independently). bridge.ts still owns the
// per-tool `description` strings.
//
// Deliberately NOT concatenated with the instructions module: an earlier
// revision merged both files into one blob, which meant an assertion could no
// longer tell WHICH file carried a phrase, and a matching COMMENT satisfied it
// just as well as real agent-facing text. Instructions text is asserted
// against the imported runtime constant instead (see below) — a comment cannot
// satisfy that, by construction.
const bridgeSrc = readFileSync(
  resolve(__dirname, '..', 'bridge', 'bridge.ts'),
  'utf-8',
)
// #3268 — deriveTurnId was extracted from the gateway monolith into its own
// importable module so the enqueue seam and the handback round-trip test share
// ONE function. The body-shape assertion below now reads it from there.
const deriveTurnIdSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'derive-turn-id.ts'),
  'utf-8',
)

describe('component 3 — turn-origin reply routing', () => {
  it('CurrentTurn carries a turnId, and the enqueue handler initialises it', () => {
    expect(gatewaySrc).toMatch(/turnId: string/)
    expect(gatewayAndStreamSrc).toMatch(/const turnId\s*=\s*\n?\s*deriveTurnId\(/)
    expect(gatewayAndStreamSrc).toMatch(/rememberRecentTurn\(next\)/)
  })

  it('the inbound meta stamps origin_turn_id derived from chat/thread/messageId', () => {
    expect(gatewaySrc).toMatch(/const originTurnId = deriveTurnId\((?:p\.)?chat_id, (?:p\.)?messageThreadId \?\? null, (?:p\.)?msgId\)/)
    expect(gatewaySrc).toMatch(/origin_turn_id: originTurnId/)
  })

  it('deriveTurnId is stable across inbound-build and enqueue (message-id based)', () => {
    // The id must be derivable identically at both sites — keyed on
    // chat/thread/messageId, NOT the not-yet-known startedAt. Lives in the
    // extracted derive-turn-id.ts module (#3268); the gateway imports it under
    // the same name (asserted below), so every enqueue callsite is unchanged.
    const fn = deriveTurnIdSrc.split('export function deriveTurnId')[1]?.split('\nexport function ')[0] ?? ''
    expect(fn).toMatch(/chatKey\(chatId, threadId \?\? null\)/)
    expect(fn).toMatch(/messageId/)
    // The gateway must import the shared function, not redefine it — so the
    // enqueue seam and the round-trip test provably use the same identity.
    expect(gatewaySrc).toMatch(/import \{ deriveTurnId \} from '\.\/derive-turn-id\.js'/)
  })

  it('executeReply resolves the answer thread via the origin turn, not the live currentTurn', () => {
    const fn = sendReplyFn
    expect(fn).toMatch(/TURN_ORIGIN_ROUTING_ENABLED/)
    expect(fn).toMatch(/findTurnByOriginId\(args\.origin_turn_id/)
    // The resolution + reply-route telemetry go through resolveAnswerThreadWithLog,
    // which calls the pure resolveAnswerThreadId internally (incl. tier-4 recovery).
    expect(fn).toMatch(/resolveAnswerThread\w*\(/)
  })

  it('the reply tool schema exposes origin_turn_id to the model', () => {
    const occurrences = bridgeSrc.match(/origin_turn_id: \{ type: 'string'/g) ?? []
    expect(occurrences.length).toBe(1) // reply
  })

  it('recentTurnsById is a BOUNDED registry (cannot grow unbounded)', () => {
    expect(gatewaySrc).toMatch(/RECENT_TURNS_MAX/)
    expect(gatewaySrc).toMatch(/recentTurnsById\.delete\(oldest\)/)
  })
})

describe('framework-owned origin recovery (determinism residual, 2026-06-05)', () => {
  it('a source-message reverse index is populated at enqueue and EVICTED in parity with recentTurnsById', () => {
    expect(gatewaySrc).toMatch(/const recentTurnIdBySourceMessageId = new Map<number, string>\(\)/)
    // Populated inside rememberRecentTurn from the turn's sourceMessageId.
    const fn = gatewaySrc.split('function rememberRecentTurn')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/recentTurnIdBySourceMessageId\.set\(turn\.sourceMessageId, turn\.turnId\)/)
    // Eviction parity: the reverse entry is dropped when its turn is evicted —
    // so the index cannot outgrow the bounded RECENT_TURNS_MAX registry.
    expect(fn).toMatch(/recentTurnIdBySourceMessageId\.delete\(evicted\.sourceMessageId\)/)
  })

  it('the reply path recovers origin from the quoted message_id when the model omits the echo', () => {
    for (const fn of [sendReplyFn]) {
      // Echo first (authoritative), quoted message_id as the framework fallback.
      expect(fn).toMatch(/const echoedTurn = findTurnByOriginId\(args\.origin_turn_id/)
      // Quoted lookup is CHAT-SCOPED (cross-chat message-id collision guard).
      expect(fn).toMatch(/findTurnByQuotedMessageId\([^,]+, args\.reply_to\)/)
      expect(fn).toMatch(/echoedTurn \?\? quotedTurn/)
    }
  })

  it('findTurnByQuotedMessageId is gated on the kill switch and resolves a real turn (never the live successor)', () => {
    const fn = gatewaySrc.split('function findTurnByQuotedMessageId')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/FRAMEWORK_ORIGIN_ROUTING_ENABLED/)
    expect(fn).toMatch(/recentTurnIdBySourceMessageId\.get\(mid\)/)
    expect(fn).toMatch(/recentTurnsById\.get\(owner\)/)
    // Cross-chat collision guard: the resolved turn must belong to this chat.
    expect(fn).toMatch(/turn\.sessionChatId !== chatId/)
  })

  it('the irreducible no-echo residual is ALARMED (MISROUTE_RISK), never silently mis-routed', () => {
    expect(gatewaySrc).toMatch(/MISROUTE_RISK\(no-echo→live-successor\)/)
    expect(gatewaySrc).toMatch(/function hasDifferentThreadedRecentTurn/)
    // The alarm is observability-only: it fires on via=live with a different
    // recent topic, and does NOT change the resolved thread.
    expect(gatewaySrc).toMatch(/const misrouteRisk =/)
    expect(gatewaySrc).toMatch(/via === 'quoted' \? ' QUOTED\(framework-origin\)' : ''/)
  })

  it('a thread anchor from ANOTHER chat is dropped before it can be sent (cross-chat guard)', () => {
    // The routing input carries the target + anchor chat ids, so the pure
    // resolver can refuse a foreign anchor (Telegram 400 "message thread not
    // found"). Behaviour is asserted in answer-thread-resolve.test.ts; this
    // pins the WIRING so a refactor cannot silently stop passing them.
    //
    // NOT A SAFETY NET — read before relying on it. Like its ~20 siblings in
    // this file, this is a source-text CALL-SITE RATCHET: it greps gateway.ts
    // for the argument spellings. Mutating `isCrossChatAnchor` to
    // `return false` leaves every assertion here GREEN (verified), because the
    // call site is still spelled the same way. The behavioural oracles are
    // `answer-thread-resolve.test.ts` (the pure predicate + precedence),
    // `reply-route-log.test.ts` (the telemetry), and the
    // `SWITCHROOM_TURN_ORIGIN_ROUTING=0` block in `send-reply-golden.test.ts`
    // (the legacy branch, at the wire). Those are what fail on a broken guard.
    const fn = gatewaySrc.split('function resolveAnswerThreadWithLog')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/targetChatId: chatId/)
    expect(fn).toMatch(/originChatId: originTurn\?\.sessionChatId/)
    expect(fn).toMatch(/liveChatId: liveTurn\?\.sessionChatId/)
    // And the dropped anchor is observable, with both chat ids on the line.
    expect(gatewaySrc).toMatch(/CROSS_CHAT_ANCHOR_DROPPED\(target=/)
  })

  it('the kill switch defaults ON and is independent of TURN_ORIGIN_ROUTING', () => {
    expect(gatewaySrc).toMatch(/SWITCHROOM_FRAMEWORK_ORIGIN_ROUTING !== '0'/)
  })
})

describe('component 4 — per-turn topic framing', () => {
  it('the gateway stamps a topic_scope directive for forum-topic inbounds (kill-switched)', () => {
    expect(gatewaySrc).toMatch(/TOPIC_FRAMING_ENABLED/)
    expect(gatewaySrc).toMatch(/topic_scope: topicScope/)
    // Only for topic inbounds — DMs get nothing.
    // P7 PR-10: the guard reads the injected constant + params inside
    // buildInboundEnvelope (topicFramingEnabled / p.messageThreadId).
    expect(gatewaySrc).toMatch(/(?:TOPIC_FRAMING_ENABLED|p\.topicFramingEnabled) && (?:p\.)?messageThreadId != null/)
  })

  it('the bridge instructions frame each channel message as the current topic', () => {
    // Asserted against the IMPORTED runtime constant, not file text: this is
    // the exact string handed to the MCP client, so a comment (or the phrase
    // living in some other file) cannot satisfy it. Wording was tightened in
    // #3562 to fit the 2048-char budget; the invariant is unchanged — the
    // instructions must scope the agent to the current message's topic and
    // forbid answering a queued other-topic message in the same turn.
    expect(MCP_INSTRUCTIONS).toMatch(/answer only the current message/i)
    expect(MCP_INSTRUCTIONS).toMatch(
      /do not also answer a pending message from another topic/i,
    )
  })
})

describe('component 5 — queued-status UX (delete-on-answer)', () => {
  it('a queuedStatusMsgIds map tracks the placeholder per buffered topic', () => {
    expect(gatewaySrc).toMatch(/const queuedStatusMsgIds = new Map/)
  })

  it('Hook A posts a queued status into the buffered message own topic (cross-topic only, kill-switched)', () => {
    expect(gatewaySrc).toMatch(/postQueuedStatus\(chat_id, messageThreadId, inFlightThread\)/)
    // Suppressed for DMs and same-topic.
    expect(gatewaySrc).toMatch(/!isDmChatId\(chat_id\) &&/)
    expect(gatewaySrc).toMatch(/messageThreadId !== inFlightThread/)
  })

  it('Hook B promotes the placeholder to "On it" when the buffered turn starts', () => {
    expect(gatewayAndStreamSrc).toMatch(/promoteQueuedStatus\(ev\.chatId, enqThreadIdNum\)/)
  })

  it('Hook C reaps the placeholder on the answer (executeReply / stream)', () => {
    const reapCalls = (gatewaySrc + turnEndSrc).match(/reapQueuedStatus\(/g) ?? []
    // definition + executeReply + purge cleanup (2 branches)
    expect(reapCalls.length).toBeGreaterThanOrEqual(4)
  })

  it('purgeReactionTracking reaps the placeholder on abnormal turn-end (defense-in-depth)', () => {
    const fn = turnEndSrc.split('function purgeReactionTracking')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/reapQueuedStatus\(/)
    // Reap sits alongside the activeReactionMsgIds cleanup.
    expect(fn).toMatch(/activeReactionMsgIds\.delete\(key\)/)
  })

  it('all queued-status sends/edits/deletes go through the swallowing wrapper (carry thread)', () => {
    for (const helper of ['postQueuedStatus', 'promoteQueuedStatus', 'reapQueuedStatus']) {
      const fn = gatewaySrc.split(`function ${helper}`)[1]?.split('\nfunction ')[0] ?? ''
      expect(fn).toMatch(/swallowingApiCall\(/)
    }
  })
})

describe('kill switches — all five default ON, each independently disableable', () => {
  it('declares the three named kill switches + the two component switches', () => {
    expect(gatewaySrc).toMatch(/SWITCHROOM_SERIALIZE_UNTIL_REPLIED !== '0'/)
    expect(gatewaySrc).toMatch(/SWITCHROOM_SERIALIZE_NOREPLY_DRAIN_MS/)
    expect(gatewaySrc).toMatch(/SWITCHROOM_QUEUED_STATUS_UX !== '0'/)
    expect(gatewaySrc).toMatch(/SWITCHROOM_TURN_ORIGIN_ROUTING !== '0'/)
    expect(gatewaySrc).toMatch(/SWITCHROOM_TOPIC_FRAMING !== '0'/)
  })

  it('the no-reply drain ms default is 2500 and clamped positive', () => {
    expect(gatewaySrc).toMatch(/SERIALIZE_NOREPLY_DRAIN_MS\s*=\s*\n?\s*Number\.isFinite\([^)]*\)\s*&&[^?]*\?\s*[^:]*:\s*2_500/)
  })
})
