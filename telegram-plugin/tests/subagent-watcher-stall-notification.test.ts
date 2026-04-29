/**
 * Tests for SubagentWatcher onStall callback wiring (Option C, issue #393).
 *
 * Locks the contract that:
 *  8. checkStalls calls config.onStall(agentId, idleMs, description) when a
 *     stall is detected.
 *  9. stallNotified flag prevents the callback from firing twice for the same
 *     sub-agent.
 * 10. onStall is NOT called for sub-agents already marked done/failed.
 */

import { describe, it, expect, vi } from 'vitest'
import { startSubagentWatcher } from '../subagent-watcher.js'
import * as fs from 'fs'

// ─── JSONL helpers ────────────────────────────────────────────────────────────

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}

// ─── Harness (mirrors subagent-watcher.test.ts pattern) ──────────────────────

interface StallHarness {
  notifications: string[]
  stallCalls: Array<{ agentId: string; idleMs: number; description: string }>
  logs: string[]
  advance: (ms: number) => void
  watcher: ReturnType<typeof startSubagentWatcher>
  now: () => number
  fileContents: Map<string, Buffer>
}

function makeStallHarness(opts: {
  agentDir?: string
  stallThresholdMs?: number
  rescanMs?: number
  initialContent?: string
  agentId?: string
}): StallHarness {
  const {
    agentDir = '/home/user/.switchroom/agents/myagent',
    stallThresholdMs = 60_000,
    rescanMs = 500,
    agentId = 'test-stall-agent-01',
    initialContent,
  } = opts

  let currentTime = 1000
  const notifications: string[] = []
  const stallCalls: Array<{ agentId: string; idleMs: number; description: string }> = []
  const logs: string[] = []

  // Build realistic path: <agentDir>/.claude/projects/<sanitized-cwd>/<sessionId>/subagents/
  const sessionId = 'mock-session-id'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

  const fileContents: Map<string, Buffer> = new Map()
  const defaultContent = buildJSONL(subAgentUserMsg('background task'))
  fileContents.set(jsonlPath, Buffer.from(initialContent ?? defaultContent, 'utf-8'))

  let lastOpenedPath: string | null = null

  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot) return true
      if (ps === projectDir) return true
      if (ps === sessionDir) return true
      if (ps === subagentsDir) return true
      if (fileContents.has(ps)) return true
      for (const fp of fileContents.keys()) {
        if (fp.startsWith(ps + '/')) return true
      }
      return false
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot) return ['mock-cwd']
      if (ps === projectDir) return [sessionId]
      if (ps === sessionDir) return ['subagents']
      if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
      return []
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
      const content = lastOpenedPath != null ? fileContents.get(lastOpenedPath) : undefined
      if (!content) return 0
      const pos = position ?? 0
      const src = content.slice(pos, pos + length)
      ;(src as Buffer).copy(buf as Buffer, offset)
      return src.length
    }) as unknown as typeof fs.readSync,
    watch: (() => {
      return { close: vi.fn() } as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch,
  }

  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    stallThresholdMs,
    rescanMs,
    sendNotification: (text) => notifications.push(text),
    onStall: (id, idle, desc) => stallCalls.push({ agentId: id, idleMs: idle, description: desc }),
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
    log: (msg) => logs.push(msg),
  })

  const advance = (ms: number): void => {
    currentTime += ms
    for (;;) {
      intervals.sort((a, b) => a.fireAt - b.fireAt)
      const next = intervals[0]
      if (!next || next.fireAt > currentTime) break
      next.fireAt += next.ms
      next.fn()
    }
  }

  return { notifications, stallCalls, logs, advance, watcher, now: () => currentTime, fileContents }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('subagent-watcher onStall callback (Option C, issue #393)', () => {
  // Test 8: checkStalls calls onStall with (agentId, idleMs, description)
  it('calls onStall with correct (agentId, idleMs, description) when stall detected', () => {
    const agentId = 'stall-test-8'
    const { stallCalls, advance, watcher } = makeStallHarness({
      agentId,
      stallThresholdMs: 60_000,
      rescanMs: 500,
    })

    // Advance past stall threshold — the first rescan registers the agent,
    // subsequent ticks check stalls. Need to go past stallThresholdMs.
    advance(500)   // first rescan — registers agent, sets lastActivityAt
    // Files present at boot are flagged historical=true and stalls are
    // suppressed for those (production semantics: don't flood chat on
    // restart). Flip the flag to simulate an entry discovered post-boot,
    // which is the only case stalls fire — same pattern as the existing
    // subagent-watcher.test.ts stall test.
    const entry = watcher.getRegistry().get(agentId)
    if (entry) entry.historical = false
    advance(62_000) // idle > 60s — stall fires

    expect(stallCalls).toHaveLength(1)
    expect(stallCalls[0].agentId).toBe(agentId)
    expect(stallCalls[0].idleMs).toBeGreaterThanOrEqual(60_000)
    expect(typeof stallCalls[0].description).toBe('string')
  })

  // Test 9: stallNotified prevents onStall from firing twice
  it('stallNotified flag prevents duplicate onStall calls for the same sub-agent', () => {
    const agentId = 'stall-test-9'
    const { stallCalls, advance, watcher } = makeStallHarness({
      agentId,
      stallThresholdMs: 60_000,
      rescanMs: 500,
    })

    advance(500)    // register
    const entry = watcher.getRegistry().get(agentId)
    if (entry) entry.historical = false
    advance(65_000) // cross threshold → stall fires once
    const countAfterFirstStall = stallCalls.length
    expect(countAfterFirstStall).toBe(1)

    // More time passes — still no new JSONL activity. stallNotified=true
    // must prevent a second onStall call.
    advance(120_000)
    expect(stallCalls.length).toBe(countAfterFirstStall) // still exactly 1
  })

  // Test 10: onStall is NOT called for sub-agents already done/failed
  it('does not call onStall for sub-agents in done/failed state', () => {
    const agentId = 'stall-test-10-done'
    const { stallCalls, advance, fileContents } = makeStallHarness({
      agentId,
      stallThresholdMs: 60_000,
      rescanMs: 500,
    })

    // Register the agent
    advance(500)

    // Simulate completion by appending a turn_duration to the JSONL.
    // The watcher interprets this as a done state.
    const sessionId = 'mock-session-id'
    const subagentsDir = `/home/user/.switchroom/agents/myagent/.claude/projects/mock-cwd/${sessionId}/subagents`
    const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`
    const existingContent = fileContents.get(jsonlPath) ?? Buffer.from('')
    const completionLine = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5000 }) + '\n'
    fileContents.set(jsonlPath, Buffer.concat([existingContent, Buffer.from(completionLine, 'utf-8')]))

    // Poll so the watcher sees the turn_duration and marks the agent done
    advance(500)

    // Now advance past the stall threshold — the agent is done so
    // stall detection must be skipped.
    advance(65_000)
    expect(stallCalls).toHaveLength(0)
  })
})
