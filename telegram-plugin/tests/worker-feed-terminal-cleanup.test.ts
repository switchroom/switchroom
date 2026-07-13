/**
 * Integration guard for the worker-feed ghost-leak fix (PR #3226 review,
 * Finding 1). The unit tests in `worker-feed-coalesce.test.ts` call
 * `feed.terminate()` DIRECTLY — they prove the feed collapses/unpins when
 * asked, but they do NOT prove the two halves of the actual wire that was
 * broken:
 *
 *   (a) the subagent-watcher FIRES `onTerminalCleanup` from its authoritative
 *       `cleanupTerminalAgent` sweep — on BOTH the JSONL-vanished path
 *       (`onFileVanished` → `cleanupTerminalAgent`) AND the boot done-at-boot
 *       orphan path — the exact paths that never fire `onFinish`; and
 *   (b) wiring that callback to `workerActivityFeed.terminate` removes the row
 *       and collapses/unpins the shared card end-to-end.
 *
 * These drive the REAL `startSubagentWatcher` (with a mock fs) wired to a REAL
 * `createWorkerActivityFeed` exactly as the gateway wires them
 * (`onTerminalCleanup: (id) => feed.terminate(id)`). If a future refactor drops
 * the `config.onTerminalCleanup(agentId)` call in `cleanupTerminalAgent`, the
 * callback never fires, the feed row survives, and these go RED — the
 * regression the divergence-based leak represented.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'
import {
  createWorkerActivityFeed,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
} from '../worker-activity-feed.js'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
const subAgentUserMsg = (t: string) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } })
const subAgentTurnEnd = () => ({ type: 'system', subtype: 'turn_duration', duration_ms: 100 })

function view(desc: string, step: string, elapsedMs: number): WorkerActivityView {
  return { description: desc, lastTool: null, toolCount: 2, latestSummary: step, elapsedMs, state: 'running' }
}

/** A real feed with a fake bot + reconcilePin capture, driven off `now`. */
function makeFeed(now: () => number) {
  const sends: { text: string }[] = []
  const edits: { messageId: number; text: string }[] = []
  const pins: { messageId: number | null }[] = []
  let seq = 700
  const bot: BotApiForWorkerFeed = {
    sendMessage: async (_c, text) => {
      sends.push({ text })
      return { message_id: seq++ }
    },
    editMessageText: async (_c, messageId, text) => {
      edits.push({ messageId, text })
      return true
    },
  }
  const feed = createWorkerActivityFeed({
    bot,
    now,
    minEditIntervalMs: 0,
    heartbeatTickMs: 1000,
    firstPaintMinMs: 0,
    setInterval: () => 0,
    clearInterval: () => {},
    reconcilePin: ({ messageId }) => pins.push({ messageId }),
  })
  return { feed, sends, edits, pins }
}
async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r))
}

/**
 * A mock fs over a single subagents dir with one worker JSONL. `vanished`
 * flips the file-read calls to throw ENOENT (Claude Code reaped the parent
 * session's `subagents/` dir) to exercise the vanished terminal path.
 */
function mockWatcherFs(opts: {
  agentDir: string
  fileName: string
  content: Buffer
  vanished: () => boolean
}) {
  const projectsRoot = `${opts.agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/sess`
  const subagentsDir = `${sessionDir}/subagents`
  const filePath = `${subagentsDir}/${opts.fileName}`
  let lastOpened: string | null = null
  const enoent = (): never => {
    const e = new Error('ENOENT') as NodeJS.ErrnoException
    e.code = 'ENOENT'
    throw e
  }
  const mock = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir) return true
      return ps === filePath && !opts.vanished()
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot) return ['mock-cwd']
      if (ps === projectDir) return ['sess']
      if (ps === sessionDir) return ['subagents']
      if (ps === subagentsDir) return opts.vanished() ? [] : [opts.fileName]
      return []
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) => {
      if (opts.vanished()) return enoent()
      return { size: opts.content.length, mtimeMs: 0 } as fs.Stats
    }) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => {
      if (opts.vanished()) return enoent()
      lastOpened = String(p)
      return 7
    }) as unknown as typeof fs.openSync,
    closeSync: (() => { lastOpened = null }) as typeof fs.closeSync,
    readSync: ((_fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null): number => {
      if (opts.vanished() || lastOpened == null) return 0
      const src = opts.content.slice(position ?? 0, (position ?? 0) + length)
      src.copy(buf as Buffer, offset)
      return src.length
    }) as unknown as typeof fs.readSync,
    watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
  }
  return { mock, filePath }
}

