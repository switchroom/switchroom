/**
 * Integration tests — stream-reply-handler wired against the realistic
 * fake bot API (with fault injection) and the real retry policy.
 *
 * These tests exercise the full error chain (fake GrammyError → retry
 * policy → draft-stream → caller result) end to end. Post-#2669 the
 * default path is the rich-message send (`sendRichMessage`) / rich edit
 * (`editMessageText({ markdown })`), so faults are injected on those
 * methods and the wire body is the raw GFM markdown (no HTML render).
 *
 * NOTE on draft-stream behaviour: the current implementation SILENTLY
 * SWALLOWS any error that isn't specifically recognised (not-modified,
 * message-to-edit-not-found, parse-entities). A 403, thread-not-found, or
 * exhausted 429 all end up logged and dropped. The handler's "finalized
 * without sending any message" check is the only signal a caller gets
 * that something went wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { createFakeBotApi, errors, type FakeBot } from './fake-bot-api.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
  }
}

function makeDeps(
  bot: FakeBot,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot: bot as unknown as StreamReplyDeps['bot'],
    retry: createRetryApiCall(),
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

/**
 * Pump vi fake timers + microtasks until all pending work settles.
 * vi.advanceTimersByTimeAsync isn't implemented under bun's test runner.
 */
async function advanceFakeClock(ms: number): Promise<void> {
  const viAny = vi as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
  if (typeof viAny.advanceTimersByTimeAsync === 'function') {
    await viAny.advanceTimersByTimeAsync(ms)
    return
  }
  vi.advanceTimersByTime(ms)
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await advanceFakeClock(ms)
    await Promise.resolve()
  }
}

describe('stream-reply-handler × real retry × fake bot', () => {
  let bot: FakeBot

  beforeEach(() => {
    vi.useFakeTimers()
    bot = createFakeBotApi({ startMessageId: 500 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('flood-wait retry', () => {
    it('retries after retry_after and the rich message lands', async () => {
      bot.faults.next('sendRichMessage', errors.floodWait(2, 'sendRichMessage'))
      const state = makeState()
      const deps = makeDeps(bot)

      const pending = handleStreamReply(
        { chat_id: 'c', text: 'hello', done: true },
        state,
        deps,
      )
      // First attempt fails → retry sleeps 2s.
      await settle(0)
      await settle(2000)
      const result = await pending

      expect(result.status).toBe('finalized')
      expect(result.messageId).toBe(500)
      expect(bot.state.sent).toHaveLength(1)
      expect(bot.state.sent[0].rich).toBe(true)
      expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(2)
    })

    it('flood-wait on editMessageText is transparent to caller', async () => {
      const state = makeState()
      const deps = makeDeps(bot)

      const p1 = handleStreamReply({ chat_id: 'c', text: 'v1' }, state, deps)
      await settle(0)
      await p1
      expect(bot.state.sent).toHaveLength(1)

      bot.faults.next('editMessageText', errors.floodWait(1))
      const pending = handleStreamReply({ chat_id: 'c', text: 'v2' }, state, deps)
      await settle(0)
      await settle(1000)
      const r = await pending

      expect(r.status).toBe('updated')
      // Raw markdown is the stored body — no HTML render.
      expect(bot.state.currentText.get(500)).toBe('v2')
    })
  })

  describe('editMessageText transient failures (swallowed by retry)', () => {
    beforeEach(() => vi.useRealTimers())

    it('retry returns undefined for "message is not modified"; stream continues', async () => {
      const state = makeState()
      const deps = makeDeps(bot)

      await handleStreamReply({ chat_id: 'c', text: 'v1' }, state, deps)
      expect(bot.state.sent).toHaveLength(1)

      bot.faults.next('editMessageText', errors.notModified())
      const r = await handleStreamReply({ chat_id: 'c', text: 'v2' }, state, deps)

      expect(r.status).toBe('updated')
      expect(bot.api.editMessageText).toHaveBeenCalled()
      expect(bot.state.sent).toHaveLength(1)
    })

    it('retry returns undefined for "message to edit not found"', async () => {
      const state = makeState()
      const deps = makeDeps(bot)

      await handleStreamReply({ chat_id: 'c', text: 'v1' }, state, deps)

      bot.faults.next('editMessageText', errors.messageToEditNotFound())
      await handleStreamReply({ chat_id: 'c', text: 'v2' }, state, deps)

      // Caller did not see an exception; the stream survives.
      expect(state.activeDraftStreams.has('c:_')).toBe(true)
    })
  })

  describe('non-retryable errors (current behaviour: swallowed by draft-stream)', () => {
    it('403 forbidden surfaces as "finalized without sending" on done=true', async () => {
      bot.faults.next('sendRichMessage', errors.forbidden('sendRichMessage'))
      const state = makeState()
      const deps = makeDeps(bot)

      await expect(
        handleStreamReply({ chat_id: 'c', text: 'hi', done: true }, state, deps),
      ).rejects.toThrowError(/finalized without sending/)
    })

    it('thread-not-found surfaces as "finalized without sending" on done=true', async () => {
      bot.faults.next('sendRichMessage', errors.threadNotFound('sendRichMessage'))
      const state = makeState()
      const deps = makeDeps(bot)

      await expect(
        handleStreamReply(
          { chat_id: 'c', text: 'hi', message_thread_id: '42', done: true },
          state,
          deps,
        ),
      ).rejects.toThrowError(/finalized without sending/)
    })
  })

  describe('parse-entities fallback (#657) end to end', () => {
    it('first rich send rejected for bad markdown → retries SAME turn as plain text, one message', async () => {
      bot.faults.next(
        'sendRichMessage',
        errors.badRequest("can't parse entities: bad markdown", 'sendRichMessage'),
      )
      const state = makeState()
      const deps = makeDeps(bot)

      const pending = handleStreamReply(
        { chat_id: 'c', text: '**broken _markdown', done: true },
        state,
        deps,
      )
      await settle(0)
      const result = await pending

      expect(result.status).toBe('finalized')
      // Exactly one message — the plain-text recovery send.
      expect(bot.state.sent).toHaveLength(1)
      expect(bot.state.sent[0].rich).toBeFalsy()
      expect(bot.state.sent[0].text).toBe('**broken _markdown')
    })
  })
})
