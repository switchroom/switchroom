/**
 * Pin the per-agent inbound buffer that closes the #1150 root cause:
 * if the gateway tries to deliver a synthetic inbound while the agent's
 * bridge isn't connected (mid-reconnect, claude-session bouncing, etc),
 * the inbound used to be silently dropped. Now it's buffered and
 * drained on the next bridge-register.
 */

import { describe, it, expect } from 'vitest'
import { createPendingInboundBuffer, redeliverBufferedInbound, idleDrainTick, planBufferedRedelivery, selectEvictionVictim, DEFAULT_PENDING_INBOUND_CAP, APPROVAL_OUTCOME_PROTECTION_MS } from '../gateway/pending-inbound-buffer.js'
import { APPROVAL_OUTCOME_SOURCES, APPROVAL_OUTCOME_DROPPED_SOURCE, isApprovalOutcome, createApprovalOutcomeDropNotifier } from '../gateway/approval-outcome-sources.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'
import { ObligationLedger } from '../gateway/obligation-ledger.js'
import { makeRepresentRedeliveryGuard } from '../gateway/represent-delivery-guard.js'

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

/** An ordinary Telegram user message — NO meta.source, so it's mergeable. */
function userMsg(
  opts: {
    text: string
    chatId?: string
    threadId?: number
    userId?: number
    ts?: number
    imagePath?: string
    attachment?: InboundMessage['attachment']
  },
): InboundMessage {
  const ts = opts.ts ?? Date.now()
  const m: InboundMessage = {
    type: 'inbound',
    chatId: opts.chatId ?? 'c1',
    messageId: ts,
    user: 'alice',
    userId: opts.userId ?? 42,
    ts,
    text: opts.text,
    meta: {},
  }
  if (opts.threadId != null) m.threadId = opts.threadId
  if (opts.imagePath != null) m.imagePath = opts.imagePath
  if (opts.attachment != null) m.attachment = opts.attachment
  return m
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

  // #2789 A: a >cap burst mid-turn used to evict the oldest SILENTLY —
  // the durable spool copy only replays at boot / escalates after 15 min,
  // so within a live session the evicted message was just gone with no
  // user-visible signal. onEvict makes the eviction non-silent so the
  // caller can surface a coalesced "messages deferred" notice.
  it('#2789 A: fires onEvict with the evicted message on cap eviction (not a silent drop)', () => {
    const evicted: InboundMessage[] = []
    const buf = createPendingInboundBuffer({
      capPerAgent: 3,
      log: () => {},
      onEvict: (_agent, m) => evicted.push(m),
    })
    // Fill to cap — no eviction yet, no notice.
    buf.push('a', inbound('m1', 1))
    buf.push('a', inbound('m2', 2))
    buf.push('a', inbound('m3', 3))
    expect(evicted).toHaveLength(0)
    // The 4th push overflows the cap → oldest (m1) evicted → onEvict fires.
    buf.push('a', inbound('m4', 4))
    expect(evicted.map((m) => m.meta?.source)).toEqual(['m1'])
    // The 5th evicts m2.
    buf.push('a', inbound('m5', 5))
    expect(evicted.map((m) => m.meta?.source)).toEqual(['m1', 'm2'])
  })

  it('#2789 A: a >32 burst produces one onEvict per evicted entry, never a silent drop', () => {
    const evicted: InboundMessage[] = []
    const buf = createPendingInboundBuffer({
      log: () => {}, // default cap = 32
      onEvict: (_agent, m) => evicted.push(m),
    })
    // 40 messages into a 32-cap buffer → exactly 8 evictions, all reported.
    for (let i = 1; i <= 40; i++) buf.push('a', inbound(`m${i}`, i))
    expect(buf.depth('a')).toBe(32)
    expect(evicted).toHaveLength(8)
    expect(evicted.map((m) => m.meta?.source)).toEqual([
      'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8',
    ])
  })

  it('#2789 A: a throwing onEvict never breaks the push hot path', () => {
    const buf = createPendingInboundBuffer({
      capPerAgent: 1,
      log: () => {},
      onEvict: () => {
        throw new Error('notice failed')
      },
    })
    buf.push('a', inbound('m1', 1))
    expect(() => buf.push('a', inbound('m2', 2))).not.toThrow()
    expect(buf.depth('a')).toBe(1)
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
    // PR D: victim selection is tiered, so the line names the index + tier
    // rather than claiming "oldest" (it is the oldest of its tier).
    expect(
      logs.some((l) => l.includes('cap=1') && l.includes('dropped entry idx=0 reason=non-outcome')),
    ).toBe(true)
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
    expect(r).toEqual({ drained: 2, redelivered: 2, rebuffered: 0, retracted: 0 })
    expect(seen).toEqual([1, 2]) // FIFO preserved
    expect(buf.depth('klanker')).toBe(0)
  })

  it('re-buffers (loses nothing) when the bridge is still offline — send returns false', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    buf.push('klanker', inbound('cron', 2))
    const r = redeliverBufferedInbound(buf, 'klanker', () => false)
    expect(r).toEqual({ drained: 2, redelivered: 0, rebuffered: 2, retracted: 0 })
    expect(buf.depth('klanker')).toBe(2) // still there, nothing lost
    expect(buf.drain('klanker').map((m) => m.meta?.source)).toEqual(['user', 'cron'])
  })

  it('treats a throwing send as not-delivered and re-buffers', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    const r = redeliverBufferedInbound(buf, 'klanker', () => {
      throw new Error('bridge write failed')
    })
    expect(r).toEqual({ drained: 1, redelivered: 0, rebuffered: 1, retracted: 0 })
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
    expect(r).toEqual({ drained: 3, redelivered: 2, rebuffered: 1, retracted: 0 })
    expect(buf.drain('klanker').map((m) => m.meta?.source)).toEqual(['b'])
  })

  it('is a no-op on an empty buffer (no send calls)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    let calls = 0
    const r = redeliverBufferedInbound(buf, 'klanker', () => {
      calls++
      return true
    })
    expect(r).toEqual({ drained: 0, redelivered: 0, rebuffered: 0, retracted: 0 })
    expect(calls).toBe(0)
  })

  // onDelivered: the deliver-until-acked enrol hook (clerk lost-message
  // incident 2026-06-03). A socket-write "success" is not proof claude
  // consumed it; the caller uses onDelivered to enrol the redelivered inbound
  // in the deliver-until-acked queue so the sweep re-delivers until `enqueue`.
  it('calls onDelivered for each CONFIRMED-delivered group (per merged identity)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    buf.push('klanker', inbound('cron', 2)) // source-tagged → its own group
    const delivered: number[] = []
    const r = redeliverBufferedInbound(buf, 'klanker', () => true, undefined, (merged) => {
      delivered.push(merged.messageId as number)
    })
    expect(r.redelivered).toBe(2)
    expect(delivered).toEqual([1, 2]) // fired once per group, carrying the merged identity
  })

  it('does NOT call onDelivered for a group that failed to send (re-buffered, not enrolled)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('klanker', inbound('user', 1))
    const delivered: number[] = []
    const r = redeliverBufferedInbound(buf, 'klanker', () => false, undefined, (m) =>
      delivered.push(m.messageId as number),
    )
    expect(r.rebuffered).toBe(1)
    expect(delivered).toEqual([]) // never enrolled — buffer/spool still own it
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
    expect(r).toEqual({ drained: 1, redelivered: 1, rebuffered: 0, retracted: 0 })
    expect(seen).toEqual([2013])
    expect(buf.depth('finn')).toBe(0)
  })

  it('is lossless — a delivery miss re-buffers, returns null on empty agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('finn', inbound('user', 1))
    const r = idleDrainTick(buf, 'finn', () => true, () => false)
    expect(r).toEqual({ drained: 1, redelivered: 0, rebuffered: 1, retracted: 0 })
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
      retracted: 0,
    })
  })
})

