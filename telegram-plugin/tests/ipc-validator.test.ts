/**
 * Exhaustive field-level tests for the IPC validator.
 *
 * The validator is the gateway's only defense against a rogue or buggy
 * client sending malformed payloads over the Unix socket. Every type
 * needs every required field exercised: omitted, wrong-type, boundary
 * values. Previous coverage was round-trip-only and didn't exercise
 * rejection paths at all.
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'

describe('validateClientMessage', () => {
  describe('generic rejection', () => {
    it('rejects non-objects', () => {
      expect(validateClientMessage(null)).toBe(false)
      expect(validateClientMessage(undefined)).toBe(false)
      expect(validateClientMessage(42)).toBe(false)
      expect(validateClientMessage('str')).toBe(false)
      expect(validateClientMessage(true)).toBe(false)
    })

    it('rejects objects without a type field', () => {
      expect(validateClientMessage({})).toBe(false)
      expect(validateClientMessage({ agentName: 'x' })).toBe(false)
    })

    it('rejects unknown types', () => {
      expect(validateClientMessage({ type: 'fake' })).toBe(false)
      expect(validateClientMessage({ type: 'Register' })).toBe(false) // case-sensitive
    })
  })

  describe('register', () => {
    it('accepts minimal valid register (no topicId)', () => {
      expect(validateClientMessage({ type: 'register', agentName: 'coder' })).toBe(true)
    })

    it('accepts register with integer topicId', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'coder', topicId: 42 }),
      ).toBe(true)
    })

    it('accepts topicId=0 (valid integer)', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'coder', topicId: 0 }),
      ).toBe(true)
    })

    it('accepts topicId=undefined as omitted', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'coder', topicId: undefined }),
      ).toBe(true)
    })

    it('rejects missing agentName', () => {
      expect(validateClientMessage({ type: 'register' })).toBe(false)
    })

    it('rejects empty-string agentName', () => {
      expect(validateClientMessage({ type: 'register', agentName: '' })).toBe(false)
    })

    it('rejects agentName longer than 128 chars', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'a'.repeat(129) }),
      ).toBe(false)
    })

    it('accepts agentName exactly 128 chars', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'a'.repeat(128) }),
      ).toBe(true)
    })

    it('rejects non-string agentName', () => {
      expect(validateClientMessage({ type: 'register', agentName: 123 })).toBe(false)
      expect(validateClientMessage({ type: 'register', agentName: null })).toBe(false)
      expect(validateClientMessage({ type: 'register', agentName: {} })).toBe(false)
    })

    // The specific regression the plan called out — topicId must be
    // validated. Before the fix a string/object/bool topicId would pass
    // through and poison the Map<number, Client> index downstream.
    it('rejects topicId as string', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'c', topicId: '42' }),
      ).toBe(false)
    })

    it('rejects topicId as object', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'c', topicId: { n: 1 } }),
      ).toBe(false)
    })

    it('rejects topicId as boolean', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'c', topicId: true }),
      ).toBe(false)
    })

    it('rejects non-integer topicId (floats)', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'c', topicId: 1.5 }),
      ).toBe(false)
    })

    it('rejects Infinity / NaN topicId', () => {
      expect(
        validateClientMessage({ type: 'register', agentName: 'c', topicId: Infinity }),
      ).toBe(false)
      expect(
        validateClientMessage({ type: 'register', agentName: 'c', topicId: NaN }),
      ).toBe(false)
    })

    it('accepts very large integer topicId (Telegram ids fit in Number)', () => {
      expect(
        validateClientMessage({
          type: 'register',
          agentName: 'c',
          topicId: Number.MAX_SAFE_INTEGER,
        }),
      ).toBe(true)
    })
  })

  describe('tool_call', () => {
    it('accepts valid tool_call', () => {
      expect(
        validateClientMessage({
          type: 'tool_call',
          id: 'uuid-1',
          tool: 'reply',
          args: { chat_id: 'x', text: 'y' },
        }),
      ).toBe(true)
    })

    it('rejects missing id', () => {
      expect(
        validateClientMessage({ type: 'tool_call', tool: 'reply', args: {} }),
      ).toBe(false)
    })

    it('rejects empty id', () => {
      expect(
        validateClientMessage({ type: 'tool_call', id: '', tool: 'reply', args: {} }),
      ).toBe(false)
    })

    it('rejects missing tool', () => {
      expect(
        validateClientMessage({ type: 'tool_call', id: 'x', args: {} }),
      ).toBe(false)
    })

    it('rejects empty tool', () => {
      expect(
        validateClientMessage({ type: 'tool_call', id: 'x', tool: '', args: {} }),
      ).toBe(false)
    })

    it('rejects null args', () => {
      expect(
        validateClientMessage({ type: 'tool_call', id: 'x', tool: 'reply', args: null }),
      ).toBe(false)
    })

    it('rejects non-object args', () => {
      expect(
        validateClientMessage({ type: 'tool_call', id: 'x', tool: 'reply', args: 'hi' }),
      ).toBe(false)
    })
  })

  describe('session_event', () => {
    it('accepts valid session_event', () => {
      expect(
        validateClientMessage({
          type: 'session_event',
          chatId: 'c',
          event: { kind: 'turn_end', durationMs: 1000 },
        }),
      ).toBe(true)
    })

    it('rejects missing chatId', () => {
      expect(
        validateClientMessage({ type: 'session_event', event: { kind: 'x' } }),
      ).toBe(false)
    })

    it('rejects non-string chatId', () => {
      expect(
        validateClientMessage({ type: 'session_event', chatId: 42, event: {} }),
      ).toBe(false)
    })

    it('rejects null event', () => {
      expect(
        validateClientMessage({ type: 'session_event', chatId: 'c', event: null }),
      ).toBe(false)
    })
  })

  describe('permission_request', () => {
    it('accepts valid permission_request', () => {
      expect(
        validateClientMessage({
          type: 'permission_request',
          requestId: 'r1',
          toolName: 'Bash',
          description: 'Run something',
          inputPreview: 'ls',
        }),
      ).toBe(true)
    })

    it('rejects missing requestId', () => {
      expect(
        validateClientMessage({
          type: 'permission_request',
          toolName: 'Bash',
          description: 'x',
          inputPreview: 'x',
        }),
      ).toBe(false)
    })

    it('rejects empty requestId', () => {
      expect(
        validateClientMessage({
          type: 'permission_request',
          requestId: '',
          toolName: 'Bash',
          description: 'x',
          inputPreview: 'x',
        }),
      ).toBe(false)
    })

    it('rejects non-string toolName / description / inputPreview', () => {
      for (const field of ['toolName', 'description', 'inputPreview']) {
        const msg: Record<string, unknown> = {
          type: 'permission_request',
          requestId: 'r1',
          toolName: 'Bash',
          description: 'x',
          inputPreview: 'x',
        }
        msg[field] = 42
        expect(validateClientMessage(msg)).toBe(false)
      }
    })
  })

  describe('heartbeat', () => {
    it('accepts valid heartbeat', () => {
      expect(validateClientMessage({ type: 'heartbeat', agentName: 'x' })).toBe(true)
    })

    it('rejects empty agentName', () => {
      expect(validateClientMessage({ type: 'heartbeat', agentName: '' })).toBe(false)
    })

    it('rejects missing agentName', () => {
      expect(validateClientMessage({ type: 'heartbeat' })).toBe(false)
    })
  })
})
