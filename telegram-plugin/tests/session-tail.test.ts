import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  projectTranscriptLine,
  projectSubagentLine,
  projectAssistantTextBlocks,
  sumUsageTokens,
  sanitizeCwdToProjectName,
  getProjectsDirForCwd,
  startSessionTail,
  type SessionEvent,
} from '../session-tail.js'

describe('sumUsageTokens', () => {
  it('sums input + output + cache_creation (cache_read excluded)', () => {
    expect(
      sumUsageTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      }),
    ).toBe(350)
  })

  it('excludes a large cache_read_input_tokens from the total', () => {
    // Locks in the deliberate exclusion: replayed cached context must not
    // inflate the "new work this turn" figure. A future regression that
    // re-adds cache_read makes this fail.
    expect(
      sumUsageTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 999_999,
        cache_creation_input_tokens: 200,
      }),
    ).toBe(350)
  })

  it('guards missing fields with 0', () => {
    expect(sumUsageTokens({ output_tokens: 42 })).toBe(42)
    expect(sumUsageTokens({})).toBe(0)
  })

  it('ignores the nested iterations / cache_creation breakdown (no double count)', () => {
    expect(
      sumUsageTokens({
        input_tokens: 2,
        output_tokens: 3,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 },
        iterations: [{ input_tokens: 2, output_tokens: 3 }],
      }),
    ).toBe(10)
  })

  it('returns 0 for null / non-object / non-numeric fields', () => {
    expect(sumUsageTokens(null)).toBe(0)
    expect(sumUsageTokens(undefined)).toBe(0)
    expect(sumUsageTokens('nope')).toBe(0)
    expect(sumUsageTokens({ input_tokens: 'x', output_tokens: null })).toBe(0)
  })
})