describe('planBufferedRedelivery — merge-on-drain (forwarded-burst across a turn boundary)', () => {
  it('passes a single message through unchanged (run of one)', () => {
    const a = userMsg({ text: 'solo', ts: 1 })
    const plan = planBufferedRedelivery([a])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.merged).toBe(a) // identity preserved, no synthetic copy
    expect(plan[0]!.originals).toEqual([a])
  })

  it('merges consecutive same-sender user messages into one turn (texts joined by \\n)', () => {
    const a = userMsg({ text: 'first', ts: 1 })
    const b = userMsg({ text: 'second', ts: 2 })
    const c = userMsg({ text: 'third', ts: 3 })
    const plan = planBufferedRedelivery([a, b, c])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.merged.text).toBe('first\nsecond\nthird')
    expect(plan[0]!.originals).toEqual([a, b, c]) // all three acked/rebuffered together
  })

  it('anchors the merged turn on the LAST message identity/meta', () => {
    const a = userMsg({ text: 'first', ts: 10 })
    const b = userMsg({ text: 'second', ts: 20 })
    const plan = planBufferedRedelivery([a, b])
    expect(plan[0]!.merged.messageId).toBe(20)
    expect(plan[0]!.merged.ts).toBe(20)
  })

  it('NEVER merges a system inbound — meta.source isolates the #1150 wake-up class', () => {
    const u1 = userMsg({ text: 'hi', ts: 1 })
    const grant = inbound('vault_grant_approved', 2)
    const u2 = userMsg({ text: 'there', ts: 3 })
    const plan = planBufferedRedelivery([u1, grant, u2])
    // The grant breaks the run; nothing merges across it.
    expect(plan.map((p) => p.merged.text)).toEqual([
      'hi',
      'synthetic vault_grant_approved',
      'there',
    ])
    expect(plan.every((p) => p.originals.length === 1)).toBe(true)
  })

  it('does not merge across different senders', () => {
    const a = userMsg({ text: 'from-alice', userId: 1, ts: 1 })
    const b = userMsg({ text: 'from-bob', userId: 2, ts: 2 })
    const plan = planBufferedRedelivery([a, b])
    expect(plan).toHaveLength(2)
  })

  it('does not merge across different topics (threadId)', () => {
    const a = userMsg({ text: 'planning', threadId: 7, ts: 1 })
    const b = userMsg({ text: 'admin', threadId: 9, ts: 2 })
    const plan = planBufferedRedelivery([a, b])
    expect(plan).toHaveLength(2)
  })

  it('does not merge across different chats', () => {
    const a = userMsg({ text: 'dm', chatId: 'cA', ts: 1 })
    const b = userMsg({ text: 'group', chatId: 'cB', ts: 2 })
    const plan = planBufferedRedelivery([a, b])
    expect(plan).toHaveLength(2)
  })

  it('carries a single attachment along even when it is NOT the last message', () => {
    const photo = userMsg({ text: 'look', ts: 1, imagePath: '/tmp/p.jpg' })
    const txt = userMsg({ text: 'at this', ts: 2 })
    const plan = planBufferedRedelivery([photo, txt])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.merged.text).toBe('look\nat this')
    expect(plan[0]!.merged.imagePath).toBe('/tmp/p.jpg')
  })

  it('carries a single document attachment from the entry that owns it', () => {
    const txt = userMsg({ text: 'here', ts: 1 })
    const doc = userMsg({
      text: '',
      ts: 2,
      attachment: { fileId: 'F1', mimeType: 'application/pdf', fileName: 'r.pdf' },
    })
    const plan = planBufferedRedelivery([txt, doc])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.merged.attachment).toEqual({
      fileId: 'F1',
      mimeType: 'application/pdf',
      fileName: 'r.pdf',
    })
  })

  it('splits a run rather than putting two attachments in one turn (no silent media loss)', () => {
    const p1 = userMsg({ text: 'one', ts: 1, imagePath: '/tmp/a.jpg' })
    const p2 = userMsg({ text: 'two', ts: 2, imagePath: '/tmp/b.jpg' })
    const plan = planBufferedRedelivery([p1, p2])
    expect(plan).toHaveLength(2)
    expect(plan[0]!.merged.imagePath).toBe('/tmp/a.jpg')
    expect(plan[1]!.merged.imagePath).toBe('/tmp/b.jpg')
  })

  it('a leading text then media then text → text+media merge, then a fresh run', () => {
    const t1 = userMsg({ text: 'intro', ts: 1 })
    const p = userMsg({ text: 'pic', ts: 2, imagePath: '/tmp/p.jpg' })
    const t2 = userMsg({ text: 'caption', ts: 3 })
    const plan = planBufferedRedelivery([t1, p, t2])
    // All three share one attachment max → single merged turn.
    expect(plan).toHaveLength(1)
    expect(plan[0]!.merged.text).toBe('intro\npic\ncaption')
    expect(plan[0]!.merged.imagePath).toBe('/tmp/p.jpg')
  })

  it('splices attachment meta from the media entry when it is NOT the anchor (A2 numbered fields survive)', () => {
    // A coalesced multi-attachment message buffered, then a text-only
    // follow-up. mergeRun anchors on `last` (the text), whose meta has no
    // attachment fields — so the owning entry's image_path + numbered
    // siblings + attachment_count must be spliced into the merged meta or
    // the agent would never see the photos.
    const photo = userMsg({ text: 'look', ts: 1, imagePath: '/tmp/a.jpg' })
    photo.meta = {
      image_path: '/tmp/a.jpg',
      image_path_2: '/tmp/b.jpg',
      attachment_count: '2',
      user: 'alice',
    }
    const txt = userMsg({ text: 'at these', ts: 2 })
    txt.meta = { user: 'alice' }
    const plan = planBufferedRedelivery([photo, txt])
    expect(plan).toHaveLength(1)
    const meta = plan[0]!.merged.meta
    expect(meta.image_path).toBe('/tmp/a.jpg')
    expect(meta.image_path_2).toBe('/tmp/b.jpg')
    expect(meta.attachment_count).toBe('2')
    // Top-level primary still re-seated for inboundHasMedia detection.
    expect(plan[0]!.merged.imagePath).toBe('/tmp/a.jpg')
  })

  it('does not need a meta splice when the media entry IS the anchor', () => {
    const txt = userMsg({ text: 'intro', ts: 1 })
    txt.meta = { user: 'alice' }
    const photo = userMsg({ text: 'pic', ts: 2, imagePath: '/tmp/p.jpg' })
    photo.meta = { image_path: '/tmp/p.jpg', user: 'alice' }
    const plan = planBufferedRedelivery([txt, photo])
    expect(plan).toHaveLength(1)
    // Anchor is the photo, so its meta is inherited verbatim.
    expect(plan[0]!.merged.meta.image_path).toBe('/tmp/p.jpg')
  })

  it('preserves the run total — sum of originals equals input length (lossless)', () => {
    const msgs = [
      userMsg({ text: 'a', ts: 1 }),
      userMsg({ text: 'b', ts: 2 }),
      inbound('cron', 3),
      userMsg({ text: 'c', ts: 4 }),
    ]
    const plan = planBufferedRedelivery(msgs)
    const total = plan.reduce((n, p) => n + p.originals.length, 0)
    expect(total).toBe(msgs.length)
  })

  it('end-to-end: redeliverBufferedInbound fans a 3-message burst into ONE send', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('ziggy', userMsg({ text: 'part 1', ts: 1 }))
    buf.push('ziggy', userMsg({ text: 'part 2', ts: 2 }))
    buf.push('ziggy', userMsg({ text: 'part 3', ts: 3 }))
    const sent: string[] = []
    const r = redeliverBufferedInbound(buf, 'ziggy', (m) => {
      sent.push(m.text)
      return true
    })
    expect(sent).toEqual(['part 1\npart 2\npart 3']) // ONE turn, not three
    expect(r).toEqual({ drained: 3, redelivered: 3, rebuffered: 0, retracted: 0 })
    expect(buf.depth('ziggy')).toBe(0)
  })

  it('end-to-end: a failed send re-buffers ALL originals of the merged run (lossless)', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('ziggy', userMsg({ text: 'part 1', ts: 1 }))
    buf.push('ziggy', userMsg({ text: 'part 2', ts: 2 }))
    const r = redeliverBufferedInbound(buf, 'ziggy', () => false)
    expect(r).toEqual({ drained: 2, redelivered: 0, rebuffered: 2, retracted: 0 })
    expect(buf.depth('ziggy')).toBe(2) // both originals back, nothing lost
    expect(buf.drain('ziggy').map((m) => m.text)).toEqual(['part 1', 'part 2'])
  })
})

