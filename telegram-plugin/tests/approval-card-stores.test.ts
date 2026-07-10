/**
 * Race/ordering pins for the in-memory approval-card stores
 * (gateway/approval-card-stores.ts) extracted in #2996 Phase 3 step 1.
 *
 * These lock the exact orderings the gateway's reaper + callback handlers +
 * boot restore depend on, BEFORE the storage moved behind the store module:
 *
 *   1. verdict-during-sweep is single-shot — an operator tap (`.delete`) that
 *      lands while the sweep is iterating fires the expiry synthetic AT MOST
 *      once for a given card; a second sweep tick never double-wakes it.
 *   2. verdict-during-restore is desync-free — a `.set` (restore) then a
 *      `.delete` (tap) operate on one Map instance, so a tap can't resurrect a
 *      restored entry nor a restore resurrect a tapped one.
 *   3. sweep cadence/fault-isolation is byte-identical to the old inline
 *      `sweepExpiredEntries(...)`: only past-TTL entries expire, and one
 *      throwing expiry never skips the remaining entries.
 */

import { describe, it, expect } from 'vitest'
import {
  createSweepableCardStore,
  type SweepableCardStore,
} from '../gateway/approval-card-stores.js'

interface Card {
  staged_at: number
  agent: string
}

const TTL = 1000

function makeStore(
  expire: (stageId: string, v: Card, now: number) => void,
  log: (msg: string) => void = () => {},
): SweepableCardStore<Card> {
  return createSweepableCardStore<Card>({
    isExpired: (v, now) => now - v.staged_at > TTL,
    expire: () => expire,
    log: () => log,
  })
}

describe('approval-card-stores: sweep cadence', () => {
  it('expires only entries past TTL', () => {
    const expired: string[] = []
    const store = makeStore((id) => {
      expired.push(id)
      store.delete(id) // mirror the gateway's expire.remove()
    })
    store.set('fresh', { staged_at: 5000, agent: 'a' })
    store.set('stale', { staged_at: 1000, agent: 'b' })
    store.sweep(5000) // fresh: 0ms old, stale: 4000ms old > TTL
    expect(expired).toEqual(['stale'])
    expect(store.has('fresh')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })

  it('is single-shot across two reaper ticks (verdict-during-sweep safe)', () => {
    const wakes: string[] = []
    const store = makeStore((id) => {
      // The pure expire core removes BEFORE the fallible wake; model that here.
      store.delete(id)
      wakes.push(id)
    })
    store.set('c1', { staged_at: 0, agent: 'a' })
    store.sweep(5000)
    store.sweep(5000) // second tick — entry already gone
    expect(wakes).toEqual(['c1']) // exactly one wake, never two
  })

  it('a throwing expiry never skips the remaining entries', () => {
    const seen: string[] = []
    const store = makeStore((id) => {
      seen.push(id)
      if (id === 'boom') throw new Error('dead socket')
      store.delete(id)
    })
    store.set('boom', { staged_at: 0, agent: 'a' })
    store.set('ok', { staged_at: 0, agent: 'b' })
    expect(() => store.sweep(5000)).not.toThrow()
    expect(seen).toContain('boom')
    expect(seen).toContain('ok')
    expect(store.has('ok')).toBe(false) // 'ok' still expired despite 'boom' throwing
  })
})

describe('approval-card-stores: verdict-during-restore desync-free', () => {
  it('a tap after restore removes the restored entry (no resurrection)', () => {
    const store = makeStore(() => {})
    store.set('r1', { staged_at: 0, agent: 'a' }) // restore populates
    expect(store.get('r1')).toBeDefined()
    const removed = store.delete('r1') // operator tap resolves it
    expect(removed).toBe(true)
    expect(store.has('r1')).toBe(false)
  })

  it('a sweep after a tap on the same instance is a no-op for that card', () => {
    const wakes: string[] = []
    const store = makeStore((id) => {
      store.delete(id)
      wakes.push(id)
    })
    store.set('r2', { staged_at: 0, agent: 'a' })
    store.delete('r2') // tap resolves before the reaper runs
    store.sweep(5000)
    expect(wakes).toEqual([]) // already resolved — no timeout wake
  })
})

describe('approval-card-stores: Map surface parity', () => {
  it('supports get/set/delete/has/size/iteration used by call sites', () => {
    const store = makeStore(() => {})
    store.set('a', { staged_at: 1, agent: 'x' })
    store.set('b', { staged_at: 2, agent: 'y' })
    expect(store.size).toBe(2)
    expect(store.get('a')?.agent).toBe('x')
    const seen: string[] = []
    for (const [id] of store) seen.push(id)
    expect(seen.sort()).toEqual(['a', 'b'])
    expect([...store.values()].map((v) => v.agent).sort()).toEqual(['x', 'y'])
    expect(store.delete('a')).toBe(true)
    expect(store.has('a')).toBe(false)
  })
})
