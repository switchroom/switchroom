/**
 * Tests for SubagentWatcher's post-stall terminal-synthesis path
 * (RFC §Bug 6 — background `Agent` dispatches in some Claude Code
 * versions write a JSONL that never ends with `system + turn_duration`,
 * so the canonical `sub_agent_turn_end` event never fires). Locks the
 * contract that:
 *
 *  1. After `silentStallTerminalMs` past the stall notification, the
 *     watcher synthesises terminal: flips `entry.state = 'done'`, fires
 *     `onStallTerminal`, fires the existing `onFinish` audit surface.
 *  2. Synthesis is idempotent: each entry triggers it at most once per
 *     lifetime (no repeat fires on every poll tick once the window
 *     elapses).
 *  3. A pre-window unstall (JSONL activity resumes) clears `stalledAt`
 *     and prevents synthesis. A subsequent re-stall starts the clock
 *     from scratch.
 *  4. Synthesis is suppressed for entries whose state is already `done`
 *     or `failed` — only `running + stallNotified` entries qualify.
 */

import { describe, it, expect, vi } from 'vitest'
import { startSubagentWatcher } from '../subagent-watcher.js'
import * as fs from 'fs'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}
function subAgentTurnEnd() {
  return { type: 'system', subtype: 'turn_duration', duration_ms: 1234 }
}
// An assistant message that STARTS a tool call (e.g. a long-running Bash
// loop). A tool-using turn's stop_reason is 'tool_use', never 'end_turn',
// so this does NOT terminalise the worker.
function subAgentToolUse(toolUseId: string, name = 'Bash') {
  return {
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: toolUseId, name, input: { command: 'sleep 600' } }],
    },
  }
}
// A user message carrying the matching tool_result — the tool call is done.
function subAgentToolResult(toolUseId: string) {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  }
}

interface Harness {
  stallCalls: Array<{ agentId: string; idleMs: number }>
  stallTerminalCalls: Array<{ agentId: string; description: string }>
  finishCalls: Array<{ agentId: string; outcome: string }>
  unstallCalls: Array<{ agentId: string }>
  logs: string[]
  advance: (ms: number) => void
  watcher: ReturnType<typeof startSubagentWatcher>
  fileContents: Map<string, Buffer>
  jsonlPath: string
  appendActivity: () => void
  appendLines: (...lines: object[]) => void
}

function makeHarness(opts: {
  agentId?: string
  stallThresholdMs?: number
  silentStallTerminalMs?: number
  rescanMs?: number
} = {}): Harness {
  const {
    agentId = 'bug6-agent',
    stallThresholdMs = 60_000,
    silentStallTerminalMs = 300_000,
    rescanMs = 500,
  } = opts

  let currentTime = 1000
  const stallCalls: Array<{ agentId: string; idleMs: number }> = []
  const stallTerminalCalls: Array<{ agentId: string; description: string }> = []
  const finishCalls: Array<{ agentId: string; outcome: string }> = []
  const unstallCalls: Array<{ agentId: string }> = []
  const logs: string[] = []

  const agentDir = '/home/user/.switchroom/agents/myagent'
  const sessionId = 'mock-session'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

  const fileContents = new Map<string, Buffer>()
  fileContents.set(
    jsonlPath,
    Buffer.from(buildJSONL(subAgentUserMsg('bg task')), 'utf-8'),
  )

  let lastOpenedPath: string | null = null
  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir) return true
      if (fileContents.has(ps)) return true
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
    statSync: ((p: fs.PathLike) => ({ size: fileContents.get(String(p))?.length ?? 0 }) as fs.Stats) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => {
      lastOpenedPath = String(p)
      return 42
    }) as unknown as typeof fs.openSync,
    closeSync: (() => { lastOpenedPath = null }) as typeof fs.closeSync,
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
    watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
  }

  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    stallThresholdMs,
    silentSynthesisStallThresholdMs: stallThresholdMs,
    silentStallTerminalMs,
    rescanMs,
    onStall: (id, idleMs) => stallCalls.push({ agentId: id, idleMs }),
    onUnstall: (id) => unstallCalls.push({ agentId: id }),
    onStallTerminal: (id, desc) => stallTerminalCalls.push({ agentId: id, description: desc }),
    onFinish: ({ agentId: id, outcome }) => finishCalls.push({ agentId: id, outcome }),
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

  const appendActivity = (): void => {
    // Append a `text` line so the watcher sees the JSONL grow and
    // flips the entry out of "stalled" via the unstall path.
    const cur = fileContents.get(jsonlPath) ?? Buffer.alloc(0)
    const more = buildJSONL({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'still working' }] },
    })
    fileContents.set(jsonlPath, Buffer.concat([cur, Buffer.from(more, 'utf-8')]))
  }

  const appendLines = (...lines: object[]): void => {
    const cur = fileContents.get(jsonlPath) ?? Buffer.alloc(0)
    const more = buildJSONL(...lines)
    fileContents.set(jsonlPath, Buffer.concat([cur, Buffer.from(more, 'utf-8')]))
  }

  return {
    stallCalls,
    stallTerminalCalls,
    finishCalls,
    unstallCalls,
    logs,
    advance,
    watcher,
    fileContents,
    jsonlPath,
    appendActivity,
    appendLines,
  }
}

// Files present at boot are flagged historical=true and stall+synth
// detection is suppressed for those (don't flood chat on restart).
// Tests flip the flag to simulate a post-boot discovery — same pattern
// as the existing stall-notification tests.
function unmarkHistorical(harness: Harness, agentId: string): void {
  const entry = harness.watcher.getRegistry().get(agentId)
  if (entry) entry.historical = false
}