describe('sanitizeCwdToProjectName', () => {
  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeCwdToProjectName('/home/user/.switchroom/agents/assistant')).toBe(
      '-home-user--switchroom-agents-assistant',
    )
  })

  it('handles paths with dots', () => {
    expect(sanitizeCwdToProjectName('/foo.bar/baz')).toBe('-foo-bar-baz')
  })

  it('preserves leading/trailing alphanumerics', () => {
    expect(sanitizeCwdToProjectName('abc/def')).toBe('abc-def')
  })

  it('matches the openclaw research example', () => {
    // From the streaming research: cwd /mnt/c/Users/example/Documents
    // sanitizes to -mnt-c-Users-example-Documents
    expect(sanitizeCwdToProjectName('/mnt/c/Users/example/Documents')).toBe(
      '-mnt-c-Users-example-Documents',
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
        '<channel source="switchroom-telegram" chat_id="-1009999999999" message_id="103" user="meken" user_id="1234567890" ts="2026-04-11T07:04:23.000Z">\nGo look at my new project\n</channel>',
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
      { kind: 'tool_result', toolUseId: 'abc', toolName: null, isError: true, errorText: 'boom' },
    ])
  })

  it('parses tool_result with content-block-array shape — concatenates text blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'xyz',
            is_error: true,
            content: [
              { type: 'text', text: 'first line of error' },
              { type: 'text', text: 'second line with detail' },
              // Non-text blocks should be skipped without breaking
              { type: 'image', source: { type: 'base64', data: '...' } },
            ],
          },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'xyz',
        toolName: null,
        isError: true,
        errorText: 'first line of error\nsecond line with detail',
      },
    ])
  })

  it('parses tool_result with is_error truncates errorText to 500 chars', () => {
    const longText = 'A'.repeat(800)
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'long', is_error: true, content: longText },
        ],
      },
    })
    const result = projectTranscriptLine(line)
    expect(result).toHaveLength(1)
    const ev = result[0]
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(ev.errorText).toBeDefined()
    expect(ev.errorText!.length).toBe(500)
    expect(ev.errorText!.startsWith('AAAA')).toBe(true)
  })

  it('parses tool_result with is_error=false omits errorText', () => {
    // Success path — no error, no errorText captured.
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'ok', content: 'all good' },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_result', toolUseId: 'ok', toolName: null, isError: undefined, errorText: undefined },
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
      // Shared narrative contract: a lone text block (no tool_use after it)
      // is lastInMessage:true at blockIndex 0.
      { kind: 'text', text: 'Replied with comparison', blockIndex: 0, lastInMessage: true },
    ])
  })

  it('drops empty/whitespace-only text blocks (shared narrative contract)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '   \n  ' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    })
    // The empty text block is dropped; only the tool_use survives.
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'tool_use', toolName: 'Read', toolUseId: 'toolu_a', input: { file_path: '/a' } },
    ])
  })

  it('text block preceding a tool_use in the same message is lastInMessage:false', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Found both:' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    })
    const events = projectTranscriptLine(line)
    expect(events[0]).toEqual({ kind: 'text', text: 'Found both:', blockIndex: 0, lastInMessage: false })
  })

  it('text block AFTER the last tool_use is lastInMessage:true', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
          { type: 'text', text: 'Done.' },
        ],
      },
    })
    const events = projectTranscriptLine(line)
    const textEv = events.find((e) => e.kind === 'text')
    expect(textEv).toEqual({ kind: 'text', text: 'Done.', blockIndex: 1, lastInMessage: true })
  })

  it('the dead sub_agent_narrative kind is never emitted', () => {
    // The union member was removed; nothing in either projector emits it.
    const subLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'prose' }] },
    })
    const events = projectSubagentLine(subLine, 'X', { hasEmittedStart: true })
    expect(events.some((e) => (e as { kind: string }).kind === 'sub_agent_narrative')).toBe(false)
  })

  it('parses assistant message with multiple blocks (thinking + tool_use)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'tool_use', name: 'mcp__switchroom-telegram__reply', id: 'toolu_04' },
        ],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'thinking' },
      { kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply', toolUseId: 'toolu_04', input: undefined },
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
    // Lifted verbatim from a live ~/.switchroom/agents/assistant/.claude/projects/.../<sid>.jsonl
    const line =
      '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-04-11T07:04:25.333Z","sessionId":"00000000-0000-0000-0000-000000000000","content":"<channel source=\\"switchroom-telegram\\" chat_id=\\"-1009999999999\\" message_id=\\"103\\" user=\\"testuser\\" user_id=\\"1234567890\\" ts=\\"2026-04-11T07:04:23.000Z\\">\\nGo look at my new project\\n</channel>"}'
    const result = projectTranscriptLine(line)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'enqueue',
      chatId: '-1009999999999',
      messageId: '103',
    })
  })

  // ─── Live model capture (message.model) ──────────────────────────────
  it('emits a model event (first) from message.model on an assistant line', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_01', input: {} }],
      },
    })
    // Model event is emitted BEFORE the content events so a same-batch render
    // already reflects the current model.
    expect(projectTranscriptLine(line)).toEqual([
      { kind: 'model', model: 'claude-opus-4-8' },
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_01', input: {} },
    ])
  })

  it('skips a synthetic model sentinel (keeps no model event)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'thinking', thinking: '...' }],
      },
    })
    expect(projectTranscriptLine(line)).toEqual([{ kind: 'thinking' }])
  })

  it('omits the model event when message.model is absent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '...' }] },
    })
    expect(projectTranscriptLine(line)).toEqual([{ kind: 'thinking' }])
  })

  it('emits a main-tier usage event with the summed per-message token delta + message.id', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_main_1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
      },
    })
    const usage = projectTranscriptLine(line).find((e) => e.kind === 'usage')
    expect(usage).toEqual({ kind: 'usage', messageId: 'msg_main_1', totalTokens: 350 })
  })

  it('emits no main-tier usage event when the assistant line carries no usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_main_2',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
      },
    })
    expect(projectTranscriptLine(line).some((e) => e.kind === 'usage')).toBe(false)
  })

  it('carries a null messageId on the main-tier usage event when message.id is absent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 5, output_tokens: 5 },
        content: [{ type: 'text', text: 'working' }],
      },
    })
    const usage = projectTranscriptLine(line).find((e) => e.kind === 'usage')
    expect(usage).toEqual({ kind: 'usage', messageId: null, totalTokens: 10 })
  })
})

