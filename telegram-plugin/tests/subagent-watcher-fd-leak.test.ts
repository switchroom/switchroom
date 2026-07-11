/**
 * FD-leak regression tests for the subagent-watcher (review findings H1 + H2).
 *
 * H1 — directory FSWatchers were only ever closed in the global stop(). When a
 *      Claude session's `subagents/` dir was reaped, the rescan loop skipped
 *      the vanished path without closing its watcher, so every session leaked
 *      one inotify FD for the gateway's lifetime.
 *
 * H2 — every boot-scanned file opened a per-file FSWatcher unconditionally,
 *      including stale historical `running` entries that `checkStalls` skips
 *      and that therefore never reach terminal cleanup — leaking their FD until
 *      the file happened to vanish.
 *
 * Each test FAILS on pre-fix code (an unclosed / never-opened-guarded watcher)
 * and PASSES with the runtime-close / open-gating fix.
 */

import { describe, it, expect, vi } from 'vitest'
import type * as fs from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'

interface FakeWatcher {
  path: string
  close: ReturnType<typeof vi.fn>
  closed: boolean
}

/**
 * Minimal watcher harness with a MUTABLE fake filesystem (so a test can make a
 * directory or file vanish mid-run) and per-watcher path tracking (so we can
 * assert exactly which watchers were opened / closed).
 */
function makeHarness(opts: {
  agentDir?: string
  dirs: Record<string, string[]>
  fileSizes?: Record<string, number>
  rescanMs?: number
}) {
  const agentDir = opts.agentDir ?? '/home/user/.switchroom/agents/myagent'
  const rescanMs = opts.rescanMs ?? 500
  const dirs = new Map<string, string[]>(Object.entries(opts.dirs))
  const fileSizes = new Map<string, number>(Object.entries(opts.fileSizes ?? {}))
  const logs: string[] = []
  const watchers: FakeWatcher[] = []
  let currentTime = 1_000_000

  const existsSync = ((p: fs.PathLike) => {
    const ps = String(p)
    return dirs.has(ps) || fileSizes.has(ps)
  }) as typeof fs.existsSync

  const mockFs = {
    existsSync,
    readdirSync: ((p: fs.PathLike) => dirs.get(String(p)) ?? []) as unknown as typeof fs.readdirSync,
    // No mtimeMs → boot-promotion freshness gate treats a running file as
    // stale (dead prior-session worker), so it stays historical + unpromoted.
    statSync: ((p: fs.PathLike) => ({ size: fileSizes.get(String(p)) ?? 0 }) as fs.Stats) as typeof fs.statSync,
    openSync: (() => 42) as unknown as typeof fs.openSync,
    closeSync: (() => undefined) as typeof fs.closeSync,
    readSync: (() => 0) as unknown as typeof fs.readSync,
    watch: ((p: fs.PathLike) => {
      const w: FakeWatcher = {
        path: String(p),
        closed: false,
        close: vi.fn(() => { w.closed = true }),
      }
      watchers.push(w)
      return w as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch,
  }

  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  const timeouts: Array<{ fn: () => void; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    onFinish: () => {},
    stallThresholdMs: 60_000,
    silentSynthesisStallThresholdMs: 60_000,
    rescanMs,
    now: () => currentTime,
    setInterval: (fn, ms) => {
      const ref = nextRef++
      intervals.push({ fn, ms, ref, fireAt: currentTime + ms })
      return { ref }
    },
    clearInterval: (handle) => {
      const { ref } = handle as { ref: number }
      const idx = intervals.findIndex((i) => i.ref === ref)
      if (idx !== -1) intervals.splice(idx, 1)
    },
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timeouts.push({ fn, ref, fireAt: currentTime + ms })
      return { ref }
    },
    clearTimeout: (handle) => {
      const { ref } = handle as { ref: number }
      const idx = timeouts.findIndex((t) => t.ref === ref)
      if (idx !== -1) timeouts.splice(idx, 1)
    },
    fs: mockFs,
    log: (msg: string) => { logs.push(msg) },
  })

  const poll = (): void => {
    // intervals[0] is the poll loop (registered first — see startSubagentWatcher).
    intervals[0]?.fn()
  }

  return {
    watcher,
    watchers,
    logs,
    dirs,
    fileSizes,
    poll,
    fileWatchers: () => watchers.filter((w) => w.path.endsWith('.jsonl')),
    dirWatchersFor: (p: string) => watchers.filter((w) => w.path === p),
  }
}

const PROJECTS = '/home/user/.switchroom/agents/myagent/.claude/projects'

describe('subagent-watcher FD-leak (H1): dir watchers close when their session dir vanishes', () => {
  it('closes and forgets the subagents-dir FSWatcher after the session dir is reaped', () => {
    const projectDir = `${PROJECTS}/myproject`
    const sessionDir = `${projectDir}/session-A`
    const subagentsDir = `${sessionDir}/subagents`

    const h = makeHarness({
      dirs: {
        [PROJECTS]: ['myproject'],
        [projectDir]: ['session-A'],
        [sessionDir]: ['subagents'],
        [subagentsDir]: [], // empty subagents dir — still gets a dir watcher
      },
    })

    // Boot scan already ran in the constructor; poll once to be certain the
    // dir watcher for the subagents dir has been opened.
    h.poll()
    const dw = h.dirWatchersFor(subagentsDir)
    expect(dw).toHaveLength(1)
    expect(dw[0].closed).toBe(false)

    // Claude Code reaps the whole session directory (session rotation).
    h.dirs.delete(sessionDir)
    h.dirs.delete(subagentsDir)
    h.dirs.set(projectDir, []) // session-A gone from the project listing

    // Next rescan tick must release the now-dangling dir watcher.
    h.poll()

    expect(dw[0].close).toHaveBeenCalledTimes(1)
    expect(dw[0].closed).toBe(true)

    h.watcher.stop()
  })
})

describe('subagent-watcher FD-leak (H2): no per-file watcher for stale historical running entries', () => {
  it('does not open an FSWatcher for a boot-discovered stale running JSONL', () => {
    const projectDir = `${PROJECTS}/myproject`
    const sessionDir = `${projectDir}/session-A`
    const subagentsDir = `${sessionDir}/subagents`
    const staleFile = `${subagentsDir}/agent-deadbeef.jsonl`

    const h = makeHarness({
      dirs: {
        [PROJECTS]: ['myproject'],
        [projectDir]: ['session-A'],
        [sessionDir]: ['subagents'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      // size 0 + no mtimeMs → registers as a stale historical `running` entry
      // that will never be promoted and never reach terminal cleanup.
      fileSizes: { [staleFile]: 0 },
    })

    h.poll()

    // A dir watcher for the subagents dir is fine. What must NOT happen is a
    // per-file (.jsonl) watcher for a stale historical running entry that
    // would leak forever.
    const fileWatchersForStale = h.fileWatchers().filter((w) => w.path === staleFile)
    expect(fileWatchersForStale).toHaveLength(0)

    h.watcher.stop()
  })
})
