/**
 * Behavioral pins for the pure approval-card expiry core
 * (gateway/pending-card-expiry.ts) — the ordering + fault-isolation contract
 * the gateway's reaper relies on:
 *
 *   - single-shot: two reaper ticks fire exactly ONE synthetic per expired card
 *     (delete-before-deliver, pinned behaviorally, not by regex),
 *   - a throwing deliver (half-dead IPC socket) never loses the
 *     missed-approvals re-offer and never escapes to the caller,
 *   - one throwing expiry never skips the remaining entries in a sweep.
 */

import { describe, it, expect, vi } from 'vitest'
import type { InboundMessage } from '../gateway/ipc-protocol.js'
import {
  expirePendingCard,
  sweepExpiredEntries,
  type ExpireCardDeps,
} from '../gateway/pending-card-expiry.js'

const INBOUND: InboundMessage = {
  type: 'inbound',
  chatId: '1',
  messageId: 1,
  user: 'vault-broker',
  userId: 0,
  ts: 1,
  text: 'timeout',
}

function makeDeps(overrides: Partial<ExpireCardDeps> = {}): ExpireCardDeps & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    remove: () => calls.push('remove'),
    editCard: () => calls.push('editCard'),
    buildInbound: () => {
      calls.push('buildInbound')
      return INBOUND
    },
    deliver: () => {
      calls.push('deliver')
      return true
    },
    recordMiss: () => calls.push('recordMiss'),
    log: () => {},
    ...overrides,
  }
}

describe('expirePendingCard — ordering contract', () => {
  it('runs remove FIRST, then editCard, then recordMiss BEFORE deliver', () => {
    const deps = makeDeps()
    const { delivered } = expirePendingCard(deps)
    expect(delivered).toBe(true)
    expect(deps.calls).toEqual(['remove', 'editCard', 'recordMiss', 'buildInbound', 'deliver'])
  })

  it('a throwing deliver returns delivered=false, never throws, and the re-offer is already recorded', () => {
    const log = vi.fn()
    const deps = makeDeps({
      deliver: () => {
        throw new Error('EPIPE: half-dead socket')
      },
      log,
    })
    const { delivered } = expirePendingCard(deps)
    expect(delivered).toBe(false)
    // recordMiss ran BEFORE the deliver attempt — the missed-approvals entry
    // survives the failed wake (the operator's return re-offers it).
    expect(deps.calls).toContain('recordMiss')
    expect(deps.calls.indexOf('recordMiss')).toBeLessThan(deps.calls.indexOf('buildInbound'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('delivery failed'))
  })

  it('a throwing editCard still records the miss and delivers the wake', () => {
    const deps = makeDeps({
      editCard: () => {
        throw new Error('telegram edit failed')
      },
    })
    const { delivered } = expirePendingCard(deps)
    expect(delivered).toBe(true)
    expect(deps.calls).toEqual(['remove', 'recordMiss', 'buildInbound', 'deliver'])
  })

  it('a throwing recordMiss still delivers the wake', () => {
    const deps = makeDeps({
      recordMiss: () => {
        throw new Error('store write failed')
      },
    })
    const { delivered } = expirePendingCard(deps)
    expect(delivered).toBe(true)
    expect(deps.calls).toContain('deliver')
  })
})

describe('sweepExpiredEntries — single-shot across ticks', () => {
  interface Entry {
    staged_at: number
  }
  const TTL = 60_000

  function makeSweepWorld() {
    const map = new Map<string, Entry>()
    const synthetics: string[] = []
    const expire = (stageId: string, _v: Entry, _now: number) => {
      // Mirrors the gateway wiring: expirePendingCard with remove-from-map
      // FIRST and the synthetic recorded on deliver.
      expirePendingCard({
        remove: () => map.delete(stageId),
        editCard: () => {},
        buildInbound: () => INBOUND,
        deliver: () => {
          synthetics.push(stageId)
          return true
        },
        recordMiss: () => {},
        log: () => {},
      })
    }
    const tick = (now: number) =>
      sweepExpiredEntries(map, (v, n) => v.staged_at < n - TTL, expire, now, () => {})
    return { map, synthetics, tick }
  }

  it('two reaper ticks fire exactly ONE synthetic per expired card', () => {
    const { map, synthetics, tick } = makeSweepWorld()
    map.set('s1', { staged_at: 0 })
    map.set('s2', { staged_at: 0 })
    map.set('fresh', { staged_at: 150_000 }) // still inside TTL at both ticks

    tick(120_000) // both s1+s2 expired; fresh is not
    tick(180_000) // second tick — expired entries are GONE from the map

    expect(synthetics.sort()).toEqual(['s1', 's2'])
    expect(map.has('fresh')).toBe(true)
    expect(map.size).toBe(1)
  })

  it('delete-before-deliver: the map entry is gone by the time the synthetic fires', () => {
    const map = new Map<string, Entry>()
    map.set('s1', { staged_at: 0 })
    let presentAtDeliver: boolean | null = null
    sweepExpiredEntries(
      map,
      (v, n) => v.staged_at < n - TTL,
      (stageId) => {
        expirePendingCard({
          remove: () => map.delete(stageId),
          editCard: () => {},
          buildInbound: () => INBOUND,
          deliver: () => {
            presentAtDeliver = map.has(stageId)
            return true
          },
          recordMiss: () => {},
          log: () => {},
        })
      },
      120_000,
      () => {},
    )
    expect(presentAtDeliver).toBe(false)
  })

  it('one throwing expiry does not skip the remaining entries', () => {
    const map = new Map<string, Entry>()
    map.set('boom', { staged_at: 0 })
    map.set('ok', { staged_at: 0 })
    const expired: string[] = []
    const log = vi.fn()
    sweepExpiredEntries(
      map,
      (v, n) => v.staged_at < n - TTL,
      (stageId) => {
        if (stageId === 'boom') throw new Error('dead socket at the worst layer')
        map.delete(stageId)
        expired.push(stageId)
      },
      120_000,
      log,
    )
    expect(expired).toEqual(['ok'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
