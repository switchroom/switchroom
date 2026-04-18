/**
 * Tests the bridge's gateway→client validator.
 *
 * Mirror of ipc-validator.test.ts on the bridge side. The gateway's
 * validator is strictly structural (no deep schema check); these tests
 * pin down the exact shape the bridge will accept, so if the gateway
 * ever drifts (e.g. renames `chatId` to `chat_id`) the bridge's parse
 * fail mode is loud rather than a silent handler no-op.
 */

import { describe, it, expect } from 'vitest'
import { validateGatewayMessage } from '../bridge/ipc-client.js'
import { allGatewayFixtures } from './protocol-fixtures.js'

describe('validateGatewayMessage', () => {
  describe('generic rejection', () => {
    it('rejects non-objects', () => {
      expect(validateGatewayMessage(null)).toBe(false)
      expect(validateGatewayMessage(undefined)).toBe(false)
      expect(validateGatewayMessage(42)).toBe(false)
      expect(validateGatewayMessage('str')).toBe(false)
    })

    it('rejects objects without a type field', () => {
      expect(validateGatewayMessage({})).toBe(false)
      expect(validateGatewayMessage({ chatId: 'x' })).toBe(false)
    })

    it('rejects unknown types', () => {
      expect(validateGatewayMessage({ type: 'fake' })).toBe(false)
      expect(validateGatewayMessage({ type: 'Inbound' })).toBe(false)
    })
  })

  describe('all protocol fixtures pass', () => {
    it.each(allGatewayFixtures.map((f) => [f.decoded.type, f] as const))(
      '%s fixture is accepted',
      (_type, fixture) => {
        expect(validateGatewayMessage(JSON.parse(fixture.wire))).toBe(true)
      },
    )
  })

  describe('inbound', () => {
    it('accepts minimal inbound (chatId + text)', () => {
      expect(validateGatewayMessage({ type: 'inbound', chatId: 'c', text: 'hi' })).toBe(true)
    })

    it('rejects missing chatId', () => {
      expect(validateGatewayMessage({ type: 'inbound', text: 'hi' })).toBe(false)
    })

    it('rejects non-string chatId', () => {
      expect(validateGatewayMessage({ type: 'inbound', chatId: 42, text: 'hi' })).toBe(false)
    })

    it('rejects missing text', () => {
      expect(validateGatewayMessage({ type: 'inbound', chatId: 'c' })).toBe(false)
    })

    it('rejects non-string text', () => {
      expect(validateGatewayMessage({ type: 'inbound', chatId: 'c', text: 42 })).toBe(false)
    })
  })

  describe('permission', () => {
    it('accepts allow and deny', () => {
      expect(
        validateGatewayMessage({ type: 'permission', requestId: 'r', behavior: 'allow' }),
      ).toBe(true)
      expect(
        validateGatewayMessage({ type: 'permission', requestId: 'r', behavior: 'deny' }),
      ).toBe(true)
    })

    it('rejects unknown behavior', () => {
      expect(
        validateGatewayMessage({ type: 'permission', requestId: 'r', behavior: 'maybe' }),
      ).toBe(false)
    })

    it('rejects empty behavior', () => {
      expect(
        validateGatewayMessage({ type: 'permission', requestId: 'r', behavior: '' }),
      ).toBe(false)
    })

    it('rejects missing requestId', () => {
      expect(validateGatewayMessage({ type: 'permission', behavior: 'allow' })).toBe(false)
    })
  })

  describe('status', () => {
    it('accepts any string status', () => {
      expect(validateGatewayMessage({ type: 'status', status: 'anything' })).toBe(true)
    })

    it('rejects non-string status', () => {
      expect(validateGatewayMessage({ type: 'status', status: 42 })).toBe(false)
    })
  })

  describe('tool_call_result', () => {
    it('accepts success result', () => {
      expect(
        validateGatewayMessage({ type: 'tool_call_result', id: 'x', success: true }),
      ).toBe(true)
    })

    it('accepts failure result', () => {
      expect(
        validateGatewayMessage({
          type: 'tool_call_result',
          id: 'x',
          success: false,
          error: 'nope',
        }),
      ).toBe(true)
    })

    it('rejects missing id', () => {
      expect(
        validateGatewayMessage({ type: 'tool_call_result', success: true }),
      ).toBe(false)
    })

    it('rejects non-boolean success', () => {
      expect(
        validateGatewayMessage({ type: 'tool_call_result', id: 'x', success: 'yes' }),
      ).toBe(false)
    })
  })
})
