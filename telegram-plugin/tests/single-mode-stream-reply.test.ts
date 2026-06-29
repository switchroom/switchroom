/**
 * Single-mode stream-reply behaviour (post-#2669).
 *
 * The parse-mode rotation this file used to cover is GONE: there is now
 * exactly ONE rendering mode (raw GFM markdown via `sendRichMessage` /
 * `editMessageText({ markdown })`). The successor contract is:
 *
 *   - Every non-`text` format reuses the SAME draft stream for a
 *     chat+thread+lane — no finalize-and-recreate dance, because no baked
 *     parse_mode can ever go stale.
 *   - The only fork is the literal `format:'text'` path (`literalText`),
 *     which sends a plain string instead of a rich-markdown wrapper.
 *
 * This file is retained (rather than deleted) to lock in the
 * single-mode-reuse invariant that replaced rotation, so a future
 * regression that reintroduces per-mode stream churn is caught.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createFakeBotApi, type FakeBot } from './fake-bot-api.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
  }
}

function makeDeps(bot: FakeBot, overrides?: Partial<StreamReplyDeps>): StreamReplyDeps {
  return {
    bot: bot as unknown as StreamReplyDeps['bot'],
    repairEscapedWhitespace: (t) => t,
    assertAllowedChat: () => {},
    resolveThreadId: (_, explicit) => (explicit != null ? Number(explicit) : undefined),
    disableLinkPreview: true,
    // Anything other than the literal 'text' is the rich-markdown path.
    defaultFormat: 'markdown',
    logStreamingEvent: () => {},
    historyEnabled: false,
    recordOutbound: () => {},
    writeError: () => {},
    throttleMs: 0,
    ...overrides,
  }
}

describe('stream-reply single-mode reuse (#2669)', () => {
  let bot: FakeBot

  beforeEach(() => {
    bot = createFakeBotApi({ startMessageId: 500 })
  })

  it('same chat+thread+lane reuses the one stream — no recreate', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'v1' }, state, deps)
    const streamBefore = state.activeDraftStreams.get('c:_')
    await handleStreamReply({ chat_id: 'c', text: 'v2' }, state, deps)
    const streamAfter = state.activeDraftStreams.get('c:_')

    // Identity preserved — there is no rotation to churn the stream.
    expect(streamBefore).toBe(streamAfter)
    // First call sent a rich message; second edited it in place.
    expect(bot.state.sent).toHaveLength(1)
    expect(bot.state.sent[0].rich).toBe(true)
    expect(bot.api.editMessageText).toHaveBeenCalled()
  })

  it('the rich path ships raw GFM markdown unescaped via sendRichMessage', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: '**bold** and _italic_' }, state, deps)

    expect(bot.state.sent).toHaveLength(1)
    expect(bot.state.sent[0].rich).toBe(true)
    // Raw markdown is the wire payload — no HTML, no MarkdownV2 escaping.
    expect(bot.state.sent[0].text).toBe('**bold** and _italic_')
    expect(bot.state.sent[0].parse_mode).toBeUndefined()
  })

  it('format:"text" takes the literal plain path (no rich wrapper)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'plain < text >', format: 'text' }, state, deps)

    expect(bot.state.sent).toHaveLength(1)
    expect(bot.state.sent[0].rich).toBeFalsy()
    expect(bot.state.sent[0].text).toBe('plain < text >')
  })

  it('switching format on the same lane does NOT recreate the stream (single mode)', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    // First call as the default rich path…
    await handleStreamReply({ chat_id: 'c', text: 'rich first', format: 'markdown' }, state, deps)
    const first = state.activeDraftStreams.get('c:_')

    // …then a call nominally requesting a different (non-text) format.
    // Pre-#2669 this rotated the stream; now there's nothing to rotate.
    await handleStreamReply({ chat_id: 'c', text: 'rich second', format: 'gfm' }, state, deps)
    const second = state.activeDraftStreams.get('c:_')

    expect(second).toBe(first)
    // Still a single message — edited in place, not a second send.
    expect(bot.state.sent).toHaveLength(1)
  })

  it('distinct lanes get independent streams', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'main', lane: 'main' }, state, deps)
    await handleStreamReply({ chat_id: 'c', text: 'activity', lane: 'activity' }, state, deps)

    expect(state.activeDraftStreams.size).toBe(2)
    expect(bot.state.sent).toHaveLength(2)
  })

  it('distinct threads get independent streams', async () => {
    const state = makeState()
    const deps = makeDeps(bot)

    await handleStreamReply({ chat_id: 'c', text: 'thread-a', message_thread_id: '1' }, state, deps)
    await handleStreamReply({ chat_id: 'c', text: 'thread-b', message_thread_id: '2' }, state, deps)

    expect(state.activeDraftStreams.size).toBe(2)
    expect(bot.state.sent).toHaveLength(2)
    expect(bot.state.sent[0].message_thread_id).toBe(1)
    expect(bot.state.sent[1].message_thread_id).toBe(2)
  })
})
