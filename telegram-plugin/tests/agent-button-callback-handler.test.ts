/**
 * Outcome pins for the agent-emitted inline-keyboard callback family
 * (`agent:` prefix, #271) extracted from the gateway's callback_query
 * dispatcher (switchroom#2996 P6). Drives handleAgentButtonCallback with a
 * mock ctx + injected deps and asserts: fall-through for non-agent data, the
 * allowFrom gate, the ack-toast-first contract (#710), the exact InboundMessage
 * envelope routed through the injected turn-safe delivery, the restarting
 * notice only on bridge-offline, and the single-use keyboard strip + meta
 * cleanup.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleAgentButtonCallback,
  type AgentButtonCallbackDeps,
} from '../gateway/agent-button-callback-handler.js'

const DATA = 'agent:approve_pr'

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    from: { id: 42, username: 'ken' },
    chat: { id: 42 },
    callbackQuery: {
      message: {
        message_id: 77,
        text: 'Deploy?',
        reply_markup: {
          inline_keyboard: [[{ text: 'Approve', callback_data: DATA }]],
        },
      },
    },
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    editMessageReplyMarkup: vi.fn(async () => {}),
    ...over,
  } as any
}

function makeDeps(over: Partial<AgentButtonCallbackDeps> = {}) {
  const deliverButtonTapInbound = vi.fn(async () => 'delivered')
  const sendRestartingNotice = vi.fn()
  const metaDelete = vi.fn()
  const deps: AgentButtonCallbackDeps = {
    loadAccess: () => ({ allowFrom: ['42'] }),
    agentButtonMeta: { get: () => undefined, delete: metaDelete },
    deliverButtonTapInbound,
    sendRestartingNotice,
    buttonConfirmSingleUseWarned: new Set(),
    buttonConfirmParseModeWarned: new Set(),
    log: vi.fn(),
    ...over,
  }
  return { deps, deliverButtonTapInbound, sendRestartingNotice, metaDelete }
}

describe('handleAgentButtonCallback — routing + gates', () => {
  it('returns false for non-agent callback data', async () => {
    const { deps } = makeDeps()
    const ctx = makeCtx()
    expect(await handleAgentButtonCallback(ctx, 'perm:allow:abcde', deps)).toBe(false)
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled()
  })

  it('gates non-allowlisted senders before any delivery', async () => {
    const { deps, deliverButtonTapInbound } = makeDeps()
    const ctx = makeCtx({ from: { id: 666 } })
    expect(await handleAgentButtonCallback(ctx, DATA, deps)).toBe(true)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    expect(deliverButtonTapInbound).not.toHaveBeenCalled()
  })
})

describe('handleAgentButtonCallback — delivery envelope', () => {
  it('acks FIRST with the default toast, then delivers the exact inbound (#710/#271)', async () => {
    const { deps, deliverButtonTapInbound } = makeDeps()
    const ctx = makeCtx()
    process.env.SWITCHROOM_AGENT_NAME = 'klanker'
    expect(await handleAgentButtonCallback(ctx, DATA, deps)).toBe(true)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✓ received' })
    // Ack precedes delivery.
    expect(ctx.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(
      deliverButtonTapInbound.mock.invocationCallOrder[0],
    )
    const [agent, msg] = deliverButtonTapInbound.mock.calls[0] as unknown as [string, any]
    expect(agent).toBe('klanker')
    expect(msg).toMatchObject({
      type: 'inbound',
      chatId: '42',
      messageId: 77,
      user: 'ken',
      userId: 42,
      text: '[user tapped button: "Approve" → approve_pr]',
      meta: expect.objectContaining({
        button_callback: 'true',
        button_callback_data: 'approve_pr',
        button_text: 'Approve',
      }),
    })
  })

  it('uses the stashed per-button ack_text when present', async () => {
    // meta is keyed by the RAW payload (prefix stripped).
    const metaMap = new Map([['approve_pr', { ack_text: 'On it!' }]])
    const { deps } = makeDeps({
      agentButtonMeta: { get: () => metaMap as any, delete: vi.fn() },
    })
    const ctx = makeCtx()
    await handleAgentButtonCallback(ctx, DATA, deps)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'On it!' })
  })

  it('shows the restarting notice ONLY on bridge-offline', async () => {
    const { deps, sendRestartingNotice } = makeDeps({
      deliverButtonTapInbound: vi.fn(async () => 'buffered-bridge-offline'),
    })
    await handleAgentButtonCallback(makeCtx(), DATA, deps)
    expect(sendRestartingNotice).toHaveBeenCalledWith('42', undefined)

    const second = makeDeps({
      deliverButtonTapInbound: vi.fn(async () => 'buffered-mid-turn'),
    })
    await handleAgentButtonCallback(makeCtx(), DATA, second.deps)
    expect(second.sendRestartingNotice).not.toHaveBeenCalled()
  })
})

describe('handleAgentButtonCallback — single-use strip', () => {
  it('strips the keyboard by default (no stashed meta) after the tap', async () => {
    const { deps } = makeDeps()
    const ctx = makeCtx()
    await handleAgentButtonCallback(ctx, DATA, deps)
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
      reply_markup: { inline_keyboard: [] },
    })
  })

  it('preserves the keyboard when a button opts out via single_use:false', async () => {
    const metaMap = new Map([['approve_pr', { single_use: false }]])
    const metaDelete = vi.fn()
    const { deps } = makeDeps({
      agentButtonMeta: { get: () => metaMap as any, delete: metaDelete },
    })
    const ctx = makeCtx()
    await handleAgentButtonCallback(ctx, DATA, deps)
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
    expect(metaDelete).not.toHaveBeenCalled()
  })
})
