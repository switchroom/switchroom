/**
 * Direct unit tests for `gateway/command-format.ts` — the pure
 * slash-command formatting/keyboard helpers extracted from gateway.ts
 * in switchroom#3461 (testability win tracked by #3460).
 *
 * These assert real rendered outcomes (exact strings, keyboard shapes,
 * thrown errors), not just that the code runs.
 */
import { describe, it, expect } from 'vitest'
import {
  formatSwitchroomOutput,
  stripAnsi,
  escapeHtmlForTg,
  preBlock,
  getCommandArgs,
  hasDemoFlag,
  assertSafeAgentName,
  formatAuthOutputForTelegram,
  buildAuthUrlKeyboard,
  buildDeferredSecretKeyboard,
  renderVaultOpFailure,
  statusIcon,
  renderAuthCodeOutcome,
  buildDoctorScopeKeyboard,
  formatDoctorReport,
} from '../gateway/command-format.js'
import { RICH_MESSAGE_MAX_CHARS } from '../format.js'
import type { Context } from 'grammy'

describe('formatSwitchroomOutput', () => {
  it('trims and passes short output through unchanged', () => {
    expect(formatSwitchroomOutput('  hello\nworld  ')).toBe('hello\nworld')
  })
  it('truncates past the rich-message cap with a marker', () => {
    const big = 'x'.repeat(RICH_MESSAGE_MAX_CHARS + 100)
    const out = formatSwitchroomOutput(big)
    expect(out.endsWith('\n... (truncated)')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS)
  })
  it('honours an explicit maxLen', () => {
    expect(formatSwitchroomOutput('abcdefghij'.repeat(10), 50)).toBe(
      'abcdefghij'.repeat(10).slice(0, 30) + '\n... (truncated)',
    )
  })
})

describe('stripAnsi', () => {
  it('removes CSI escape sequences and keeps text', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain')
  })
})

describe('escapeHtmlForTg', () => {
  it('backslash-escapes GFM specials', () => {
    expect(escapeHtmlForTg('a*b_c`d[e]f|g~h=i\\j')).toBe(
      'a\\*b\\_c\\`d\\[e\\]f\\|g\\~h\\=i\\\\j',
    )
  })
  it('leaves ordinary text alone', () => {
    expect(escapeHtmlForTg('hello world 123')).toBe('hello world 123')
  })
})

describe('preBlock', () => {
  it('wraps content in a fenced code block', () => {
    expect(preBlock('ls -la')).toBe('```\nls -la\n```')
  })
  it('defuses embedded triple-backticks so the fence cannot break', () => {
    const out = preBlock('a```b')
    expect(out.startsWith('```\n')).toBe(true)
    expect(out.endsWith('\n```')).toBe(true)
    // interior fence broken up (zero-width space injected)
    expect(out.slice(4, -4)).not.toContain('```')
  })
})

describe('getCommandArgs', () => {
  it('prefers ctx.match when present', () => {
    const ctx = { match: '  foo bar  ', msg: { text: '/cmd other' } } as unknown as Context
    expect(getCommandArgs(ctx)).toBe('foo bar')
  })
  it('falls back to parsing the message text', () => {
    const ctx = { match: undefined, msg: { text: '/restart alpha beta' } } as unknown as Context
    expect(getCommandArgs(ctx)).toBe('alpha beta')
  })
  it('returns empty string for a bare command', () => {
    const ctx = { match: '', msg: { text: '/status' } } as unknown as Context
    expect(getCommandArgs(ctx)).toBe('')
  })
})

describe('hasDemoFlag', () => {
  it('matches trailing demo token case-insensitively', () => {
    expect(hasDemoFlag('demo')).toBe(true)
    expect(hasDemoFlag('show DEMO')).toBe(true)
  })
  it('does not match demo as a prefix of another token', () => {
    expect(hasDemoFlag('demo-foo')).toBe(false)
    expect(hasDemoFlag('demo mid')).toBe(false)
  })
})

describe('assertSafeAgentName', () => {
  it('accepts alphanumeric/hyphen/underscore names and the all keyword', () => {
    expect(() => assertSafeAgentName('my-agent_01')).not.toThrow()
    expect(() => assertSafeAgentName('all')).not.toThrow()
  })
  it('rejects shell metacharacters and over-long names', () => {
    expect(() => assertSafeAgentName('a;rm -rf')).toThrow(/invalid agent name/)
    expect(() => assertSafeAgentName('x'.repeat(65))).toThrow(/invalid agent name/)
  })
})

