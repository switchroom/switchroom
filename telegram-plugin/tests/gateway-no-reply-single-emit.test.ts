import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAnswerStream } from '../answer-stream.js'

/**
 * #656 — gateway turn_end no-reply path.
 *
 * Background: gateway.ts at the turn_end handler used to materialize() the
 * answer-lane stream when no reply tool was called, in parallel with the
 * turn-flush emitter (gateway.ts ~3475). Both gates fire on the same
 * `!replyCalled && capturedText.length > 0` condition, no dedup between
 * them, and materialize() posts the raw model text without HTML conversion
 * — producing a visible duplicate where one copy shows raw <b> tags and
 * the other renders cleanly.
 *
 * Fix: drop the materialize branch entirely. Always retract() the
 * answer-stream at turn_end. Turn-flush is the sole canonical emitter for
 * no-reply turns (it runs markdownToHtml + records to outboundDedup).
 *
 * This test pins the contract that retract() does NOT emit a fresh
 * sendMessage — only deletes any preliminary message previously sent. The
 * gateway's no-reply path now relies on this property.
 */

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

let nextMessageId = 5000

beforeEach(() => {
  nextMessageId = 5000
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('#656 — answer-stream retract() at turn_end emits nothing', () => {
  it('retract before any preliminary send: no sendMessage, no deleteMessage', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: nextMessageId++ }))
    const editMessageText = vi.fn(async () => {})
    const deleteMessage = vi.fn(async () => {})

    const stream = createAnswerStream({
      chatId: 'chat-no-reply',      minInitialChars: 400,
      throttleMs: 250,
      sendMessage: sendMessage as never,
      editMessageText: editMessageText as never,
      deleteMessage: deleteMessage as never,
    })

    // Seed a sub-threshold blob so nothing has been sent yet
    stream.update('x'.repeat(50))
    await flushMicrotasks()
    expect(sendMessage).not.toHaveBeenCalled()

    await stream.retract()

    // Critically: retract() must NOT emit a fresh sendMessage. The gateway's
    // no-reply path delegates the user-visible emit to turn-flush.
    expect(sendMessage).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  // Visible-answer-stream OFF (default since 2026-06-03): the gateway passes
  // minInitialChars=MAX_SAFE_INTEGER so a SUPERGROUP turn (message transport —
  // draft is unsupported in forum topics) NEVER opens a visible preview, no
  // matter how much interstitial assistant.text streams. This is the full fix
  // for the marko-General unformatted-flash (the DM path is already covered by
  // draft transport). Without it, message transport opens at the 50-char gate
  // and retract() then deletes it.
  it('flag-off supergroup: huge minInitialChars never opens a message even past the 50-char gate', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: nextMessageId++ }))
    const editMessageText = vi.fn(async () => {})
    const deleteMessage = vi.fn(async () => {})

    const stream = createAnswerStream({
      chatId: 'supergroup-topic',      threadId: 4,
      minInitialChars: Number.MAX_SAFE_INTEGER,
      throttleMs: 250,
      sendMessage: sendMessage as never,
      editMessageText: editMessageText as never,
      deleteMessage: deleteMessage as never,
    })

    // Feed 200 chars — well past the default 50-char open gate.
    stream.update('x'.repeat(200))
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()
    expect(sendMessage).not.toHaveBeenCalled() // never opened a preview
    expect(editMessageText).not.toHaveBeenCalled()

    await stream.retract()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled() // nothing to delete → no flash
  })

  it('retract after a preliminary send: deletes the prelim, no fresh sendMessage', async () => {
    const THROTTLE = 1000
    const sendMessage = vi.fn(async () => ({ message_id: nextMessageId++ }))
    const editMessageText = vi.fn(async () => {})
    const deleteMessage = vi.fn(async () => {})

    const stream = createAnswerStream({
      chatId: 'chat-no-reply',      minInitialChars: 10,
      throttleMs: THROTTLE,
      sendMessage: sendMessage as never,
      editMessageText: editMessageText as never,
      deleteMessage: deleteMessage as never,
    })

    // Cross threshold so a preliminary send fires
    stream.update('x'.repeat(50))
    await flushMicrotasks()
    vi.advanceTimersByTime(THROTTLE)
    await flushMicrotasks()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    const sendCallsBefore = sendMessage.mock.calls.length

    await stream.retract()

    // Retract should delete the preliminary message (cleanup) but must NOT
    // emit any new sendMessage — turn-flush owns the user-visible emit.
    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls.length).toBe(sendCallsBefore)
  })
})
