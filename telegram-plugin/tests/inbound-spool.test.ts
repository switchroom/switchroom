/**
 * inbound-spool — durable, crash-tolerant inbound spool.
 *
 * Pins the determinism guarantee: a buffered inbound survives a
 * gateway/container restart (it's on the persistent volume), is
 * replayed un-acked, acked only on confirmed delivery, deduped by a
 * stable id, and escalated-then-dropped if undeliverable past its
 * bound — so the "your message is queued" promise is ALWAYS resolved
 * (delivered or visibly retracted), never silently lost (the
 * finn/carrie lost-on-restart incident class, 2026-05-19).
 */

import { describe, it, expect } from 'vitest'
import {
  createInboundSpool,
  spoolId,
  type InboundSpoolFsSeam,
} from '../gateway/inbound-spool.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: 'inbound',
    chatId: 'c1',
    messageId: 1001,
    user: 'ken',
    userId: 42,
    ts: 1000,
    text: 'hello',
    meta: {},
    ...over,
  } as InboundMessage
}

/** In-memory fake fs. Models append-only + full rewrite. */
function fakeFs(): InboundSpoolFsSeam & { dump(): string } {
  let store = ''
  let exists = false
  return {
    appendFileSync: (_p, d) => {
      store += d
      exists = true
    },
    readFileSync: () => store,
    writeFileSync: (_p, d) => {
      store = d
      exists = true
    },
    existsSync: () => exists,
    statSizeSync: () => Buffer.byteLength(store),
    dump: () => store,
  }
}

const PATH = '/state/agent/telegram/inbound-spool.jsonl'

describe('spoolId — stable dedup key', () => {
  it('real Telegram message → m:chat:msgId', () => {
    expect(spoolId(msg({ chatId: 'c9', messageId: 55 }))).toBe('m:c9:55')
  })
  it('synthetic (messageId 0) → s:chat:source:ts (distinct events do not collapse)', () => {
    const a = spoolId(msg({ messageId: 0, meta: { source: 'cron' }, ts: 100 }))
    const b = spoolId(msg({ messageId: 0, meta: { source: 'cron' }, ts: 200 }))
    expect(a).toBe('s:c1:cron:100')
    expect(a).not.toBe(b) // different ts = different logical event
  })
  it('same logical synthetic retried (same ts) dedups to the same id', () => {
    const a = spoolId(msg({ messageId: 0, meta: { source: 'cron' }, ts: 100 }))
    const b = spoolId(msg({ messageId: 0, meta: { source: 'cron' }, ts: 100 }))
    expect(a).toBe(b)
  })
})

describe('inbound-spool — put / ack / dedup', () => {
  it('put records a live entry; dedups a re-put of the same id', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    expect(s.put('carrie', msg({ messageId: 7 }))).toBe(true)
    expect(s.put('carrie', msg({ messageId: 7 }))).toBe(false) // dedup
    expect(s.liveCount()).toBe(1)
    expect(s.liveEntries()).toHaveLength(1)
    expect(s.liveEntries()[0].agent).toBe('carrie')
  })

  it('ack tombstones the entry; ack is idempotent / unknown-id safe', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    const m = msg({ messageId: 7 })
    s.put('carrie', m)
    s.ack(m)
    expect(s.liveCount()).toBe(0)
    s.ack(m) // idempotent
    s.ack(msg({ messageId: 999 })) // unknown id, no throw
    expect(s.liveCount()).toBe(0)
  })

  it('liveEntries is oldest-first (replay order)', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    s.put('a', msg({ messageId: 1 }))
    s.put('a', msg({ messageId: 2 }))
    s.put('a', msg({ messageId: 3 }))
    expect(s.liveEntries().map((e) => e.msg.messageId)).toEqual([1, 2, 3])
  })
})

