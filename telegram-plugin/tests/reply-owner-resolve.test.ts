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
  resolveReplyOwnerTier,
  decideAnswerLatchSuppression,
  decideContentGateBypass,
  type ReplyOwnerCandidates,
  type ReplyOwnerTier,
  type AnswerDeliveredLatch,
} from '../reply-owner-resolve.js'
import { FlushedTurnSupersedeRegistry, DEFAULT_SUPERSEDE_TTL_MS } from '../flushed-turn-supersede.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { latestTurnForChat } from '../gateway/latest-turn-lookup.js'

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
    'window (no supersede record yet) → SUPPRESSED by the flush-armed latch', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: 'flush',
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
        ownerAnswerDelivered: 'flush',
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
        ownerAnswerDelivered: 'flush',
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
        ownerAnswerDelivered: 'flush',
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
  const lateSubstantiveReply = (ownerAnswerDelivered: AnswerDeliveredLatch) =>
    decideAnswerLatchSuppression({
      superseded: false,
      replySubstantive: true,
      isLateReply: true,
      ownerAnswerDelivered,
    })

  it('WITHOUT the catch-reset (latch still armed) the late reply is suppressed ' +
    '— the zero-message bug', () => {
    // Models the buggy state: flush armed the latch, send failed, latch left armed.
    expect(lateSubstantiveReply('flush')).toBe(true)
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
 * The fix latches `ownerTurn.answerDelivered = 'flush'` at record consumption,
 * so the retry (resolving the SAME ended owner turn) is caught by
 * `decideAnswerLatchSuppression` and suppressed — exactly one message survives.
 */
describe('reply-flicker edit-in-place — mid-path throw + retry never resurrects the duplicate (L1)', () => {
  const CHAT = '636363'

  /** Minimal model of the ended owner turn atom the gateway mutates + reads. */
  interface OwnerTurn { turnId: string; answerDelivered: AnswerDeliveredLatch }

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
      // The fix: latch at consumption, BEFORE the arg-validation throw. Tagged
      // 'flush' (#3426) — a flush record existed for this turn.
      owner.answerDelivered = 'flush'
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

/**
 * #3426 — async sub-agent handback silently dropped by a stale answer-delivered
 * latch.
 *
 * ## The incident these tests pin (overlord, chat 12345, turn …#10473)
 *
 *   11:28:00  interim ack `reply` (321 chars — ABOVE the ≥200 substantive
 *             floor) lands in the LIVE turn; the gateway records the answer on
 *             the turn atom (outbound-send-path no-record branch tail).
 *   11:28:10  turn_end (replyCalled=true, finalAnswer=true); the atom persists
 *             in recentTurnsById with endedAt stamped.
 *   11:28:51  the async sub-agent completes and the agent's handback `reply`
 *             (1365 chars, GENUINELY DIFFERENT content) lands with NO live
 *             gateway turn (a sub-agent completion is not a new inbound, so no
 *             new turn atom exists). The owner resolves to the ENDED ack turn
 *             via the latest-ended tier (41 s ≤ the 60 s supersede TTL), whose
 *             boolean latch was still armed → the handback was suppressed as a
 *             "flush duplicate" and a false "deduped" success returned. The
 *             user never saw the sub-agent's findings.
 *
 * ## The fix
 *
 * The latch is SOURCE-TAGGED (`AnswerDeliveredLatch`): 'flush' when the
 * turn-flush backstop armed it (the two races the suppression exists for),
 * 'reply' when a normally-delivered reply carried the answer.
 * `decideAnswerLatchSuppression` suppresses a late reply ONLY for a
 * flush-armed latch — a 'reply'-armed latch never suppresses, so the
 * dispatch → ack → turn_end → handback sequence always delivers. Genuine
 * byte-identical replays of the delivered reply remain covered by the
 * content-keyed #546 outbound dedup, asserted below. (Honest bound: the dedup
 * TTL is anchored at reply RECORD time, the latest-ended owner tier at
 * `endedAt` — a replay landing in the gap between those 60 s windows now
 * delivers as a rare duplicate rather than being suppressed; a conscious
 * trade against the silent handback drop. See the `AnswerDeliveredLatch`
 * docblock.)
 */
describe('#3426 — async sub-agent handback after an interim-ack turn', () => {
  const CHAT = '12345'
  const ACK_TURN = '12345:_#10473'
  /** ms between turn_end (11:28:10) and the handback landing (11:28:51). */
  const HANDBACK_AGE_MS = 41_000

  interface OwnerTurn { turnId: string; answerDelivered: AnswerDeliveredLatch }

  /** The OLD (pre-#3426) decision, reproduced verbatim for the red-on-main
   *  contrast: the latch was a plain boolean, so ANY armed latch suppressed a
   *  late substantive reply regardless of which path armed it. */
  function oldBooleanLatchSuppression(input: {
    superseded: boolean
    replySubstantive: boolean
    isLateReply: boolean
    ownerAnswerDelivered: boolean
  }): boolean {
    if (input.superseded) return false
    if (!input.replySubstantive) return false
    if (!input.isLateReply) return false
    return input.ownerAnswerDelivered
  }

  /**
   * Drive the incident timeline through the SAME pure cores the gateway runs.
   * `latchSemantics` toggles the fixed source-tagged decision ('tagged') vs
   * the pre-fix boolean decision ('boolean' — red-on-main contrast).
   * Returns what the user ends up seeing.
   */
  function runDispatchAckHandback(latchSemantics: 'tagged' | 'boolean'): {
    delivered: string[]
    ownerId: string | null
    handbackSuppressed: boolean
  } {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 1_000_000
    const owner: OwnerTurn = { turnId: ACK_TURN, answerDelivered: false }
    const delivered: string[] = []

    // ── 1. Interim ack lands IN the live turn (substantive: 321 ≥ 200). ──
    // Live turn ⇒ isLateReply=false ⇒ never suppressed; the gateway then
    // arms the latch on the owner turn (outbound-send-path no-record tail).
    const ackSuppressed = decideAnswerLatchSuppression({
      superseded: false,
      replySubstantive: true,
      isLateReply: false, // currentTurn is live at ack time
      ownerAnswerDelivered: owner.answerDelivered,
    })
    expect(ackSuppressed).toBe(false)
    delivered.push('ack("Kicked off a fable researcher…")')
    owner.answerDelivered = 'reply' // the fixed arm site tags the source

    // ── 2. turn_end — the atom persists (endedAt stamped), latch still armed. ──

    // ── 3. The async handback lands 41 s later with NO live gateway turn. ──
    // DM ⇒ no origin_turn_id; no quote recovery; the latest-ended tier
    // resolves the ENDED ack turn as owner (41 s ≤ 60 s TTL) — the latch IS
    // genuinely reachable, which is exactly how the incident happened.
    const ownerId = resolveReplyOwnerTurnId({
      liveTurnId: null,
      originTurnId: null,
      quotedTurnId: null,
      latestEndedTurnId: owner.turnId,
      latestEndedAgeMs: HANDBACK_AGE_MS,
      latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
    })
    expect(ownerId).toBe(ACK_TURN)

    // No flush ever fired this turn ⇒ no supersede record to take.
    const supersede = reg.take(CHAT, undefined, { liveTurnId: ownerId, now: now + HANDBACK_AGE_MS })
    expect(supersede.supersede).toBe(false)

    const handbackSuppressed = latchSemantics === 'tagged'
      ? decideAnswerLatchSuppression({
          superseded: false,
          replySubstantive: true, // 1365 chars
          isLateReply: true, // no live gateway turn at handback time
          ownerAnswerDelivered: owner.answerDelivered,
        })
      : oldBooleanLatchSuppression({
          superseded: false,
          replySubstantive: true,
          isLateReply: true,
          // Pre-fix the latch was `true` (a bare boolean, source-blind).
          ownerAnswerDelivered: owner.answerDelivered !== false,
        })
    if (!handbackSuppressed) delivered.push('handback("Fable\'s back. The /model fix…")')
    return { delivered, ownerId, handbackSuppressed }
  }

  it('CORE REGRESSION (the fix): the handback is NOT suppressed — the user ' +
    'receives BOTH the interim ack AND the sub-agent findings', () => {
    const r = runDispatchAckHandback('tagged')
    expect(r.handbackSuppressed).toBe(false)
    expect(r.delivered).toEqual([
      'ack("Kicked off a fable researcher…")',
      'handback("Fable\'s back. The /model fix…")',
    ])
  })

  it('RED-ON-MAIN CONTRAST: the pre-fix boolean latch suppresses the handback ' +
    '— the silent drop (only the ack ever reaches the user)', () => {
    const r = runDispatchAckHandback('boolean')
    // Owner resolution is identical in both worlds — the ended ack turn.
    expect(r.ownerId).toBe(ACK_TURN)
    expect(r.handbackSuppressed).toBe(true)
    expect(r.delivered).toEqual(['ack("Kicked off a fable researcher…")'])
  })

  it('pure core: a reply-armed latch never suppresses a late substantive reply', () => {
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: 'reply',
      }),
    ).toBe(false)
  })

  it('flush race NOT reopened: the same late-landing shape against a ' +
    'FLUSH-armed latch is still suppressed (the Part 2 backstop holds)', () => {
    // Same timeline shape, but the turn's answer went out via the turn-flush
    // backstop (post-fire pre-record window): latch = 'flush', no record yet.
    expect(
      decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive: true,
        isLateReply: true,
        ownerAnswerDelivered: 'flush',
      }),
    ).toBe(true)
  })

  it('double-send NOT reopened: a byte-identical replay of the delivered ' +
    'reply is still caught by the #546 content dedup (60 s TTL)', () => {
    const dedup = new OutboundDedupCache()
    const now = 5_000_000
    const answer =
      'Fable is back. The /model fix landed in release 1.0.128 and the fallback ' +
      'behaviour matches what we saw in the transcripts yesterday evening.'
    // The reply path records what it sent (with its turn key)…
    dedup.record(CHAT, undefined, answer, now, ACK_TURN)
    // …and a late byte-identical replay (no live turn ⇒ null turnKey, which
    // matches any recorded entry) is deduped before the latch is ever consulted.
    const replay = dedup.check(CHAT, undefined, answer, now + HANDBACK_AGE_MS, null)
    expect(replay).not.toBeNull()
    // While the DIFFERENT-content handback sails past the content dedup…
    const handback = dedup.check(
      CHAT, undefined,
      'Completely different sub-agent findings text, long enough to clear the dedup floor.',
      now + HANDBACK_AGE_MS, null,
    )
    expect(handback).toBeNull()
  })
})

