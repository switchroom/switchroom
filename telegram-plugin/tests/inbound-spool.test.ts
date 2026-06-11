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

/** In-memory fake fs keyed by path. Models append, full rewrite, and
 *  atomic rename (so the tmp→rename compaction path is exercised). */
function fakeFs(): InboundSpoolFsSeam & { dump(p?: string): string } {
  const files = new Map<string, string>()
  return {
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? '') + d),
    readFileSync: (p) => files.get(p) ?? '',
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (from, to) => {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    existsSync: (p) => files.has(p),
    statSizeSync: (p) => Buffer.byteLength(files.get(p) ?? ''),
    dump: (p = PATH) => files.get(p) ?? '',
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
  // #1719: a subagent_handback envelope carries the JSONL agent id, and
  // spoolId() keys on it — so a re-built envelope for the same finished
  // sub-agent (different Date.now()-derived ts/messageId across a
  // restart or the onFinish race) collapses to one spool entry instead
  // of re-firing the handback turn.
  it('subagent_handback → s:handback:<jsonl_agent_id>, stable across ts', () => {
    const a = spoolId(
      msg({
        messageId: 1700_000_000_000,
        ts: 1700_000_000_000,
        meta: { source: 'subagent_handback', subagent_jsonl_id: 'abc-123' },
      }),
    )
    const b = spoolId(
      msg({
        messageId: 1700_000_999_999,
        ts: 1700_000_999_999,
        meta: { source: 'subagent_handback', subagent_jsonl_id: 'abc-123' },
      }),
    )
    expect(a).toBe('s:handback:abc-123')
    expect(b).toBe(a) // stable across Date.now() drift / restart re-build
  })
  it('subagent_handback for distinct sub-agents stays distinct', () => {
    const a = spoolId(
      msg({ messageId: 0, meta: { source: 'subagent_handback', subagent_jsonl_id: 'a' } }),
    )
    const b = spoolId(
      msg({ messageId: 0, meta: { source: 'subagent_handback', subagent_jsonl_id: 'b' } }),
    )
    expect(a).not.toBe(b)
  })
  it('subagent_handback without jsonl id falls back to legacy id (back-compat)', () => {
    const a = spoolId(
      msg({ messageId: 555, meta: { source: 'subagent_handback' }, ts: 100 }),
    )
    // messageId > 0 → legacy m:<chat>:<msgId> still wins.
    expect(a).toBe('m:c1:555')
  })
  // honest-restart-resume: a boot-resume inbound is minted with a fresh
  // ts/messageId every boot, so without a turn-keyed id an operator who
  // restarts twice before the agent drains the first resume would stack
  // N resumes of the same turn. Keying on resume_turn_key collapses them.
  it('resume_interrupted → s:resume:<turn_key>, stable across boots (fresh ts/messageId)', () => {
    const a = spoolId(
      msg({
        messageId: 1700_000_000_000,
        ts: 1700_000_000_000,
        meta: { source: 'resume_interrupted', resume_turn_key: '12345:11' },
      }),
    )
    const b = spoolId(
      msg({
        messageId: 1700_000_999_999,
        ts: 1700_000_999_999,
        meta: { source: 'resume_interrupted', resume_turn_key: '12345:11' },
      }),
    )
    expect(a).toBe('s:resume:12345:11')
    expect(b).toBe(a)
  })
  it('resume_watchdog_timeout shares the s:resume namespace (one turn is one or the other)', () => {
    const interrupted = spoolId(
      msg({ messageId: 0, meta: { source: 'resume_interrupted', resume_turn_key: 'k:1' } }),
    )
    const timeout = spoolId(
      msg({ messageId: 0, meta: { source: 'resume_watchdog_timeout', resume_turn_key: 'k:1' } }),
    )
    expect(timeout).toBe('s:resume:k:1')
    expect(timeout).toBe(interrupted)
  })
  it('resume inbounds for distinct turns stay distinct', () => {
    const a = spoolId(
      msg({ messageId: 0, meta: { source: 'resume_interrupted', resume_turn_key: 'k:1' } }),
    )
    const b = spoolId(
      msg({ messageId: 0, meta: { source: 'resume_interrupted', resume_turn_key: 'k:2' } }),
    )
    expect(a).not.toBe(b)
  })
  it('resume source without a turn_key falls back to legacy id (no crash)', () => {
    const a = spoolId(msg({ messageId: 777, meta: { source: 'resume_interrupted' }, ts: 100 }))
    expect(a).toBe('m:c1:777')
  })
})

