/**
 * Integration tests for stream-reply parseMode rotation.
 *
 * Covers the specific bug-1 scenario in stream-reply-handler.ts: when
 * two stream_reply calls land on the same chat+thread+lane but with
 * different parseMode (e.g. PTY-tail auto-stream creates a text-mode
 * stream, then an explicit stream_reply with format:'html' reuses it),
 * the stale controller must be finalized + discarded and a fresh one
 * created with the new mode.
 *
 * Without that, the second call inherits the wrong parseMode and sends
 * literal markdown, or edits the wrong baked-in format into Telegram.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { markdownToHtml as realMarkdownToHtml } from '../format.js'
import { createFakeBotApi, type FakeBot } from './fake-bot-api.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    activeDraftParseModes: new Map<string, 'HTML' | 'MarkdownV2' | undefined>(),
  }
}

function makeDeps(bot: FakeBot, overrides?: Partial<StreamReplyDeps>): StreamReplyDeps {
  return {
    bot: bot as unknown as StreamReplyDeps['bot'],
    markdownToHtml: (t) => realMarkdownToHtml(t),
    escapeMarkdownV2: (t) => `ESC(${t})`,
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

describe('stream-reply parseMode rotation', () => {
  let bot: FakeBot

  beforeEach(() => {
    bot = createFakeBotApi({ startMessageId: 500 })
  })

  it('same format → stream is reused (no rotation)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'v1', format: 'html' }, state, deps)
    const streamBefore = state.activeDraftStreams.get('c:_')
    await handleStreamReply({ chat_id: 'c', text: 'v2', format: 'html' }, state, deps)
    const streamAfter = state.activeDraftStreams.get('c:_')

    expect(streamBefore).toBe(streamAfter) // identity preserved
    expect(bot.state.sent).toHaveLength(1)
    expect(bot.api.editMessageText).toHaveBeenCalled()
  })

  it('html → markdownv2 rotation: old stream finalized, new one created', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'hello', format: 'html' }, state, deps)
    expect(state.activeDraftParseModes.get('c:_')).toBe('HTML')
    const firstStreamHandle = state.activeDraftStreams.get('c:_')

    // Now call with a different parse mode.
    await handleStreamReply({ chat_id: 'c', text: 'hello2', format: 'markdownv2' }, state, deps)
    expect(state.activeDraftParseModes.get('c:_')).toBe('MarkdownV2')
    const secondStreamHandle = state.activeDraftStreams.get('c:_')

    // Stream instance should have been replaced.
    expect(secondStreamHandle).not.toBe(firstStreamHandle)
    // Two messages sent — one in html, one in markdownv2.
    expect(bot.state.sent).toHaveLength(2)
    expect(bot.state.sent[0].parse_mode).toBe('HTML')
    expect(bot.state.sent[1].parse_mode).toBe('MarkdownV2')
    // The second message's text ran through the MarkdownV2 escaper.
    expect(bot.state.sent[1].text).toBe('ESC(hello2)')
  })

  it('undefined (text) → html rotation: old stream finalized, new one created', async () => {
    const state = makeState()
    const deps = makeDeps(bot, { defaultFormat: 'text' })

    // First call in text mode (no parse_mode).
    await handleStreamReply({ chat_id: 'c', text: 'plain', format: 'text' }, state, deps)
    expect(state.activeDraftParseModes.get('c:_')).toBeUndefined()
    expect(bot.state.sent[0].parse_mode).toBeUndefined()

    // Second call in html.
    await handleStreamReply({ chat_id: 'c', text: 'rich', format: 'html' }, state, deps)
    expect(state.activeDraftParseModes.get('c:_')).toBe('HTML')
    expect(bot.state.sent).toHaveLength(2)
    expect(bot.state.sent[1].parse_mode).toBe('HTML')
  })

  it('markdownv2 → undefined rotation', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'a', format: 'markdownv2' }, state, deps)
    expect(state.activeDraftParseModes.get('c:_')).toBe('MarkdownV2')

    await handleStreamReply({ chat_id: 'c', text: 'b', format: 'text' }, state, deps)
    expect(state.activeDraftParseModes.get('c:_')).toBeUndefined()
    expect(bot.state.sent).toHaveLength(2)
    expect(bot.state.sent[0].parse_mode).toBe('MarkdownV2')
    expect(bot.state.sent[1].parse_mode).toBeUndefined()
  })

  it('rotation across two distinct lanes is independent', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply(
      { chat_id: 'c', text: 'main', format: 'html', lane: 'main' },
      state,
      deps,
    )
    await handleStreamReply(
      { chat_id: 'c', text: 'activity', format: 'text', lane: 'activity' },
      state,
      deps,
    )

    expect(state.activeDraftParseModes.get('c:_:main')).toBe('HTML')
    expect(state.activeDraftParseModes.get('c:_:activity')).toBeUndefined()
    // Two messages: different lanes, different modes, different streams.
    expect(bot.state.sent).toHaveLength(2)
  })

  it('rotation across threads is independent', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply(
      { chat_id: 'c', text: 'thread-a', format: 'html', message_thread_id: '1' },
      state,
      deps,
    )
    await handleStreamReply(
      { chat_id: 'c', text: 'thread-b', format: 'markdownv2', message_thread_id: '2' },
      state,
      deps,
    )

    expect(state.activeDraftStreams.size).toBe(2)
    expect(state.activeDraftParseModes.get('c:1')).toBe('HTML')
    expect(state.activeDraftParseModes.get('c:2')).toBe('MarkdownV2')
    expect(bot.state.sent).toHaveLength(2)
  })
})
