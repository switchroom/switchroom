/**
 * Integration tests for `createStreamController` — the wiring layer
 * between `createDraftStream` and grammy's `bot.api`.
 *
 * Uses the ported openclaw-style mock bot harness (`bot-api.harness.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStreamController } from '../stream-controller.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

describe('createStreamController', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first update calls bot.api.sendMessage with rendered text + options', async () => {
    const stream = createStreamController({
      bot,
      chatId: '123',
      threadId: 42,
      parseMode: 'HTML',
      throttleMs: 1000,
    })

    void stream.update('<b>hi</b>')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    const [chat_id, text, opts] = bot.api.sendMessage.mock.calls[0]
    expect(chat_id).toBe('123')
    expect(text).toBe('<b>hi</b>')
    expect(opts).toMatchObject({
      parse_mode: 'HTML',
      message_thread_id: 42,
      link_preview_options: { is_disabled: true },
    })
    expect(stream.getMessageId()).toBe(500)
  })

  it('subsequent updates call editMessageText against the captured id', async () => {
    const stream = createStreamController({ bot, chatId: '123', throttleMs: 1000 })

    void stream.update('step 1')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('step 1 — step 2')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    const [chat_id, id, text] = bot.api.editMessageText.mock.calls[0]
    expect(chat_id).toBe('123')
    expect(id).toBe(500)
    expect(text).toBe('step 1 — step 2')
  })

  it('finalize() flushes pending text as an edit immediately', async () => {
    const stream = createStreamController({ bot, chatId: '123', throttleMs: 1000 })

    void stream.update('draft')
    await microtaskFlush()
    void stream.update('final')
    await microtaskFlush()
    expect(bot.api.editMessageText).not.toHaveBeenCalled()

    await stream.finalize()

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('final')
    expect(stream.isFinal()).toBe(true)
  })

  it('onSend and onEdit observers fire once per successful API call', async () => {
    const onSend = vi.fn<(id: number, chars: number) => void>()
    const onEdit = vi.fn<(id: number, chars: number) => void>()
    const stream = createStreamController({
      bot,
      chatId: '1',
      throttleMs: 1000,
      onSend,
      onEdit,
    })

    void stream.update('hello')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('hello world')
    await microtaskFlush()

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(500, 5)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith(500, 11)
  })

  it('omits parse_mode when not provided (plain text mode)', async () => {
    const stream = createStreamController({ bot, chatId: '1' })
    void stream.update('plain')
    await microtaskFlush()
    expect(bot.api.sendMessage.mock.calls[0][2]?.parse_mode).toBeUndefined()
  })

  it('omits message_thread_id when threadId is undefined', async () => {
    const stream = createStreamController({ bot, chatId: '1' })
    void stream.update('no thread')
    await microtaskFlush()
    expect(bot.api.sendMessage.mock.calls[0][2]?.message_thread_id).toBeUndefined()
  })

  it('rapid updates collapse to the latest; exactly one edit lands', async () => {
    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000 })

    void stream.update('initial')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)

    void stream.update('a')
    void stream.update('b')
    void stream.update('c')
    await microtaskFlush()
    expect(bot.api.editMessageText).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await microtaskFlush()

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('c')
  })

  it('treats "message is not modified" edit errors as success (swallow)', async () => {
    bot.api.editMessageText.mockImplementationOnce(async () => {
      throw new Error('Bad Request: message is not modified')
    })

    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000 })
    void stream.update('first')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()

    expect(stream.isFinal()).toBe(false)
  })

  it('passes retry policy through to both send and edit', async () => {
    const retry = vi.fn(<T>(fn: () => Promise<T>) => fn())
    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000, retry })

    void stream.update('a')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('b')
    await microtaskFlush()

    expect(retry).toHaveBeenCalledTimes(2)
    expect(retry.mock.calls[0][1]).toEqual({ threadId: undefined, chat_id: '1' })
  })

  it('send failure is swallowed by draft-stream loop (pinned behaviour)', async () => {
    bot.api.sendMessage.mockImplementationOnce(async () => {
      throw new Error('network down')
    })

    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000 })
    void stream.update('will fail')
    await microtaskFlush()

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(stream.getMessageId()).toBeNull()
    // This pins the current "swallow and continue" semantics. When we
    // harden error handling later, this test flips to expect a thrown
    // error or a status-reaction signal — whichever we decide.
  })
})
