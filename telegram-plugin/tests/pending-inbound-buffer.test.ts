/**
 * Pin the per-agent inbound buffer that closes the #1150 root cause:
 * if the gateway tries to deliver a synthetic inbound while the agent's
 * bridge isn't connected (mid-reconnect, claude-session bouncing, etc),
 * the inbound used to be silently dropped. Now it's buffered and
 * drained on the next bridge-register.
 */

import { describe, it, expect } from 'vitest'
import { createPendingInboundBuffer, redeliverBufferedInbound, idleDrainTick, DEFAULT_PENDING_INBOUND_CAP } from '../gateway/pending-inbound-buffer.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

function inbound(source: string, ts = Date.now()): InboundMessage {
  return {
    type: 'inbound',
    chatId: 'c1',
    messageId: ts,
    user: 'vault-broker',
    userId: 0,
    ts,
    text: `synthetic ${source}`,
    meta: { source },
  }
}

describe('pending-inbound-buffer', () => {
  it('push + drain — FIFO order per agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('a', inbound('vault_grant_approved', 1))
    buf.push('a', inbound('cron', 2))
    buf.push('a', inbound('reaction', 3))
    const drained = buf.drain('a')
    expect(drained.map((m) => m.meta?.source)).toEqual([
      'vault_grant_approved',
      'cron',
      'reaction',
    ])
  })

  it('drain is idempotent — second call returns empty', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('a', inbound('x'))
    expect(buf.drain('a')).toHaveLength(1)
    expect(buf.drain('a')).toHaveLength(0)
  })

  it('drain only affects the named agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('a', inbound('x'))
    buf.push('b', inbound('y'))
    expect(buf.drain('a').map((m) => m.meta?.source)).toEqual(['x'])
    expect(buf.depth('b')).toBe(1)
    expect(buf.drain('b').map((m) => m.meta?.source)).toEqual(['y'])
  })

  it('respects per-agent cap — oldest evicted when full', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 3, log: () => {} })
    // Push 1 .. 5; cap is 3 so 1, 2 should be evicted.
    buf.push('a', inbound('m1', 1))
    buf.push('a', inbound('m2', 2))
    buf.push('a', inbound('m3', 3))
    buf.push('a', inbound('m4', 4))
    buf.push('a', inbound('m5', 5))
    expect(buf.depth('a')).toBe(3)
    const drained = buf.drain('a')
    expect(drained.map((m) => m.meta?.source)).toEqual(['m3', 'm4', 'm5'])
  })

  it('push returns false when eviction occurred', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 2, log: () => {} })
    expect(buf.push('a', inbound('m1'))).toBe(true)
    expect(buf.push('a', inbound('m2'))).toBe(true)
    expect(buf.push('a', inbound('m3'))).toBe(false) // evicted m1
  })

  it('default cap is 32', () => {
    expect(DEFAULT_PENDING_INBOUND_CAP).toBe(32)
    const buf = createPendingInboundBuffer({ log: () => {} })
    for (let i = 0; i < 32; i++) buf.push('a', inbound(`m${i}`, i))
    expect(buf.depth('a')).toBe(32)
    buf.push('a', inbound('m33', 33))
    expect(buf.depth('a')).toBe(32) // still at cap
  })

  it('logs on eviction', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ capPerAgent: 1, log: (l) => logs.push(l) })
    buf.push('a', inbound('m1', 1))
    buf.push('a', inbound('m2', 2)) // evicts m1
    expect(logs.some((l) => l.includes('cap=1') && l.includes('dropped oldest'))).toBe(true)
    expect(logs.some((l) => l.includes('m1'))).toBe(true)
  })

  it('logs on push (depth tracking visibility)', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ log: (l) => logs.push(l) })
    buf.push('a', inbound('vault_grant_approved'))
    expect(logs.some((l) => l.includes('agent=a buffered source=vault_grant_approved depth_after=1'))).toBe(true)
  })

  it('logs on drain with source listing', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ log: (l) => logs.push(l) })
    buf.push('a', inbound('vault_grant_approved'))
    buf.push('a', inbound('cron'))
    logs.length = 0
    buf.drain('a')
    expect(logs.some((l) => l.includes('drained agent=a count=2'))).toBe(true)
    expect(logs.some((l) => l.includes('sources=[vault_grant_approved,cron]'))).toBe(true)
  })

  it('drain on empty agent does not log', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ log: (l) => logs.push(l) })
    expect(buf.drain('never-pushed')).toEqual([])
    expect(logs).toEqual([])
  })

  it('depth and totalDepth track correctly across agents', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    expect(buf.totalDepth()).toBe(0)
    buf.push('a', inbound('x'))
    buf.push('a', inbound('y'))
    buf.push('b', inbound('z'))
    expect(buf.depth('a')).toBe(2)
    expect(buf.depth('b')).toBe(1)
    expect(buf.depth('c')).toBe(0)
    expect(buf.totalDepth()).toBe(3)
    buf.drain('a')
    expect(buf.totalDepth()).toBe(1)
  })
})

