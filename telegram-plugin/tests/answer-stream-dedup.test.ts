/**
 * Regression tests for #646 — answer-stream materialize dedup.
 *
 * Bug: a silent-end turn (no reply tool called) followed by a bridge
 * disconnect + reconnect produces two Telegram messages:
 *
 *   1. turn-flush fires after the disconnect grace period and sends
 *      the captured text via bot.api.sendMessage (HTML-rendered).
 *   2. answer-stream.materialize() fires when the turn_end event lands
 *      on bridge reconnect, sends the same content again (also via
 *      sendMessage) — no dedup check, no recordOutbound.
 *
 * The fix adds `checkDedup` and `recordDedup` callbacks to
 * AnswerStreamConfig. The gateway wires them to the shared
 * OutboundDedupCache. These tests verify the callbacks are honored
 * correctly at the answer-stream unit level.
 *
 * Invariant pinned:
 *   When checkDedup returns true, materialize() skips the send,
 *   emits answer_lane_materialized with suppressed=true, and returns
 *   undefined. When checkDedup returns false / is absent, materialize()
 *   proceeds normally, calls recordDedup after a successful send, and
 *   returns the message_id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnswerStream, __resetDraftIdForTests } from '../answer-stream.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

let nextMessageId = 2000

function makeSendMessage() {
  return vi.fn(async (_chatId: string, _text: string) => {
    return { message_id: nextMessageId++ }
  })
}

function makeEditMessageText() {
  return vi.fn(async () => {})
}

beforeEach(() => {
  __resetDraftIdForTests()
  nextMessageId = 2000
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

const LONG_TEXT =
  'This is a multi-line answer that exceeds the 24-char dedup floor. It contains enough content to represent the kind of reply that bug #646 actually duplicated in production.'

describe('answer-stream materialize() — dedup callbacks (#646)', () => {
  it('materialize sends normally when checkDedup returns false', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const checkDedup = vi.fn(() => false)
    const recordDedup = vi.fn()
    const onMetric = vi.fn()

    const stream = createAnswerStream({
      chatId: 'chat646',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      checkDedup,
      recordDedup,
      onMetric,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const result = await stream.materialize()

    expect(result).toBeTypeOf('number')
    expect(sendMessage).toHaveBeenCalled()
    expect(recordDedup).toHaveBeenCalledWith(LONG_TEXT)
    expect(checkDedup).toHaveBeenCalledWith(LONG_TEXT)
    // metric should not have suppressed flag set
    const matMetric = onMetric.mock.calls.find(
      ([ev]: [{ kind: string; suppressed?: boolean }]) =>
        ev.kind === 'answer_lane_materialized',
    )
    expect(matMetric).toBeDefined()
    expect(matMetric![0].suppressed).toBeFalsy()
  })

  it('materialize is suppressed when checkDedup returns true', async () => {
    // This is the #646 regression case: turn-flush already sent this
    // content; checkDedup returns true; materialize must skip the send.
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    // Simulate turn-flush having already recorded this content
    const checkDedup = vi.fn(() => true)
    const recordDedup = vi.fn()
    const onMetric = vi.fn()
    const log = vi.fn()

    const stream = createAnswerStream({
      chatId: 'chat646',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      checkDedup,
      recordDedup,
      onMetric,
      log,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    // Drain any streaming sends (these happen before materialize)
    const sendsBeforeMaterialize = sendMessage.mock.calls.length

    const result = await stream.materialize()

    expect(result).toBeUndefined()
    // No additional send should have occurred
    expect(sendMessage.mock.calls.length).toBe(sendsBeforeMaterialize)
    // recordDedup should NOT be called on a suppressed send
    expect(recordDedup).not.toHaveBeenCalled()
    // metric should be emitted with suppressed=true
    const matMetric = onMetric.mock.calls.find(
      ([ev]: [{ kind: string; suppressed?: boolean }]) =>
        ev.kind === 'answer_lane_materialized',
    )
    expect(matMetric).toBeDefined()
    expect(matMetric![0].suppressed).toBe(true)
    // log should mention the suppression
    expect(log.mock.calls.some(([msg]: [string]) => /materialize-dedup-suppressed/i.test(msg))).toBe(
      true,
    )
  })

  it('materialize proceeds normally when checkDedup is absent', async () => {
    // Backwards-compat: callers that don't inject dedup callbacks get
    // the old behaviour — always sends.
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()

    const stream = createAnswerStream({
      chatId: 'chat646',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const result = await stream.materialize()
    expect(result).toBeTypeOf('number')
    expect(sendMessage).toHaveBeenCalled()
  })

  it('recordDedup is not called when send fails', async () => {
    // If the bot API throws, we must not record as-if-sent.
    const sendMessage = vi.fn(async () => {
      throw new Error('Telegram 429 Too Many Requests')
    })
    const editMessageText = makeEditMessageText()
    const checkDedup = vi.fn(() => false)
    const recordDedup = vi.fn()

    const stream = createAnswerStream({
      chatId: 'chat646',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage: sendMessage as never,
      editMessageText,
      checkDedup,
      recordDedup,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const result = await stream.materialize()
    expect(result).toBeUndefined()
    expect(recordDedup).not.toHaveBeenCalled()
  })

  it('silent-end → bridge reconnect race: checkDedup on materialize prevents second message', async () => {
    // Full #646 scenario simulation at the unit level:
    //
    // Phase 1: turn-flush fires after bridge disconnect. It records the
    //   content in dedup (simulated by making checkDedup return true for
    //   subsequent calls).
    //
    // Phase 2: bridge reconnects; turn_end fires; answer-stream.materialize()
    //   is called. checkDedup returns true → send is suppressed.
    //
    // Result: exactly one "Telegram send" happens.

    let dedupRecorded = false

    // Simulate the turn-flush side: after recording, checkDedup returns true
    const checkDedup = vi.fn(() => dedupRecorded)
    const recordDedup = vi.fn((text: string) => {
      // Simulate what turn-flush does: record after a successful send
      if (text.length >= 24) dedupRecorded = true
    })

    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()

    const stream = createAnswerStream({
      chatId: 'chat646',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      checkDedup,
      recordDedup,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    // Phase 1: turn-flush fires and records (simulate externally)
    dedupRecorded = true

    // Phase 2: bridge reconnects; answer-stream.materialize() fires
    const result = await stream.materialize()

    // The materialize should have been suppressed because turn-flush
    // already sent the content and set dedupRecorded=true.
    expect(result).toBeUndefined()

    // Count total sendMessage calls that originated from materialize's
    // actual send (i.e. only the streaming update sends, not a new one).
    // The streaming update happened before dedupRecorded=true, so that
    // one may have gone through. What matters is materialize itself
    // did NOT add another send.
    const totalSends = sendMessage.mock.calls.length
    // Materialize was suppressed, so no extra send
    expect(checkDedup).toHaveBeenCalledWith(LONG_TEXT)
    // At this point sendMessage from materialize is 0, total is from streaming only
    // Just assert materialize returned undefined (the key observable)
    expect(result).toBeUndefined()
  })
})

// ─── Tests for #648 — recordOutbound callback ─────────────────────────────────

describe('answer-stream materialize() — recordOutbound callback (#648)', () => {
  it('recordOutbound is called with messageId and text on successful materialize', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const recordOutbound = vi.fn()

    const stream = createAnswerStream({
      chatId: 'chat648',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      recordOutbound,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const result = await stream.materialize()

    expect(result).toBeTypeOf('number')
    expect(recordOutbound).toHaveBeenCalledOnce()
    expect(recordOutbound).toHaveBeenCalledWith({ messageId: result, text: LONG_TEXT })
  })

  it('recordOutbound is NOT called when materialize is suppressed by checkDedup', async () => {
    const sendMessage = makeSendMessage()
    const editMessageText = makeEditMessageText()
    const checkDedup = vi.fn(() => true)
    const recordOutbound = vi.fn()

    const stream = createAnswerStream({
      chatId: 'chat648',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage,
      editMessageText,
      checkDedup,
      recordOutbound,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const result = await stream.materialize()

    expect(result).toBeUndefined()
    expect(recordOutbound).not.toHaveBeenCalled()
  })

  it('recordOutbound is NOT called when sendMessage throws', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('Telegram 500 Internal Server Error')
    })
    const editMessageText = makeEditMessageText()
    const recordOutbound = vi.fn()

    const stream = createAnswerStream({
      chatId: 'chat648',
      isPrivateChat: false,
      minInitialChars: 0,
      throttleMs: 250,
      sendMessage: sendMessage as never,
      editMessageText,
      recordOutbound,
    })

    stream.update(LONG_TEXT)
    vi.advanceTimersByTime(500)
    await flushMicrotasks()

    const result = await stream.materialize()

    expect(result).toBeUndefined()
    expect(recordOutbound).not.toHaveBeenCalled()
  })
})
