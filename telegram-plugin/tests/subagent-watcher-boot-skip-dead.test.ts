/**
 * Boot-reconcile perf regression: at boot the subagent-watcher must NOT do the
 * full initial `readSubTail` (a whole-transcript parse + per-record sqlite
 * liveness/backfill round-trips) for provably-dead prior-session workers.
 *
 * Production incident (2026-07-19): on a busy 24/7 agent ~1177 dead `running`
 * JSONLs (last written days-to-weeks ago) each got the full register → whole-
 * file read → liveness/backfill → staleness → FSWatcher-decision treatment on
 * every boot. On a slow disk that O(filesize) work delayed the gateway
 * answering Telegram by ~7 minutes after each restart, so the agent looked
 * dead. The staleness verdict (`last write > inflightPromoteMaxAgeMs`) was
 * already reached, but only AFTER the expensive read.
 *
 * The fix replaces the full read for a stale-by-mtime historical entry with a
 * BOUNDED TAIL PROBE. Outcomes asserted here (not code paths):
 *   1. running-at-boot-stale (no turn_end): registered historical, NO watcher,
 *      NOT swept (nothing terminal to sweep), and the disk read is bounded to
 *      the tail window even for a huge file (never a byte-0 whole-transcript
 *      read).
 *   2. done-at-boot-stale (turn_end present): still reaches terminal cleanup —
 *      `onTerminalCleanup` fires after the grace window so the worker-feed row
 *      is swept (the regression the coordinator caught: a done-at-boot orphan
 *      must NOT be silently left as a ghost feed row).
 *   3. fresh in-flight-at-boot: takes the full path — its JSONL IS read from
 *      byte 0 and it DOES get a per-file FSWatcher (no over-pruning).
 */

import { describe, it, expect, vi } from 'vitest'
import type * as fs from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'

interface FakeWatcher { path: string; close: ReturnType<typeof vi.fn> }
interface ReadCall { position: number; length: number }

const AGENT_DIR = '/home/user/.switchroom/agents/myagent'
const PROJECTS = `${AGENT_DIR}/.claude/projects`
const PROJECT = `${PROJECTS}/proj`
const SESSION = `${PROJECT}/sess`
const SUBAGENTS = `${SESSION}/subagents`
const NOW = 100_000_000

const turnEndLine = () => JSON.stringify({ type: 'system', subtype: 'turn_duration', duration_ms: 100 })
const toolUseLine = () =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } })

/**
 * Harness with per-path read tracking (position + length of every readSync, the
 * proxy for "how much of the transcript did boot read") and FSWatcher tracking.
 * `reportedSize` can far exceed the synthetic tail content, so a test can assert
 * that only the tail window — not the whole (huge) file — was read.
 */
function makeHarness(opts: {
  fileName: string
  ageMs: number
  reportedSize: number
  /** Synthetic bytes returned when the file is read (represents its tail). */
  tail: Buffer
}) {
  const jsonl = `${SUBAGENTS}/${opts.fileName}`
  const reads: ReadCall[] = []
  const watchers: FakeWatcher[] = []
  const timeouts: Array<{ fn: () => void; fireAt: number; ref: number }> = []
  const terminalCleanups: string[] = []
  let currentTime = NOW
  let nextRef = 1

  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      return ps === PROJECTS || ps === PROJECT || ps === SESSION || ps === SUBAGENTS || ps === jsonl
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === PROJECTS) return ['proj']
      if (ps === PROJECT) return ['sess']
      if (ps === SESSION) return ['subagents']
      if (ps === SUBAGENTS) return [opts.fileName]
      return []
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) => {
      if (String(p) !== jsonl) return { size: 0, mtimeMs: currentTime } as fs.Stats
      return { size: opts.reportedSize, mtimeMs: currentTime - opts.ageMs } as fs.Stats
    }) as typeof fs.statSync,
    openSync: (() => 7) as unknown as typeof fs.openSync,
    closeSync: (() => undefined) as typeof fs.closeSync,
    readSync: ((
      _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
    ): number => {
      reads.push({ position: position ?? 0, length })
      const src = opts.tail.subarray(0, Math.min(length, opts.tail.length))
      src.copy(buf as Buffer, offset)
      return src.length
    }) as unknown as typeof fs.readSync,
    watch: ((p: fs.PathLike) => {
      const w: FakeWatcher = { path: String(p), close: vi.fn() }
      watchers.push(w)
      return w as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch,
  }

  const watcher = startSubagentWatcher({
    agentDir: AGENT_DIR,
    fs: mockFs,
    now: () => currentTime,
    setInterval: () => ({ ref: 0 }),
    clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => {
      const ref = nextRef++
      timeouts.push({ fn, fireAt: currentTime + ms, ref })
      return { ref }
    },
    clearTimeout: (handle) => {
      const { ref } = handle as { ref: number }
      const idx = timeouts.findIndex((t) => t.ref === ref)
      if (idx !== -1) timeouts.splice(idx, 1)
    },
    onTerminalCleanup: (agentId: string) => { terminalCleanups.push(agentId) },
  })

  const advance = (ms: number): void => {
    currentTime += ms
    for (;;) {
      timeouts.sort((a, b) => a.fireAt - b.fireAt)
      const next = timeouts[0]
      if (!next || next.fireAt > currentTime) break
      timeouts.shift()
      next.fn()
    }
  }

  return {
    watcher,
    reads,
    advance,
    terminalCleanups,
    jsonl,
    fileWatchers: () => watchers.filter((w) => w.path === jsonl),
  }
}

