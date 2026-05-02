/**
 * Validation contract for `update_placeholder` IPC messages.
 *
 * The hook (recall.py / future others) sends a JSON line over the
 * gateway socket; `validateClientMessage` is the gate before the
 * gateway acts on it. Keeps the contract narrow so a rogue process on
 * the same socket can't push arbitrary content into the user's
 * Telegram draft.
 *
 * Companion to the operator_event validator tests
 * (`ipc-server-validate-operator.test.ts`).
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'

function base() {
  return {
    type: 'update_placeholder' as const,
    chatId: '8248703757',
    text: '📚 recalling memories…',
  }
}

describe('validateClientMessage — update_placeholder', () => {
  it('accepts a well-formed DM message', () => {
    expect(validateClientMessage(base())).toBe(true)
  })

  it('accepts negative chat ids (groups / channels)', () => {
    expect(validateClientMessage({ ...base(), chatId: '-1001234567890' })).toBe(true)
  })

  it('rejects non-numeric chatIds', () => {
    expect(validateClientMessage({ ...base(), chatId: 'not-a-number' })).toBe(false)
    expect(validateClientMessage({ ...base(), chatId: '12abc' })).toBe(false)
    expect(validateClientMessage({ ...base(), chatId: '12 34' })).toBe(false)
    expect(validateClientMessage({ ...base(), chatId: '<script>' })).toBe(false)
  })

  it('rejects empty chatId', () => {
    expect(validateClientMessage({ ...base(), chatId: '' })).toBe(false)
  })

  it('rejects oversized chatId (would imply a malformed sender)', () => {
    expect(validateClientMessage({ ...base(), chatId: '1'.repeat(33) })).toBe(false)
  })

  it('requires chatId to be a string', () => {
    expect(validateClientMessage({ ...base(), chatId: 123 })).toBe(false)
    expect(validateClientMessage({ ...base(), chatId: null })).toBe(false)
    const noChat = { ...base() } as Record<string, unknown>
    delete noChat.chatId
    expect(validateClientMessage(noChat)).toBe(false)
  })

  it('rejects empty text', () => {
    expect(validateClientMessage({ ...base(), text: '' })).toBe(false)
  })

  it('caps text at 500 chars', () => {
    expect(validateClientMessage({ ...base(), text: 'x'.repeat(500) })).toBe(true)
    expect(validateClientMessage({ ...base(), text: 'x'.repeat(501) })).toBe(false)
  })

  it('requires text to be a string', () => {
    expect(validateClientMessage({ ...base(), text: 42 })).toBe(false)
    expect(validateClientMessage({ ...base(), text: null })).toBe(false)
    const noText = { ...base() } as Record<string, unknown>
    delete noText.text
    expect(validateClientMessage(noText)).toBe(false)
  })

  it('rejects unknown type values', () => {
    expect(validateClientMessage({ ...base(), type: 'something_else' })).toBe(false)
  })
})
