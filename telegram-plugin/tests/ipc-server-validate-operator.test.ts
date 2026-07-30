/**
 * Tightened operator_event validation in `validateClientMessage`
 * (Phase 4c wiring — issue #30 task 2).
 *
 * The Phase 4b shape check accepted any non-empty kind/agent string. With
 * the producer side now actually wired (bridge → IPC), the gateway needs
 * a stricter gate so a misbehaving or compromised bridge can't:
 *   - inject an unknown `kind` that crashes the renderer at switch-default
 *   - send an agent name that bypasses systemctl-arg sanity (the same
 *     regex as `assertSafeAgentName`)
 *   - flood the gateway journal with a giant `detail` payload
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'
import { OPERATOR_EVENT_KINDS } from '../operator-events.js'

// Drift-proof: iterate the CANONICAL taxonomy the validator now derives its
// allowlist from, not a hand-copied literal. A kind added to
// OPERATOR_EVENT_KINDS is automatically covered here; a validator that fails
// to accept any canonical kind fails this test.
const VALID_KINDS = OPERATOR_EVENT_KINDS

function base() {
  return {
    type: 'operator_event' as const,
    kind: 'credentials-expired',
    agent: 'gymbro',
    detail: 'token expired at 2026-04-27',
    chatId: '',
  }
}

describe('validateClientMessage — operator_event', () => {
  it('accepts every taxonomy kind', () => {
    for (const kind of VALID_KINDS) {
      expect(validateClientMessage({ ...base(), kind })).toBe(true)
    }
  })

  // Regression for the 2026-07-30 silent-out-of-credits incident: these three
  // kinds were added to the OperatorEventKind union but NOT to the gateway IPC
  // validator's hand-maintained allowlist. The bridge forwarded a
  // `provider-credit-exhausted` operator_event; the validator rejected it as an
  // "invalid IPC message shape" and dropped it, so an OpenRouter/LiteLLM 402
  // credit wall produced NO loud Telegram card. Named explicitly (not just via
  // the canonical-list loop above) so the failure message points straight at
  // the incident if the allowlist ever regresses to a hand-maintained literal.
  it('accepts the operator-actionable kinds forwarded by the bridge over IPC', () => {
    for (const kind of ['provider-credit-exhausted', 'mcp-dependency-blocked', 'proxy-misconfig']) {
      expect(validateClientMessage({ ...base(), kind }), kind).toBe(true)
    }
  })

  it('rejects unknown kinds', () => {
    expect(validateClientMessage({ ...base(), kind: 'something-else' })).toBe(false)
    expect(validateClientMessage({ ...base(), kind: '' })).toBe(false)
    expect(validateClientMessage({ ...base(), kind: 'CREDENTIALS-EXPIRED' })).toBe(false)
  })

  it('accepts well-formed agent names', () => {
    for (const agent of ['gymbro', 'a', 'a1', 'agent-1', 'a_b', '0xff']) {
      expect(validateClientMessage({ ...base(), agent })).toBe(true)
    }
  })

  it('rejects malformed agent names', () => {
    // leading hyphen would let `switchroom-${agent}` look like a flag
    expect(validateClientMessage({ ...base(), agent: '-bad' })).toBe(false)
    // uppercase, spaces, slashes, semicolons all rejected — the regex
    // is the same one `assertSafeAgentName` uses for systemctl arg safety
    expect(validateClientMessage({ ...base(), agent: 'BadName' })).toBe(false)
    expect(validateClientMessage({ ...base(), agent: 'a b' })).toBe(false)
    expect(validateClientMessage({ ...base(), agent: '../etc' })).toBe(false)
    expect(validateClientMessage({ ...base(), agent: 'a;rm' })).toBe(false)
    expect(validateClientMessage({ ...base(), agent: '' })).toBe(false)
    // Over the 51-char cap (1 leading + 50 trailing)
    expect(validateClientMessage({ ...base(), agent: 'a' + 'b'.repeat(51) })).toBe(false)
  })

  it('caps detail at 1000 chars', () => {
    expect(validateClientMessage({ ...base(), detail: 'x'.repeat(1000) })).toBe(true)
    expect(validateClientMessage({ ...base(), detail: 'x'.repeat(1001) })).toBe(false)
  })

  it('requires chatId to be a string (may be empty)', () => {
    expect(validateClientMessage({ ...base(), chatId: '' })).toBe(true)
    expect(validateClientMessage({ ...base(), chatId: '12345' })).toBe(true)
    const noChat = { ...base() } as Record<string, unknown>
    delete noChat.chatId
    expect(validateClientMessage(noChat)).toBe(false)
    expect(validateClientMessage({ ...base(), chatId: 12345 })).toBe(false)
  })

  it('rejects wrong types on every field', () => {
    expect(validateClientMessage({ ...base(), kind: 42 })).toBe(false)
    expect(validateClientMessage({ ...base(), agent: null })).toBe(false)
    expect(validateClientMessage({ ...base(), detail: null })).toBe(false)
  })
})
