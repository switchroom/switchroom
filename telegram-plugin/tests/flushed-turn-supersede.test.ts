/**
 * Unit coverage for the turnId-keyed flushed-turn supersede registry
 * (2026-07 duplicate-reply fix).
 *
 * The regression these tests pin: the answer-ready quiescence flush (or the
 * turn-end backstop) posts a turn's terminal text as a Telegram message, then
 * the model's REAL `reply` tool call for the SAME turn lands ~10 s later and
 * ships a SECOND message. The pre-existing `OutboundDedupCache` misses this
 * because it matches on EXACT text equality — a `narration\n\nanswer` flush
 * never equals the clean `answer`-only reply.
 *
 * Identity-only supersede (adversarial-review HIGH fix): supersede fires ONLY
 * when the landing reply is positively attributable to the flushed turn by
 * turnId. A reply with an UNRESOLVED turn (`liveTurnId == null`) never deletes a
 * turnId-bearing record — we never delete a message we can't attribute to the
 * reply's own turn. The lane holds a per-turnId map, so two concurrent turns can
 * each flush a message and each turn's reply supersedes ONLY its own.
 */

import { describe, it, expect } from 'vitest'
import {
  decideSupersede,
  FlushedTurnSupersedeRegistry,
  DEFAULT_SUPERSEDE_TTL_MS,
  type FlushedTurnRecord,
} from '../flushed-turn-supersede.js'

const rec = (over: Partial<FlushedTurnRecord> = {}): FlushedTurnRecord => ({
  turnId: 'turn-A',
  messageIds: [101, 102],
  text: 'narration\n\nthe real answer',
  ts: 1_000_000,
  ...over,
})

describe('decideSupersede — the duplicate-reply decision core', () => {
  it('supersedes when the reply is attributed to the SAME turn as the flush', () => {
    // The common late-replay dup: the gateway resolves the reply's turnId (from
    // origin_turn_id) even after currentTurn cleared, so it matches by identity.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: 'turn-A',
      now: 1_000_000 + 10_000,
    })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([101, 102])
    expect(d.reason).toBe('supersede')
  })

  it('does NOT supersede a reply belonging to a DIFFERENT turn', () => {
    // A different turn is the resolved owner — it must never delete this turn's
    // message. This is the guard that keeps the fix from eating a legit answer.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: 'turn-B',
      now: 1_000_000 + 500,
    })
    expect(d.supersede).toBe(false)
    expect(d.deleteMessageIds).toEqual([])
    expect(d.reason).toBe('different-turn')
  })

  it('does NOT supersede a turnId-bearing record when the reply turn is UNRESOLVED (liveTurnId == null)', () => {
    // HIGH-finding core guard: a late reply we cannot attribute to a turn must
    // NEVER delete a message that positively belongs to some turn. Pre-fix the
    // null branch superseded ANY record — deleting a possibly-different turn's
    // legitimate message.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: null,
      now: 1_000_000 + 10_000,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('different-turn')
  })

  it('does NOT supersede once the record is past its TTL', () => {
    const d = decideSupersede(rec(), {
      liveTurnId: 'turn-A',
      now: 1_000_000 + DEFAULT_SUPERSEDE_TTL_MS + 1,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('expired')
  })

  it('returns no-record when there is nothing to supersede', () => {
    const d = decideSupersede(undefined, { liveTurnId: null, now: 1_000_000 })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('no-record')
  })

  it('a null-turnId record is superseded ONLY by an equally-unresolved (null) reply', () => {
    // A synthetic/no-nonce flush: only a reply that ALSO has no resolvable turn
    // matches it — it never clobbers a turn we CAN identify.
    const live = decideSupersede(rec({ turnId: null }), {
      liveTurnId: 'turn-Z',
      now: 1_000_000,
    })
    expect(live.supersede).toBe(false)
    expect(live.reason).toBe('different-turn')

    const unresolved = decideSupersede(rec({ turnId: null }), {
      liveTurnId: null,
      now: 1_000_000,
    })
    expect(unresolved.supersede).toBe(true)
  })
})

