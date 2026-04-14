import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  projectTranscriptLine,
  sanitizeCwdToProjectName,
  getProjectsDirForCwd,
  startSessionTail,
  type SessionEvent,
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
