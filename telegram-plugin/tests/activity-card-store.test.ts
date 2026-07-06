/**
 * activity-card-store.test.ts — outcome-based tests for the mid-turn
 * activity-card restart-survivability fix (Known Gap 1,
 * `reference/rfcs/deterministic-turn-liveness.md`).
 *
 * PRE-FIX PROOF: before this PR, no persistence existed for
 * `CurrentTurn.activityMessageId` at all — `../gateway/activity-card-store.js`
 * did not exist, so `import` itself failed at collection time:
 *
 *   Error: Cannot find module '../gateway/activity-card-store.js'
 *   (or its corresponding .ts source) imported from
 *   telegram-plugin/tests/activity-card-store.test.ts
 *
 * i.e. every test below fails on today's (pre-fix) base — there was no seam
 * to test. Recorded run against `origin/main` (this PR's parent commit)
 * before the module was added:
 *
 *   FAIL  telegram-plugin/tests/activity-card-store.test.ts
 *   [vitest] Cannot find module '../gateway/activity-card-store.js'
 *
 * This file exercises the REAL exported store + boot-reaper functions (not a
 * structural grep), mirroring `status-pin-store.test.ts`'s in-memory fs seam
 * convention, plus a transport-boundary reaper test (mirrors
 * `silent-end-transport.test.ts`'s spy-transport convention) proving the
 * exact outcome contract: (a) card open persists a record; (b) clean close
 * clears it; (c) a boot reaper run against a leftover record performs
 * EXACTLY ONE finalizing edit + one unpin and deletes the record; (d) a
 * second boot performs ZERO edits and ZERO unpins; (e) a corrupt state file
 * never crashes boot and is dropped without an edit.
 */
import { describe, it, expect } from 'vitest'
import {
  loadActivityCards,
  persistActivityCards,
  writeActivityCardRecord,
  clearActivityCardRecord,
  runActivityCardBootReaper,
  restartOrphanCardFinalizeText,
  type ActivityCardRecord,
  type ActivityCardStoreFsSeam,
} from '../gateway/activity-card-store.js'

