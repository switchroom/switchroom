/**
 * Eager voice pre-synthesis + rolling cleanup unit tests (issue #2763).
 *
 * gateway.ts is a 25k-line module with import-time side effects, so the
 * primitives live in ../voice-presynth.ts (imported by the gateway). These
 * tests exercise the real primitives + reproduce the exact gateway decisions
 * (queue bounding, TTL/size sweep, attach-vs-fallback, kill switch) without
 * importing the gateway.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  PreSynthQueue,
  sweepVoiceCacheDir,
  writeVoiceCacheFile,
  voiceCacheFilePath,
  eagerVoiceEnabled,
  VOICE_FILE_TTL_MS,
  PRESYNTH_MAX_PENDING,
  type PreSynthJob,
  type SweepFs,
} from '../voice-presynth.js'
import { VoiceOnDemandCache } from '../voice-ondemand.js'

const KILL = 'SWITCHROOM_DISABLE_EAGER_VOICE'
let savedKill: string | undefined

beforeEach(() => {
  savedKill = process.env[KILL]
  delete process.env[KILL]
})

afterEach(() => {
  if (savedKill === undefined) delete process.env[KILL]
  else process.env[KILL] = savedKill
})

// ─── Kill switch ────────────────────────────────────────────────────────────

describe('eagerVoiceEnabled (kill switch)', () => {
  it('is on by default', () => {
    expect(eagerVoiceEnabled()).toBe(true)
  })

  it('is off when SWITCHROOM_DISABLE_EAGER_VOICE=1 or =true', () => {
    process.env[KILL] = '1'
    expect(eagerVoiceEnabled()).toBe(false)
    process.env[KILL] = 'true'
    expect(eagerVoiceEnabled()).toBe(false)
  })

  it('other values do not disable', () => {
    process.env[KILL] = '0'
    expect(eagerVoiceEnabled()).toBe(true)
    process.env[KILL] = ''
    expect(eagerVoiceEnabled()).toBe(true)
  })

  it('gateway put-site decision: kill switch means no job is enqueued', () => {
    // Reproduces the exact guard the gateway uses around enqueue().
    process.env[KILL] = '1'
    const ran: string[] = []
    const q = new PreSynthQueue({
      runJob: async (j) => void ran.push(j.token),
      defer: (fn) => fn(),
      log: () => {},
    })
    if (eagerVoiceEnabled()) q.enqueue({ token: 't1', text: 'hello' })
    expect(q.size).toBe(0)
    expect(ran).toEqual([])
  })
})

// ─── Queue bounding + serialization ─────────────────────────────────────────

describe('PreSynthQueue', () => {
  it('drains jobs FIFO with concurrency 1', async () => {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const deferred: Array<() => void> = []
    const q = new PreSynthQueue({
      runJob: async (j) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Promise.resolve() // yield — lets a concurrent runner interleave if one existed
        order.push(j.token)
        inFlight--
      },
      defer: (fn) => deferred.push(fn),
      log: () => {},
    })
    q.enqueue({ token: 'a', text: '1' })
    q.enqueue({ token: 'b', text: '2' })
    q.enqueue({ token: 'c', text: '3' })
    expect(deferred.length).toBe(1) // one drain kicked, not one per job
    deferred[0]!()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['a', 'b', 'c'])
    expect(maxInFlight).toBe(1)
    expect(q.size).toBe(0)
    expect(q.busy).toBe(false)
  })

  it('drops the OLDEST pending job past the backlog cap', () => {
    const q = new PreSynthQueue({
      runJob: async () => {},
      maxPending: 3,
      defer: () => {}, // never drain — pure backlog test
      log: () => {},
    })
    for (const t of ['a', 'b', 'c', 'd', 'e']) q.enqueue({ token: t, text: t })
    expect(q.size).toBe(3)
  })

  it('drop-oldest under a blocked runner keeps only the newest maxPending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const ran: string[] = []
    const q = new PreSynthQueue({
      runJob: async (j) => {
        ran.push(j.token)
        if (j.token === 'first') await gate // block the drain on the first job
      },
      maxPending: 2,
      defer: (fn) => fn(),
      log: () => {},
    })
    q.enqueue({ token: 'first', text: 'x' }) // starts running, blocks
    await new Promise((r) => setTimeout(r, 0))
    q.enqueue({ token: 'a', text: '1' })
    q.enqueue({ token: 'b', text: '2' })
    q.enqueue({ token: 'c', text: '3' }) // over cap → 'a' dropped
    expect(q.size).toBe(2)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(ran).toEqual(['first', 'b', 'c'])
  })

  it('default cap matches the design (~50)', () => {
    expect(PRESYNTH_MAX_PENDING).toBe(50)
  })

  it('a throwing job never propagates and does not stall the queue', async () => {
    const ran: string[] = []
    const logs: string[] = []
    const q = new PreSynthQueue({
      runJob: async (j) => {
        if (j.token === 'boom') throw new Error('synth exploded')
        ran.push(j.token)
      },
      defer: (fn) => fn(),
      log: (l) => void logs.push(l),
    })
    q.enqueue({ token: 'boom', text: 'x' })
    q.enqueue({ token: 'ok', text: 'y' })
    await new Promise((r) => setTimeout(r, 0))
    expect(ran).toEqual(['ok'])
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
    expect(q.busy).toBe(false)
  })
})

// ─── File persistence helpers ────────────────────────────────────────────────

describe('writeVoiceCacheFile', () => {
  it('writes atomically under the dir, creating it as needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-cache-'))
    try {
      const nested = join(dir, 'voice-cache')
      const audio = new Uint8Array([1, 2, 3, 4])
      const path = writeVoiceCacheFile(nested, 'tok1', audio)
      expect(path).toBe(voiceCacheFilePath(nested, 'tok1'))
      expect(existsSync(path)).toBe(true)
      expect(Array.from(readFileSync(path))).toEqual([1, 2, 3, 4])
      expect(existsSync(path + '.tmp')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── Sweep: TTL + size budget ────────────────────────────────────────────────

function makeFakeFs(files: Record<string, { mtimeMs: number; size: number }>): {
  fs: SweepFs
  deleted: string[]
} {
  const deleted: string[] = []
  const state = { ...files }
  return {
    deleted,
    fs: {
      readdirSync: () => Object.keys(state),
      statSync: (path: string) => {
        const name = path.split('/').pop()!
        const f = state[name]
        if (f == null) throw new Error('ENOENT')
        return { mtimeMs: f.mtimeMs, size: f.size, isFile: () => true }
      },
      unlinkSync: (path: string) => {
        const name = path.split('/').pop()!
        if (state[name] == null) throw new Error('ENOENT')
        delete state[name]
        deleted.push(name)
      },
    },
  }
}

describe('sweepVoiceCacheDir', () => {
  const NOW = 1_800_000_000_000
  const DAY = 24 * 60 * 60 * 1000

  it('deletes files older than 7 days and reports their tokens', () => {
    const { fs, deleted } = makeFakeFs({
      'old.ogg': { mtimeMs: NOW - 8 * DAY, size: 100 },
      'edge.ogg': { mtimeMs: NOW - VOICE_FILE_TTL_MS, size: 100 }, // exactly at cutoff → gone
      'fresh.ogg': { mtimeMs: NOW - 1 * DAY, size: 100 },
    })
    const result = sweepVoiceCacheDir({ dir: '/x', now: () => NOW, fs, log: () => {} })
    expect(deleted.sort()).toEqual(['edge.ogg', 'old.ogg'])
    expect(result.deletedTokens.sort()).toEqual(['edge', 'old'])
    expect(result.remainingBytes).toBe(100)
  })

  it('size budget: deletes oldest-first down to maxBytes even when fresh', () => {
    const { fs, deleted } = makeFakeFs({
      'a.ogg': { mtimeMs: NOW - 3 * DAY, size: 300 },
      'b.ogg': { mtimeMs: NOW - 2 * DAY, size: 300 },
      'c.ogg': { mtimeMs: NOW - 1 * DAY, size: 300 },
    })
    const result = sweepVoiceCacheDir({
      dir: '/x',
      now: () => NOW,
      fs,
      maxBytes: 650,
      log: () => {},
    })
    expect(deleted).toEqual(['a.ogg']) // oldest first, stop once under budget
    expect(result.remainingBytes).toBe(600)
  })

  it('missing dir is a no-op (crash-safe)', () => {
    const result = sweepVoiceCacheDir({
      dir: join(tmpdir(), 'definitely-not-there-' + Date.now()),
      log: () => {},
    })
    expect(result.deletedTokens).toEqual([])
    expect(result.remainingBytes).toBe(0)
  })

  it('a file vanishing mid-sweep (stat or unlink ENOENT) never aborts', () => {
    let statCalls = 0
    const fs: SweepFs = {
      readdirSync: () => ['gone.ogg', 'old.ogg'],
      statSync: (path: string) => {
        statCalls++
        if (path.endsWith('gone.ogg')) throw new Error('ENOENT')
        return { mtimeMs: NOW - 8 * DAY, size: 10, isFile: () => true }
      },
      unlinkSync: () => {
        throw new Error('ENOENT') // concurrent delete — tolerated
      },
    }
    const result = sweepVoiceCacheDir({ dir: '/x', now: () => NOW, fs, log: () => {} })
    expect(statCalls).toBe(2)
    expect(result.deletedTokens).toEqual(['old'])
  })

  it('real-fs end-to-end: TTL sweep removes old, keeps fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-sweep-'))
    try {
      const oldPath = join(dir, 'oldtok.ogg')
      const freshPath = join(dir, 'freshtok.ogg')
      writeFileSync(oldPath, 'old')
      writeFileSync(freshPath, 'fresh')
      const oldTime = (Date.now() - 8 * DAY) / 1000
      utimesSync(oldPath, oldTime, oldTime)
      const result = sweepVoiceCacheDir({ dir, log: () => {} })
      expect(result.deletedTokens).toEqual(['oldtok'])
      expect(existsSync(oldPath)).toBe(false)
      expect(existsSync(freshPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── Attach-vs-fallback decision + cache integration ────────────────────────

describe('attach-on-tap decision (gateway contract)', () => {
  /** Reproduces the exact gateway tap decision: pre-made file readable →
   *  attach; otherwise → lazy synth fallback. */
  function decideTap(entry: { filePath?: string } | null): 'expired' | 'attach' | 'lazy' {
    if (entry == null) return 'expired'
    if (entry.filePath != null) {
      try {
        readFileSync(entry.filePath)
        return 'attach'
      } catch {
        return 'lazy'
      }
    }
    return 'lazy'
  }

  it('attaches when the pre-made file exists and the entry is live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-attach-'))
    try {
      const cache = new VoiceOnDemandCache()
      cache.put('tok', { text: 'hello world', speed: 1.1 })
      const filePath = writeVoiceCacheFile(dir, 'tok', new Uint8Array([9, 9]))
      cache.setFilePath('tok', filePath)
      const entry = cache.get('tok')
      expect(entry?.filePath).toBe(filePath)
      expect(decideTap(entry)).toBe('attach')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to lazy when the file was swept from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-attach-'))
    try {
      const cache = new VoiceOnDemandCache()
      cache.put('tok', { text: 'hello', speed: 1.0 })
      const filePath = writeVoiceCacheFile(dir, 'tok', new Uint8Array([1]))
      cache.setFilePath('tok', filePath)
      rmSync(filePath) // sweep/crash took the file
      expect(decideTap(cache.get('tok'))).toBe('lazy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pre-feature entries (no filePath) take the lazy path', () => {
    const cache = new VoiceOnDemandCache()
    cache.put('tok', { text: 'hello', speed: 1.0 })
    const entry = cache.get('tok')
    expect(entry?.filePath).toBeUndefined()
    expect(decideTap(entry)).toBe('lazy')
  })

  it('expired entries degrade to the expired toast (7-day TTL)', () => {
    let nowMs = 1_000
    const cache = new VoiceOnDemandCache({ now: () => nowMs })
    cache.put('tok', { text: 'hello', speed: 1.0 })
    nowMs += VOICE_FILE_TTL_MS + 1 // > 7 days later
    expect(cache.get('tok')).toBeNull()
    expect(decideTap(cache.get('tok'))).toBe('expired')
  })

  it('setFilePath on an expired/evicted entry is a no-op', () => {
    let nowMs = 1_000
    const cache = new VoiceOnDemandCache({ now: () => nowMs })
    cache.put('tok', { text: 'hello', speed: 1.0 })
    nowMs += VOICE_FILE_TTL_MS + 1
    cache.setFilePath('tok', '/some/file.ogg') // must not resurrect
    expect(cache.get('tok')).toBeNull()
  })

  it('prune drops entries whose files the sweep deleted', () => {
    const cache = new VoiceOnDemandCache()
    cache.put('a', { text: 'x', speed: 1 })
    cache.put('b', { text: 'y', speed: 1 })
    cache.prune(['a', 'unknown-token'])
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).not.toBeNull()
  })

  it('filePath + createdAt survive the persistence round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-persist-'))
    try {
      const persistPath = join(dir, 'voice-ondemand.json')
      const c1 = new VoiceOnDemandCache({ persistPath })
      c1.put('tok', { text: 'hello', speed: 1.2 })
      c1.setFilePath('tok', '/state/voice-cache/tok.ogg')
      const c2 = new VoiceOnDemandCache({ persistPath })
      const entry = c2.get('tok')
      expect(entry?.filePath).toBe('/state/voice-cache/tok.ogg')
      // createdAt is persisted on the stored entry (sweep/introspection aid)
      // even though get() keeps it internal.
      const raw = JSON.parse(readFileSync(persistPath, 'utf8')) as {
        entries: Record<string, { createdAt?: number }>
      }
      expect(typeof raw.entries['tok']?.createdAt).toBe('number')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── End-to-end: queue → file → cache → sweep ───────────────────────────────

describe('pre-synth pipeline integration (no gateway import)', () => {
  it('a job writes the file, records it, and the sweep later prunes both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-e2e-'))
    try {
      const cacheDir = join(dir, 'voice-cache')
      mkdirSync(cacheDir, { recursive: true })
      const cache = new VoiceOnDemandCache()
      cache.put('tok', { text: 'spoken reply', speed: 1.1 })
      const q = new PreSynthQueue({
        // Mirrors the gateway runJob: fake sidecar → write → record.
        runJob: async (job: PreSynthJob) => {
          const audio = new TextEncoder().encode(`AUDIO:${job.text}`)
          const filePath = writeVoiceCacheFile(cacheDir, job.token, audio)
          cache.setFilePath(job.token, filePath)
        },
        defer: (fn) => fn(),
        log: () => {},
      })
      q.enqueue({ token: 'tok', text: 'spoken reply', speed: 1.1 })
      await new Promise((r) => setTimeout(r, 0))
      const entry = cache.get('tok')
      expect(entry?.filePath).toBeDefined()
      expect(readFileSync(entry!.filePath!, 'utf8')).toBe('AUDIO:spoken reply')

      // 8 days later the sweep removes the file and the entry is pruned.
      const DAY = 24 * 60 * 60 * 1000
      const result = sweepVoiceCacheDir({
        dir: cacheDir,
        now: () => Date.now() + 8 * DAY,
        log: () => {},
      })
      expect(result.deletedTokens).toEqual(['tok'])
      cache.prune(result.deletedTokens)
      expect(existsSync(entry!.filePath!)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
