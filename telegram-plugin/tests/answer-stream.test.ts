import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createAnswerStream,
  __resetDraftIdForTests,
  MIN_INITIAL_CHARS,
  DRAFT_METHOD_UNAVAILABLE_RE,
  DRAFT_CHAT_UNSUPPORTED_RE,
} from '../answer-stream.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flush microtask queue N times. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

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

let nextMessageId = 1000

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

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetDraftIdForTests()
  nextMessageId = 1000
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('answer-stream — minInitialChars threshold', () => {
  it('does not call transport when text is below minInitialChars', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 400,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    // 200 chars < 400 threshold
    stream.update('x'.repeat(200))
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('calls transport exactly once when text meets minInitialChars', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 400,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    // 500 chars >= 400 threshold
    stream.update('y'.repeat(500))
    // effectiveThrottle = max(250, 250) = 250; lastSentAt=0 so fires immediately
    await flushMicrotasks()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      'y'.repeat(500),
      expect.objectContaining({ parse_mode: 'HTML' }),
    )
    expect(editMessageText).not.toHaveBeenCalled()
  })
})

describe('answer-stream — draft transport selection', () => {
  it('uses sendMessageDraft for DMs (isPrivateChat: true)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    // Draft transport bypasses minInitialChars gate — any non-empty text goes
    stream.update('Hello from DM!')
    await flushMicrotasks()

    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
    expect(sendMessageDraft).toHaveBeenCalledWith(
      'chat1',
      expect.any(Number),
      'Hello from DM!',
      undefined,
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('uses sendMessage for non-DM chats even when sendMessageDraft is provided', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 10,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    stream.update('x'.repeat(50))
    await flushMicrotasks()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessageDraft).not.toHaveBeenCalled()
  })
})

describe('answer-stream — runtime fallback when sendMessageDraft rejects', () => {
  it('falls back to sendMessage when sendMessageDraft throws DRAFT_METHOD_UNAVAILABLE_RE pattern', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    // The shouldFallbackFromDraftTransport helper checks for "sendMessageDraft" in the
    // error message plus the regex pattern.
    const sendMessageDraft = vi.fn(async () => {
      throw new Error('sendMessageDraft: unknown method')
    })

    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    // First update — draft throws, falls back
    stream.update('Hello DM!')
    await flushMicrotasks()

    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
    // After fallback, sendMessage should have been called with the same text
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('chat1', 'Hello DM!', expect.any(Object))

    // Subsequent update should use sendMessage+editMessageText, not draft
    sendMessageDraft.mockClear()
    sendMessage.mockClear()
    vi.advanceTimersByTime(1000)
    stream.update('Follow-up!')
    await flushMicrotasks()

    expect(sendMessageDraft).not.toHaveBeenCalled()
    expect(editMessageText).toHaveBeenCalledTimes(1)
  })

  it('falls back when sendMessageDraft throws DRAFT_CHAT_UNSUPPORTED_RE pattern', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = vi.fn(async () => {
      throw new Error("sendMessageDraft can't be used in this chat")
    })

    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: true,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    stream.update('Hello!')
    await flushMicrotasks()

    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('chat1', 'Hello!', expect.any(Object))
  })
})

describe('answer-stream — throttling', () => {
  it('three rapid updates within throttleMs result in at most two transport calls', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const THROTTLE = 1000
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 10,
      throttleMs: THROTTLE,
      sendMessage,
      editMessageText,
    })

    // First update — fires immediately (lastSentAt=0)
    stream.update('a'.repeat(50))
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // Three rapid updates within the throttle window
    stream.update('b'.repeat(50))
    stream.update('c'.repeat(50))
    stream.update('d'.repeat(50))
    await flushMicrotasks()
    // Not yet — throttle window not elapsed
    expect(editMessageText).toHaveBeenCalledTimes(0)

    // Advance past the throttle window
    vi.advanceTimersByTime(THROTTLE)
    await flushMicrotasks()

    // Only the latest (coalesced) text lands — at most one edit call
    expect(editMessageText.mock.calls.length).toBeLessThanOrEqual(1)
    if (editMessageText.mock.calls.length === 1) {
      expect(editMessageText.mock.calls[0][2]).toBe('d'.repeat(50))
    }

    // Total transport calls: 1 initial send + at most 1 coalesced edit
    const totalCalls = sendMessage.mock.calls.length + editMessageText.mock.calls.length
    expect(totalCalls).toBeLessThanOrEqual(2)
  })
})

