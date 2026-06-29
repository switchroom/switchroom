/**
 * Integration tests for `createStreamController` — the wiring layer
 * between `createDraftStream` and grammy's `bot.api`.
 *
 * Post-#2669: the default path sends via `bot.api.sendRichMessage(chat,
 * { markdown }, opts)` and edits via `bot.api.editMessageText(chat, id,
 * { markdown }, opts)`. A `literalText: true` stream takes the plain
 * `sendMessage` / plain-string `editMessageText` path instead. Both share
 * one opts object, so a rich send is always followed by a rich edit.
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

  it('first update calls bot.api.sendRichMessage with raw markdown + options', async () => {
    const stream = createStreamController({
      bot,
      chatId: '123',
      threadId: 42,
      throttleMs: 1000,
    })

    void stream.update('**hi**')
    await microtaskFlush()

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    const [chat_id, rich, opts] = bot.api.sendRichMessage.mock.calls[0]
    expect(chat_id).toBe('123')
    // Raw GFM markdown passed straight through, unescaped, no HTML.
    expect(rich).toEqual({ markdown: '**hi**' })
    expect(opts).toMatchObject({ message_thread_id: 42 })
    // sendRichMessage does NOT accept link_preview_options (stripped on the
    // rich send path).
    expect(opts.link_preview_options).toBeUndefined()
    expect(stream.getMessageId()).toBe(500)
  })

  it('subsequent updates call editMessageText({ markdown }) against the captured id', async () => {
    const stream = createStreamController({ bot, chatId: '123', throttleMs: 1000 })

    void stream.update('step 1')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('step 1 — step 2')
    await microtaskFlush()

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    const [chat_id, id, text] = bot.api.editMessageText.mock.calls[0]
    expect(chat_id).toBe('123')
    expect(id).toBe(500)
    // The edit carries the rich-message wrapper, not a plain string.
    expect(text).toEqual({ markdown: 'step 1 — step 2' })
  })

  it('literalText:true takes the plain sendMessage / plain-string edit path', async () => {
    const stream = createStreamController({ bot, chatId: '123', throttleMs: 1000, literalText: true })

    void stream.update('raw < text >')
    await microtaskFlush()
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendRichMessage).not.toHaveBeenCalled()
    expect(bot.api.sendMessage.mock.calls[0][1]).toBe('raw < text >')

    vi.advanceTimersByTime(1000)
    void stream.update('raw < text > more')
    await microtaskFlush()
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    // Literal edits pass a plain string, not { markdown }.
    expect(bot.api.editMessageText.mock.calls[0][2]).toBe('raw < text > more')
  })

  it('finalize() flushes pending text as a rich edit immediately', async () => {
    const stream = createStreamController({ bot, chatId: '123', throttleMs: 1000 })

    void stream.update('draft')
    await microtaskFlush()
    void stream.update('final')
    await microtaskFlush()
    expect(bot.api.editMessageText).not.toHaveBeenCalled()

    await stream.finalize()

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toEqual({ markdown: 'final' })
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

  it('rich send strips link_preview_options but keeps message_thread_id', async () => {
    const stream = createStreamController({ bot, chatId: '1', threadId: 9 })
    void stream.update('hi')
    await microtaskFlush()
    const opts = bot.api.sendRichMessage.mock.calls[0][2]
    expect(opts.link_preview_options).toBeUndefined()
    expect(opts.message_thread_id).toBe(9)
  })

  it('omits message_thread_id when threadId is undefined', async () => {
    const stream = createStreamController({ bot, chatId: '1' })
    void stream.update('no thread')
    await microtaskFlush()
    expect(bot.api.sendRichMessage.mock.calls[0][2]?.message_thread_id).toBeUndefined()
  })

  it('rapid updates collapse to the latest; exactly one edit lands', async () => {
    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000 })

    void stream.update('initial')
    await microtaskFlush()
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)

    void stream.update('a')
    void stream.update('b')
    void stream.update('c')
    await microtaskFlush()
    expect(bot.api.editMessageText).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await microtaskFlush()

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][2]).toEqual({ markdown: 'c' })
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

  it('replyMarkup is included in sendRichMessage opts', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'Steer', callback_data: 'steer:1' }]] }
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 1000, replyMarkup: keyboard,
    })
    void stream.update('hello')
    await microtaskFlush()

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_markup).toBe(keyboard)
  })

  it('replyMarkup rides on both the rich send AND the rich edit', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'Steer', callback_data: 'steer:1' }]] }
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 1000, replyMarkup: keyboard,
    })

    void stream.update('first')
    await microtaskFlush()
    vi.advanceTimersByTime(1000)
    void stream.update('second')
    await microtaskFlush()

    expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_markup).toBe(keyboard)
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][3]?.reply_markup).toBe(keyboard)
  })

  it('replyMarkup persists through finalize flush', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'Steer', callback_data: 'steer:1' }]] }
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 1000, replyMarkup: keyboard,
    })

    void stream.update('draft')
    await microtaskFlush()
    void stream.update('final')
    await stream.finalize()

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(bot.api.editMessageText.mock.calls[0][3]?.reply_markup).toBe(keyboard)
  })

  it('omits reply_markup when replyMarkup is not provided', async () => {
    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000 })
    void stream.update('hello')
    await microtaskFlush()
    expect(bot.api.sendRichMessage.mock.calls[0][2]?.reply_markup).toBeUndefined()
  })

  it('send failure is swallowed by draft-stream loop (pinned behaviour)', async () => {
    bot.api.sendRichMessage.mockImplementationOnce(async () => {
      throw new Error('network down')
    })

    const stream = createStreamController({ bot, chatId: '1', throttleMs: 1000 })
    void stream.update('will fail')
    await microtaskFlush()

    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(stream.getMessageId()).toBeNull()
  })

  it('initialMessageId — first update edits the supplied id via rich edit, no send fires (#626)', async () => {
    const stream = createStreamController({
      bot,
      chatId: '999',
      threadId: 7,
      throttleMs: 1000,
      initialMessageId: 7777,
    })
    void stream.update('**edit-only**')
    await microtaskFlush()
    expect(bot.api.sendRichMessage).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    const [chat_id, id, text, opts] = bot.api.editMessageText.mock.calls[0]
    expect(chat_id).toBe('999')
    expect(id).toBe(7777)
    expect(text).toEqual({ markdown: '**edit-only**' })
    // The edit keeps message_thread_id but not reply_parameters/protect.
    expect(opts).toMatchObject({ message_thread_id: 7 })
    expect(stream.getMessageId()).toBe(7777)
  })
})
