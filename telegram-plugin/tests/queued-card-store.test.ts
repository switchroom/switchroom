/**
 * queued-card-store.test.ts — outcome-based tests for the queued-status /
 * busy-ack card restart-survivability fix (#3002).
 *
 * PRE-FIX PROOF: before this change, no persistence existed for the
 * `queuedStatusMsgIds` Map at all — `../gateway/queued-card-store.js` did not
 * exist, so `import` itself failed at collection time and every test below
 * failed on today's (pre-fix) base — there was no seam to test.
 *
 * This file exercises the REAL exported store + boot-reaper functions (not a
 * structural grep), mirroring `activity-card-store.test.ts`'s in-memory fs seam
 * convention, proving the exact outcome contract:
 *   (a) card post persists a record;
 *   (b) in-process reap clears it;
 *   (c) a boot reaper against a leftover record performs EXACTLY ONE Telegram
 *       delete and empties the store;
 *   (d) a second boot performs ZERO deletes;
 *   (e) a corrupt state file never crashes boot and is dropped without a delete;
 *   (f) a delete failure never crashes the reaper and still clears the row.
 */
import { describe, it, expect } from 'vitest'
import {
  loadQueuedCards,
  persistQueuedCards,
  writeQueuedCardRecord,
  clearQueuedCardRecord,
  runQueuedCardBootReaper,
  type QueuedCardRecord,
  type QueuedCardStoreFsSeam,
} from '../gateway/queued-card-store.js'