describe('answer-stream — materialize()', () => {
  it('sends a fresh sendMessage (not editMessageText) on materialize', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const THROTTLE = 1000
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 10,
      throttleMs: THROTTLE,
      sendMessage,
      editMessageText,
    })

    // Stream some text
    stream.update('x'.repeat(50))
    await flushMicrotasks()
    // Advance so the initial send lands
    vi.advanceTimersByTime(THROTTLE)
    await flushMicrotasks()

    const sendCallsBefore = sendMessage.mock.calls.length
    editMessageText.mockClear()

    // materialize() should fire a fresh sendMessage
    const msgId = await stream.materialize()

    expect(typeof msgId).toBe('number')
    expect(sendMessage.mock.calls.length).toBeGreaterThan(sendCallsBefore)
    // materialize always uses sendMessage, never editMessageText
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('materialize() is idempotent — second call returns same id, no extra sendMessage', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 10,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('x'.repeat(50))
    await flushMicrotasks()

    const id1 = await stream.materialize()
    const sendCallsAfterFirst = sendMessage.mock.calls.length

    const id2 = await stream.materialize()

    expect(id1).toBe(id2)
    // No additional sendMessage calls on the second call
    expect(sendMessage.mock.calls.length).toBe(sendCallsAfterFirst)
  })
})

describe('answer-stream — forceNewMessage() supersession', () => {
  it('after forceNewMessage(), next update sends a fresh message not an edit', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const THROTTLE = 1000
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 10,
      throttleMs: THROTTLE,
      sendMessage,
      editMessageText,
    })

    // Stream initial text
    stream.update('x'.repeat(50))
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const firstMsgId = sendMessage.mock.calls[0]

    // Advance past throttle so a new update is ready to send
    vi.advanceTimersByTime(THROTTLE)
    await flushMicrotasks()

    // Now force a new message
    stream.forceNewMessage()
    sendMessage.mockClear()
    editMessageText.mockClear()

    // Next update should NOT edit the old message — should send a fresh one
    stream.update('y'.repeat(50))
    await flushMicrotasks()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(editMessageText).not.toHaveBeenCalled()
  })
})

describe('answer-stream — stop() cancels pending throttled edits', () => {
  it('stop() before timer fires prevents any transport call', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const THROTTLE = 1000
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 10,
      throttleMs: THROTTLE,
      sendMessage,
      editMessageText,
    })

    // Send initial to get msgId established
    stream.update('x'.repeat(50))
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // Schedule a throttled edit
    stream.update('y'.repeat(50))
    await flushMicrotasks()
    // Not yet sent (within throttle window)
    expect(editMessageText).toHaveBeenCalledTimes(0)

    // Stop before the timer fires
    stream.stop()
    sendMessage.mockClear()
    editMessageText.mockClear()

    // Advance well past the throttle window
    vi.advanceTimersByTime(THROTTLE * 3)
    await flushMicrotasks()

    // The pending edit should NOT have fired
    expect(editMessageText).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('answer-stream — empty / whitespace-only text is a no-op', () => {
  it('update("") does not trigger any transport call', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('')
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('update("   ") does not trigger any transport call', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('   ')
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })
})

describe('answer-stream — maxChars guard', () => {
  it('does not send when text exceeds 4096 chars', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    // 4097 chars exceeds Telegram's 4096 limit
    stream.update('z'.repeat(4097))
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })
})

describe('answer-stream — materialize() on draft transport', () => {
  it('clears the draft and sends a fresh sendMessage on materialize', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: true,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
    })

    stream.update('hello world')
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    expect(sendMessageDraft).toHaveBeenCalled()
    const draftCallsBeforeMaterialize = sendMessageDraft.mock.calls.length

    const finalId = await stream.materialize()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toBe('hello world')
    expect(typeof finalId).toBe('number')

    expect(sendMessageDraft.mock.calls.length).toBeGreaterThan(draftCallsBeforeMaterialize)
    const lastDraftCall = sendMessageDraft.mock.calls[sendMessageDraft.mock.calls.length - 1]
    expect(lastDraftCall[2]).toBe('')
  })
})