// ─── Bug 1 regression: per-file cursor state survives re-attachment ────
//
// Scenario: Claude Code's Agent/Task tool spawns a sub-agent which
// writes its own JSONL. The sub-agent's file briefly becomes
// newest-mtime in the projects dir, so `findActiveSessionFile` picks
// it and we re-target. Events in the sub-agent file get reported.
// Later, the parent JSONL mtime leads again (the parent resumes). If
// we seek to the end of the parent at re-attach time, we miss every
// event the parent wrote while we were watching the sub-agent (most
// critically: tool_result and turn_end, which means the progress card
// never flips items to done and never fires the final "Done" render).
//
// The fix: track cursors per absolute file path. On re-attach to a
// known file, restore the saved cursor; on detach, save the current
// cursor into the map. These tests exercise that round trip with a
// real temp directory and real files.
describe('startSessionTail — re-attach resumes from saved cursor', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tempDirs.length = 0
  })

  function mkProjectsDir(): { claudeHome: string; cwd: string; projectsDir: string } {
    const base = mkdtempSync(join(tmpdir(), 'session-tail-test-'))
    tempDirs.push(base)
    const cwd = join(base, 'agent')
    const claudeHome = join(base, 'claude-home')
    const projectsDir = getProjectsDirForCwd(cwd, claudeHome)
    mkdirSync(projectsDir, { recursive: true })
    return { claudeHome, cwd, projectsDir }
  }

  function setMtime(path: string, seconds: number): void {
    utimesSync(path, seconds, seconds)
  }

  async function wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  const assistantTextLine = (text: string): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'

  const turnEndLine = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 }) + '\n'

  it('resumes the parent JSONL from the saved cursor after a sub-agent JSONL briefly leads on mtime', async () => {
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()

    // Parent and sub-agent JSONL files. We manipulate mtimes directly
    // so the test is deterministic (newest-mtime wins).
    const parent = join(projectsDir, 'parent.jsonl')
    const sub = join(projectsDir, 'sub.jsonl')

    // Parent has some history already. Writing this BEFORE startSessionTail
    // guarantees the initial attach seeks past it (first attach seeks to
    // current end — we only ever want NEW events).
    writeFileSync(parent, assistantTextLine('initial parent'))
    setMtime(parent, 1_000_000) // older

    const events: SessionEvent[] = []
    const handle = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 50,
      onEvent: (ev) => { events.push(ev) },
    })

    try {
      // Give the initial rescan a chance to attach.
      await wait(120)
      expect(events).toHaveLength(0) // nothing new yet

      // Use mtimes rooted at "now" to out-rank any writes the fs does
      // automatically on append (append bumps mtime to wall-clock).
      const nowSec = Math.floor(Date.now() / 1000)

      // Sub-agent JSONL appears (empty first, so attach seeks-to-end at
      // position 0 — no "history" to skip). Only then do we append to
      // simulate the sub-agent writing incrementally.
      writeFileSync(sub, '')
      setMtime(sub, nowSec + 10)
      // Force parent to be "older" than sub so newest-mtime picks sub.
      setMtime(parent, nowSec + 5)
      await wait(150) // let rescan attach to the (newly newest) sub file

      appendFileSync(sub, assistantTextLine('from sub-agent'))
      // Keep sub freshest for the read.
      setMtime(sub, nowSec + 11)
      await wait(150)

      // Parent appends events — these are the ones that would be
      // SKIPPED if we seek-to-end on re-attach. Then bump parent's
      // mtime so the next rescan flips back to it.
      appendFileSync(parent, assistantTextLine('parent event A'))
      appendFileSync(parent, assistantTextLine('parent event B'))
      appendFileSync(parent, turnEndLine)
      setMtime(parent, nowSec + 20)
      await wait(250)

      // The sub-agent text and all three parent events must be present.
      const textEvents = events
        .filter((e) => e.kind === 'text')
        .map((e) => (e as Extract<SessionEvent, { kind: 'text' }>).text)
      expect(textEvents).toContain('from sub-agent')
      expect(textEvents).toContain('parent event A')
      expect(textEvents).toContain('parent event B')
      expect(events.some((e) => e.kind === 'turn_end')).toBe(true)
    } finally {
      handle.stop()
    }
  })
})

