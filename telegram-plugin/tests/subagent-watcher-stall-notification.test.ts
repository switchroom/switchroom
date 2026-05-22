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
  stallCalls: Array<{ agentId: string; idleMs: number; description: string }>
  unstallCalls: Array<{ agentId: string; description: string }>
  logs: string[]
  advance: (ms: number) => void
  watcher: ReturnType<typeof startSubagentWatcher>
  now: () => number
  fileContents: Map<string, Buffer>
  jsonlPath: string
}

function makeStallHarness(opts: {
  agentDir?: string
  stallThresholdMs?: number
  silentSynthesisStallThresholdMs?: number
  rescanMs?: number
  initialContent?: string
  agentId?: string
}): StallHarness {
  const {
    agentDir = '/home/user/.switchroom/agents/myagent',
    stallThresholdMs = 60_000,
    silentSynthesisStallThresholdMs,
    rescanMs = 500,
    agentId = 'test-stall-agent-01',
    initialContent,
  } = opts

  let currentTime = 1000
  const stallCalls: Array<{ agentId: string; idleMs: number; description: string }> = []
  const unstallCalls: Array<{ agentId: string; description: string }> = []
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
    // When the test doesn't explicitly distinguish the two thresholds,
    // mirror them so existing fixtures (which have toolCount=0 and a
    // simple "advance past 60s" model) keep working under the new
    // adaptive logic. New tests pass an explicit value to exercise the
    // silent-synthesis vs active-loop split.
    silentSynthesisStallThresholdMs: silentSynthesisStallThresholdMs ?? stallThresholdMs,
    rescanMs,
    onStall: (id, idle, desc) => stallCalls.push({ agentId: id, idleMs: idle, description: desc }),
    onUnstall: (id, desc) => unstallCalls.push({ agentId: id, description: desc }),
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

  return { stallCalls, unstallCalls, logs, advance, watcher, now: () => currentTime, fileContents, jsonlPath }
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

  // Test 11 (silent-synthesis): a sub-agent that hasn't fired any tools
  // yet should NOT trip the stall detector at the active-loop threshold
  // (60s) — it's almost certainly in long-form synthesis mode where the
  // model is still composing its first emit. The silent-synthesis
  // threshold (5min by default) is what gates that case. Pre-fix the
  // single 60s threshold tripped on plan/research sub-agents that ran
  // 2-3min legitimately, freezing the card at ⚠ until completion.
  it('does NOT trip stall at 60s when toolCount=0 (silent synthesis adaptive threshold)', () => {
    const agentId = 'stall-test-11'
    const { stallCalls, advance, watcher } = makeStallHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentSynthesisStallThresholdMs: 300_000, // 5min
      rescanMs: 500,
    })
    advance(500) // register
    const entry = watcher.getRegistry().get(agentId)
    if (entry) entry.historical = false
    advance(120_000) // 2min idle, far past 60s but well under 5min
    expect(stallCalls).toHaveLength(0)
    advance(200_000) // total ~5min 20s — past silent-synthesis threshold
    expect(stallCalls).toHaveLength(1)
    expect(stallCalls[0].agentId).toBe(agentId)
  })

  // Test 12 (un-stall transition): once JSONL activity returns after a
  // stall, the watcher must reset stallNotified, fire onUnstall, and
  // re-arm so a subsequent stall detects again. Pre-fix none of those
  // happened — the card stuck at ⚠ even when the sub-agent was clearly
  // alive again.
  it('fires onUnstall when activity returns after a stall and re-arms detection', () => {
    const agentId = 'stall-test-12'
    const { stallCalls, unstallCalls, advance, watcher, fileContents, jsonlPath } = makeStallHarness({
      agentId,
      // Force the active-loop threshold by giving the entry a tool right
      // away (avoids the silent-synthesis adaptive path). We append a
      // sub_agent_tool_use line in the initial content so toolCount > 0
      // by the first activity bump.
      stallThresholdMs: 60_000,
      silentSynthesisStallThresholdMs: 60_000, // keep flat for this test
      rescanMs: 500,
      initialContent: buildJSONL(
        subAgentUserMsg('background task'),
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-A', name: 'Read', input: { path: '/x' } }] } },
      ),
    })
    advance(500) // register + initial tail read (toolCount becomes 1)
    const entry = watcher.getRegistry().get(agentId)
    if (entry) entry.historical = false
    advance(65_000) // cross 60s — stall fires
    expect(stallCalls).toHaveLength(1)
    expect(unstallCalls).toHaveLength(0)

    // Append a fresh JSONL line — the sub-agent emits text, proving it's
    // alive. The watcher should reset stallNotified, fire onUnstall, and
    // re-arm so a *future* idle period can stall it again.
    const existing = fileContents.get(jsonlPath) ?? Buffer.from('')
    const resumeLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still alive' }] } }) + '\n'
    fileContents.set(jsonlPath, Buffer.concat([existing, Buffer.from(resumeLine, 'utf-8')]))
    advance(500) // poll picks up the new line

    expect(unstallCalls).toHaveLength(1)
    expect(unstallCalls[0].agentId).toBe(agentId)
    // stallNotified must be re-armed: another idle window crosses
    // threshold again and onStall fires a SECOND time.
    advance(65_000)
    expect(stallCalls).toHaveLength(2)
  })

  // Test 13 (un-stall + tool-loop adaptive): once tools have been used,
  // a 60s gap correctly re-trips the stall detector. Sanity check that
  // toolCount > 0 selects the active-loop threshold, not silent-synthesis.
  it('uses 60s threshold once toolCount>0 (active-loop adaptive)', () => {
    const agentId = 'stall-test-13'
    const { stallCalls, advance, watcher } = makeStallHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentSynthesisStallThresholdMs: 600_000, // way out — 10min
      rescanMs: 500,
      initialContent: buildJSONL(
        subAgentUserMsg('worker'),
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-A', name: 'Read', input: {} }] } },
      ),
    })
    advance(500) // register + tail (toolCount=1)
    const entry = watcher.getRegistry().get(agentId)
    if (entry) entry.historical = false
    advance(65_000) // 65s of silence with tools active → stall
    expect(stallCalls).toHaveLength(1)
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
