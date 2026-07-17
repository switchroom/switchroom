/**
 * S1 fix (fable red-team 2026-07-17) — turn-flush pre-delivery suppression.
 *
 * The old gateway predicate (`getRecentOutboundCount(chatId, 2) > 0`) counted
 * ANY assistant row in the WHOLE chat, so a worker progress ping, a command
 * ack, or a reply in a different forum topic suppressed the flush and closed
 * the obligation — silently dropping the user's real answer. These tests pin
 * the scoped replacement: the oracle must be asked for a SAME-THREAD row of
 * substantive length within the 2s window, and oracle failures fail OPEN
 * (deliver, don't drop). The oracle's own thread/length SQL semantics are
 * pinned separately in `history.test.ts` (`hasOutboundDeliveredSince`).
 */
import { describe, it, expect } from 'vitest'
import {
  shouldSuppressTurnFlush,
  FLUSH_SUPPRESSION_WINDOW_MS,
} from '../gateway/turn-flush-suppression.js'
import { FINAL_ANSWER_MIN_CHARS } from '../final-answer-detect.js'

type OracleCall = { chatId: string; sinceMs: number; threadId: number | null; minChars: number }

function capture(result: boolean) {
  const calls: OracleCall[] = []
  const deps = {
    hasSubstantiveOutbound: (chatId: string, sinceMs: number, threadId: number | null, minChars: number) => {
      calls.push({ chatId, sinceMs, threadId, minChars })
      return result
    },
  }
  return { calls, deps }
}

describe('shouldSuppressTurnFlush', () => {
  it('suppresses iff the oracle finds a substantive same-thread outbound', () => {
    const yes = capture(true)
    expect(
      shouldSuppressTurnFlush(yes.deps, { chatId: '-100', threadId: 7, answerLength: 500, nowMs: 10_000 }),
    ).toBe(true)
    const no = capture(false)
    expect(
      shouldSuppressTurnFlush(no.deps, { chatId: '-100', threadId: 7, answerLength: 500, nowMs: 10_000 }),
    ).toBe(false)
  })

  it('scopes the oracle query to the turn thread and the 2s window', () => {
    const { calls, deps } = capture(true)
    shouldSuppressTurnFlush(deps, { chatId: '-100', threadId: 7, answerLength: 500, nowMs: 10_000 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.chatId).toBe('-100')
    // Explicit thread id — never `undefined` (undefined would match rows in
    // ANY topic and re-open the cross-topic false positive).
    expect(calls[0]!.threadId).toBe(7)
    expect(calls[0]!.sinceMs).toBe(10_000 - FLUSH_SUPPRESSION_WINDOW_MS)
  })

  it('passes an explicit null thread for DM / chat-root turns', () => {
    const { calls, deps } = capture(false)
    shouldSuppressTurnFlush(deps, { chatId: '55', threadId: null, answerLength: 300, nowMs: 5_000 })
    expect(calls[0]!.threadId).toBeNull()
  })

  it('caps the length floor at FINAL_ANSWER_MIN_CHARS for long answers (a short ping can never suppress a long answer)', () => {
    const { calls, deps } = capture(false)
    shouldSuppressTurnFlush(deps, { chatId: '-100', threadId: null, answerLength: 5_000, nowMs: 10_000 })
    expect(calls[0]!.minChars).toBe(FINAL_ANSWER_MIN_CHARS)
  })

  it('lowers the floor to the answer length for terse answers (their own stream materialization still suppresses a duplicate)', () => {
    const { calls, deps } = capture(true)
    shouldSuppressTurnFlush(deps, { chatId: '-100', threadId: null, answerLength: 12, nowMs: 10_000 })
    expect(calls[0]!.minChars).toBe(12)
  })

  it('clamps the floor to >= 1 for a degenerate empty answer', () => {
    const { calls, deps } = capture(false)
    shouldSuppressTurnFlush(deps, { chatId: '-100', threadId: null, answerLength: 0, nowMs: 10_000 })
    expect(calls[0]!.minChars).toBe(1)
  })

  it('fails open (no suppression) when the oracle throws — deliver beats drop', () => {
    const deps = {
      hasSubstantiveOutbound: () => {
        throw new Error('sqlite unavailable')
      },
    }
    expect(
      shouldSuppressTurnFlush(deps, { chatId: '-100', threadId: null, answerLength: 300, nowMs: 10_000 }),
    ).toBe(false)
  })
})
