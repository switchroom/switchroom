/**
 * Unit tests for the subagent-watcher module.
 *
 * Covers:
 *   - Registry transitions (register, tool_use, turn_end)
 *   - JSONL tail parsing (description from sub_agent_text, toolCount from sub_agent_tool_use)
 *   - Stall detection (stall notification after stallThresholdMs idle)
 *   - Completion notification (sent once on state=done)
 *   - Historical-vs-active filter (pre-existing files do not fire stalls/completions)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher, type WorkerEntry } from '../subagent-watcher.js'

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
    lastTool: null,
    historical: false,
    ...overrides,
  }
}

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
  logs: string[]
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
  const logs: string[] = []

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
  const timeouts: Array<{ fn: () => void; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    // Card retired (#1122): completion surfaces via onFinish, not a
    // user-facing message. Capture it so the completion assertions still
    // verify the terminal-transition + de-dup behaviour.
    onFinish: (info) => notifications.push(`✓ Worker done: ${info.description}`),
    stallThresholdMs,
    // Mirror the active-loop threshold so existing fixtures (which have
    // toolCount=0 and use the simple "advance past N" model) keep
    // working under the adaptive split. Tests that need the silent-
    // synthesis vs active-loop distinction set both explicitly.
    silentSynthesisStallThresholdMs: stallThresholdMs,
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
    // Fire any one-shot timeouts whose fireAt <= currentTime — drain
    // the queue (oneshots, so remove on fire).
    for (;;) {
      timeouts.sort((a, b) => a.fireAt - b.fireAt)
      const next = timeouts[0]
      if (!next || next.fireAt > currentTime) break
      timeouts.shift()
      next.fn()
    }
  }

  const poll = (): void => {
    const pollInterval = intervals[0]
    if (pollInterval) pollInterval.fn()
  }

  return {
    notifications,
    logs,
    advance,
    poll,
    watcher,
    now: () => currentTime,
    mockFs,
    fakeWatchers,
    pendingTimeouts: () => timeouts.length,
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

  it('detects a new subagent JSONL created after startup', () => {
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

    const entry = h.watcher.getRegistry().get('deadbeef')
    expect(entry).toBeDefined()
    expect(entry?.historical).toBe(false)
    expect(entry?.state).toBe('running')

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

    function startWatcherSync(opts: {
      agentDir: string
      onFinish?: Parameters<typeof startSubagentWatcher>[0]['onFinish']
      onProgress?: Parameters<typeof startSubagentWatcher>[0]['onProgress']
    }): {
      notifications: string[]
      poll: () => void
      watcher: ReturnType<typeof startSubagentWatcher>
      fireScheduledCleanups: () => number
    } {
      const notifications: string[] = []
      const intervals: Array<{ fn: () => void; ref: number }> = []
      const timeouts: Array<{ fn: () => void; ref: number }> = []
      let nextRef = 1
      const watcher = startSubagentWatcher({
        agentDir: opts.agentDir,
        // Card retired (#1122): completion surfaces via onFinish. Capture
        // it for the completion assertions and still delegate to any
        // test-supplied onFinish.
        onFinish: (info) => {
          notifications.push(`✓ Worker done: ${info.description}`)
          opts.onFinish?.(info)
        },
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
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
        setTimeout: (fn) => {
          const ref = nextRef++
          timeouts.push({ fn, ref })
          return { ref }
        },
        clearTimeout: (handle) => {
          const { ref } = handle as { ref: number }
          const idx = timeouts.findIndex((t) => t.ref === ref)
          if (idx !== -1) timeouts.splice(idx, 1)
        },
        log: () => {},
      })
      startedWatchers.push(watcher)
      return {
        notifications,
        poll: () => intervals[0]?.fn(),
        watcher,
        // Drain any scheduled deferred-cleanups regardless of fireAt time
        // (tests use this to advance past the 30s grace deterministically).
        fireScheduledCleanups: () => {
          let fired = 0
          while (timeouts.length) {
            const next = timeouts.shift()!
            next.fn()
            fired++
          }
          return fired
        },
      }
    }

    it('does NOT overwrite description with sub_agent_text narrative (#352)', () => {
      // Pre-#352 the watcher would overwrite a sub-agent's dispatch
      // description with the first narrative line it saw. That made identical
      // dispatches render differently depending on which event reached the
      // watcher first — a race-condition-dependent UX bug.
      //
      // Post-#352 the description must remain whatever the watcher started
      // with (the dispatch description set by the parent Agent tool_use
      // input, or the placeholder when the watcher is bootstrapped without
      // one). Narrative text is recorded in `lastSummaryLine` instead.
      const content = buildJSONL(
        subAgentUserMsg('Do the thing'),
        subAgentAssistantText('I will implement the feature now'),
      )
      const { agentDir } = setupRealFs(content, 'deadbeef')
      const h = startWatcherSync({ agentDir })
      h.poll()
      const entry = h.watcher.getRegistry().get('deadbeef')
      expect(entry).toBeDefined()
      // Description stays as the bootstrap value — the watcher must NOT
      // promote the narrative line into the description field.
      expect(entry?.description).not.toMatch(/I will implement/)
      // Narrative text still flows into lastSummaryLine for telemetry.
      expect(entry?.lastSummaryLine).toMatch(/I will implement/)
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

    it('fires onProgress with a friendly tool-step progressLine on a tool_use tick (foreground visibility)', () => {
      // A foreground sub-agent that runs tools WITHOUT emitting prose used
      // to fire no onProgress cue at all — only `sub_agent_text` did — so
      // its steps never nested under the parent's activity feed (the named
      // foreground blindspot). The tool_use branch now fires onProgress
      // carrying a `describeToolUse` label so the gateway can render
      // "Reading X" the same way the main-turn feed does.
      const progress: Array<{ progressLine?: string; toolCount: number; latestSummary: string }> = []
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')

      const h = startWatcherSync({
        agentDir,
        onProgress: ({ progressLine, toolCount, latestSummary }) => {
          progress.push({ progressLine, toolCount, latestSummary })
        },
      })
      // Register running, post-boot (same pattern as the onFinish test).
      writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Research the competitors')))
      h.poll()
      expect(h.watcher.getRegistry().get('deadbeef')?.state).toBe('running')

      // The sub-agent reads a file — a tool_use with no accompanying prose.
      appendFileSync(jsonlPath, buildJSONL({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/x/CLAUDE.md' } }] },
      }))
      h.poll()

      const toolTick = progress.find((p) => p.progressLine != null)
      expect(toolTick).toBeDefined()
      // Friendly label, matching the main-turn activity feed's renderer.
      expect(toolTick?.progressLine).toBe('Reading CLAUDE.md')
      // latestSummary stays the (empty) narrative result — never polluted
      // with the tool label, so the handback payload is unaffected.
      expect(toolTick?.latestSummary).toBe('')
    })

    it('narrative gate: a draft-then-reply sub_agent_text is SUPPRESSED (no progress cue)', () => {
      // The worker composes its answer as a text block, then calls
      // stream_reply with near-identical text. The narrative cue must be
      // suppressed so the answer is not double-surfaced.
      const narrativeCues: string[] = []
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')
      const h = startWatcherSync({
        agentDir,
        onProgress: ({ progressLine, latestSummary }) => {
          // Narrative ticks carry NO progressLine (tool ticks do); record them.
          if (progressLine == null) narrativeCues.push(latestSummary)
        },
      })
      writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Find the repo path')))
      h.poll()
      const answer = 'The repo is at /home/user/code/switchroom.'
      appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText(answer)))
      h.poll()
      // The draft is staged, not yet resolved — no cue yet.
      // The very next event is a reply tool with matching text → SUPPRESS.
      appendFileSync(jsonlPath, buildJSONL({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'stream_reply', id: 'r1', input: { text: answer } }] },
      }))
      h.poll()
      expect(narrativeCues.length).toBe(0)
    })

    it('narrative gate: pure working narration is SHOWN (cue fires)', () => {
      // "On it. Let me find the repo…" followed by a Bash tool — the next
      // event is a non-reply tool, so the narration is SHOWN.
      const narrativeCues: string[] = []
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')
      const h = startWatcherSync({
        agentDir,
        onProgress: ({ progressLine, latestSummary }) => {
          if (progressLine == null) narrativeCues.push(latestSummary)
        },
      })
      writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Find the repo')))
      h.poll()
      appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText('On it. Let me find the repo.')))
      h.poll()
      appendFileSync(jsonlPath, buildJSONL(subAgentToolUse('Bash', 'b1')))
      h.poll()
      // The staged narration was resolved by the non-reply Bash → SHOWN.
      expect(narrativeCues.length).toBe(1)
      expect(narrativeCues[0]).toContain('find the repo')
    })

    it('narrative gate: trailing narration at turn_end is SHOWN', () => {
      const narrativeCues: string[] = []
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')
      const h = startWatcherSync({
        agentDir,
        onProgress: ({ progressLine, latestSummary }) => {
          if (progressLine == null) narrativeCues.push(latestSummary)
        },
      })
      writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
      h.poll()
      // A trailing narration block, then turn_end (turn_duration). The
      // trailing block has no reply after it → SHOWN at turn_end.
      appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText('Done. All green.')))
      h.poll()
      appendFileSync(jsonlPath, buildJSONL(subAgentTurnDuration()))
      h.poll()
      expect(narrativeCues.length).toBe(1)
      expect(narrativeCues[0]).toContain('All green')
    })

    it('captures the full last narrative line into lastResultText (handback)', () => {
      // lastSummaryLine keeps only the first line, 120 chars — a progress
      // preview. lastResultText keeps the full last narrative emission:
      // for a worker that IS its result summary, fed to the gateway's
      // subagent_handback inbound (conversational-pacing beat 4).
      const fullResult =
        'Done. I refactored the auth module, added 4 tests, and all green.\n' +
        'One caveat: the legacy token path still needs a follow-up.'
      const content = buildJSONL(
        subAgentUserMsg('Refactor auth'),
        subAgentAssistantText(fullResult),
      )
      const { agentDir } = setupRealFs(content, 'deadbeef')
      const h = startWatcherSync({ agentDir })
      h.poll()
      const entry = h.watcher.getRegistry().get('deadbeef')
      expect(entry).toBeDefined()
      // lastSummaryLine is the truncated first line only.
      expect(entry?.lastSummaryLine).not.toMatch(/follow-up/)
      // lastResultText keeps the whole thing — multi-line, both sentences.
      expect(entry?.lastResultText).toContain('refactored the auth module')
      expect(entry?.lastResultText).toContain('legacy token path still needs a follow-up')
    })

    it('onFinish carries description + resultText for the handback', () => {
      // onFinish fires only on a POST-boot transition (a file already
      // done at startup is historical and short-circuits). So: register
      // the running sub-agent first, then append turn_duration.
      const finishes: Array<{ description: string; resultText: string; outcome: string }> = []
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')

      const h = startWatcherSync({
        agentDir,
        onFinish: ({ description, resultText, outcome }) => {
          finishes.push({ description, resultText, outcome })
        },
      })
      // Register the sub-agent as running (post-boot, not historical).
      writeFileSync(
        jsonlPath,
        buildJSONL(
          subAgentUserMsg('Run a long task'),
          subAgentAssistantText('All set — migration applied cleanly, 0 rows dropped.'),
        ),
      )
      h.poll()
      expect(h.watcher.getRegistry().get('deadbeef')?.state).toBe('running')

      // Now it finishes — onFinish must carry the result text.
      appendFileSync(jsonlPath, buildJSONL(subAgentTurnDuration()))
      h.poll()

      expect(finishes.length).toBe(1)
      expect(finishes[0].outcome).toBe('completed')
      expect(finishes[0].resultText).toContain('migration applied cleanly')
      // description stays the dispatch description, never the narrative.
      expect(finishes[0].description).not.toMatch(/migration applied/)
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
      expect(entry?.historical).toBe(false)

      // Now append turn_end to simulate agent finishing
      appendFileSync(jsonlPath, buildJSONL(subAgentTurnDuration()))
      h.poll()

      const completionNotifs = h.notifications.filter((n) => n.includes('Worker done'))
      expect(completionNotifs).toHaveLength(1)
    })

    it('drops the FSWatcher + Map entries after terminal-state grace fires (MEM1)', () => {
      // Pre-MEM1 fix: per-subagent FSWatcher entries lived for the
      // entire process lifetime. With sustained sub-agent load a
      // long-running gateway hit ulimit -n. This test pins the deferred
      // cleanup contract: completion → fire grace timer → tails/registry
      // entries removed → underlying FSWatcher closed.
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-cleanme.jsonl')
      writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))

      const h = startWatcherSync({ agentDir })

      // Discover + register the agent (running state).
      h.poll()
      expect(h.watcher.getRegistry().has('cleanme')).toBe(true)

      // Append turn_end → done state → completion notification + scheduled cleanup.
      appendFileSync(jsonlPath, buildJSONL(subAgentTurnDuration()))
      h.poll()
      expect(h.notifications.some((n) => n.includes('Worker done'))).toBe(true)
      // Registry still has it during the 30s grace window.
      expect(h.watcher.getRegistry().has('cleanme')).toBe(true)

      // Drain pending timeouts (simulates 30s elapsing).
      const fired = h.fireScheduledCleanups()
      expect(fired).toBeGreaterThan(0)

      // Post-grace: registry entry gone, downstream consumers see no
      // dangling FSWatcher.
      expect(h.watcher.getRegistry().has('cleanme')).toBe(false)
    })

    it('cleans up historical-and-already-done agents after grace (MEM1)', () => {
      // Historical files (pre-existing at boot, already done) used to
      // keep their FSWatcher open forever — they bypass the
      // maybySendStateTransition done branch because completionNotified
      // is set to true in the registerAgent path. Cleanup must still
      // schedule there.
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-historical.jsonl')
      // Already-done at boot: contains turn_end already.
      writeFileSync(jsonlPath, buildJSONL(
        subAgentUserMsg('From a prior session'),
        subAgentTurnDuration(),
      ))

      const h = startWatcherSync({ agentDir })

      // Boot scan picks it up as historical-and-done; no completion
      // notification fires (would be a spurious replay).
      expect(h.notifications.filter((n) => n.includes('Worker done'))).toHaveLength(0)
      expect(h.watcher.getRegistry().has('historical')).toBe(true)

      // Cleanup is still scheduled (the FSWatcher would otherwise leak).
      const fired = h.fireScheduledCleanups()
      expect(fired).toBeGreaterThan(0)
      expect(h.watcher.getRegistry().has('historical')).toBe(false)
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

    const stallLogs = h.logs.filter((n) => n.includes('stall detected'))
    expect(stallLogs.length).toBeGreaterThanOrEqual(1)
    expect(stallLogs[0]).toContain('stall detected')

    h.watcher.stop()
  })

  it('suppresses stall notifications for historical (done-at-boot) entries', () => {
    // A worker that already FINISHED before the watcher booted (turn_end
    // present in the file) stays historical and must NOT fire stall
    // notifications. With months of finished session history present at
    // restart, firing stalls for each would flood the chat. NOTE: a worker
    // still RUNNING at boot is a different case — Gap 1 promotes it to live
    // so it DOES get the stall safety net (it's an in-flight worker the
    // user is still awaiting), covered in subagent-watcher-handback-gaps.
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`
    const content = buildJSONL(subAgentUserMsg('Old task'), subAgentTurnDuration())

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

    const stallLogs = h.logs.filter((n) => n.includes('stall detected'))
    expect(stallLogs).toHaveLength(0)

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

    const stallLogs = h.logs.filter((n) => n.includes('stall detected'))
    expect(stallLogs.length).toBe(1)

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
    expect(registry.size).toBe(1)

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

  // ─── Historical-vs-active filter regression tests ────────────────────────

  describe('historical-vs-active filter', () => {
    /**
     * Pre-existing FINISHED (done-at-boot) JSONL files are tagged
     * historical=true. Stalls and completion notifications are gated on
     * !historical so a restart with months of session history doesn't
     * flood the chat. (A still-RUNNING file at boot is promoted to live by
     * Gap 1 — see subagent-watcher-handback-gaps — so it must carry a
     * turn_end here to stay historical.)
     */

    it('pre-existing done-at-boot JSONL files are tagged historical', () => {
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const jsonlA = `${subagentsDir}/agent-hist-aaaa.jsonl`
      const jsonlB = `${subagentsDir}/agent-hist-bbbb.jsonl`

      const content = buildJSONL(subAgentUserMsg('Old task'), subAgentTurnDuration())

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

      const registry = h.watcher.getRegistry()
      expect(registry.size).toBe(2)
      for (const entry of registry.values()) {
        expect(entry.historical).toBe(true)
      }

      h.watcher.stop()
    })

    it('JSONL file created after startup is tagged non-historical', () => {
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const newJsonl = `${subagentsDir}/agent-new-cccc.jsonl`

      const content = buildJSONL(subAgentUserMsg('Fresh task'))

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

      h.poll()

      const entry = h.watcher.getRegistry().get('new-cccc')
      expect(entry).toBeDefined()
      expect(entry?.historical).toBe(false)

      h.watcher.stop()
    })

    it('pre-existing in-flight agent that finishes after restart fires completion', () => {
      // Running at boot → Gap 1 promotes it to live (historical=false),
      // because it's an in-flight worker the user is still awaiting across
      // the restart. When it then writes turn_end, the completion
      // notification fires for the state transition. (The deeper handback
      // outcome — completed, not the dropped `orphan` — is covered in
      // subagent-watcher-handback-gaps.)
      const agentDir = '/home/user/.switchroom/agents/myagent'
      const projectsRoot = `${agentDir}/.claude/projects`
      const projectDir = `${projectsRoot}/myproject`
      const sessionDir = `${projectDir}/session-abc123`
      const subagentsDir = `${sessionDir}/subagents`
      const jsonlPath = `${subagentsDir}/agent-inflight-dddd.jsonl`

      const initialContent = buildJSONL(subAgentUserMsg('Important in-flight task'))
      const initialBuf = Buffer.from(initialContent, 'utf-8')

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

      const entry = h.watcher.getRegistry().get('inflight-dddd')
      expect(entry).toBeDefined()
      expect(entry?.state).toBe('running')

      const finishedContent = initialContent + buildJSONL(subAgentTurnDuration())
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

      h.poll()

      const completionNotifs = h.notifications.filter((n) => n.includes('Worker done'))
      expect(completionNotifs).toHaveLength(1)

      h.watcher.stop()
    })
  })

  // ─── Issue #1116 regressions ─────────────────────────────────────────────

  describe('issue #1116 — project-dir slug filter (Bug A)', () => {
    /**
     * Claude Code keys its `.claude/projects/<slug>/` dirs off the cwd it
     * was launched in. Over time an agent's home can accumulate stale
     * project dirs from prior boots (or from a sibling agent that briefly
     * shared the home via a wayward `CLAUDE_PROJECT_DIR`). Pre-#1116 the
     * watcher enumerated every project dir under `<agentDir>/.claude/projects/`
     * and registered any `agent-*.jsonl` it found, which produced phantom
     * registry entries whose backing files vanish on the next session-cleanup
     * tick (ENOENT spam + false stall notifications, per the issue's
     * smoking-gun log).
     *
     * The fix: when `agentCwd` is supplied, the watcher restricts
     * enumeration to the project dir whose slug matches
     * `sanitizeCwdToProjectName(agentCwd)`. Foreign-slug shadow dirs are
     * skipped entirely.
     */

    let tmpRoot = ''
    const startedWatchers: Array<{ stop(): void }> = []

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-watcher-1116-slug-'))
    })

    afterEach(() => {
      while (startedWatchers.length) {
        try { startedWatchers.pop()?.stop() } catch { /* ignore */ }
      }
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    function startWatcherSync(opts: { agentDir: string; agentCwd?: string }): {
      notifications: string[]
      logs: string[]
      poll: () => void
      watcher: ReturnType<typeof startSubagentWatcher>
    } {
      const notifications: string[] = []
      const logs: string[] = []
      const intervals: Array<{ fn: () => void; ref: number }> = []
      const timeouts: Array<{ fn: () => void; ref: number }> = []
      let nextRef = 1
      const watcher = startSubagentWatcher({
        agentDir: opts.agentDir,
        ...(opts.agentCwd !== undefined ? { agentCwd: opts.agentCwd } : {}),
        // Card retired (#1122): completion surfaces via onFinish.
        onFinish: (info) => notifications.push(`✓ Worker done: ${info.description}`),
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
        setTimeout: (fn) => {
          const ref = nextRef++
          timeouts.push({ fn, ref })
          return { ref }
        },
        clearTimeout: (handle) => {
          const { ref } = handle as { ref: number }
          const idx = timeouts.findIndex((t) => t.ref === ref)
          if (idx !== -1) timeouts.splice(idx, 1)
        },
        log: (msg) => logs.push(msg),
      })
      startedWatchers.push(watcher)
      return {
        notifications,
        logs,
        poll: () => intervals[0]?.fn(),
        watcher,
      }
    }

    it('skips foreign-slug project dirs when agentCwd is provided', () => {
      // Layout: an agent whose real cwd is /home/test/agent-own. Its
      // home contains BOTH its own project dir (-home-test-agent-own)
      // AND a stale foreign one (-home-test-agent-foreign) left over
      // from a prior boot. Each contains a sub-agent JSONL with a
      // distinct agentId.
      const agentDir = join(tmpRoot, 'agent')
      const agentCwd = '/home/test/agent-own'
      const ownSubagents = join(agentDir, '.claude', 'projects', '-home-test-agent-own', 'sess-A', 'subagents')
      const foreignSubagents = join(agentDir, '.claude', 'projects', '-home-test-agent-foreign', 'sess-B', 'subagents')
      mkdirSync(ownSubagents, { recursive: true })
      mkdirSync(foreignSubagents, { recursive: true })
      writeFileSync(
        join(ownSubagents, 'agent-ownworker.jsonl'),
        buildJSONL(subAgentUserMsg('legit work')),
      )
      writeFileSync(
        join(foreignSubagents, 'agent-foreignworker.jsonl'),
        buildJSONL(subAgentUserMsg('stale shadow')),
      )

      const h = startWatcherSync({ agentDir, agentCwd })
      h.poll()

      const reg = h.watcher.getRegistry()
      expect(reg.has('ownworker')).toBe(true)
      expect(reg.has('foreignworker')).toBe(false)
    })

    it('does NOT emit "read error" ENOENT for foreign-slug files that vanish mid-scan', () => {
      // Simulates the smoking-gun log line from the issue. Foreign-slug
      // JSONL is deleted from disk before the watcher's first readSubTail.
      // With the slug filter in place the foreign agent is never even
      // registered, so no ENOENT log line is emitted.
      const agentDir = join(tmpRoot, 'agent')
      const agentCwd = '/home/test/agent-own'
      const ownSubagents = join(agentDir, '.claude', 'projects', '-home-test-agent-own', 'sess-A', 'subagents')
      const foreignSubagents = join(agentDir, '.claude', 'projects', '-home-test-agent-foreign', 'sess-B', 'subagents')
      mkdirSync(ownSubagents, { recursive: true })
      mkdirSync(foreignSubagents, { recursive: true })
      writeFileSync(
        join(ownSubagents, 'agent-ownworker.jsonl'),
        buildJSONL(subAgentUserMsg('legit work')),
      )
      const foreignJsonl = join(foreignSubagents, 'agent-foreignworker.jsonl')
      writeFileSync(foreignJsonl, buildJSONL(subAgentUserMsg('about to vanish')))

      const h = startWatcherSync({ agentDir, agentCwd })
      // Reap the foreign file the way Claude Code's session cleanup
      // would, *before* the first poll runs.
      rmSync(foreignJsonl)
      h.poll()

      // Polls should not produce a "read error … ENOENT" log line.
      const enoentLogs = h.logs.filter((l) => l.includes('read error') && l.includes('ENOENT'))
      expect(enoentLogs).toHaveLength(0)
      // And the foreign agent must not be registered.
      expect(h.watcher.getRegistry().has('foreignworker')).toBe(false)
    })
  })

  describe('issue #1116 — terminal cleanup must not re-fire completion (Bug B)', () => {
    /**
     * Pre-#1116: after `TERMINAL_CLEANUP_GRACE_MS` (30s) elapsed,
     * `cleanupTerminalAgent` deleted the agentId from `registry` and
     * the JSONL path from `knownFiles`. The JSONL itself stayed on disk
     * (Claude Code keeps the file). The next `rescanSubagentDirs` poll
     * found the JSONL absent from `knownFiles`, re-added it, called
     * `registerAgent` with a fresh `completionNotified=false` entry,
     * read the terminal `turn_duration` line again, and fired a SECOND
     * `✓ Worker done` notification. This loops every grace-window
     * (~30s); for the operator it manifests as the same handful of
     * sub-agents announcing completion every ~6 min indefinitely.
     */

    let tmpRoot = ''
    const startedWatchers: Array<{ stop(): void }> = []

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-watcher-1116-rerun-'))
    })

    afterEach(() => {
      while (startedWatchers.length) {
        try { startedWatchers.pop()?.stop() } catch { /* ignore */ }
      }
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('does NOT re-fire "Worker done" after terminal cleanup grace expires and rescan rediscovers the JSONL', () => {
      const agentDir = join(tmpRoot, 'agent')
      const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'sess-A', 'subagents')
      mkdirSync(subagentsDir, { recursive: true })
      const jsonlPath = join(subagentsDir, 'agent-loopme.jsonl')

      // Boot with an empty subagents dir, then write a post-boot JSONL so
      // the agent is registered non-historical (otherwise the historical
      // shortcut suppresses the completion notification entirely).
      const notifications: string[] = []
      const intervals: Array<{ fn: () => void; ref: number }> = []
      const timeouts: Array<{ fn: () => void; ref: number }> = []
      let nextRef = 1
      const watcher = startSubagentWatcher({
        agentDir,
        // Card retired (#1122): completion surfaces via onFinish.
        onFinish: (info) => notifications.push(`✓ Worker done: ${info.description}`),
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
        setTimeout: (fn) => {
          const ref = nextRef++
          timeouts.push({ fn, ref })
          return { ref }
        },
        clearTimeout: (handle) => {
          const { ref } = handle as { ref: number }
          const idx = timeouts.findIndex((t) => t.ref === ref)
          if (idx !== -1) timeouts.splice(idx, 1)
        },
        log: () => {},
      })
      startedWatchers.push(watcher)

      const poll = () => intervals[0]?.fn()
      const fireScheduledCleanups = () => {
        let fired = 0
        while (timeouts.length) {
          const next = timeouts.shift()!
          next.fn()
          fired++
        }
        return fired
      }

      // Step 1: post-boot, write an in-flight JSONL → poll registers it.
      writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
      poll()
      expect(watcher.getRegistry().has('loopme')).toBe(true)
      expect(watcher.getRegistry().get('loopme')?.historical).toBe(false)

      // Step 2: append turn_duration → poll → state=done → "Worker done" fires.
      appendFileSync(jsonlPath, buildJSONL(subAgentTurnDuration()))
      poll()
      const firstRoundNotifs = notifications.filter((n) => n.includes('Worker done'))
      expect(firstRoundNotifs).toHaveLength(1)

      // Step 3: fire the terminal-cleanup grace timer (drains the
      // scheduled cleanup). Registry entry should be gone.
      const fired = fireScheduledCleanups()
      expect(fired).toBeGreaterThan(0)
      expect(watcher.getRegistry().has('loopme')).toBe(false)

      // Step 4: the JSONL is STILL on disk — Claude Code doesn't delete
      // it after the sub-agent finishes. The next poll re-scans the dir
      // and finds the file. Pre-fix: re-registers the agent and fires a
      // SECOND "Worker done". Post-fix: re-discovery is a no-op for
      // an agentId we've already announced as terminal.
      poll()
      const afterRescanNotifs = notifications.filter((n) => n.includes('Worker done'))
      expect(
        afterRescanNotifs.length,
        `Expected exactly 1 "Worker done" notification, got ${afterRescanNotifs.length}: ${JSON.stringify(afterRescanNotifs)}`,
      ).toBe(1)

      // And another poll for good measure — still exactly one.
      poll()
      poll()
      expect(notifications.filter((n) => n.includes('Worker done'))).toHaveLength(1)
    })
  })
})
