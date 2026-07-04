import { describe, it, expect } from 'vitest'
import {
  projectTranscriptLine,
  projectSubagentLine,
  assistantLineCarriesAnswerSurface,
  type SessionEvent,
} from '../session-tail.js'

/**
 * CONTRACT / CANARY: the Claude Code transcript event shapes the liveness
 * surface depends on.
 *
 * switchroom has NO stream-json path — the status/liveness surface is derived
 * entirely by scraping Claude Code's on-disk per-session JSONL transcript
 * (see session-tail.ts header). Those shapes are UNDOCUMENTED and
 * version-fragile: a 2.1.x release changed a single logical assistant message
 * from "one JSONL line carrying all content blocks in source order" to
 * "multiple JSONL lines sharing one message.id, one content-block per line,
 * with the terminal stop_reason stamped on EVERY split line". That silently
 * dropped background sub-agent handbacks (the terminal fired on the leading
 * thinking split line before the answer text line was projected).
 *
 * This file PINS every wire shape the projector consumes, using fixtures
 * captured verbatim from a live 2.1.199 transcript. If an upstream release
 * changes the shape such that the projector stops emitting the expected
 * SessionEvents, THIS TEST FAILS LOUDLY at CI — instead of the card silently
 * blanking in production. When it fails: re-capture the fixtures from a real
 * transcript, confirm the projector still emits the same SessionEvents, and
 * update the fixtures + this contract deliberately.
 */

const kinds = (evs: SessionEvent[]): string[] => evs.map((e) => e.kind)

describe('Claude Code event-stream contract (canary)', () => {
  it('queue-operation enqueue carries the channel meta the gateway keys currentTurn on', () => {
    // enqueue is the ONLY event that carries chatId — losing it kills the
    // whole per-turn liveness surface (progress card, draft-mirror, floor).
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        '<channel source="telegram" chat_id="12345" message_id="678" message_thread_id="9">hi</channel>',
    })
    expect(projectTranscriptLine(line)).toEqual([
      {
        kind: 'enqueue',
        chatId: '12345',
        messageId: '678',
        threadId: '9',
        rawContent:
          '<channel source="telegram" chat_id="12345" message_id="678" message_thread_id="9">hi</channel>',
      },
    ])
  })

  it('assistant thinking block projects to a thinking event (phase-distinct signal)', () => {
    // 2.1.x thinking block shape: { type, thinking, signature }.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_a',
        stop_reason: 'tool_use',
        stop_details: { type: 'tool_use' }, // new field in 2.1.x — must be ignored gracefully
        content: [{ type: 'thinking', thinking: 'let me look', signature: 'sig' }],
      },
    })
    expect(kinds(projectTranscriptLine(line))).toEqual(['thinking'])
  })

  it('assistant tool_use block still carries {id, name, input}', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_b',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls' } },
    ])
  })

  it('user tool_result block still carries tool_use_id + is_error', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }],
      },
    })
    const evs = projectTranscriptLine(line)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'toolu_1', isError: true })
  })

  it('system/turn_duration remains the main-agent terminal', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 4200 })
    expect(projectTranscriptLine(line)).toEqual([{ kind: 'turn_end', durationMs: 4200 }])
  })

  it('SPLIT assistant message: each content-block is its own line sharing message.id', () => {
    // The 2.1.x split shape, captured verbatim. text and tool_use are NEVER
    // co-located anymore; each block is a separate line. The projector must
    // still emit each block's event exactly once, in order, across lines.
    const thinking = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_split', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 't', signature: 's' }] },
    })
    const tool = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_split', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/x' } }] },
    })
    const all = [...projectTranscriptLine(thinking), ...projectTranscriptLine(tool)]
    expect(kinds(all)).toEqual(['thinking', 'tool_use'])
    // No duplicate emission of the tool_use across the split lines.
    expect(all.filter((e) => e.kind === 'tool_use')).toHaveLength(1)
  })

  it('CANARY: end_turn stamped on the thinking-only split line must NOT be a terminal', () => {
    // The exact shape that dropped sub-agent handbacks: line 1 of a split
    // terminal message is thinking-only but carries stop_reason end_turn.
    expect(
      assistantLineCarriesAnswerSurface([{ type: 'thinking', thinking: 't', signature: 's' }]),
    ).toBe(false)
    // A content-bearing line (the real final answer) DOES carry the surface.
    expect(assistantLineCarriesAnswerSurface([{ type: 'text', text: 'final answer' }])).toBe(true)
    // Empty/whitespace text is not an answer surface.
    expect(assistantLineCarriesAnswerSurface([{ type: 'text', text: '   ' }])).toBe(false)

    const st = { hasEmittedStart: true }
    const thinkingEndTurn = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_t', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 't', signature: 's' }] },
    })
    expect(
      projectSubagentLine(thinkingEndTurn, 'agentX', st).some((e) => e.kind === 'sub_agent_turn_end'),
    ).toBe(false)
  })

  it('sub-agent kickoff: first user message string prompt fires sub_agent_started', () => {
    const st = { hasEmittedStart: false }
    const line = JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'Review PR #123 and report back.' },
    })
    expect(projectSubagentLine(line, 'agentX', st)).toEqual([
      { kind: 'sub_agent_started', agentId: 'agentX', firstPromptText: 'Review PR #123 and report back.' },
    ])
  })
})
