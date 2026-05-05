/**
 * Unit tests for the /inject Telegram handler (#725 Phase 2).
 *
 * The handler is factored out of gateway.ts so we can exercise it
 * without booting grammy/Bot. Real tmux is never touched — the inject
 * function is mocked via the InjectDeps seam.
 *
 * Run with: npx vitest run telegram-plugin/gateway/inject-handler.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import type { Context } from 'grammy'
import { handleInjectCommand, type InjectDeps } from './inject-handler.js'
import { InjectError } from '../../src/agents/inject.js'

function fakeCtx(): Context {
  // Cast: we never read real fields off ctx; deps shim everything.
  return {} as unknown as Context
}

function makeDeps(overrides: Partial<InjectDeps> = {}): {
  deps: InjectDeps
  replies: Array<{ text: string; opts?: { html?: boolean } }>
} {
  const replies: Array<{ text: string; opts?: { html?: boolean } }> = []
  const deps: InjectDeps = {
    isAuthorized: () => true,
    inject: vi.fn().mockResolvedValue({ output: 'mock', truncated: false }),
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

describe('handleInjectCommand', () => {
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

  it('passes the slash-command verbatim to inject and renders output as <pre>', async () => {
    const inject = vi.fn().mockResolvedValue({ output: 'Total cost: $0.42', truncated: false })
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(inject).toHaveBeenCalledWith('gymbro', '/cost')
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('<pre>Total cost: $0.42</pre>')
    expect(replies[0].opts).toEqual({ html: true })
  })

  it('prepends slash if the operator omitted it', async () => {
    const inject = vi.fn().mockResolvedValue({ output: 'ok', truncated: false })
    const { deps } = makeDeps({ getArgs: () => 'cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(inject).toHaveBeenCalledWith('gymbro', '/cost')
  })

  it('replies with an empty-output notice when nothing new was captured', async () => {
    const inject = vi.fn().mockResolvedValue({ output: '   \n  ', truncated: false })
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].text).toContain('no new output captured')
  })

  it('appends a truncation suffix when the result is truncated', async () => {
    const inject = vi.fn().mockResolvedValue({ output: 'a lot of text', truncated: true })
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].text).toContain('output truncated')
  })

  it('surfaces InjectError code + message when validation fails (not_allowed)', async () => {
    const inject = vi.fn().mockRejectedValue(new InjectError('not_allowed', '/foo not in allowlist'))
    const { deps, replies } = makeDeps({ getArgs: () => '/foo', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].text).toContain('inject failed')
    expect(replies[0].text).toContain('not_allowed')
    expect(replies[0].text).toContain('not in allowlist')
  })

  it('surfaces InjectError when the agent has no tmux session (session_missing)', async () => {
    const inject = vi.fn().mockRejectedValue(new InjectError('session_missing', 'session "gymbro" not found'))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].text).toContain('session_missing')
  })

  it('falls back to a generic message for unknown errors', async () => {
    const inject = vi.fn().mockRejectedValue(new Error('boom'))
    const { deps, replies } = makeDeps({ getArgs: () => '/cost', inject })
    await handleInjectCommand(fakeCtx(), deps)
    expect(replies[0].text).toContain('boom')
  })
})