/** In-memory fs seam with an atomic rename — same convention as
 *  status-pin-store.test.ts's memFs, so the tmp→rename crash-safety
 *  contract is exercised without touching real disk. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const calls: string[] = []
  const fs: ActivityCardStoreFsSeam = {
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

const PATH = '/state/agent/telegram/activity-cards-pending.json'

function card(over: Partial<ActivityCardRecord> = {}): ActivityCardRecord {
  return {
    turnKey: 'c:_',
    chatId: '-100123',
    threadId: null,
    activityMessageId: 715,
    startedAt: Date.now() - 60_000,
    pinned: true,
    ...over,
  }
}

describe('activity-card-store — persistence primitives', () => {
  it('loads [] when no file exists (fresh boot)', () => {
    const { fs } = memFs()
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('(a) card open → state persisted (round-trips a written record)', () => {
    const { fs } = memFs()
    // Construct ONCE — card() stamps `startedAt: Date.now() - 60_000`, so two
    // separate calls can straddle a millisecond and flake the deep-equal.
    const record = card()
    writeActivityCardRecord(PATH, fs, record)
    const loaded = loadActivityCards(PATH, fs)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(record)
  })

  it('a fresh OPEN for the same topic replaces (upserts) the stale row, not appends', () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card({ activityMessageId: 715 }))
    writeActivityCardRecord(PATH, fs, card({ activityMessageId: 900 }))
    const loaded = loadActivityCards(PATH, fs)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.activityMessageId).toBe(900)
  })

  it('(b) clean close → state cleared', () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card())
    expect(loadActivityCards(PATH, fs)).toHaveLength(1)
    clearActivityCardRecord(PATH, fs, 'c:_')
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('clearing an absent/mismatched turnKey is a no-op (never throws)', () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card({ turnKey: 'c:other' }))
    clearActivityCardRecord(PATH, fs, 'c:_')
    expect(loadActivityCards(PATH, fs)).toHaveLength(1)
  })

  it('writes via tmp + atomic rename (crash-safe)', () => {
    const { fs, calls } = memFs()
    persistActivityCards(PATH, fs, [card()])
    expect(calls).toEqual([`write:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`])
  })

  it('(e) corrupt state file: boot survives, loads as [] (fail-open, never throws)', () => {
    const { fs } = memFs({ [PATH]: '{not json' })
    expect(() => loadActivityCards(PATH, fs)).not.toThrow()
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('fail-open: wrong envelope version / malformed shape loads as []', () => {
    const { fs: f1 } = memFs({ [PATH]: JSON.stringify({ v: 2, cards: [card()] }) })
    expect(loadActivityCards(PATH, f1)).toEqual([])
    const { fs: f2 } = memFs({ [PATH]: JSON.stringify({ v: 1, cards: 'nope' }) })
    expect(loadActivityCards(PATH, f2)).toEqual([])
  })

  it('drops malformed rows but keeps valid ones', () => {
    const { fs } = memFs({
      [PATH]: JSON.stringify({
        v: 1,
        cards: [
          card({ activityMessageId: 715 }),
          { turnKey: '', chatId: 'c', threadId: null, activityMessageId: 1, startedAt: 1 },
          { turnKey: 'k', chatId: 'c', threadId: null, startedAt: 1 }, // missing activityMessageId
        ],
      }),
    })
    const loaded = loadActivityCards(PATH, fs)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.activityMessageId).toBe(715)
  })

  it('persist never throws on a failing fs (durability degrades, live path unaffected)', () => {
    const throwingFs: ActivityCardStoreFsSeam = {
      readFileSync: () => {
        throw new Error('boom')
      },
      writeFileSync: () => {
        throw new Error('disk full')
      },
      renameSync: () => {
        throw new Error('nope')
      },
      existsSync: () => false,
    }
    const logs: string[] = []
    expect(() => persistActivityCards(PATH, throwingFs, [card()], (l) => logs.push(l))).not.toThrow()
    expect(logs.join('')).toContain('persist FAILED')
  })
})

/**
 * Boot reaper — transport-boundary outcome tests (mirrors
 * silent-end-transport.test.ts's spy-transport convention): a spy stands in
 * for `bot.api.editMessageText` / `bot.api.unpinChatMessage`, asserting an
 * actual finalizing edit + unpin land, not a stubbed decision callback.
 */