/** In-memory fs seam with an atomic rename — same convention as
 *  activity-card-store.test.ts's memFs, so the tmp→rename crash-safety
 *  contract is exercised without touching real disk. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const calls: string[] = []
  const fs: QueuedCardStoreFsSeam = {
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return files.get(p)!
    },
    writeFileSync: (p, d) => {
      calls.push(`write:${p}`)
      files.set(p, d)
    },
    renameSync: (a, b) => {
      calls.push(`rename:${a}->${b}`)
      if (!files.has(a)) throw new Error(`ENOENT ${a}`)
      files.set(b, files.get(a)!)
      files.delete(a)
    },
    existsSync: (p) => files.has(p),
  }
  return { fs, files, calls }
}

const PATH = '/state/agent/telegram/queued-cards-pending.json'

function card(over: Partial<QueuedCardRecord> = {}): QueuedCardRecord {
  return {
    key: '-100123:42',
    chatId: '-100123',
    threadId: 42,
    messageId: 715,
    ...over,
  }
}

describe('queued-card-store — persistence primitives', () => {
  it('loads [] when no file exists (fresh boot)', () => {
    const { fs } = memFs()
    expect(loadQueuedCards(PATH, fs)).toEqual([])
  })

  it('(a) card post → state persisted (round-trips a written record)', () => {
    const { fs } = memFs()
    const record = card()
    writeQueuedCardRecord(PATH, fs, record)
    const loaded = loadQueuedCards(PATH, fs)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(record)
  })

  it('round-trips a DM card (threadId null)', () => {
    const { fs } = memFs()
    const record = card({ key: '-100123:', threadId: null })
    writeQueuedCardRecord(PATH, fs, record)
    expect(loadQueuedCards(PATH, fs)[0]).toEqual(record)
  })

  it('a fresh post for the same topic replaces (upserts) the stale row, not appends', () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card({ messageId: 715 }))
    writeQueuedCardRecord(PATH, fs, card({ messageId: 900 }))
    const loaded = loadQueuedCards(PATH, fs)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.messageId).toBe(900)
  })

  it('keeps rows for distinct keys (different topics) side by side', () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card({ key: '-100123:42', messageId: 715 }))
    writeQueuedCardRecord(PATH, fs, card({ key: '-100123:43', messageId: 716 }))
    expect(loadQueuedCards(PATH, fs)).toHaveLength(2)
  })

  it('(b) in-process reap → state cleared', () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card())
    expect(loadQueuedCards(PATH, fs)).toHaveLength(1)
    clearQueuedCardRecord(PATH, fs, '-100123:42')
    expect(loadQueuedCards(PATH, fs)).toEqual([])
  })

  it('clearing an absent/mismatched key is a no-op (never throws)', () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card({ key: '-100123:99' }))
    clearQueuedCardRecord(PATH, fs, '-100123:42')
    expect(loadQueuedCards(PATH, fs)).toHaveLength(1)
  })

  it('reap-race guard: clear scoped to messageId leaves a fresh live card intact', () => {
    const { fs } = memFs()
    // A live turn posted a NEW card (msg 900) under the same key while a stale
    // reap tries to clear the OLD one (msg 715) — the new row must survive.
    writeQueuedCardRecord(PATH, fs, card({ messageId: 900 }))
    clearQueuedCardRecord(PATH, fs, '-100123:42', 715)
    const loaded = loadQueuedCards(PATH, fs)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.messageId).toBe(900)
  })

  it('writes via tmp + atomic rename (crash-safe)', () => {
    const { fs, calls } = memFs()
    persistQueuedCards(PATH, fs, [card()])
    expect(calls).toEqual([`write:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`])
  })

  it('(e) corrupt state file: boot survives, loads as [] (fail-open, never throws)', () => {
    const { fs } = memFs({ [PATH]: '{not json' })
    expect(() => loadQueuedCards(PATH, fs)).not.toThrow()
    expect(loadQueuedCards(PATH, fs)).toEqual([])
  })

  it('fail-open: wrong envelope version / malformed shape loads as []', () => {
    const { fs: f1 } = memFs({ [PATH]: JSON.stringify({ v: 2, cards: [card()] }) })
    expect(loadQueuedCards(PATH, f1)).toEqual([])
    const { fs: f2 } = memFs({ [PATH]: JSON.stringify({ v: 1, cards: 'nope' }) })
    expect(loadQueuedCards(PATH, f2)).toEqual([])
    const { fs: f3 } = memFs({ [PATH]: JSON.stringify({ v: 1, cards: [{ key: '' }] }) })
    expect(loadQueuedCards(PATH, f3)).toEqual([])
  })
})

describe('queued-card-store — boot reaper (reap-on-boot, delete is the terminal)', () => {
  it('(c) deletes each persisted card EXACTLY ONCE and empties the store', async () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card({ key: '-100123:42', messageId: 715 }))
    writeQueuedCardRecord(PATH, fs, card({ key: '-100123:43', messageId: 716 }))
    const deletes: number[] = []
    const res = await runQueuedCardBootReaper({
      path: PATH,
      fs,
      deleteCard: async (r) => {
        deletes.push(r.messageId)
        return { message_id: r.messageId }
      },
    })
    expect(res).toEqual({ deleted: 2, total: 2 })
    expect(deletes.sort()).toEqual([715, 716])
    // Store is emptied — the stale cards can never be re-reaped.
    expect(loadQueuedCards(PATH, fs)).toEqual([])
  })

  it('(d) a SECOND boot performs ZERO deletes (store already drained)', async () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card())
    await runQueuedCardBootReaper({ path: PATH, fs, deleteCard: async () => ({}) })
    const deletes: number[] = []
    const res = await runQueuedCardBootReaper({
      path: PATH,
      fs,
      deleteCard: async (r) => {
        deletes.push(r.messageId)
        return {}
      },
    })
    expect(res).toEqual({ deleted: 0, total: 0 })
    expect(deletes).toEqual([])
  })

  it('deletes the record BEFORE the delete call (idempotency guard — no double-delete on crash)', async () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card({ messageId: 715 }))
    let storeAtDeleteTime: QueuedCardRecord[] | null = null
    await runQueuedCardBootReaper({
      path: PATH,
      fs,
      deleteCard: async () => {
        // At the moment the Telegram delete runs, the row is already gone from
        // disk — a crash here or a concurrent second boot cannot re-issue it.
        storeAtDeleteTime = loadQueuedCards(PATH, fs)
        return {}
      },
    })
    expect(storeAtDeleteTime).toEqual([])
  })

  it('(f) a delete FAILURE never crashes the reaper and still clears the row (best-effort, tolerate "not found")', async () => {
    const { fs } = memFs()
    writeQueuedCardRecord(PATH, fs, card({ messageId: 715 }))
    const res = await runQueuedCardBootReaper({
      path: PATH,
      fs,
      deleteCard: async () => {
        throw new Error('Bad Request: message to delete not found')
      },
      log: () => {},
    })
    // Not counted as deleted, but the row is dropped (delete-first) so it can't
    // wedge every future boot.
    expect(res).toEqual({ deleted: 0, total: 1 })
    expect(loadQueuedCards(PATH, fs)).toEqual([])
  })

  it('empty store: reaper is a no-op', async () => {
    const { fs } = memFs()
    const res = await runQueuedCardBootReaper({ path: PATH, fs, deleteCard: async () => ({}) })
    expect(res).toEqual({ deleted: 0, total: 0 })
  })
})
