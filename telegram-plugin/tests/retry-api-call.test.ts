/**
 * Covers the retry policy's error-mode contract end-to-end with REAL
 * GrammyError shapes (via fake-bot-api).
 *
 * This is the test suite the plan called out as missing — before the
 * extraction the retry logic was a local function inside gateway.ts,
 * reachable only by spinning up the full bot, so 429/not-modified/
 * not-found behaviour was only "tested" in production.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GrammyError } from 'grammy'
import {
  createRetryApiCall,
  createSwallowingRetryApiCall,
  retryWithThreadFallback,
  isHtmlParseRejectError,
  isMessageTooLongError,
  isPhotoDimensionRejectError,
  isLocalResourceError,
  isFloodWaitActiveError,
  LOCAL_RESOURCE_EXHAUSTED,
  FLOOD_WAIT_ACTIVE,
  DEFAULT_MAX_FLOOD_SLEEP_MS,
  type FloodWaitActiveError,
  type RetryObserver,
} from '../retry-api-call.js'
import { errors, makeGrammyError } from './fake-bot-api.js'

// vitest's vi.advanceTimersByTimeAsync isn't implemented by Bun's test runner.
// This polyfill keeps the same semantics (advance fake clock + flush microtasks)
// and lets the file run cleanly under both vitest and `bun test`.
async function advanceTimers(ms: number): Promise<void> {
  const viAny = vi as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
  if (typeof viAny.advanceTimersByTimeAsync === 'function') {
    await viAny.advanceTimersByTimeAsync(ms)
    return
  }
  vi.advanceTimersByTime(ms)
  // Flush a few microtask turns so awaits chained off the timer callback resolve.
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('retryApiCall', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('flood-wait (429)', () => {
    it('sleeps retry_after seconds then succeeds on retry', async () => {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(errors.floodWait(3))
        .mockResolvedValueOnce('ok')

      const observer: RetryObserver = { onRetry: vi.fn(), onGiveUp: vi.fn(), onBenign: vi.fn() }
      const retry = createRetryApiCall({ observer })

      const pending = retry(fn)
      // Haven't advanced time yet — call is parked on the sleep.
      await Promise.resolve()
      expect(fn).toHaveBeenCalledTimes(1)
      await advanceTimers(3000)
      const result = await pending
      expect(result).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
      expect(observer.onRetry).toHaveBeenCalledWith({
        attempt: 0,
        reason: 'flood_wait',
        delayMs: 3000,
      })
    })

    it('defaults to 5s when retry_after is absent', async () => {
      const err = makeGrammyError({
        error_code: 429,
        description: 'Too Many Requests',
        method: 'sendMessage',
      })
      const fn = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(undefined)

      const retry = createRetryApiCall()
      const pending = retry(fn)
      await Promise.resolve()
      await advanceTimers(5000)
      await pending
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('re-flood during retry still gets caught (second attempt backs off again)', async () => {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(errors.floodWait(1))
        .mockRejectedValueOnce(errors.floodWait(2))
        .mockResolvedValueOnce('ok')

      const retry = createRetryApiCall()
      const pending = retry(fn)
      await Promise.resolve()
      await advanceTimers(1000)
      await Promise.resolve()
      await advanceTimers(2000)
      expect(await pending).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(3)
    })
  })

  describe('benign 400s (swallowed)', () => {
    it('returns undefined on "message is not modified"', async () => {
      const fn = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(errors.notModified())
      const observer: RetryObserver = { onBenign: vi.fn() }
      const retry = createRetryApiCall({ observer })
      const result = await retry(fn)
      expect(result).toBeUndefined()
      expect(fn).toHaveBeenCalledTimes(1)
      expect(observer.onBenign).toHaveBeenCalledWith({ kind: 'not_modified' })
    })

    it('returns undefined on "message to edit not found"', async () => {
      const fn = vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(errors.messageToEditNotFound())
      const observer: RetryObserver = { onBenign: vi.fn() }
      const retry = createRetryApiCall({ observer })
      const result = await retry(fn)
      expect(result).toBeUndefined()
      expect(observer.onBenign).toHaveBeenCalledWith({ kind: 'message_not_found' })
    })

    it('returns undefined on "message to delete not found"', async () => {
      const fn = vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(errors.messageToDeleteNotFound())
      const observer: RetryObserver = { onBenign: vi.fn() }
      const retry = createRetryApiCall({ observer })
      const result = await retry(fn)
      expect(result).toBeUndefined()
      expect(observer.onBenign).toHaveBeenCalledWith({ kind: 'delete_not_found' })
    })
  })

  describe('thread_not_found', () => {
    it('rethrows as THREAD_NOT_FOUND when threadId + chat_id are provided', async () => {
      const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(errors.threadNotFound())
      const retry = createRetryApiCall()
      await expect(retry(fn, { threadId: 42, chat_id: 'c' })).rejects.toMatchObject({
        message: 'THREAD_NOT_FOUND',
      })
    })

    it('passes through the original error when opts are missing', async () => {
      const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(errors.threadNotFound())
      const retry = createRetryApiCall()
      await expect(retry(fn)).rejects.toBeInstanceOf(GrammyError)
    })
  })

  describe('network errors (retryable)', () => {
    it('retries ECONNRESET with exponential backoff', async () => {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('fetch failed: ETIMEDOUT'))
        .mockResolvedValueOnce('ok')

      const observer: RetryObserver = { onRetry: vi.fn() }
      const retry = createRetryApiCall({ observer })
      const pending = retry(fn)

      await Promise.resolve()
      await advanceTimers(1000) // 2^0 * 1000
      await Promise.resolve()
      await advanceTimers(2000) // 2^1 * 1000
      expect(await pending).toBe('ok')
      expect(observer.onRetry).toHaveBeenCalledTimes(2)
      expect((observer.onRetry as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        reason: 'network',
        delayMs: 1000,
      })
      expect((observer.onRetry as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({
        reason: 'network',
        delayMs: 2000,
      })
    })

    it('gives up after maxRetries network errors', async () => {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error('fetch failed'))
      const observer: RetryObserver = { onGiveUp: vi.fn() }
      const retry = createRetryApiCall({ observer })
      const pending = retry(fn)

      // Suppress expected rejection from floating
      const caught = pending.catch((e) => e)

      await Promise.resolve()
      await advanceTimers(1000)
      await Promise.resolve()
      await advanceTimers(2000)
      const err = await caught
      expect((err as Error).message).toBe('fetch failed')
      expect(fn).toHaveBeenCalledTimes(3)
      expect(observer.onGiveUp).toHaveBeenCalled()
    })
  })

  describe('non-retryable errors', () => {
    it('rethrows 403 immediately', async () => {
      const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(errors.forbidden())
      const retry = createRetryApiCall()
      await expect(retry(fn)).rejects.toMatchObject({ error_code: 403 })
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('rethrows unknown 400s without swallowing', async () => {
      const fn = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(errors.badRequest('chat not found'))
      const retry = createRetryApiCall()
      await expect(retry(fn)).rejects.toMatchObject({ error_code: 400 })
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('rethrows non-Grammy exceptions unchanged', async () => {
      const fn = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new TypeError('bad shape'))
      const retry = createRetryApiCall()
      await expect(retry(fn)).rejects.toBeInstanceOf(TypeError)
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })

  describe('observer', () => {
    it('onRetry fires before each sleep with incrementing attempt', async () => {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(errors.floodWait(1))
        .mockRejectedValueOnce(errors.floodWait(1))
        .mockResolvedValueOnce('ok')
      const onRetry = vi.fn()
      const retry = createRetryApiCall({ observer: { onRetry } })
      const pending = retry(fn)
      await Promise.resolve()
      await advanceTimers(1000)
      await Promise.resolve()
      await advanceTimers(1000)
      await pending
      expect(onRetry).toHaveBeenCalledTimes(2)
      expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 0, reason: 'flood_wait' })
      expect(onRetry.mock.calls[1][0]).toMatchObject({ attempt: 1, reason: 'flood_wait' })
    })

    it('onGiveUp fires once with the final error', async () => {
      const err = errors.badRequest('no')
      const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(err)
      const onGiveUp = vi.fn()
      const retry = createRetryApiCall({ observer: { onGiveUp } })
      await expect(retry(fn)).rejects.toBe(err)
      expect(onGiveUp).toHaveBeenCalledTimes(1)
      expect(onGiveUp.mock.calls[0][0]).toMatchObject({ attempts: 1, error: err })
    })
  })

  describe('log sink', () => {
    it('logs flood-wait lines', async () => {
      const log = vi.fn()
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(errors.floodWait(2))
        .mockResolvedValueOnce('ok')
      const retry = createRetryApiCall({ log })
      const pending = retry(fn)
      await Promise.resolve()
      await advanceTimers(2000)
      await pending
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/429 rate limited.*2s/))
    })

    it('logs network retry lines', async () => {
      const log = vi.fn()
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('fetch failed: ENOTFOUND'))
        .mockResolvedValueOnce('ok')
      const retry = createRetryApiCall({ log })
      const pending = retry(fn)
      await Promise.resolve()
      await advanceTimers(1000)
      await pending
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/network error.*1s/))
    })
  })
})

// #1075 — coverage for the swallow + thread-fallback helpers that wrap
// the retry policy for the six previously-unwrapped outbound surfaces.
describe('createSwallowingRetryApiCall (#1075)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves to the underlying value on success', async () => {
    const retry = createRetryApiCall()
    const swallow = createSwallowingRetryApiCall(retry)
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok')
    const result = await swallow(fn)
    expect(result).toBe('ok')
  })

  it('returns undefined and logs when THREAD_NOT_FOUND fires', async () => {
    const retry = createRetryApiCall()
    const log = vi.fn()
    const swallow = createSwallowingRetryApiCall(retry, log)
    const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(errors.threadNotFound())
    const result = await swallow(fn, { threadId: 42, chat_id: 'c', verb: 'test.send' })
    expect(result).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/test\.send.*THREAD_NOT_FOUND/))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('returns undefined and logs on 403 forbidden', async () => {
    const retry = createRetryApiCall()
    const log = vi.fn()
    const swallow = createSwallowingRetryApiCall(retry, log)
    const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(errors.forbidden())
    const result = await swallow(fn, { chat_id: 'c', verb: 'forbidden.send' })
    expect(result).toBeUndefined()
    expect(log).toHaveBeenCalled()
  })

  it('returns undefined on benign not-modified (passes through retry semantics)', async () => {
    const retry = createRetryApiCall()
    const swallow = createSwallowingRetryApiCall(retry)
    const fn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(errors.badRequest('Bad Request: message is not modified'))
    const result = await swallow(fn)
    // retry already swallows benign 400s to undefined, so swallowing wrapper
    // resolves to undefined cleanly with NO error log fired.
    expect(result).toBeUndefined()
  })
})

describe('retryWithThreadFallback (#1075)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on success with threadId passed through', async () => {
    const retry = createRetryApiCall()
    const send = vi
      .fn<(tid: number | undefined) => Promise<{ message_id: number }>>()
      .mockResolvedValue({ message_id: 1 })
    const result = await retryWithThreadFallback(retry, send, {
      threadId: 42,
      chat_id: 'c',
      verb: 'fallback.test',
    })
    expect(result.message_id).toBe(1)
    expect(send).toHaveBeenCalledWith(42)
  })

  it('drops the thread id and retries once on THREAD_NOT_FOUND', async () => {
    const retry = createRetryApiCall()
    const send = vi
      .fn<(tid: number | undefined) => Promise<{ message_id: number }>>()
      .mockRejectedValueOnce(errors.threadNotFound())
      .mockResolvedValueOnce({ message_id: 2 })
    const result = await retryWithThreadFallback(retry, send, {
      threadId: 42,
      chat_id: 'c',
    })
    expect(result.message_id).toBe(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toBe(42)
    // Fallback call must drop the thread id.
    expect(send.mock.calls[1][0]).toBeUndefined()
  })

  it('propagates non-thread-not-found errors without retry', async () => {
    const retry = createRetryApiCall()
    const send = vi
      .fn<(tid: number | undefined) => Promise<{ message_id: number }>>()
      .mockRejectedValueOnce(errors.forbidden())
    await expect(
      retryWithThreadFallback(retry, send, { threadId: 42, chat_id: 'c' }),
    ).rejects.toMatchObject({ error_code: 403 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('handles delete on a thread-bearing message (THREAD_NOT_FOUND coverage for delete)', async () => {
    const retry = createRetryApiCall()
    const send = vi
      .fn<(tid: number | undefined) => Promise<boolean>>()
      .mockRejectedValueOnce(errors.threadNotFound())
      .mockResolvedValueOnce(true)
    const result = await retryWithThreadFallback(retry, send, {
      threadId: 99,
      chat_id: 'c',
      verb: 'deleteMessage',
    })
    expect(result).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('handles pin on a thread-bearing message', async () => {
    const retry = createRetryApiCall()
    const send = vi
      .fn<(tid: number | undefined) => Promise<boolean>>()
      .mockRejectedValueOnce(errors.threadNotFound())
      .mockResolvedValueOnce(true)
    const result = await retryWithThreadFallback(retry, send, {
      threadId: 7,
      chat_id: 'c',
      verb: 'pinChatMessage',
    })
    expect(result).toBe(true)
  })

  it('handles edit on a thread-bearing message', async () => {
    const retry = createRetryApiCall()
    const send = vi
      .fn<(tid: number | undefined) => Promise<boolean>>()
      .mockRejectedValueOnce(errors.threadNotFound())
      .mockResolvedValueOnce(true)
    const result = await retryWithThreadFallback(retry, send, {
      threadId: 7,
      chat_id: 'c',
      verb: 'editMessageText',
    })
    expect(result).toBe(true)
  })
})

describe('isHtmlParseRejectError', () => {
  it('matches the real Telegram parse-failure 400 descriptions', () => {
    const descriptions = [
      "can't parse entities: Unsupported start tag \"h2\" at byte offset 12",
      'Bad Request: unsupported start tag "span"',
      "can't find end of the entity starting at byte offset 40",
      'Bad Request: unclosed start tag at byte offset 5',
      'Bad Request: unexpected end tag at byte offset 9',
      "Bad Request: can't parse entities: expected end tag",
    ]
    for (const d of descriptions) {
      expect(
        isHtmlParseRejectError(
          makeGrammyError({ error_code: 400, description: d, method: 'sendMessage' }),
        ),
      ).toBe(true)
    }
  })

  it('does NOT match other 400s (those have their own handling)', () => {
    for (const d of [
      'Bad Request: message is not modified',
      'Bad Request: message to edit not found',
      'Bad Request: message thread not found',
      'Bad Request: chat not found',
    ]) {
      expect(
        isHtmlParseRejectError(
          makeGrammyError({ error_code: 400, description: d, method: 'sendMessage' }),
        ),
      ).toBe(false)
    }
  })

  it('does not match non-400 GrammyErrors', () => {
    expect(
      isHtmlParseRejectError(
        makeGrammyError({
          error_code: 429,
          description: "can't parse entities",
          method: 'sendMessage',
        }),
      ),
    ).toBe(false)
    expect(
      isHtmlParseRejectError(
        makeGrammyError({
          error_code: 403,
          description: 'Forbidden: bot was blocked',
          method: 'sendMessage',
        }),
      ),
    ).toBe(false)
  })

  it('does not match plain Errors or non-error values', () => {
    expect(isHtmlParseRejectError(new Error("can't parse entities"))).toBe(false)
    expect(isHtmlParseRejectError('string')).toBe(false)
    expect(isHtmlParseRejectError(null)).toBe(false)
    expect(isHtmlParseRejectError(undefined)).toBe(false)
  })

  it('matches the curly-apostrophe variant Telegram sometimes emits', () => {
    expect(
      isHtmlParseRejectError(
        makeGrammyError({
          error_code: 400,
          description: 'Bad Request: can’t parse entities: bad tag',
          method: 'sendMessage',
        }),
      ),
    ).toBe(true)
  })
})

describe('#2923 — LOCAL resource exhaustion is NOT retried (avoids flood ban)', () => {
  it('classifies ENOSPC / EDQUOT / EIO / ENOMEM by errno code', () => {
    expect(isLocalResourceError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(true)
    expect(isLocalResourceError(Object.assign(new Error('x'), { code: 'EDQUOT' }))).toBe(true)
    expect(isLocalResourceError(Object.assign(new Error('x'), { code: 'EIO' }))).toBe(true)
    expect(isLocalResourceError(Object.assign(new Error('x'), { code: 'ENOMEM' }))).toBe(true)
  })

  it('classifies by message when no code is present (incl. EIO, word-boundaried)', () => {
    expect(isLocalResourceError(new Error('ENOSPC: no space left on device, write'))).toBe(true)
    expect(isLocalResourceError(new Error('disk quota exceeded'))).toBe(true)
    expect(isLocalResourceError(new Error('EIO: i/o error, write'))).toBe(true)
    // No false match on a substring (e.g. a word containing the letters).
    expect(isLocalResourceError(new Error('DENOSPCX not a real code'))).toBe(false)
  })

  it('does NOT classify a remote GrammyError or ordinary error', () => {
    expect(isLocalResourceError(errors.floodWait(10))).toBe(false)
    expect(isLocalResourceError(new Error('fetch failed'))).toBe(false)
  })

  it('throws LOCAL_RESOURCE_EXHAUSTED immediately without retrying', async () => {
    // Before the fix: an ENOSPC thrown by the send-staging step fell through
    // to the network-retry branch pattern OR was rethrown but only after the
    // caller kept re-driving sends — the storm that tripped the flood ban.
    // Now it must fail FAST on the first attempt with a distinct marker.
    const sleep = vi.fn(async () => {})
    let calls = 0
    const retry = createRetryApiCall({ maxRetries: 3, sleep })
    await expect(
      retry(async () => {
        calls++
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }),
    ).rejects.toThrow(LOCAL_RESOURCE_EXHAUSTED)
    expect(calls).toBe(1) // no retry
    expect(sleep).not.toHaveBeenCalled() // no backoff-into-flood
  })

  it('fires onFloodWait with the retry_after when a 429 is seen', async () => {
    const seen: number[] = []
    const sleep = vi.fn(async () => {})
    let n = 0
    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep,
      onFloodWait: (s) => seen.push(s),
    })
    const out = await retry(async () => {
      if (n++ === 0) throw errors.floodWait(42)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(seen).toEqual([42])
  })

  it('passes the call opts to onFloodWait so the gateway can open a scope-precise window (#3111)', async () => {
    const seen: { sec: number; chat_id?: string; chatType?: string }[] = []
    const sleep = vi.fn(async () => {})
    let n = 0
    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep,
      onFloodWait: (sec, opts) => seen.push({ sec, chat_id: opts?.chat_id, chatType: opts?.chatType }),
    })
    const out = await retry(
      async () => {
        if (n++ === 0) throw errors.floodWait(7)
        return 'ok'
      },
      { chat_id: '42', chatType: 'supergroup' },
    )
    expect(out).toBe('ok')
    // The hook received the same chat scope the send carried — not a bare number.
    expect(seen).toEqual([{ sec: 7, chat_id: '42', chatType: 'supergroup' }])
  })
})

describe('#3084 — a long flood ban fails FAST instead of sleeping for hours', () => {
  /**
   * Deterministic fake clock: `sleep` never waits, it just advances a counter.
   * Nothing here touches a real timer, so "did we try to sleep 4.6 hours?" is
   * an assertion on the fake clock, not a stopwatch.
   */
  function fakeClock() {
    let elapsedMs = 0
    const slept: number[] = []
    return {
      get elapsedMs() {
        return elapsedMs
      },
      slept,
      sleep: async (ms: number) => {
        slept.push(ms)
        elapsedMs += ms
      },
    }
  }

  // The real value overlord's gateway logged on 2026-07-11.
  const REAL_BAN_SEC = 16_739

  it('does NOT sleep a 4.6-hour retry_after (clock never advances past the ceiling)', async () => {
    const clock = fakeClock()
    let calls = 0
    const retry = createRetryApiCall({ maxRetries: 3, sleep: clock.sleep })

    await expect(
      retry(async () => {
        calls++
        throw errors.floodWait(REAL_BAN_SEC)
      }),
    ).rejects.toThrow(FLOOD_WAIT_ACTIVE)

    expect(calls).toBe(1) // failed fast on the first 429 — no retry storm
    expect(clock.slept).toEqual([]) // never even attempted the sleep
    expect(clock.elapsedMs).toBe(0)
    expect(clock.elapsedMs).toBeLessThanOrEqual(DEFAULT_MAX_FLOOD_SLEEP_MS)
  })

  it('carries retry_after / untilTs / original on the thrown marker', async () => {
    const clock = fakeClock()
    const before = Date.now()
    const retry = createRetryApiCall({ maxRetries: 3, sleep: clock.sleep })

    const err = await retry(async () => {
      throw errors.floodWait(REAL_BAN_SEC)
    }).catch((e: unknown) => e)

    expect(isFloodWaitActiveError(err)).toBe(true)
    const flood = err as FloodWaitActiveError
    expect(flood.retryAfterSec).toBe(REAL_BAN_SEC)
    expect(flood.untilTs).toBeGreaterThanOrEqual(before + REAL_BAN_SEC * 1000)
    expect(flood.original).toBeInstanceOf(GrammyError)
  })

  it('STILL records the flood window via onFloodWait before throwing (#2923 breaker)', async () => {
    const clock = fakeClock()
    const seen: number[] = []
    const order: string[] = []
    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep: clock.sleep,
      onFloodWait: (s) => {
        seen.push(s)
        order.push('recorded')
      },
      observer: {
        onGiveUp: () => {
          order.push('gave_up')
        },
      },
    })

    await expect(
      retry(async () => {
        throw errors.floodWait(REAL_BAN_SEC)
      }),
    ).rejects.toThrow(FLOOD_WAIT_ACTIVE)

    // The breaker MUST learn about the window — that is what suppresses the
    // restart boot-card that would otherwise extend the ban.
    expect(seen).toEqual([REAL_BAN_SEC])
    expect(order).toEqual(['recorded', 'gave_up'])
  })

  it('a throwing onFloodWait hook still yields the marker, not the hook error', async () => {
    const clock = fakeClock()
    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep: clock.sleep,
      onFloodWait: () => {
        throw new Error('disk full while persisting flood state')
      },
    })
    await expect(
      retry(async () => {
        throw errors.floodWait(REAL_BAN_SEC)
      }),
    ).rejects.toThrow(FLOOD_WAIT_ACTIVE)
  })

  it('a SHORT retry_after under the ceiling still sleeps-and-retries and succeeds', async () => {
    const clock = fakeClock()
    let n = 0
    const retry = createRetryApiCall({ maxRetries: 3, sleep: clock.sleep })

    // 30s — the everyday rate-limit blip. Behaviour must be unchanged.
    const out = await retry(async () => {
      if (n++ === 0) throw errors.floodWait(30)
      return 'ok'
    })

    expect(out).toBe('ok')
    expect(n).toBe(2)
    expect(clock.slept).toEqual([30_000])
  })

  it('the historic 28s and 75s waits are still slept through (no regression)', async () => {
    for (const sec of [28, 75]) {
      const clock = fakeClock()
      let n = 0
      const retry = createRetryApiCall({ maxRetries: 3, sleep: clock.sleep })
      const out = await retry(async () => {
        if (n++ === 0) throw errors.floodWait(sec)
        return 'ok'
      })
      expect(out).toBe('ok')
      expect(clock.slept).toEqual([sec * 1000])
    }
  })

  it('sleeps exactly AT the ceiling, throws just above it', async () => {
    const atCeiling = DEFAULT_MAX_FLOOD_SLEEP_MS / 1000

    const clockAt = fakeClock()
    let n = 0
    const retryAt = createRetryApiCall({ maxRetries: 3, sleep: clockAt.sleep })
    expect(
      await retryAt(async () => {
        if (n++ === 0) throw errors.floodWait(atCeiling)
        return 'ok'
      }),
    ).toBe('ok')
    expect(clockAt.slept).toEqual([DEFAULT_MAX_FLOOD_SLEEP_MS])

    const clockOver = fakeClock()
    const retryOver = createRetryApiCall({ maxRetries: 3, sleep: clockOver.sleep })
    await expect(
      retryOver(async () => {
        throw errors.floodWait(atCeiling + 1)
      }),
    ).rejects.toThrow(FLOOD_WAIT_ACTIVE)
    expect(clockOver.slept).toEqual([])
  })

  it('honours a caller-supplied maxFloodSleepMs ceiling', async () => {
    const clock = fakeClock()
    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep: clock.sleep,
      maxFloodSleepMs: 5_000,
    })
    // 30s would sleep under the DEFAULT ceiling; with a 5s ceiling it throws.
    await expect(
      retry(async () => {
        throw errors.floodWait(30)
      }),
    ).rejects.toThrow(FLOOD_WAIT_ACTIVE)
    expect(clock.slept).toEqual([])
  })

  it('maxRetries semantics unchanged for sustained SHORT floods', async () => {
    const clock = fakeClock()
    let calls = 0
    const retry = createRetryApiCall({ maxRetries: 3, sleep: clock.sleep })

    await expect(
      retry(async () => {
        calls++
        throw errors.floodWait(10)
      }),
    ).rejects.toThrow('retryApiCall: max retries exceeded')

    expect(calls).toBe(3)
    expect(clock.slept).toEqual([10_000, 10_000, 10_000])
  })

  it('the swallowing wrapper absorbs the marker (no unhandled rejection)', async () => {
    const clock = fakeClock()
    const lines: string[] = []
    const retry = createRetryApiCall({ maxRetries: 3, sleep: clock.sleep })
    const swallow = createSwallowingRetryApiCall(retry, (l) => lines.push(l))

    const out = await swallow(
      async () => {
        throw errors.floodWait(REAL_BAN_SEC)
      },
      { verb: 'sendMessage' },
    )

    expect(out).toBeUndefined()
    expect(lines.join('')).toContain(FLOOD_WAIT_ACTIVE)
  })
})

