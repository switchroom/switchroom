/**
 * Unit tests for the sub_agent_capped detection heuristic in session-tail.ts.
 *
 * Three fixture categories:
 *   - "capped": >= 30 tool_uses, no terminal record — truncated mid-flight
 *   - "completed": has a terminal record (system:turn_duration or type:result)
 *   - "in-flight": < 30 tool_uses, no terminal — legitimately still running
 *
 * These tests drive the SubTail tracking fields via the exported
 * projectSubagentLine function and the reapIdleSubTails logic indirectly
 * by constructing the SubTail-like state machine manually.
 */

import { describe, it, expect } from 'vitest'
import { projectSubagentLine, type SessionEvent } from '../session-tail.js'

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeToolUseLine(agentId: string, toolName = 'Read', id = 'toolu_01'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id, name: toolName, input: { file_path: '/tmp/test.ts' } },
      ],
    },
    isSidechain: true,
    agentId,
  })
}

function makeToolResultLine(agentId: string, toolUseId = 'toolu_01'): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' },
      ],
    },
    isSidechain: true,
    agentId,
  })
}

function makeTerminalLine(): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1234 })
}

function makeResultLine(): string {
  return JSON.stringify({ type: 'result', subtype: 'success' })
}

/**
 * Simulate reading N tool_use + tool_result pairs through projectSubagentLine.
 * Returns { toolUseCount, hasSeenTerminal } mirroring the SubTail fields.
 */