describe('runActivityCardBootReaper — transport-boundary outcome tests', () => {
  it('(c) leftover record → exactly one finalizing edit + one unpin, record deleted', async () => {
    const { fs } = memFs()
    const startedAt = Date.now() - 90_000
    writeActivityCardRecord(PATH, fs, card({ startedAt }))

    const edits: Array<{ chatId: string; messageId: number; text: string }> = []
    const unpins: Array<{ chatId: string; messageId: number }> = []

    const res = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async (record) => {
        edits.push({
          chatId: record.chatId,
          messageId: record.activityMessageId,
          text: restartOrphanCardFinalizeText(record.startedAt),
        })
      },
      unpinCard: async (record) => {
        unpins.push({ chatId: record.chatId, messageId: record.activityMessageId })
      },
    })

    expect(edits).toHaveLength(1)
    expect(edits[0]!.chatId).toBe('-100123')
    expect(edits[0]!.messageId).toBe(715)
    expect(edits[0]!.text).toContain('Interrupted by a gateway restart')
    expect(edits[0]!.text).toContain('was running')

    expect(unpins).toHaveLength(1)
    expect(unpins[0]).toEqual({ chatId: '-100123', messageId: 715 })

    expect(res).toEqual({ finalized: 1, unpinned: 1, total: 1 })
    // Record gone — nothing left for a future boot to re-finalize.
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('(d) second boot with an already-empty store → zero edits, zero unpins', async () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card())

    let edits = 0
    let unpins = 0
    // First boot reaps the one leftover record.
    await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {
        edits++
      },
      unpinCard: async () => {
        unpins++
      },
    })
    expect(edits).toBe(1)
    expect(unpins).toBe(1)

    // Second boot re-reads the (now empty) file — the idempotency guarantee.
    const res2 = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {
        edits++
      },
      unpinCard: async () => {
        unpins++
      },
    })
    expect(edits).toBe(1) // unchanged
    expect(unpins).toBe(1) // unchanged
    expect(res2).toEqual({ finalized: 0, unpinned: 0, total: 0 })
  })

  it('a record with pinned:false (or absent) is finalized but never unpinned', async () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card({ pinned: false }))
    let unpins = 0
    const res = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {},
      unpinCard: async () => {
        unpins++
      },
    })
    expect(res.finalized).toBe(1)
    expect(unpins).toBe(0)
  })

  it('no-op on a fresh boot with no persisted cards (zero edits, zero unpins)', async () => {
    const { fs } = memFs()
    let calls = 0
    const res = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {
        calls++
      },
      unpinCard: async () => {
        calls++
      },
    })
    expect(res).toEqual({ finalized: 0, unpinned: 0, total: 0 })
    expect(calls).toBe(0)
  })

  it('a failing finalize edit is non-fatal, still attempts the unpin, and the store is still emptied', async () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card())
    let unpinCalled = false
    const res = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {
        throw new Error('message to edit not found')
      },
      unpinCard: async () => {
        unpinCalled = true
      },
    })
    expect(res).toEqual({ finalized: 0, unpinned: 1, total: 1 })
    expect(unpinCalled).toBe(true)
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('a failing unpin (already unpinned / no rights) is non-fatal and does not re-run the edit', async () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card())
    let editCalls = 0
    const res = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {
        editCalls++
      },
      unpinCard: async () => {
        throw new Error('message to unpin not found')
      },
    })
    expect(res).toEqual({ finalized: 1, unpinned: 0, total: 1 })
    expect(editCalls).toBe(1)
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('reaps multiple leftover records from distinct topics independently', async () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card({ turnKey: 'c:1', chatId: '-100111', activityMessageId: 1 }))
    writeActivityCardRecord(PATH, fs, card({ turnKey: 'c:2', chatId: '-100222', activityMessageId: 2 }))
    const edited: number[] = []
    const unpinned: number[] = []
    const res = await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async (r) => {
        edited.push(r.activityMessageId)
      },
      unpinCard: async (r) => {
        unpinned.push(r.activityMessageId)
      },
    })
    expect(res).toEqual({ finalized: 2, unpinned: 2, total: 2 })
    expect(edited.sort()).toEqual([1, 2])
    expect(unpinned.sort()).toEqual([1, 2])
    expect(loadActivityCards(PATH, fs)).toEqual([])
  })

  it('idempotency guard: the record is removed from disk BEFORE the finalize/unpin calls run (crash-mid-reap safety)', async () => {
    const { fs } = memFs()
    writeActivityCardRecord(PATH, fs, card())
    let onDiskDuringFinalize: ActivityCardRecord[] = []
    await runActivityCardBootReaper({
      path: PATH,
      fs,
      finalizeCard: async () => {
        onDiskDuringFinalize = loadActivityCards(PATH, fs)
      },
      unpinCard: async () => {},
    })
    // At the moment finalizeCard ran, the record was ALREADY gone from disk —
    // so a crash right here (or a concurrent second boot) can never re-reap it.
    expect(onDiskDuringFinalize).toEqual([])
  })
})

describe('restartOrphanCardFinalizeText', () => {
  it('is honest about elapsed time', () => {
    const text = restartOrphanCardFinalizeText(Date.now() - 45_000)
    expect(text).toContain('Interrupted by a gateway restart')
    expect(text).toMatch(/was running \d+s/)
  })

  it('omits a nonsensical elapsed clause for a degenerate startedAt', () => {
    const text = restartOrphanCardFinalizeText(Date.now() + 10_000) // future — negative elapsed
    expect(text).toContain('Interrupted by a gateway restart')
    expect(text).not.toContain('was running')
  })
})
