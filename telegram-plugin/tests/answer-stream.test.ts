import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createAnswerStream,
  MIN_INITIAL_CHARS,
} from '../answer-stream.js'
import { resolveAnswerLaneConfig, ANSWER_LANE_NEVER_OPENS } from '../answer-stream-flag.js'

// #2669: the answer lane no longer converts markdown → HTML. It ships the RAW
// assistant transcript markdown through its sendMessage/editMessageText
// closures, which the gateway wires to the rich-message path
// (`sendRichMessage` / `editMessageText({ markdown })`). There is no
// renderText / parse_mode anymore — the body IS the raw GFM markdown.

// The rich-message wire cap the answer lane guards against (matches
// answer-stream.ts's TELEGRAM_MAX_CHARS).
const TELEGRAM_MAX_CHARS = 32768

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

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
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

  it('FLASH REGRESSION: the DORMANT config (visible off, draft retired) sends NOTHING, even for a full answer', async () => {
    // End-to-end proof that the resolved default config produces no visible
    // preview → nothing to retract → no flash. Wires the ACTUAL resolver output
    // (not a hand-picked threshold) into the stream.
    const lane = resolveAnswerLaneConfig({ visibleEnabled: false })
    expect(lane.state).toBe('dormant')
    expect(lane.minInitialChars).toBe(ANSWER_LANE_NEVER_OPENS)

    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      minInitialChars: lane.minInitialChars,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    // A realistic full answer — 2000 chars, far above any normal threshold.
    stream.update('The answer is '.repeat(150))
    vi.advanceTimersByTime(5000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('calls transport exactly once when text meets minInitialChars', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
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
      // #2669: no parse_mode — the body ships as raw markdown via the rich path.
      expect.not.objectContaining({ parse_mode: 'HTML' }),
    )
    expect(editMessageText).not.toHaveBeenCalled()
  })
})

describe('answer-stream — raw GFM markdown passthrough (#2669)', () => {
  // The answer lane historically shipped the RAW assistant transcript under
  // parse_mode:'HTML', so `**bold**` arrived as literal asterisks. Post-#2669
  // there is ONE rich-markdown path: the lane ships the raw markdown VERBATIM
  // (the gateway wraps it in `sendRichMessage` / `editMessageText({ markdown })`),
  // so `**bold**` reaches Telegram intact and renders as bold there.

  it('ships raw markdown verbatim on the opening sendMessage (no HTML conversion)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      minInitialChars: 10,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('Here is some **bold** narration text for the user.')
    await flushMicrotasks()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const sentText = sendMessage.mock.calls[0][1] as string
    // Raw markdown passes through unchanged — no <b> conversion.
    expect(sentText).toContain('**bold**')
    expect(sentText).not.toContain('<b>bold</b>')
    expect(sendMessage.mock.calls[0][2]).not.toHaveProperty('parse_mode')
  })

  it('ships raw markdown verbatim on a follow-up editMessageText', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      minInitialChars: 10,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('first chunk of the answer arriving')
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(300)
    stream.update('first chunk of the answer arriving with **bold** added')
    vi.advanceTimersByTime(300)
    await flushMicrotasks()

    expect(editMessageText).toHaveBeenCalled()
    const editText = editMessageText.mock.calls.at(-1)![2] as string
    expect(editText).toContain('**bold**')
    expect(editText).not.toContain('<b>bold</b>')
  })

  it('ships raw markdown verbatim on materialize', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      minInitialChars: 10,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update('The final answer is **definitely** forty-two.')
    await flushMicrotasks()
    const sendsBeforeMaterialize = sendMessage.mock.calls.length

    const id = await stream.materialize()
    expect(typeof id).toBe('number')
    expect(sendMessage.mock.calls.length).toBe(sendsBeforeMaterialize + 1)
    const sentText = sendMessage.mock.calls.at(-1)![1] as string
    expect(sentText).toContain('**definitely**')
    expect(sentText).not.toContain('<b>definitely</b>')
  })
})

