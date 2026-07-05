/**
 * #2787 Mechanism B — gateway-glue coverage for the `claudeBusyKeys` orphan
 * reaper and its lockstep shadow timestamp map.
 *
 * `gateway.ts` cannot be imported by a unit test — it boots the Telegram bot and
 * the IPC listener on module load. So this harness wires the SAME containers the
 * gateway owns (`claudeBusyKeys: Set`, `claudeBusyKeySince: Map`), the SAME
 * delivery-confirm queue used as the reaper's proof gate, and the REAL
 * `flushOnAgentDisconnect` used at bridge death — exactly as the gateway does
 * (see `markClaudeBusyForInbound`, `reapOrphanBusyKeysNow`, the delivery-confirm
 * sweep, and the `flushOnAgentDisconnect({ claudeBusyKeys, claudeBusyKeySince })`
 * call). It reproduces the two real defects the pure-helper tests could not:
 *
 *   1. Lockstep across a disconnect → reconnect → re-mark: a stale
 *      pre-disconnect timestamp must NOT survive to make a freshly-marked key
 *      look orphan-old.
 *   2. Slow-delivery safety: a merely-slow (up to ~5-min, #1922) delivery whose
 *      key is still tracked in the confirm queue must NOT be reaped even long
 *      past the grace, because `currentTurn == null` during the eager-mark→
 *      enqueue window is not proof of idle.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  markBusyKeyLockstep,
  reapOrphanBusyKeys,
  clearBusyKeyLockstep,
} from '../gateway/busy-key-reaper.js'
import { flushOnAgentDisconnect } from '../gateway/disconnect-flush.js'
import {
  createDeliveryQueue,
  trackDelivery,
  ackDelivery,
} from '../gateway/inbound-delivery-confirm.js'

const TTL = 30_000

/** The gateway's `reapOrphanBusyKeysNow` glue, reproduced verbatim: no turn in
 *  flight, reap keyed on set membership + a delivery-queue proof gate. */
function reap(
  keys: Set<string>,
  since: Map<string, number>,
  q: ReturnType<typeof createDeliveryQueue>,
  now: number,
  ttlMs = TTL,
): string[] {
  return reapOrphanBusyKeys(keys, since, now, {
    ttlMs,
    hasPendingDelivery: (key) => q.pending.has(key),
    log: () => {},
  })
}

/** Minimal disconnect-flush deps carrying the two containers under test — the
 *  real bridge-death path that clears busy keys. Mirrors the gateway's call. */
function flushDeps(claudeBusyKeys: Set<string>, claudeBusyKeySince: Map<string, number>) {
  return {
    agentName: 'clerk',
    activeStatusReactions: new Map(),
    activeReactionMsgIds: new Map(),
    activeTurnStartedAt: new Map<string, number>(),
    claudeBusyKeys,
    claudeBusyKeySince,
    activeDraftStreams: new Map(),
    clearActiveReactions: vi.fn(),
    disposeProgressDriver: vi.fn(),
    log: vi.fn(),
  }
}