describe('planBufferedRedelivery — seeded fuzz over random burst schedules', () => {
  // Tiny deterministic PRNG (mulberry32) so failures reproduce from the seed.
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s |= 0
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const SOURCES = ['vault_grant_approved', 'cron', 'reaction', 'approval', 'handback']

  function randomSchedule(rand: () => number): InboundMessage[] {
    const n = 1 + Math.floor(rand() * 12)
    const out: InboundMessage[] = []
    for (let i = 0; i < n; i++) {
      const roll = rand()
      if (roll < 0.3) {
        // system inbound (has meta.source) — never mergeable
        out.push(inbound(SOURCES[Math.floor(rand() * SOURCES.length)]!, i + 1))
      } else {
        // user message: random sender/topic/chat, sometimes media
        const hasImg = rand() < 0.2
        const hasDoc = !hasImg && rand() < 0.15
        out.push(
          userMsg({
            text: `m${i}`,
            ts: i + 1,
            chatId: rand() < 0.5 ? 'cA' : 'cB',
            userId: rand() < 0.5 ? 1 : 2,
            threadId: rand() < 0.4 ? (rand() < 0.5 ? 7 : 9) : undefined,
            imagePath: hasImg ? `/tmp/img${i}.jpg` : undefined,
            attachment: hasDoc
              ? { fileId: `F${i}`, mimeType: 'application/pdf' }
              : undefined,
          }),
        )
      }
    }
    return out
  }

  function hasMedia(m: InboundMessage): boolean {
    return m.imagePath != null || m.attachment != null
  }
  function isSystem(m: InboundMessage): boolean {
    return m.meta != null && m.meta.source != null
  }

  it('holds all invariants across 5000 random schedules', () => {
    const rand = rng(0xC0FFEE)
    for (let iter = 0; iter < 5000; iter++) {
      const pending = randomSchedule(rand)
      const plan = planBufferedRedelivery(pending)

      // 1. Lossless + order-preserving: flattening originals reproduces input.
      const flat = plan.flatMap((p) => p.originals)
      expect(flat).toEqual(pending)

      // 2. Count is conserved.
      expect(flat.length).toBe(pending.length)

      for (const { merged, originals } of plan) {
        // 3. A multi-message run never carries >1 attachment.
        const mediaCount = originals.filter(hasMedia).length
        expect(mediaCount).toBeLessThanOrEqual(1)

        // 4. A system inbound is NEVER part of a multi-message run, and is
        //    never silently mutated (passes through by identity).
        if (originals.length > 1) {
          expect(originals.every((m) => !isSystem(m))).toBe(true)
        } else {
          expect(merged).toBe(originals[0])
        }

        // 5. Every message in a merged run shares the same (chat, thread, user).
        if (originals.length > 1) {
          const k = (m: InboundMessage) =>
            `${m.chatId}|${m.threadId ?? null}|${m.userId}`
          expect(new Set(originals.map(k)).size).toBe(1)
          // text is the \n-join of the run in order
          expect(merged.text).toBe(originals.map((m) => m.text).join('\n'))
          // the single attachment (if any) comes from the owning entry
          const owner = originals.find(hasMedia)
          expect(merged.imagePath).toBe(owner?.imagePath)
          expect(merged.attachment).toEqual(owner?.attachment)
        }
      }
    }
  })

  it('redeliver counts always satisfy drained == redelivered + rebuffered (5000 schedules)', () => {
    const rand = rng(0x5EED)
    for (let iter = 0; iter < 5000; iter++) {
      const pending = randomSchedule(rand)
      const buf = createPendingInboundBuffer({ log: () => {} })
      for (const m of pending) buf.push('fuzz', m)
      // Randomly succeed/fail each send to exercise both branches.
      const r = redeliverBufferedInbound(buf, 'fuzz', () => rand() < 0.5)
      expect(r.drained).toBe(pending.length)
      expect(r.redelivered + r.rebuffered).toBe(r.drained)
      // Whatever didn't deliver is still buffered (nothing lost).
      expect(buf.depth('fuzz')).toBe(r.rebuffered)
    }
  })
})