describe('redeliverBufferedInbound — wedge-clear self-heal (fleet-update incident 2026-05-19)', () => {
  it('delivers every buffered message and empties the buffer when send succeeds', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    buf.push('klanker', inbound('user', 2))
    const seen: number[] = []
    const r = redeliverBufferedInbound(buf, 'klanker', (m) => {
      seen.push(m.messageId as number)
      return true
    })
    expect(r).toEqual({ drained: 2, redelivered: 2, rebuffered: 0 })
    expect(seen).toEqual([1, 2]) // FIFO preserved
    expect(buf.depth('klanker')).toBe(0)
  })

  it('re-buffers (loses nothing) when the bridge is still offline — send returns false', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    buf.push('klanker', inbound('cron', 2))
    const r = redeliverBufferedInbound(buf, 'klanker', () => false)
    expect(r).toEqual({ drained: 2, redelivered: 0, rebuffered: 2 })
    expect(buf.depth('klanker')).toBe(2) // still there, nothing lost
    expect(buf.drain('klanker').map((m) => m.meta?.source)).toEqual(['user', 'cron'])
  })

  it('treats a throwing send as not-delivered and re-buffers', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    const r = redeliverBufferedInbound(buf, 'klanker', () => {
      throw new Error('bridge write failed')
    })
    expect(r).toEqual({ drained: 1, redelivered: 0, rebuffered: 1 })
    expect(buf.depth('klanker')).toBe(1)
  })

  it('mixed: delivers what it can, re-buffers only the misses', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('a', 1))
    buf.push('klanker', inbound('b', 2))
    buf.push('klanker', inbound('c', 3))
    let n = 0
    const r = redeliverBufferedInbound(buf, 'klanker', () => {
      n++
      return n !== 2 // 2nd send fails
    })
    expect(r).toEqual({ drained: 3, redelivered: 2, rebuffered: 1 })
    expect(buf.drain('klanker').map((m) => m.meta?.source)).toEqual(['b'])
  })

  it('is a no-op on an empty buffer (no send calls)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    let calls = 0
    const r = redeliverBufferedInbound(buf, 'klanker', () => {
      calls++
      return true
    })
    expect(r).toEqual({ drained: 0, redelivered: 0, rebuffered: 0 })
    expect(calls).toBe(0)
  })

  it('only touches the named agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    buf.push('clerk', inbound('user', 2))
    redeliverBufferedInbound(buf, 'klanker', () => true)
    expect(buf.depth('klanker')).toBe(0)
    expect(buf.depth('clerk')).toBe(1) // untouched
  })
})

