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
  type AnswerDeliveredLatch,
} from '../reply-owner-resolve.js'
import { FlushedTurnSupersedeRegistry, DEFAULT_SUPERSEDE_TTL_MS } from '../flushed-turn-supersede.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'

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