/**
 * #3429 — content evidence in the answer-delivered latch.
 *
 * A flush-armed latch used to suppress ANY late substantive reply resolving
 * the flush-delivered ended turn. With the supersede path now declining
 * new-content handbacks (they must send FRESH, not edit the flushed message in
 * place), those handbacks fall through to this latch — which would have
 * converted the #3429 silent edit into a #3426-style silent drop. The
 * `replyMatchesFlushedAnswer` evidence closes that: positive FALSE (the reply
 * is NOT the flushed answer) never suppresses; TRUE or unknown (null/omitted)
 * preserves the #2996 Part 2 flush-race backstop exactly as before.
 */
describe('#3429 — flush-armed latch with content evidence', () => {
  const base = {
    superseded: false,
    replySubstantive: true,
    isLateReply: true,
    ownerAnswerDelivered: 'flush' as const,
  }

  it('CORE: positive new-content evidence (matches === false) is NEVER suppressed ' +
    '— the handback after a flush-delivered turn delivers fresh', () => {
    expect(decideAnswerLatchSuppression({ ...base, replyMatchesFlushedAnswer: false })).toBe(false)
  })

  it('the flushed answer landing again (matches === true) is still suppressed ' +
    '(the flush race the latch exists for)', () => {
    expect(decideAnswerLatchSuppression({ ...base, replyMatchesFlushedAnswer: true })).toBe(true)
  })

  it('unknown evidence (null) keeps the conservative pre-#3429 suppression', () => {
    expect(decideAnswerLatchSuppression({ ...base, replyMatchesFlushedAnswer: null })).toBe(true)
  })

  it('omitted evidence keeps the conservative pre-#3429 suppression (back-compat)', () => {
    expect(decideAnswerLatchSuppression(base)).toBe(true)
  })

  it('evidence never overrides the reply-armed/unarmed rules (still no suppression)', () => {
    expect(
      decideAnswerLatchSuppression({ ...base, ownerAnswerDelivered: 'reply', replyMatchesFlushedAnswer: true }),
    ).toBe(false)
    expect(
      decideAnswerLatchSuppression({ ...base, ownerAnswerDelivered: false, replyMatchesFlushedAnswer: true }),
    ).toBe(false)
  })
})

