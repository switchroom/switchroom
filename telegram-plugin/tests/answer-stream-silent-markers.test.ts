import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  createAnswerStream,
  __resetDraftIdForTests,
} from '../answer-stream.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SendMessageFn = (
  chatId: string,
  text: string,
  params?: {
    parse_mode?: 'HTML'
    message_thread_id?: number
    link_preview_options?: { is_disabled: boolean }
    reply_parameters?: { message_id: number }
  },
) => Promise<{ message_id: number }>

type EditMessageTextFn = (
  chatId: string,
  messageId: number,
  text: string,
  params?: {
    parse_mode?: 'HTML'
    message_thread_id?: number
    link_preview_options?: { is_disabled: boolean }
  },
) => Promise<unknown>

type SendMessageDraftFn = (
  chatId: string,
  draftId: number,
  text: string,
  params?: { message_thread_id?: number },
) => Promise<unknown>

let nextMessageId = 9000

function makeSendMessage(): ReturnType<typeof vi.fn> & SendMessageFn {
  const fn = vi.fn(async (_chatId: string, _text: string) => {
    return { message_id: nextMessageId++ }
  })
  return fn as unknown as ReturnType<typeof vi.fn> & SendMessageFn
}

function makeEditMessageText(): ReturnType<typeof vi.fn> & EditMessageTextFn {
  return vi.fn(async () => {}) as unknown as ReturnType<typeof vi.fn> & EditMessageTextFn
}

function makeSendMessageDraft(): ReturnType<typeof vi.fn> & SendMessageDraftFn {
  return vi.fn(async () => {}) as unknown as ReturnType<typeof vi.fn> & SendMessageDraftFn
}

beforeEach(() => {
  __resetDraftIdForTests()
  nextMessageId = 9000
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * Regression coverage for #299: answer-stream materialize() must honor the
 * NO_REPLY / HEARTBEAT_OK silent markers and suppress outbound Telegram
 * messages when the whole turn body is one of those tokens.
 *
 * Root cause: in private chats (DMs), usesDraftTransport=true bypasses the
 * minInitialChars length gate in update(), so even short markers like "NO_REPLY"
 * (8 chars) reach pendingText and then materialize() sends them as real messages.
 *
 * Mirrors the sentinel suppression already present in:
 *   - server.ts (reply/stream_reply MCP tool handlers)
 *   - turn-flush-safety.ts (stop-hook decideTurnFlush)
 *   - gateway.ts (gateway turn-flush)
 */
describe('answer-stream — silent-marker suppression at materialize()', () => {
  it('NO_REPLY as the sole chunk — no outbound message, suppression log line emitted', async () => {
    // Use isPrivateChat: true + sendMessageDraft to replicate the exact repro
    // conditions from #299: DM chat bypasses the minInitialChars length gate
    // in update(), so "NO_REPLY" (8 chars) reaches pendingText and materialize()
    // would previously send it as a real Telegram message.
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat42',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
      log: (msg) => logs.push(msg),
    })

    // Simulate: model emits exactly NO_REPLY, no reply/stream_reply call.
    // In a DM, update() bypasses the length gate and sets pendingText.
    stream.update('NO_REPLY')
    // materialize() is what gateway.ts calls at turn_end when no tool reply
    // was made — this is the path that was broken in #299 (msg id=8268).
    const msgId = await stream.materialize()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
    expect(msgId).toBeUndefined()
    expect(logs.some(l => /silent-marker-suppressed.*NO_REPLY.*chatId=chat42/i.test(l))).toBe(true)
  })

  it('HEARTBEAT_OK as the sole chunk — no outbound message', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const stream = createAnswerStream({
      chatId: 'chat43',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    stream.update('HEARTBEAT_OK')
    const msgId = await stream.materialize()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(msgId).toBeUndefined()
  })

  it('NO_REPLY. (trailing period) — suppressed by trailing-punctuation tolerance', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat44',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
      log: (msg) => logs.push(msg),
    })

    stream.update('NO_REPLY.')
    const msgId = await stream.materialize()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(msgId).toBeUndefined()
    expect(logs.some(l => /silent-marker-suppressed/i.test(l))).toBe(true)
  })

  it('substring match ("the agent suggested NO_REPLY earlier") — NOT suppressed, materialises normally', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const stream = createAnswerStream({
      chatId: 'chat45',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    const prose = 'the agent suggested NO_REPLY earlier'
    stream.update(prose)
    // materialize() should send a fresh message — only 1 call, from materialize
    // itself (update() in draft mode sends a draft, not a sendMessage call).
    const msgId = await stream.materialize()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'chat45',
      prose,
      expect.objectContaining({ parse_mode: 'HTML' }),
    )
    expect(typeof msgId).toBe('number')
  })

  it('empty body — materialize returns undefined, no outbound (existing behaviour)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat46',
      isPrivateChat: false,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      log: (msg) => logs.push(msg),
    })

    // No update() call — nothing buffered.
    const msgId = await stream.materialize()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(msgId).toBeUndefined()
    // Existing log message for empty body
    expect(logs.some(l => /nothing to send/i.test(l))).toBe(true)
  })
})
