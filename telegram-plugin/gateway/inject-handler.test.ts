/**
 * Unit tests for the /inject Telegram handler (#725 epic UX upgrade).
 *
 * The handler is factored out of gateway.ts so we can exercise it
 * without booting grammy/Bot. Real tmux is never touched — the inject
 * function is mocked via the InjectDeps seam.
 *
 * Run with: npx vitest run telegram-plugin/gateway/inject-handler.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import type { Context } from 'grammy'
import { handleInjectCommand, type InjectDeps, type InjectAccent } from './inject-handler.js'
import { InjectError, INJECT_COMMANDS, type InjectResult } from '../../src/agents/inject.js'

function fakeCtx(): Context {
  return {} as unknown as Context
}

interface CapturedReply {
  text: string
  opts?: { html?: boolean; accent?: InjectAccent }
}

function makeDeps(overrides: Partial<InjectDeps> = {}): {
  deps: InjectDeps
  replies: CapturedReply[]
} {
  const replies: CapturedReply[] = []
  const deps: InjectDeps = {
    isAuthorized: () => true,
    inject: vi.fn().mockResolvedValue({
      outcome: 'ok',
      output: 'mock',
      truncated: false,
      command: '/cost',
      meta: INJECT_COMMANDS.get('/cost') ?? null,
    } satisfies InjectResult),
    reply: async (_ctx, text, opts) => {
      replies.push({ text, opts })
    },
    getAgentName: () => 'gymbro',
    getArgs: () => '/cost',
    escapeHtml: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    preBlock: (s) => `<pre>${s}</pre>`,
    ...overrides,
  }
  return { deps, replies }
}

function okResult(verb: string, output: string, truncated = false): InjectResult {
  return {
    outcome: 'ok',
    output,
    truncated,
    command: verb,
    meta: INJECT_COMMANDS.get(verb) ?? null,
    ...(truncated ? { diagnostic: 'truncated_output' as const } : {}),
  }
}

function noOutputResult(verb: string): InjectResult {
  return {
    outcome: 'ok_no_output',
    output: '',
    truncated: false,
    command: verb,
    meta: INJECT_COMMANDS.get(verb) ?? null,
  }
}

function failedResult(
  verb: string,
  errorCode: NonNullable<InjectResult['errorCode']>,
  errorMessage: string,
): InjectResult {
  return {
    outcome: 'failed',
    output: '',
    truncated: false,
    command: verb,
    meta: INJECT_COMMANDS.get(verb) ?? null,
    errorCode,
    errorMessage,
  }
}

describe('handleInjectCommand — guards', () => {
  it('drops messages from unauthorized senders without replying', async () => {
    const { deps, replies } = makeDeps({ isAuthorized: () => false })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies).toHaveLength(0)
    expect(deps.inject).not.toHaveBeenCalled()
  })

  it('replies with usage when no slash-command argument is provided', async () => {
    const inject = vi.fn()
    const { deps, replies } = makeDeps({ getArgs: () => '', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(inject).not.toHaveBeenCalled()
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toContain('Usage')
    expect(replies[0].text).toContain('/cost')
  })
})

describe('handleInjectCommand — outcome=ok', () => {
  it('renders verb + pre-block, accent=done', async () => {
    const inject = vi.fn().mockResolvedValue(okResult('/cost', 'Total cost: $0.42'))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies).toHaveLength(1)
    expect(replies[0].opts?.accent).toBe('done')
    expect(replies[0].text).toContain('✅')
    expect(replies[0].text).toContain('<code>/cost</code>')
    expect(replies[0].text).toContain('<pre>Total cost: $0.42</pre>')
  })

  it('appends <i>truncated</i> when output truncated', async () => {
    const inject = vi.fn().mockResolvedValue(okResult('/cost', 'a lot of text', true))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].text).toContain('<i>truncated</i>')
    expect(replies[0].opts?.accent).toBe('done')
  })

  it('prepends slash if the operator omitted it', async () => {
    const inject = vi.fn().mockResolvedValue(okResult('/cost', 'ok'))
    const { deps } = makeDeps({ getArgs: () => 'cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(inject).toHaveBeenCalledWith('gymbro', '/cost')
  })
})

describe('handleInjectCommand — outcome=ok_no_output', () => {
  it('uses silentNote when meta provides one (e.g. /compact)', async () => {
    const inject = vi.fn().mockResolvedValue(noOutputResult('/compact'))
    const { deps, replies } = makeDeps({ getArgs: () => '/compact', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('done')
    expect(replies[0].text).toContain('<code>/compact</code>')
    expect(replies[0].text).toContain('compaction runs silently')
    expect(replies[0].text).not.toContain('<pre>')
  })

  it('warns with accent=issue when expectsOutput=true and capture empty (/cost)', async () => {
    const inject = vi.fn().mockResolvedValue(noOutputResult('/cost'))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('issue')
    expect(replies[0].text).toContain('⚠️')
    expect(replies[0].text).toContain('empty capture')
  })

  it('bare ack with accent=done when expectsOutput=false and no silentNote (/clear)', async () => {
    const inject = vi.fn().mockResolvedValue(noOutputResult('/clear'))
    const { deps, replies } = makeDeps({ getArgs: () => '/clear', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('done')
    expect(replies[0].text).toContain('<code>/clear</code>')
    expect(replies[0].text).not.toContain('empty capture')
    expect(replies[0].text).not.toContain('<pre>')
  })
})

describe('handleInjectCommand — outcome=failed', () => {
  it('not_allowed: lists allowed verbs, accent=issue', async () => {
    const inject = vi
      .fn()
      .mockResolvedValue(failedResult('/foo', 'not_allowed', '/foo not in allowlist'))
    const { deps, replies } = makeDeps({ getArgs: () => '/foo', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('issue')
    expect(replies[0].text).toContain('not allowed')
    expect(replies[0].text).toContain('/cost')
    expect(replies[0].text).toContain('/clear')
  })

  it('blocked: surfaces parenthetical reason', async () => {
    const inject = vi
      .fn()
      .mockResolvedValue(
        failedResult('/login', 'blocked', '/login is explicitly blocked from inject (would mutate auth state).'),
      )
    const { deps, replies } = makeDeps({ getArgs: () => '/login', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('issue')
    expect(replies[0].text).toContain('<code>/login</code>')
    expect(replies[0].text).toContain('blocked: would mutate auth state')
  })

  it('session_missing: hints at experimental.legacy_pty', async () => {
    const inject = vi
      .fn()
      .mockResolvedValue(failedResult('/cost', 'session_missing', 'session not found'))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('issue')
    expect(replies[0].text).toContain('tmux session not found')
    expect(replies[0].text).toContain('experimental.legacy_pty')
  })

  it('tmux_failed: surfaces escaped error message', async () => {
    const inject = vi
      .fn()
      .mockResolvedValue(failedResult('/cost', 'tmux_failed', 'connection <refused>'))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('issue')
    expect(replies[0].text).toContain('tmux send-keys failed')
    expect(replies[0].text).toContain('connection &lt;refused&gt;')
  })

  it('thrown InjectError from inject() is normalized to outcome=failed', async () => {
    const inject = vi.fn().mockRejectedValue(new InjectError('not_allowed', '/foo not allowed'))
    const { deps, replies } = makeDeps({ getArgs: () => '/foo', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].opts?.accent).toBe('issue')
    expect(replies[0].text).toContain('not allowed')
  })
})