/**
 * `resolveReplyOwnerTier` (fix/backstop-duplicate-reply) exposes WHICH precedence
 * tier won, so the gateway can apply the #3429 content gate ONLY on the ambiguous
 * `latest-ended` fallback. It shares one precedence with `resolveReplyOwnerTurnId`
 * (asserted equivalent below), so the winning id and the winning tier can never
 * disagree.
 */
describe('resolveReplyOwnerTier — precedence + latest-ended TTL bound', () => {
  const base: ReplyOwnerCandidates = {
    liveTurnId: null,
    originTurnId: null,
    quotedTurnId: null,
    latestEndedTurnId: null,
  }

  it('live wins over every lower tier', () => {
    expect(
      resolveReplyOwnerTier({ ...base, liveTurnId: 'L', originTurnId: 'O', quotedTurnId: 'Q', latestEndedTurnId: 'E' }),
    ).toBe('live')
  })

  it('origin wins when no live turn', () => {
    expect(resolveReplyOwnerTier({ ...base, originTurnId: 'O', quotedTurnId: 'Q', latestEndedTurnId: 'E' })).toBe('origin')
  })

  it('quoted wins when no live/origin turn (the positive DM recovery tier)', () => {
    expect(resolveReplyOwnerTier({ ...base, quotedTurnId: 'Q', latestEndedTurnId: 'E' })).toBe('quoted')
  })

  it('latest-ended is the ambiguous FALLBACK when only it resolves', () => {
    expect(resolveReplyOwnerTier({ ...base, latestEndedTurnId: 'E' })).toBe('latest-ended')
  })

  it('none when every lookup missed', () => {
    expect(resolveReplyOwnerTier(base)).toBe('none')
  })

  it('a STALE latest-ended (age > TTL) is NOT accepted → none, never latest-ended', () => {
    const stale: ReplyOwnerCandidates = {
      ...base,
      latestEndedTurnId: 'E',
      latestEndedAgeMs: DEFAULT_SUPERSEDE_TTL_MS + 1,
      latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
    }
    expect(resolveReplyOwnerTier(stale)).toBe('none')
    // And the id resolver agrees (no destructive authority granted to a stale turn).
    expect(resolveReplyOwnerTurnId(stale)).toBe(null)
  })

  it('tier and id resolver share one precedence for every candidate shape', () => {
    const shapes: ReplyOwnerCandidates[] = [
      base,
      { ...base, liveTurnId: 'L', quotedTurnId: 'Q', latestEndedTurnId: 'E' },
      { ...base, originTurnId: 'O', latestEndedTurnId: 'E' },
      { ...base, quotedTurnId: 'Q' },
      { ...base, latestEndedTurnId: 'E' },
    ]
    const idForTier = (s: ReplyOwnerCandidates): string | null => {
      switch (resolveReplyOwnerTier(s)) {
        case 'live': return s.liveTurnId
        case 'origin': return s.originTurnId
        case 'quoted': return s.quotedTurnId
        case 'latest-ended': return s.latestEndedTurnId
        case 'none': return null
      }
    }
    for (const s of shapes) {
      // The id the winning tier points at equals what the id resolver returns.
      expect(resolveReplyOwnerTurnId(s)).toBe(idForTier(s))
    }
  })
})

