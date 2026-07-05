/**
 * Unit tests for the pure permission-card re-arm helpers (#2861 / #2859).
 *
 * These cover the discriminable decision logic extracted from gateway.ts
 * (which has top-level side effects and isn't unit-importable):
 *   - classifyPermissionRequest — duplicate / rearm / fresh
 *   - computeBootSweepStripTargets — grace-period strip filtering
 *   - isPermissionRearmEnabled / permissionRearmGraceMs — kill switch + knob
 *   - distinctRequestIds
 *
 * The gateway/bridge WIRING that consumes these is pinned separately in
 * permission-rearm-wiring.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyPermissionRequest,
  computeBootSweepStripTargets,
  isPermissionRearmEnabled,
  permissionRearmGraceMs,
  distinctRequestIds,
  PERMISSION_REARM_GRACE_MS,
} from '../gateway/permission-rearm.js'
import type { PersistedPermCard } from '../gateway/permission-card-store.js'

function card(requestId: string, messageId: number): PersistedPermCard {
  return {
    requestId,
    chatId: '-100123',
    messageId,
    startedAt: 1_000,
    toolName: 'mcp__brevo__post',
    cardText: 'Marko wants to post to Brevo',
  }
}

describe('classifyPermissionRequest', () => {
  it('already-live request → duplicate (ignore, no second card)', () => {
    expect(classifyPermissionRequest({ hasPending: true, persistedCount: 0 })).toBe('duplicate')
    // hasPending wins even if the store also has it
    expect(classifyPermissionRequest({ hasPending: true, persistedCount: 2 })).toBe('duplicate')
  })

  it('gone from memory but persisted → rearm', () => {
    expect(classifyPermissionRequest({ hasPending: false, persistedCount: 1 })).toBe('rearm')
    expect(classifyPermissionRequest({ hasPending: false, persistedCount: 3 })).toBe('rearm')
  })

  it('unknown request → fresh (post a new card)', () => {
    expect(classifyPermissionRequest({ hasPending: false, persistedCount: 0 })).toBe('fresh')
  })
})

describe('computeBootSweepStripTargets', () => {
  it('strips only entries NOT re-claimed by a bridge re-send', () => {
    const stale = [card('aaaaa', 10), card('bbbbb', 11), card('ccccc', 12)]
    const reclaimed = new Set(['bbbbb'])
    const targets = computeBootSweepStripTargets(stale, reclaimed)
    expect(targets.map(t => t.requestId)).toEqual(['aaaaa', 'ccccc'])
  })

  it('a re-claimed entry survives the deadline (empty strip)', () => {
    const stale = [card('aaaaa', 10)]
    const reclaimed = new Set(['aaaaa'])
    expect(computeBootSweepStripTargets(stale, reclaimed)).toEqual([])
  })

  it('an un-re-claimed entry is stripped at the deadline', () => {
    const stale = [card('aaaaa', 10)]
    const reclaimed = new Set<string>()
    expect(computeBootSweepStripTargets(stale, reclaimed).map(t => t.requestId)).toEqual(['aaaaa'])
  })

  it('keeps ALL fan-out messages for an un-re-claimed request', () => {
    // Same request_id, two operator surfaces → two persisted rows.
    const stale = [card('aaaaa', 10), card('aaaaa', 20)]
    const targets = computeBootSweepStripTargets(stale, new Set())
    expect(targets).toHaveLength(2)
    expect(targets.map(t => t.messageId).sort()).toEqual([10, 20])
  })
})

describe('distinctRequestIds', () => {
  it('dedupes request_ids across fan-out rows', () => {
    const cards = [card('aaaaa', 10), card('aaaaa', 20), card('bbbbb', 30)]
    expect(distinctRequestIds(cards).sort()).toEqual(['aaaaa', 'bbbbb'])
  })
})

describe('isPermissionRearmEnabled (kill switch)', () => {
  it('enabled by default (unset)', () => {
    expect(isPermissionRearmEnabled({})).toBe(true)
  })
  it('enabled for any value other than "0"', () => {
    expect(isPermissionRearmEnabled({ SWITCHROOM_PERMISSION_REARM: '1' })).toBe(true)
    expect(isPermissionRearmEnabled({ SWITCHROOM_PERMISSION_REARM: 'on' })).toBe(true)
  })
  it('disabled only for the exact "0" kill value', () => {
    expect(isPermissionRearmEnabled({ SWITCHROOM_PERMISSION_REARM: '0' })).toBe(false)
  })
})

describe('permissionRearmGraceMs', () => {
  it('defaults to PERMISSION_REARM_GRACE_MS when unset', () => {
    expect(permissionRearmGraceMs({})).toBe(PERMISSION_REARM_GRACE_MS)
  })
  it('honours a finite non-negative override (test collapse)', () => {
    expect(permissionRearmGraceMs({ SWITCHROOM_PERMISSION_REARM_GRACE_MS: '0' })).toBe(0)
    expect(permissionRearmGraceMs({ SWITCHROOM_PERMISSION_REARM_GRACE_MS: '250' })).toBe(250)
  })
  it('falls back to the default on garbage / negative', () => {
    expect(permissionRearmGraceMs({ SWITCHROOM_PERMISSION_REARM_GRACE_MS: 'nope' })).toBe(PERMISSION_REARM_GRACE_MS)
    expect(permissionRearmGraceMs({ SWITCHROOM_PERMISSION_REARM_GRACE_MS: '-5' })).toBe(PERMISSION_REARM_GRACE_MS)
  })
})
