/**
 * #1720 — extensions to inbound-spool for the progress envelope.
 *
 * Three behaviours pinned here that the existing spool tests don't
 * cover:
 *
 *   1. spoolId for `subagent_progress` is bucket-deterministic — two
 *      envelopes for the same (jsonl id, bucket idx) collapse to ONE
 *      live entry regardless of ts.
 *   2. `liveEntries()` skips entries whose `meta.expiresAt` has
 *      passed (stale progress is worse than no progress).
 *   3. `dropMatching(predicate)` tombstones live entries by spool id
 *      prefix — the handback path uses this to sweep stale progress
 *      envelopes for a sub-agent at the moment its handback is queued.
 */

import { describe, it, expect } from 'vitest'
import {
  createInboundSpool,
  spoolId,
  type InboundSpoolFsSeam,
} from '../gateway/inbound-spool.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

function progressMsg(over: {
  jsonlId: string
  bucketIdx: number
  ts?: number
  chatId?: string
  expiresAt?: number
}): InboundMessage {
  const ts = over.ts ?? 1_000_000
  const meta: Record<string, string> = {
    source: 'subagent_progress',
    subagent_jsonl_id: over.jsonlId,
    bucket_idx: String(over.bucketIdx),
  }
  if (over.expiresAt != null) meta.expiresAt = String(over.expiresAt)
  return {
    type: 'inbound',
    chatId: over.chatId ?? 'c1',
    messageId: ts,
    user: 'subagent-watcher',
    userId: 0,
    ts,
    text: 'progress envelope',
    meta,
  }
}

function fakeFs(): InboundSpoolFsSeam {
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
  }
}

const PATH = '/state/agent/telegram/inbound-spool.jsonl'

describe('spoolId — subagent_progress branch (#1720)', () => {
  it('two progress envelopes for the same (jsonl id, bucket idx) have IDENTICAL ids', () => {
    const a = spoolId(progressMsg({ jsonlId: 'j1', bucketIdx: 2, ts: 1000 }))
    const b = spoolId(progressMsg({ jsonlId: 'j1', bucketIdx: 2, ts: 9999 }))
    expect(a).toBe('s:progress:j1:2')
    expect(a).toBe(b)
  })

  it('different bucket idx → different id', () => {
    expect(
      spoolId(progressMsg({ jsonlId: 'j1', bucketIdx: 1 })),
    ).not.toBe(spoolId(progressMsg({ jsonlId: 'j1', bucketIdx: 2 })))
  })

  it('different jsonl id → different id', () => {
    expect(
      spoolId(progressMsg({ jsonlId: 'j1', bucketIdx: 1 })),
    ).not.toBe(spoolId(progressMsg({ jsonlId: 'j2', bucketIdx: 1 })))
  })
})

describe('inbound-spool — progress envelopes coalesce by bucket', () => {
  it('three puts for the same (jsonl id, bucket idx) yield ONE live entry', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    expect(s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1, ts: 1000 }))).toBe(true)
    expect(s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1, ts: 2000 }))).toBe(false)
    expect(s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1, ts: 3000 }))).toBe(false)
    expect(s.liveCount()).toBe(1)
  })

  it('a fresh spool over the same file still sees ONE live entry (restart-safe coalesce)', () => {
    const fs = fakeFs()
    const s1 = createInboundSpool({ path: PATH, fs })
    s1.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1, ts: 1000 }))
    s1.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1, ts: 2000 }))
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(1)
    expect(s2.liveEntries()[0].msg.meta.subagent_jsonl_id).toBe('j1')
  })

  it('successive buckets DO NOT collapse', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1 }))
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 2 }))
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 3 }))
    expect(s.liveCount()).toBe(3)
  })
})

describe('inbound-spool — TTL filter on liveEntries (#1720)', () => {
  it('an entry whose expiresAt is in the past is OMITTED from liveEntries', () => {
    const fs = fakeFs()
    let t = 1_000_000
    const s = createInboundSpool({ path: PATH, fs, now: () => t })
    // expiresAt = 1_002_000 — within window at put-time
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1, ts: t, expiresAt: 1_002_000 }))
    expect(s.liveEntries()).toHaveLength(1)
    expect(s.liveCount()).toBe(1) // raw count includes it
    // Advance clock past expiry
    t = 1_010_000
    expect(s.liveEntries()).toHaveLength(0)
    // liveCount is the raw map size — TTL is a read-time filter.
    expect(s.liveCount()).toBe(1)
  })

  it('entries without expiresAt are not affected (handback envelopes stay live)', () => {
    const fs = fakeFs()
    let t = 1_000_000
    const s = createInboundSpool({ path: PATH, fs, now: () => t })
    s.put('worker', {
      type: 'inbound',
      chatId: 'c1',
      messageId: 999,
      user: 'x',
      userId: 0,
      ts: t,
      text: 'handback',
      meta: { source: 'subagent_handback' },
    })
    t = 9_000_000_000
    expect(s.liveEntries()).toHaveLength(1)
  })

  it('a non-numeric or empty expiresAt is treated as "no expiry"', () => {
    const fs = fakeFs()
    let t = 1_000_000
    const s = createInboundSpool({ path: PATH, fs, now: () => t })
    s.put('worker', {
      type: 'inbound',
      chatId: 'c1',
      messageId: 1,
      user: 'x',
      userId: 0,
      ts: t,
      text: 'x',
      meta: { source: 'subagent_progress', subagent_jsonl_id: 'j1', bucket_idx: '1', expiresAt: '' },
    })
    s.put('worker', {
      type: 'inbound',
      chatId: 'c1',
      messageId: 2,
      user: 'x',
      userId: 0,
      ts: t,
      text: 'x',
      meta: { source: 'subagent_progress', subagent_jsonl_id: 'j2', bucket_idx: '1', expiresAt: 'not-a-number' },
    })
    t = 9_000_000_000
    expect(s.liveEntries()).toHaveLength(2)
  })
})

describe('inbound-spool — dropMatching (#1720 handback sweep)', () => {
  it('drops every live entry whose id matches the predicate', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1 }))
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 2 }))
    s.put('worker', progressMsg({ jsonlId: 'j2', bucketIdx: 1 }))
    expect(s.liveCount()).toBe(3)
    const dropped = s.dropMatching((id) => id.startsWith('s:progress:j1:'))
    expect(dropped).toBe(2)
    expect(s.liveCount()).toBe(1)
    expect(s.liveEntries()[0].msg.meta.subagent_jsonl_id).toBe('j2')
  })

  it('a drop survives across a restart (tombstoned in the log)', () => {
    const fs = fakeFs()
    const s1 = createInboundSpool({ path: PATH, fs })
    s1.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1 }))
    s1.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 2 }))
    expect(s1.dropMatching((id) => id.startsWith('s:progress:j1:'))).toBe(2)
    const s2 = createInboundSpool({ path: PATH, fs })
    expect(s2.liveCount()).toBe(0)
  })

  it('an empty match set is a no-op (returns 0)', () => {
    const fs = fakeFs()
    const s = createInboundSpool({ path: PATH, fs })
    s.put('worker', progressMsg({ jsonlId: 'j1', bucketIdx: 1 }))
    expect(s.dropMatching((id) => id.startsWith('s:progress:nope:'))).toBe(0)
    expect(s.liveCount()).toBe(1)
  })
})
