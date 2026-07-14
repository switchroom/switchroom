/**
 * Regression coverage for the 2026-07 double-reply-on-DM fix — completes the
 * #3236 turnId-keyed dedup (`flushed-turn-supersede.ts`) for the late-reply / DM
 * path.
 *
 * ## The incident these tests pin
 *
 * On a DM agent a turn DOUBLE-SENT: the answer-ready quiescence flush posted the
 * composed terminal answer as message A (no quote), then the model's REAL
 * `reply` tool call landed and sent message B (quoted). The user should have
 * received exactly ONE message (the quoted reply).
 *
 * #3236's supersede is turnId-identity-keyed and text-agnostic BY DESIGN, so the
 * 275-vs-249-char rewording is NOT why it missed. It missed because the reply's
 * owner turn resolved to `null` on the late path: `currentTurn` was nulled by the
 * flush's synthetic turn_end, and `origin_turn_id` (a forum-supergroup field) is
 * absent in DMs — so the OLD 2-tier chain `currentTurn ?? findTurnByOriginId`
 * yielded null, and `decideSupersede` never lets a null live turn supersede a
 * turnId-bearing record.
 *
 * The router recovered the SAME reply's owner via `findTurnByQuotedMessageId` and
 * `findLatestEndedTurnForChat`; the supersede chain omitted BOTH. The fix
 * (`resolveReplyOwnerTurnId`) unifies the two onto one precedence.
 *
 * These tests exercise the extracted pure cores — the exact precedence and latch
 * decision the gateway runs (`gateway.ts` is not importable in tests; the repo's
 * `decideTurnFlush` / `decideSupersede` pattern). The core test also asserts the
 * OLD 2-tier chain FAILS to recover the owner (the red-on-main contrast) while
 * the unified chain recovers it and the supersede fires.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveReplyOwnerTurnId,
  decideAnswerLatchSuppression,
  type ReplyOwnerCandidates,
} from '../reply-owner-resolve.js'
import { FlushedTurnSupersedeRegistry } from '../flushed-turn-supersede.js'

const NONE: ReplyOwnerCandidates = {
  liveTurnId: null,
  originTurnId: null,
  quotedTurnId: null,
  latestEndedTurnId: null,
}

/** The OLD (pre-fix) resolver chain the gateway ran on main — the 2-tier
 *  `currentTurn ?? findTurnByOriginId` — reproduced here to prove the incident
 *  went unrecovered before the fix (red-on-main contrast). */
function oldTwoTierResolve(c: ReplyOwnerCandidates): string | null {
  return c.liveTurnId ?? c.originTurnId ?? null
}

describe('resolveReplyOwnerTurnId — unified owner-turn precedence (Part 1)', () => {
  it('prefers the live currentTurn when present', () => {
    expect(
      resolveReplyOwnerTurnId({ ...NONE, liveTurnId: 'live', originTurnId: 'origin', latestEndedTurnId: 'ended' }),
    ).toBe('live')
  })

  it('falls to the model-echoed origin turn when no live turn', () => {
    expect(
      resolveReplyOwnerTurnId({ ...NONE, originTurnId: 'origin', quotedTurnId: 'quoted', latestEndedTurnId: 'ended' }),
    ).toBe('origin')
  })

  it('falls to the framework-owned quoted-message turn when no live/origin', () => {
    expect(
      resolveReplyOwnerTurnId({ ...NONE, quotedTurnId: 'quoted', latestEndedTurnId: 'ended' }),
    ).toBe('quoted')
  })

  it('falls to the chat latest-ended turn as the final tier — the DM recovery', () => {
    expect(resolveReplyOwnerTurnId({ ...NONE, latestEndedTurnId: 'ended' })).toBe('ended')
  })

  it('returns null only when every lookup missed', () => {
    expect(resolveReplyOwnerTurnId(NONE)).toBeNull()
  })

  it('RED-ON-MAIN CONTRAST: the DM late reply (no live turn, no origin) is ' +
    'unrecovered by the old 2-tier chain but recovered by the unified chain', () => {
    // The exact incident inputs: flush nulled currentTurn (liveTurnId=null),
    // DM has no origin_turn_id (originTurnId=null); the owner survives only in
    // the latest-ended registry (latestEndedTurnId).
    const incident: ReplyOwnerCandidates = { ...NONE, latestEndedTurnId: 'turn-T' }
    // Old behaviour (what shipped on main): null → no supersede → duplicate.
    expect(oldTwoTierResolve(incident)).toBeNull()
    // Fixed behaviour: recovers the owning turn T.
    expect(resolveReplyOwnerTurnId(incident)).toBe('turn-T')
  })
})

describe('Part 1 end-to-end: unified resolver drives the flush supersede', () => {
  const CHAT = '424242'

  it('CORE INCIDENT: flush records message A for turn T, then a late DM reply ' +
    '(currentTurn=null, no origin_turn_id) SUPERSEDES via the recovered owner', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 1_000
    // Flush commits message A for turn T.
    reg.record(CHAT, undefined, { turnId: 'turn-T', messageIds: [5001], text: 'A' }, now)

    // Late DM reply: no live turn, no origin echo; owner survives in the
    // latest-ended registry as turn-T.
    const incident: ReplyOwnerCandidates = { ...NONE, latestEndedTurnId: 'turn-T' }

    // Old 2-tier chain → null → supersede DECLINES (the duplicate ships).
    const oldId = oldTwoTierResolve(incident)
    expect(reg.peek(CHAT, undefined, { liveTurnId: oldId, now: now + 10 }).supersede).toBe(false)

    // Unified chain → turn-T → supersede FIRES and deletes message A, so the
    // reply below delivers as the single clean message.
    const newId = resolveReplyOwnerTurnId(incident)
    const decision = reg.take(CHAT, undefined, { liveTurnId: newId, now: now + 10 })
    expect(decision.supersede).toBe(true)
    expect(decision.deleteMessageIds).toEqual([5001])
  })

  it('a DIFFERENT newer turn recovered as owner does NOT supersede turn T', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 2_000
    reg.record(CHAT, undefined, { turnId: 'turn-T', messageIds: [7001], text: 'A' }, now)
    // Owner recovers to a newer turn (its own flush isn't recorded here).
    const id = resolveReplyOwnerTurnId({ ...NONE, latestEndedTurnId: 'turn-NEWER' })
    expect(reg.take(CHAT, undefined, { liveTurnId: id, now: now + 10 }).supersede).toBe(false)
  })
})

describe('decideAnswerLatchSuppression — race backstop (Part 2)', () => {
  it('RACE: a late substantive reply lands in the flush post-fire pre-record ' +
    'window (no supersede record yet) → SUPPRESSED by the latch', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: true,
      }),
    ).toBe(true)
  })

  it('does NOT double-suppress when Part 1 already superseded (else the turn ' +
    'ends with ZERO messages)', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: true,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: true,
      }),
    ).toBe(false)
  })

  it('NEGATIVE: an interim sub-floor ack (not substantive) is never suppressed ' +
    '— so interim-ack-then-final both send', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: false,
        isLateReply: true,
        ownerAnswerDelivered: true,
      }),
    ).toBe(false)
  })

  it('NEGATIVE: a normal in-turn reply with a live currentTurn is never ' +
    'suppressed (a legitimate second substantive reply still sends)', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: false,
        ownerAnswerDelivered: true,
      }),
    ).toBe(false)
  })

  it('does not suppress when the owner latch is unset (a normal answer)', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: false,
      }),
    ).toBe(false)
  })
})