describe('#2787 Mechanism B — orphan reaper (gateway glue)', () => {
  it('does NOT reap a slow-but-real delivery still tracked in the confirm queue, even far past the grace', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue<{ text: string }>()

    // Eager mark at delivery + track for ack (the normal user-inbound glue).
    markBusyKeyLockstep(keys, since, '-100:4', 0)
    trackDelivery(q, '-100:4', { text: 'slow but real' }, 0, '9001')

    // currentTurn is still null 6 MINUTES later (the #1922 tail) — but the
    // delivery is still pending its enqueue ack. The proof gate must protect it.
    expect(reap(keys, since, q, 360_000)).toEqual([])
    expect(keys.has('-100:4')).toBe(true)

    // Once claude finally acks (enqueue lands), the queue entry clears; the
    // gateway would then hold currentTurn and clear busy at turn_end.
    expect(ackDelivery(q, '-100:4', '9001')).toBe(true)
  })

  it('reaps a TRUE orphan — busy-marked, no pending delivery, past the grace', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue()

    // A steer/interrupt inbound marks busy but is excluded from tracking
    // (shouldTrackDelivery=false) — no queue entry. Its turn vanished without
    // clearing busy: a genuine stuck marker.
    markBusyKeyLockstep(keys, since, '555:_', 0)
    expect(reap(keys, since, q, TTL)).toEqual(['555:_'])
    expect(keys.has('555:_')).toBe(false)
    expect(since.has('555:_')).toBe(false)
  })

  it('does not reap before the grace elapses', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue()
    markBusyKeyLockstep(keys, since, '555:_', 0)
    expect(reap(keys, since, q, TTL - 1)).toEqual([])
    expect(keys.has('555:_')).toBe(true)
  })

  it('disconnect → reconnect → re-mark: fresh timestamp, key NOT reaped as stale (the lockstep fix)', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue()

    // t=0 first mark.
    markBusyKeyLockstep(keys, since, '-100:4', 0)

    // Bridge dies at t=1000 — the REAL disconnect flush clears BOTH containers
    // in lockstep (belt-and-suspenders to the set-membership guard).
    flushOnAgentDisconnect(flushDeps(keys, since))
    expect(keys.size).toBe(0)
    expect(since.size).toBe(0)

    // Reconnect and re-mark the SAME key at t=300_000 (well after the old stamp).
    markBusyKeyLockstep(keys, since, '-100:4', 300_000)

    // Pre-fix (stale t=0 stamp surviving the disconnect + a `!since.has` guard
    // declining to re-stamp) the age would read 300_000ms ≫ grace and the key
    // would be reaped THE INSTANT it was re-marked — re-opening the idle-drain
    // while claude is about to process this very inbound. With the fix the stamp
    // is fresh (t=300_000), so at t just past the re-mark it is NOT reaped.
    expect(reap(keys, since, q, 305_000)).toEqual([]) // age 5s < 30s grace
    expect(keys.has('-100:4')).toBe(true)

    // ...and it DOES reap once the fresh grace genuinely elapses.
    expect(reap(keys, since, q, 300_000 + TTL)).toEqual(['-100:4'])
  })

  it('disconnect while a delivery is pending: reconnect re-mark stays protected by the proof gate', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue<{ text: string }>()

    markBusyKeyLockstep(keys, since, '-100:4', 0)
    trackDelivery(q, '-100:4', { text: 'inflight' }, 0, '42')

    // Bridge flap: disconnect clears busy state; the offline buffer / re-deliver
    // loop still owns the inbound. Reconnect re-marks + re-tracks it.
    flushOnAgentDisconnect(flushDeps(keys, since))
    markBusyKeyLockstep(keys, since, '-100:4', 5_000)
    trackDelivery(q, '-100:4', { text: 'inflight' }, 5_000, '42')

    // Even minutes later, still pending its ack → never reaped.
    expect(reap(keys, since, q, 5_000 + 400_000)).toEqual([])
    expect(keys.has('-100:4')).toBe(true)
  })

  it('prunes shadow-map entries whose key already left the set (no unbounded growth)', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue()
    // Simulate a direct clear that (hypothetically) left the map behind.
    since.set('ghost:_', 0)
    reap(keys, since, q, 999_999)
    expect(since.has('ghost:_')).toBe(false)
  })

  it('re-mark of an already-busy key does NOT reset its timestamp (measures the true dangle)', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    const q = createDeliveryQueue()
    markBusyKeyLockstep(keys, since, 'k:_', 0)
    markBusyKeyLockstep(keys, since, 'k:_', 20_000) // still busy → no re-stamp
    expect(since.get('k:_')).toBe(0)
    // Orphaned (no pending delivery) → reaps on the ORIGINAL stamp's grace.
    expect(reap(keys, since, q, TTL)).toEqual(['k:_'])
  })

  it('clearBusyKeyLockstep removes from both containers', () => {
    const keys = new Set<string>()
    const since = new Map<string, number>()
    markBusyKeyLockstep(keys, since, 'k:_', 0)
    clearBusyKeyLockstep(keys, since, 'k:_')
    expect(keys.has('k:_')).toBe(false)
    expect(since.has('k:_')).toBe(false)
  })
})
