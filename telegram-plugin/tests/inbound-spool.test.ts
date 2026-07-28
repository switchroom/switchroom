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
 *  atomic rename (so the tmp→rename compaction path is exercised).
 *  `ops` records the mutating/durability calls in order, so tests can pin
 *  the fsync ORDERING the crash-durability guarantee depends on. */
function fakeFs(): InboundSpoolFsSeam & { dump(p?: string): string; ops: string[] } {
  const files = new Map<string, string>()
  const ops: string[] = []
  return {
    appendFileSync: (p, d) => {
      ops.push(`append:${p}`)
      files.set(p, (files.get(p) ?? '') + d)
    },
    readFileSync: (p) => files.get(p) ?? '',
    writeFileSync: (p, d) => {
      ops.push(`write:${p}`)
      files.set(p, d)
    },
    renameSync: (from, to) => {
      ops.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    existsSync: (p) => files.has(p),
    statSizeSync: (p) => Buffer.byteLength(files.get(p) ?? ''),
    fsyncFileSync: (p) => ops.push(`fsyncFile:${p}`),
    fsyncDirSync: (p) => ops.push(`fsyncDir:${p}`),
    dump: (p = PATH) => files.get(p) ?? '',
    ops,
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
  // #2793 part B: a cron BOOT-REPLAY carries meta.replay_fire_ms (the
  // minute-aligned fire being replayed). spoolId() keys on it + the
  // schedule index so a re-replay of the SAME missed fire across a gateway
  // restart — which mints a fresh synthetic messageId=ts each boot —
  // collapses to one live entry instead of stacking a fresh one each boot.
  it('cron boot-replay → s:cron-replay:chat:idx:fireMs, stable across ts/messageId', () => {
    const a = spoolId(
      msg({
        messageId: 1700_000_000_000,
        ts: 1700_000_000_000,
        meta: { source: 'cron', schedule_index: '3', replay_fire_ms: '1699999980000' },
      }),
    )
    const b = spoolId(
      msg({
        messageId: 1700_000_999_999,
        ts: 1700_000_999_999,
        meta: { source: 'cron', schedule_index: '3', replay_fire_ms: '1699999980000' },
      }),
    )
    expect(a).toBe('s:cron-replay:c1:3:1699999980000')
    expect(b).toBe(a) // stable across the fresh per-boot messageId/ts
  })
  it('cron boot-replays for distinct missed fires stay distinct', () => {
    const a = spoolId(
      msg({ messageId: 0, meta: { source: 'cron', schedule_index: '3', replay_fire_ms: '100' } }),
    )
    const b = spoolId(
      msg({ messageId: 0, meta: { source: 'cron', schedule_index: '3', replay_fire_ms: '200' } }),
    )
    const c = spoolId(
      msg({ messageId: 0, meta: { source: 'cron', schedule_index: '4', replay_fire_ms: '100' } }),
    )
    expect(a).not.toBe(b) // different fire minute
    expect(a).not.toBe(c) // different schedule index
  })
  it('a LIVE cron tick (no replay_fire_ms) keeps its per-fire identity', () => {
    // Live ticks are not routed through the spool, but assert the id path
    // is unchanged so live fires never collapse into a replay bucket.
    const live = spoolId(msg({ messageId: 0, meta: { source: 'cron' }, ts: 500 }))
    expect(live).toBe('s:c1:cron:500')
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

describe('inbound-spool — power-cut durability (fsync)', () => {
  it('fsyncs the spool file on every appended record', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs, log: () => {} })
    s.put('a', msg({ messageId: 1 }))
    s.ack(msg({ messageId: 1 }))
    // Both the put record and the ack tombstone are durability-critical:
    // an un-synced ack replays an already-answered message after a power
    // cut, an un-synced put loses it entirely.
    expect(fs.ops).toEqual([
      `append:${PATH}`,
      `fsyncFile:${PATH}`,
      `append:${PATH}`,
      `fsyncFile:${PATH}`,
    ])
  })

  it('compaction fsyncs the tmp file BEFORE the rename and the directory AFTER', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs, compactAtBytes: 200, log: () => {} })
    for (let i = 1; i <= 10; i++) s.put('a', msg({ messageId: i, text: 'y'.repeat(50) }))
    // The bound triggers several compactions across the 10 puts; each one
    // must follow the same four-step sequence, so pin the last.
    expect(fs.ops.slice(-4)).toEqual([
      `write:${PATH}.compact.tmp`,
      `fsyncFile:${PATH}.compact.tmp`,
      `rename:${PATH}.compact.tmp->${PATH}`,
      'fsyncDir:/state/agent/telegram',
    ])
  })

  it('an un-acked entry survives a POWER CUT, not just a process kill', () => {
    // Models the distinction the fsync exists for: `appendFileSync` returning
    // puts the bytes in the page cache (enough to survive SIGKILL — the
    // process dies, the kernel still holds them), but only fsync puts them on
    // stable storage. `powerCut()` discards everything not fsync'd, which is
    // what a host power loss actually does.
    const cache = new Map<string, string>()
    const platter = new Map<string, string>()
    const fs: InboundSpoolFsSeam = {
      appendFileSync: (p, d) => cache.set(p, (cache.get(p) ?? '') + d),
      readFileSync: (p) => cache.get(p) ?? '',
      writeFileSync: (p, d) => cache.set(p, d),
      renameSync: (from, to) => {
        cache.set(to, cache.get(from) ?? '')
        cache.delete(from)
      },
      existsSync: (p) => cache.has(p),
      statSizeSync: (p) => Buffer.byteLength(cache.get(p) ?? ''),
      fsyncFileSync: (p) => {
        if (cache.has(p)) platter.set(p, cache.get(p)!)
      },
      fsyncDirSync: () => {},
    }
    const powerCut = (): void => {
      cache.clear()
      for (const [p, d] of platter) cache.set(p, d)
    }

    const s = createInboundSpool({ path: PATH, fs, log: () => {} })
    s.put('a', msg({ messageId: 7, text: 'answer me' }))
    powerCut()

    const rebooted = createInboundSpool({ path: PATH, fs, log: () => {} })
    expect(rebooted.liveEntries().map((e) => e.msg.messageId)).toEqual([7])
  })
})