/**
 * F1 end-to-end: the delivery-time represent re-check wired into
 * redeliverBufferedInbound via `beforeRedeliver`. These exercise the WHOLE
 * drain path (buffer → plan → guard → send) against a real ObligationLedger,
 * asserting OUTCOMES: a stale represent is dropped and the ledger closed; a
 * truly-unanswered obligation fires exactly one represent.
 */
describe('redeliverBufferedInbound + F1 delivery-time represent re-check', () => {
  const CHAT = 'c1'
  const ORIGIN = 'turn-abc'
  const OPENED_AT = 1_000

  function representInbound(): InboundMessage {
    return {
      type: 'inbound',
      chatId: CHAT,
      messageId: 5_000,
      user: 'obligation-ledger',
      userId: 0,
      ts: 5_000,
      text: 'You asked earlier and I want to make sure I did not miss it…',
      meta: { source: 'obligation_represent', origin_turn_id: ORIGIN },
    }
  }

  function openLedger(): ObligationLedger {
    const l = new ObligationLedger()
    l.openIfAbsent({
      originTurnId: ORIGIN,
      chatId: CHAT,
      messageId: 42,
      text: 'original question',
      openedAt: OPENED_AT,
    })
    return l
  }

  function guardFor(
    ledger: ObligationLedger,
    hasOutboundDeliveredSince: (chatId: string, sinceMs: number) => boolean,
  ) {
    return makeRepresentRedeliveryGuard({
      enabled: true,
      historyEnabled: true,
      ledger,
      hasOutboundDeliveredSince: (chatId, sinceMs) => hasOutboundDeliveredSince(chatId, sinceMs),
      minReplyChars: 1,
      log: () => {},
    })
  }

  it('drops a buffered represent whose reply landed since decision, and closes the ledger', () => {
    const ledger = openLedger()
    // A real answer was delivered AT/AFTER the obligation's cutoff (openedAt).
    const buf = createPendingInboundBuffer({
      log: () => {},
      beforeRedeliver: guardFor(ledger, (_chat, sinceMs) => sinceMs <= 2_000),
    })
    buf.push('a', representInbound())

    let sends = 0
    const r = redeliverBufferedInbound(buf, 'a', () => {
      sends++
      return true
    })

    expect(sends).toBe(0) // never handed to the CLI bridge
    expect(r.drained).toBe(1)
    expect(r.retracted).toBe(1)
    expect(r.redelivered).toBe(0)
    expect(r.rebuffered).toBe(0)
    expect(ledger.isOpen(ORIGIN)).toBe(false) // F1 closed the stale obligation
    expect(buf.depth('a')).toBe(0) // dropped, not re-buffered
  })

  it('delivers exactly one represent for a truly-unanswered obligation (no outbound row)', () => {
    const ledger = openLedger()
    // Plain-text-no-reply / genuinely unanswered: no outbound recorded since cutoff.
    const buf = createPendingInboundBuffer({
      log: () => {},
      beforeRedeliver: guardFor(ledger, () => false),
    })
    buf.push('a', representInbound())

    let sends = 0
    const r = redeliverBufferedInbound(buf, 'a', () => {
      sends++
      return true
    })

    expect(sends).toBe(1)
    expect(r.drained).toBe(1)
    expect(r.redelivered).toBe(1)
    expect(r.retracted).toBe(0)
    expect(r.rebuffered).toBe(0)
    expect(ledger.isOpen(ORIGIN)).toBe(true) // still open — the represent will be answered
  })
})

