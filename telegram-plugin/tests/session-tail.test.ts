import { describe, it, expect } from 'vitest'
import {
  projectTranscriptLine,
  sanitizeCwdToProjectName,
  getProjectsDirForCwd,
} from '../session-tail.js'

describe('sanitizeCwdToProjectName', () => {
  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeCwdToProjectName('/home/user/.clerk/agents/assistant')).toBe(
      '-home-user--clerk-agents-assistant',
    )
  })

  it('handles paths with dots', () => {
    expect(sanitizeCwdToProjectName('/foo.bar/baz')).toBe('-foo-bar-baz')
  })

  it('preserves leading/trailing alphanumerics', () => {
    expect(sanitizeCwdToProjectName('abc/def')).toBe('abc-def')
  })

  it('matches the openclaw research example', () => {
    // From the streaming research: cwd /mnt/c/Users/kenth/SynologyDrive
    // sanitizes to -mnt-c-Users-kenth-SynologyDrive
    expect(sanitizeCwdToProjectName('/mnt/c/Users/kenth/SynologyDrive')).toBe(
      '-mnt-c-Users-kenth-SynologyDrive',
    )
  })
})

describe('getProjectsDirForCwd', () => {
  it('joins claudeHome + projects + sanitized cwd', () => {
    const result = getProjectsDirForCwd('/home/user/agent', '/home/user/.claude')
    expect(result).toBe('/home/user/.claude/projects/-home-user-agent')
  })
})

describe('projectTranscriptLine', () => {
  it('returns empty array for invalid JSON', () => {
    expect(projectTranscriptLine('not json {')).toEqual([])
    expect(projectTranscriptLine('')).toEqual([])
  })

  it('returns empty array for unknown event types', () => {
    expect(projectTranscriptLine(JSON.stringify({ type: 'permission-mode' }))).toEqual([])
    expect(projectTranscriptLine(JSON.stringify({ type: 'attachment' }))).toEqual([])
  })

  it('parses queue-operation enqueue with channel meta', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        '<channel source="clerk-telegram" chat_id="-1009999999999" message_id="103" user="meken" user_id="1234567890" ts="2026-04-11T07:04:23.000Z">\nGo look at my new project\n</channel>',
    })
    const result = projectTranscriptLine(line)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'enqueue',
      chatId: '-1009999999999',
      messageId: '103',
    })
  })

  it('parses queue-operation dequeue', () => {
    const line = JSON.stringify({ type: 'queue-operation', operation: 'dequeue' })
    expect(projectTranscriptLine(line)).toEqual([{ kind: 'dequeue' }])
  })

  it('parses assistant message with thinking block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: '...' }],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([{ kind: 'thinking' }])
  })

  it('parses assistant message with tool_use block (empty input)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_01', input: {} }],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_01', input: {} },
    ])
  })

  it('parses assistant message with tool_use block (carries input args)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 'toolu_02', input: { file_path: '/x/foo.ts' } },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_use', toolName: 'Read', toolUseId: 'toolu_02', input: { file_path: '/x/foo.ts' } },
    ])
  })

  it('parses tool_use with missing input as undefined', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_03' }],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_03', input: undefined },
    ])
  })

  it('parses tool_result with is_error flagged', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'abc', is_error: true, content: 'boom' },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_result', toolUseId: 'abc', toolName: null, isError: true },
    ])
  })

  it('parses assistant message with text block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Replied with comparison' }],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'text', text: 'Replied with comparison' },
    ])
  })

  it('parses assistant message with multiple blocks (thinking + tool_use)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'tool_use', name: 'mcp__clerk-telegram__reply', id: 'toolu_04' },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'thinking' },
      { kind: 'tool_use', toolName: 'mcp__clerk-telegram__reply', toolUseId: 'toolu_04', input: undefined },
    ])
  })

  it('parses user message with tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_abc123', content: 'sent' },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_result', toolUseId: 'toolu_abc123', toolName: null },
    ])
  })

  it('parses system turn_duration as turn_end', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 12345,
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'turn_end', durationMs: 12345 },
    ])
  })

  it('ignores other system subtypes', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'something_else',
    })
    expect(projectTranscriptLine(line)).toEqual([])
  })

  it('handles missing chat_id in enqueue gracefully', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'plain text without channel xml',
    })
    const result = projectTranscriptLine(line)
    expect(result[0]).toMatchObject({
      kind: 'enqueue',
      chatId: null,
      messageId: null,
    })
  })

  it('parses real production-shape enqueue line from server', () => {
    // Lifted verbatim from a live ~/.clerk/agents/assistant/.claude/projects/.../<sid>.jsonl
    const line =
      '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-04-11T07:04:25.333Z","sessionId":"00000000-0000-0000-0000-000000000000","content":"<channel source=\\"clerk-telegram\\" chat_id=\\"-1009999999999\\" message_id=\\"103\\" user=\\"mekenthompson\\" user_id=\\"1234567890\\" ts=\\"2026-04-11T07:04:23.000Z\\">\\nGo look at my new project\\n</channel>"}'
    const result = projectTranscriptLine(line)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'enqueue',
      chatId: '-1009999999999',
      messageId: '103',
    })
  })
})