/**
 * `decideContentGateBypass` — WHEN the supersede path may treat a landing reply
 * as this flushed turn's own answer and collapse the provisional flush even
 * though the model REWORDED it.
 *
 * The rule replaced a blanket ban on the model-supplied `origin`/`quoted` tiers
 * with CORROBORATION against the framework-derived `latestEndedTurnId`. The two
 * properties that matter, both asserted below as outcomes:
 *
 *   - it closes the 2026-07-27 duplicate: a reply that echoes `origin_turn_id`
 *     for its OWN turn now bypasses, exactly as it would have by omitting the
 *     echo (the blanket ban punished the extra information);
 *   - it grants ZERO new capability: for every candidate shape, a corroborated
 *     `origin`/`quoted` bypass is reachable by dropping the model-supplied ids
 *     and landing on `latest-ended` — so nothing bypasses that could not
 *     already, and a STEERED attribution (pointing at a different turn than the
 *     framework resolves) still cannot.
 */
describe('decideContentGateBypass — corroborated bypass of the #3429 content gate', () => {
  const OWNER = 'turn-OWNER'
  const OTHER = 'turn-OTHER'

  /** Candidates whose framework-derived latest-ended IS `latestEnded`, fresh. */
  const cands = (over: Partial<ReplyOwnerCandidates> = {}): ReplyOwnerCandidates => ({
    liveTurnId: null,
    originTurnId: null,
    quotedTurnId: null,
    latestEndedTurnId: OWNER,
    latestEndedAgeMs: 30_000,
    latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
    ...over,
  })

  it('THE 2026-07-27 INCIDENT: an `origin` echo pointing at the SAME turn the ' +
    'framework resolves bypasses the gate (pre-fix: banned → visible duplicate)', () => {
    expect(
      decideContentGateBypass({
        tier: 'origin',
        resolvedTurnId: OWNER,
        candidates: cands({ originTurnId: OWNER }),
        handbackCouldOwnReply: false,
      }),
    ).toBe(true)
  })

  it('a `quoted` attribution corroborated the same way also bypasses', () => {
    expect(
      decideContentGateBypass({
        tier: 'quoted',
        resolvedTurnId: OWNER,
        candidates: cands({ quotedTurnId: OWNER }),
        handbackCouldOwnReply: false,
      }),
    ).toBe(true)
  })

  it('THE FABLE VECTOR stays closed: an `origin`/`quoted` attribution STEERED onto ' +
    'a different turn than the framework resolves never bypasses', () => {
    for (const tier of ['origin', 'quoted'] as const) {
      expect(
        decideContentGateBypass({
          tier,
          resolvedTurnId: OTHER,
          candidates: cands({
            originTurnId: tier === 'origin' ? OTHER : null,
            quotedTurnId: tier === 'quoted' ? OTHER : null,
            latestEndedTurnId: OWNER,
          }),
          handbackCouldOwnReply: false,
        }),
      ).toBe(false)
    }
  })

  it('a decoupled completion in the window keeps the gate on EVERY non-live tier', () => {
    for (const tier of ['origin', 'quoted', 'latest-ended'] as const) {
      expect(
        decideContentGateBypass({
          tier,
          resolvedTurnId: OWNER,
          candidates: cands({
            originTurnId: tier === 'origin' ? OWNER : null,
            quotedTurnId: tier === 'quoted' ? OWNER : null,
          }),
          handbackCouldOwnReply: true,
        }),
      ).toBe(false)
    }
  })

  it('`live` bypasses unconditionally — even inside a handback window ' +
    '(framework-owned, and decideSupersede bars it from another turn record)', () => {
    expect(
      decideContentGateBypass({
        tier: 'live',
        resolvedTurnId: OWNER,
        candidates: cands({ liveTurnId: OWNER }),
        handbackCouldOwnReply: true,
      }),
    ).toBe(true)
  })

  it('`none` never bypasses (nothing to attribute the reply to)', () => {
    expect(
      decideContentGateBypass({
        tier: 'none',
        resolvedTurnId: null,
        candidates: cands({ latestEndedTurnId: null }),
        handbackCouldOwnReply: false,
      }),
    ).toBe(false)
  })

  it('a STALE framework candidate corroborates NOTHING — the F2 freshness bound ' +
    'still denies a past-TTL turn any bypass authority', () => {
    const stale = cands({
      originTurnId: OWNER,
      latestEndedAgeMs: DEFAULT_SUPERSEDE_TTL_MS + 1,
    })
    expect(
      decideContentGateBypass({
        tier: 'origin',
        resolvedTurnId: OWNER,
        candidates: stale,
        handbackCouldOwnReply: false,
      }),
    ).toBe(false)
  })

  it('`latest-ended` behaviour is UNCHANGED by the widening (it corroborates itself)', () => {
    expect(
      decideContentGateBypass({
        tier: 'latest-ended',
        resolvedTurnId: OWNER,
        candidates: cands(),
        handbackCouldOwnReply: false,
      }),
    ).toBe(true)
  })

  // ─── #3726: total over degenerate input, and it fails CLOSED ───
  //
  // TypeScript makes `candidates` mandatory and the gateway always constructs
  // it, so this is production-unreachable — but the function is EXPORTED, and a
  // caller without the gateway's construction discipline used to get a
  // `TypeError` out of the supersede decision path (fail-open-by-crash) instead
  // of the safe answer. The safe answer is `false`: keep the #3429 content gate.
  it('#3726: an absent candidate set returns false (fail CLOSED), never throws', () => {
    for (const tier of ['origin', 'quoted', 'latest-ended'] as const) {
      for (const absent of [undefined, null]) {
        expect(
          decideContentGateBypass({
            tier,
            resolvedTurnId: OWNER,
            candidates: absent as unknown as ReplyOwnerCandidates,
            handbackCouldOwnReply: false,
          }),
        ).toBe(false)
      }
    }
  })

  // ─── ZERO new capability, as an EXHAUSTIVE property (#3724) ───
  //
  // The safety argument for widening `origin`/`quoted` from a blanket ban to
  // corroboration: every shape that bypasses via a model-supplied tier ALSO
  // bypasses with those model-supplied ids stripped (i.e. by the model simply
  // omitting `origin_turn_id` / `reply_to`). So the widening hands a reply no
  // reach it did not already have.
  //
  // #3724 — the previous form of this test hand-picked four candidate shapes and
  // guarded its assertion behind `if (withModelIds)`, so one of the four
  // asserted nothing at all, `handbackCouldOwnReply` was pinned `false`, and
  // `liveTurnId` was never varied. It could only go red if the corroboration
  // equality were deleted outright. It is replaced here by an exhaustive sweep
  // of the whole (small) candidate space that derives `tier`/`resolvedTurnId`
  // from the REAL resolvers rather than passing them in by hand — and, so the
  // sweep is evidence rather than decoration, by a companion test that runs the
  // SAME sweep over deliberately broken decisions and asserts it catches them.
  const IDS = [null, OWNER, OTHER] as const
  /** fresh / stale / unbounded (no age+ttl — the documented back-compat path). */
  const AGES = [
    { label: 'fresh', ageMs: 30_000 as number | null, ttlMs: DEFAULT_SUPERSEDE_TTL_MS as number | undefined },
    { label: 'stale', ageMs: DEFAULT_SUPERSEDE_TTL_MS + 1, ttlMs: DEFAULT_SUPERSEDE_TTL_MS },
    { label: 'unbounded', ageMs: null, ttlMs: undefined },
  ]

  type Decide = typeof decideContentGateBypass

  /** The module's freshness rule, restated locally so the mutants below can
   *  differ from the real decision in EXACTLY one respect each. */
  const freshEnough = (c: ReplyOwnerCandidates): boolean =>
    c.latestEndedTurnId != null &&
    (c.latestEndedAgeMs == null || c.latestEndedTtlMs == null
      ? true
      : c.latestEndedAgeMs <= c.latestEndedTtlMs)

  /**
   * Sweep the full candidate space against `decide`, reporting every case that
   * VIOLATES zero-new-capability (bypasses with the model-supplied ids present
   * but not with them stripped) plus coverage counters that stop the sweep
   * silently degrading to all-vacuous.
   */
  function sweepZeroNewCapability(decide: Decide): {
    violations: string[]
    cases: number
    bypasses: number
    modelTierBypasses: number
  } {
    const violations: string[] = []
    let cases = 0
    let bypasses = 0
    let modelTierBypasses = 0
    for (const liveTurnId of IDS)
      for (const originTurnId of IDS)
        for (const quotedTurnId of IDS)
          for (const latestEndedTurnId of IDS)
            for (const age of AGES)
              for (const handbackCouldOwnReply of [false, true]) {
                cases++
                const c: ReplyOwnerCandidates = {
                  liveTurnId,
                  originTurnId,
                  quotedTurnId,
                  latestEndedTurnId,
                  latestEndedAgeMs: age.ageMs,
                  latestEndedTtlMs: age.ttlMs,
                }
                const tier = resolveReplyOwnerTier(c)
                const withModelIds = decide({
                  tier,
                  resolvedTurnId: resolveReplyOwnerTurnId(c),
                  candidates: c,
                  handbackCouldOwnReply,
                })
                // Strip the model-supplied ids: the FRAMEWORK alone resolves the
                // owner — the reach the model already had by staying silent.
                const stripped: ReplyOwnerCandidates = {
                  ...c,
                  originTurnId: null,
                  quotedTurnId: null,
                }
                const withoutModelIds = decide({
                  tier: resolveReplyOwnerTier(stripped),
                  resolvedTurnId: resolveReplyOwnerTurnId(stripped),
                  candidates: stripped,
                  handbackCouldOwnReply,
                })
                if (withModelIds) {
                  bypasses++
                  if (tier === 'origin' || tier === 'quoted') modelTierBypasses++
                }
                if (withModelIds && !withoutModelIds) {
                  violations.push(
                    `tier=${tier} live=${liveTurnId} origin=${originTurnId} ` +
                      `quoted=${quotedTurnId} latestEnded=${latestEndedTurnId} ` +
                      `age=${age.label} handback=${handbackCouldOwnReply}`,
                  )
                }
              }
    return { violations, cases, bypasses, modelTierBypasses }
  }

  it('ZERO new capability over the EXHAUSTIVE candidate space: no shape bypasses ' +
    'with model-supplied ids that would not bypass without them', () => {
    const r = sweepZeroNewCapability(decideContentGateBypass)
    // The property itself — every violating shape is NAMED, not just counted.
    expect(r.violations).toEqual([])
    // Non-degeneracy: the sweep must actually cover the space and must actually
    // reach the branch under test, so it can never quietly become a no-op.
    expect(r.cases).toBe(IDS.length ** 4 * AGES.length * 2)
    expect(r.bypasses).toBeGreaterThan(0)
    // …and specifically, many cases must win their bypass on the WIDENED,
    // model-steerable `origin`/`quoted` tiers — the thing being vouched for.
    // Exactly 8 of the 486 cases do: no live turn, handback clear, a FRESH
    // latest-ended id, and the steered id equal to it.
    //
    // This floor was 16 before #3725. The other 8 were the `latestEndedAgeMs
    // == null` (unbounded) shapes, which corroborated a bypass off an anchor
    // that had never ended. #3725 makes the latest-ended lookup `endedOnly`, so
    // the age is always a real number and an explicit null age fails CLOSED —
    // those 8 shapes are now correctly unreachable. Lowering the floor here is
    // recording that narrowing, not conceding it: the property assertion above
    // (`violations` empty) is unchanged and still passes.
    expect(r.modelTierBypasses).toBeGreaterThanOrEqual(8)
  })

  // NON-VACUITY, asserted deterministically rather than demonstrated by hand:
  // the same sweep is run over mutants that break zero-new-capability in the two
  // realistic ways #3724 called out. If it could not go red on these, it would
  // not be evidence for the real function.
  it('the sweep is NOT vacuous: it catches a bypass that ignores corroboration, ' +
    'and one that ignores the handback window on the steerable tiers', () => {
    // Mutant A — the widening WITHOUT the corroboration equality: `origin`/
    // `quoted` bypass on any resolved turn. This is the Fable silent-edit-over.
    const ignoresCorroboration: Decide = (input) => {
      if (input.tier === 'live') return true
      if (input.tier === 'none') return false
      if (input.handbackCouldOwnReply) return false
      if (input.candidates == null) return false
      if (input.tier === 'origin' || input.tier === 'quoted') return true
      if (!freshEnough(input.candidates)) return false
      return input.resolvedTurnId === input.candidates.latestEndedTurnId
    }
    const a = sweepZeroNewCapability(ignoresCorroboration)
    expect(a.violations.length).toBeGreaterThan(0)

    // Mutant B — corroboration kept, handback guard dropped on the steerable
    // tiers only. The OLD hand-picked test stayed GREEN under exactly this,
    // because it pinned `handbackCouldOwnReply: false` in every shape.
    const ignoresHandback: Decide = (input) => {
      if (input.tier === 'live') return true
      if (input.tier === 'none') return false
      const steerable = input.tier === 'origin' || input.tier === 'quoted'
      if (input.handbackCouldOwnReply && !steerable) return false
      if (input.candidates == null) return false
      if (!freshEnough(input.candidates)) return false
      return (
        input.resolvedTurnId != null &&
        input.resolvedTurnId === input.candidates.latestEndedTurnId
      )
    }
    const b = sweepZeroNewCapability(ignoresHandback)
    expect(b.violations.length).toBeGreaterThan(0)
  })
})

