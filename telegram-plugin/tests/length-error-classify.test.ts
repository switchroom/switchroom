/**
 * Tests for the over-length error classification (task E of the Telegram-
 * formatting bundle) and the hardSliceToCap last-resort slicer.
 *
 * The rich path rejects a 32769+ char body with `RICH_MESSAGE_TEXT_TOO_LONG`
 * (and the legacy plain path with `MESSAGE_TOO_LONG`). That is a LENGTH error,
 * not a markdown-parse error — it must be classified so the caller re-splits
 * the body rather than (a) misclassifying it as a parse-reject and resending
 * the same oversized payload as plain text, or (b) surfacing the raw 400.
 */
import { describe, test, expect } from 'vitest'
import { GrammyError } from 'grammy'
import { isLengthError, isParseEntitiesError } from '../rich-send.js'
import { isMessageTooLongError, isHtmlParseRejectError } from '../retry-api-call.js'
import { hardSliceToCap, RICH_MESSAGE_MAX_CHARS } from '../format.js'

// Build a GrammyError with a given 400 description. GrammyError's constructor
// takes (message, payload, method, parameters) in grammy 1.44.
function grammy400(description: string): GrammyError {
  return new GrammyError(
    `Call to 'sendRichMessage' failed! (400: ${description})`,
    { ok: false, error_code: 400, description },
    'sendRichMessage',
    {},
  )
}

describe('length-error classification (rich-send.isLengthError)', () => {
  test('RICH_MESSAGE_TEXT_TOO_LONG is a length error', () => {
    const err = grammy400('RICH_MESSAGE_TEXT_TOO_LONG')
    expect(isLengthError(err)).toBe(true)
  })

  test('legacy MESSAGE_TOO_LONG / "message is too long" are length errors', () => {
    expect(isLengthError(grammy400('MESSAGE_TOO_LONG'))).toBe(true)
    expect(isLengthError(grammy400('Bad Request: message is too long'))).toBe(true)
  })

  test('a parse-entities error is NOT a length error', () => {
    expect(isLengthError(grammy400("can't parse entities: bad offset"))).toBe(false)
  })

  test('a length error is NOT misclassified as a parse-entities error', () => {
    const err = grammy400('RICH_MESSAGE_TEXT_TOO_LONG')
    expect(isParseEntitiesError(err)).toBe(false)
  })

  test('non-GrammyError and non-400 are neither', () => {
    expect(isLengthError(new Error('boom'))).toBe(false)
    const err403 = new GrammyError(
      'forbidden',
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' },
      'sendRichMessage',
      {},
    )
    expect(isLengthError(err403)).toBe(false)
  })
})

describe('length-error classification (retry-api-call.isMessageTooLongError)', () => {
  test('RICH_MESSAGE_TEXT_TOO_LONG is a length error', () => {
    expect(isMessageTooLongError(grammy400('RICH_MESSAGE_TEXT_TOO_LONG'))).toBe(true)
  })

  test('a length error is NOT misclassified as an html-parse-reject', () => {
    const err = grammy400('RICH_MESSAGE_TEXT_TOO_LONG')
    expect(isHtmlParseRejectError(err)).toBe(false)
  })

  test('a parse-reject error still classifies as a parse-reject (not length)', () => {
    const err = grammy400("can't parse entities: unexpected end")
    expect(isHtmlParseRejectError(err)).toBe(true)
    expect(isMessageTooLongError(err)).toBe(false)
  })
})

describe('hardSliceToCap', () => {
  test('returns the input as one piece when it already fits', () => {
    expect(hardSliceToCap('short', 100)).toEqual(['short'])
  })

  test('slices an oversized body into pieces each <= cap', () => {
    const body = 'x'.repeat(250)
    const pieces = hardSliceToCap(body, 100)
    expect(pieces).toHaveLength(3)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(100)
    expect(pieces.join('')).toBe(body)
  })

  test('defaults the cap to RICH_MESSAGE_MAX_CHARS', () => {
    const body = 'y'.repeat(RICH_MESSAGE_MAX_CHARS + 5)
    const pieces = hardSliceToCap(body)
    expect(pieces).toHaveLength(2)
    expect(pieces[0].length).toBe(RICH_MESSAGE_MAX_CHARS)
    expect(pieces[1].length).toBe(5)
  })
})