/** Deterministic clock + injectable timers shared by watcher + feed. */
function makeClock() {
  let currentTime = 1_000_000
  const intervals: Array<{ fn: () => void; ms: number; fireAt: number }> = []
  const timeouts: Array<{ fn: () => void; fireAt: number; ref: number }> = []
  let nextRef = 1
  const now = () => currentTime
  const advance = (ms: number): void => {
    currentTime += ms
    for (;;) {
      timeouts.sort((a, b) => a.fireAt - b.fireAt)
      const next = timeouts[0]
      if (!next || next.fireAt > currentTime) break
      timeouts.shift()
      next.fn()
    }
    for (const iv of intervals) {
      while (iv.fireAt <= currentTime) {
        iv.fn()
        iv.fireAt += iv.ms
      }
    }
  }
  const timers = {
    setInterval: (fn: () => void, ms: number) => {
      intervals.push({ fn, ms, fireAt: currentTime + ms })
      return { ref: 0 }
    },
    clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => {
      const ref = nextRef++
      timeouts.push({ fn, fireAt: currentTime + ms, ref })
      return { ref }
    },
    clearTimeout: (handle: { ref: number }) => {
      const idx = timeouts.findIndex((t) => t.ref === handle.ref)
      if (idx !== -1) timeouts.splice(idx, 1)
    },
  }
  return { now, advance, timers }
}

describe('worker-feed ghost-leak — watcher terminal sweep → feed removal (integration)', () => {
  it('boot done-at-boot orphan: cleanupTerminalAgent fires onTerminalCleanup → feed row removed, card collapsed + unpinned', async () => {
    const agentDir = '/home/user/.switchroom/agents/x'
    const { now, advance, timers } = makeClock()
    const { feed, pins } = makeFeed(now)

    // The worker was live in the feed (its progress had surfaced there).
    await feed.update('boot1', 'chat', view('task boot1', 'reading', 0))
    await drain()
    expect(feed.size).toBe(1)
    expect(pins.at(-1)?.messageId).not.toBeNull() // pinned

    const { mock } = mockWatcherFs({
      agentDir,
      fileName: 'agent-boot1.jsonl',
      // Already `done` at boot (turn_end present) → registerAgent schedules a
      // terminal cleanup with NO onFinish (the boot-orphan bypass path).
      content: Buffer.from(buildJSONL(subAgentUserMsg('done task'), subAgentTurnEnd()), 'utf-8'),
      vanished: () => false,
    })
    const watcher = startSubagentWatcher({
      agentDir,
      fs: mock,
      now,
      // Wire EXACTLY as the gateway does.
      onTerminalCleanup: (agentId) => { void feed.terminate(agentId) },
      ...timers,
    })
    expect(watcher.getRegistry().has('boot1')).toBe(true)

    // Fire the scheduled terminal cleanup (30s grace) → onTerminalCleanup.
    advance(30_000)
    await drain()

    expect(feed.size).toBe(0)                        // row removed by the sweep
    expect(pins.at(-1)?.messageId).toBeNull()        // card collapsed + UNPINNED
    watcher.stop()
  })

  it('JSONL-vanished path: onFileVanished → cleanupTerminalAgent → onTerminalCleanup → feed row removed + unpinned', async () => {
    const agentDir = '/home/user/.switchroom/agents/y'
    const { now, advance, timers } = makeClock()
    const { feed, pins } = makeFeed(now)

    await feed.update('van1', 'chat', view('task van1', 'running a command', 0))
    await drain()
    expect(feed.size).toBe(1)

    let vanished = false
    const { mock } = mockWatcherFs({
      agentDir,
      fileName: 'agent-van1.jsonl',
      // Running at boot (no turn_end) — stays registered; the poll loop reads
      // it defensively, so when the file vanishes the read throws ENOENT and
      // the watcher takes onFileVanished → cleanupTerminalAgent.
      content: Buffer.from(buildJSONL(subAgentUserMsg('long task')), 'utf-8'),
      vanished: () => vanished,
    })
    const captured: string[] = []
    const watcher = startSubagentWatcher({
      agentDir,
      fs: mock,
      now,
      onTerminalCleanup: (agentId) => {
        captured.push(agentId)
        void feed.terminate(agentId)
      },
      ...timers,
    })
    expect(watcher.getRegistry().has('van1')).toBe(true)

    // The parent session ends → Claude Code reaps subagents/ → next poll read
    // hits ENOENT.
    vanished = true
    advance(2_000) // drive the rescan/poll interval
    await drain()

    expect(captured).toContain('van1')               // vanished path funnels here
    expect(feed.size).toBe(0)                         // wired removal happened
    expect(pins.at(-1)?.messageId).toBeNull()         // unpinned
    watcher.stop()
  })
})