/**
 * #3725 — the "framework-derived, TTL-bounded" supersede anchor was neither
 * ended nor bounded.
 *
 * The gateway's `recentTurnsById` registry is populated at turn START, so its
 * tail entry for a chat can be a turn that is STILL RUNNING (`endedAt: null`) —
 * and because the registry is chat-wide and thread-agnostic, a turn running in
 * another topic of the same chat lands there. The gateway then computed
 * `latestEndedAgeMs = endedAt != null ? now - endedAt : null`, and
 * `latestEndedAccepted` treated a null age as UNBOUNDED (its back-compat escape
 * for callers that supply no age at all). Net effect: a still-running turn
 * became a corroborating anchor with NO freshness bound, for the widened
 * `origin`/`quoted` content-gate bypass #3719 leans on.
 *
 * The fix is two-layer and both layers fail CLOSED:
 *   1. the gateway lookup skips turns with no `endedAt` (`latestTurnForChat`
 *      with `endedOnly: true`), so the anchor is a genuinely ended turn — and
 *      when the chat has no ended turn, there is NO anchor rather than a
 *      running one;
 *   2. `latestEndedAccepted` distinguishes an OMITTED age (undefined ⇒
 *      back-compat unbounded) from a COMPUTED-null age (⇒ rejected).
 */
