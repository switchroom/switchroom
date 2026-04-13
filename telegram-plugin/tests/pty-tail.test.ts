import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  V1Extractor,
  V1ToolActivityExtractor,
  shouldSuppressToolActivity,
  startPtyTail,
} from '../pty-tail.js'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Helper: feed a string into a fresh xterm Terminal and return it after
 * the parser has processed all bytes. Real Claude Code TUI output uses
 * ANSI escapes; we synthesize them here.
 */
async function feedToTerm(input: string, opts: { cols?: number; rows?: number } = {}): Promise<Terminal> {
  const term = new Terminal({
    cols: opts.cols ?? 132,
    rows: opts.rows ?? 40,
    scrollback: 5000,
    allowProposedApi: true,
  })
  await new Promise<void>(resolve => {
    term.write(input, () => resolve())
  })
  return term
}

describe('V1Extractor', () => {
  const extractor = new V1Extractor()

  it('returns null for an empty terminal', async () => {
    const term = await feedToTerm('')
    expect(extractor.extract(term)).toBeNull()
  })

  it('returns null when no clerk-telegram tool block is present', async () => {
    const term = await feedToTerm('● Bash(ls -la)\r\n  ⎿  total 4\r\n     drwx 2 user user\r\n')
    expect(extractor.extract(term)).toBeNull()
  })

  it('extracts a complete reply text on a single line', async () => {
    const tui = '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Hello world")\r\n'
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Hello world')
  })

  it('extracts a multi-line reply with continuation indentation', async () => {
    // Synthesized to match the real shape from the live server's service.log
    const tui = [
      '● clerk-telegram - reply (MCP)(chat_id: "-1009999999999", text: "Yes — I can',
      '                              attach files to replies. Images send as inline',
      '                              photos, and other file types go as documents (up',
      '                              to 50MB each). Just point me at a file path or ask',
      '                               me to generate/fetch something and I\'ll send it',
      '                              along.")',
      '',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).not.toBeNull()
    expect(result).toContain('Yes — I can attach files to replies')
    expect(result).toContain('Images send as inline photos')
    expect(result).toContain("along.")
    // Should NOT contain the closing '")'
    expect(result).not.toContain('")')
  })

  it('extracts an in-progress reply (no closing paren yet)', async () => {
    // Mid-stream: the text is still being generated, no `")` closer
    const tui = [
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Working on this',
      '                              for you, just need a second',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).not.toBeNull()
    expect(result).toContain('Working on this')
    expect(result).toContain('for you')
  })

  it('takes the most recent reply when there are several in the buffer', async () => {
    const tui = [
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "First reply")',
      '',
      '● Bash(echo hi)',
      '  ⎿  hi',
      '',
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Second reply, the latest one")',
      '',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Second reply, the latest one')
  })

  it('also matches stream_reply tool calls', async () => {
    const tui = '● clerk-telegram - stream_reply (MCP)(chat_id: "123", text: "Streaming partial")\r\n'
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Streaming partial')
  })

  it('stops accumulating at a new tool block (next bullet)', async () => {
    const tui = [
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Reply text',
      '                              continuation here',
      '● Bash(ls)',
      '  ⎿  output',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).toContain('Reply text')
    expect(result).toContain('continuation here')
    expect(result).not.toContain('Bash')
  })

  it('stops accumulating at a tool result marker (⎿)', async () => {
    const tui = [
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Done")',
      '  ⎿  sent (id: 100)',
      '',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Done')
  })

  it('handles ANSI escape sequences in the input correctly', async () => {
    // Real Claude Code output is wrapped in cursor positioning + colors.
    // The xterm parser should strip them; we just see the rendered text.
    const tui =
      '\x1b[2C\x1b[1;36m●\x1b[0m\x1b[1C\x1b[1mclerk-telegram - reply (MCP)\x1b[0m(chat_id: "123", text: "Bold reply")\r\n'
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Bold reply')
  })

  it('reports progressive growth as more bytes arrive', async () => {
    const term = new Terminal({ cols: 132, rows: 40, scrollback: 5000, allowProposedApi: true })
    // Feed in chunks
    await new Promise<void>(r => term.write('● clerk-telegram - reply (MCP)(chat_id: "1", text: "Hel', () => r()))
    expect(extractor.extract(term)).toBe('Hel')

    await new Promise<void>(r => term.write('lo wo', () => r()))
    expect(extractor.extract(term)).toBe('Hello wo')

    await new Promise<void>(r => term.write('rld")', () => r()))
    expect(extractor.extract(term)).toBe('Hello world')
  })

  it('returns null when buffer contains only banner / startup noise', async () => {
    const tui = [
      '────────────────────────────────────────',
      '▐▛███▜▌   Claude Code v2.1.101',
      '▝▜█████▛▘  Opus 4.6 (1M context) · Claude Max',
      '   Listening for channel messages from: server:clerk-telegram',
      '   Experimental · inbound messages will be pushed into this session',
      '────────────────────────────────────────',
      '❯',
      '────────────────────────────────────────',
      '⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBeNull()
  })

  it('has a stable version identifier for logging', () => {
    expect(extractor.version).toMatch(/^v1/)
  })

  // ─── Regression: text is NOT the last parameter ─────────────────────────
  //
  // The user-visible "duplicate Telegram message with leaked JSON" bug
  // came from V1Extractor assuming `text` was always the final param in
  // the tool call and terminating on the `")` close-paren sequence. When
  // the model passed `text` before `reply_to` / `format` / etc., the
  // extractor grabbed everything from `text: "` to the end-of-call `")`,
  // including `", reply_to: "86"` in the middle — which then got edited
  // into a draft-stream preview and surfaced as a second Telegram message
  // whose body contained literal JSON.

  it('extracts text correctly when it is NOT the last parameter', async () => {
    const tui = '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Hello", reply_to: "86")\r\n'
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Hello')
  })

  it('extracts text when followed by multiple trailing params', async () => {
    const tui =
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Done now", reply_to: "86", format: "text")\r\n'
    const term = await feedToTerm(tui)
    expect(extractor.extract(term)).toBe('Done now')
  })

  it('handles escaped double quotes inside text without early termination', async () => {
    const tui =
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Understood — I\\"ll stop the duplicate \\"progress stream + final reply\\" pattern", reply_to: "86")\r\n'
    // Widen the terminal so the long single line doesn't get hard-wrapped
    // by xterm at the default 132 cols — which would truncate the trailing
    // characters and look like a regression even though the parser is
    // fine.
    const term = await feedToTerm(tui, { cols: 400 })
    const result = extractor.extract(term)
    // Inner escaped quotes should appear as real quotes in the extracted
    // text. The terminator is the unescaped `"` after `pattern`.
    expect(result).toBe(
      'Understood — I"ll stop the duplicate "progress stream + final reply" pattern',
    )
    // And crucially: no `reply_to` leakage.
    expect(result).not.toContain('reply_to')
    expect(result).not.toContain('"86"')
  })

  it('handles escaped backslashes correctly', async () => {
    const tui =
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Windows path: C:\\\\temp\\\\file.txt", reply_to: "1")\r\n'
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).toBe('Windows path: C:\\temp\\file.txt')
    expect(result).not.toContain('reply_to')
  })

  it('handles escaped newline sequences inside text', async () => {
    const tui =
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Line one\\nLine two", reply_to: "1")\r\n'
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    // The continuation-line collapse turns the unescaped \n into a space.
    expect(result).toMatch(/^Line one\s+Line two$/)
    expect(result).not.toContain('reply_to')
  })

  it('does not include subsequent param names when text is mid-call', async () => {
    // This is the exact scenario that produced the bug screenshot.
    const tui =
      '● clerk-telegram - reply (MCP)(chat_id: "8248703757", text: "Short answer coming once I\\"ve looked.", reply_to: "86")\r\n'
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).toBe('Short answer coming once I"ve looked.')
    expect(result).not.toMatch(/reply_to/)
    expect(result).not.toMatch(/"86"/)
  })

  it('still handles the open-ended mid-stream case with text NOT last', async () => {
    // Partial render: text parameter has started but the closing quote
    // hasn't arrived yet. The extractor should return what it has so far.
    const tui =
      '● clerk-telegram - reply (MCP)(chat_id: "123", text: "Halfway through a thou'
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).toBe('Halfway through a thou')
  })

  it('stops at first unescaped closing quote even if more text follows', async () => {
    // Only the FIRST unescaped `"` terminates the string. Anything after
    // is a different param (or the tool-call close paren).
    const tui = '● clerk-telegram - reply (MCP)(chat_id: "1", text: "First", text: "Second")\r\n'
    const term = await feedToTerm(tui)
    // Extractor should latch onto the FIRST `text: "` and return its value
    // cleanly, NOT merge the two values.
    expect(extractor.extract(term)).toBe('First')
  })
})

