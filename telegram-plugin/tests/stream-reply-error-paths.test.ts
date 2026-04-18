/**
 * Integration tests — stream-reply-handler wired against the realistic
 * fake bot API (with fault injection) and the real retry policy.
 *
 * These tests exercise the full error chain (fake GrammyError → retry
 * policy → draft-stream → caller result) end to end. Before this suite,
 * those paths existed only in production.
 *
 * NOTE on draft-stream behaviour: the current implementation SILENTLY
 * SWALLOWS any error that isn't specifically recognised (not-modified,
 * message-to-edit-not-found). A 403, thread-not-found, or exhausted 429
 * all end up logged and dropped. The handler's "finalized without
 * sending any message" check at stream-reply-handler.ts:397 is the only
 * signal a caller gets that something went wrong. These tests document
 * that contract rather than the one a strict API would have — changing
 * it is tracked separately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleStreamReply, type StreamReplyDeps, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { markdownToHtml as realMarkdownToHtml } from '../format.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { createFakeBotApi, errors, type FakeBot } from './fake-bot-api.js'

function makeState(): StreamReplyState {
  return {
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    activeDraftParseModes: new Map<string, 'HTML' | 'MarkdownV2' | undefined>(),
  }
}

function makeDeps(
  bot: FakeBot,
  overrides?: Partial<StreamReplyDeps>,
): StreamReplyDeps {
  return {
    bot: bot as unknown as StreamReplyDeps['bot'],
    retry: createRetryApiCall(),
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

/**
 * Pump vi fake timers + microtasks until all pending work settles.
 * The draft-stream's `flushLoop` has setTimeout(0) schedules that need
 * explicit advancement even at throttleMs=0, plus intermediate awaits.
 */
async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(ms)
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
    it('retries after retry_after and the message lands', async () => {
      bot.faults.next('sendMessage', errors.floodWait(2))
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
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
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
      expect(bot.state.currentText.get(500)).toBe(realMarkdownToHtml('v2'))
    })
  })

  describe('editMessageText transient failures (swallowed by retry)', () => {
    // These tests use REAL timers because draft-stream's throttling
    // sequence across two updates is hard to deterministically pump with
    // fake timers (the setTimeout(0) schedule is inside a promise chain
    // that re-enters after the first flush completes). Real timers +
    // a tiny throttle keeps the test fast and reliable.
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
    // The following tests document the current swallow-all contract in
    // draft-stream.ts. When a send fails with 403 / thread-not-found / a
    // retry-exhausted network error, draft-stream's catch-all at line 182
    // logs + continues. The HANDLER then sees getMessageId() == null on
    // finalize and throws the "finalized without sending" error.
    //
    // If draft-stream grows a lastError hook later, these assertions
    // should be tightened to match the real underlying error.

    it('403 forbidden surfaces as "finalized without sending" on done=true', async () => {
      bot.faults.next('sendMessage', errors.forbidden())
      const state = makeState()
      const deps = makeDeps(bot)

      await expect(
        handleStreamReply({ chat_id: 'c', text: 'hi', done: true }, state, deps),
      ).rejects.toThrowError(/finalized without sending/)
    })

    it('thread-not-found surfaces as "finalized without sending" on done=true', async () => {
      bot.faults.next('sendMessage', errors.threadNotFound())
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
})