describe('projectSubagentLine', () => {
  it('emits sub_agent_started exactly once for the first user message (string content)', () => {
    const st = { hasEmittedStart: false }
    const line = JSON.stringify({
      isSidechain: true,
      agentId: 'aaa',
      type: 'user',
      message: { role: 'user', content: 'hello sub-agent' },
    })
    const events = projectSubagentLine(line, 'aaa', st)
    expect(events).toEqual([
      { kind: 'sub_agent_started', agentId: 'aaa', firstPromptText: 'hello sub-agent' },
    ])
    expect(st.hasEmittedStart).toBe(true)
    // Second user message → tool_results, NOT another sub_agent_started
    const line2 = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: false }],
      },
    })
    const events2 = projectSubagentLine(line2, 'aaa', st)
    expect(events2).toEqual([
      { kind: 'sub_agent_tool_result', agentId: 'aaa', toolUseId: 'toolu_x', isError: undefined },
    ])
  })

  it('emits sub_agent_model (first) from message.model on a sub-agent assistant line', () => {
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'sr-glm-5',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    expect(events[0]).toEqual({ kind: 'sub_agent_model', agentId: 'X', model: 'sr-glm-5' })
    expect(events[1].kind).toBe('sub_agent_tool_use')
  })

  it('skips a synthetic sub-agent model sentinel', () => {
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    expect(events.some((e) => e.kind === 'sub_agent_model')).toBe(false)
    expect(events[0].kind).toBe('sub_agent_tool_use')
  })

  it('emits sub_agent_usage with the summed per-message token delta + message.id', () => {
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    const usage = events.find((e) => e.kind === 'sub_agent_usage')
    expect(usage).toEqual({ kind: 'sub_agent_usage', agentId: 'X', messageId: 'msg_1', totalTokens: 350 })
  })

  it('emits no sub_agent_usage when the assistant line carries no usage', () => {
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    expect(events.some((e) => e.kind === 'sub_agent_usage')).toBe(false)
  })

  it('carries a null messageId when message.id is absent', () => {
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 5, output_tokens: 5 },
        content: [{ type: 'text', text: 'working' }],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    const usage = events.find((e) => e.kind === 'sub_agent_usage')
    expect(usage).toEqual({ kind: 'sub_agent_usage', agentId: 'X', messageId: null, totalTokens: 10 })
  })

  it('emits sub_agent_tool_use for regular tools; nested Agent fires ONLY nested_spawn', () => {
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
          { type: 'tool_use', id: 'toolu_b', name: 'Agent', input: { description: 'nested', prompt: 'nested-p' } },
        ],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    // 2 events: 1 sub_agent_tool_use (Read) + 1 nested_spawn (the Agent).
    // Per design §5.5 we do NOT also emit sub_agent_tool_use for the
    // nested Agent — that would surface the sub-sub-agent's description
    // as the parent sub-agent's currentTool and break "no recursion in
    // rendering."
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('sub_agent_tool_use')
    // The nested_spawn now ALSO carries the dispatch toolUseId + input so
    // the watcher can key the nested worker's registry row
    // (recordNestedSubagentDispatch — the depth-2+ card fix). Rendering is
    // unchanged: still no sub_agent_tool_use for the nested Agent.
    expect(events[1]).toEqual({
      kind: 'sub_agent_nested_spawn',
      agentId: 'X',
      toolUseId: 'toolu_b',
      input: { description: 'nested', prompt: 'nested-p' },
    })
  })

  it('emits sub_agent_text + sub_agent_tool_use in source order for [text, tool_use]', () => {
    // Sub-agent assistant messages can interleave text (preamble) and
    // tool_use blocks in a single `content` array. The projector MUST
    // emit them in source order so the progress-card reducer can pair
    // the preamble to the immediately-next tool_use on the same agent.
    const st = { hasEmittedStart: true }
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the reducer' },
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    })
    const events = projectSubagentLine(line, 'X', st)
    expect(events).toEqual([
      // text precedes a tool_use in the same message → lastInMessage:false
      { kind: 'sub_agent_text', agentId: 'X', text: 'Reading the reducer', blockIndex: 0, lastInMessage: false },
      {
        kind: 'sub_agent_tool_use',
        agentId: 'X',
        toolUseId: 'toolu_a',
        toolName: 'Read',
        input: { file_path: '/a' },
      },
    ])
  })

  it('emits sub_agent_turn_end on system turn_duration', () => {
    const st = { hasEmittedStart: true }
    const events = projectSubagentLine(
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 42 }),
      'X',
      st,
    )
    expect(events).toEqual([{ kind: 'sub_agent_turn_end', agentId: 'X' }])
  })

  it('emits sub_agent_turn_end after the text when the final assistant message stop_reason is end_turn', () => {
    // Background `Agent` workers (claude ≥2.1.156) never write the
    // system/turn_duration line, only a final assistant message with
    // stop_reason 'end_turn'. That IS the authoritative completion signal —
    // without treating it as terminal the card hung "running" until the
    // ~5-min stall-synthesis net fired (the screenshot bug).
    const st = { hasEmittedStart: true }
    const events = projectSubagentLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done. Fixed the bug.' }],
        },
      }),
      'X',
      st,
    )
    // Text first (so the final summary still renders), turn_end last.
    // A lone trailing text block (no tool_use after it) is lastInMessage:true.
    expect(events).toEqual([
      { kind: 'sub_agent_text', agentId: 'X', text: 'Done. Fixed the bug.', blockIndex: 0, lastInMessage: true },
      { kind: 'sub_agent_turn_end', agentId: 'X' },
    ])
  })

  // ── Upstream-shape regression (Claude Code ≥2.1.x split-message writes) ──
  // One logical assistant message is now persisted as MULTIPLE JSONL lines
  // sharing one message.id, one content-block per line, and the terminal
  // stop_reason (end_turn) is stamped on EVERY split line — including the
  // leading [thinking] line that precedes the [text: final answer] line.
  // Regression: firing the sub-agent terminal on the thinking-only line marks
  // the sub-agent done and hands back stale/empty text BEFORE the real handback
  // [text] line is projected. These pin the fix: the terminal must ride the
  // content-bearing line, not the thinking-only split preamble.
  it('does NOT emit sub_agent_turn_end on a thinking-only end_turn split line', () => {
    // The FIRST line of a split terminal message: thinking only, but carries
    // stop_reason end_turn (observed verbatim in 2.1.199 transcripts).
    const st = { hasEmittedStart: true }
    const events = projectSubagentLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_split',
          stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: 'deciding how to summarise', signature: 'sig' }],
        },
      }),
      'X',
      st,
    )
    // Thinking is a projection no-op for sub-agents; crucially, NO premature
    // terminal — the handback text has not been seen yet.
    expect(events.some((e) => e.kind === 'sub_agent_turn_end')).toBe(false)
  })

  it('emits the handback text THEN one turn_end across a split end_turn message', () => {
    // The full split terminal message, as two consecutive JSONL lines sharing
    // message.id — the shape that dropped background sub-agent handbacks.
    const st = { hasEmittedStart: true }
    const thinkingLine = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_split2',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '...', signature: 'sig' }],
      },
    })
    const textLine = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_split2',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Handback: the fix is in session-tail.' }],
      },
    })
    const all = [
      ...projectSubagentLine(thinkingLine, 'X', st),
      ...projectSubagentLine(textLine, 'X', st),
    ]
    // The handback text must be emitted, and exactly one turn_end, and the
    // text must come BEFORE the turn_end so the watcher captures the real
    // result before it marks the entry done.
    const textEvents = all.filter((e) => e.kind === 'sub_agent_text')
    const endEvents = all.filter((e) => e.kind === 'sub_agent_turn_end')
    expect(textEvents.length).toBe(1)
    expect((textEvents[0] as { text: string }).text).toBe('Handback: the fix is in session-tail.')
    expect(endEvents.length).toBe(1)
    const textIdx = all.findIndex((e) => e.kind === 'sub_agent_text')
    const endIdx = all.findIndex((e) => e.kind === 'sub_agent_turn_end')
    expect(textIdx).toBeLessThan(endIdx)
  })

  it('still fires terminal on the legacy single-line [thinking, text](end_turn) shape', () => {
    // Graceful degradation: the OLD one-line-all-blocks shape has a text block
    // on the same line, so the terminal fires exactly as before.
    const st = { hasEmittedStart: true }
    const events = projectSubagentLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: '...', signature: 'sig' },
            { type: 'text', text: 'Legacy handback.' },
          ],
        },
      }),
      'X',
      st,
    )
    const textIdx = events.findIndex((e) => e.kind === 'sub_agent_text')
    const endIdx = events.findIndex((e) => e.kind === 'sub_agent_turn_end')
    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(textIdx)
  })

  it('does NOT emit sub_agent_turn_end for a tool-using assistant message (stop_reason tool_use)', () => {
    // A mid-run assistant message that calls a tool has stop_reason 'tool_use'
    // and keeps going — it must not be mistaken for completion.
    const st = { hasEmittedStart: true }
    const events = projectSubagentLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }],
        },
      }),
      'X',
      st,
    )
    expect(events.some((e) => e.kind === 'sub_agent_turn_end')).toBe(false)
  })

  it('skips malformed lines silently', () => {
    const st = { hasEmittedStart: false }
    expect(projectSubagentLine('{not-json', 'X', st)).toEqual([])
    expect(projectSubagentLine('{}', 'X', st)).toEqual([])
    expect(st.hasEmittedStart).toBe(false)
  })
})

