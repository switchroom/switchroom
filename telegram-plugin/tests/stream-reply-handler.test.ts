/**
 * Integration tests for the `stream_reply` MCP tool handler.
 *
 * Exercises the extracted `handleStreamReply` against the mock bot harness
 * with realistic deps (format rendering, access check, thread resolution,
 * handoff prefix, history record).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  handleStreamReply,
  type StreamReplyDeps,
  type StreamReplyState,
} from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

function makeState(): StreamReplyState {
  return { activeDraftStreams: new Map<string, DraftStreamHandle>() }
}

function makeDeps(
  bot: ReturnType<typeof createMockBot>,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot,
    markdownToHtml: (t) => `<html>${t}</html>`,
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

describe('handleStreamReply', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first call creates stream + sends with rendered HTML text', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply({ chat_id: '1', text: 'hi' }, state, deps)
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('updated')
    expect(result.messageId).toBe(500)
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<html>hi</html>')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBe('HTML')
    expect(state.activeDraftStreams.size).toBe(1)
  })

  it('respects format=markdownv2 — uses MDv2 escaper and parse_mode', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'hi', format: 'markdownv2' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('\\hi\\')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBe('MarkdownV2')
  })

  it('respects format=text — no parse_mode, raw text', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pending = handleStreamReply(
      { chat_id: '1', text: 'plain', format: 'text' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('plain')
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBeUndefined()
  })

  it('prepends handoff prefix on first chunk only', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      takeHandoffPrefix: vi.fn<(fmt: string) => string>(() => '↩️ '),
    })

    // First call: prefix applied
    const p1 = handleStreamReply({ chat_id: '1', text: 'first' }, state, deps)
    await microtaskFlush()
    await p1
    // Prefix is prepended AFTER format rendering (it's already format-safe
    // because takeHandoffPrefix takes the format tag).
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('↩️ <html>first</html>')

    // Second call: handoff not consumed again
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply({ chat_id: '1', text: 'second' }, state, deps)
    await microtaskFlush()
    await p2
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>second</html>')
    expect(deps.takeHandoffPrefix).toHaveBeenCalledTimes(1)
  })

  it('done=true finalizes, deletes from map, calls endStatusReaction', async () => {
    const state = makeState()
    const endStatusReaction = vi.fn()
    const deps = makeDeps(bot, { endStatusReaction })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'final', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('finalized')
    expect(state.activeDraftStreams.size).toBe(0)
    expect(endStatusReaction).toHaveBeenCalledWith('1', undefined, 'done')
  })

  it('done=true with historyEnabled records the final message row', async () => {
    const state = makeState()
    const recordOutbound = vi.fn()
    const deps = makeDeps(bot, {
      historyEnabled: true,
      recordOutbound,
      resolveThreadId: () => 42,
    })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'final text', done: true, message_thread_id: '42' },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(recordOutbound).toHaveBeenCalledWith({
      chat_id: '1',
      thread_id: 42,
      message_ids: [500],
      texts: ['final text'], // raw text, NOT HTML-rendered
    })
  })

  it('historyEnabled=false skips recordOutbound', async () => {
    const state = makeState()
    const recordOutbound = vi.fn()
    const deps = makeDeps(bot, { historyEnabled: false, recordOutbound })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'f', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pending

    expect(recordOutbound).not.toHaveBeenCalled()
  })

  it('recordOutbound throws → error logged, handler still resolves finalized', async () => {
    const state = makeState()
    const writeError = vi.fn()
    const recordOutbound = vi.fn(() => {
      throw new Error('db locked')
    })
    const deps = makeDeps(bot, { historyEnabled: true, recordOutbound, writeError })

    const pending = handleStreamReply(
      { chat_id: '1', text: 'f', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    const result = await pending

    expect(result.status).toBe('finalized')
    expect(writeError).toHaveBeenCalledTimes(1)
    expect(writeError.mock.calls[0][0]).toMatch(/db locked/)
  })

  it('rejects when assertAllowedChat throws', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      assertAllowedChat: () => { throw new Error('chat not allowed') },
    })

    await expect(
      handleStreamReply({ chat_id: 'evil', text: 'x' }, state, deps),
    ).rejects.toThrow('chat not allowed')

    expect(bot.api.sendMessage).not.toHaveBeenCalled()
  })

  it('subsequent calls reuse the same stream + edit in place', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply({ chat_id: '1', text: 'step 1' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)

    const p2 = handleStreamReply({ chat_id: '1', text: 'step 2' }, state, deps)
    await microtaskFlush()
    await p2

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][1]).toBe(500) // same id
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>step 2</html>')
  })

  it('passes repairEscapedWhitespace through before rendering', async () => {
    const state = makeState()
    const deps = makeDeps(bot, {
      repairEscapedWhitespace: (t) => t.replace(/\\n/g, '\n'),
    })

    const pending = handleStreamReply({ chat_id: '1', text: 'a\\nb' }, state, deps)
    await microtaskFlush()
    await pending

    // repair happens first; then markdownToHtml wraps the repaired text
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('<html>a\nb</html>')
  })

  it('different lanes for same chat produce independent Telegram messages', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply(
      { chat_id: '1', text: 'thinking aloud', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    const r1 = await p1

    const p2 = handleStreamReply(
      { chat_id: '1', text: 'final answer' }, // no lane = answer
      state,
      deps,
    )
    await microtaskFlush()
    const r2 = await p2

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(r1.messageId).not.toBe(r2.messageId) // separate messages
    expect(state.activeDraftStreams.size).toBe(2)
    expect(state.activeDraftStreams.has('1:_')).toBe(true)
    expect(state.activeDraftStreams.has('1:_:thinking')).toBe(true)
  })

  it('same lane updates the same message (no duplicate send per lane)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const p1 = handleStreamReply(
      { chat_id: '1', text: 'step 1', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    await p1

    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply(
      { chat_id: '1', text: 'step 1 — step 2', lane: 'thinking' },
      state,
      deps,
    )
    await microtaskFlush()
    await p2

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('<html>step 1 — step 2</html>')
  })

  it('done=true on one lane does not affect other lanes', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    const pThink = handleStreamReply(
      { chat_id: '1', text: 'thinking', lane: 'thinking', done: true },
      state,
      deps,
    )
    await microtaskFlush()
    await pThink

    const pAnswer = handleStreamReply(
      { chat_id: '1', text: 'answering' }, // still in progress
      state,
      deps,
    )
    await microtaskFlush()
    await pAnswer

    expect(state.activeDraftStreams.has('1:_:thinking')).toBe(false)
    expect(state.activeDraftStreams.has('1:_')).toBe(true)
  })

  it('streamExisted flag in logStreamingEvent reflects map state', async () => {
    const state = makeState()
    const logStreamingEvent = vi.fn()
    const deps = makeDeps(bot, { logStreamingEvent })

    const p1 = handleStreamReply({ chat_id: '1', text: 'a' }, state, deps)
    await microtaskFlush()
    await p1
    vi.advanceTimersByTime(1000)
    const p2 = handleStreamReply({ chat_id: '1', text: 'b' }, state, deps)
    await microtaskFlush()
    await p2

    const calledEvents = logStreamingEvent.mock.calls.map(c => c[0])
    const streamReplyCalledEvents = calledEvents.filter(
      (e: { kind: string }) => e.kind === 'stream_reply_called',
    )
    expect(streamReplyCalledEvents[0].streamExisted).toBe(false)
    expect(streamReplyCalledEvents[1].streamExisted).toBe(true)
  })
})
