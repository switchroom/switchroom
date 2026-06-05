import { describe, it, expect } from 'vitest'
import { parseSourceMessageId, MAX_TELEGRAM_MESSAGE_ID } from './source-message-id.js'

describe('parseSourceMessageId', () => {
  it('accepts a plausible Telegram message id (string or number)', () => {
    expect(parseSourceMessageId('903')).toBe(903)
    expect(parseSourceMessageId(905)).toBe(905)
    expect(parseSourceMessageId('1')).toBe(1)
  })

  it('REJECTS a fabricated 13-digit Date.now() timestamp (the resume-dark-feed bug)', () => {
    // 2026-06-04T23:34:21.578Z — the exact value that 400'd every feed send.
    expect(parseSourceMessageId('1780616061578')).toBeNull()
    expect(parseSourceMessageId(1_780_616_061_578)).toBeNull()
  })

  it('rejects anything at or above the Telegram message-id ceiling (2^31)', () => {
    expect(parseSourceMessageId(MAX_TELEGRAM_MESSAGE_ID)).toBeNull()
    expect(parseSourceMessageId(MAX_TELEGRAM_MESSAGE_ID - 1)).toBe(MAX_TELEGRAM_MESSAGE_ID - 1)
  })

  it('rejects null / undefined / empty / non-numeric / non-positive', () => {
    expect(parseSourceMessageId(null)).toBeNull()
    expect(parseSourceMessageId(undefined)).toBeNull()
    expect(parseSourceMessageId('')).toBeNull()
    expect(parseSourceMessageId('12a')).toBeNull()
    expect(parseSourceMessageId('-5')).toBeNull() // leading "-" fails the digit test
    expect(parseSourceMessageId(0)).toBeNull()
    expect(parseSourceMessageId(-5)).toBeNull()
    expect(parseSourceMessageId('3.5')).toBeNull()
  })
})
