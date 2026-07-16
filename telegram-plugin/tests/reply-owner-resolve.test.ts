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
import { FlushedTurnSupersedeRegistry, DEFAULT_SUPERSEDE_TTL_MS } from '../flushed-turn-supersede.js'

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

describe('F1 — flush send failure must NOT suppress the late reply (zero-message guard)', () => {
  // The flush arms `answerDelivered` synchronously at FIRE time, BEFORE the async
  // send. If the send then throws and NOTHING was delivered, the supersede record
  // is never written (gated on sentIds>0), so Part 1 cannot fire. Leaving the
  // latch armed would make a genuine late reply suppress itself → the user gets
  // ZERO messages. The gateway's send-failure catch resets `answerDelivered =
  // false`; these assert the resulting coordination outcome at the pure core.
  const lateSubstantiveReply = (ownerAnswerDelivered: boolean) =>
    decideAnswerLatchSuppression({
      superseded: false,
      replySubstantive: true,
      isLateReply: true,
      ownerAnswerDelivered,
    })

  it('WITHOUT the catch-reset (latch still armed) the late reply is suppressed ' +
    '— the zero-message bug', () => {
    // Models the buggy state: flush armed the latch, send failed, latch left true.
    expect(lateSubstantiveReply(true)).toBe(true)
  })

  it('WITH the catch-reset (answerDelivered=false) the late reply DELIVERS', () => {
    // Models the fixed state: catch reset the latch, so the genuine late reply
    // is not suppressed and the user still receives the answer.
    expect(lateSubstantiveReply(false)).toBe(false)
  })
})

describe('F2 — recency-bound the destructive latest-ended supersede tier', () => {
  const CHAT = '515151'
  const base: ReplyOwnerCandidates = {
    liveTurnId: null,
    originTurnId: null,
    quotedTurnId: null,
    latestEndedTurnId: null,
  }

  it('accepts a latest-ended turn that ended within the supersede TTL', () => {
    expect(
      resolveReplyOwnerTurnId({
        ...base,
        latestEndedTurnId: 'turn-T',
        latestEndedAgeMs: DEFAULT_SUPERSEDE_TTL_MS - 1,
        latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
      }),
    ).toBe('turn-T')
  })

  it('REJECTS a STALE latest-ended turn (ended past the supersede TTL) so it ' +
    'cannot inherit deletion authority — resolver returns null', () => {
    expect(
      resolveReplyOwnerTurnId({
        ...base,
        latestEndedTurnId: 'turn-STALE',
        latestEndedAgeMs: DEFAULT_SUPERSEDE_TTL_MS + 5_000,
        latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
      }),
    ).toBeNull()
  })

  it('end-to-end: a stale latest-ended turn does NOT delete a live flush ' +
    "record it doesn't own", () => {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 1_000_000
    // A fresh flush record for the newer turn T2 (its owner, well within TTL).
    reg.record(CHAT, undefined, { turnId: 'turn-T2', messageIds: [9001], text: 'A2' }, now)
    // A late reply whose only recoverable owner is a STALE turn (ended long ago).
    // Without the recency bound the resolver would hand back the stale turn id
    // and a take() keyed on it could mis-target; with the bound it resolves null,
    // so no deletion authority is granted and T2's record survives untouched.
    const ownerId = resolveReplyOwnerTurnId({
      ...base,
      latestEndedTurnId: 'turn-STALE',
      latestEndedAgeMs: DEFAULT_SUPERSEDE_TTL_MS + 5_000,
      latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
    })
    expect(ownerId).toBeNull()
    const decision = reg.take(CHAT, undefined, { liveTurnId: ownerId, now: now + 10 })
    expect(decision.supersede).toBe(false)
    // T2's record is intact (a null owner never reaches its turnId-keyed lane).
    expect(reg.peek(CHAT, undefined, { liveTurnId: 'turn-T2', now: now + 10 }).supersede).toBe(true)
  })

  it('unbounded when no age is supplied (back-compat: pre-F2 precedence intact)', () => {
    expect(
      resolveReplyOwnerTurnId({ ...base, latestEndedTurnId: 'turn-T' }),
    ).toBe('turn-T')
  })
})