describe('FlushedTurnSupersedeRegistry — record / peek / take lifecycle', () => {
  it('records a flush and supersedes the same turn`s later reply end to end', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7, 8], text: 'x' }, 1000)
    const d = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 5000 })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([7, 8])
  })

  it('take() CONSUMES the matched record so a replayed reply does not double-delete', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    const first = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 2000 })
    expect(first.supersede).toBe(true)
    // Replay of the same reply — the flushed message is already gone.
    const second = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 2001 })
    expect(second.supersede).toBe(false)
    expect(second.reason).toBe('no-record')
  })

  it('peek() does NOT consume — repeated peeks keep returning supersede', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(true)
    expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 2001 }).supersede).toBe(true)
  })

  it('does not record a flush that posted zero messages', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [], text: 'x' }, 1000)
    expect(reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(false)
  })

  it('keys per chat|thread — a flush in one thread never supersedes a reply in another', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', 42, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    // different thread, same chat
    expect(reg.take('chat1', 99, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(false)
    // correct thread supersedes
    expect(reg.take('chat1', 42, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(true)
  })

  // ---- HIGH finding regression: wrong-delete via a null-turn late reply. ----
  describe('HIGH regression — two concurrent turns on one lane', () => {
    it('turn A`s late reply supersedes ONLY A`s flush, never turn B`s legitimate message', () => {
      const reg = new FlushedTurnSupersedeRegistry()
      // Turn A flushes msg 100.
      reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [100], text: 'a' }, 1000)
      // Turn B flushes msg 200 (B's real answer message).
      reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [200], text: 'b' }, 1100)

      // Turn A's real reply lands late, resolved (via origin_turn_id) to turn A.
      const dA = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 1200 })
      expect(dA.supersede).toBe(true)
      expect(dA.deleteMessageIds).toEqual([100]) // NOT [200] — B's message is untouched.

      // B's own message is still independently supersedable by B's reply — proof
      // A's reply did not consume or clobber B's record.
      const dB = reg.take('chat1', undefined, { liveTurnId: 'turn-B', now: 1300 })
      expect(dB.supersede).toBe(true)
      expect(dB.deleteMessageIds).toEqual([200])
    })

    it('an UNRESOLVED (null-turn) late reply does NOT delete a different turn`s legitimate message', () => {
      // This is the exact wrong-delete the review flagged. Pre-fix: single lane
      // slot overwritten to {turn-B,[200]} + promiscuous null branch → the null
      // reply superseded and DELETED msg 200 (B's good answer). Post-fix: a null
      // liveTurnId matches no turnId-bearing record, so nothing is deleted.
      const reg = new FlushedTurnSupersedeRegistry()
      reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [100], text: 'a' }, 1000)
      reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [200], text: 'b' }, 1100)

      const d = reg.take('chat1', undefined, { liveTurnId: null, now: 1200 })
      expect(d.supersede).toBe(false)
      expect(d.deleteMessageIds).toEqual([])

      // Both records survive — neither turn's message was wrongly deleted.
      expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 1300 }).supersede).toBe(true)
      expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-B', now: 1300 }).supersede).toBe(true)
    })
  })

  it('size() evicts expired records and prunes emptied lanes', () => {
    const reg = new FlushedTurnSupersedeRegistry({ ttlMs: 1000 })
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [1], text: 'a' }, 1000)
    reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [2], text: 'b' }, 1000)
    expect(reg.size(1500)).toBe(2)
    expect(reg.size(3000)).toBe(0)
  })

  it('record() actively sweeps expired records (LOW-2 GC — no orphan accumulation)', () => {
    const reg = new FlushedTurnSupersedeRegistry({ ttlMs: 1000 })
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [1], text: 'a' }, 1000)
    // A much later flush on a DIFFERENT lane sweeps the now-expired turn-A record.
    reg.record('chat2', undefined, { turnId: 'turn-B', messageIds: [2], text: 'b' }, 5000)
    // Only the fresh record remains; the orphan was swept, not left to leak.
    expect(reg.size(5000)).toBe(1)
    expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 5000 }).reason).toBe('no-record')
  })
})
