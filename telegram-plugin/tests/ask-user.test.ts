/**
 * Unit tests for the pure helpers behind the `ask_user` MCP tool (#574).
 *
 * Coverage targets:
 *   - validateAskUserArgs: every error path + every clamp + every
 *     valid edge case.
 *   - encodeAskCallback / decodeAskCallback: round-trip, length budget,
 *     malformed inputs, prefix non-match returns null (caller falls
 *     through to next dispatcher arm).
 *   - generateAskId: shape correct, low collision rate.
 *
 * The runtime side (executor + grammY + TTL timer + callback
 * resolution) lives in gateway.ts and is exercised by the integration
 * tests in real-gateway harness — these tests stay pure / fast.
 */

import { describe, it, expect } from 'bun:test'
import {
  validateAskUserArgs,
  generateAskId,
  encodeAskCallback,
  decodeAskCallback,
  ASK_USER_DEFAULT_TIMEOUT_MS,
  ASK_USER_MAX_TIMEOUT_MS,
  ASK_USER_MIN_TIMEOUT_MS,
  ASK_USER_MAX_OPTIONS,
} from '../ask-user.js'

describe('validateAskUserArgs — required fields', () => {
  it('accepts the minimal valid input (chat_id + question + 2 options)', () => {
    const r = validateAskUserArgs({ chat_id: '123', question: 'OK?', options: ['Yes', 'No'] })
    expect(r.chatId).toBe('123')
    expect(r.question).toBe('OK?')
    expect(r.options).toEqual(['Yes', 'No'])
    expect(r.threadId).toBeUndefined()
    expect(r.replyTo).toBeUndefined()
    expect(r.timeoutMs).toBe(ASK_USER_DEFAULT_TIMEOUT_MS)
  })

  it('rejects empty chat_id', () => {
    expect(() => validateAskUserArgs({ chat_id: '', question: 'q', options: ['a', 'b'] }))
      .toThrow(/chat_id is required/)
  })

  it('rejects missing question', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: '   ', options: ['a', 'b'] }))
      .toThrow(/question is required/)
  })

  it('rejects question over 3500 chars (forced-choice should be short)', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'x'.repeat(3501), options: ['a', 'b'] }))
      .toThrow(/question too long/)
  })
})

describe('validateAskUserArgs — options', () => {
  it('rejects fewer than 2 options', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['only'] }))
      .toThrow(/at least 2/)
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: [] }))
      .toThrow(/at least 2/)
  })

  it(`accepts exactly ${ASK_USER_MAX_OPTIONS} options`, () => {
    const opts = Array.from({ length: ASK_USER_MAX_OPTIONS }, (_, i) => `o${i}`)
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: opts })
    expect(r.options).toEqual(opts)
  })

  it(`rejects more than ${ASK_USER_MAX_OPTIONS} options`, () => {
    const opts = Array.from({ length: ASK_USER_MAX_OPTIONS + 1 }, (_, i) => `o${i}`)
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: opts }))
      .toThrow(/too many options/)
  })

  it('rejects empty option string', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['Yes', ''] }))
      .toThrow(/options\[1\] must be a non-empty string/)
  })

  it('rejects whitespace-only option', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['Yes', '   '] }))
      .toThrow(/options\[1\] must be a non-empty string/)
  })

  it('rejects option label longer than 64 chars', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['Yes', 'x'.repeat(65)] }))
      .toThrow(/options\[1\] too long/)
  })
})

describe('validateAskUserArgs — optional fields', () => {
  it('parses message_thread_id to integer', () => {
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], message_thread_id: '42' })
    expect(r.threadId).toBe(42)
  })

  it('rejects non-positive message_thread_id', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], message_thread_id: '0' }))
      .toThrow(/positive integer/)
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], message_thread_id: '-5' }))
      .toThrow(/positive integer/)
  })

  it('parses reply_to to integer', () => {
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], reply_to: '99' })
    expect(r.replyTo).toBe(99)
  })
})

