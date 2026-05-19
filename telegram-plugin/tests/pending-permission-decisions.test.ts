/**
 * Pin the per-agent permission-verdict buffer (PR-3 of the callback→
 * model-continuation series). A tool/skill/MCP permission request
 * suspends the claude turn inside the MCP permission call until the
 * operator's Approve/Deny verdict is relayed back. The verdict sites
 * previously `broadcast(...)` fire-and-forget, so a verdict produced
 * while the bridge was mid-reconnect was dropped and the model stayed
 * wedged forever (user tapped, nothing happened, silence). This buffer
 * — the permission analog of pending-inbound-buffer — holds the missed
 * verdict and is drained on the next bridge register.
 */

import { describe, it, expect } from 'vitest'
import {
  createPendingPermissionBuffer,
  DEFAULT_PENDING_PERMISSION_CAP,
} from '../gateway/pending-permission-decisions.js'
import type { PermissionEvent } from '../gateway/ipc-protocol.js'

function verdict(
  requestId: string,
  behavior: 'allow' | 'deny' = 'allow',
  rule?: string,
): PermissionEvent {
  return { type: 'permission', requestId, behavior, ...(rule ? { rule } : {}) }
}

describe('pending-permission-decisions', () => {
  it('push + drain — FIFO order per agent, idempotent drain', () => {
    const buf = createPendingPermissionBuffer({ log: () => {} })
    buf.push('a', verdict('r1', 'allow'))
    buf.push('a', verdict('r2', 'deny'))
    buf.push('b', verdict('r3', 'allow'))
    const a = buf.drain('a')
    expect(a.map((e) => e.requestId)).toEqual(['r1', 'r2'])
    expect(a[1]!.behavior).toBe('deny')
    expect(buf.drain('a')).toEqual([]) // idempotent
    expect(buf.drain('b').map((e) => e.requestId)).toEqual(['r3'])
    expect(buf.totalDepth()).toBe(0)
  })

  it('preserves the always-allow rule field through buffering', () => {
    const buf = createPendingPermissionBuffer({ log: () => {} })
    buf.push('a', verdict('r1', 'allow', 'Bash(ls:*)'))
    const [ev] = buf.drain('a')
    expect(ev!.rule).toBe('Bash(ls:*)')
    expect(ev!.behavior).toBe('allow')
  })

  it('per-agent cap drops the OLDEST verdict and reports eviction', () => {
    const buf = createPendingPermissionBuffer({ capPerAgent: 3, log: () => {} })
    expect(buf.push('a', verdict('r1'))).toBe(true)
    expect(buf.push('a', verdict('r2'))).toBe(true)
    expect(buf.push('a', verdict('r3'))).toBe(true)
    expect(buf.push('a', verdict('r4'))).toBe(false) // evicted oldest
    const drained = buf.drain('a')
    expect(drained.map((e) => e.requestId)).toEqual(['r2', 'r3', 'r4'])
  })

  it('depth/totalDepth track buffered verdicts', () => {
    const buf = createPendingPermissionBuffer({ log: () => {} })
    expect(buf.depth('a')).toBe(0)
    buf.push('a', verdict('r1'))
    buf.push('a', verdict('r2'))
    buf.push('b', verdict('r3'))
    expect(buf.depth('a')).toBe(2)
    expect(buf.totalDepth()).toBe(3)
  })

  it('exports a sane default cap', () => {
    expect(DEFAULT_PENDING_PERMISSION_CAP).toBeGreaterThanOrEqual(8)
  })
})
