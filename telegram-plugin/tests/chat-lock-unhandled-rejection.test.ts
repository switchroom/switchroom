/**
 * Regression test for the #klanker 2026-07-10 gateway crash.
 *
 * A `sendPhoto` that failed with PHOTO_INVALID_DIMENSIONS took the WHOLE
 * gateway down with an `unhandledRejection`, even though the reply-tool
 * call site `await`s the send and `onToolCall` wraps it in try/catch.
 *
 * Root cause was in `chat-lock.ts`'s `run()`: it stores a SECOND promise
 * (`tracked = next.finally(...)`) in the per-key chain map and returns the
 * separate `next` to the caller. The caller handles `next`'s rejection, but
 * `tracked` — which rejects with the same reason — is only ever handled by
 * the NEXT queued call chaining onto it. On the TAIL call of a lane (the
 * common single-reply case) nothing attaches a handler to `tracked`, so its
 * rejection escapes as an `unhandledRejection` and crashes the process.
 *
 * These tests assert:
 *   1. a rejecting TAIL call does NOT emit an `unhandledRejection`, and
 *   2. the caller STILL receives the real error (so error handling / the
 *      photo→document fallback still runs).
 */

import { describe, it, expect } from 'vitest'
import { createChatLock } from '../chat-lock.js'

/** Run `body`, capturing any process-level unhandledRejection during it. */
async function captureUnhandledRejections(
  body: () => Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    // Let any orphaned rejections surface: unhandledRejection fires on a
    // later microtask/macrotask tick, so flush both.
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return seen
}

describe('chat-lock run() — tail-call rejection safety', () => {
  it('does NOT emit an unhandledRejection when the tail call rejects', async () => {
    const boom = new Error('PHOTO_INVALID_DIMENSIONS')
    const unhandled = await captureUnhandledRejections(async () => {
      const lock = createChatLock()
      // Single call on this key → it IS the tail. Caller handles the error.
      await expect(lock.run('chat:1', () => Promise.reject(boom))).rejects.toBe(boom)
    })
    expect(unhandled).toEqual([])
  })

  it('still surfaces the real error to the caller', async () => {
    const lock = createChatLock()
    const boom = new Error('boom')
    await expect(lock.run('k', () => Promise.reject(boom))).rejects.toBe(boom)
  })

  it('is quiet even when the failing call is the last of a burst', async () => {
    const boom = new Error('PHOTO_INVALID_DIMENSIONS')
    const unhandled = await captureUnhandledRejections(async () => {
      const lock = createChatLock()
      // First call succeeds, second (tail) rejects — mirrors the incident:
      // a document then a photo on the same (chat,thread) lane.
      const okP = lock.run('chat:9', () => Promise.resolve('doc-sent'))
      const failP = lock.run('chat:9', () => Promise.reject(boom))
      await expect(okP).resolves.toBe('doc-sent')
      await expect(failP).rejects.toBe(boom)
    })
    expect(unhandled).toEqual([])
  })

  it('one failure does not poison later work on the same key', async () => {
    const lock = createChatLock()
    await expect(lock.run('k2', () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    // A subsequent call on the same key must still run and resolve.
    await expect(lock.run('k2', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('wrapBot surfaces a bot.api rejection without crashing (tail call)', async () => {
    const boom = new Error('PHOTO_INVALID_DIMENSIONS')
    const unhandled = await captureUnhandledRejections(async () => {
      const lock = createChatLock()
      const bot = {
        api: {
          sendPhoto: (_chatId: string, _file: unknown, _opts?: unknown) =>
            Promise.reject(boom),
        },
      }
      const wrapped = lock.wrapBot(bot)
      await expect(
        (wrapped.api.sendPhoto as (c: string, f: unknown, o?: unknown) => Promise<unknown>)(
          '123', {}, {},
        ),
      ).rejects.toBe(boom)
    })
    expect(unhandled).toEqual([])
  })
})
