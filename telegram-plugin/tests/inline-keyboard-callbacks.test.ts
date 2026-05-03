/**
 * Unit tests for #271's agent-callback prefix wrapping + parsing.
 *
 * These pin the wire-format contract so the gateway's callback_query
 * dispatcher and the inline_keyboard validation in executeReply /
 * executeStreamReply stay in sync. If anyone adds a new infrastructure
 * prefix in callback_query routing, these tests still pass — but the
 * contract that `agent:` is reserved for round-tripping is enforced
 * by the parser.
 */

import { describe, it, expect } from 'vitest'
import {
  AGENT_CALLBACK_PREFIX,
  AGENT_CALLBACK_DATA_MAX,
  wrapAgentCallbacks,
  parseAgentCallback,
  validateAndWrapAgentKeyboard,
} from '../inline-keyboard-callbacks.js'

describe('inline-keyboard-callbacks (#271)', () => {
  describe('AGENT_CALLBACK_DATA_MAX', () => {
    it('reserves room for the prefix within Telegram\'s 64-byte limit', () => {
      // Sanity: prefix bytes + agent budget == Telegram limit (64).
      const prefixBytes = new TextEncoder().encode(AGENT_CALLBACK_PREFIX).byteLength
      expect(prefixBytes + AGENT_CALLBACK_DATA_MAX).toBe(64)
    })
  })

  describe('wrapAgentCallbacks', () => {
    it('prepends `agent:` to every callback_data field', () => {
      const wrapped = wrapAgentCallbacks([
        [{ text: 'Approve', callback_data: 'approve_pr_547' }],
        [{ text: 'Hold', callback_data: 'hold' }],
      ])
      expect(wrapped[0]![0]!.callback_data).toBe('agent:approve_pr_547')
      expect(wrapped[1]![0]!.callback_data).toBe('agent:hold')
    })

    it('passes URL buttons through unchanged', () => {
      const wrapped = wrapAgentCallbacks([
        [{ text: 'Open docs', url: 'https://example.com' }],
      ])
      expect(wrapped[0]![0]).toEqual({ text: 'Open docs', url: 'https://example.com' })
      expect(wrapped[0]![0]!.callback_data).toBeUndefined()
    })

    it('handles mixed URL + callback_data buttons in one row', () => {
      const wrapped = wrapAgentCallbacks([
        [
          { text: 'Open', url: 'https://x.test' },
          { text: 'Approve', callback_data: 'ok' },
        ],
      ])
      expect(wrapped[0]![0]!.url).toBe('https://x.test')
      expect(wrapped[0]![0]!.callback_data).toBeUndefined()
      expect(wrapped[0]![1]!.callback_data).toBe('agent:ok')
      expect(wrapped[0]![1]!.url).toBeUndefined()
    })

    it('returns a fresh array — does not mutate input', () => {
      const original = [[{ text: 'A', callback_data: 'a' }]]
      const wrapped = wrapAgentCallbacks(original)
      expect(original[0]![0]!.callback_data).toBe('a')
      expect(wrapped[0]![0]!.callback_data).toBe('agent:a')
      expect(wrapped).not.toBe(original)
      expect(wrapped[0]).not.toBe(original[0])
    })

    it('throws when an agent-supplied callback_data exceeds the 58-byte budget', () => {
      const tooLong = 'x'.repeat(AGENT_CALLBACK_DATA_MAX + 1)
      expect(() =>
        wrapAgentCallbacks([[{ text: 'X', callback_data: tooLong }]]),
      ).toThrow(/exceeds 58-byte agent budget/)
    })

    it('accepts callback_data exactly at the 58-byte budget', () => {
      const atLimit = 'x'.repeat(AGENT_CALLBACK_DATA_MAX)
      const wrapped = wrapAgentCallbacks([[{ text: 'X', callback_data: atLimit }]])
      const wireBytes = new TextEncoder().encode(wrapped[0]![0]!.callback_data as string).byteLength
      expect(wireBytes).toBe(64) // hits Telegram's hard limit exactly
    })

    it('counts BYTES not chars for multi-byte UTF-8', () => {
      // '🔐' is 4 bytes in UTF-8. 14 of them = 56 bytes — under the
      // 58-byte budget, so should pass. 15 of them = 60 bytes — over.
      const ok = '🔐'.repeat(14)
      expect(() =>
        wrapAgentCallbacks([[{ text: 'X', callback_data: ok }]]),
      ).not.toThrow()

      const bad = '🔐'.repeat(15)
      expect(() =>
        wrapAgentCallbacks([[{ text: 'X', callback_data: bad }]]),
      ).toThrow(/exceeds 58-byte agent budget/)
    })

    it('handles an empty keyboard without crashing', () => {
      expect(wrapAgentCallbacks([])).toEqual([])
    })
  })

  describe('parseAgentCallback', () => {
    it('strips the prefix and returns the raw payload', () => {
      const result = parseAgentCallback('agent:approve_pr_547')
      expect(result).toEqual({ raw: 'approve_pr_547' })
    })

    it('returns null for non-agent prefixes (lets dispatcher fall through)', () => {
      expect(parseAgentCallback('auth:rotate:clerk')).toBeNull()
      expect(parseAgentCallback('op:dismiss:klanker')).toBeNull()
      expect(parseAgentCallback('vd:unlock:abc')).toBeNull()
      expect(parseAgentCallback('aq:0:xyz')).toBeNull()
      expect(parseAgentCallback('perm:allow:abcde')).toBeNull()
      expect(parseAgentCallback('something_random')).toBeNull()
    })

    it('returns empty raw payload when the agent emitted bare prefix', () => {
      // Edge case: agent emits `callback_data: ''` (zero-length). After
      // wrap we'd send `agent:`. Round-tripping returns { raw: '' }.
      // Validation upstream should reject empty callback_data; this is
      // a defensive check.
      expect(parseAgentCallback('agent:')).toEqual({ raw: '' })
    })
  })

  describe('validateAndWrapAgentKeyboard', () => {
    it('returns ok=true with wrapped keyboard on a valid input', () => {
      const result = validateAndWrapAgentKeyboard([
        [{ text: 'Approve', callback_data: 'ok' }],
      ])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.wrapped[0]![0]!.callback_data).toBe('agent:ok')
      }
    })

    it('returns ok=false with errors when validation fails', () => {
      // Empty text fails the existing validateInlineKeyboard.
      const result = validateAndWrapAgentKeyboard([
        [{ text: '', callback_data: 'ok' }],
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0)
        expect(result.errors[0]!.field).toBe('text')
      }
    })
  })
})