describe('V1Extractor against real captured production output', () => {
  const extractor = new V1Extractor()
  it('extracts the rendered reply text from a real script -qfc service.log fragment', async () => {
    // This is the literal pattern observed in the live server's service.log:
    // "Yes — I can / attach files to replies. Images send as inline / photos..."
    // verified manually via xterm.js dump in earlier debugging.
    const tui = [
      '● clerk-telegram - reply (MCP)(chat_id: "-1009999999999", text: "Yes — I can',
      '                              attach files to replies. Images send as inline',
      '                              photos, and other file types go as documents (up',
      '                              to 50MB each). Just point me at a file path or ask',
      '                               me to generate/fetch something and I\'ll send it',
      '                              along.")',
      '',
      '● Sent. Confirmed to the user that I can attach images (inline) and other file',
      '  types (as documents), up to 50MB each.',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    const result = extractor.extract(term)
    expect(result).not.toBeNull()
    // The extractor's continuation logic collapses newlines + indentation
    // into spaces, so the final text reads as one flowing sentence.
    expect(result).toMatch(/^Yes — I can attach files to replies/)
    expect(result).toMatch(/along\.$/)
  })
})

describe('V1ToolActivityExtractor', () => {
  const ax = new V1ToolActivityExtractor()

  it('returns null for an empty terminal', async () => {
    const term = await feedToTerm('')
    expect(ax.extract(term)).toBeNull()
  })

  it('extracts a Bash tool call as a short status', async () => {
    const term = await feedToTerm('● Bash(git status)\r\n')
    expect(ax.extract(term)).toBe('Running Bash: git status')
  })

  it('extracts a Read tool call', async () => {
    const term = await feedToTerm('● Read(/home/user/foo.ts)\r\n')
    expect(ax.extract(term)).toBe('Reading file: /home/user/foo.ts')
  })

  it('extracts a Grep tool call, keeping only the first arg', async () => {
    const term = await feedToTerm('● Grep(pattern: "foo", path: "/bar")\r\n')
    const out = ax.extract(term)
    expect(out).toMatch(/^Searching with Grep: /)
    // Must NOT include the second `path:` arg
    expect(out).not.toContain('/bar')
  })

  it('returns null for clerk-telegram tool calls (owned by V1Extractor)', async () => {
    const term = await feedToTerm(
      '● clerk-telegram - reply (MCP)(chat_id: "1", text: "hi")\r\n',
    )
    expect(ax.extract(term)).toBeNull()
  })

  it('takes the most recent tool call when several are in the buffer', async () => {
    const tui = [
      '● Bash(ls)',
      '  ⎿  output',
      '● Read(/tmp/a.ts)',
      '  ⎿  ...',
      '● Grep(foo)',
      '',
    ].join('\r\n')
    const term = await feedToTerm(tui)
    expect(ax.extract(term)).toBe('Searching with Grep: foo')
  })

  it('truncates overlong inner arg', async () => {
    const longArg = 'x'.repeat(200)
    const term = await feedToTerm(`● Bash(${longArg})\r\n`, { cols: 400 })
    const out = ax.extract(term) ?? ''
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.startsWith('Running Bash: ')).toBe(true)
  })

  it('has a stable version identifier', () => {
    expect(ax.version).toMatch(/^v1/)
  })

  it('handles an unknown tool name with a generic verb', async () => {
    const term = await feedToTerm('● MyCustomTool(xyz)\r\n')
    expect(ax.extract(term)).toBe('Running MyCustomTool: xyz')
  })
})