describe('#3725 — a still-running turn is not a supersede anchor', () => {
  const CHAT = '12345'
  const ENDED = 'turn-ENDED'
  const RUNNING = 'turn-RUNNING'

  interface RegistryTurn { turnId: string; sessionChatId: string; endedAt: number | null }

  const NOW = 1_000_000

  /**
   * The gateway's candidate construction (`resolveReplyOwnerTurn`), mirrored
   * here because `gateway.ts` is not importable in tests — the same convention
   * the rest of this file uses. `scan` selects the FIXED lookup (`endedOnly`)
   * or the PRE-FIX one (tail entry regardless of `endedAt`), giving the
   * red-on-main contrast as an assertion rather than prose.
   */
  function gatewayCandidates(
    turns: RegistryTurn[],
    scan: 'fixed' | 'prefix',
    over: Partial<ReplyOwnerCandidates> = {},
  ): ReplyOwnerCandidates {
    const latestEnded =
      scan === 'fixed'
        ? latestTurnForChat(turns, CHAT, { endedOnly: true })
        : (turns.filter((t) => t.sessionChatId === CHAT).at(-1) ?? null)
    return {
      liveTurnId: null,
      originTurnId: null,
      quotedTurnId: null,
      latestEndedTurnId: latestEnded?.turnId ?? null,
      latestEndedAgeMs: latestEnded?.endedAt != null ? NOW - latestEnded.endedAt : null,
      latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
      ...over,
    }
  }

  /**
   * The PRE-FIX resolver semantics, reproduced verbatim for the red-on-main
   * contrast. BOTH layers of the defect are here: `latestEndedAccepted` treated
   * a null age as unbounded (`age == null ⇒ true`), and the gateway's scan (the
   * `'prefix'` mode above) handed it a turn that had not ended, whose age it
   * therefore computed as null.
   */
  function preFixAccepted(c: ReplyOwnerCandidates): boolean {
    if (c.latestEndedTurnId == null) return false
    const age = c.latestEndedAgeMs
    const ttl = c.latestEndedTtlMs
    if (age == null || ttl == null) return true
    return age <= ttl
  }
  function preFixTier(c: ReplyOwnerCandidates): ReplyOwnerTier {
    if (c.liveTurnId != null) return 'live'
    if (c.originTurnId != null) return 'origin'
    if (c.quotedTurnId != null) return 'quoted'
    if (preFixAccepted(c)) return 'latest-ended'
    return 'none'
  }
  function preFixOwnerId(c: ReplyOwnerCandidates): string | null {
    switch (preFixTier(c)) {
      case 'live': return c.liveTurnId
      case 'origin': return c.originTurnId
      case 'quoted': return c.quotedTurnId
      case 'latest-ended': return c.latestEndedTurnId
      case 'none': return null
    }
  }
  /** `decideContentGateBypass` as it stood before this fix (same rule, pre-fix
   *  acceptance). */
  function preFixBypass(c: ReplyOwnerCandidates): boolean {
    const tier = preFixTier(c)
    if (tier === 'live') return true
    if (tier === 'none') return false
    if (!preFixAccepted(c)) return false
    const id = preFixOwnerId(c)
    return id != null && id === c.latestEndedTurnId
  }

  /** A chat whose only ended turn is followed by a turn still running in
   *  another topic — the registry tail is the RUNNING turn. */
  const registry: RegistryTurn[] = [
    { turnId: ENDED, sessionChatId: CHAT, endedAt: NOW - 10_000 },
    { turnId: RUNNING, sessionChatId: CHAT, endedAt: null },
  ]

  it('the anchor is the ENDED turn, not the running tail entry (pre-fix scan ' +
    'picked the running turn with a null — unbounded — age)', () => {
    expect(gatewayCandidates(registry, 'fixed')).toMatchObject({
      latestEndedTurnId: ENDED,
      latestEndedAgeMs: 10_000,
    })
    expect(gatewayCandidates(registry, 'prefix')).toMatchObject({
      latestEndedTurnId: RUNNING,
      latestEndedAgeMs: null,
    })
  })

  it('a model-steered `origin` echo of the RUNNING turn gets NO corroborated ' +
    'bypass — pre-fix it did', () => {
    const steered = { originTurnId: RUNNING }
    const fixed = gatewayCandidates(registry, 'fixed', steered)
    expect(
      decideContentGateBypass({
        tier: resolveReplyOwnerTier(fixed),
        resolvedTurnId: resolveReplyOwnerTurnId(fixed),
        candidates: fixed,
        handbackCouldOwnReply: false,
      }),
    ).toBe(false)
    // Red-on-main contrast: the same reply DID bypass the #3429 content gate
    // before the fix, corroborated by a turn that had not even ended.
    expect(preFixBypass(gatewayCandidates(registry, 'prefix', steered))).toBe(true)
  })

  it('a chat with ONLY a running turn yields NO owner and NO bypass (fail ' +
    'closed), where pre-fix it yielded an unbounded latest-ended owner', () => {
    const onlyRunning: RegistryTurn[] = [{ turnId: RUNNING, sessionChatId: CHAT, endedAt: null }]
    const fixed = gatewayCandidates(onlyRunning, 'fixed')
    expect(fixed.latestEndedTurnId).toBeNull()
    expect(resolveReplyOwnerTier(fixed)).toBe('none')
    expect(resolveReplyOwnerTurnId(fixed)).toBeNull()
    expect(
      decideContentGateBypass({
        tier: 'none',
        resolvedTurnId: null,
        candidates: fixed,
        handbackCouldOwnReply: false,
      }),
    ).toBe(false)

    const prefix = gatewayCandidates(onlyRunning, 'prefix')
    expect(preFixTier(prefix)).toBe('latest-ended')
    expect(preFixOwnerId(prefix)).toBe(RUNNING)
  })

  it('layer 2: an EXPLICIT null age is rejected outright, while an OMITTED age ' +
    'keeps the pre-F2 back-compat escape', () => {
    const base: ReplyOwnerCandidates = {
      liveTurnId: null,
      originTurnId: null,
      quotedTurnId: null,
      latestEndedTurnId: ENDED,
      latestEndedTtlMs: DEFAULT_SUPERSEDE_TTL_MS,
    }
    // Computed-null (the caller's candidate turn has not ended) ⇒ closed.
    expect(resolveReplyOwnerTier({ ...base, latestEndedAgeMs: null })).toBe('none')
    expect(resolveReplyOwnerTurnId({ ...base, latestEndedAgeMs: null })).toBeNull()
    expect(
      decideContentGateBypass({
        tier: 'origin',
        resolvedTurnId: ENDED,
        candidates: { ...base, originTurnId: ENDED, latestEndedAgeMs: null },
        handbackCouldOwnReply: false,
      }),
    ).toBe(false)
    // Property omitted entirely ⇒ unchanged pre-F2 behaviour.
    expect(resolveReplyOwnerTier(base)).toBe('latest-ended')
    expect(resolveReplyOwnerTurnId(base)).toBe(ENDED)
  })

  it('end-to-end: a late reply while another topic is still running cannot ' +
    "delete a DIFFERENT turn's flush record", () => {
    const reg = new FlushedTurnSupersedeRegistry()
    // The still-running turn holds a fresh flush record of its own.
    reg.record(CHAT, undefined, { turnId: RUNNING, messageIds: [9001], text: 'A' }, NOW)
    // A late reply lands with no live turn, no echo, no quote. Pre-fix its owner
    // resolved to the RUNNING turn (registry tail, unbounded) and the take()
    // consumed that turn's record; with the fix the owner is the ENDED turn, so
    // the running turn's record is untouched.
    const onlyRunning: RegistryTurn[] = [
      { turnId: ENDED, sessionChatId: CHAT, endedAt: NOW - 10_000 },
      { turnId: RUNNING, sessionChatId: CHAT, endedAt: null },
    ]
    const ownerId = resolveReplyOwnerTurnId(gatewayCandidates(onlyRunning, 'fixed'))
    expect(ownerId).toBe(ENDED)
    expect(reg.take(CHAT, undefined, { liveTurnId: ownerId, now: NOW + 10 }).supersede).toBe(false)
    expect(reg.peek(CHAT, undefined, { liveTurnId: RUNNING, now: NOW + 10 }).supersede).toBe(true)
  })
})
