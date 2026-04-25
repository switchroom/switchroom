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
import { createRetryApiCall, type RetryObserver } from '../retry-api-call.js'
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