describe('idle sub-tail reap (MEM2)', () => {
  // Pre-MEM2 fix the per-sub-agent FSWatcher in startSessionTail
  // lived for the entire process lifetime. A long-running gateway
  // with sustained sub-agent load eventually FD-exhausted. The reap
  // logic is invoked from the rescan tick; full-path testing requires
  // injectable time, so we pin the structural shape via source-grep
  // and rely on the existing rescan-tick tests to prove the rest.
  it('source declares lastActivityAt + reap on the sub-tail path', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, join: joinPath } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const TEST_DIR = resolve(fileURLToPath(import.meta.url), '..')
    const REPO_ROOT = resolve(TEST_DIR, '..', '..')
    const src = readFileSync(joinPath(REPO_ROOT, 'telegram-plugin/session-tail.ts'), 'utf-8')

    expect(src).toContain('lastActivityAt: number')
    expect(src).toContain('reapIdleSubTails')
    expect(src).toContain('IDLE_FSWATCH_TTL_MS')
    // Must be invoked from the rescan tick, not just declared.
    expect(src).toMatch(/rescanSubagents\(\)\s*[\s\S]*?reapIdleSubTails\(\)/)
  })
})

describe('projectAssistantTextBlocks (shared text→narrative kernel)', () => {
  // Direct unit coverage for the now-live projection kernel. Both
  // projectTranscriptLine and projectSubagentLine derive their text events
  // through this one function; these tests pin its contract independently of
  // either caller. The `make` adapter here uses the main-agent `text` kind.
  const makeText = (text: string, blockIndex: number, lastInMessage: boolean): SessionEvent => ({
    kind: 'text',
    text,
    blockIndex,
    lastInMessage,
  })

  it('emits one narration event per non-empty text block, keyed by source index', () => {
    const out = projectAssistantTextBlocks(
      [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'Read', id: 't1' },
        { type: 'text', text: 'world' },
      ],
      makeText,
    )
    expect(out.size).toBe(2)
    expect(out.get(0)).toEqual({ kind: 'text', text: 'hello', blockIndex: 0, lastInMessage: false })
    expect(out.get(2)).toEqual({ kind: 'text', text: 'world', blockIndex: 2, lastInMessage: true })
  })

  it('drops empty and whitespace-only text blocks', () => {
    const out = projectAssistantTextBlocks(
      [
        { type: 'text', text: '' },
        { type: 'text', text: '   \n\t  ' },
        { type: 'text', text: 'kept' },
      ],
      makeText,
    )
    expect(out.size).toBe(1)
    expect(out.has(0)).toBe(false)
    expect(out.has(1)).toBe(false)
    expect(out.get(2)).toEqual({ kind: 'text', text: 'kept', blockIndex: 2, lastInMessage: true })
  })

  it('lastInMessage is false when a tool_use follows the text block in the same message', () => {
    const out = projectAssistantTextBlocks(
      [
        { type: 'text', text: 'preamble' },
        { type: 'tool_use', name: 'Bash', id: 't1' },
      ],
      makeText,
    )
    expect(out.get(0)).toEqual({ kind: 'text', text: 'preamble', blockIndex: 0, lastInMessage: false })
  })

  it('lastInMessage is true for a text block after the last tool_use (trailing narration)', () => {
    const out = projectAssistantTextBlocks(
      [
        { type: 'tool_use', name: 'Bash', id: 't1' },
        { type: 'text', text: 'done' },
      ],
      makeText,
    )
    expect(out.get(1)).toEqual({ kind: 'text', text: 'done', blockIndex: 1, lastInMessage: true })
  })

  it('the make adapter controls the wire kind (sub_agent_text tier)', () => {
    const out = projectAssistantTextBlocks(
      [{ type: 'text', text: 'sub preamble' }],
      (text, blockIndex, lastInMessage): SessionEvent => ({
        kind: 'sub_agent_text',
        agentId: 'A',
        text,
        blockIndex,
        lastInMessage,
      }),
    )
    expect(out.get(0)).toEqual({
      kind: 'sub_agent_text',
      agentId: 'A',
      text: 'sub preamble',
      blockIndex: 0,
      lastInMessage: true,
    })
  })
})
