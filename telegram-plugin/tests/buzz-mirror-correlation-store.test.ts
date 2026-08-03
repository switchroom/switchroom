import { describe, it, expect } from 'vitest'
import {
  createCorrelationStore,
  type CorrelationFsLike,
} from '../gateway/buzz-mirror-correlation-store.js'

/**
 * In-memory fake filesystem implementing CorrelationFsLike. Shared across store
 * instances to simulate a gateway restart against the SAME journal — the core
 * of the #4222 fix (an edit_message correction must survive a restart).
 */
function makeFakeFs(): CorrelationFsLike & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const fdPaths = new Map<number, string>()
  let nextFd = 3
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p) },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return files.get(p)!
    },
    writeFileSync: (p, data) => { files.set(p, data) },
    renameSync: (from, to) => {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    openSync: (p) => {
      if (!files.has(p)) files.set(p, '')
      const fd = nextFd++
      fdPaths.set(fd, p)
      return fd
    },
    writeSync: (fd, data) => {
      const p = fdPaths.get(fd)!
      files.set(p, (files.get(p) ?? '') + data)
    },
    fsyncSync: () => { /* no-op */ },
    closeSync: (fd) => { fdPaths.delete(fd) },
  }
}

const JP = '/state/buzz/mirror-correlation.jsonl'

describe('createCorrelationStore — durable msg→Buzz correlation (#4222)', () => {
  it('replays a persisted mapping into a NEW store instance (restart survival)', () => {
    const fs = makeFakeFs()
    const a = createCorrelationStore({ journalPath: JP, fs })
    a.set('555:1001', { eventId: 'evt-A', channelId: 'chan-A' })
    a.close()

    // Fresh instance over the SAME journal — the mapping must reload.
    const b = createCorrelationStore({ journalPath: JP, fs })
    expect(b.get('555:1001')).toEqual({ eventId: 'evt-A', channelId: 'chan-A' })
    expect(b.size()).toBe(1)
  })

  it('last-write-wins on a re-set key across a restart', () => {
    const fs = makeFakeFs()
    const a = createCorrelationStore({ journalPath: JP, fs })
    a.set('555:1', { eventId: 'evt-old', channelId: 'chan-A' })
    a.set('555:1', { eventId: 'evt-new', channelId: 'chan-A' })
    a.close()

    const b = createCorrelationStore({ journalPath: JP, fs })
    expect(b.get('555:1')).toEqual({ eventId: 'evt-new', channelId: 'chan-A' })
    expect(b.size()).toBe(1)
  })

  it('in-memory-only mode (no journalPath) never touches the fs but still bounds', () => {
    const fs = makeFakeFs()
    const s = createCorrelationStore({ capacity: 2, fs })
    s.set('a', { eventId: 'e1', channelId: 'c' })
    s.set('b', { eventId: 'e2', channelId: 'c' })
    s.set('c', { eventId: 'e3', channelId: 'c' })
    expect(s.get('a')).toBeUndefined() // evicted (FIFO, capacity 2)
    expect(s.size()).toBe(2)
    expect(fs.files.size).toBe(0) // no journal written
  })

  it('enforces the FIFO capacity bound in memory AND on disk after compaction', () => {
    const fs = makeFakeFs()
    const capacity = 4
    const a = createCorrelationStore({ journalPath: JP, fs, capacity })
    // Insert more than capacity — oldest keys evict.
    for (let i = 0; i < 20; i++) a.set(`k:${i}`, { eventId: `e${i}`, channelId: 'c' })
    expect(a.size()).toBe(capacity)
    expect(a.get('k:0')).toBeUndefined()
    expect(a.get('k:19')).toEqual({ eventId: 'e19', channelId: 'c' })
    a.close()

    // Restart: boot compaction must keep the on-disk journal bounded too — a new
    // instance sees exactly `capacity` keys, and the compacted journal file has
    // no more than `capacity` lines.
    const b = createCorrelationStore({ journalPath: JP, fs, capacity })
    expect(b.size()).toBe(capacity)
    const lines = (fs.files.get(JP) ?? '').split('\n').filter((l) => l.trim())
    expect(lines.length).toBeLessThanOrEqual(capacity)
    expect(b.get('k:19')).toEqual({ eventId: 'e19', channelId: 'c' })
  })

  it('re-compacts in-session so the journal never grows unbounded', () => {
    const fs = makeFakeFs()
    const capacity = 4
    const s = createCorrelationStore({ journalPath: JP, fs, capacity })
    // Churn far more writes than capacity; the in-session compaction (at
    // capacity * COMPACTION_FACTOR appends) must keep the file bounded.
    for (let i = 0; i < 200; i++) s.set(`k:${i}`, { eventId: `e${i}`, channelId: 'c' })
    const lines = (fs.files.get(JP) ?? '').split('\n').filter((l) => l.trim())
    // Bounded by roughly capacity * COMPACTION_FACTOR (4*4=16) + the compacted
    // baseline — assert it stays a small multiple of capacity, never 200.
    expect(lines.length).toBeLessThan(capacity * 8)
    expect(s.size()).toBe(capacity)
    s.close()
  })

  it('tolerates a torn final journal line (crash mid-write)', () => {
    const fs = makeFakeFs()
    fs.dirs.add('/state/buzz')
    fs.files.set(
      JP,
      JSON.stringify({ key: '1:1', eventId: 'e1', channelId: 'c' }) + '\n' + '{"key":"1:2","eventId', // truncated
    )
    const s = createCorrelationStore({ journalPath: JP, fs })
    expect(s.get('1:1')).toEqual({ eventId: 'e1', channelId: 'c' })
    expect(s.get('1:2')).toBeUndefined()
  })

  it('degrades to empty in-memory when the journal cannot be read', () => {
    const fs = makeFakeFs()
    fs.dirs.add('/state/buzz')
    fs.files.set(JP, 'exists-but-unreadable')
    const throwingFs: CorrelationFsLike = {
      ...fs,
      readFileSync: () => { throw new Error('EIO') },
    }
    const s = createCorrelationStore({ journalPath: JP, fs: throwingFs })
    // No crash; store is empty and still usable.
    expect(s.size()).toBe(0)
    s.set('1:1', { eventId: 'e1', channelId: 'c' })
    expect(s.get('1:1')).toEqual({ eventId: 'e1', channelId: 'c' })
  })
})
