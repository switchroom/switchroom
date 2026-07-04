/**
 * Eager voice pre-synthesis + rolling voice-cache cleanup (issue #2763).
 *
 * When an outbound reply becomes Listen-eligible (a voiceOnDemandCache entry
 * is persisted for its 🔊 Listen button), the gateway ALSO kicks an async
 * background synthesis of the normalized text via the LOCAL sidecar (kokoro
 * only — never the cloud engine, which costs money and stays lazy-only). The
 * resulting OGG lands on disk under TELEGRAM_STATE_DIR/voice-cache/ and its
 * path is recorded on the cache entry, so a Listen tap attaches the pre-made
 * file instantly instead of synthesizing on demand.
 *
 * This module owns the two dependency-free primitives:
 *
 *   - {@link PreSynthQueue} — a bounded FIFO (concurrency 1, drop-oldest past
 *     the backlog cap) so message bursts can't pile up GPU synth jobs.
 *   - {@link sweepVoiceCacheDir} — the 7-day TTL + size-budget sweep that
 *     keeps the voice-cache directory from growing unbounded.
 *
 * Kill switch: SWITCHROOM_DISABLE_EAGER_VOICE=1 reverts to lazy-only synth
 * (no pre-synth jobs, no new files). The sweep still runs under the kill
 * switch so previously written files age out.
 *
 * Strictly off the reply critical path: enqueue is a synchronous array push;
 * the drain is async and never awaited by the reply flow; every job failure
 * is swallowed (logged) — a synth failure can never affect message delivery.
 */

import { readdirSync, statSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'

/** Voice files older than this are deleted by the rolling sweep. */
export const VOICE_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Size budget for the voice-cache dir; oldest files are deleted first when
 *  the directory exceeds this (defence in depth if the timer dies and the
 *  boot sweep is far away). ~500MB per the #2763 design notes. */
export const VOICE_CACHE_MAX_BYTES = 500 * 1024 * 1024

/** Backlog cap for the pre-synth FIFO. Past this, the OLDEST pending job is
 *  dropped (newer replies are the ones the user is most likely to tap). */
export const PRESYNTH_MAX_PENDING = 50

/** Sweep cadence: hourly, plus one sweep at gateway boot. */
export const VOICE_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** True unless the operator flipped the kill switch. Same env shape as
 *  SWITCHROOM_DISABLE_TTS_NORMALIZE / SWITCHROOM_DISABLE_VOICE_SCRUB. */
export function eagerVoiceEnabled(): boolean {
  const kill = process.env.SWITCHROOM_DISABLE_EAGER_VOICE
  return !(kill === '1' || kill === 'true')
}

export type PreSynthJob = {
  /** Listen token — doubles as the on-disk filename stem (`<token>.ogg`). */
  token: string
  /** Speech-normalized text to synthesize (same payload the lazy path uses). */
  text: string
  voice?: string
  speed?: number
}

export type PreSynthQueueOptions = {
  /** Runs ONE job: synthesize + persist + record. Errors are swallowed. */
  runJob: (job: PreSynthJob) => Promise<void>
  maxPending?: number
  /** Injected scheduler (tests). Defaults to setTimeout(fn, 0). */
  defer?: (fn: () => void) => void
  log?: (line: string) => void
}

/**
 * Bounded FIFO pre-synth queue, concurrency 1. Jobs are drained strictly in
 * order; past `maxPending` queued jobs the oldest pending job is dropped
 * (drop-oldest). Enqueue is synchronous and never throws; the drain kicks off
 * via a deferred callback so the reply flow that enqueued is never blocked.
 */
export class PreSynthQueue {
  private readonly pending: PreSynthJob[] = []
  private running = false
  private readonly runJob: (job: PreSynthJob) => Promise<void>
  private readonly maxPending: number
  private readonly defer: (fn: () => void) => void
  private readonly log: (line: string) => void

  constructor(options: PreSynthQueueOptions) {
    this.runJob = options.runJob
    this.maxPending = options.maxPending ?? PRESYNTH_MAX_PENDING
    this.defer = options.defer ?? ((fn) => setTimeout(fn, 0))
    this.log = options.log ?? ((line) => process.stderr.write(line + '\n'))
  }

  /** Number of queued (not yet started) jobs — test/introspection aid. */
  get size(): number {
    return this.pending.length
  }

  /** True while a job is in flight. */
  get busy(): boolean {
    return this.running
  }

  /** Enqueue a job. Never throws; never blocks the caller. */
  enqueue(job: PreSynthJob): void {
    this.pending.push(job)
    while (this.pending.length > this.maxPending) {
      const dropped = this.pending.shift()
      if (dropped != null) {
        this.log(
          `voice-presynth: backlog over ${this.maxPending} — dropped oldest job token=${dropped.token}`,
        )
      }
    }
    if (!this.running) {
      this.running = true
      this.defer(() => void this.drain())
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const job = this.pending.shift()
      if (job == null) break
      try {
        await this.runJob(job)
      } catch (err) {
        // Best-effort by contract: a failed pre-synth only means the Listen
        // tap falls back to the lazy path. Never propagate.
        this.log(`voice-presynth: job failed token=${job.token}: ${String(err)}`)
      }
    }
    this.running = false
  }
}

/** Absolute path of the pre-synthesized file for a Listen token. */
export function voiceCacheFilePath(dir: string, token: string): string {
  return join(dir, `${token}.ogg`)
}

/** Atomically persist synthesized audio for `token` under `dir`; returns the
 *  final path. Throws on IO failure (caller — the queue runner — swallows). */
export function writeVoiceCacheFile(dir: string, token: string, audio: Uint8Array): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const final = voiceCacheFilePath(dir, token)
  const tmp = `${final}.tmp`
  writeFileSync(tmp, audio)
  renameSync(tmp, final)
  return final
}

