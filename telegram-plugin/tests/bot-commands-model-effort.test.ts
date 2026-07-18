/**
 * Outcome pins for the /model and /effort commands extracted from gateway.ts
 * (switchroom#2996 P6 bot.command drain). Registers against a fake grammy Bot
 * and drives the captured handlers with mock contexts: asserts the durable
 * receipt-first contract (#3177 — log line + history row before any branch),
 * the busy → ack+queue disposition (#3017/#3262), the menu path, and the
 * direct-apply path for both commands.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  registerModelEffortCommands,
  type ModelEffortCommandDeps,
} from '../gateway/bot-commands-model-effort.js'

type Handler = (ctx: any) => Promise<void>

function fakeBot() {
  const handlers = new Map<string, Handler>()
  return {
    bot: { command: (name: string, h: Handler) => void handlers.set(name, h) } as any,
    handlers,
  }
}

function makeDeps(over: Partial<ModelEffortCommandDeps> = {}) {
  const log = vi.fn()
  const recordInbound = vi.fn()
  const enqueueSessionCommand = vi.fn()
  const switchroomReply = vi.fn(async () => {})
  const deps: ModelEffortCommandDeps = {
    isAuthorizedSender: () => true,
    getMyAgentName: () => 'klanker',
    resolveThreadId: () => undefined,
    resolveModelEffortBusy: () => ({ currentTurnActive: false, turnInFlight: false }),
    historyEnabled: true,
    recordInbound,
    buildModelDeps: () => ({
      discover: async () => ({ models: [], current: null }),
      isBusy: () => false,
      getAgentName: () => 'klanker',
      getQuotaBrief: async () => null,
      discoverSrModels: async () => [],
      escapeHtml: (s: string) => s,
      getConfiguredModel: () => 'opus',
      preBlock: (s: string) => s,
      scheduleRestart: async () => {},
      scheduleModelRelaunch: async () => {},
      scheduleModelDefaultRelaunch: async () => {},
    }) as any,
    buildEffortDeps: () => ({
      applyEffort: vi.fn(async () => ({ ok: true })),
      getAgentName: () => 'klanker',
      getConfiguredEffort: () => 'high',
      getSessionEffort: () => null,
      escapeHtml: (s: string) => s,
    }) as any,
    modelMenuReplyMarkup: () => undefined,
    effortMenuReplyMarkup: () => undefined,
    enqueueSessionCommand,
    switchroomReply,
    modelMenuEnabled: () => true,
    log,
    ...over,
  }
  return { deps, log, recordInbound, enqueueSessionCommand, switchroomReply }
}

function makeCtx(text: string) {
  return {
    message: { text, message_id: 7, date: 1000 },
    chat: { id: 42 },
    from: { id: 11, username: 'ken' },
    replyWithRichMessage: vi.fn(async () => ({ message_id: 900 })),
  }
}

describe('/model', () => {
  it('drops unauthorized senders silently', async () => {
    const { bot, handlers } = fakeBot()
    const { deps, log } = makeDeps({ isAuthorizedSender: () => false })
    registerModelEffortCommands(bot, deps)
    await handlers.get('model')!(makeCtx('/model'))
    expect(log).not.toHaveBeenCalled()
  })

  it('writes the durable receipt (log + history row) BEFORE any branch (#3177)', async () => {
    const { bot, handlers } = fakeBot()
    const { deps, log, recordInbound } = makeDeps()
    registerModelEffortCommands(bot, deps)
    await handlers.get('model')!(makeCtx('/model'))
    expect(log.mock.calls[0][0]).toContain('model')
    expect(recordInbound).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: '42', message_id: 7, user: 'ken', text: '/model' }),
    )
  })

  it('bare /model on an idle session opens the menu via switchroomReply', async () => {
    const { bot, handlers } = fakeBot()
    const buildModelDeps = vi.fn(() => ({
      // ModelMenuDeps shape — what buildModelMenu really reads.
      discover: async () => ({ models: [], current: null }),
      isBusy: () => false,
      getAgentName: () => 'klanker',
      getQuotaBrief: async () => null,
      discoverSrModels: async () => [],
      escapeHtml: (s: string) => s,
      getConfiguredModel: () => 'opus',
      preBlock: (s: string) => s,
      scheduleRestart: async () => {},
      scheduleModelRelaunch: async () => {},
      scheduleModelDefaultRelaunch: async () => {},
    }) as any)
    const { deps, switchroomReply } = makeDeps({ buildModelDeps })
    registerModelEffortCommands(bot, deps)
    await handlers.get('model')!(makeCtx('/model'))
    expect(switchroomReply).toHaveBeenCalledTimes(1)
    expect(switchroomReply.mock.calls[0][2]).toMatchObject({ html: true })
  })

  it('typed /model <target> while BUSY acks and queues instead of applying (#3017)', async () => {
    const { bot, handlers } = fakeBot()
    const { deps, enqueueSessionCommand, switchroomReply } = makeDeps({
      resolveModelEffortBusy: () => ({ currentTurnActive: true, turnInFlight: true }),
    })
    registerModelEffortCommands(bot, deps)
    const ctx = makeCtx('/model opus')
    await handlers.get('model')!(ctx)
    expect(ctx.replyWithRichMessage).toHaveBeenCalledTimes(1)
    expect(enqueueSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'model',
        origin: 'typed',
        arg: 'opus',
        ackChatId: '42',
        ackMessageId: 900,
      }),
    )
    expect(switchroomReply).not.toHaveBeenCalled()
  })
})

describe('/effort', () => {
  it('shows the menu for bare /effort', async () => {
    const { bot, handlers } = fakeBot()
    const buildEffortDeps = vi.fn(() => ({
      applyEffort: vi.fn(async () => ({ ok: true })),
      getAgentName: () => 'klanker',
      getConfiguredEffort: () => 'high',
      getSessionEffort: () => null,
      escapeHtml: (s: string) => s,
    }) as any)
    const { deps, switchroomReply } = makeDeps({ buildEffortDeps })
    registerModelEffortCommands(bot, deps)
    await handlers.get('effort')!(makeCtx('/effort'))
    expect(switchroomReply).toHaveBeenCalledTimes(1)
    expect(switchroomReply.mock.calls[0][2]).toMatchObject({ html: true })
  })

  it('set while busy: acks and queues with the requested level', async () => {
    const { bot, handlers } = fakeBot()
    const { deps, enqueueSessionCommand } = makeDeps({
      resolveModelEffortBusy: () => ({ currentTurnActive: true, turnInFlight: false }),
    })
    registerModelEffortCommands(bot, deps)
    const ctx = makeCtx('/effort low')
    await handlers.get('effort')!(ctx)
    expect(ctx.replyWithRichMessage).toHaveBeenCalledTimes(1)
    expect(enqueueSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'effort', arg: 'low', targetLabel: 'low' }),
    )
  })

  it('set while idle: applies via handleEffortCommand and replies', async () => {
    const { bot, handlers } = fakeBot()
    const buildEffortDeps = vi.fn(() => ({
      applyEffort: vi.fn(async () => ({ ok: true })),
      getAgentName: () => 'klanker',
      getConfiguredEffort: () => 'high',
      getSessionEffort: () => null,
      escapeHtml: (s: string) => s,
    }) as any)
    const { deps, switchroomReply, enqueueSessionCommand } = makeDeps({ buildEffortDeps })
    registerModelEffortCommands(bot, deps)
    await handlers.get('effort')!(makeCtx('/effort low'))
    expect(enqueueSessionCommand).not.toHaveBeenCalled()
    expect(switchroomReply).toHaveBeenCalledTimes(1)
  })
})
