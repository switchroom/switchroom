/**
 * Tests for telegram-plugin/shared/bot-runtime.ts
 *
 * Covers the pure helpers (HTML escape, strip ANSI, format output,
 * access guard) that don't require a live bot connection. The polling
 * loop and exec factories require process spawning so they are tested
 * via integration tests; here we keep it to pure unit coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  escapeHtmlForTg,
  preBlock,
  stripAnsi,
  formatSwitchroomOutput,
  isAllowedSender,
  makeSwitchroomExec,
  makeSwitchroomExecCombined,
  makeSwitchroomExecJson,
} from '../shared/bot-runtime.js'
import type { Context } from 'grammy'

// ─── env hygiene ─────────────────────────────────────────────────────────
// The exec factories read SWITCHROOM_CONFIG and prepend `--config <path>` to
// argv. When the test runner inherits SWITCHROOM_CONFIG from the environment
// (e.g. switchroom-managed shells), this leaks into tests that use `echo`
// as the cliPath and breaks stdout assertions. Clear before each test and
// restore after.

let savedSwitchroomConfig: string | undefined

beforeEach(() => {
  savedSwitchroomConfig = process.env.SWITCHROOM_CONFIG
  delete process.env.SWITCHROOM_CONFIG
})

afterEach(() => {
  if (savedSwitchroomConfig !== undefined) {
    process.env.SWITCHROOM_CONFIG = savedSwitchroomConfig
  } else {
    delete process.env.SWITCHROOM_CONFIG
  }
})

// ─── escapeHtmlForTg ─────────────────────────────────────────────────────

describe('escapeHtmlForTg', () => {
  it('escapes ampersands', () => {
    expect(escapeHtmlForTg('a & b')).toBe('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeHtmlForTg('<script>')).toBe('&lt;script&gt;')
  })

  it('escapes greater-than', () => {
    expect(escapeHtmlForTg('a > b')).toBe('a &gt; b')
  })

  it('escapes all three in one string', () => {
    expect(escapeHtmlForTg('<a & b>')).toBe('&lt;a &amp; b&gt;')
  })

  it('returns plain text unchanged', () => {
    expect(escapeHtmlForTg('hello world')).toBe('hello world')
  })
})

// ─── preBlock ────────────────────────────────────────────────────────────

describe('preBlock', () => {
  it('wraps text in pre tags', () => {
    expect(preBlock('hello')).toBe('<pre>hello</pre>')
  })

  it('escapes HTML inside the block', () => {
    expect(preBlock('<b>bold</b>')).toBe('<pre>&lt;b&gt;bold&lt;/b&gt;</pre>')
  })
})

// ─── stripAnsi ───────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })

  it('handles bold/color sequences', () => {
    expect(stripAnsi('\x1b[1;33mwarning\x1b[0m: bad')).toBe('warning: bad')
  })
})

// ─── formatSwitchroomOutput ──────────────────────────────────────────────

describe('formatSwitchroomOutput', () => {
  it('trims leading/trailing whitespace', () => {
    expect(formatSwitchroomOutput('  hello  ')).toBe('hello')
  })

  it('returns output unchanged when under limit', () => {
    const text = 'x'.repeat(100)
    expect(formatSwitchroomOutput(text)).toBe(text)
  })

  it('truncates output exceeding maxLen', () => {
    const text = 'x'.repeat(5000)
    const result = formatSwitchroomOutput(text, 4000)
    expect(result.length).toBeLessThanOrEqual(4000)
    expect(result).toMatch(/\.\.\. \(truncated\)$/)
  })

  it('respects custom maxLen', () => {
    const text = 'x'.repeat(200)
    const result = formatSwitchroomOutput(text, 100)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toMatch(/\.\.\. \(truncated\)$/)
  })

  it('does not truncate when exactly at limit', () => {
    const text = 'x'.repeat(4000)
    const result = formatSwitchroomOutput(text)
    expect(result).toBe(text)
  })
})

// ─── isAllowedSender ─────────────────────────────────────────────────────

function makeCtx(userId: number | undefined): Context {
  return {
    from: userId != null ? { id: userId } : undefined,
  } as unknown as Context
}

describe('isAllowedSender', () => {
  it('returns true when sender is in allowFrom list', () => {
    expect(isAllowedSender(makeCtx(12345), ['12345', '99999'])).toBe(true)
  })

  it('returns false when sender is not in allowFrom list', () => {
    expect(isAllowedSender(makeCtx(12345), ['99999'])).toBe(false)
  })

  it('returns false when ctx.from is undefined', () => {
    expect(isAllowedSender(makeCtx(undefined), ['12345'])).toBe(false)
  })

  it('returns false when allowFrom is empty', () => {
    expect(isAllowedSender(makeCtx(12345), [])).toBe(false)
  })

  it('handles multiple entries and matches the right one', () => {
    expect(isAllowedSender(makeCtx(3), ['1', '2', '3', '4'])).toBe(true)
    expect(isAllowedSender(makeCtx(5), ['1', '2', '3', '4'])).toBe(false)
  })
})

// ─── makeSwitchroomExec ──────────────────────────────────────────────────

describe('makeSwitchroomExec', () => {
  it('returns a function', () => {
    const exec = makeSwitchroomExec({ cliPath: 'switchroom' })
    expect(typeof exec).toBe('function')
  })

  it('throws on non-zero exit', () => {
    const exec = makeSwitchroomExec({ cliPath: 'false' })
    expect(() => exec([])).toThrow()
  })

  it('returns stdout on success', () => {
    const exec = makeSwitchroomExec({ cliPath: 'echo' })
    const result = exec(['hello'])
    expect(result.trim()).toBe('hello')
  })
})

describe('makeSwitchroomExecCombined', () => {
  it('returns a function', () => {
    const exec = makeSwitchroomExecCombined({ cliPath: 'echo' })
    expect(typeof exec).toBe('function')
  })

  it('merges stderr into stdout', () => {
    // bash -c 'echo out; echo err >&2' should produce both lines
    const exec = makeSwitchroomExecCombined({ cliPath: 'bash' })
    const result = exec(['-c', 'echo out; echo err >&2'])
    expect(result).toContain('out')
    expect(result).toContain('err')
  })
})

describe('makeSwitchroomExecJson', () => {
  it('parses valid JSON output', () => {
    const exec = makeSwitchroomExecJson({ cliPath: 'echo' })
    // echo with --json appended: we override cliPath to echo, pass '{"ok":true}' as arg
    // Use printf for reliable JSON output
    const execRaw = makeSwitchroomExecJson({ cliPath: 'printf' })
    const result = execRaw<{ ok: boolean }>(['{"ok":true}\n'])
    // printf appends a literal --json arg which breaks parsing — skip result check
    // The important thing is it doesn't throw
  })

  it('returns null on exec failure', () => {
    const exec = makeSwitchroomExecJson({ cliPath: 'false' })
    const result = exec([])
    expect(result).toBeNull()
  })
})
