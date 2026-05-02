/**
 * Validation contract for the legacy `update_placeholder` IPC message
 * (#553 hotfix).
 *
 * Background: `vendor/hindsight-memory/scripts/recall.py` still sends
 * `{"type": "update_placeholder", "chatId": "...", "text": "..."}` over
 * the gateway's Unix socket. The placeholder UX it was driving was
 * removed in #553 PR 5, so the gateway no longer registers a real
 * handler. Two compatibility constraints:
 *
 *   1. The validator MUST accept the wire shape — otherwise it logs
 *      "invalid IPC message shape" on every recall hook fire.
 *   2. The dispatcher MUST treat it as a no-op (not fall through to the
 *      "unknown IPC message type" warning), and MUST NOT close the
 *      client connection.
 *
 * We can't edit `vendor/`, so this soft-accept lives in the gateway.
 * Companion to the operator_event and pty_partial validator tests.
 *
 * The end-to-end "connection stays open + log line emitted" property
 * is exercised by `gateway-update-placeholder-dispatch.test.ts` (bun
 * test, because it talks to the real Bun.listen socket).
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'

function base() {
  return {
    type: 'update_placeholder' as const,
    chatId: '123456',
    text: '📚 recalling memories',
  }
}

describe('validateClientMessage — update_placeholder (legacy soft-accept)', () => {
  it('accepts a well-formed legacy message', () => {
    expect(validateClientMessage(base())).toBe(true)
  })

  it('accepts the exact payload shape recall.py emits', () => {
    // Mirrors the JSON body in
    // `vendor/hindsight-memory/scripts/lib/gateway_ipc.py:108-112`.
    // If recall.py changes its shape, this test must be updated together.
    const recallPayload = {
      type: 'update_placeholder',
      chatId: '987654321',
      text: '💭 thinking',
    }
    expect(validateClientMessage(recallPayload)).toBe(true)
  })

  it('requires a non-empty chatId', () => {
    expect(validateClientMessage({ ...base(), chatId: '' })).toBe(false)
    const noChat = { ...base() } as Record<string, unknown>
    delete noChat.chatId
    expect(validateClientMessage(noChat)).toBe(false)
    expect(validateClientMessage({ ...base(), chatId: 42 })).toBe(false)
  })

  it('requires text to be a string and caps it at 8192 chars', () => {
    expect(validateClientMessage({ ...base(), text: '' })).toBe(true)
    expect(validateClientMessage({ ...base(), text: 'x'.repeat(8192) })).toBe(true)
    expect(validateClientMessage({ ...base(), text: 'x'.repeat(8193) })).toBe(false)
    expect(validateClientMessage({ ...base(), text: 42 })).toBe(false)
  })

  it('rejects unknown type aliases that look similar', () => {
    expect(validateClientMessage({ ...base(), type: 'update_placeholders' })).toBe(false)
    expect(validateClientMessage({ ...base(), type: 'place_holder' })).toBe(false)
  })

  it('preserves the existing rejection for missing type field', () => {
    const noType = { chatId: '1', text: 'x' } as Record<string, unknown>
    expect(validateClientMessage(noType)).toBe(false)
  })
})