describe('inbound-spool — #2789 C: multi-message drop notice reports the real count', () => {
  it('passes the true per-chat dropped count to the coalesced notice', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({
      path: PATH,
      fs,
      now: () => t,
      escalateAfterMs: 100,
      escalateNoticeCooldownMs: 10_000,
    })
    // Four undeliverable synthetics in ONE chat — the historical bug
    // coalesced these into a notice that read as a SINGLE drop.
    s.put('marko', msg({ messageId: 0, ts: 1, meta: { source: 'cron' } }))
    s.put('marko', msg({ messageId: 0, ts: 2, meta: { source: 'cron' } }))
    s.put('marko', msg({ messageId: 0, ts: 3, meta: { source: 'cron' } }))
    s.put('marko', msg({ messageId: 0, ts: 4, meta: { source: 'cron' } }))
    t = 1000 // all older than the 100ms bound
    const posted: number[] = []
    const seen: number[] = []
    const dropped = s.sweepEscalations((_e, { postNotice, droppedCount }) => {
      seen.push(droppedCount)
      if (postNotice) posted.push(droppedCount)
    })
    expect(dropped).toBe(4) // all four retracted
    // Every callback for this chat sees the true sweep count (4), and the
    // ONE posted notice reports 4 — not 1.
    expect(seen).toEqual([4, 4, 4, 4])
    expect(posted).toEqual([4])
  })

  it('reports per-chat counts independently in a mixed sweep', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({
      path: PATH,
      fs,
      now: () => t,
      escalateAfterMs: 100,
      escalateNoticeCooldownMs: 10_000,
    })
    // 3 in chat A, 1 in chat B.
    s.put('m', msg({ chatId: 'A', messageId: 0, ts: 1, meta: { source: 'cron' } }))
    s.put('m', msg({ chatId: 'A', messageId: 0, ts: 2, meta: { source: 'cron' } }))
    s.put('m', msg({ chatId: 'A', messageId: 0, ts: 3, meta: { source: 'cron' } }))
    s.put('m', msg({ chatId: 'B', messageId: 0, ts: 4, meta: { source: 'cron' } }))
    t = 1000
    const posted = new Map<string, number>()
    s.sweepEscalations((e, { postNotice, droppedCount }) => {
      if (postNotice) posted.set(String(e.msg.chatId), droppedCount)
    })
    expect(posted.get('A')).toBe(3)
    expect(posted.get('B')).toBe(1)
  })

  it('a single drop still reports a count of 1', () => {
    const fs = fakeFs()
    let t = 0
    const s = createInboundSpool({ path: PATH, fs, now: () => t, escalateAfterMs: 100 })
    s.put('m', msg({ messageId: 0, ts: 1, meta: { source: 'cron' } }))
    t = 1000
    const counts: number[] = []
    s.sweepEscalations((_e, { droppedCount }) => counts.push(droppedCount))
    expect(counts).toEqual([1])
  })
})

