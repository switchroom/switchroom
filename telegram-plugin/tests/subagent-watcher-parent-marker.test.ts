/**
 * Issue #501: foreground sub-agent activity refreshes the parent's
 * `turn-active.json` mtime so the watchdog's TURN_HANG_SECS gate
 * (default 300s) doesn't kill the parent during a long sub-agent
 * task whose JSONL went silent for the threshold window.
 *
 * Background sub-agents are EXPLICITLY excluded — their lifecycle is
 * decoupled from the parent's turn boundary, so refreshing the parent
 * marker on background activity would mask real parent-side hangs.
 *
 * Belt-and-braces with PR #557's multi-signal progress gate in
 * bin/bridge-watchdog.sh — the marker touch closes the residual gap
 * when a sub-agent has no JSONL emits for the threshold window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fsReal from 'fs'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher } from '../subagent-watcher.js'
import type { SubagentLivenessDb } from '../subagent-watcher.js'
import {
  writeTurnActiveMarker,
  TURN_ACTIVE_MARKER_FILE,
} from '../gateway/turn-active-marker.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function subAgentUserMsg(text: string) {
  return { type: 'user', message: { content: [{ type: 'text', text }] } }
}

function subAgentToolUse(name: string, id: string) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } }
}

/**
 * Minimal fake DB matching SubagentLivenessDb.
 * Returns rows whose `jsonl_agent_id` matches the lookup parameter so the
 * watcher can resolve `background` for the parent-marker decision.
 */
function makeFakeDb(rows: Record<string, Record<string, unknown>>): SubagentLivenessDb {
  return {
    prepare(sql: string) {
      return {
        run() { /* noop — we don't assert DB writes here */ },
        get(...params: unknown[]) {
          if (/SELECT.*FROM subagents WHERE jsonl_agent_id/i.test(sql)) {
            const jsonlId = params[0] as string
            return Object.values(rows).find((r) => r['jsonl_agent_id'] === jsonlId) ?? null
          }
          return null
        },
      }
    },
  }
}