/**
 * FAIL-OPEN safety: a `beforeRedeliver` predicate that THROWS must never silence
 * or lose a real message, nor abort the drain loop. The throw is swallowed, the
 * message is treated as "deliver", and every following buffered message in the
 * same drain is still delivered. This test fails if the try/catch around the
 * predicate is removed (the throw would propagate out of redeliverBufferedInbound).
 */
describe('redeliverBufferedInbound — beforeRedeliver fail-open on throw', () => {
  it('delivers the message and the rest of the drain when the predicate throws', () => {
    const buf = createPendingInboundBuffer({
      log: () => {},
      beforeRedeliver: () => {
        throw new Error('guard boom')
      },
    })
    buf.push('a', inbound('cron', 1))
    buf.push('a', inbound('vault_grant_approved', 2))

    const seen: number[] = []
    // Must not throw — the loop completes past a throwing predicate.
    const r = redeliverBufferedInbound(buf, 'a', (m) => {
      seen.push(m.messageId as number)
      return true
    })

    expect(seen).toEqual([1, 2]) // both delivered, loop not aborted
    expect(r.drained).toBe(2)
    expect(r.redelivered).toBe(2) // failed open → delivered, not dropped
    expect(r.retracted).toBe(0) // a throw is NOT a retract
    expect(r.rebuffered).toBe(0)
    expect(buf.depth('a')).toBe(0) // nothing stranded
  })
})

/**
 * PR D — cap eviction must not pick an APPROVAL OUTCOME while anything else is
 * droppable. The victim used to be an unconditional `q.shift()`, and the oldest
 * entry is exactly the one most likely to be a synthetic approval outcome that
 * has been waiting through an entire turn. An ordinary chat message is
 * resendable; a `vault_grant_approved` is not — the operator's tap already
 * happened, so "please resend" is meaningless and the agent blocks forever.
 */
