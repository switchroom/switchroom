/**
 * Tests for the inline status-accent header feature (issue #320 fallback).
 *
 * Post-#2669 the header is GFM markdown (every outbound goes through the
 * rich-message path), and the body ships as raw markdown via
 * `sendRichMessage` / `editMessageText({ markdown })`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildAccentHeader, handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

// ─── buildAccentHeader unit tests ────────────────────────────────────────────

describe('buildAccentHeader', () => {
  it("'in-progress' returns the blue circle markdown header", () => {
    expect(buildAccentHeader('in-progress')).toBe('🔵 _In progress…_\n\n')
  })

  it("'done' returns the checkmark markdown header", () => {
    expect(buildAccentHeader('done')).toBe('✅ **Done**\n\n')
  })

  it("'issue' returns the warning markdown header", () => {
    expect(buildAccentHeader('issue')).toBe('⚠️ **Issue**\n\n')
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
  }
}

function makeDeps(
  bot: ReturnType<typeof createMockBot>,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot,
    repairEscapedWhitespace: (t) => t,
    assertAllowedChat: () => {},
    resolveThreadId: (_, explicit) => (explicit != null ? Number(explicit) : undefined),
    disableLinkPreview: true,
    defaultFormat: 'markdown',
    logStreamingEvent: () => {},
    historyEnabled: false,
    recordOutbound: () => {},
    writeError: () => {},
    throttleMs: 600,
    ...overrides,
  }
}

function sentMarkdown(bot: ReturnType<typeof createMockBot>, i = 0): string {
  return (bot.api.sendRichMessage.mock.calls[i][1] as { markdown: string }).markdown
}
function editedMarkdown(bot: ReturnType<typeof createMockBot>, i = 0): string {
  return (bot.api.editMessageText.mock.calls[i][2] as { markdown: string }).markdown
}

describe('handleStreamReply accent integration', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("accent='in-progress' prepends the blue-circle markdown header before the body", async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Still working...', accent: 'in-progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    const sent = sentMarkdown(bot)
    // The default-on rich renderer normalises the italic marker
    // (`_In progress…_` -> `*In progress…*`, same wire entity).
    expect(sent).toMatch(/^🔵 \*In progress…\*\n\n/)
    expect(sent).toBe('🔵 *In progress…*\n\nStill working...')
  })

  it("accent='done' prepends the checkmark markdown header before the body", async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Task complete.', accent: 'done' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(sentMarkdown(bot)).toBe('✅ **Done**\n\nTask complete.')
  })

  it("accent='issue' prepends the warning markdown header before the body", async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Blocked on X.', accent: 'issue' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(sentMarkdown(bot)).toBe('⚠️ **Issue**\n\nBlocked on X.')
  })

  it('no accent — body ships as raw markdown unchanged (regression guard)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'Hello world' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(sentMarkdown(bot)).toBe('Hello world')
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

    expect(sentMarkdown(bot)).toBe('Hello world')
  })

  it('accent header is included on every call that passes it (full-text replace model)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply(
      { chat_id: '1', text: 'Part one', accent: 'in-progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await p1

    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply(
      { chat_id: '1', text: 'Part one Part two', accent: 'in-progress' },
      state,
      deps,
    )
    await microtaskFlush()
    await p2

    expect(editedMarkdown(bot)).toBe('🔵 *In progress…*\n\nPart one Part two')
  })
})