/**
 * Reply-flicker edit-in-place fix (PR #3266) — the deferred-correction
 * resurrection window (adversarial-review L1).
 *
 * The fix defers the flushed-message correction (delete-resend vs edit-in-place)
 * from the supersede site to the send site so a single-message reply can EDIT
 * the flushed message A in place instead of delete+resend. But `take()` consumes
 * the supersede record at the supersede site, and TWO arg-validation `throw`s
 * (file too-large, invalid inline_keyboard) sit BETWEEN consumption and the
 * correction. A late reply that supersedes a flush AND carries an oversized file
 * / invalid keyboard throws before the correction runs: message A is neither
 * deleted nor edited, the model retries `reply`, and — the record already
 * consumed — the retry takes the no-record branch. Without a latch the retry
 * would ship a fresh B alongside the stale narration A (both visible).
 *
 * The fix latches `ownerTurn.answerDelivered = true` at record consumption, so
 * the retry (resolving the SAME ended owner turn) is caught by
 * `decideAnswerLatchSuppression` and suppressed — exactly one message survives.
 */
describe('reply-flicker edit-in-place — mid-path throw + retry never resurrects the duplicate (L1)', () => {
  const CHAT = '636363'

  /** Minimal model of the ended owner turn atom the gateway mutates + reads. */
  interface OwnerTurn { turnId: string; answerDelivered: boolean }

  /**
   * Drive the two gateway `reply` calls the incident produces, threading the
   * SAME registry + owner-turn atom. `setLatchOnSupersede` toggles the fix on
   * (true = PR behaviour) vs off (false = pre-fix red-on-main contrast).
   * Returns which messages are visible after the sequence.
   */
  function runSupersedeThenThrowRetry(setLatchOnSupersede: boolean): {
    visible: string[]
    firstSuperseded: boolean
    retrySuppressed: boolean
  } {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 2_000_000
    const owner: OwnerTurn = { turnId: 'turn-A', answerDelivered: false }
    // The flush posted message A for turn-A and recorded it.
    reg.record(CHAT, undefined, { turnId: owner.turnId, messageIds: [8001], text: 'narration\n\nthe answer' }, now)
    const visible = ['A(flush-narration)']

    // --- Call 1: the model's real `reply` lands and SUPERSEDES the flush. ---
    const d1 = reg.take(CHAT, undefined, { liveTurnId: owner.turnId, now: now + 10 })
    const firstSuperseded = d1.supersede
    if (d1.supersede && setLatchOnSupersede) {
      // The fix: latch at consumption, BEFORE the arg-validation throw.
      owner.answerDelivered = true
    }
    // Arg-validation throw fires here (oversized file / invalid keyboard):
    // the correction never runs → A is neither deleted nor edited, B not sent.
    // (Modelled by simply NOT applying the correction and NOT pushing B.)

    // --- Call 2: the model retries `reply` after seeing the MCP error. ---
    // The record was consumed by Call 1's take() → no-record now.
    const d2 = reg.take(CHAT, undefined, { liveTurnId: owner.turnId, now: now + 20 })
    let retrySuppressed = false
    if (!d2.supersede) {
      // else/no-record branch: the retry is a late substantive reply.
      retrySuppressed = decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: owner.answerDelivered,
      })
    }
    if (!retrySuppressed) visible.push('B(retry-reply)')
    return { visible, firstSuperseded, retrySuppressed }
  }

  it('WITH the fix: the retry is latch-suppressed → exactly ONE surviving message (never A+B)', () => {
    const r = runSupersedeThenThrowRetry(true)
    expect(r.firstSuperseded).toBe(true)
    expect(r.retrySuppressed).toBe(true)
    expect(r.visible).toHaveLength(1)
    // The single surviving message is the flushed A (the correction throw left it
    // in place); the retry B was suppressed — no stale-narration + reply duplicate.
    expect(r.visible).toEqual(['A(flush-narration)'])
  })

  it('WITHOUT the fix (contrast): the retry is NOT suppressed → BOTH A and B ship (the resurrected duplicate)', () => {
    const r = runSupersedeThenThrowRetry(false)
    expect(r.firstSuperseded).toBe(true)
    expect(r.retrySuppressed).toBe(false)
    // The exact regression: stale narration A AND the retry reply B are both visible.
    expect(r.visible).toEqual(['A(flush-narration)', 'B(retry-reply)'])
  })
})