describe('pending-inbound-buffer — approval-outcome eviction protection (PR D)', () => {
  /** A button tap: NO meta.source at all, only meta.button_callback. */
  function tap(ts: number): InboundMessage {
    return {
      type: 'inbound',
      chatId: 'c1',
      messageId: ts,
      user: 'alice',
      userId: 42,
      ts,
      text: '[user tapped button: Approve]',
      meta: { button_callback: 'true', button_callback_data: 'ag:ok', button_text: 'Approve' },
    }
  }

  it('an outcome at the HEAD survives an overflow of ordinary messages', () => {
    const buf = createPendingInboundBuffer({ log: () => {} }) // cap 32
    buf.push('a', inbound('vault_grant_approved', 1))
    for (let i = 0; i < 31; i++) buf.push('a', userMsg({ text: `m${i}`, ts: 100 + i }))
    buf.push('a', userMsg({ text: 'overflow', ts: 999 }))
    const drained = buf.drain('a')
    expect(drained.some((m) => m.meta?.source === 'vault_grant_approved')).toBe(true)
    // The oldest ORDINARY message went instead, and nothing else was lost.
    expect(drained).toHaveLength(32)
    expect(drained.map((m) => m.text)).not.toContain('m0')
    expect(drained.map((m) => m.text)).toContain('overflow')
  })

  it('a sustained ordinary-message burst never evicts the buffered outcome', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 4, log: () => {} })
    buf.push('a', inbound('secret_provided', 1))
    for (let i = 0; i < 40; i++) buf.push('a', userMsg({ text: `u${i}`, ts: 100 + i }))
    const drained = buf.drain('a')
    expect(drained[0]?.meta?.source).toBe('secret_provided')
    expect(drained.map((m) => m.text).slice(1)).toEqual(['u37', 'u38', 'u39'])
  })

  it('a button tap is protected too — it carries NO meta.source', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 3, log: () => {} })
    buf.push('a', tap(1))
    buf.push('a', userMsg({ text: 'u1', ts: 2 }))
    buf.push('a', userMsg({ text: 'u2', ts: 3 }))
    buf.push('a', userMsg({ text: 'u3', ts: 4 }))
    const drained = buf.drain('a')
    expect(drained[0]?.meta?.button_callback).toBe('true')
    expect(drained.map((m) => m.text).slice(1)).toEqual(['u2', 'u3'])
  })

  it('survivors keep insertion order after a mid-queue eviction (FIFO contract)', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 4, log: () => {} })
    buf.push('a', inbound('vault_grant_approved', 1))
    buf.push('a', userMsg({ text: 'u1', ts: 2 }))
    buf.push('a', userMsg({ text: 'u2', ts: 3 }))
    buf.push('a', userMsg({ text: 'u3', ts: 4 }))
    buf.push('a', userMsg({ text: 'u4', ts: 5 })) // evicts u1 (index 1), not the head
    expect(buf.drain('a').map((m) => m.meta?.source ?? m.text)).toEqual([
      'vault_grant_approved', 'u2', 'u3', 'u4',
    ])
  })

  it('onEvict (not onEvictCritical) fires for an ordinary victim', () => {
    const ordinary: InboundMessage[] = []
    const critical: InboundMessage[] = []
    const buf = createPendingInboundBuffer({
      capPerAgent: 2,
      log: () => {},
      onEvict: (_a, m) => ordinary.push(m),
      onEvictCritical: (_a, m) => critical.push(m),
    })
    buf.push('a', inbound('vault_grant_approved', 1))
    buf.push('a', userMsg({ text: 'u1', ts: 2 }))
    buf.push('a', userMsg({ text: 'u2', ts: 3 }))
    expect(ordinary.map((m) => m.text)).toEqual(['u1'])
    expect(critical).toHaveLength(0)
  })

  it('all-outcomes fallback: drops the oldest and fires onEvictCritical, NOT onEvict', () => {
    const ordinary: InboundMessage[] = []
    const critical: { agent: string; msg: InboundMessage }[] = []
    const buf = createPendingInboundBuffer({
      capPerAgent: 3,
      log: () => {},
      now: () => 1000, // all three below are well inside the protection window
      onEvict: (_a, m) => ordinary.push(m),
      onEvictCritical: (agent, msg) => critical.push({ agent, msg }),
    })
    buf.push('a', inbound('vault_grant_approved', 900))
    buf.push('a', inbound('secret_provided', 950))
    buf.push('a', inbound('skill_proposal_apply', 980))
    expect(critical).toHaveLength(0)
    buf.push('a', inbound('mental_model_proposal_applied', 999))
    expect(ordinary).toHaveLength(0)
    expect(critical).toHaveLength(1)
    expect(critical[0]!.agent).toBe('a')
    expect(critical[0]!.msg.meta?.source).toBe('vault_grant_approved')
    expect(critical[0]!.msg.ts).toBe(900)
    // The newest outcome is in and the other two are intact.
    expect(buf.drain('a').map((m) => m.meta?.source)).toEqual([
      'secret_provided', 'skill_proposal_apply', 'mental_model_proposal_applied',
    ])
  })

  it('a STALE outcome is evictable — protection is bounded, so it cannot pin the buffer', () => {
    const critical: InboundMessage[] = []
    const nowMs = 100 * 60 * 1000
    const buf = createPendingInboundBuffer({
      capPerAgent: 2,
      log: () => {},
      now: () => nowMs,
      onEvictCritical: (_a, m) => critical.push(m),
    })
    // Stale: older than the 15-min protection window (already spool-escalated).
    buf.push('a', inbound('vault_grant_timeout', nowMs - 20 * 60 * 1000))
    // Fresh.
    buf.push('a', inbound('secret_provided', nowMs - 1000))
    buf.push('a', inbound('vault_grant_approved', nowMs))
    expect(critical.map((m) => m.meta?.source)).toEqual(['vault_grant_timeout'])
    // The FRESH outcomes both survived — staleness, not arrival order, decided it.
    expect(buf.drain('a').map((m) => m.meta?.source)).toEqual([
      'secret_provided', 'vault_grant_approved',
    ])
  })

  it('APPROVAL_OUTCOME_PROTECTION_MS matches the spool escalation window', () => {
    expect(APPROVAL_OUTCOME_PROTECTION_MS).toBe(15 * 60 * 1000)
  })

  it('cap of 1 with a single fresh outcome: evicts it and reports critical', () => {
    const critical: InboundMessage[] = []
    const buf = createPendingInboundBuffer({
      capPerAgent: 1,
      log: () => {},
      now: () => 1000,
      onEvictCritical: (_a, m) => critical.push(m),
    })
    buf.push('a', inbound('vault_grant_approved', 900))
    buf.push('a', inbound('secret_provided', 950))
    expect(critical.map((m) => m.meta?.source)).toEqual(['vault_grant_approved'])
    expect(buf.drain('a').map((m) => m.meta?.source)).toEqual(['secret_provided'])
  })

  it('a throwing onEvictCritical never breaks the push hot path', () => {
    const buf = createPendingInboundBuffer({
      capPerAgent: 1,
      log: () => {},
      onEvictCritical: () => { throw new Error('notice failed') },
    })
    buf.push('a', inbound('vault_grant_approved', 1))
    expect(() => buf.push('a', inbound('secret_provided', 2))).not.toThrow()
    expect(buf.drain('a').map((m) => m.meta?.source)).toEqual(['secret_provided'])
  })

  describe('selectEvictionVictim tiers', () => {
    const out = (ts: number) => inbound('vault_grant_approved', ts)
    const ord = (ts: number) => userMsg({ text: `u${ts}`, ts })

    it('empty queue is safe (index 0, no crash at the call site)', () => {
      expect(selectEvictionVictim([], 0)).toEqual({ index: 0, reason: 'all-outcomes' })
    })

    it('picks the FIRST non-outcome, not merely any non-outcome', () => {
      expect(selectEvictionVictim([out(1), out(2), ord(3), ord(4)], 5)).toEqual({
        index: 2, reason: 'non-outcome',
      })
    })

    it('prefers an ordinary message over a STALE outcome', () => {
      const nowMs = 60 * 60 * 1000
      expect(selectEvictionVictim([out(1), ord(nowMs)], nowMs)).toEqual({
        index: 1, reason: 'non-outcome',
      })
    })

    // Tier 2 vs tier 3. These two tiers agree on the victim whenever the queue
    // is in `ts`-ascending order (the oldest entry is then also the stalest),
    // so an in-order fixture CANNOT tell them apart — disabling the age bound
    // entirely leaves such a test green (verified by mutation). The
    // discriminating case is a queue whose head is FRESH and whose later entry
    // is STALE.
    it('prefers a STALE outcome over a fresher one queued ahead of it', () => {
      const nowMs = 100 * 60 * 1000
      const fresh = out(nowMs)
      const stale = out(nowMs - 20 * 60 * 1000) // past the 15-min window
      expect(selectEvictionVictim([fresh, stale], nowMs)).toEqual({
        index: 1, reason: 'stale-outcome',
      })
    })

    // The `reason` is not cosmetic: it is what the eviction log line reports,
    // and it is the only signal distinguishing "dropped an outcome the spool
    // already escalated" from "dropped a live one because there was nothing
    // else". Pin it in the ordinary in-order shape too.
    it('reports stale-outcome (not all-outcomes) when the victim is past its window', () => {
      const nowMs = 100 * 60 * 1000
      expect(
        selectEvictionVictim([out(nowMs - 20 * 60 * 1000), out(nowMs)], nowMs).reason,
      ).toBe('stale-outcome')
    })

    // The bound must actually be a bound: an outcome one millisecond inside
    // the window is still protected, so tier 3 is what fires.
    it('an outcome just INSIDE the window is not stale — falls through to tier 3', () => {
      const nowMs = 100 * 60 * 1000
      const justInside = out(nowMs - (APPROVAL_OUTCOME_PROTECTION_MS - 1))
      expect(selectEvictionVictim([out(nowMs), justInside], nowMs)).toEqual({
        index: 0, reason: 'all-outcomes',
      })
    })
  })
})