describe('inbound-spool — #2789 B: spool write failure surfaces a health signal', () => {
  // An fs whose appendFileSync can be toggled to fail, modelling a full /
  // unwritable persistent volume. The append swallows the error (delivery
  // must not break) but the degradation must be SURFACED, not silent.
  function toggleableFs(): InboundSpoolFsSeam & { fail: boolean; failFsync: boolean } {
    const files = new Map<string, string>()
    const seam = {
      fail: false,
      // A failing fsync is its own degradation mode: the bytes reached the
      // page cache but NOT stable storage, so the durable promise is gone
      // even though appendFileSync returned cleanly.
      failFsync: false,
      appendFileSync(p: string, d: string) {
        if (seam.fail) throw new Error('ENOSPC: no space left on device')
        files.set(p, (files.get(p) ?? '') + d)
      },
      readFileSync: (p: string) => files.get(p) ?? '',
      writeFileSync: (p: string, d: string) => files.set(p, d),
      renameSync: (from: string, to: string) => {
        files.set(to, files.get(from) ?? '')
        files.delete(from)
      },
      existsSync: (p: string) => files.has(p),
      statSizeSync: (p: string) => Buffer.byteLength(files.get(p) ?? ''),
      fsyncFileSync: (_p: string) => {
        if (seam.failFsync) throw new Error('EIO: i/o error, fsync')
      },
      fsyncDirSync: (_p: string) => {},
    }
    return seam
  }

  it('raises a latched onDegraded signal when an append fails, and isDegraded() reflects it', () => {
    const fs = toggleableFs()
    const events: { degraded: boolean; consecutiveFailures: number }[] = []
    const s = createInboundSpool({
      path: PATH,
      fs,
      log: () => {},
      onDegraded: (info) => events.push({ degraded: info.degraded, consecutiveFailures: info.consecutiveFailures }),
    })
    expect(s.isDegraded()).toBe(false)
    fs.fail = true
    // put() must NOT throw — live delivery keeps working, durability degrades.
    expect(() => s.put('a', msg({ messageId: 1, ts: 1 }))).not.toThrow()
    expect(s.isDegraded()).toBe(true)
    expect(s.appendFailureCount()).toBe(1)
    // Latched: exactly one transition event on entering degraded.
    expect(events).toEqual([{ degraded: true, consecutiveFailures: 1 }])
  })

  it('a failing fsync degrades too — a cached-but-unsynced append is NOT durable', () => {
    // The subtle one: appendFileSync succeeds, so the old code would have
    // reported a healthy spool while the record was one power cut from gone.
    const fs = toggleableFs()
    const events: { degraded: boolean }[] = []
    const logs: string[] = []
    const s = createInboundSpool({
      path: PATH,
      fs,
      log: (l) => logs.push(l),
      onDegraded: (info) => events.push({ degraded: info.degraded }),
    })
    fs.failFsync = true
    expect(() => s.put('a', msg({ messageId: 1, ts: 1 }))).not.toThrow()
    expect(s.isDegraded()).toBe(true)
    expect(events).toEqual([{ degraded: true }])
    expect(logs.join('')).toContain('durability degraded')
    // Live delivery is unaffected — degradation is a durability claim, not a
    // delivery failure.
    expect(s.liveCount()).toBe(1)
  })

  it('does not re-fire the degraded signal on every failing append (latched)', () => {
    const fs = toggleableFs()
    const events: boolean[] = []
    const s = createInboundSpool({
      path: PATH, fs, log: () => {},
      onDegraded: (info) => events.push(info.degraded),
    })
    fs.fail = true
    s.put('a', msg({ messageId: 1, ts: 1 }))
    s.put('a', msg({ messageId: 2, ts: 2 }))
    s.put('a', msg({ messageId: 3, ts: 3 }))
    expect(s.appendFailureCount()).toBe(3)
    expect(events).toEqual([true]) // one transition, not three
  })

  it('surfaces recovery when appends succeed again (health signal un-latches)', () => {
    const fs = toggleableFs()
    const events: boolean[] = []
    const s = createInboundSpool({
      path: PATH, fs, log: () => {},
      onDegraded: (info) => events.push(info.degraded),
    })
    fs.fail = true
    s.put('a', msg({ messageId: 1, ts: 1 }))
    expect(s.isDegraded()).toBe(true)
    fs.fail = false
    s.put('a', msg({ messageId: 2, ts: 2 }))
    expect(s.isDegraded()).toBe(false)
    expect(s.appendFailureCount()).toBe(0)
    expect(events).toEqual([true, false]) // degraded → recovered
  })
})