describe('#3084 — the fast throw must not become a re-drive amplifier', () => {
  const REAL_BAN_SEC = 16_739

  /**
   * EXACT duck-type predicate used by the card surfaces to arm their 429
   * cooldown — copied verbatim from `worker-activity-feed.ts`
   * (`extractRetryAfterSecs`) and `issues-card.ts`. They do NOT use
   * `instanceof GrammyError`. If the marker doesn't satisfy this, they
   * classify it 'transient', arm no cooldown, and their 5-6s heartbeats
   * re-drive the send into the open ban.
   */
  function extractRetryAfterSecs(err: unknown): number | null {
    if (err == null || typeof err !== 'object') return null
    const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } }
    if (e.error_code !== 429) return null
    const ra = e.parameters?.retry_after
    if (typeof ra === 'number' && Number.isFinite(ra) && ra > 0) return ra
    return null
  }

  it('the marker satisfies the card surfaces\' 429 cooldown duck-type', async () => {
    const retry = createRetryApiCall({ maxRetries: 3, sleep: async () => {} })
    const err = await retry(async () => {
      throw errors.floodWait(REAL_BAN_SEC)
    }).catch((e: unknown) => e)

    // worker-activity-feed / issues-card would now arm a FULL-window cooldown
    // instead of treating this as a generic 'transient' error.
    expect(extractRetryAfterSecs(err)).toBe(REAL_BAN_SEC)
  })

  it('the marker is still NOT a GrammyError (resend-fallback probes must not match)', async () => {
    const retry = createRetryApiCall({ maxRetries: 3, sleep: async () => {} })
    const err = await retry(async () => {
      throw errors.floodWait(REAL_BAN_SEC)
    }).catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(GrammyError)
    expect(isHtmlParseRejectError(err)).toBe(false)
    expect(isMessageTooLongError(err)).toBe(false)
    expect(isPhotoDimensionRejectError(err)).toBe(false)
  })

  it('a card heartbeat ticking across the whole 4.6h ban issues ONE Bot API call', async () => {
    // The regression that must be impossible. Before the pre-call gate: the
    // marker throws in ~1ms, the 6s heartbeat re-drives, and we fire ~2,760
    // fresh requests into the still-open per-bot ban — feeding the exact flood
    // counter #2923 exists to starve. Strictly worse than the original hang.
    let now = 1_000_000
    let state: { untilTs: number } | null = null
    let apiCalls = 0

    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep: async () => {},
      // The #2923 breaker: record the window...
      onFloodWait: (sec) => {
        state = { untilTs: now + sec * 1000 }
      },
      // ...and the #3084 gate: refuse to send into it.
      floodWaitRemainingMs: () => (state ? Math.max(0, state.untilTs - now) : 0),
    })

    const HEARTBEAT_MS = 6_000
    const ticks = Math.ceil((REAL_BAN_SEC * 1000) / HEARTBEAT_MS) // ~2,790
    let markerThrows = 0

    for (let i = 0; i < ticks; i++) {
      // A worker-feed style heartbeat: best-effort edit, swallow failures,
      // and (deliberately, to model the WORST case) arm no cooldown of its own.
      await retry(async () => {
        apiCalls++
        throw errors.floodWait(REAL_BAN_SEC)
      }).catch((e: unknown) => {
        if (isFloodWaitActiveError(e)) markerThrows++
      })
      now += HEARTBEAT_MS
    }

    expect(ticks).toBeGreaterThan(2_700) // we really did simulate the full ban
    expect(markerThrows).toBe(ticks) // every tick got a clean degraded state
    // …and the Bot API was touched a HANDFUL of times, not once per tick.
    // Without the pre-call gate this is ~2,790 requests fired into an open
    // per-bot ban. With it: the first tick (which discovers the ban) plus the
    // few tail ticks that run after the simulated window has elapsed and
    // legitimately re-probe. Bounded and small is the whole contract.
    expect(apiCalls).toBeLessThanOrEqual(5)
    expect(apiCalls).toBeGreaterThanOrEqual(1)
    expect(apiCalls / ticks).toBeLessThan(0.01) // <1% of ticks reach the API
  })

  it('resumes issuing calls once the window expires (the gate is not a latch)', async () => {
    let now = 1_000_000
    let state: { untilTs: number } | null = null
    let apiCalls = 0

    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep: async () => {},
      onFloodWait: (sec) => {
        state = { untilTs: now + sec * 1000 }
      },
      floodWaitRemainingMs: () => (state ? Math.max(0, state.untilTs - now) : 0),
    })

    await expect(
      retry(async () => {
        apiCalls++
        throw errors.floodWait(300)
      }),
    ).rejects.toThrow(FLOOD_WAIT_ACTIVE)
    expect(apiCalls).toBe(1)

    // Mid-window: gated, no call.
    now += 100_000
    await expect(retry(async () => 'ok')).rejects.toThrow(FLOOD_WAIT_ACTIVE)
    expect(apiCalls).toBe(1)

    // Window expired: the very next call goes through and succeeds.
    now += 300_000
    expect(
      await retry(async () => {
        apiCalls++
        return 'ok'
      }),
    ).toBe('ok')
    expect(apiCalls).toBe(2)
  })

  it('a SHORT open window is not short-circuited (sleep-and-retry still rides it out)', async () => {
    // A 30s window is under the ceiling: the normal path may still succeed
    // (the server may have cleared it), so we must NOT gate it.
    let apiCalls = 0
    let n = 0
    const retry = createRetryApiCall({
      maxRetries: 3,
      sleep: async () => {},
      floodWaitRemainingMs: () => 30_000,
    })
    const out = await retry(async () => {
      apiCalls++
      if (n++ === 0) throw errors.floodWait(30)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(apiCalls).toBe(2)
  })

  it('FAILS OPEN — a throwing/garbage flood probe never silences the bot', async () => {
    const throwing = createRetryApiCall({
      maxRetries: 3,
      sleep: async () => {},
      floodWaitRemainingMs: () => {
        throw new Error('EACCES: unreadable flood-wait.json')
      },
    })
    expect(await throwing(async () => 'ok')).toBe('ok')

    // Garbage from a corrupt marker file must be treated as "no window".
    // Infinity in particular would otherwise mute the bot forever.
    for (const garbage of [NaN, -1, 0, Infinity]) {
      const retry = createRetryApiCall({
        maxRetries: 3,
        sleep: async () => {},
        floodWaitRemainingMs: () => garbage,
      })
      expect(await retry(async () => 'ok')).toBe('ok')
    }
  })

  it('with no flood probe wired at all, behaviour is exactly as before', async () => {
    let apiCalls = 0
    let n = 0
    const retry = createRetryApiCall({ maxRetries: 3, sleep: async () => {} })
    const out = await retry(async () => {
      apiCalls++
      if (n++ === 0) throw errors.floodWait(30)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(apiCalls).toBe(2)
  })
})
