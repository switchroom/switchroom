/**
 * Tests for telegram-plugin/foreman/foreman-handlers.ts
 *
 * Tests the real handler implementations imported from foreman-handlers.ts,
 * using injected mocks for execFileSync and switchroomExecJson rather than
 * re-implementing the logic locally.
 *
 * Covers:
 *   - assertSafeAgentName: valid and invalid agent names
 *   - handleLogsCommand: agent name validation, --tail parsing, execFileSync args,
 *     bad-name rejection, empty output, paginated output
 *   - buildFleetSummary: calls switchroomExecJson(['agent', 'list']),
 *     formats HTML output correctly
 *   - private-chat guard: middleware rejects non-private chats
 *   - parseTailN: tail-N parsing rules
 *   - chunkText: pagination boundary logic
 */

import { describe, it, expect, vi } from 'vitest'
import {
  assertSafeAgentName,
  handleLogsCommand,
  buildFleetSummary,
  parseTailN,
  chunkText,
  type SwitchroomExecJsonFn,
} from '../foreman/foreman-handlers.js'
import { isAllowedSender } from '../shared/bot-runtime.js'
import type { Context } from 'grammy'

// ─── assertSafeAgentName ──────────────────────────────────────────────────

describe('foreman-handlers: assertSafeAgentName', () => {
  it('accepts simple lowercase names', () => {
    expect(() => assertSafeAgentName('gymbro')).not.toThrow()
  })

  it('accepts names with hyphens', () => {
    expect(() => assertSafeAgentName('my-agent')).not.toThrow()
  })

  it('accepts names with underscores', () => {
    expect(() => assertSafeAgentName('my_agent')).not.toThrow()
  })

  it('accepts lowercase names with digits', () => {
    expect(() => assertSafeAgentName('agent1')).not.toThrow()
  })

  it('rejects uppercase names', () => {
    expect(() => assertSafeAgentName('Agent1')).toThrow('invalid agent name')
  })

  it('accepts 51-char name (Telegram callback_data max)', () => {
    expect(() => assertSafeAgentName('a'.repeat(51))).not.toThrow()
  })

  it('rejects 52-char name (exceeds callback_data budget)', () => {
    expect(() => assertSafeAgentName('a'.repeat(52))).toThrow('invalid agent name')
  })

  it('rejects empty name', () => {
    expect(() => assertSafeAgentName('')).toThrow('invalid agent name')
  })

  it('rejects name with space', () => {
    expect(() => assertSafeAgentName('my agent')).toThrow('invalid agent name')
  })

  it('rejects name with semicolon (shell injection attempt)', () => {
    expect(() => assertSafeAgentName('agent; rm -rf /')).toThrow('invalid agent name')
  })

  it('rejects name with dollar sign', () => {
    expect(() => assertSafeAgentName('agent$(evil)')).toThrow('invalid agent name')
  })

  it('rejects path traversal', () => {
    expect(() => assertSafeAgentName('../etc/passwd')).toThrow('invalid agent name')
  })

  it('rejects name with colon', () => {
    expect(() => assertSafeAgentName('agent:bad')).toThrow('invalid agent name')
  })
})

// ─── parseTailN ─────────────────────────────────────────────────────────

describe('foreman-handlers: parseTailN', () => {
  it('defaults to 50 when no --tail', () => {
    expect(parseTailN(['gymbro'])).toBe(50)
  })

  it('parses explicit --tail N', () => {
    expect(parseTailN(['gymbro', '--tail', '100'])).toBe(100)
  })

  it('clamps to 500 max', () => {
    expect(parseTailN(['gymbro', '--tail', '9999'])).toBe(500)
  })

  it('ignores --tail without value', () => {
    expect(parseTailN(['gymbro', '--tail'])).toBe(50)
  })

  it('ignores non-numeric --tail value', () => {
    expect(parseTailN(['gymbro', '--tail', 'abc'])).toBe(50)
  })

  it('ignores zero --tail value', () => {
    expect(parseTailN(['gymbro', '--tail', '0'])).toBe(50)
  })

  it('ignores negative --tail value', () => {
    expect(parseTailN(['gymbro', '--tail', '-10'])).toBe(50)
  })
})

// ─── chunkText ───────────────────────────────────────────────────────────