describe('inbound-spool — subagent_handback dedup across restart re-build (#1719)', () => {
  it('two handback envelopes for the same jsonl id collapse to one live entry', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    const first = msg({
      messageId: 1700_000_000_000,
      ts: 1700_000_000_000,
      meta: { source: 'subagent_handback', subagent_jsonl_id: 'jsonl-xyz' },
    })
    // Simulates a second onFinish (or boot-replay re-build) for the
    // same sub-agent. Different ts / messageId — same jsonl id.
    const second = msg({
      messageId: 1700_000_999_999,
      ts: 1700_000_999_999,
      meta: { source: 'subagent_handback', subagent_jsonl_id: 'jsonl-xyz' },
    })
    expect(s.put('worker', first)).toBe(true)
    expect(s.put('worker', second)).toBe(false) // deduped, no re-fire
    expect(s.liveCount()).toBe(1)
    expect(s.liveEntries()).toHaveLength(1)
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

describe('inbound-spool — give-up notice coalescing (2026-06-09 marko spam)', () => {
  // Helper: drive a sweep, return the list of postNotice flags per dropped entry.
  function sweepFlags(s: ReturnType<typeof createInboundSpool>): boolean[] {
    const flags: boolean[] = []
    s.sweepEscalations((_e, { postNotice }) => flags.push(postNotice))
    return flags
  }

  it('a burst of undeliverable entries in one chat posts exactly ONE notice', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({
      path: PATH, fs, now: () => t,
      escalateAfterMs: 100, escalateNoticeCooldownMs: 10_000,
    })
    // Three synthetics, same chat, distinct ids (fresh ts → distinct spoolId,
    // the exact churn shape that produced the spam).
    s.put('marko', msg({ messageId: 0, ts: 1, meta: { source: 'cron' } }))
    s.put('marko', msg({ messageId: 0, ts: 2, meta: { source: 'cron' } }))
    s.put('marko', msg({ messageId: 0, ts: 3, meta: { source: 'cron' } }))
    t = 1000 // all older than the 100ms bound
    const flags = sweepFlags(s)
    expect(flags.length).toBe(3) // all three dropped (promise retracted)
    expect(flags.filter(Boolean).length).toBe(1) // ONE notice posted
    expect(s.liveCount()).toBe(0)
  })

  it('distinct chats each get their own notice', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({ path: PATH, fs, now: () => t, escalateAfterMs: 100 })
    s.put('marko', msg({ chatId: 'A', messageId: 1 }))
    s.put('marko', msg({ chatId: 'B', messageId: 2 }))
    t = 1000
    expect(sweepFlags(s).filter(Boolean).length).toBe(2)
  })

  it('same chat, different forum topics are coalesced independently', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({ path: PATH, fs, now: () => t, escalateAfterMs: 100 })
    s.put('marko', msg({ chatId: 'A', messageId: 1, meta: { threadId: '3' } }))
    s.put('marko', msg({ chatId: 'A', messageId: 2, meta: { threadId: '4' } }))
    t = 1000
    expect(sweepFlags(s).filter(Boolean).length).toBe(2)
  })

  it('THE BUG: the coalescing window survives a restart — a re-aged synthetic does not re-spam', () => {
    const fs = fakeFs()
    let t = 0
    const opts = { escalateAfterMs: 100, escalateNoticeCooldownMs: 60_000 }
    // Boot 1: one synthetic ages out → posts the notice.
    const s1 = createInboundSpool({ path: PATH, fs, now: () => t, ...opts })
    s1.put('marko', msg({ messageId: 0, ts: 1, meta: { source: 'cron' } }))
    t = 1000
    expect(sweepFlags(s1)).toEqual([true])
    // Restart. A NEW synthetic (fresh ts → fresh id) lands and ages out within
    // the cooldown. Pre-fix this re-posted every cycle across restarts.
    t = 5000
    const s2 = createInboundSpool({ path: PATH, fs, now: () => t, ...opts })
    s2.put('marko', msg({ messageId: 0, ts: 2, meta: { source: 'cron' } }))
    t = 6000
    expect(sweepFlags(s2)).toEqual([false]) // dropped, but notice SUPPRESSED
  })

  it('compaction preserves the coalescing window (a post-compaction restart does not re-spam)', () => {
    const fs = fakeFs()
    let t = 0
    // Tiny compact threshold so the next append triggers a rewrite.
    const opts = { escalateAfterMs: 100, escalateNoticeCooldownMs: 60_000, compactAtBytes: 1 }
    const s1 = createInboundSpool({ path: PATH, fs, now: () => t, ...opts })
    s1.put('marko', msg({ messageId: 0, ts: 1, meta: { source: 'cron' } }))
    t = 1000
    expect(sweepFlags(s1)).toEqual([true]) // posts + appends esc; compaction runs
    // After compaction the file must still carry the esc record → a restart
    // hydrates the window → a new re-aged synthetic stays suppressed.
    t = 5000
    const s2 = createInboundSpool({ path: PATH, fs, now: () => t, ...opts })
    s2.put('marko', msg({ messageId: 0, ts: 2, meta: { source: 'cron' } }))
    t = 6000
    expect(sweepFlags(s2)).toEqual([false])
  })

  it('re-notifies after the burst goes quiet for longer than the cooldown', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({
      path: PATH, fs, now: () => t,
      escalateAfterMs: 100, escalateNoticeCooldownMs: 1000,
    })
    s.put('marko', msg({ messageId: 0, ts: 1, meta: { source: 'cron' } }))
    t = 200
    expect(sweepFlags(s)).toEqual([true]) // first notice
    // Quiet gap longer than the cooldown, then a new stuck synthetic.
    t = 5000
    s.put('marko', msg({ messageId: 0, ts: 2, meta: { source: 'cron' } }))
    t = 5200
    expect(sweepFlags(s)).toEqual([true]) // genuinely new situation → re-notify
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

  it('atomic compaction: a rename crash leaves the ORIGINAL log intact (no loss)', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs, compactAtBytes: 200 })
    for (let i = 1; i <= 10; i++) {
      s.put('a', msg({ messageId: i, text: 'y'.repeat(50) }))
    }
    // Simulate a crash AFTER the tmp write but BEFORE/at the rename.
    fs.renameSync = () => {
      throw new Error('crash mid-compact')
    }
    s.put('a', msg({ messageId: 11, text: 'y'.repeat(50) })) // triggers maybeCompact → rename throws
    // Original append-only log must still hold every live entry — the
    // failed compaction is a no-op, never a truncation.
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(11)
    expect(s2.liveEntries().map((e) => e.msg.messageId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ])
  })
})