describe('answer-stream — onSuperseded callback', () => {
  it('invokes onSuperseded when a send resolves after forceNewMessage', async () => {
    const onSuperseded = vi.fn()

    let resolveSend: ((value: { message_id: number }) => void) | undefined
    const sendMessage = vi.fn(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          resolveSend = resolve
        }),
    ) as unknown as ReturnType<typeof vi.fn> & SendMessageFn

    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      onSuperseded,
    })

    stream.update('first message text')
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(resolveSend).toBeDefined()

    stream.forceNewMessage()

    resolveSend!({ message_id: 9999 })
    await flushMicrotasks()

    expect(onSuperseded).toHaveBeenCalledTimes(1)
    expect(onSuperseded.mock.calls[0][0]).toEqual({
      messageId: 9999,
      textSnapshot: 'first message text',
    })
    expect(stream.messageId()).toBeUndefined()
  })
})

describe('answer-stream — materialize() max-chars guard', () => {
  it('does not send when buffered text exceeds 4096 chars', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const warn = vi.fn()
    const stream = createAnswerStream({
      chatId: 'chat1',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      warn,
    })

    stream.update('a'.repeat(4000))
    vi.advanceTimersByTime(500)
    await flushMicrotasks()
    const sendsAfterStreaming = sendMessage.mock.calls.length

    stream.update('b'.repeat(4097))
    const result = await stream.materialize()

    expect(result).toBeUndefined()
    expect(sendMessage.mock.calls.length).toBe(sendsAfterStreaming)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => /4096|exceeds/i.test(String(c[0])))).toBe(true)
  })
})

// ─── Issue #203: onMetric callback ──────────────────────────────────────────
describe('answer-stream — onMetric callback (#203)', () => {
  it('fires answer_lane_update on first sendMessage (non-DM, message transport)', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chatX',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      onMetric,
    })

    stream.update('hello there friend, this is some answer text')
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    expect(onMetric).toHaveBeenCalledTimes(1)
    const ev = onMetric.mock.calls[0][0] as { kind: string; chatId: string; transport: string; charCount: number }
    expect(ev.kind).toBe('answer_lane_update')
    expect(ev.chatId).toBe('chatX')
    expect(ev.transport).toBe('message')
    expect(typeof ev.charCount).toBe('number')
    expect(ev.charCount).toBeGreaterThan(0)
  })

  it('fires answer_lane_update on edit (transport: edit)', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chatX',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      onMetric,
    })

    stream.update('initial text')
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    stream.update('initial text plus more')
    vi.advanceTimersByTime(1500)
    await flushMicrotasks()

    const transports = onMetric.mock.calls.map((c) => (c[0] as { transport: string }).transport)
    expect(transports).toContain('message')
    expect(transports).toContain('edit')
  })

  it('fires answer_lane_update on draft transport for DMs', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const sendMessageDraft = makeSendMessageDraft()
    const stream = createAnswerStream({
      chatId: 'chatX',
      isPrivateChat: true,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      sendMessageDraft,
      onMetric,
    })

    stream.update('streaming via draft')
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const draftEvents = onMetric.mock.calls
      .map((c) => c[0] as { kind: string; transport?: string })
      .filter((ev) => ev.kind === 'answer_lane_update' && ev.transport === 'draft')
    expect(draftEvents.length).toBeGreaterThan(0)
  })

  it('fires answer_lane_materialized on materialize success', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chatX',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      onMetric,
    })

    stream.update('full answer text')
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    onMetric.mockClear()
    const id = await stream.materialize()

    expect(typeof id).toBe('number')
    expect(onMetric).toHaveBeenCalledTimes(1)
    const ev = onMetric.mock.calls[0][0] as { kind: string; chatId: string; messageId: number }
    expect(ev.kind).toBe('answer_lane_materialized')
    expect(ev.chatId).toBe('chatX')
    expect(ev.messageId).toBe(id)
  })

  it('does not fire answer_lane_materialized when oversize guard rejects', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chatX',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      onMetric,
    })

    stream.update('x'.repeat(4097))
    onMetric.mockClear()
    const id = await stream.materialize()

    expect(id).toBeUndefined()
    const matEvents = onMetric.mock.calls
      .map((c) => c[0] as { kind: string })
      .filter((ev) => ev.kind === 'answer_lane_materialized')
    expect(matEvents).toHaveLength(0)
  })
})