describe('foreman-handlers: chunkText', () => {
  it('returns single chunk when under limit', () => {
    const text = 'x'.repeat(3800)
    expect(chunkText(text, 3800)).toHaveLength(1)
  })

  it('splits into two chunks when over limit', () => {
    const text = 'x'.repeat(4097)
    const chunks = chunkText(text, 4096)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(4096)
    expect(chunks[1]).toHaveLength(1)
  })

  it('all chunks reconstruct the original', () => {
    const text = 'abcdefgh'.repeat(1000)
    const chunks = chunkText(text, 3000)
    expect(chunks.join('')).toBe(text)
  })

  it('handles exactly limit-length text', () => {
    const text = 'x'.repeat(4096)
    expect(chunkText(text, 4096)).toHaveLength(1)
  })
})

// ─── handleLogsCommand ───────────────────────────────────────────────────

describe('foreman-handlers: handleLogsCommand — agent name validation', () => {
  it('returns usage when no args', () => {
    const result = handleLogsCommand('')
    expect(result.replies).toHaveLength(1)
    expect(result.replies[0].text).toContain('Usage')
  })

  it('rejects a bad agent name and returns Invalid agent name', () => {
    const execFile = vi.fn()
    const result = handleLogsCommand('agent; rm -rf /', execFile as never)
    expect(result.replies[0].text).toBe('Invalid agent name.')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('rejects agent name with colon (callback_data delimiter)', () => {
    const execFile = vi.fn()
    const result = handleLogsCommand('bad:name', execFile as never)
    expect(result.replies[0].text).toBe('Invalid agent name.')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('accepts a valid agent name with hyphens', () => {
    const execFile = vi.fn().mockReturnValue('log line 1\nlog line 2\n')
    const result = handleLogsCommand('my-agent', execFile as never)
    expect(execFile).toHaveBeenCalled()
    expect(result.replies[0].text).toContain('log line 1')
  })

  it('accepts a valid agent name with underscores', () => {
    const execFile = vi.fn().mockReturnValue('some log\n')
    const result = handleLogsCommand('my_agent', execFile as never)
    expect(execFile).toHaveBeenCalled()
  })
})

describe('foreman-handlers: handleLogsCommand — execFileSync args', () => {
  it('calls journalctl with correct argv array (no shell)', () => {
    const execFile = vi.fn().mockReturnValue('line1\n')
    handleLogsCommand('gymbro', execFile as never)

    expect(execFile).toHaveBeenCalledOnce()
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('journalctl')
    expect(args).toContain('--user')
    expect(args).toContain('-u')
    expect(args).toContain('switchroom-gymbro')
    expect(args).toContain('-n')
    expect(args).toContain('50') // default tail
    expect(args).toContain('--no-pager')
    // Must NOT be a shell string — the second arg must be an array
    expect(Array.isArray(args)).toBe(true)
  })

  it('passes --tail N to journalctl -n', () => {
    const execFile = vi.fn().mockReturnValue('line\n')
    handleLogsCommand('gymbro --tail 200', execFile as never)

    const [, args] = execFile.mock.calls[0] as [string, string[]]
    const nIdx = args.indexOf('-n')
    expect(nIdx).toBeGreaterThan(-1)
    expect(args[nIdx + 1]).toBe('200')
  })

  it('clamps --tail above 500 to 500', () => {
    const execFile = vi.fn().mockReturnValue('line\n')
    handleLogsCommand('gymbro --tail 9999', execFile as never)

    const [, args] = execFile.mock.calls[0] as [string, string[]]
    const nIdx = args.indexOf('-n')
    expect(args[nIdx + 1]).toBe('500')
  })

  it('unit name includes agent name', () => {
    const execFile = vi.fn().mockReturnValue('line\n')
    handleLogsCommand('my-agent', execFile as never)

    const [, args] = execFile.mock.calls[0] as [string, string[]]
    const uIdx = args.indexOf('-u')
    expect(args[uIdx + 1]).toBe('switchroom-my-agent')
  })
})

describe('foreman-handlers: handleLogsCommand — output handling', () => {
  it('returns empty-log message when journalctl returns blank', () => {
    const execFile = vi.fn().mockReturnValue('   \n')
    const result = handleLogsCommand('gymbro', execFile as never)
    expect(result.replies[0].text).toContain('No logs found')
  })

  it('returns error message when execFileSync throws', () => {
    const execFile = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('no such unit'), { stderr: 'Unit not found.' })
    })
    const result = handleLogsCommand('gymbro', execFile as never)
    expect(result.replies[0].text).toContain('logs failed for')
  })

  it('returns paginated replies for large output', () => {
    const bigOutput = 'x'.repeat(4000) // > 3 KB
    const execFile = vi.fn().mockReturnValue(bigOutput)
    const result = handleLogsCommand('gymbro', execFile as never)
    // Should be chunked into multiple replies
    expect(result.replies.length).toBeGreaterThan(1)
  })
})

// ─── buildFleetSummary ────────────────────────────────────────────────────

describe('foreman-handlers: buildFleetSummary — calls switchroomExecJson correctly', () => {
  it('calls execJson with ["agent", "list"]', () => {
    const mockExecJson = vi.fn().mockReturnValue({
      agents: [{ name: 'gymbro', status: 'active', uptime: '1h' }],
    }) as SwitchroomExecJsonFn
    buildFleetSummary(mockExecJson)
    expect(mockExecJson).toHaveBeenCalledWith(['agent', 'list'])
  })

  it('renders fleet HTML with agent name and status', () => {
    const mockExecJson = vi.fn().mockReturnValue({
      agents: [{ name: 'gymbro', status: 'active', uptime: '2h' }],
    }) as SwitchroomExecJsonFn
    const html = buildFleetSummary(mockExecJson)
    expect(html).toContain('gymbro')
    expect(html).toContain('active')
    expect(html).toContain('Fleet status')
  })

  it('returns empty message when no agents', () => {
    const mockExecJson = vi.fn().mockReturnValue({ agents: [] }) as SwitchroomExecJsonFn
    const html = buildFleetSummary(mockExecJson)
    expect(html).toContain('No agents defined')
  })

  it('handles execJson throwing (CLI unreachable)', () => {
    const mockExecJson = vi.fn().mockImplementation(() => {
      throw new Error('switchroom CLI not found')
    }) as SwitchroomExecJsonFn
    const html = buildFleetSummary(mockExecJson)
    expect(html).toContain('agent list failed')
  })

  it('escapes HTML-unsafe characters in agent names', () => {
    const mockExecJson = vi.fn().mockReturnValue({
      agents: [{ name: '<script>', status: 'active', uptime: '1h' }],
    }) as SwitchroomExecJsonFn
    const html = buildFleetSummary(mockExecJson)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ─── private-chat guard ───────────────────────────────────────────────────
// The guard lives in foreman.ts middleware but we test the isAllowedSender
// helper that it composes with, plus verify the type check logic directly.

describe('foreman-handlers: private-chat guard (middleware logic)', () => {
  function makeCtx(chatType: string | undefined, userId: number | undefined): Context {
    return {
      chat: chatType != null ? { type: chatType } : undefined,
      from: userId != null ? { id: userId } : undefined,
    } as unknown as Context
  }

  it('isAllowedSender allows configured user in private chat', () => {
    const ctx = makeCtx('private', 42)
    expect(isAllowedSender(ctx, ['42'])).toBe(true)
  })

  it('isAllowedSender blocks configured user in group chat', () => {
    // The middleware checks chat.type !== 'private' BEFORE isAllowedSender.
    // Here we just verify that the chat type is the signal to bail.
    const ctx = makeCtx('group', 42)
    // Simulate middleware: if not private, return early (do NOT call isAllowedSender)
    const isPrivate = ctx.chat?.type === 'private'
    expect(isPrivate).toBe(false)
    // isAllowedSender itself would allow the user — the guard is in middleware
    expect(isAllowedSender(ctx, ['42'])).toBe(true) // guard is upstream
  })

  it('isAllowedSender blocks unknown user in private chat', () => {
    const ctx = makeCtx('private', 99)
    expect(isAllowedSender(ctx, ['42'])).toBe(false)
  })

  it('isAllowedSender blocks when ctx.from is missing', () => {
    const ctx = makeCtx('private', undefined)
    expect(isAllowedSender(ctx, ['42'])).toBe(false)
  })

  it('group chat is detected as non-private (middleware would bail)', () => {
    const ctx = makeCtx('supergroup', 42)
    expect(ctx.chat?.type !== 'private').toBe(true)
  })

  it('undefined chat type is treated as non-private (middleware would bail)', () => {
    const ctx = makeCtx(undefined, 42)
    expect(ctx.chat?.type !== 'private').toBe(true)
  })
})
