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

  // Positive direction of the H2 gate: the open-guard is `!entry.historical ||
  // entry.bootPromotionPending != null`, so the negative test above (no watcher
  // for a stale boot entry) must be balanced by proof the guard does NOT
  // over-prune a genuinely LIVE worker. A file that first appears AFTER the boot
  // scan is non-historical (`bootScanInProgress` is already false), so it is a
  // live worker the user is awaiting and MUST get its own per-file FSWatcher —
  // otherwise its tool-call / turn_end transitions would be invisible until the
  // 1s defensive poll happened to catch them. Reviewer verified this by code-
  // reading only; this test locks it in.
  it('opens a per-file FSWatcher for a live (post-boot, non-historical) worker JSONL', () => {
    const projectDir = `${PROJECTS}/myproject`
    const sessionDir = `${projectDir}/session-A`
    const subagentsDir = `${sessionDir}/subagents`
    const liveFile = `${subagentsDir}/agent-live01.jsonl`

    const h = makeHarness({
      dirs: {
        [PROJECTS]: ['myproject'],
        [projectDir]: ['session-A'],
        [sessionDir]: ['subagents'],
        [subagentsDir]: [], // empty at boot → nothing marked historical
      },
    })

    // Boot scan already ran (constructor) over the empty dir; poll once so the
    // dir watcher for the subagents dir is definitely established.
    h.poll()
    expect(h.fileWatchers()).toHaveLength(0) // nothing to watch yet

    // A brand-new worker dispatches AFTER boot: its JSONL appears now. Because
    // bootScanInProgress is already false, scanSubagentsDir does NOT mark it
    // historical → it registers as a live running entry.
    h.dirs.set(subagentsDir, ['agent-live01.jsonl'])
    h.fileSizes.set(liveFile, 24)

    h.poll()

    const fileWatchersForLive = h.fileWatchers().filter((w) => w.path === liveFile)
    expect(fileWatchersForLive).toHaveLength(1)
    expect(fileWatchersForLive[0].closed).toBe(false)

    h.watcher.stop()
    // stop() must close the live watcher it opened (no leak on shutdown).
    expect(fileWatchersForLive[0].closed).toBe(true)
  })
})

describe('subagent-watcher FD-leak (H1): a still-present session dir keeps its watcher across rescans', () => {
  it('does NOT prune the dir watcher for a directory that is still present', () => {
    const projectDir = `${PROJECTS}/myproject`
    const sessionDir = `${projectDir}/session-A`
    const subagentsDir = `${sessionDir}/subagents`

    const h = makeHarness({
      dirs: {
        [PROJECTS]: ['myproject'],
        [projectDir]: ['session-A'],
        [sessionDir]: ['subagents'],
        [subagentsDir]: [], // present + empty — gets a dir watcher, stays present
      },
    })

    h.poll()
    const dw = h.dirWatchersFor(subagentsDir)
    expect(dw).toHaveLength(1)
    expect(dw[0].closed).toBe(false)

    // The session dir never vanishes. Several rescan ticks pass. The complement
    // of the H1 close-on-vanish test: pruneVanishedDirWatchers must leave a
    // still-existing dir's watcher untouched, and the `if (!dirWatchers.has(...))`
    // guard must NOT open a duplicate watcher for the same dir on each rescan.
    h.poll()
    h.poll()
    h.poll()

    expect(dw[0].close).not.toHaveBeenCalled()
    expect(dw[0].closed).toBe(false)
    // Exactly one dir watcher for this path across all the rescans — no churn.
    expect(h.dirWatchersFor(subagentsDir)).toHaveLength(1)

    h.watcher.stop()
  })
})
