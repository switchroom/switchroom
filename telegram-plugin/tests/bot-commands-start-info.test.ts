/**
 * Outcome pins for the /start /help /status /agents commands extracted from
 * gateway.ts (switchroom#2996 P6 bot.command drain). Registers against a fake
 * grammy Bot, captures the handlers, and drives them with mock contexts:
 * asserts the dmCommandGate silent-drop, the disabled-flag plumbing into the
 * start text, the paired/pending/unpaired /status branches, and the /agents
 * formatter output fed through runSwitchroomCommandFormatted.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  registerStartInfoCommands,
  type StartInfoCommandDeps,
} from '../gateway/bot-commands-start-info.js'

type Handler = (ctx: any) => Promise<void>

function fakeBot() {
  const handlers = new Map<string, Handler>()
  return {
    bot: { command: (name: string, h: Handler) => void handlers.set(name, h) } as any,
    handlers,
  }
}

function makeDeps(over: Partial<StartInfoCommandDeps> = {}): StartInfoCommandDeps {
  return {
    dmCommandGate: () => ({
      access: { dmPolicy: 'allowlist', allowFrom: ['42'], pending: {} } as any,
      senderId: '42',
    }),
    isAuthorizedSender: () => true,
    getMyAgentName: () => 'klanker',
    getCommandArgs: () => '',
    hasDemoFlag: () => false,
    buildAgentMetadata: async () =>
      ({
        agentName: 'klanker',
        model: 'opus',
        extendsProfile: null,
        topicName: null,
        topicEmoji: null,
        uptime: '2h',
        status: 'running',
        auth: null,
      }) as any,
    runSwitchroomCommandFormatted: vi.fn(async (_ctx, _args, _label, formatter) => {
      formatter()
    }),
    switchroomExecJson: () => null,
    statusIcon: () => '🟢',
    ...over,
  }
}

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    from: { username: 'ken' },
    reply: vi.fn(async () => {}),
    replyWithRichMessage: vi.fn(async () => {}),
    ...over,
  }
}

describe('/start and /help', () => {
  it('silently drops when dmCommandGate rejects', async () => {
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(bot, makeDeps({ dmCommandGate: () => null }))
    const ctx = makeCtx()
    await handlers.get('start')!(ctx)
    await handlers.get('help')!(ctx)
    expect(ctx.replyWithRichMessage).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('replies with the start text, carrying the disabled flag through', async () => {
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({
        dmCommandGate: () => ({
          access: { dmPolicy: 'disabled', allowFrom: [], pending: {} } as any,
          senderId: '42',
        }),
      }),
    )
    const ctx = makeCtx()
    await handlers.get('start')!(ctx)
    expect(ctx.replyWithRichMessage).toHaveBeenCalledTimes(1)
    // welcome-text startText(name, disabled=true) renders the disabled notice.
    const arg = ctx.replyWithRichMessage.mock.calls[0][0]
    expect(JSON.stringify(arg)).toContain("isn't accepting new connections")
  })

  it('replies with the help text for allowed senders', async () => {
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(bot, makeDeps())
    const ctx = makeCtx()
    await handlers.get('help')!(ctx)
    expect(ctx.replyWithRichMessage).toHaveBeenCalledTimes(1)
  })
})

describe('/status branches', () => {
  it('paired: builds agent metadata and replies rich', async () => {
    const buildAgentMetadata = vi.fn(async () =>
      ({
        agentName: 'klanker',
        model: 'opus',
        extendsProfile: null,
        topicName: null,
        topicEmoji: null,
        uptime: '2h',
        status: 'running',
        auth: null,
      }) as any)
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(bot, makeDeps({ buildAgentMetadata }))
    const ctx = makeCtx()
    await handlers.get('status')!(ctx)
    expect(buildAgentMetadata).toHaveBeenCalledWith('klanker')
    expect(ctx.replyWithRichMessage).toHaveBeenCalledTimes(1)
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('pending: replies with the pairing-code text', async () => {
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({
        dmCommandGate: () => ({
          access: {
            dmPolicy: 'pairing',
            allowFrom: [],
            pending: { ABC123: { senderId: '42' } },
          } as any,
          senderId: '42',
        }),
      }),
    )
    const ctx = makeCtx()
    await handlers.get('status')!(ctx)
    expect(ctx.replyWithRichMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ctx.replyWithRichMessage.mock.calls[0][0])).toContain('ABC123')
  })

  it('unpaired: falls through to the plain unpaired reply', async () => {
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({
        dmCommandGate: () => ({
          access: { dmPolicy: 'pairing', allowFrom: [], pending: {} } as any,
          senderId: '42',
        }),
      }),
    )
    const ctx = makeCtx()
    await handlers.get('status')!(ctx)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.replyWithRichMessage).not.toHaveBeenCalled()
  })
})

describe('/agents', () => {
  it('drops unauthorized senders before running the CLI', async () => {
    const runSwitchroomCommandFormatted = vi.fn(async () => {})
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({ isAuthorizedSender: () => false, runSwitchroomCommandFormatted }),
    )
    await handlers.get('agents')!(makeCtx())
    expect(runSwitchroomCommandFormatted).not.toHaveBeenCalled()
  })

  it('formats the agent list exactly (icon, name, status, uptime, template line)', async () => {
    let formatted: string | null = ''
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({
        runSwitchroomCommandFormatted: vi.fn(async (_c, args, label, formatter) => {
          expect(args).toEqual(['agent', 'list'])
          expect(label).toBe('agent list')
          formatted = formatter()
        }),
        switchroomExecJson: <T,>() =>
          ({
            agents: [
              {
                name: 'klanker',
                status: 'running',
                uptime: '2h',
                template: 'root-debug',
                topic_name: 'DM',
                topic_emoji: '🔧',
              },
            ],
          }) as T,
      }),
    )
    await handlers.get('agents')!(makeCtx())
    expect(formatted).toBe(
      '**Agents**\n🟢 **klanker** · running · 2h\n    _root-debug → DM 🔧_',
    )
  })

  it('renders the empty-list placeholder', async () => {
    let formatted: string | null = ''
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({
        runSwitchroomCommandFormatted: vi.fn(async (_c, _a, _l, formatter) => {
          formatted = formatter()
        }),
        switchroomExecJson: <T,>() => ({ agents: [] }) as T,
      }),
    )
    await handlers.get('agents')!(makeCtx())
    expect(formatted).toBe('_No agents defined_')
  })

  it('returns null (CLI failure passthrough) when exec returns null', async () => {
    let formatted: string | null = 'sentinel'
    const { bot, handlers } = fakeBot()
    registerStartInfoCommands(
      bot,
      makeDeps({
        runSwitchroomCommandFormatted: vi.fn(async (_c, _a, _l, formatter) => {
          formatted = formatter()
        }),
        switchroomExecJson: () => null,
      }),
    )
    await handlers.get('agents')!(makeCtx())
    expect(formatted).toBeNull()
  })
})