describe('inbound-spool — crash-survivable replay (the core guarantee)', () => {
  it('a fresh spool over an existing file rebuilds live state (survives restart)', () => {
    const fs = fakeFs()
    const s1 = createInboundSpool({ path: PATH, fs })
    s1.put('carrie', msg({ messageId: 7, text: 'the craft message' }))
    s1.put('carrie', msg({ messageId: 8 }))
    s1.ack(msg({ messageId: 8 })) // 8 delivered before the "crash"
    // Simulate gateway/container restart: brand-new spool, SAME file.
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(1)
    const live = s2.liveEntries()
    expect(live[0].msg.messageId).toBe(7)
    expect(live[0].msg.text).toBe('the craft message') // full payload survived
    expect(live[0].agent).toBe('carrie')
  })

  it('tolerates a torn final line (crash mid-append) — skips it, keeps the rest', () => {
    const fs = fakeFs()
    const s1 = createInboundSpool({ path: PATH, fs })
    s1.put('carrie', msg({ messageId: 7 }))
    // Append a half-written record (no newline, invalid JSON tail).
    fs.appendFileSync(PATH, '{"t":"put","id":"m:c1:8","agen')
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(1) // the torn line is ignored, 7 survives
    expect(s2.liveEntries()[0].msg.messageId).toBe(7)
  })

  it('ignores any line that does not pass the shape check', () => {
    const fs = fakeFs()
    fs.appendFileSync(PATH, 'not json\n')
    fs.appendFileSync(PATH, '{"t":"put"}\n') // missing id/msg/agent
    fs.appendFileSync(PATH, '{"t":"weird","id":"x"}\n')
    fs.appendFileSync(
      PATH,
      JSON.stringify({ t: 'put', id: 'm:c1:7', agent: 'a', firstAt: 1, msg: msg({ messageId: 7 }) }) + '\n',
    )
    const s = createInboundSpool({ path: PATH, fs })
    expect(s.liveCount()).toBe(1)
    expect(s.liveEntries()[0].msg.messageId).toBe(7)
  })
})

describe('inbound-spool — bounded escalation (promise always resolved)', () => {
  it('escalates+drops only entries older than the bound; younger untouched', () => {
    const fs = fakeFs()
    let t = 1_000_000
    const s = createInboundSpool({
      path: PATH,
      fs,
      now: () => t,
      escalateAfterMs: 10_000,
    })
    s.put('carrie', msg({ messageId: 1 })) // firstAt = 1_000_000
    t = 1_005_000
    s.put('carrie', msg({ messageId: 2 })) // firstAt = 1_005_000
    t = 1_012_000 // msg1 is 12s old (>10s bound), msg2 is 7s old
    const escalated: number[] = []
    const n = s.sweepEscalations((e) => escalated.push(e.msg.messageId as number))
    expect(n).toBe(1)
    expect(escalated).toEqual([1])
    expect(s.liveCount()).toBe(1) // msg2 still live
    expect(s.liveEntries()[0].msg.messageId).toBe(2)
  })

  it('an escalated id stays dropped across a restart (tombstoned, not replayed)', () => {
    const fs = fakeFs()
    let t = 0
    const s1 = createInboundSpool({ path: PATH, fs, now: () => t, escalateAfterMs: 100 })
    s1.put('a', msg({ messageId: 1 }))
    t = 1000
    expect(s1.sweepEscalations(() => {})).toBe(1)
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(0) // not resurrected on replay
  })
})

describe('inbound-spool — robustness', () => {
  it('a failing appendFileSync does not throw and keeps in-memory live state', () => {
    const fs = fakeFs()
    fs.appendFileSync = () => {
      throw new Error('ENOSPC')
    }
    const logs: string[] = []
    const s = createInboundSpool({ path: PATH, fs, log: (l) => logs.push(l) })
    expect(() => s.put('a', msg({ messageId: 1 }))).not.toThrow()
    expect(s.liveCount()).toBe(1) // live delivery still works (degraded durability)
    expect(logs.join('')).toContain('durability degraded')
  })

  it('compacts once past the size bound, dropping acked ids', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs, compactAtBytes: 200 })
    for (let i = 1; i <= 20; i++) {
      s.put('a', msg({ messageId: i, text: 'x'.repeat(50) }))
      s.ack(msg({ messageId: i }))
    }
    s.put('a', msg({ messageId: 999 }))
    // After compaction the file holds only the one live id, not the
    // 20 acked put+ack pairs.
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(1)
    expect(s2.liveEntries()[0].msg.messageId).toBe(999)
    expect(fs.dump().split('\n').filter(Boolean).length).toBeLessThan(5)
  })
})