describe('answer-stream — throttling', () => {
  it('three rapid updates within throttleMs result in at most two transport calls', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const THROTTLE = 1000
    const stream = createAnswerStream({
      chatId: 'chat1',
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
      minInitialChars: 10,
      throttleMs: THROTTLE,
      sendMessage,
      editMessageText,
    })

    // Stream initial text
    stream.update('x'.repeat(50))
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

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
  it('does not send when text exceeds the rich-message cap (#2669)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    // One char over the 32768 rich-message limit.
    stream.update('z'.repeat(TELEGRAM_MAX_CHARS + 1))
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('DOES send a body that fits under the 32768 cap (was rejected under the old 4096)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat1',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    // 8000 chars — over the legacy 4096 cap but well under the rich cap.
    stream.update('z'.repeat(8000))
    await flushMicrotasks()

    expect(sendMessage).toHaveBeenCalledTimes(1)
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
  it('does not send when buffered text exceeds the rich-message cap (#2669)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const warn = vi.fn()
    const stream = createAnswerStream({
      chatId: 'chat1',
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

    // One char over the 32768 rich cap.
    stream.update('b'.repeat(TELEGRAM_MAX_CHARS + 1))
    const result = await stream.materialize()

    expect(result).toBeUndefined()
    expect(sendMessage.mock.calls.length).toBe(sendsAfterStreaming)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => /32768|exceeds/i.test(String(c[0])))).toBe(true)
  })
})

// ─── Issue #251: retract() — delete preliminary message when reply path wins ──
describe('answer-stream — retract() (#251)', () => {
  it('calls deleteMessage with (chatId, messageId) after a preliminary message was sent', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const deleteMessage = vi.fn(async () => {})
    const stream = createAnswerStream({
      chatId: 'chat251',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      deleteMessage,
    })

    // Push enough text to exceed the threshold and actually send a message
    stream.update('x'.repeat(500))
    await flushMicrotasks()

    // Verify a message was sent and we know its id
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const sentMsgId = (sendMessage.mock.results[0].value as Promise<{ message_id: number }>)
    const resolved = await sentMsgId
    expect(typeof resolved.message_id).toBe('number')

    const msgId = stream.messageId()
    expect(typeof msgId).toBe('number')

    // Now retract — simulates the reply path winning
    await stream.retract()

    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(deleteMessage).toHaveBeenCalledWith('chat251', msgId)
  })

  it('does not call deleteMessage when no preliminary message was sent', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const deleteMessage = vi.fn(async () => {})
    const stream = createAnswerStream({
      chatId: 'chat251',
      // High threshold so the text below never triggers a send
      minInitialChars: 5000,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      deleteMessage,
    })

    // Short text — stays below minInitialChars, no message sent
    stream.update('x'.repeat(100))
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(stream.messageId()).toBeUndefined()

    // retract() should be a no-op — no delete attempt
    await stream.retract()

    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('retract() stops the stream — subsequent update() calls are no-ops', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const deleteMessage = vi.fn(async () => {})
    const stream = createAnswerStream({
      chatId: 'chat251',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      deleteMessage,
    })

    // Establish an initial message
    stream.update('hello world')
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // Retract
    await stream.retract()

    // Any subsequent update should be silently dropped
    sendMessage.mockClear()
    editMessageText.mockClear()
    stream.update('this should be ignored after retract')
    vi.advanceTimersByTime(2000)
    await flushMicrotasks()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('retract() is best-effort — deleteMessage failure does not throw', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const deleteMessage = vi.fn(async () => {
      throw new Error('deleteMessage: message to delete not found')
    })
    const warn = vi.fn()
    const stream = createAnswerStream({
      chatId: 'chat251',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      deleteMessage,
      warn,
    })

    stream.update('x'.repeat(500))
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // retract() must not throw even when deleteMessage rejects
    await expect(stream.retract()).resolves.toBeUndefined()

    // The failure should have been logged via warn
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => /retract.*failed|deleteMessage.*failed/i.test(String(c[0])))).toBe(true)
  })

  it('retract() without deleteMessage wired is a no-op (no error)', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chat251',
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      // deleteMessage intentionally omitted
    })

    stream.update('hello world')
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // retract() with no deleteMessage callback — should resolve without error
    await expect(stream.retract()).resolves.toBeUndefined()
  })
})

// ─── Issue #203: onMetric callback ──────────────────────────────────────────
describe('answer-stream — onMetric callback (#203)', () => {
  it('fires answer_lane_update on first sendMessage (message transport)', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chatX',
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

  it('fires answer_lane_materialized on materialize success', async () => {
    const onMetric = vi.fn()
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const stream = createAnswerStream({
      chatId: 'chatX',
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
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      onMetric,
    })

    stream.update('x'.repeat(TELEGRAM_MAX_CHARS + 1))
    onMetric.mockClear()
    const id = await stream.materialize()

    expect(id).toBeUndefined()
    const matEvents = onMetric.mock.calls
      .map((c) => c[0] as { kind: string })
      .filter((ev) => ev.kind === 'answer_lane_materialized')
    expect(matEvents).toHaveLength(0)
  })
})