describe('startPtyTail integration — onActivity wiring + dedup + throttle', () => {
  it('emits activity lines as tool-call bullets appear, deduping repeats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-activity-'))
    const logFile = join(dir, 'service.log')
    writeFileSync(logFile, '')

    const activities: string[] = []
    const partials: string[] = []
    const handle = startPtyTail({
      logFile,
      throttleMs: 10,
      onPartial: (t) => { partials.push(t) },
      activityExtractor: new V1ToolActivityExtractor(),
      onActivity: (t) => { activities.push(t) },
    })

    try {
      // Give the poll loop a chance to attach
      await new Promise(r => setTimeout(r, 250))

      appendFileSync(logFile, '● Bash(echo hi)\r\n')
      await new Promise(r => setTimeout(r, 400))

      // Duplicate buffer state → should NOT re-emit
      appendFileSync(logFile, '  ⎿  hi\r\n')
      await new Promise(r => setTimeout(r, 400))

      appendFileSync(logFile, '● Read(/tmp/foo.ts)\r\n')
      await new Promise(r => setTimeout(r, 400))

      expect(activities).toContain('Running Bash: echo hi')
      expect(activities).toContain('Reading file: /tmp/foo.ts')
      // Dedup check: 'Running Bash: echo hi' should appear exactly once,
      // not once per byte-batch.
      const bashCount = activities.filter(a => a === 'Running Bash: echo hi').length
      expect(bashCount).toBe(1)
      // Reply text should not have been emitted — no clerk-telegram marker in the log.
      expect(partials).toHaveLength(0)
    } finally {
      handle.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('preserves onPartial reply extraction when onActivity is also wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-mixed-'))
    const logFile = join(dir, 'service.log')
    writeFileSync(logFile, '')

    const activities: string[] = []
    const partials: string[] = []
    const handle = startPtyTail({
      logFile,
      throttleMs: 10,
      onPartial: (t) => { partials.push(t) },
      activityExtractor: new V1ToolActivityExtractor(),
      onActivity: (t) => { activities.push(t) },
    })

    try {
      await new Promise(r => setTimeout(r, 250))
      appendFileSync(logFile, '● Bash(ls)\r\n')
      await new Promise(r => setTimeout(r, 300))
      appendFileSync(
        logFile,
        '● clerk-telegram - reply (MCP)(chat_id: "1", text: "hello world")\r\n',
      )
      await new Promise(r => setTimeout(r, 400))

      expect(activities).toContain('Running Bash: ls')
      expect(partials.some(p => p.includes('hello world'))).toBe(true)
    } finally {
      handle.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})

