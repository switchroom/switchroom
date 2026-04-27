/**
 * Unit tests for the subagent-watcher module.
 *
 * Covers (post-#142):
 *   - Registry transitions (register, tool_use, turn_end)
 *   - JSONL tail parsing (description from sub_agent_text, toolCount from sub_agent_tool_use)
 *   - Stall detection (stall notification after stallThresholdMs idle)
 *   - Completion notification (sent once on state=done)
 *
 * #142 deleted the per-dispatch "Worker dispatched" reply and the pinned
 * "🔧 Background workers" card — those duplicated information already
 * shown in the main progress card's in-card `[Sub-agents · N running]`
 * block, which now stays alive past parent turn-end via the driver's
 * pendingCompletion gate (see progress-card-driver.test.ts:1347+ for the
 * locked contract).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher } from '../subagent-watcher.js'

// ─── startSubagentWatcher harness ────────────────────────────────────────────

/**
 * Minimal harness to drive the watcher without real filesystem or timers.
 *
 * We mock:
 *  - fs.existsSync, fs.readdirSync → control which dirs/files are "on disk"
 *  - fs.statSync → control file sizes (drives JSONL read)
 *  - fs.openSync, fs.readSync, fs.closeSync → feed JSONL content
 *  - fs.watch → stub (returns a fake watcher)
 *  - Date.now → injected via config.now
 *  - setInterval / clearInterval → injected via config
 */

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}

function subAgentAssistantText(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }
}

function subAgentToolUse(name: string, id: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input: {} }] },
  }
}

function subAgentTurnDuration() {
  return { type: 'system', subtype: 'turn_duration', durationMs: 5000 }
}

interface WatcherHarness {
  notifications: string[]
  advance: (ms: number) => void
  // Trigger the poll timer manually
  poll: () => void
  // Expose the watcher
  watcher: ReturnType<typeof startSubagentWatcher>
  // Current mocked time
  now: () => number
  // Mutable fs object — tests can override .readSync, .statSync etc.
  // for per-test customization (the watcher reads each method on every call,
  // so reassigning is picked up immediately).
  mockFs: {
    existsSync: typeof fs.existsSync
    readdirSync: typeof fs.readdirSync
    statSync: typeof fs.statSync
    openSync: typeof fs.openSync
    closeSync: typeof fs.closeSync
    readSync: typeof fs.readSync
    watch: typeof fs.watch
  }
}

