/**
 * Unit tests for the subagent-watcher module.
 *
 * Covers:
 *   - renderWorkerCard output format
 *   - Registry transitions (register, tool_use, turn_end)
 *   - JSONL tail parsing (description from sub_agent_text, toolCount from sub_agent_tool_use)
 *   - Stall detection (stall notification after stallThresholdMs idle)
 *   - Completion notification (sent once on state=done)
 *   - Dispatch notification (sent on registration)
 *   - Card lifecycle (created on first worker, updated on changes, removed when all done)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderWorkerCard, startSubagentWatcher, type WorkerEntry } from '../subagent-watcher.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    agentId: 'test-agent-01',
    filePath: '/tmp/agent-test-agent-01.jsonl',
    description: 'Build the feature',
    state: 'running',
    dispatchedAt: 1000,
    lastActivityAt: 1000,
    toolCount: 0,
    stallNotified: false,
    completionNotified: false,
    lastSummaryLine: '',
    historical: false,
    ...overrides,
  }
}

// ─── renderWorkerCard ────────────────────────────────────────────────────────

describe('renderWorkerCard', () => {
  it('returns null when registry is empty', () => {
    const registry = new Map<string, WorkerEntry>()
    expect(renderWorkerCard(registry, 2000)).toBeNull()
  })

  it('returns null when all workers are done', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ state: 'done' })],
      ['b', makeEntry({ agentId: 'b', state: 'failed' })],
    ])
    expect(renderWorkerCard(registry, 2000)).toBeNull()
  })

  it('renders a single running worker', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'Fix the tests', toolCount: 3, lastActivityAt: 1000 })],
    ])
    const html = renderWorkerCard(registry, 61_000)
    expect(html).not.toBeNull()
    expect(html).toContain('Background workers (1)')
    expect(html).toContain('Fix the tests')
    expect(html).toContain('3 tools')
    // Issue #94: rows now use the same `🤖` glyph + `⏱ MM:SS` format as
    // sub-agent rows in the main progress card. The literal word
    // "running" no longer appears — the active state is implied by the
    // worker showing up in the card at all (done/failed are filtered).
    expect(html).toContain('🤖')
    expect(html).toContain('⏱')
  })

  it('renders multiple running workers', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'Worker A', toolCount: 2 })],
      ['b', makeEntry({ agentId: 'b', description: 'Worker B', toolCount: 5 })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).toContain('Background workers (2)')
    expect(html).toContain('Worker A')
    expect(html).toContain('Worker B')
  })

  it('shows only running workers in the card', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'Still running', state: 'running' })],
      ['b', makeEntry({ agentId: 'b', description: 'Already done', state: 'done' })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).toContain('Background workers (1)')
    expect(html).toContain('Still running')
    expect(html).not.toContain('Already done')
  })

  it('escapes HTML special characters in description', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: '<script>alert("xss")</script>' })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('truncates long descriptions', () => {
    const long = 'a'.repeat(100)
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: long })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html?.length).toBeLessThan(400)
    expect(html).toContain('…')
  })

  it('formats last-activity age (issue #94: shared MM:SS format)', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ lastActivityAt: 1000 })],
    ])
    // 30s ago — shared formatter emits "00:30", not the legacy "30s".
    const html = renderWorkerCard(registry, 31_000)
    expect(html).toContain('00:30')
    expect(html).not.toContain('30s ago')
  })

  it('issue #94: sub-second age renders HTML-safe (no `<1s` literal)', () => {
    // Pre-#94 the watcher's own formatDuration returned the literal
    // string "<1s" when ms < 1000. That broke Telegram's HTML parser
    // unless escaped at every call site (see #86 / #89 / #101). The
    // shared formatter (`./card-format.ts`) returns "<n>ms" instead,
    // so no `<` ever appears in the rendered output and no per-call
    // escapeHtml is required.
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'sub-agent', lastActivityAt: 999 })],
    ])
    const html = renderWorkerCard(registry, 1000) // 1ms idle
    expect(html).not.toContain('<1s')
    expect(html).not.toContain('&lt;1s')
    // The HTML-safe form: "1ms" — a literal sub-second duration as
    // numeric ms. No HTML special chars; ready to interpolate without
    // escaping.
    expect(html).toContain('1ms')
  })

  it('excludes historical entries from the active-workers card', () => {
    // Historical = JSONL existed before the watcher started. The sub-agent
    // process is long dead; the file is just left over from a prior session.
    // Even if state was last written as 'running' (no turn_end event in
    // the file), the entry must not appear in the card. With many
    // historical entries (e.g. months of session history) the card text
    // overflows Telegram's 4096-char message limit and sendMessage fails.
    const registry = new Map<string, WorkerEntry>([
      ['live', makeEntry({ agentId: 'live', description: 'real worker', historical: false })],
      ['hist1', makeEntry({ agentId: 'hist1', description: 'old session 1', historical: true })],
      ['hist2', makeEntry({ agentId: 'hist2', description: 'old session 2', historical: true })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).toContain('Background workers (1)')
    expect(html).toContain('real worker')
    expect(html).not.toContain('old session 1')
    expect(html).not.toContain('old session 2')
  })

  it('returns null when only historical entries are present', () => {
    const registry = new Map<string, WorkerEntry>([
      ['hist1', makeEntry({ agentId: 'hist1', historical: true })],
      ['hist2', makeEntry({ agentId: 'hist2', historical: true })],
    ])
    expect(renderWorkerCard(registry, 2000)).toBeNull()
  })
})

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
  cardUpdates: Array<string | null>
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
  cardUpdateIntervalMs?: number
  rescanMs?: number
}): WatcherHarness {
  const {
    agentDir = '/home/user/.switchroom/agents/myagent',
    files = {},
    dirs = {},
    existingDirs = [],
    stallThresholdMs = 60_000,
    cardUpdateIntervalMs = 100,
    rescanMs = 500,
  } = opts

  let currentTime = 1000
  const notifications: string[] = []
  const cardUpdates: Array<string | null> = []

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
    updatePinnedCard: (html) => cardUpdates.push(html),
    stallThresholdMs,
    cardUpdateIntervalMs,
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
    cardUpdates,
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
    expect(h.cardUpdates).toHaveLength(0)
    h.watcher.stop()
  })

  it('detects a new subagent JSONL created after startup and emits dispatch notification', () => {
    // Watcher starts with an empty subagents dir, then a new file appears.
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
        // subagentsDir is empty at startup
        [subagentsDir]: [],
      },
      files: {},
    })

    // No notifications during boot
    expect(h.notifications).toHaveLength(0)

    // Simulate the new file appearing after startup
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

    expect(h.notifications.length).toBeGreaterThanOrEqual(1)
    expect(h.notifications[0]).toContain('Worker dispatched')

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
      cardUpdates: Array<string | null>
      poll: () => void
      watcher: ReturnType<typeof startSubagentWatcher>
    } {
      const notifications: string[] = []
      const cardUpdates: Array<string | null> = []
      const intervals: Array<{ fn: () => void; ref: number }> = []
      let nextRef = 1
      const watcher = startSubagentWatcher({
        agentDir: opts.agentDir,
        sendNotification: (text) => notifications.push(text),
        updatePinnedCard: (html) => cardUpdates.push(html),
        stallThresholdMs: 60_000,
        cardUpdateIntervalMs: 100,
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
        cardUpdates,
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

    it('emits completion notification when a NEW subagent finishes', () => {
      // File does NOT exist at startup. Watcher starts, then file appears
      // with an in-flight status. Then turn_end is appended — we should
      // get a completion notification.
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-newagent.jsonl')

      // Write just the initial user message (in-flight state)
      const initialContent = buildJSONL(subAgentUserMsg('Do the task'))

      const h = startWatcherSync({ agentDir })

      // Write file AFTER watcher starts (post-startup, so not historical)
      writeFileSync(jsonlPath, initialContent)
      h.poll()

      const entry = h.watcher.getRegistry().get('newagent')
      expect(entry).toBeDefined()
      expect(entry?.state).toBe('running')

      // Dispatch notification fired (post-startup file)
      expect(h.notifications.filter((n) => n.includes('Worker dispatched'))).toHaveLength(1)

      // Now append turn_end to simulate agent finishing
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

  // ─── Startup-snapshot regression tests (the core bug fix) ─────────────────

  describe('startup snapshot: pre-existing JSONL files do not fire dispatch', () => {
    /**
     * These tests directly verify the fix for the bug where pre-existing JSONL
     * files at watcher boot caused spurious "Worker dispatched" notifications —
     * one per historical session — on every agent restart.
     */

    it('pre-existing JSONL files at startup are NOT dispatched', () => {
      // Two JSONL files exist before the watcher starts.
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const jsonlA = `${subagentsDir}/agent-hist-aaaa.jsonl`
      const jsonlB = `${subagentsDir}/agent-hist-bbbb.jsonl`

      const content = buildJSONL(subAgentUserMsg('Old task'))

      // Both files exist at harness construction time (i.e. before watcher starts)
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

      // Both agents are in the registry (we track them for state transitions)
      const registry = h.watcher.getRegistry()
      expect(registry.size).toBe(2)

      // But no dispatch notification was emitted for either
      const dispatchNotifs = h.notifications.filter((n) => n.includes('Worker dispatched'))
      expect(dispatchNotifs).toHaveLength(0)

      h.watcher.stop()
    })

    it('JSONL file created after startup DOES fire dispatch', () => {
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const newJsonl = `${subagentsDir}/agent-new-cccc.jsonl`

      const content = buildJSONL(subAgentUserMsg('Fresh task'))

      // Watcher starts with an EMPTY subagents dir
      const h = makeHarness({
        agentDir,
        existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
        dirs: {
          [projectsRoot]: ['myproject'],
          [projectDir]: ['session-abc123'],
          // subagentsDir is empty at startup — no pre-existing files
          [subagentsDir]: [],
        },
        files: {},
      })

      // Nothing dispatched yet
      expect(h.notifications.filter((n) => n.includes('Worker dispatched'))).toHaveLength(0)

      // Simulate a new file appearing AFTER startup by mutating mockFs
      h.mockFs.readdirSync = ((p: unknown) => {
        if (String(p) === subagentsDir) return ['agent-new-cccc.jsonl']
        if (String(p) === projectsRoot) return ['myproject']
        if (String(p) === projectDir) return ['session-abc123']
        return []
      }) as unknown as typeof import('fs').readdirSync
      h.mockFs.existsSync = ((p: unknown) => {
        const ps = String(p)
        return [projectsRoot, projectDir, sessionDir, subagentsDir, newJsonl].includes(ps)
      }) as typeof import('fs').existsSync
      h.mockFs.statSync = ((p: unknown) => {
        const ps = String(p)
        if (ps === newJsonl) return { size: Buffer.from(content, 'utf-8').length } as import('fs').Stats
        return { size: 0 } as import('fs').Stats
      }) as typeof import('fs').statSync

      // Trigger a poll — the new file is now visible
      h.poll()

      const dispatchNotifs = h.notifications.filter((n) => n.includes('Worker dispatched'))
      expect(dispatchNotifs).toHaveLength(1)
      expect(dispatchNotifs[0]).toContain('Worker dispatched')

      h.watcher.stop()
    })

    it('pre-existing in-flight agent that finishes after restart fires completion but NOT dispatch', () => {
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
