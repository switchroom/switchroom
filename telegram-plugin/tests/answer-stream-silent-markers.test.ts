import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  createAnswerStream,
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

beforeEach(() => {
  nextMessageId = 9000
  // Set system time to 0 so Date.now() returns 0 and lastSentAt=0 is
  // within the throttle window — update() schedules a timer rather than
  // firing sendMessage immediately. This lets materialize() see pendingText
  // and apply the silent-marker guard before any send goes out.
  vi.useFakeTimers()
  vi.setSystemTime(0)
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
 * Previously in DMs the draft transport bypassed the minInitialChars length
 * gate in update(), so short markers like "NO_REPLY" (8 chars) reached
 * pendingText; then materialize() would send them as real messages.
 *
 * The draft transport is permanently retired. These tests now use:
 *   - minInitialChars: 0 — bypasses the length gate so update() sets pendingText
 *   - vi.setSystemTime(0) + throttleMs: 250 — since Date.now()=0 and lastSentAt=0,
 *     the throttle check (sinceLast >= 250) is false so update() schedules a timer
 *     rather than firing sendMessage immediately. materialize() cancels that timer
 *     and applies the silent-marker guard to pendingText before any send.
 *
 * Mirrors the sentinel suppression already present in:
 *   - server.ts (reply/stream_reply MCP tool handlers)
 *   - turn-flush-safety.ts (stop-hook decideTurnFlush)
 *   - gateway.ts (gateway turn-flush)
 */
describe('answer-stream — silent-marker suppression at materialize()', () => {
  it('NO_REPLY as the sole chunk — no outbound message, suppression log line emitted', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat42',
      // minInitialChars: 0 bypasses the length gate so short markers like
      // "NO_REPLY" (8 chars) set pendingText. Combined with vi.setSystemTime(0),
      // the throttle keeps update() from firing sendMessage immediately, so
      // materialize() can apply the silent-marker guard.
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      log: (msg) => logs.push(msg),
    })

    // Simulate: model emits exactly NO_REPLY, no reply/stream_reply call.
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
    const stream = createAnswerStream({
      chatId: 'chat43',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('HEARTBEAT_OK')
    const msgId = await stream.materialize()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(msgId).toBeUndefined()
  })

  it('NO_REPLY. (trailing period) — suppressed by trailing-punctuation tolerance', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat44',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
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
    const stream = createAnswerStream({
      chatId: 'chat45',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    const prose = 'the agent suggested NO_REPLY earlier'
    stream.update(prose)
    const msgId = await stream.materialize()

    // materialize() sends a fresh message — prose is not a silent marker
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'chat45',
      prose,
      expect.objectContaining({ parse_mode: 'HTML' }),
    )
    expect(typeof msgId).toBe('number')
  })

  it('multi-chunk update where final body equals NO_REPLY — still suppressed (#299 review feedback)', async () => {
    // update() replaces pendingText wholesale on each call, so two updates
    // where the second equals NO_REPLY should suppress at materialize().
    // This pins the assumption that the guard fires on final resolved body,
    // not on any intermediate chunk.
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat47',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      log: (msg) => logs.push(msg),
    })

    // Model first emits a draft thought, then revises to bare NO_REPLY.
    stream.update('let me think...')
    stream.update('NO_REPLY')
    const msgId = await stream.materialize()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(msgId).toBeUndefined()
    expect(logs.some(l => /silent-marker-suppressed.*NO_REPLY.*chatId=chat47/i.test(l))).toBe(true)
  })

  it('empty body — materialize returns undefined, no outbound (existing behaviour)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const logs: string[] = []
    const stream = createAnswerStream({
      chatId: 'chat46',
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
