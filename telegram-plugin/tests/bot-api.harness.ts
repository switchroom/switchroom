/**
 * Reusable mock bot.api harness — ported from openclaw's
 * `extensions/telegram/src/send.test-harness.ts` pattern.
 *
 * openclaw uses `vi.hoisted` + `vi.mock('grammy')` to replace the full Bot
 * class at import time. We don't need that level of ceremony because our
 * new code (stream-controller.ts) takes the bot as an injected dependency
 * — we just hand it a mock.
 *
 * What we copy from openclaw: a single exported `botApi` record whose
 * every method is a `vi.fn()`, a `beforeEach` reset hook, and a
 * factory that returns a fresh bot wrapper with `{ api }` shape.
 *
 * This gives every streaming-related test the same mental model:
 *   "I wire `bot` into the thing under test, then assert on
 *   `botApi.sendMessage.mock.calls` / `botApi.editMessageText.mock.calls`."
 */

import { vi, beforeEach, type MockInstance } from 'vitest'

export interface MockBotApi {
  sendMessage: MockInstance<
    (
      chat_id: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ message_id: number }>
  >
  editMessageText: MockInstance<
    (
      chat_id: string,
      message_id: number,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>
  >
  deleteMessage: MockInstance<(chat_id: string, message_id: number) => Promise<true>>
  setMessageReaction: MockInstance<
    (chat_id: string, message_id: number, reactions: unknown) => Promise<true>
  >
  editMessageReplyMarkup: MockInstance<
    (chat_id: string, message_id: number, opts?: unknown) => Promise<unknown>
  >
  sendChatAction: MockInstance<(chat_id: string, action: string) => Promise<true>>
  pinChatMessage: MockInstance<
    (chat_id: string, message_id: number, opts?: unknown) => Promise<true>
  >
  getFile: MockInstance<(file_id: string) => Promise<{ file_path?: string }>>
}

export interface MockBot {
  api: MockBotApi
  /** Auto-incrementing id the default sendMessage impl assigns. */
  nextMessageId: number
}

/**
 * Create a fresh mock bot. Every method is a `vi.fn()` with a sensible
 * default. Override via the standard vitest mock API:
 *   bot.api.sendMessage.mockImplementationOnce(...)
 *   bot.api.editMessageText.mockRejectedValueOnce(new Error('...'))
 */
export function createMockBot(startMessageId = 500): MockBot {
  const state = { nextMessageId: startMessageId }

  const api: MockBotApi = {
    sendMessage: vi.fn(async () => ({ message_id: state.nextMessageId++ })),
    editMessageText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => true as const),
    setMessageReaction: vi.fn(async () => true as const),
    editMessageReplyMarkup: vi.fn(async () => undefined),
    sendChatAction: vi.fn(async () => true as const),
    pinChatMessage: vi.fn(async () => true as const),
    getFile: vi.fn(async () => ({ file_path: 'documents/file.bin' })),
  }

  return {
    api,
    get nextMessageId() {
      return state.nextMessageId
    },
    set nextMessageId(v) {
      state.nextMessageId = v
    },
  }
}

/**
 * Install a `beforeEach` hook that resets every mock on a given bot.
 * Call once at the top of a describe() block. Mirrors openclaw's
 * `installTelegramSendTestHooks`.
 */
export function installBotResetHook(bot: MockBot): void {
  beforeEach(() => {
    for (const fn of Object.values(bot.api) as MockInstance[]) {
      fn.mockReset()
    }
    // Re-apply defaults after reset (mockReset wipes the implementation).
    bot.nextMessageId = 500
    bot.api.sendMessage.mockImplementation(async () => ({
      message_id: bot.nextMessageId++,
    }))
    bot.api.editMessageText.mockImplementation(async () => undefined)
    bot.api.deleteMessage.mockImplementation(async () => true as const)
    bot.api.setMessageReaction.mockImplementation(async () => true as const)
    bot.api.editMessageReplyMarkup.mockImplementation(async () => undefined)
    bot.api.sendChatAction.mockImplementation(async () => true as const)
    bot.api.pinChatMessage.mockImplementation(async () => true as const)
    bot.api.getFile.mockImplementation(async () => ({ file_path: 'documents/file.bin' }))
  })
}

/** Convenience: wait for scheduled microtasks to drain. */
export async function microtaskFlush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
