import { describe, expect, it, vi } from 'vitest'

import { guardSilentReply, isSilentReplyMarker } from '../server.js'

/**
 * Regression coverage for sprint1 review finding #6: the reply /
 * stream_reply tool handlers must call `assertAllowedChat(chat_id)`
 * BEFORE returning the silent-reply ack, so an unauthorised chat
 * cannot bypass the outbound allowlist by having the agent emit
 * `NO_REPLY` / `HEARTBEAT_OK`.
 *
 * We exercise the extracted `guardSilentReply` helper directly rather
 * than the full MCP tool handler; the handler scaffolding (IPC + Bot
 * harness + history DB) is heavy, and the ordering contract — "assert
 * first, then ack" — lives entirely inside the helper.
 */
describe('guardSilentReply — allowlist ordering', () => {
  it('asserts the allowlist BEFORE returning a silent ack (NO_REPLY)', () => {
    const assertAllowed = vi.fn()
    const result = guardSilentReply({
      chat_id: '123',
      text: 'NO_REPLY',
      hasFiles: false,
      assertAllowed,
    })
    expect(assertAllowed).toHaveBeenCalledOnce()
    expect(assertAllowed).toHaveBeenCalledWith('123')
    expect(result).toEqual({ kind: 'silent', markerText: 'NO_REPLY' })
  })

  it('recognises HEARTBEAT_OK as a silent marker and still gates on allowlist', () => {
    const assertAllowed = vi.fn()
    const result = guardSilentReply({
      chat_id: '456',
      text: '  heartbeat_ok  ',
      hasFiles: false,
      assertAllowed,
    })
    expect(assertAllowed).toHaveBeenCalledWith('456')
    expect(result).toEqual({ kind: 'silent', markerText: 'heartbeat_ok' })
  })

  it('throws (does NOT return a silent ack) when the chat is disallowed', () => {
    // This is the exact bypass the fix prevents: an unauthorised chat_id
    // using NO_REPLY must NOT receive a successful silent-reply ack.
    const assertAllowed = vi.fn((chat_id: string) => {
      throw new Error(`chat ${chat_id} is not allowlisted`)
    })
    expect(() =>
      guardSilentReply({
        chat_id: '999',
        text: 'NO_REPLY',
        hasFiles: false,
        assertAllowed,
      }),
    ).toThrow(/not allowlisted/)
    expect(assertAllowed).toHaveBeenCalledOnce()
  })

  it('does not short-circuit (or call assertAllowed) when files are attached', () => {
    // Silent-reply semantics are text-only; a NO_REPLY payload with files
    // is a real send and must flow through the normal allowlist path
    // inside the send codepath, not the silent short-circuit.
    const assertAllowed = vi.fn()
    const result = guardSilentReply({
      chat_id: '123',
      text: 'NO_REPLY',
      hasFiles: true,
      assertAllowed,
    })
    expect(assertAllowed).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'continue' })
  })

  it('does not short-circuit for normal prose that merely mentions the marker', () => {
    const assertAllowed = vi.fn()
    const result = guardSilentReply({
      chat_id: '123',
      text: 'the agent suggested NO_REPLY earlier',
      hasFiles: false,
      assertAllowed,
    })
    expect(assertAllowed).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'continue' })
  })

  it('does not short-circuit on undefined/empty text', () => {
    const assertAllowed = vi.fn()
    expect(
      guardSilentReply({
        chat_id: '123',
        text: undefined,
        hasFiles: false,
        assertAllowed,
      }),
    ).toEqual({ kind: 'continue' })
    expect(
      guardSilentReply({
        chat_id: '123',
        text: '',
        hasFiles: false,
        assertAllowed,
      }),
    ).toEqual({ kind: 'continue' })
    expect(assertAllowed).not.toHaveBeenCalled()
  })

  // Sanity: the helper the guard delegates to is exported for direct
  // marker-recognition testing. Keep a thin smoke assertion so future
  // marker-set tweaks break here rather than at the ordering layer.
  it('isSilentReplyMarker recognises the documented marker set', () => {
    expect(isSilentReplyMarker('NO_REPLY')).toBe(true)
    expect(isSilentReplyMarker('HEARTBEAT_OK')).toBe(true)
    expect(isSilentReplyMarker('no_reply')).toBe(true)
    expect(isSilentReplyMarker('hello')).toBe(false)
    expect(isSilentReplyMarker(undefined)).toBe(false)
  })
})