describe('shouldSuppressToolActivity (bug 2: suppress noisy per-tool narration)', () => {
  it('suppresses Bash/Read/Write/Edit/Grep/Glob per-call narration', () => {
    // These are the core tools the user complained about — rapid-fire
    // narration like "Running Bash: cd .." per call is noise.
    expect(shouldSuppressToolActivity('Running Bash: git status')).toBe(true)
    expect(shouldSuppressToolActivity('Reading file: /tmp/foo.ts')).toBe(true)
    expect(shouldSuppressToolActivity('Writing file: /tmp/out.md')).toBe(true)
    expect(shouldSuppressToolActivity('Editing file: server.ts')).toBe(true)
    expect(shouldSuppressToolActivity('Searching with Grep: foo')).toBe(true)
    expect(shouldSuppressToolActivity('Searching with Glob: **/*.ts')).toBe(true)
  })

  it('passes through human-meaningful activity (sub-agent, web, custom tools)', () => {
    // These ARE useful to surface — they run long, and the user actually
    // wants to know the agent is doing them.
    expect(shouldSuppressToolActivity('Running sub-agent: @researcher')).toBe(false)
    expect(shouldSuppressToolActivity('Fetching URL: https://example.com')).toBe(false)
    expect(shouldSuppressToolActivity('Searching the web: foo')).toBe(false)
    // Unknown / custom tool goes through the generic "Running <Tool>"
    // path and must NOT be suppressed — only the named noisy set is.
    expect(shouldSuppressToolActivity('Running MyCustomTool: xyz')).toBe(false)
  })

  it('bug 2: sequence of Bash/Grep/Read activity lines is entirely suppressed from outbound stream', async () => {
    // End-to-end shape: simulate the V1ToolActivityExtractor emitting the
    // noisy per-tool lines (as it still will — the filter is at the
    // consumer layer). The filter should drop all of them before they
    // reach the stream. The test uses the extractor directly to produce
    // realistic strings, then runs them through the suppression check
    // to assert nothing leaks to outbound.
    const ax = new V1ToolActivityExtractor()
    const outbound: string[] = []
    const emitToStream = (line: string) => {
      if (shouldSuppressToolActivity(line)) return
      outbound.push(line)
    }

    for (const tui of [
      '● Bash(cd /tmp && ls)\r\n',
      '● Grep(pattern: "foo")\r\n',
      '● Read(/home/user/bar.ts)\r\n',
      '● Bash(git status)\r\n',
    ]) {
      const term = await feedToTerm(tui)
      const line = ax.extract(term)
      expect(line).not.toBeNull()
      emitToStream(line!)
    }

    // All four were noisy-core-tool narration → outbound must be empty.
    expect(outbound).toEqual([])
  })

  it('regression: suppresses spinner-verb prefixes (Reading/Writing/Editing/Searching)', () => {
    // Real production leak: Claude Code's in-progress spinner uses bare
    // verbs ("Reading…", "Writing…") which the bullet-line regex captures
    // as the tool token. activityVerb falls through to default
    // `Running ${tool}`, producing "Running Reading: ctrl+o to expand"
    // and friends. Prior suppression list (formatted "Reading file"
    // prefix only) missed these. Pin the fix.
    expect(shouldSuppressToolActivity('Running Reading: ctrl+o to expand')).toBe(true)
    expect(shouldSuppressToolActivity('Running Writing: ctrl+o to expand')).toBe(true)
    expect(shouldSuppressToolActivity('Running Editing: foo.ts')).toBe(true)
    expect(shouldSuppressToolActivity('Running Searching: pattern')).toBe(true)
    // Also the short tool-token aliases ("Read"/"Write"/"Edit") that the
    // generic default verb produces when the bullet line shows "● Read".
    expect(shouldSuppressToolActivity('Running Read: foo.ts')).toBe(true)
    expect(shouldSuppressToolActivity('Running Write: bar.md')).toBe(true)
    expect(shouldSuppressToolActivity('Running Edit: baz.ts')).toBe(true)
    expect(shouldSuppressToolActivity('Running Grep: pat')).toBe(true)
    expect(shouldSuppressToolActivity('Running Glob: **/*.ts')).toBe(true)
  })

  it('suppresses any line carrying a Claude Code TUI keyboard hint', () => {
    // The Telegram user cannot press ctrl+o, esc, shift+tab — surfacing
    // these hints in the activity lane is confusing UX (they tap and
    // nothing happens). Drop the line regardless of which tool prefix
    // dressed it up.
    expect(shouldSuppressToolActivity('Running sub-agent: ctrl+o to expand')).toBe(true)
    expect(shouldSuppressToolActivity('Fetching URL: esc to interrupt')).toBe(true)
    expect(shouldSuppressToolActivity('Running MyCustomTool: shift+tab to cycle')).toBe(true)
    expect(shouldSuppressToolActivity('Doing thing (Ctrl+O to expand)')).toBe(true) // case-insensitive
    expect(shouldSuppressToolActivity('Doing thing alt+enter to send')).toBe(true)
  })

  it('still passes clean human-meaningful activity through', () => {
    // Make sure the broadened filter didn't over-trigger on normal lines.
    expect(shouldSuppressToolActivity('Running sub-agent: @researcher')).toBe(false)
    expect(shouldSuppressToolActivity('Fetching URL: https://example.com')).toBe(false)
    expect(shouldSuppressToolActivity('Searching the web: claude api')).toBe(false)
    expect(shouldSuppressToolActivity('Running MyCustomTool: payload')).toBe(false)
  })
})