function makeHarness(opts: {
  agentDir?: string
  files?: Record<string, string>  // filePath → JSONL content
  dirs?: Record<string, string[]> // dirPath → list of filenames
  existingDirs?: string[]
  stallThresholdMs?: number
  rescanMs?: number
}): WatcherHarness {
  const {
    agentDir = '/home/user/.switchroom/agents/myagent',
    files = {},
    dirs = {},
    existingDirs = [],
    stallThresholdMs = 60_000,
    rescanMs = 500,
  } = opts

  let currentTime = 1000
  const notifications: string[] = []

  // Track all JSONL content per path for statSync + read simulation
  const fileContents: Map<string, Buffer> = new Map()
  for (const [path, content] of Object.entries(files)) {
    fileContents.set(path, Buffer.from(content, 'utf-8'))
  }

  // Build a mock fs object — injected via watcher config (ESM namespace
  // exports are not configurable so vi.spyOn(fs, ...) doesn't work).
  const fakeWatchers: Array<{ close: () => void }> = []
  // Track which path was last opened so readSync can serve the right content.
  // The mock fd is always 42; we only ever have one open file at a time.
  let lastOpenedPath: string | null = null
  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (existingDirs.includes(ps)) return true
      if (dirs[ps] !== undefined) return true
      if (fileContents.has(ps)) return true
      for (const fp of fileContents.keys()) {
        if (fp.startsWith(ps + '/')) return true
      }
      return false
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (dirs[ps]) return dirs[ps]
      const children = new Set<string>()
      for (const fp of fileContents.keys()) {
        if (fp.startsWith(ps + '/')) {
          const rest = fp.slice(ps.length + 1)
          const part = rest.split('/')[0]
          if (part) children.add(part)
        }
      }
      return Array.from(children)
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) => {
      const ps = String(p)
      const content = fileContents.get(ps)
      return { size: content?.length ?? 0 } as fs.Stats
    }) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => {
      lastOpenedPath = String(p)
      return 42
    }) as unknown as typeof fs.openSync,
    closeSync: (() => {
      lastOpenedPath = null
    }) as typeof fs.closeSync,
    readSync: ((
      _fd: number,
      buf: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      // Serve content from fileContents for the currently open file.
      const content = lastOpenedPath != null ? fileContents.get(lastOpenedPath) : undefined
      if (!content) return 0
      const pos = position ?? 0
      const src = content.slice(pos, pos + length)
      ;(src as Buffer).copy(buf as Buffer, offset)
      return src.length
    }) as unknown as typeof fs.readSync,
    watch: (() => {
      const w = { close: vi.fn() }
      fakeWatchers.push(w)
      return w as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch,
  }

  // Injected timers
  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    sendNotification: (text) => notifications.push(text),
    stallThresholdMs,
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
    fs: mockFs,
    log: (_msg: string) => {}, // silence in tests
  })

  const advance = (ms: number): void => {
    currentTime += ms
    // Fire any intervals whose fireAt <= currentTime
    for (;;) {
      intervals.sort((a, b) => a.fireAt - b.fireAt)
      const next = intervals[0]
      if (!next || next.fireAt > currentTime) break
      next.fireAt += next.ms
      next.fn()
    }
  }

  const poll = (): void => {
    const pollInterval = intervals[0]
    if (pollInterval) pollInterval.fn()
  }

  return {
    notifications,
    advance,
    poll,
    watcher,
    now: () => currentTime,
    mockFs,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('startSubagentWatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when the agent dir has no .claude/projects', () => {
    const h = makeHarness({ agentDir: '/nonexistent', existingDirs: [] })
    h.poll()
    expect(h.notifications).toHaveLength(0)
    h.watcher.stop()
  })

  it('registers a new post-startup sub-agent in the registry without firing a Telegram dispatch (#142)', () => {
    // Pre-#142 the watcher emitted a "🛠️ Worker dispatched" inline reply
    // every time it discovered a sub-agent JSONL after boot. That surface
    // duplicated the in-card `[Sub-agents · N running]` block of the main
    // progress card. #142 deleted it — registry tracking still happens
    // (we still tail JSONLs for stall + completion transitions), but no
    // dispatch notification is sent to Telegram.
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`
    const content = buildJSONL(subAgentUserMsg('Fix the tests please'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: [],
      },
      files: {},
    })

    expect(h.notifications).toHaveLength(0)

    h.mockFs.readdirSync = ((p: unknown) => {
      const ps = String(p)
      if (ps === subagentsDir) return ['agent-deadbeef.jsonl']
      if (ps === projectsRoot) return ['myproject']
      if (ps === projectDir) return ['session-abc123']
      return []
    }) as unknown as typeof fs.readdirSync
    h.mockFs.existsSync = ((p: unknown) => {
      const ps = String(p)
      return [projectsRoot, projectDir, sessionDir, subagentsDir, jsonlPath].includes(ps)
    }) as typeof fs.existsSync
    const contentBuf = Buffer.from(content, 'utf-8')
    h.mockFs.statSync = ((p: unknown) => {
      if (String(p) === jsonlPath) return { size: contentBuf.length } as import('fs').Stats
      return { size: 0 } as import('fs').Stats
    }) as typeof fs.statSync

    h.poll()

    // Registry has the new agent…
    expect(h.watcher.getRegistry().has('deadbeef')).toBe(true)
    expect(h.watcher.getRegistry().get('deadbeef')?.historical).toBe(false)
    // …but no Telegram dispatch notification was sent.
    expect(h.notifications.filter((n) => n.includes('Worker dispatched'))).toHaveLength(0)

    h.watcher.stop()
  })

  // The next three tests use a real tmp dir + real files + real fs (no
  // injection). The over-mocked harness can't reproduce the read-sequence
  // statefully — real fs is simpler and more accurate.
  describe('with real tmp filesystem', () => {
    let tmpRoot = ''
    const startedWatchers: Array<{ stop(): void }> = []

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-watcher-test-'))
    })

    afterEach(() => {
      while (startedWatchers.length) {
        try { startedWatchers.pop()?.stop() } catch { /* ignore */ }
      }
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    function setupRealFs(jsonlContent: string, agentId: string): {
      agentDir: string
      jsonlPath: string
    } {
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`)
      writeFileSync(jsonlPath, jsonlContent)
      return { agentDir, jsonlPath }
    }

    function startWatcherSync(opts: { agentDir: string }): {
      notifications: string[]
      poll: () => void
      watcher: ReturnType<typeof startSubagentWatcher>
    } {
      const notifications: string[] = []
      const intervals: Array<{ fn: () => void; ref: number }> = []
      let nextRef = 1
      const watcher = startSubagentWatcher({
        agentDir: opts.agentDir,
        sendNotification: (text) => notifications.push(text),
        stallThresholdMs: 60_000,
        rescanMs: 500,
        now: () => Date.now(),
        setInterval: (fn) => {
          const ref = nextRef++
          intervals.push({ fn, ref })
          return { ref }
        },
        clearInterval: (handle) => {
          const { ref } = handle as { ref: number }
          const idx = intervals.findIndex((i) => i.ref === ref)
          if (idx !== -1) intervals.splice(idx, 1)
        },
        log: () => {},
      })
      startedWatchers.push(watcher)
      return {
        notifications,
        poll: () => intervals[0]?.fn(),
        watcher,
      }
    }

    it('updates description from sub_agent_text event', () => {
      const content = buildJSONL(
        subAgentUserMsg('Do the thing'),
        subAgentAssistantText('I will implement the feature now'),
      )
      const { agentDir } = setupRealFs(content, 'deadbeef')
      const h = startWatcherSync({ agentDir })
      h.poll()
      const entry = h.watcher.getRegistry().get('deadbeef')
      expect(entry).toBeDefined()
      expect(entry?.description).not.toBe('sub-agent')
      expect(entry?.description).toMatch(/I will implement/)
    })

    it('counts tools from sub_agent_tool_use events', () => {
      const content = buildJSONL(
        subAgentUserMsg('Fix things'),
        subAgentToolUse('Read', 'id1'),
        subAgentToolUse('Bash', 'id2'),
        subAgentToolUse('Edit', 'id3'),
      )
      const { agentDir } = setupRealFs(content, 'deadbeef')
      const h = startWatcherSync({ agentDir })
      h.poll()
      const entry = h.watcher.getRegistry().get('deadbeef')
      expect(entry).toBeDefined()
      expect(entry?.toolCount).toBe(3)
    })

    it('does NOT emit completion notification for a file already done at startup', () => {
      // File pre-exists with turn_end already written — agent was done before
      // the watcher started. No completion notification should fire.
      const content = buildJSONL(
        subAgentUserMsg('Do the task'),
        subAgentTurnDuration(),
      )
      const { agentDir } = setupRealFs(content, 'deadbeef')
      const h = startWatcherSync({ agentDir })
      h.poll()
      const entry = h.watcher.getRegistry().get('deadbeef')
      expect(entry).toBeDefined()
      expect(entry?.state).toBe('done')
      // Already done at boot → historical → no completion notification
      const completionNotifs = h.notifications.filter((n) => n.includes('Worker done'))
      expect(completionNotifs).toHaveLength(0)
    })

    it('emits completion notification when a NEW subagent finishes (no dispatch since #142)', () => {
      // File does NOT exist at startup. Watcher starts, then file appears
      // with an in-flight status. Then turn_end is appended — we should
      // get a completion notification.
      //
      // Pre-#142 a "🛠️ Worker dispatched" notification also fired on the
      // first poll. That surface was deleted (it duplicated the in-card
      // [Sub-agents · N running] block of the main progress card).
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-newagent.jsonl')

      const initialContent = buildJSONL(subAgentUserMsg('Do the task'))

      const h = startWatcherSync({ agentDir })

      writeFileSync(jsonlPath, initialContent)
      h.poll()

      const entry = h.watcher.getRegistry().get('newagent')
      expect(entry).toBeDefined()
      expect(entry?.state).toBe('running')

      // No dispatch notification — that surface was deleted in #142.
      expect(h.notifications.filter((n) => n.includes('Worker dispatched'))).toHaveLength(0)

      // Append turn_end to simulate agent finishing
      appendFileSync(jsonlPath, buildJSONL(subAgentTurnDuration()))
      h.poll()

      const completionNotifs = h.notifications.filter((n) => n.includes('Worker done'))
      expect(completionNotifs).toHaveLength(1)
    })
  })

  it('emits stall notification after stallThresholdMs idle', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    // Only the initial user message — no tool_use or turn_end
    const content = buildJSONL(subAgentUserMsg('Run a long task'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
      stallThresholdMs: 60_000,
      rescanMs: 500,
    })

    // Initial poll — registers the agent (as historical, since the file
    // already exists at boot). Flip historical=false to simulate an entry
    // that was discovered post-boot, which is the only case stalls fire.
    h.poll()
    const entry = h.watcher.getRegistry().get('deadbeef')
    if (entry) entry.historical = false

    // Advance past stall threshold without any new JSONL activity
    h.advance(65_000)

    const stallNotifs = h.notifications.filter((n) => n.includes('Worker idle'))
    expect(stallNotifs.length).toBeGreaterThanOrEqual(1)
    expect(stallNotifs[0]).toContain('Worker idle')

    h.watcher.stop()
  })

  it('suppresses stall notifications for historical entries', () => {
    // Historical entries (file existed at watcher boot) must NOT fire
    // stall notifications. The sub-agent process is long dead; the file
    // is just left over from a prior session. With many historicals
    // present at restart, firing stalls for each would flood the chat.
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`
    const content = buildJSONL(subAgentUserMsg('Old task'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
      stallThresholdMs: 60_000,
    })

    h.poll()
    h.advance(65_000) // past stall threshold

    const stallNotifs = h.notifications.filter((n) => n.includes('Worker idle'))
    expect(stallNotifs).toHaveLength(0)

    h.watcher.stop()
  })

  it('does not emit stall notification twice', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(subAgentUserMsg('Long task'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
      stallThresholdMs: 60_000,
    })

    h.poll()
    const entry = h.watcher.getRegistry().get('deadbeef')
    if (entry) entry.historical = false

    h.advance(65_000)
    h.advance(65_000) // advance past threshold AGAIN

    const stallNotifs = h.notifications.filter((n) => n.includes('Worker idle'))
    expect(stallNotifs.length).toBe(1)

    h.watcher.stop()
  })

  it('does not duplicate workers registered from same file', () => {
    // File exists at startup → historical. Repeated polls should not
    // re-register the agent or emit extra notifications.
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(subAgentUserMsg('Do it'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
    })

    h.poll()
    h.poll() // second poll — should not re-register
    h.poll()

    const registry = h.watcher.getRegistry()
    // The agent is tracked exactly once (historical, no dispatch spam)
    expect(registry.size).toBe(1)

    // Historical file — no dispatch notification should have been emitted
    const dispatchNotifs = h.notifications.filter((n) => n.includes('Worker dispatched'))
    expect(dispatchNotifs.length).toBe(0)

    h.watcher.stop()
  })

  it('stop() cleans up and stops poll timers', () => {
    const h = makeHarness({})
    h.watcher.stop()

    // After stop, advancing should not trigger anything new
    const notifsBefore = h.notifications.length
    h.advance(100_000)
    expect(h.notifications.length).toBe(notifsBefore)
  })

  // ─── Startup-snapshot regression tests ─────────────────────────────────

  describe('startup snapshot: registry tracks pre-existing files (no dispatch since #142)', () => {
    /**
     * Pre-#142 history: the watcher emitted a "🛠️ Worker dispatched" inline
     * reply for every newly-discovered sub-agent. A bug shipped in PR #70
     * caused that to fire for every pre-existing JSONL file at watcher
     * boot — flooding the chat on every restart with "Worker dispatched"
     * for sessions that finished long ago. The historical-files snapshot
     * was the targeted fix.
     *
     * Post-#142 the dispatch surface is gone entirely (it duplicated the
     * in-card [Sub-agents · N running] block of the main progress card).
     * Historical tracking still matters because stall detection skips
     * historical entries (otherwise restarts would fire 60s-stall warnings
     * for every long-dead session).
     */

    it('pre-existing JSONL files at startup populate the registry (no dispatch ever)', () => {
      // Two JSONL files exist before the watcher starts.
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const jsonlA = `${subagentsDir}/agent-hist-aaaa.jsonl`
      const jsonlB = `${subagentsDir}/agent-hist-bbbb.jsonl`

      const content = buildJSONL(subAgentUserMsg('Old task'))

      const h = makeHarness({
        agentDir,
        existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
        dirs: {
          [projectsRoot]: ['myproject'],
          [projectDir]: ['session-abc123'],
          [subagentsDir]: ['agent-hist-aaaa.jsonl', 'agent-hist-bbbb.jsonl'],
        },
        files: {
          [jsonlA]: content,
          [jsonlB]: content,
        },
      })

      // Both agents are in the registry, both flagged historical.
      const registry = h.watcher.getRegistry()
      expect(registry.size).toBe(2)
      for (const entry of registry.values()) {
        expect(entry.historical).toBe(true)
      }

      // No dispatch notification — surface deleted in #142.
      const dispatchNotifs = h.notifications.filter((n) => n.includes('Worker dispatched'))
      expect(dispatchNotifs).toHaveLength(0)

      h.watcher.stop()
    })

    it('pre-existing in-flight agent that finishes after restart fires completion (no dispatch ever, #142)', () => {
      // An in-flight subagent existed before restart. At boot it's registered
      // as historical (no dispatch). Then it writes turn_end and we get a
      // completion notification — the state transition fired correctly.
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const jsonlPath = `${subagentsDir}/agent-inflight-dddd.jsonl`

      // At boot: only the initial user message — still running
      const initialContent = buildJSONL(subAgentUserMsg('Important in-flight task'))
      const initialBuf = Buffer.from(initialContent, 'utf-8')

      // Track mutable file content for the real-time fs mock
      let currentContent = initialBuf

      const h = makeHarness({
        agentDir,
        existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
        dirs: {
          [projectsRoot]: ['myproject'],
          [projectDir]: ['session-abc123'],
          [subagentsDir]: ['agent-inflight-dddd.jsonl'],
        },
        files: { [jsonlPath]: initialContent },
      })

      // After boot: historical — no dispatch notification
      const dispatchNotifs = h.notifications.filter((n) => n.includes('Worker dispatched'))
      expect(dispatchNotifs).toHaveLength(0)

      // The agent IS in the registry
      const entry = h.watcher.getRegistry().get('inflight-dddd')
      expect(entry).toBeDefined()
      expect(entry?.state).toBe('running')

      // Now the sub-agent finishes — new JSONL content with turn_end appended
      const finishedContent = initialContent + buildJSONL(subAgentTurnDuration())
      // Update the mock so statSync/readSync see the larger file
      currentContent = Buffer.from(finishedContent, 'utf-8')
      h.mockFs.statSync = ((p: unknown) => {
        if (String(p) === jsonlPath) return { size: currentContent.length } as import('fs').Stats
        return { size: 0 } as import('fs').Stats
      }) as typeof import('fs').statSync
      h.mockFs.readSync = ((
        _fd: number,
        buf: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ): number => {
        const pos = position ?? 0
        const src = currentContent.slice(pos, pos + length)
        Buffer.from(src).copy(buf as Buffer, offset)
        return src.length
      }) as unknown as typeof import('fs').readSync

      // Trigger a poll — watcher should detect the turn_end and emit completion
      h.poll()

      const completionNotifs = h.notifications.filter((n) => n.includes('Worker done'))
      expect(completionNotifs).toHaveLength(1)

      // Still no spurious dispatch notification
      expect(h.notifications.filter((n) => n.includes('Worker dispatched'))).toHaveLength(0)

      h.watcher.stop()
    })
  })
})
