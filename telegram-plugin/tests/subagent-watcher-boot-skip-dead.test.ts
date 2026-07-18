/**
 * Boot-reconcile perf regression: a provably-dead prior-session worker present
 * at boot must be recognised as historical CHEAPLY — no full `readSubTail`
 * (whole-transcript parse + per-record sqlite liveness/backfill), no FSWatcher.
 *
 * Production incident (2026-07-19): on a busy 24/7 agent ~1177 dead `running`
 * JSONLs (last written days-to-weeks ago) each got the full register → initial
 * read → liveness/backfill → staleness → FSWatcher-decision treatment on every
 * boot. On a slow disk that O(n) work delayed the gateway answering Telegram by
 * ~7 minutes after each restart, so the agent looked dead. The staleness verdict
 * (`last write > inflightPromoteMaxAgeMs`) was already reached, but only AFTER
 * the expensive read. The fix moves that same age check ahead of the read.
 *
 * Outcome asserted (not code path): for a stale worker the JSONL is NEVER
 * opened (`openSync` count == 0) and NO per-file FSWatcher is created; a
 * genuinely fresh in-flight-at-boot worker still IS read and DOES get promoted
 * with a watcher. Same `inflightPromoteMaxAgeMs` threshold decides both.
 */

import { describe, it, expect, vi } from 'vitest'
import type * as fs from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'

interface FakeWatcher { path: string; close: ReturnType<typeof vi.fn> }

const AGENT_DIR = '/home/user/.switchroom/agents/myagent'
const PROJECTS = `${AGENT_DIR}/.claude/projects`
const PROJECT = `${PROJECTS}/proj`
const SESSION = `${PROJECT}/sess`
const SUBAGENTS = `${SESSION}/subagents`

/**
 * Harness with a per-path `openSync` counter (proxy for "the expensive initial
 * read ran") and per-path FSWatcher tracking. mtime is configurable per file so
 * a test can place a worker inside or outside the freshness window.
 */
function makeHarness(opts: {
  files: Record<string, { size: number; ageMs: number }>
  dirListing: string[]
}) {
  const NOW = 100_000_000
  const opens = new Map<string, number>()
  const watchers: FakeWatcher[] = []
  const files = new Map(Object.entries(opts.files))

  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      return ps === PROJECTS || ps === PROJECT || ps === SESSION || ps === SUBAGENTS || files.has(ps)
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === PROJECTS) return ['proj']
      if (ps === PROJECT) return ['sess']
      if (ps === SESSION) return ['subagents']
      if (ps === SUBAGENTS) return opts.dirListing
      return []
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) => {
      const f = files.get(String(p))
      return { size: f?.size ?? 0, mtimeMs: f ? NOW - f.ageMs : NOW } as fs.Stats
    }) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => {
      const ps = String(p)
      opens.set(ps, (opens.get(ps) ?? 0) + 1)
      return 7
    }) as unknown as typeof fs.openSync,
    closeSync: (() => undefined) as typeof fs.closeSync,
    // EOF immediately — the read itself is a no-op; we only care that the file
    // was OPENED at all (openSync count), which is the reconcile-read signal.
    readSync: (() => 0) as unknown as typeof fs.readSync,
    watch: ((p: fs.PathLike) => {
      const w: FakeWatcher = { path: String(p), close: vi.fn() }
      watchers.push(w)
      return w as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch,
  }

  const watcher = startSubagentWatcher({
    agentDir: AGENT_DIR,
    fs: mockFs,
    now: () => NOW,
    setInterval: () => ({ ref: 0 }),
    clearInterval: () => {},
    setTimeout: () => ({ ref: 0 }),
    clearTimeout: () => {},
  })

  return {
    watcher,
    opensFor: (p: string) => opens.get(p) ?? 0,
    fileWatchersFor: (p: string) => watchers.filter((w) => w.path === p),
  }
}

describe('subagent-watcher boot reconcile: skip provably-dead prior-session workers', () => {
  it('does NOT open (read) or watch a stale historical running JSONL at boot', () => {
    const agentId = 'deadbeef'
    const jsonl = `${SUBAGENTS}/agent-${agentId}.jsonl`

    // Last write 3 days ago — far past the 15-min default freshness window.
    const h = makeHarness({
      dirListing: [`agent-${agentId}.jsonl`],
      files: { [jsonl]: { size: 4096, ageMs: 3 * 24 * 3600_000 } },
    })

    // The dead worker is registered but as an inert historical entry...
    const entry = h.watcher.getRegistry().get(agentId)
    expect(entry?.historical).toBe(true)
    // ...with the expensive reconcile skipped: the JSONL was never opened,
    // and no per-file FSWatcher leaked.
    expect(h.opensFor(jsonl)).toBe(0)
    expect(h.fileWatchersFor(jsonl)).toHaveLength(0)

    h.watcher.stop()
  })

  it('still reads AND watches a fresh in-flight-at-boot worker (no over-pruning)', () => {
    const agentId = 'liveone'
    const jsonl = `${SUBAGENTS}/agent-${agentId}.jsonl`

    // Last write 30s ago — well inside the freshness window: a genuine
    // in-flight-across-restart worker the user is still awaiting.
    const h = makeHarness({
      dirListing: [`agent-${agentId}.jsonl`],
      files: { [jsonl]: { size: 4096, ageMs: 30_000 } },
    })

    // The fresh worker takes the full path: its JSONL IS opened (reconcile
    // read ran) and it gets a per-file FSWatcher so its transitions are seen.
    expect(h.opensFor(jsonl)).toBeGreaterThan(0)
    expect(h.fileWatchersFor(jsonl)).toHaveLength(1)

    h.watcher.stop()
  })
})