// #2793 part B — cron boot-replay accept-vs-consume durability. A missed
// scheduled fire re-injected at boot is routed through this spool by the
// gateway's onInjectInbound handler (put on accept, ack on confirmed
// delivery). These tests pin the two windows the ledger closes.
describe('#2793 — cron boot-replay accept vs consume', () => {
  function replayMsg(fireMs: number, boot: number): InboundMessage {
    // A fresh synthetic messageId/ts is minted every replay attempt; the
    // stable identity is (schedule_index, replay_fire_ms).
    return msg({
      messageId: boot,
      ts: boot,
      user: 'cron',
      userId: 0,
      meta: { source: 'cron', schedule_index: '3', replay_fire_ms: String(fireMs) },
    })
  }

  it('accepted-but-NOT-consumed replay survives a restart and re-fires', () => {
    const fs = fakeFs()
    // Boot 1: the gateway accepts the replay (put) but the session never
    // came up, so it is never delivered → never acked.
    createInboundSpool({ path: PATH, fs, log: () => {} }).put('a', replayMsg(1000, 111))
    // Boot 2: a fresh gateway rehydrates from the durable log. The un-acked
    // replay is STILL live, so the boot-replay path re-delivers it — the
    // silent-loss window (accepted, never consumed) is closed.
    const s2 = createInboundSpool({ path: PATH, fs, log: () => {} })
    const live = s2.liveEntries()
    expect(live).toHaveLength(1)
    expect(live[0]!.msg.meta?.replay_fire_ms).toBe('1000')
  })

  it('a CONSUMED replay (acked on delivery) does NOT re-fire on restart', () => {
    const fs = fakeFs()
    const s1 = createInboundSpool({ path: PATH, fs, log: () => {} })
    const m = replayMsg(1000, 111)
    s1.put('a', m)
    s1.ack(m) // gateway delivered it to a live bridge → tombstone
    // A fresh gateway sees the tombstone and does not re-deliver — the
    // double-fire window is closed for a consumed replay.
    const s2 = createInboundSpool({ path: PATH, fs, log: () => {} })
    expect(s2.liveEntries()).toHaveLength(0)
  })

  it('a re-replay of the SAME missed fire dedups (at-least-once with dedup)', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs, log: () => {} })
    // First accept.
    expect(s.put('a', replayMsg(1000, 111))).toBe(true)
    // The scheduler re-replays the same missed fire on a later boot (fresh
    // messageId/ts) while the first is still un-acked → collapses to one.
    expect(s.put('a', replayMsg(1000, 222))).toBe(false)
    expect(s.liveCount()).toBe(1)
  })

  it('distinct missed fires are each retained (no cross-fire collapse)', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs, log: () => {} })
    expect(s.put('a', replayMsg(1000, 111))).toBe(true)
    expect(s.put('a', replayMsg(2000, 222))).toBe(true)
    expect(s.liveCount()).toBe(2)
  })
})