/**
 * PR D — the notifier the gateway wires to `onEvictCritical`. This drives the
 * REAL production factory (gateway.ts calls exactly this), so the re-entrancy
 * and termination properties are pinned where they live, not in a test copy.
 */
describe('approval-outcome drop notifier (PR D)', () => {
  /** Run every queued microtask to quiescence. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  it('the approval_outcome_dropped notice lands in the buffer and names the source', async () => {
    // Wire it exactly as gateway.ts does: the buffer's onEvictCritical calls
    // the notifier, and the notifier pushes back into the same buffer.
    const buf = createPendingInboundBuffer({
      capPerAgent: 3,
      log: () => {},
      now: () => 1000,
      onEvictCritical: (a, m) => notifier(a, m),
    })
    const notifier = createApprovalOutcomeDropNotifier({
      push: (agent, msg) => { buf.push(agent, msg) },
      log: () => {},
    })
    buf.push('a', inbound('vault_grant_approved', 900))
    buf.push('a', inbound('secret_provided', 950))
    buf.push('a', inbound('skill_proposal_apply', 960))
    buf.push('a', inbound('mental_model_proposal_applied', 970)) // critical evict
    // Nothing enqueued synchronously — the notice must NOT ride the push frame.
    expect(buf.depth('a')).toBe(3)
    await settle()
    const drained = buf.drain('a')
    const notice = drained.find((m) => m.meta?.source === 'approval_outcome_dropped')
    expect(notice).toBeDefined()
    // The notice push itself ran against a queue still full of outcomes, so it
    // evicted one more. The surviving notice must name BOTH — an earlier notice
    // naming only the first drop is exactly what the next overflow evicts.
    expect(notice!.meta?.dropped_sources).toBe('vault_grant_approved, secret_provided')
    expect(notice!.text).toContain('vault_grant_approved')
    // Every outcome that was NOT dropped is still buffered.
    expect(drained.map((m) => m.meta?.source)).toEqual([
      'skill_proposal_apply', 'mental_model_proposal_applied', 'approval_outcome_dropped',
    ])
  })

  // The guarantee is "a dropped approval outcome is never silent". If it
  // depended on each construction site passing a callback it would be
  // discipline, not a mechanism — so the notifier defaults ON and this pins it.
  it('is wired BY DEFAULT — a bare buffer still enqueues the notice', async () => {
    const buf = createPendingInboundBuffer({
      capPerAgent: 3,
      log: () => {},
      now: () => 1000,
      // NO onEvictCritical passed.
    })
    buf.push('a', inbound('vault_grant_approved', 900))
    buf.push('a', inbound('secret_provided', 950))
    buf.push('a', inbound('skill_proposal_apply', 960))
    buf.push('a', inbound('vault_grant_denied', 970))
    await settle()
    const drained = buf.drain('a')
    const notice = drained.find((m) => m.meta?.source === 'approval_outcome_dropped')
    expect(notice).toBeDefined()
    expect(notice!.meta?.dropped_sources).toContain('vault_grant_approved')
  })

  it('an explicit no-op onEvictCritical opts out of the notice', async () => {
    const buf = createPendingInboundBuffer({
      capPerAgent: 3,
      log: () => {},
      now: () => 1000,
      onEvictCritical: () => {},
    })
    for (let i = 0; i < 6; i++) buf.push('a', inbound('vault_grant_approved', 900 + i))
    await settle()
    expect(buf.drain('a').some((m) => m.meta?.source === 'approval_outcome_dropped')).toBe(false)
  })

  it('a burst of critical evictions terminates and does not spin the microtask queue', async () => {
    let pushes = 0
    const buf = createPendingInboundBuffer({
      capPerAgent: 3,
      log: () => {},
      now: () => 1000,
      onEvictCritical: (a, m) => notifier(a, m),
    })
    const notifier = createApprovalOutcomeDropNotifier({
      push: (agent, msg) => { pushes++; buf.push(agent, msg) },
      log: () => {},
    })
    for (let i = 0; i < 10; i++) buf.push('a', inbound('vault_grant_approved', 900 + i))
    await settle()
    // Bounded: at most one notice per burst plus the follow-up hop, never one
    // notice per evicted outcome (that is the recursion this guards).
    expect(pushes).toBeGreaterThan(0)
    expect(pushes).toBeLessThanOrEqual(3)
    // A notice is resident, and it is NOT itself an approval outcome — which is
    // what makes it the preferred victim next time and bounds the chain.
    const drained = buf.drain('a')
    expect(drained.some((m) => m.meta?.source === 'approval_outcome_dropped')).toBe(true)
  })

  it('a burst coalesces into ONE notice naming every dropped source', async () => {
    const notices: InboundMessage[] = []
    const notifier = createApprovalOutcomeDropNotifier({
      push: (_agent, msg) => { notices.push(msg) },
      log: () => {},
    })
    notifier('a', inbound('vault_grant_approved', 1))
    notifier('a', inbound('secret_declined', 2))
    notifier('a', inbound('skill_proposal_apply', 3))
    expect(notices).toHaveLength(0) // deferred, never same-frame
    await settle()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.meta?.dropped_sources).toBe(
      'vault_grant_approved, secret_declined, skill_proposal_apply',
    )
    expect(notices[0]!.meta?.dropped_count).toBe('3')
  })

  it('a button tap victim is labelled button_callback, not "-"', async () => {
    const notices: InboundMessage[] = []
    const notifier = createApprovalOutcomeDropNotifier({
      push: (_agent, msg) => { notices.push(msg) },
      log: () => {},
    })
    notifier('a', {
      type: 'inbound', chatId: 'c1', messageId: 1, user: 'alice', userId: 42, ts: 1,
      text: '[user tapped button: Approve]', meta: { button_callback: 'true' },
    })
    await settle()
    expect(notices[0]!.meta?.dropped_sources).toBe('button_callback')
  })
})

describe('isApprovalOutcome (PR D)', () => {
  const withMeta = (meta: Record<string, string> | undefined): InboundMessage => ({
    type: 'inbound', chatId: 'c1', messageId: 1, user: 'u', userId: 1, ts: 1, text: 't',
    ...(meta != null ? { meta } : {}),
  } as InboundMessage)

  it('true for every registered source', () => {
    for (const s of APPROVAL_OUTCOME_SOURCES) {
      expect(isApprovalOutcome(withMeta({ source: s }))).toBe(true)
    }
  })

  it('true for a button tap with no source at all', () => {
    expect(isApprovalOutcome(withMeta({ button_callback: 'true' }))).toBe(true)
  })

  it('false for ordinary messages and non-outcome system sources', () => {
    expect(isApprovalOutcome(withMeta({}))).toBe(false)
    expect(isApprovalOutcome(withMeta(undefined))).toBe(false)
    for (const s of [
      'missed_approval_retry', 'obligation_represent', 'subagent_handback',
      'subagent_progress', 'resume_interrupted', 'warmup', 'reaction', 'cron',
      'approval_outcome_dropped',
    ]) {
      expect(isApprovalOutcome(withMeta({ source: s }))).toBe(false)
    }
  })

  it('the dropped-notice source is deliberately NOT protected', () => {
    expect(APPROVAL_OUTCOME_SOURCES.has(APPROVAL_OUTCOME_DROPPED_SOURCE)).toBe(false)
  })

  // Drift pin on the registry itself. `Object.freeze` on a Set does NOT block
  // `.add` (Set data lives in internal slots), so asserting `isFrozen` would be
  // a placebo — immutability is enforced at compile time by the `ReadonlySet`
  // type. What IS worth pinning is membership: silently dropping a source here
  // makes that verdict class evictable again with no test going red.
  it('the registry contents are exactly the audited set', () => {
    expect([...APPROVAL_OUTCOME_SOURCES].sort()).toEqual([
      'eval_case_applied',
      'eval_case_apply_failed',
      'eval_case_rejected',
      'mental_model_proposal_applied',
      'mental_model_proposal_denied',
      'mental_model_proposal_failed',
      'mental_model_propose_timeout',
      'secret_declined',
      'secret_provide_failed',
      'secret_provided',
      'secret_request_timeout',
      'skill_proposal_apply',
      'vault_grant_approved',
      'vault_grant_denied',
      'vault_grant_timeout',
      'vault_save_completed',
      'vault_save_discarded',
      'vault_save_failed',
      'vault_save_timeout',
    ])
  })
})
