/**
 * Validation contract for `pty_partial` IPC messages.
 *
 * The bridge forwards extracted reply text from Claude Code's TUI
 * rendering so the gateway can drive a draft-stream edit (Claude.ai-
 * style per-character reply streaming, #482). `validateClientMessage`
 * is the gate before the gateway acts on it. Keeps the contract narrow
 * so a rogue process on the same Unix socket can't push arbitrary
 * payloads into the user's chat.
 *
 * Companion to the operator_event and update_placeholder validator
 * tests.
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'

function base() {
  return {
    type: 'pty_partial' as const,
    text: 'Yes — I can help with that.',
  }
}

describe('validateClientMessage — pty_partial', () => {
  it('accepts a well-formed partial', () => {
    expect(validateClientMessage(base())).toBe(true)
  })

  it('accepts the empty string (the extractor emits empty snapshots while the model warms up)', () => {
    // Empty isn't a malformed payload — it's the normal "no text yet"
    // shape from the extractor. The handler dedups against the
    // last-emitted text so an empty snapshot is a no-op downstream.
    expect(validateClientMessage({ ...base(), text: '' })).toBe(true)
  })

  it('caps text at 8192 chars (headroom over Telegram 4096-char limit)', () => {
    expect(validateClientMessage({ ...base(), text: 'x'.repeat(8192) })).toBe(true)
    expect(validateClientMessage({ ...base(), text: 'x'.repeat(8193) })).toBe(false)
  })

  it('requires text to be a string', () => {
    expect(validateClientMessage({ ...base(), text: 42 })).toBe(false)
    expect(validateClientMessage({ ...base(), text: null })).toBe(false)
    const noText = { ...base() } as Record<string, unknown>
    delete noText.text
    expect(validateClientMessage(noText)).toBe(false)
  })

  it('preserves Unicode + multi-line content (the model emits both)', () => {
    expect(
      validateClientMessage({ ...base(), text: 'Line 1\nLine 2 — with em-dash\n你好' }),
    ).toBe(true)
  })

  it('rejects unknown type values', () => {
    expect(validateClientMessage({ ...base(), type: 'pty_oops' })).toBe(false)
  })

  it('rejects messages without a type field', () => {
    const noType = { text: 'hello' } as Record<string, unknown>
    expect(validateClientMessage(noType)).toBe(false)
  })
})