describe('subagent-watcher: parent turn-active marker refresh (#501)', () => {
  let tmpRoot = ''
  const startedWatchers: Array<{ stop(): void }> = []

  beforeEach(() => {
    vi.restoreAllMocks()
    tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-501-test-'))
  })

  afterEach(() => {
    while (startedWatchers.length) {
      try { startedWatchers.pop()?.stop() } catch { /* ignore */ }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function makeWatcher(opts: {
    agentDir: string
    db: SubagentLivenessDb | null
    parentStateDir: string | null
  }): { poll: () => void; watcher: ReturnType<typeof startSubagentWatcher> } {
    const intervals: Array<{ fn: () => void; ref: number }> = []
    let nextRef = 1
    const watcher = startSubagentWatcher({
      agentDir: opts.agentDir,
      sendNotification: () => { /* noop */ },
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
      log: () => { /* noop */ },
      db: opts.db,
      parentStateDir: opts.parentStateDir,
    })
    startedWatchers.push(watcher)
    return { poll: () => intervals[0]?.fn(), watcher }
  }

  function setupSubagentJsonl(jsonlContent: string, agentId: string): {
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

  it('foreground sub-agent JSONL growth touches the parent turn-active marker', () => {
    const jsonlStem = 'foreground01'
    const toolUseId = 'toolu_fg_01'
    const initialContent = buildJSONL(subAgentUserMsg('Do work'))
    const { agentDir, jsonlPath } = setupSubagentJsonl(initialContent, jsonlStem)

    // Parent state dir with a turn-active marker, mtime stamped well in the past
    // so a fresh touch is observable.
    const parentStateDir = join(tmpRoot, 'parent-state')
    mkdirSync(parentStateDir, { recursive: true })
    writeTurnActiveMarker(parentStateDir, {
      turnKey: 'k1',
      chatId: 'c1',
      threadId: null,
      startedAt: 0,
    })
    const markerPath = join(parentStateDir, TURN_ACTIVE_MARKER_FILE)
    // Force the mtime to "long ago" so the touch from the fix is the only
    // thing that could move it back to ~now.
    const longAgo = new Date(Date.now() - 10 * 60_000) // 10 minutes ago
    fsReal.utimesSync(markerPath, longAgo, longAgo)
    const mtimeBefore = statSync(markerPath).mtimeMs

    // Foreground row: background=0
    const db = makeFakeDb({
      [toolUseId]: {
        id: toolUseId,
        jsonl_agent_id: jsonlStem,
        background: 0,
        status: 'running',
      },
    })

    const h = makeWatcher({ agentDir, db, parentStateDir })

    // Boot scan registers the file as historical; subsequent appends are picked
    // up by the next poll. Append a tool_use to trigger a JSONL bump.
    const grown = initialContent + buildJSONL(subAgentToolUse('Bash', 'x1'))
    writeFileSync(jsonlPath, grown)
    h.poll()

    const mtimeAfter = statSync(markerPath).mtimeMs
    expect(mtimeAfter).toBeGreaterThan(mtimeBefore)
    // Sanity: marker payload still parseable
    expect(() => JSON.parse(readFileSync(markerPath, 'utf8'))).not.toThrow()
  })

  it('background sub-agent JSONL growth does NOT touch the parent marker', () => {
    const jsonlStem = 'background01'
    const toolUseId = 'toolu_bg_01'
    const initialContent = buildJSONL(subAgentUserMsg('Do background work'))
    const { agentDir, jsonlPath } = setupSubagentJsonl(initialContent, jsonlStem)

    const parentStateDir = join(tmpRoot, 'parent-state')
    mkdirSync(parentStateDir, { recursive: true })
    writeTurnActiveMarker(parentStateDir, {
      turnKey: 'k1',
      chatId: 'c1',
      threadId: null,
      startedAt: 0,
    })
    const markerPath = join(parentStateDir, TURN_ACTIVE_MARKER_FILE)
    const longAgo = new Date(Date.now() - 10 * 60_000)
    fsReal.utimesSync(markerPath, longAgo, longAgo)
    const mtimeBefore = statSync(markerPath).mtimeMs

    // Background row: background=1
    const db = makeFakeDb({
      [toolUseId]: {
        id: toolUseId,
        jsonl_agent_id: jsonlStem,
        background: 1,
        status: 'running',
      },
    })

    const h = makeWatcher({ agentDir, db, parentStateDir })

    const grown = initialContent + buildJSONL(subAgentToolUse('Bash', 'x1'))
    writeFileSync(jsonlPath, grown)
    h.poll()

    const mtimeAfter = statSync(markerPath).mtimeMs
    // Marker stays stale — background activity must not refresh it.
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it('parentStateDir unset → no marker touch attempted (preserves pre-#501 behaviour)', () => {
    const jsonlStem = 'fg_no_state_dir'
    const toolUseId = 'toolu_fg_02'
    const initialContent = buildJSONL(subAgentUserMsg('Work'))
    const { agentDir, jsonlPath } = setupSubagentJsonl(initialContent, jsonlStem)

    // We still write a marker into a known location — but we will NOT pass
    // parentStateDir to the watcher. The marker must therefore be untouched.
    const parentStateDir = join(tmpRoot, 'parent-state')
    mkdirSync(parentStateDir, { recursive: true })
    writeTurnActiveMarker(parentStateDir, {
      turnKey: 'k1', chatId: 'c1', threadId: null, startedAt: 0,
    })
    const markerPath = join(parentStateDir, TURN_ACTIVE_MARKER_FILE)
    const longAgo = new Date(Date.now() - 10 * 60_000)
    fsReal.utimesSync(markerPath, longAgo, longAgo)
    const mtimeBefore = statSync(markerPath).mtimeMs

    const db = makeFakeDb({
      [toolUseId]: {
        id: toolUseId,
        jsonl_agent_id: jsonlStem,
        background: 0,
        status: 'running',
      },
    })

    const h = makeWatcher({ agentDir, db, parentStateDir: null })

    const grown = initialContent + buildJSONL(subAgentToolUse('Bash', 'x1'))
    writeFileSync(jsonlPath, grown)
    h.poll()

    expect(statSync(markerPath).mtimeMs).toBe(mtimeBefore)
  })

  it('foreground activity is a no-op when no marker file exists (touchTurnActiveMarker is idempotent)', () => {
    const jsonlStem = 'fg_no_marker'
    const toolUseId = 'toolu_fg_03'
    const initialContent = buildJSONL(subAgentUserMsg('Work'))
    const { agentDir, jsonlPath } = setupSubagentJsonl(initialContent, jsonlStem)

    const parentStateDir = join(tmpRoot, 'parent-state-empty')
    mkdirSync(parentStateDir, { recursive: true })
    // Intentionally NO marker file.

    const db = makeFakeDb({
      [toolUseId]: {
        id: toolUseId,
        jsonl_agent_id: jsonlStem,
        background: 0,
        status: 'running',
      },
    })

    const h = makeWatcher({ agentDir, db, parentStateDir })

    const grown = initialContent + buildJSONL(subAgentToolUse('Bash', 'x1'))
    writeFileSync(jsonlPath, grown)

    // Should not throw — touchTurnActiveMarker silently no-ops on missing file.
    expect(() => h.poll()).not.toThrow()
    expect(fsReal.existsSync(join(parentStateDir, TURN_ACTIVE_MARKER_FILE))).toBe(false)
  })
})
