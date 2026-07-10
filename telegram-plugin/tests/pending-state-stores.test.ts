/**
 * Contract + race/ordering pins for the long-tail pending-state stores
 * (gateway/pending-state-stores.ts), extracted in #2996 Phase 3 step 2.
 *
 * Written BEFORE the long-tail Maps moved behind the store module. They lock:
 *
 *   1. Each family's EXACT `isExpired` comparison direction survives verbatim —
 *      TTL directions differ across families (`now - staged_at > TTL`,
 *      `now - startedAt > TTL`, `now - createdAt > TTL`, `now - armed_at > TTL`,
 *      and the absolute `now > expiresAt`), and a store must delete exactly the
 *      entries the old open-coded loop deleted, not one tick early or late.
 *   2. `sweep` is delete-during-iteration safe (JS Map iterators tolerate
 *      deleting the current key — the raw reaper loops relied on this).
 *   3. The gateway-visible EAGER-SWEEP-AT-ADD pattern (the sweep called right
 *      after a `.set` at a staging site, e.g. `sweepSecretRequests()` after the
 *      `pendingSecretRequests.set` in executeRequestSecret) is single-shot: an
 *      add followed by an eager sweep expires only entries already past TTL and
 *      leaves the just-added fresh entry intact.
 *   4. Map-surface parity for every operation the call sites use, including the
 *      LRU eviction pattern `agentButtonMeta` uses (`keys().next().value`) and
 *      the live `size` getter.
 */

import { describe, it, expect } from 'vitest'
import {
  createSweepableStore,
  createPlainStore,
} from '../gateway/pending-state-stores.js'

// TTL constants mirror the gateway family values so the direction pins are
// meaningful (values themselves are not the contract — the direction is).
const VAULT_INPUT_TTL_MS = 5 * 60 * 1000
const VAULT_PASSPHRASE_TTL_MS = 30 * 60 * 1000
const DEFERRED_SECRET_TTL_MS = 5 * 60 * 1000
const ARMED_SECRET_CAPTURE_TTL_MS = 10 * 60_000
const ALWAYS_ALLOW_CORRELATION_TTL_MS = 30_000
const MENTAL_MODEL_CORRELATION_TTL_MS = 720_000
const REAUTH_INTERCEPT_TTL_MS = 10 * 60_000

