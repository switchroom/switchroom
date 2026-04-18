/**
 * Integration tests for multi-turn state isolation.
 *
 * Verifies that state carried across turns in the same chat+thread
 * (activeDraftStreams, activeDraftParseModes, suppressPtyPreview)
 * resets cleanly when a new turn starts — i.e. the previous turn's
 * stream handle is finalized/discarded before the next begins.
 *
 * This is one of the "per-chat continuity" gaps the plan called out:
 * previously tested only through the full server.ts orchestration in
 * production; now we pin down the behaviour at the handler layer.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { markdownToHtml as realMarkdownToHtml } from '../format.js'
import { createFakeBotApi, type FakeBot } from './fake-bot-api.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    activeDraftParseModes: new Map<string, 'HTML' | 'MarkdownV2' | undefined>(),
    suppressPtyPreview: new Set<string>(),
  }
}

function makeDeps(bot: FakeBot, overrides?: Partial<StreamReplyDeps>): StreamReplyDeps {
  return {
    bot: bot as unknown as StreamReplyDeps['bot'],
    markdownToHtml: (t) => realMarkdownToHtml(t),
    escapeMarkdownV2: (t) => t,
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
    throttleMs: 0,
    ...overrides,
  }
}

describe('multi-turn continuity', () => {
  let bot: FakeBot

  beforeEach(() => {
    bot = createFakeBotApi({ startMessageId: 500 })
  })

  it('done=true clears the stream entry and parse-mode map', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'turn-1', done: true }, state, deps)
    expect(state.activeDraftStreams.has('c:_')).toBe(false)
    expect(state.activeDraftParseModes.has('c:_')).toBe(false)
  })

  it('two sequential turns on the same chat each get their own message', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'first turn', done: true }, state, deps)
    await handleStreamReply({ chat_id: 'c', text: 'second turn', done: true }, state, deps)

    expect(bot.state.sent).toHaveLength(2)
    expect(bot.state.sent[0].text).toContain('first turn')
    expect(bot.state.sent[1].text).toContain('second turn')
    // Each turn finalised — map is empty.
    expect(state.activeDraftStreams.size).toBe(0)
  })

  it('concurrent turns on different chats do not interfere', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    // Interleave chat-A and chat-B streams.
    await handleStreamReply({ chat_id: 'A', text: 'A.1' }, state, deps)
    await handleStreamReply({ chat_id: 'B', text: 'B.1' }, state, deps)
    await handleStreamReply({ chat_id: 'A', text: 'A.2' }, state, deps)
    await handleStreamReply({ chat_id: 'B', text: 'B.2', done: true }, state, deps)
    await handleStreamReply({ chat_id: 'A', text: 'A.3', done: true }, state, deps)

    expect(bot.messagesIn('A')).toHaveLength(1)
    expect(bot.messagesIn('B')).toHaveLength(1)
    const finalA = bot.messagesIn('A')[0]
    const finalB = bot.messagesIn('B')[0]
    expect(bot.textOf(finalA.message_id)).toContain('A.3')
    expect(bot.textOf(finalB.message_id)).toContain('B.2')
    expect(state.activeDraftStreams.size).toBe(0)
  })

  it('concurrent turns on different threads of the same chat stay isolated', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply(
      { chat_id: 'c', text: 't1', message_thread_id: '1' },
      state,
      deps,
    )
    await handleStreamReply(
      { chat_id: 'c', text: 't2', message_thread_id: '2' },
      state,
      deps,
    )

    // Two separate active streams, both under chat 'c' but distinct thread keys.
    expect(state.activeDraftStreams.size).toBe(2)
    expect(state.activeDraftStreams.has('c:1')).toBe(true)
    expect(state.activeDraftStreams.has('c:2')).toBe(true)
    expect(bot.state.sent).toHaveLength(2)
    expect(bot.state.sent[0].message_thread_id).toBe(1)
    expect(bot.state.sent[1].message_thread_id).toBe(2)

    await handleStreamReply(
      { chat_id: 'c', text: 't1-end', message_thread_id: '1', done: true },
      state,
      deps,
    )
    expect(state.activeDraftStreams.has('c:1')).toBe(false)
    expect(state.activeDraftStreams.has('c:2')).toBe(true) // still mid-turn
  })

  it('suppressPtyPreview claim is lane-less and shared across streams in the same chat', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    // Default-lane call claims lane-less key.
    await handleStreamReply({ chat_id: 'c', text: 'x' }, state, deps)
    expect(state.suppressPtyPreview?.has('c:_')).toBe(true)

    // Named-lane call claims the SAME lane-less key (by design —
    // see comment in stream-reply-handler line 276).
    await handleStreamReply({ chat_id: 'c', text: 'y', lane: 'activity' }, state, deps)
    expect(state.suppressPtyPreview?.has('c:_')).toBe(true)
  })

  it('new turn on same chat reuses the stream until done:true fires', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'one' }, state, deps)
    const s1 = state.activeDraftStreams.get('c:_')
    await handleStreamReply({ chat_id: 'c', text: 'two' }, state, deps)
    const s2 = state.activeDraftStreams.get('c:_')

    expect(s1).toBe(s2)
    // One message, edited twice.
    expect(bot.state.sent).toHaveLength(1)
    expect(bot.textOf(bot.state.sent[0].message_id)).toContain('two')
  })
})
