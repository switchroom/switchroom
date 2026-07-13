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
 * Every test below is written so it would FAIL against the pre-fix behaviour
 * (no supersede — the second message always sends):
 *   - a fresh same-turn / ended-turn reply MUST report `supersede: true` with
 *     the flushed message ids to delete;
 *   - a reply belonging to a DIFFERENT newer live turn MUST NOT supersede
 *     (never clobber a fresh turn's own answer);
 *   - an expired record MUST NOT supersede;
 *   - `take` MUST consume the record so a replayed reply doesn't double-delete.
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
  it('supersedes when the flushed turn already ended (liveTurnId == null) — the common late-replay dup', () => {
    // Pre-fix: the reply just sent a second message. Post-fix: it supersedes
    // the flushed message. This is the exact 60s-window late-reply case.
    const d = decideSupersede(rec(), { liveTurnId: null, now: 1_000_000 + 10_000 })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([101, 102])
    expect(d.reason).toBe('supersede')
  })

  it('supersedes when the live turn IS the flushed turn (reply lands while same turn still pinned)', () => {
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: 'turn-A',
      now: 1_000_000 + 500,
    })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([101, 102])
  })

  it('does NOT supersede a reply belonging to a DIFFERENT newer live turn', () => {
    // A newer turn is live and produces its own answer — it must never delete
    // the earlier turn's message. This is the guard that keeps the fix from
    // eating a legitimate fresh answer.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: 'turn-B',
      now: 1_000_000 + 500,
    })
    expect(d.supersede).toBe(false)
    expect(d.deleteMessageIds).toEqual([])
    expect(d.reason).toBe('different-turn')
  })

  it('does NOT supersede once the record is past its TTL', () => {
    const d = decideSupersede(rec(), {
      liveTurnId: null,
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

  it('a null-turnId record is only superseded by a null-live-turn reply (conservative fallback)', () => {
    // No nonce on the record: it must never clobber a live turn.
    const live = decideSupersede(rec({ turnId: null }), {
      liveTurnId: 'turn-Z',
      now: 1_000_000,
    })
    expect(live.supersede).toBe(false)
    expect(live.reason).toBe('different-turn')

    const ended = decideSupersede(rec({ turnId: null }), {
      liveTurnId: null,
      now: 1_000_000,
    })
    expect(ended.supersede).toBe(true)
  })
})

describe('FlushedTurnSupersedeRegistry — record / peek / take lifecycle', () => {
  it('records a flush and supersedes the same turn`s later reply end to end', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7, 8], text: 'x' }, 1000)
    const d = reg.take('chat1', undefined, { liveTurnId: null, now: 5000 })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([7, 8])
  })

  it('take() CONSUMES the record so a replayed reply does not double-delete', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    const first = reg.take('chat1', undefined, { liveTurnId: null, now: 2000 })
    expect(first.supersede).toBe(true)
    // Replay of the same reply — the flushed message is already gone.
    const second = reg.take('chat1', undefined, { liveTurnId: null, now: 2001 })
    expect(second.supersede).toBe(false)
    expect(second.reason).toBe('no-record')
  })

  it('peek() does NOT consume — repeated peeks keep returning supersede', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    expect(reg.peek('chat1', undefined, { liveTurnId: null, now: 2000 }).supersede).toBe(true)
    expect(reg.peek('chat1', undefined, { liveTurnId: null, now: 2001 }).supersede).toBe(true)
  })

  it('does not record a flush that posted zero messages', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [], text: 'x' }, 1000)
    expect(reg.take('chat1', undefined, { liveTurnId: null, now: 2000 }).supersede).toBe(false)
  })

  it('keys per chat|thread — a flush in one thread never supersedes a reply in another', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', 42, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    // different thread, same chat
    expect(reg.take('chat1', 99, { liveTurnId: null, now: 2000 }).supersede).toBe(false)
    // correct thread supersedes
    expect(reg.take('chat1', 42, { liveTurnId: null, now: 2000 }).supersede).toBe(true)
  })

  it('a newest flush replaces the prior record for the same lane', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [1], text: 'a' }, 1000)
    reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [2], text: 'b' }, 1100)
    const d = reg.take('chat1', undefined, { liveTurnId: 'turn-B', now: 1200 })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([2])
  })

  it('size() evicts expired records', () => {
    const reg = new FlushedTurnSupersedeRegistry({ ttlMs: 1000 })
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [1], text: 'a' }, 1000)
    expect(reg.size(1500)).toBe(1)
    expect(reg.size(3000)).toBe(0)
  })
})