describe('subagent-watcher boot reconcile: skip full read for dead prior-session workers', () => {
  it('running-at-boot-stale: historical, no watcher, bounded tail read (not whole transcript), not swept', () => {
    const agentId = 'deadrunning'
    // A huge (50 MB) JSONL last written 3 days ago whose tail has NO turn_end.
    const tail = Buffer.from(`${toolUseLine()}\n${toolUseLine()}\n${toolUseLine()}\n`, 'utf-8')
    const h = makeHarness({
      fileName: `agent-${agentId}.jsonl`,
      ageMs: 3 * 24 * 3600_000,
      reportedSize: 50_000_000,
      tail,
    })

    const entry = h.watcher.getRegistry().get(agentId)
    expect(entry?.historical).toBe(true)
    expect(entry?.state).toBe('running')             // never promoted, never done
    expect(h.fileWatchers()).toHaveLength(0)          // no FD leak for a dead worker
    expect(h.terminalCleanups).not.toContain(agentId) // nothing terminal to sweep

    // The disk read was BOUNDED to the tail window — the 50 MB file was NEVER
    // read from byte 0 (that whole-transcript read is the ~7-min boot cost).
    expect(h.reads.length).toBeGreaterThan(0)
    for (const r of h.reads) {
      expect(r.position).toBeGreaterThan(0)           // tail offset, not byte 0
      expect(r.length).toBeLessThanOrEqual(512 * 1024)
    }

    h.watcher.stop()
  })

  it('done-at-boot-stale: still reaches terminal cleanup (onTerminalCleanup fires → feed row swept)', () => {
    const agentId = 'deaddone'
    // A stale JSONL whose tail ends in a turn_duration line → done at boot.
    const tail = Buffer.from(`${toolUseLine()}\n${turnEndLine()}\n`, 'utf-8')
    const h = makeHarness({
      fileName: `agent-${agentId}.jsonl`,
      ageMs: 3 * 24 * 3600_000,
      reportedSize: 50_000_000,
      tail,
    })

    const entry = h.watcher.getRegistry().get(agentId)
    expect(entry?.historical).toBe(true)
    expect(entry?.state).toBe('done')                 // detected terminal via the probe
    expect(h.fileWatchers()).toHaveLength(0)           // no watcher for a done-at-boot worker
    expect(h.terminalCleanups).toHaveLength(0)         // not yet — waits out the grace window

    // Fire the scheduled terminal cleanup (30s grace) → onTerminalCleanup so the
    // gateway sweeps the ghost feed row. THIS is the regression guard.
    h.advance(30_000)
    expect(h.terminalCleanups).toContain(agentId)

    // Still bounded — the probe read only the tail, never the whole 50 MB file.
    for (const r of h.reads) {
      expect(r.position).toBeGreaterThan(0)
      expect(r.length).toBeLessThanOrEqual(512 * 1024)
    }

    h.watcher.stop()
  })

  it('fresh in-flight-at-boot: full path — read from byte 0 and given an FSWatcher (no over-pruning)', () => {
    const agentId = 'liveone'
    const tail = Buffer.from(`${toolUseLine()}\n`, 'utf-8')
    const h = makeHarness({
      fileName: `agent-${agentId}.jsonl`,
      ageMs: 30_000,                                  // 30s old — inside the freshness window
      reportedSize: tail.length,
      tail,
    })

    // Full path: the JSONL is read from byte 0 (the whole transcript) and a
    // per-file FSWatcher is opened so live transitions are observed.
    expect(h.reads.some((r) => r.position === 0)).toBe(true)
    expect(h.fileWatchers()).toHaveLength(1)

    h.watcher.stop()
  })
})