/** Minimal fs facade so the sweep is testable without a real 500MB dir. */
export type SweepFs = {
  readdirSync: (dir: string) => string[]
  statSync: (path: string) => { mtimeMs: number; size: number; isFile(): boolean }
  unlinkSync: (path: string) => void
}

export type SweepOptions = {
  dir: string
  ttlMs?: number
  maxBytes?: number
  now?: () => number
  fs?: SweepFs
  log?: (line: string) => void
}

export type SweepResult = {
  /** Listen tokens whose files were deleted (filename stem, `.ogg` stripped) —
   *  the caller prunes the matching voiceOnDemandCache entries. */
  deletedTokens: string[]
  /** Total bytes remaining in the dir after the sweep. */
  remainingBytes: number
}

/**
 * Rolling voice-cache sweep: delete files older than `ttlMs` (7 days), then —
 * if the directory still exceeds `maxBytes` — delete oldest-first down to
 * budget. Crash-safe: a missing dir yields an empty result; a file that
 * vanishes mid-sweep (concurrent delete) is tolerated; per-file errors never
 * abort the sweep.
 */
export function sweepVoiceCacheDir(options: SweepOptions): SweepResult {
  const ttlMs = options.ttlMs ?? VOICE_FILE_TTL_MS
  const maxBytes = options.maxBytes ?? VOICE_CACHE_MAX_BYTES
  const now = options.now ?? Date.now
  const fsx: SweepFs = options.fs ?? { readdirSync, statSync, unlinkSync }
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'))

  let names: string[]
  try {
    names = fsx.readdirSync(options.dir)
  } catch {
    return { deletedTokens: [], remainingBytes: 0 } // no dir yet — nothing to sweep
  }

  type Entry = { name: string; path: string; mtimeMs: number; size: number }
  const files: Entry[] = []
  for (const name of names) {
    const path = join(options.dir, name)
    try {
      const st = fsx.statSync(path)
      if (!st.isFile()) continue
      files.push({ name, path, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // vanished mid-sweep / unreadable — skip, never abort
    }
  }

  const deletedTokens: string[] = []
  const cutoff = now() - ttlMs
  const remove = (f: Entry, reason: string): boolean => {
    try {
      fsx.unlinkSync(f.path)
    } catch {
      // Already gone (concurrent delete) — treat as removed either way; a
      // truly stuck file just gets retried next sweep.
    }
    deletedTokens.push(f.name.replace(/\.(ogg|ogg\.tmp)$/, ''))
    log(`voice-presynth: sweep removed ${f.name} (${reason})`)
    return true
  }

  // Pass 1 — TTL: anything older than 7 days goes (including orphaned .tmp).
  let kept: Entry[] = []
  for (const f of files) {
    if (f.mtimeMs <= cutoff) remove(f, 'ttl')
    else kept.push(f)
  }

  // Pass 2 — size budget: oldest-first down to maxBytes.
  let total = kept.reduce((sum, f) => sum + f.size, 0)
  if (total > maxBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
    while (total > maxBytes && kept.length > 0) {
      const oldest = kept.shift()!
      remove(oldest, 'size-budget')
      total -= oldest.size
    }
  }

  return { deletedTokens, remainingBytes: total }
}
