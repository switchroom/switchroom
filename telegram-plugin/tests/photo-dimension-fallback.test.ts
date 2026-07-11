/**
 * Covers the photo→document graceful fallback contract (#klanker
 * 2026-07-10 incident: a tall phone screenshot sent via the reply tool's
 * `files` param threw PHOTO_INVALID_DIMENSIONS).
 *
 * Two production pieces make the gateway's fallback work:
 *   1. `isPhotoDimensionRejectError` classifies the 400s that mean "not
 *      usable AS a photo" (dimensions / save-file / too-large).
 *   2. `retryApiCall` must NOT swallow or retry those 400s — they have to
 *      reach the caller's catch so it can re-send as a document.
 *
 * The final block exercises the EXACT try/catch shape the gateway's reply
 * file-send loop uses (`retryWithThreadFallback` + the predicate), proving
 * the file is still delivered as a document.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createRetryApiCall,
  retryWithThreadFallback,
  isPhotoDimensionRejectError,
} from '../retry-api-call.js'
import { errors } from './fake-bot-api.js'

describe('isPhotoDimensionRejectError', () => {
  it('is true for PHOTO_INVALID_DIMENSIONS', () => {
    expect(isPhotoDimensionRejectError(errors.badRequest('PHOTO_INVALID_DIMENSIONS', 'sendPhoto'))).toBe(true)
  })

  it('is true for PHOTO_SAVE_FILE_INVALID', () => {
    expect(isPhotoDimensionRejectError(errors.badRequest('PHOTO_SAVE_FILE_INVALID', 'sendPhoto'))).toBe(true)
  })

  it('is true for the mediagroup-wrapped variant', () => {
    const err = errors.badRequest(
      'failed to send message #2 with the error message "PHOTO_INVALID_DIMENSIONS"',
      'sendMediaGroup',
    )
    expect(isPhotoDimensionRejectError(err)).toBe(true)
  })

  it('is true for photo-too-big size rejections', () => {
    expect(isPhotoDimensionRejectError(errors.badRequest('PHOTO_SAVE_FILE_INVALID: photo is too big', 'sendPhoto'))).toBe(true)
    expect(isPhotoDimensionRejectError(errors.badRequest('Image is too big', 'sendPhoto'))).toBe(true)
  })

  it('is false for unrelated 400s', () => {
    expect(isPhotoDimensionRejectError(errors.badRequest('chat not found', 'sendPhoto'))).toBe(false)
    expect(isPhotoDimensionRejectError(errors.threadNotFound('sendPhoto'))).toBe(false)
  })

  it('is false for non-400 and non-grammy errors', () => {
    expect(isPhotoDimensionRejectError(errors.forbidden('sendPhoto'))).toBe(false)
    expect(isPhotoDimensionRejectError(errors.floodWait(3, 'sendPhoto'))).toBe(false)
    expect(isPhotoDimensionRejectError(new Error('PHOTO_INVALID_DIMENSIONS'))).toBe(false)
    expect(isPhotoDimensionRejectError(null)).toBe(false)
  })
})

describe('retryApiCall does not swallow photo-dimension rejects', () => {
  it('rethrows PHOTO_INVALID_DIMENSIONS so the caller can fall back', async () => {
    const retry = createRetryApiCall()
    const err = errors.badRequest('PHOTO_INVALID_DIMENSIONS', 'sendPhoto')
    await expect(retry(() => Promise.reject(err))).rejects.toBe(err)
  })

  it('propagates through retryWithThreadFallback (not treated as THREAD_NOT_FOUND)', async () => {
    const retry = createRetryApiCall()
    const err = errors.badRequest('PHOTO_INVALID_DIMENSIONS', 'sendPhoto')
    await expect(
      retryWithThreadFallback(retry, () => Promise.reject(err), {
        threadId: 42,
        chat_id: '123',
        verb: 'sendPhoto',
      }),
    ).rejects.toBe(err)
  })
})

describe('photo→document fallback (gateway reply-loop shape)', () => {
  it('re-sends as a document when sendPhoto is rejected for dimensions', async () => {
    const retry = createRetryApiCall()
    const err = errors.badRequest('PHOTO_INVALID_DIMENSIONS', 'sendPhoto')
    const sendPhoto = vi.fn(() => Promise.reject(err))
    const sendDocument = vi.fn(() => Promise.resolve({ message_id: 555 }))

    // Mirror gateway.ts executeReply's per-file try/catch.
    let sent: { message_id: number }
    try {
      sent = await retryWithThreadFallback(retry, () => sendPhoto(), {
        threadId: undefined,
        chat_id: '123',
        verb: 'sendPhoto',
      })
    } catch (caught) {
      expect(isPhotoDimensionRejectError(caught)).toBe(true)
      sent = await retryWithThreadFallback(retry, () => sendDocument(), {
        threadId: undefined,
        chat_id: '123',
        verb: 'sendDocument',
      })
    }

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendDocument).toHaveBeenCalledTimes(1)
    expect(sent!.message_id).toBe(555)
  })

  it('does NOT fall back for non-dimension errors (they propagate)', async () => {
    const retry = createRetryApiCall()
    const err = errors.forbidden('sendPhoto')
    const sendDocument = vi.fn(() => Promise.resolve({ message_id: 1 }))

    let threw = false
    try {
      await retryWithThreadFallback(retry, () => Promise.reject(err), {
        threadId: undefined,
        chat_id: '123',
        verb: 'sendPhoto',
      })
    } catch (caught) {
      threw = true
      // The gateway only falls back when this predicate holds.
      expect(isPhotoDimensionRejectError(caught)).toBe(false)
    }
    expect(threw).toBe(true)
    expect(sendDocument).not.toHaveBeenCalled()
  })
})