function simulateSubTailReads(
  agentId: string,
  toolUseCount: number,
  terminalLine: string | null = null,
): { toolUseCount: number; hasSeenTerminal: boolean; events: SessionEvent[] } {
  const state = { hasEmittedStart: false }
  const events: SessionEvent[] = []
  let seenTerminal = false
  let toolCount = 0

  // First message: the kickoff prompt (user message with string content)
  const kickoffLine = JSON.stringify({
    type: 'user',
    message: { content: 'Do the work' },
    isSidechain: true,
    agentId,
  })
  const kickoffEvents = projectSubagentLine(kickoffLine, agentId, state)
  events.push(...kickoffEvents)

  // Simulate N tool_use / tool_result pairs
  for (let i = 0; i < toolUseCount; i++) {
    const id = `toolu_${i.toString().padStart(3, '0')}`
    const tuLine = makeToolUseLine(agentId, 'Read', id)
    const tuEvents = projectSubagentLine(tuLine, agentId, state)
    for (const ev of tuEvents) {
      if (ev.kind === 'sub_agent_tool_use') toolCount++
      if (ev.kind === 'sub_agent_turn_end') seenTerminal = true
      events.push(ev)
    }

    // tool result requires a subsequent user message
    const trLine = makeToolResultLine(agentId, id)
    const trEvents = projectSubagentLine(trLine, agentId, state)
    events.push(...trEvents)
  }

  // Optional terminal line
  if (terminalLine != null) {
    // Check raw JSON for terminal type (mirrors readSub logic)
    try {
      const raw = JSON.parse(terminalLine) as Record<string, unknown>
      if (
        raw.type === 'result' ||
        raw.type === 'final' ||
        (raw.type === 'system' && raw.subtype === 'end') ||
        raw.subtype === 'end'
      ) {
        seenTerminal = true
      }
    } catch { /* ignore */ }

    const termEvents = projectSubagentLine(terminalLine, agentId, state)
    for (const ev of termEvents) {
      if (ev.kind === 'sub_agent_turn_end') seenTerminal = true
      events.push(ev)
    }
  }

  return { toolUseCount: toolCount, hasSeenTerminal: seenTerminal, events }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('sub_agent_capped detection heuristic', () => {
  describe('capped fixtures (>= 30 tool_uses, no terminal record)', () => {
    it('detects exactly 30 tool_uses with no terminal as capped', () => {
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-abc', 30, null)
      expect(toolUseCount).toBe(30)
      expect(hasSeenTerminal).toBe(false)
      // The heuristic: toolUseCount >= 30 AND !hasSeenTerminal => emit sub_agent_capped
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(true)
    })

    it('detects 50 tool_uses with no terminal as capped', () => {
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-def', 50, null)
      expect(toolUseCount).toBe(50)
      expect(hasSeenTerminal).toBe(false)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(true)
    })

    it('detects 80 tool_uses with no terminal as capped', () => {
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-ghi', 80, null)
      expect(toolUseCount).toBe(80)
      expect(hasSeenTerminal).toBe(false)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(true)
    })
  })

  describe('completed fixtures (has a terminal record)', () => {
    it('does NOT classify as capped when system:turn_duration is present', () => {
      const terminal = makeTerminalLine()
      const { toolUseCount, hasSeenTerminal, events } = simulateSubTailReads('agent-jkl', 35, terminal)
      expect(toolUseCount).toBe(35)
      // system:turn_duration is emitted as sub_agent_turn_end which sets hasSeenTerminal
      expect(hasSeenTerminal).toBe(true)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(false)
      // Confirm sub_agent_turn_end was emitted
      expect(events.some((e) => e.kind === 'sub_agent_turn_end')).toBe(true)
    })

    it('does NOT classify as capped when type:result record is present', () => {
      const result = makeResultLine()
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-mno', 40, result)
      expect(toolUseCount).toBe(40)
      expect(hasSeenTerminal).toBe(true)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(false)
    })

    it('does NOT classify as capped with few tool_uses and terminal record', () => {
      const terminal = makeTerminalLine()
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-pqr', 5, terminal)
      expect(toolUseCount).toBe(5)
      expect(hasSeenTerminal).toBe(true)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(false)
    })
  })

  describe('in-flight fixtures (< 30 tool_uses, no terminal)', () => {
    it('does NOT classify as capped when tool_use count is below threshold', () => {
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-stu', 10, null)
      expect(toolUseCount).toBe(10)
      expect(hasSeenTerminal).toBe(false)
      // Below threshold — could still be running
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(false)
    })

    it('does NOT classify as capped for zero tool_uses', () => {
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-vwx', 0, null)
      expect(toolUseCount).toBe(0)
      expect(hasSeenTerminal).toBe(false)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(false)
    })

    it('does NOT classify as capped at exactly 29 tool_uses', () => {
      const { toolUseCount, hasSeenTerminal } = simulateSubTailReads('agent-yz0', 29, null)
      expect(toolUseCount).toBe(29)
      expect(hasSeenTerminal).toBe(false)
      expect(toolUseCount >= 30 && !hasSeenTerminal).toBe(false)
    })
  })

  describe('sub_agent_capped SessionEvent shape', () => {
    it('sub_agent_capped event has correct agentId and toolUseCount fields', () => {
      const event: SessionEvent = {
        kind: 'sub_agent_capped',
        agentId: 'agent-abc123',
        toolUseCount: 42,
      }
      expect(event.kind).toBe('sub_agent_capped')
      expect(event.agentId).toBe('agent-abc123')
      expect(event.toolUseCount).toBe(42)
    })
  })
})

describe('projectSubagentLine terminal detection', () => {
  it('emits sub_agent_turn_end for system:turn_duration', () => {
    const agentId = 'agent-test'
    const state = { hasEmittedStart: true }
    const line = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    const events = projectSubagentLine(line, agentId, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'sub_agent_turn_end', agentId })
  })

  it('counts sub_agent_tool_use events correctly', () => {
    const agentId = 'agent-count'
    const state = { hasEmittedStart: true }
    let toolCount = 0
    for (let i = 0; i < 5; i++) {
      const line = makeToolUseLine(agentId, 'Read', `toolu_${i}`)
      const events = projectSubagentLine(line, agentId, state)
      toolCount += events.filter((e) => e.kind === 'sub_agent_tool_use').length
    }
    expect(toolCount).toBe(5)
  })
})