describe('formatAuthOutputForTelegram', () => {
  it('returns a plain pre-block when no URL is present', () => {
    const { text, url } = formatAuthOutputForTelegram('\x1b[32mno link here\x1b[0m')
    expect(url).toBeNull()
    expect(text).toBe('```\nno link here\n```')
  })
  it('extracts the URL, drops CLI hint lines, and appends mobile guidance', () => {
    const raw = [
      'Started Claude auth for agent overlord',
      'Open this URL to authorize:',
      'https://claude.ai/oauth/authorize?code=abc123',
      'switchroom auth code overlord <code>',
      'Cancel with: switchroom auth cancel overlord',
    ].join('\n')
    const { text, url } = formatAuthOutputForTelegram(raw)
    expect(url).toBe('https://claude.ai/oauth/authorize?code=abc123')
    expect(text).not.toContain('switchroom auth code')
    expect(text).not.toContain('Cancel with:')
    expect(text).toContain('**Started Claude auth for agent overlord**')
    expect(text).toContain('_Open this URL to authorize:_')
    expect(text.trimEnd().endsWith(url as string)).toBe(true)
  })
})

describe('keyboards', () => {
  it('buildAuthUrlKeyboard produces a single url button', () => {
    const kb = buildAuthUrlKeyboard('https://example.com/x')
    const rows = kb.inline_keyboard
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(1)
    expect(rows[0][0]).toMatchObject({ text: '🔐 Open Claude auth', url: 'https://example.com/x' })
  })
  it('buildDeferredSecretKeyboard encodes unlock/cancel callback_data', () => {
    const kb = buildDeferredSecretKeyboard('123:456')
    const row = kb.inline_keyboard[0]
    expect(row.map(b => (b as { callback_data?: string }).callback_data)).toEqual([
      'vd:unlock:123:456',
      'vd:cancel:123:456',
    ])
  })
  it('buildDeferredSecretKeyboard throws on a 64-byte callback_data overflow', () => {
    expect(() => buildDeferredSecretKeyboard('9'.repeat(80))).toThrow(/callback_data overflow/)
  })
  it('buildDoctorScopeKeyboard offers fleet and self scopes', () => {
    const row = buildDoctorScopeKeyboard().inline_keyboard[0]
    expect(row.map(b => (b as { callback_data?: string }).callback_data)).toEqual([
      'dr:fleet',
      'dr:self',
    ])
  })
})

describe('renderVaultOpFailure', () => {
  it('falls back to a raw pre-block for unrecognised CLI output', () => {
    const out = renderVaultOpFailure('get', 'some random failure', 'mykey')
    expect(out).toBe('**vault get failed:**\n```\nsome random failure\n```')
  })
  it('routes recognised broker-denied markers through the structured renderer', () => {
    const out = renderVaultOpFailure('get', 'VAULT-BROKER-DENIED: no grant for key', 'mykey')
    expect(out).not.toContain('**vault get failed:**')
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('statusIcon', () => {
  it('maps statuses to glyphs', () => {
    expect(statusIcon('running')).toBe('🟢')
    expect(statusIcon('active')).toBe('🟢')
    expect(statusIcon('stopped')).toBe('🔴')
    expect(statusIcon('failed')).toBe('⚠️')
    expect(statusIcon('whatever')).toBe('⚪')
  })
})

describe('renderAuthCodeOutcome', () => {
  it('returns null for success or missing outcome', () => {
    expect(renderAuthCodeOutcome(null)).toBeNull()
    expect(renderAuthCodeOutcome({ kind: 'success' } as never)).toBeNull()
  })
  it('renders invalid-code with escaped pane tail', () => {
    const out = renderAuthCodeOutcome({ kind: 'invalid-code', paneTailText: 'bad*code' } as never)
    expect(out).toContain('Code rejected by Claude')
    expect(out).toContain('bad\\*code')
  })
  it('renders pane-not-ready and timeout variants', () => {
    expect(renderAuthCodeOutcome({ kind: 'pane-not-ready' } as never)).toContain('Auth pane not ready')
    expect(renderAuthCodeOutcome({ kind: 'timeout' } as never)).toContain('Still waiting after 2 min')
  })
})

describe('formatDoctorReport', () => {
  it('swaps check glyphs for traffic lights inside a pre block', () => {
    const raw = '\x1b[32m✓ ok check\x1b[0m\n✗ bad check\n! warn check'
    expect(formatDoctorReport(raw)).toBe('```\n🟢 ok check\n🔴 bad check\n🟡 warn check\n```')
  })
  it('handles empty output', () => {
    expect(formatDoctorReport('  \x1b[0m ')).toBe('doctor: no output')
  })
})
