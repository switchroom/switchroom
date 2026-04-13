import { describe, it, expect } from 'vitest'
import {
  isContextExhaustionText,
  shouldArmOrphanedReplyTimeout,
  ORPHANED_REPLY_TIMEOUT_MS,
  CONTEXT_EXHAUSTION_MARKER,
} from '../context-exhaustion.js'

describe('isContextExhaustionText', () => {
  it('detects the exact error phrase', () => {
    expect(isContextExhaustionText('Prompt is too long')).toBe(true)
  })

  it('detects the phrase embedded in a larger message', () => {
    expect(
      isContextExhaustionText(
        'Error: Prompt is too long. Consider starting a new conversation.',
      ),
    ).toBe(true)
  })

  it('does not fire on normal assistant text', () => {
    expect(isContextExhaustionText('Reading the file now.')).toBe(false)
    expect(isContextExhaustionText('')).toBe(false)
    expect(isContextExhaustionText('Prompt is fine')).toBe(false)
  })

  it('is case-sensitive (matches Claude Code\'s exact wording)', () => {
    expect(isContextExhaustionText('prompt is too long')).toBe(false)
    expect(isContextExhaustionText('PROMPT IS TOO LONG')).toBe(false)
  })

  it('marker constant is stable', () => {
    expect(CONTEXT_EXHAUSTION_MARKER).toBe('Prompt is too long')
  })
})

describe('shouldArmOrphanedReplyTimeout', () => {
  it('arms when chat is set, text captured, and reply not called', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: '123',
        capturedTextCount: 1,
        replyCalled: false,
      }),
    ).toBe(true)
  })

  it('does not arm when no chat is active', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: null,
        capturedTextCount: 1,
        replyCalled: false,
      }),
    ).toBe(false)
  })

  it('does not arm when no text has been captured', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: '123',
        capturedTextCount: 0,
        replyCalled: false,
      }),
    ).toBe(false)
  })

  it('does not arm after reply tool has been called', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: '123',
        capturedTextCount: 5,
        replyCalled: true,
      }),
    ).toBe(false)
  })

  it('timeout constant is 30 seconds', () => {
    expect(ORPHANED_REPLY_TIMEOUT_MS).toBe(30_000)
  })
})