describe('idleDrainTick — the 3rd drain trigger (finn orphan gap, 2026-05-19)', () => {
  it('no-op (returns null, no send) when the buffer is empty', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    let sent = 0
    const r = idleDrainTick(buf, 'finn', () => true, () => { sent++; return true })
    expect(r).toBeNull()
    expect(sent).toBe(0)
  })

  it('no-op (returns null) when bridge is NOT alive — never drains into a dead bridge', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('finn', inbound('user', 1))
    let sent = 0
    const r = idleDrainTick(buf, 'finn', () => false, () => { sent++; return true })
    expect(r).toBeNull()
    expect(sent).toBe(0)
    expect(buf.depth('finn')).toBe(1) // untouched — onClientRegistered will get it on reconnect
  })

  it('flushes the buffer when bridge is alive AND something is buffered (the finn fix)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('finn', inbound('user', 2013)) // the orphaned "verify with mff-query.py" class
    const seen: number[] = []
    const r = idleDrainTick(buf, 'finn', () => true, (m) => { seen.push(m.messageId as number); return true })
    expect(r).toEqual({ drained: 1, redelivered: 1, rebuffered: 0 })
    expect(seen).toEqual([2013])
    expect(buf.depth('finn')).toBe(0)
  })

  it('is lossless — a delivery miss re-buffers, returns null on empty agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('finn', inbound('user', 1))
    const r = idleDrainTick(buf, 'finn', () => true, () => false)
    expect(r).toEqual({ drained: 1, redelivered: 0, rebuffered: 1 })
    expect(buf.depth('finn')).toBe(1) // nothing lost
    expect(idleDrainTick(buf, '', () => true, () => true)).toBeNull() // empty agent guard
  })

  it('checks depth BEFORE isBridgeAlive — empty buffer never probes the bridge', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    let probed = false
    const r = idleDrainTick(buf, 'finn', () => { probed = true; return true }, () => true)
    expect(r).toBeNull()
    expect(probed).toBe(false) // cheap path: Map.get only, no bridge probe, no log
  })
})

describe('durable-spool integration (finn/carrie lost-on-restart fix)', () => {
  function spySpool() {
    const puts: string[] = []
    const acks: string[] = []
    return {
      puts,
      acks,
      spool: {
        put: (_a: string, m: InboundMessage) => {
          puts.push(String(m.messageId))
          return true
        },
        ack: (m: InboundMessage) => {
          acks.push(String(m.messageId))
        },
        liveEntries: () => [],
        sweepEscalations: () => 0,
        liveCount: () => 0,
      },
    }
  }

  it('every push is durably spooled (chokepoint for all ~10 push sites)', () => {
    const sp = spySpool()
    const buf = createPendingInboundBuffer({ log: () => {}, spool: sp.spool as never })
    buf.push('carrie', inbound('user', 7))
    buf.push('carrie', inbound('user', 8))
    expect(sp.puts).toEqual(['7', '8'])
  })

  it('a CONFIRMED delivery acks the spool; a miss does NOT (stays durable)', () => {
    const sp = spySpool()
    const buf = createPendingInboundBuffer({ log: () => {}, spool: sp.spool as never })
    buf.push('carrie', inbound('user', 7))
    // delivery succeeds → spool acked
    redeliverBufferedInbound(buf, 'carrie', () => true, sp.spool as never)
    expect(sp.acks).toEqual(['7'])

    // delivery misses → NOT acked, re-buffered + still spooled
    const sp2 = spySpool()
    const buf2 = createPendingInboundBuffer({ log: () => {}, spool: sp2.spool as never })
    buf2.push('carrie', inbound('user', 9))
    redeliverBufferedInbound(buf2, 'carrie', () => false, sp2.spool as never)
    expect(sp2.acks).toEqual([]) // never acked on a miss → survives for retry/escalation
    expect(buf2.depth('carrie')).toBe(1) // re-buffered in memory too
  })

  it('idleDrainTick threads the spool through (ack only on delivered)', () => {
    const sp = spySpool()
    const buf = createPendingInboundBuffer({ log: () => {}, spool: sp.spool as never })
    buf.push('carrie', inbound('user', 7))
    idleDrainTick(buf, 'carrie', () => true, () => true, sp.spool as never)
    expect(sp.acks).toEqual(['7'])
  })

  it('works with no spool (back-compat: undefined spool is a no-op)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('carrie', inbound('user', 7))
    expect(redeliverBufferedInbound(buf, 'carrie', () => true)).toEqual({
      drained: 1,
      redelivered: 1,
      rebuffered: 0,
    })
  })
})
