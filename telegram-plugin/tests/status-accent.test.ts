/**
 * Tests for the inline status-accent header feature (issue #320 fallback).
 *
 * Covers both the pure `buildAccentHeader` helper and the integration paths
 * through `handleStreamReply` (stream_reply) and the server reply case
 * (exercised via the handler directly since server.ts wires it the same way).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildAccentHeader, handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

// ─── buildAccentHeader unit tests ────────────────────────────────────────────

describe('buildAccentHeader', () => {
  it("'in-progress' returns the blue circle header", () => {
    expect(buildAccentHeader('in-progress')).toBe('🔵 <i>In progress…</i>\n\n')
  })

  it("'done' returns the checkmark header", () => {
    expect(buildAccentHeader('done')).toBe('✅ <b>Done</b>\n\n')
  })

  it("'issue' returns the warning header", () => {
    expect(buildAccentHeader('issue')).toBe('⚠️ <b>Issue</b>\n\n')
  })

  it('undefined returns empty string (no header)', () => {
    expect(buildAccentHeader(undefined)).toBe('')
  })

  it('invalid / unrecognised value is silently ignored (returns empty string)', () => {
    expect(buildAccentHeader('unknown')).toBe('')
    expect(buildAccentHeader('')).toBe('')
    expect(buildAccentHeader('DONE')).toBe('')
  })
})

// ─── handleStreamReply integration tests ─────────────────────────────────────

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    activeDraftParseModes: new Map<string, 'HTML' | 'MarkdownV2' | undefined>(),
  }
}

function makeDeps(
  bot: ReturnType<typeof createMockBot>,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot,
    markdownToHtml: (t) => `<b>${t}</b>`,
    escapeMarkdownV2: (t) => `\\${t}\\`,
    repairEscapedWhitespace: (t) => t,
    takeHandoffPrefix: () => '',
    assertAllowedChat: () => {},
    resolveThreadId: (_, explicit) => (explicit != null ? Number(explicit) : undefined),
    disableLinkPreview: true,
    defaultFormat: 'html',
    logStreamingEvent: () => {},
    endStatusReaction: () => {},
    historyEnabled: false,
    recordOutbound: () => {},
    writeError: () => {},
    throttleMs: 600,
    ...overrides,
  }
}

describe('handleStreamReply accent integration', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("accent='in-progress' prepends the blue-circle header before the body", async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Still working...', accent: 'in-progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    const sent = bot.api.sendMessage.mock.calls[0][1] as string
    expect(sent).toMatch(/^🔵 <i>In progress…<\/i>\n\n/)
    expect(sent).toBe('🔵 <i>In progress…</i>\n\n<b>Still working...</b>')
  })

  it("accent='done' prepends the checkmark header before the body", async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Task complete.', accent: 'done' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    const sent = bot.api.sendMessage.mock.calls[0][1] as string
    expect(sent).toBe('✅ <b>Done</b>\n\n<b>Task complete.</b>')
  })

  it("accent='issue' prepends the warning header before the body", async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Blocked on X.', accent: 'issue' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    const sent = bot.api.sendMessage.mock.calls[0][1] as string
    expect(sent).toBe('⚠️ <b>Issue</b>\n\n<b>Blocked on X.</b>')
  })

  it('no accent — output is unchanged from today (regression guard)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Hello world' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    const sent = bot.api.sendMessage.mock.calls[0][1] as string
    expect(sent).toBe('<b>Hello world</b>')
  })

  it('invalid accent is silently ignored — output equals no-accent path', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Hello world', accent: 'rainbow' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    const sent = bot.api.sendMessage.mock.calls[0][1] as string
    expect(sent).toBe('<b>Hello world</b>')
  })

  it('accent header is included on every call that passes it (full-text replace model)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    // First call
    const p1 = handleStreamReply(
      { chat_id: '1', text: 'Part one', accent: 'in-progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await p1

    // Second call — same turn, same accent
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply(
      { chat_id: '1', text: 'Part one Part two', accent: 'in-progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await p2

    const edited = bot.api.editMessageText.mock.calls[0][2] as string
    expect(edited).toBe('🔵 <i>In progress…</i>\n\n<b>Part one Part two</b>')
  })
})
