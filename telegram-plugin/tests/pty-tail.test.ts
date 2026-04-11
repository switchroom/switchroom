import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { V1Extractor } from '../pty-tail.js'

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