describe('validateAskUserArgs — timeout clamping', () => {
  it('uses default when timeout_ms is omitted', () => {
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'] })
    expect(r.timeoutMs).toBe(ASK_USER_DEFAULT_TIMEOUT_MS)
  })

  it('floors timeouts below the minimum', () => {
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], timeout_ms: 100 })
    expect(r.timeoutMs).toBe(ASK_USER_MIN_TIMEOUT_MS)
  })

  it('caps timeouts above the maximum', () => {
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], timeout_ms: 99_999_999 })
    expect(r.timeoutMs).toBe(ASK_USER_MAX_TIMEOUT_MS)
  })

  it('passes mid-range timeouts through unchanged', () => {
    const r = validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], timeout_ms: 60_000 })
    expect(r.timeoutMs).toBe(60_000)
  })

  it('rejects non-numeric timeout_ms', () => {
    expect(() => validateAskUserArgs({ chat_id: '1', question: 'q', options: ['a', 'b'], timeout_ms: NaN }))
      .toThrow(/timeout_ms must be a number/)
  })
})

describe('generateAskId', () => {
  it('returns 8 lowercase hex chars', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateAskId()
      expect(id).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('produces distinct ids across many calls (no obvious bias)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateAskId())
    // 32 bits of entropy: collision in 1000 draws would be a real bug.
    expect(seen.size).toBeGreaterThanOrEqual(999)
  })
})

describe('encodeAskCallback / decodeAskCallback round-trip', () => {
  it('round-trips for every valid index', () => {
    const id = '1a2b3c4d'
    for (let i = 0; i < ASK_USER_MAX_OPTIONS; i++) {
      const data = encodeAskCallback(id, i)
      const decoded = decodeAskCallback(data)
      expect(decoded).toEqual({ askId: id, idx: i })
    }
  })

  it('encoded callback stays under Telegram 64-byte budget', () => {
    const id = generateAskId()
    for (let i = 0; i < ASK_USER_MAX_OPTIONS; i++) {
      const data = encodeAskCallback(id, i)
      expect(Buffer.byteLength(data, 'utf-8')).toBeLessThanOrEqual(64)
    }
  })
})

describe('encodeAskCallback — input validation', () => {
  it('rejects malformed askId', () => {
    expect(() => encodeAskCallback('NOTHEX', 0)).toThrow(/invalid askId/)
    expect(() => encodeAskCallback('1a2b3c4', 0)).toThrow(/invalid askId/)  // 7 chars
    expect(() => encodeAskCallback('1a2b3c4d5', 0)).toThrow(/invalid askId/) // 9 chars
    expect(() => encodeAskCallback('1A2B3C4D', 0)).toThrow(/invalid askId/) // uppercase
  })

  it('rejects out-of-range index', () => {
    expect(() => encodeAskCallback('1a2b3c4d', -1)).toThrow(/invalid option index/)
    expect(() => encodeAskCallback('1a2b3c4d', ASK_USER_MAX_OPTIONS)).toThrow(/invalid option index/)
    expect(() => encodeAskCallback('1a2b3c4d', 1.5)).toThrow(/invalid option index/)
  })
})

describe('decodeAskCallback — non-match falls through', () => {
  it('returns null for non-aq prefixes (caller dispatches to next arm)', () => {
    expect(decodeAskCallback('perm:allow:abcde')).toBeNull()
    expect(decodeAskCallback('op:dismiss:agent')).toBeNull()
    expect(decodeAskCallback('vd:unlock:key')).toBeNull()
    expect(decodeAskCallback('')).toBeNull()
  })

  it('returns null for malformed aq: data', () => {
    expect(decodeAskCallback('aq:0:short')).toBeNull()
    expect(decodeAskCallback('aq:abc:1a2b3c4d')).toBeNull()  // non-numeric idx
    expect(decodeAskCallback('aq::1a2b3c4d')).toBeNull()      // empty idx
    expect(decodeAskCallback('aq:9:1a2b3c4d')).toBeNull()      // out of range (>=8)
    expect(decodeAskCallback('aq:0:1a2b3c4d:extra')).toBeNull() // trailing junk
  })
})