describe('subagent-watcher post-stall terminal synthesis (RFC §Bug 6)', () => {
  it('synthesises terminal after silentStallTerminalMs past stall notification', () => {
    const agentId = 'bug6-synth-1'
    const h = makeHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 300_000,
      rescanMs: 500,
    })

    h.advance(500) // register
    unmarkHistorical(h, agentId)
    h.advance(62_000) // stall fires
    expect(h.stallCalls).toHaveLength(1)
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(0)

    // Advance to JUST BEFORE the post-stall window closes — synth must
    // not fire yet.
    h.advance(299_000)
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(0)

    // Cross the threshold — synthesis fires exactly once.
    h.advance(2_000)
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.stallTerminalCalls[0].agentId).toBe(agentId)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].agentId).toBe(agentId)
    // The synthesised path uses outcome 'completed' so downstream
    // consumers treat it the same as a real `sub_agent_turn_end` —
    // the audit log entry distinguishes via the `synthesis` log line.
    expect(h.finishCalls[0].outcome).toBe('completed')
  })

  it('is idempotent — does not re-fire on subsequent poll ticks', () => {
    const agentId = 'bug6-synth-idempotent'
    const h = makeHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 60_000,
      rescanMs: 500,
    })

    h.advance(500)
    unmarkHistorical(h, agentId)
    h.advance(62_000)
    h.advance(62_000) // synth fires
    expect(h.stallTerminalCalls).toHaveLength(1)

    // Many more polls past the window — synth must not re-fire.
    h.advance(60_000)
    h.advance(60_000)
    h.advance(60_000)
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
  })

  it('a pre-window unstall resets the synthesis clock', () => {
    const agentId = 'bug6-synth-unstall'
    const h = makeHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 60_000,
      rescanMs: 500,
    })

    h.advance(500)
    unmarkHistorical(h, agentId)
    h.advance(62_000) // stall fires
    expect(h.stallCalls).toHaveLength(1)

    // 30s into the post-stall window — append activity so the watcher
    // sees JSONL growth and fires onUnstall.
    h.advance(30_000)
    h.appendActivity()
    h.advance(1_000) // next poll reads the new bytes, fires onUnstall
    expect(h.unstallCalls).toHaveLength(1)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // Advance another 60s past unstall — would have synthesised if the
    // clock hadn't reset. It should not.
    h.advance(60_000)
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(0)
  })

  it('does NOT synthesise when an explicit sub_agent_turn_end lands inside the window', () => {
    const agentId = 'bug6-synth-explicit-end'
    const h = makeHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 300_000,
      rescanMs: 500,
    })

    h.advance(500)
    unmarkHistorical(h, agentId)
    h.advance(62_000) // stall fires
    expect(h.stallCalls).toHaveLength(1)

    // 100s into the post-stall window the worker writes its terminal
    // JSONL line — the watcher's existing turn_end path flips state to
    // 'done' and fires onFinish with outcome='completed'. The synth
    // path then sees state !== 'running' and skips.
    h.advance(100_000)
    const cur = h.fileContents.get(h.jsonlPath) ?? Buffer.alloc(0)
    h.fileContents.set(
      h.jsonlPath,
      Buffer.concat([cur, Buffer.from(buildJSONL(subAgentTurnEnd()), 'utf-8')]),
    )
    h.advance(1_000)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('completed')

    // Cross the synth threshold — synth must NOT fire (the explicit
    // path already terminated the entry).
    h.advance(300_000)
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(1) // unchanged
  })
})

describe('subagent-watcher in-flight tool-call gate (incident 2026-07-10)', () => {
  it('does NOT synthesise terminal while a tool call is still in flight, even past silentStallTerminalMs', () => {
    const agentId = 'inflight-no-synth'
    const h = makeHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 300_000,
      rescanMs: 500,
    })

    h.advance(500) // register
    unmarkHistorical(h, agentId)

    // Worker starts a long-running Bash tool call (a frame-capture loop).
    // The transcript ends in a tool_use with NO matching tool_result — the
    // JSONL then goes silent for the entire duration of the tool call.
    h.appendLines(subAgentToolUse('toolu_longbash'))
    h.advance(1_000) // poll reads the tool_use → in-flight set has 1 id

    // Idle far past the stall threshold: the stall badge still fires (the
    // worker IS quiet), but the entry is inside a legal long tool call.
    h.advance(62_000)
    expect(h.stallCalls).toHaveLength(1)

    // Idle well past silentStallTerminalMs — with the OLD code this would
    // finalise the live worker's card. The in-flight gate must suppress it.
    h.advance(400_000)
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('terminal synthesis deferred'))).toBe(true)
  })

  it('synthesises terminal once the tool_result lands and idle persists', () => {
    const agentId = 'inflight-then-synth'
    const h = makeHarness({
      agentId,
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 300_000,
      rescanMs: 500,
    })

    h.advance(500)
    unmarkHistorical(h, agentId)

    // In-flight tool call, then a long silent window — no synthesis.
    h.appendLines(subAgentToolUse('toolu_longbash'))
    h.advance(1_000)
    h.advance(62_000) // stall fires
    h.advance(400_000) // gated — no synthesis
    expect(h.stallTerminalCalls).toHaveLength(0)

    // The tool call finally completes: the matching tool_result lands.
    // This is JSONL growth, so the un-stall path fires and the in-flight
    // set drains — the gate re-opens.
    h.appendLines(subAgentToolResult('toolu_longbash'))
    h.advance(1_000)
    expect(h.unstallCalls).toHaveLength(1)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // Now the worker goes genuinely silent with nothing in flight: re-stall,
    // then cross the terminal window — synthesis fires exactly as designed.
    h.advance(62_000) // re-stall
    h.advance(302_000) // past silentStallTerminalMs from the new stall
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.stallTerminalCalls[0].agentId).toBe(agentId)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('completed')
  })
})