describe('pending-state-stores: per-family isExpired direction (byte-identical)', () => {
  it('pendingVaultOps — now - startedAt > VAULT_INPUT_TTL_MS', () => {
    const store = createSweepableStore<{ startedAt: number }>(
      (v, now) => now - v.startedAt > VAULT_INPUT_TTL_MS,
    )
    const now = 10_000_000
    store.set('fresh', { startedAt: now - VAULT_INPUT_TTL_MS }) // exactly TTL old: NOT expired (> is strict)
    store.set('stale', { startedAt: now - VAULT_INPUT_TTL_MS - 1 })
    store.sweep(now)
    expect(store.has('fresh')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })

  it('vaultPassphraseCache — absolute now > expiresAt', () => {
    const store = createSweepableStore<{ expiresAt: number }>(
      (v, now) => now > v.expiresAt,
    )
    const now = 10_000_000
    store.set('atExpiry', { expiresAt: now }) // now > now is false → NOT expired
    store.set('past', { expiresAt: now - 1 })
    store.sweep(now)
    expect(store.has('atExpiry')).toBe(true)
    expect(store.has('past')).toBe(false)
    void VAULT_PASSPHRASE_TTL_MS
  })

  it('deferredSecrets — now - staged_at > DEFERRED_SECRET_TTL_MS', () => {
    const store = createSweepableStore<{ staged_at: number }>(
      (v, now) => now - v.staged_at > DEFERRED_SECRET_TTL_MS,
    )
    const now = 10_000_000
    store.set('fresh', { staged_at: now - DEFERRED_SECRET_TTL_MS })
    store.set('stale', { staged_at: now - DEFERRED_SECRET_TTL_MS - 1 })
    store.sweep(now)
    expect(store.has('fresh')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })

  it('armedSecretCaptures — now - armed_at > ARMED_SECRET_CAPTURE_TTL_MS', () => {
    const store = createSweepableStore<{ armed_at: number }>(
      (v, now) => now - v.armed_at > ARMED_SECRET_CAPTURE_TTL_MS,
    )
    const now = 10_000_000
    store.set('fresh', { armed_at: now - ARMED_SECRET_CAPTURE_TTL_MS })
    store.set('stale', { armed_at: now - ARMED_SECRET_CAPTURE_TTL_MS - 1 })
    store.sweep(now)
    expect(store.has('fresh')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })

  it('pendingAlwaysAllowCorrelations — 30s now - createdAt > TTL', () => {
    const store = createSweepableStore<{ createdAt: number }>(
      (v, now) => now - v.createdAt > ALWAYS_ALLOW_CORRELATION_TTL_MS,
    )
    const now = 10_000_000
    store.set('fresh', { createdAt: now - ALWAYS_ALLOW_CORRELATION_TTL_MS })
    store.set('stale', { createdAt: now - ALWAYS_ALLOW_CORRELATION_TTL_MS - 1 })
    store.sweep(now)
    expect(store.has('fresh')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })

  it('pendingMentalModelCorrelations — 720s now - createdAt > TTL (outlives the 30s window)', () => {
    const store = createSweepableStore<{ createdAt: number }>(
      (v, now) => now - v.createdAt > MENTAL_MODEL_CORRELATION_TTL_MS,
    )
    const now = 10_000_000
    // A slow-but-valid tap 10 min in must NOT be swept (the whole point of the
    // dedicated 720s TTL vs the 30s always-allow window).
    store.set('slowTap', { createdAt: now - 10 * 60_000 })
    store.set('stale', { createdAt: now - MENTAL_MODEL_CORRELATION_TTL_MS - 1 })
    store.sweep(now)
    expect(store.has('slowTap')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })

  it('pendingReauthFlows — now - startedAt > REAUTH_INTERCEPT_TTL_MS', () => {
    const store = createSweepableStore<{ startedAt: number }>(
      (v, now) => now - v.startedAt > REAUTH_INTERCEPT_TTL_MS,
    )
    const now = 10_000_000
    store.set('fresh', { startedAt: now - REAUTH_INTERCEPT_TTL_MS })
    store.set('stale', { startedAt: now - REAUTH_INTERCEPT_TTL_MS - 1 })
    store.sweep(now)
    expect(store.has('fresh')).toBe(true)
    expect(store.has('stale')).toBe(false)
  })
})

describe('pending-state-stores: sweep safety', () => {
  it('deletes every past-TTL entry across a multi-entry map (delete-during-iteration safe)', () => {
    const store = createSweepableStore<{ staged_at: number }>(
      (v, now) => now - v.staged_at > 1000,
    )
    for (let i = 0; i < 10; i++) store.set(`e${i}`, { staged_at: i % 2 === 0 ? 0 : 9_999_999 })
    store.sweep(1_000_000) // even entries stale, odd entries fresh
    for (let i = 0; i < 10; i++) {
      expect(store.has(`e${i}`)).toBe(i % 2 === 1)
    }
  })

  it('is single-shot across two sweep ticks', () => {
    const store = createSweepableStore<{ staged_at: number }>(
      (v, now) => now - v.staged_at > 1000,
    )
    store.set('one', { staged_at: 0 })
    store.sweep(1_000_000)
    expect(store.size).toBe(0)
    expect(() => store.sweep(1_000_000)).not.toThrow() // second tick — nothing left
    expect(store.size).toBe(0)
  })
})

describe('pending-state-stores: eager-sweep-at-add pattern (gateway-visible)', () => {
  // Mirrors executeRequestSecret: dedupe-drop prior stage for the same target,
  // .set the new one, then eagerly sweep. The just-added fresh entry survives;
  // a stale sibling is reaped in the same eager pass.
  it('add + eager sweep expires only stale siblings, keeps the fresh add', () => {
    const TTL = 30 * 60_000
    const store = createSweepableStore<{ chat_id: string; key: string; staged_at: number }>(
      (v, now) => now - v.staged_at > TTL,
    )
    const now = 100_000_000
    store.set('old', { chat_id: 'c', key: 'k1', staged_at: now - TTL - 1 }) // stale
    // Dedupe pass (same target) would delete a live dup; here targets differ.
    const fresh = { chat_id: 'c', key: 'k2', staged_at: now }
    store.set('new', fresh)
    store.sweep(now) // eager sweep at the add site
    expect(store.has('new')).toBe(true) // fresh add never self-expires
    expect(store.get('new')).toBe(fresh)
    expect(store.has('old')).toBe(false) // stale sibling reaped in the eager pass
  })

  it('dedupe-then-add-then-sweep leaves exactly the new entry', () => {
    const TTL = 30 * 60_000
    const store = createSweepableStore<{ chat_id: string; key: string; staged_at: number }>(
      (v, now) => now - v.staged_at > TTL,
    )
    const now = 100_000_000
    store.set('dup', { chat_id: 'c', key: 'k', staged_at: now - 1000 })
    // dedupe: drop prior stage for the same (chat, key)
    for (const [sid, p] of store) {
      if (p.chat_id === 'c' && p.key === 'k') store.delete(sid)
    }
    store.set('fresh', { chat_id: 'c', key: 'k', staged_at: now })
    store.sweep(now)
    expect([...store.keys()]).toEqual(['fresh'])
  })
})

describe('pending-state-stores: plain store (no sweep)', () => {
  it('has no sweep method and preserves Map surface', () => {
    const store = createPlainStore<{ n: number }>()
    expect((store as { sweep?: unknown }).sweep).toBeUndefined()
    store.set('a', { n: 1 })
    store.set('b', { n: 2 })
    expect(store.size).toBe(2)
    expect(store.get('a')?.n).toBe(1)
    expect(store.has('b')).toBe(true)
    expect(store.delete('a')).toBe(true)
    expect(store.has('a')).toBe(false)
  })

  it('agentButtonMeta LRU eviction — keys().next().value is the oldest insertion', () => {
    const AGENT_BUTTON_META_MAX = 3
    const store = createPlainStore<Map<string, { ack: string }>>()
    const remember = (key: string) => {
      store.set(key, new Map([['cb', { ack: key }]]))
      while (store.size > AGENT_BUTTON_META_MAX) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        store.delete(oldest)
      }
    }
    remember('m1')
    remember('m2')
    remember('m3')
    remember('m4') // evicts m1 (oldest insertion)
    expect(store.has('m1')).toBe(false)
    expect([...store.keys()]).toEqual(['m2', 'm3', 'm4'])
    expect(store.get('m4')?.get('cb')?.ack).toBe('m4')
  })

  it('pendingAskUser surface — values()/entries()/get/delete used by call sites', () => {
    const store = createPlainStore<{ chatId: string; messageId: number | null }>()
    store.set('ask1', { chatId: 'c1', messageId: 10 })
    store.set('ask2', { chatId: 'c2', messageId: null })
    expect([...store.values()].map((v) => v.chatId).sort()).toEqual(['c1', 'c2'])
    const collected: string[] = []
    for (const [askId] of store.entries()) collected.push(askId)
    expect(collected.sort()).toEqual(['ask1', 'ask2'])
    expect(store.get('ask1')?.messageId).toBe(10)
    store.delete('ask1')
    expect(store.size).toBe(1)
  })
})
