/**
 * Unit tests for draft-transport.ts — shared regex constants and
 * shouldFallbackFromDraftTransport helper.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  DRAFT_METHOD_UNAVAILABLE_RE,
  DRAFT_CHAT_UNSUPPORTED_RE,
  shouldFallbackFromDraftTransport,
  allocateDraftId,
  __resetDraftIdForTests,
  extractDraft429RetryAfterSecs,
  isDraft429,
} from '../draft-transport.js'

describe('DRAFT_METHOD_UNAVAILABLE_RE', () => {
  it('matches "unknown method"', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('unknown method sendMessageDraft')).toBe(true)
  })

  it('matches "method not found"', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('method sendMessageDraft not found')).toBe(true)
  })

  it('matches "method not available"', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('method is not available')).toBe(true)
  })

  it('matches "method not supported"', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('method not supported')).toBe(true)
  })

  it('matches "unsupported"', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('unsupported')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('UNKNOWN METHOD')).toBe(true)
  })

  it('does NOT match unrelated errors', () => {
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('network timeout')).toBe(false)
    expect(DRAFT_METHOD_UNAVAILABLE_RE.test('chat not found')).toBe(false)
  })
})

describe('DRAFT_CHAT_UNSUPPORTED_RE', () => {
  it('matches "can\'t be used"', () => {
    expect(DRAFT_CHAT_UNSUPPORTED_RE.test("sendMessageDraft can't be used in this type of chat")).toBe(true)
  })

  it('matches "can be used only"', () => {
    expect(DRAFT_CHAT_UNSUPPORTED_RE.test('sendMessageDraft can be used only in private chats')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(DRAFT_CHAT_UNSUPPORTED_RE.test("CAN'T BE USED")).toBe(true)
  })

  it('does NOT match unrelated errors', () => {
    expect(DRAFT_CHAT_UNSUPPORTED_RE.test('message not found')).toBe(false)
    expect(DRAFT_CHAT_UNSUPPORTED_RE.test('forbidden')).toBe(false)
  })
})

describe('shouldFallbackFromDraftTransport', () => {
  it('returns false when error text does not mention sendMessageDraft', () => {
    expect(shouldFallbackFromDraftTransport(new Error('unknown method'))).toBe(false)
    expect(shouldFallbackFromDraftTransport(new Error('unsupported feature'))).toBe(false)
  })

  it('returns true for DRAFT_METHOD_UNAVAILABLE_RE with sendMessageDraft in message', () => {
    expect(shouldFallbackFromDraftTransport(
      new Error('sendMessageDraft: unknown method'),
    )).toBe(true)
    expect(shouldFallbackFromDraftTransport(
      new Error('400: sendMessageDraft method not found'),
    )).toBe(true)
  })

  it('returns true for DRAFT_CHAT_UNSUPPORTED_RE with sendMessageDraft in message', () => {
    expect(shouldFallbackFromDraftTransport(
      new Error("sendMessageDraft can't be used in group chats"),
    )).toBe(true)
    expect(shouldFallbackFromDraftTransport(
      new Error('sendMessageDraft can be used only in private chats'),
    )).toBe(true)
  })

  it('accepts a plain string as the error', () => {
    expect(shouldFallbackFromDraftTransport('sendMessageDraft: unknown method')).toBe(true)
    expect(shouldFallbackFromDraftTransport('network error')).toBe(false)
  })

  it('accepts an object with a description field', () => {
    expect(shouldFallbackFromDraftTransport({
      description: 'sendMessageDraft: unknown method',
    })).toBe(true)
    expect(shouldFallbackFromDraftTransport({
      description: 'sendMessageDraft can be used only in DMs',
    })).toBe(true)
  })

  it('returns false for null / undefined / unrelated objects', () => {
    expect(shouldFallbackFromDraftTransport(null)).toBe(false)
    expect(shouldFallbackFromDraftTransport(undefined)).toBe(false)
    expect(shouldFallbackFromDraftTransport(42)).toBe(false)
    expect(shouldFallbackFromDraftTransport({})).toBe(false)
  })

  it('returns false when sendMessageDraft is in message but pattern does not match', () => {
    expect(shouldFallbackFromDraftTransport(
      new Error('sendMessageDraft: rate limited'),
    )).toBe(false)
    expect(shouldFallbackFromDraftTransport(
      new Error('sendMessageDraft: internal server error'),
    )).toBe(false)
  })
})

describe('allocateDraftId', () => {
  beforeEach(() => {
    __resetDraftIdForTests()
  })

  it('allocates incrementing ids starting at 1', () => {
    expect(allocateDraftId()).toBe(1)
    expect(allocateDraftId()).toBe(2)
    expect(allocateDraftId()).toBe(3)
  })

  it('wraps at 2_147_483_647 back to 1', () => {
    // Manually set the counter near max via multiple allocations would be too slow.
    // Instead, use the global state directly.
    const g = globalThis as Record<PropertyKey, unknown>
    const key = Symbol.for('switchroom.draftStreamState')
    const state = g[key] as { nextDraftId: number }
    state.nextDraftId = 2_147_483_647 - 1
    expect(allocateDraftId()).toBe(2_147_483_647)
    // Next should wrap
    expect(allocateDraftId()).toBe(1)
  })
})

// ─── PR D: 429 + non-True helpers ──────────────────────────────────────

describe('extractDraft429RetryAfterSecs (PR D)', () => {
  it('returns retry_after on a grammY 429', () => {
    const err = { error_code: 429, parameters: { retry_after: 7 } }
    expect(extractDraft429RetryAfterSecs(err)).toBe(7)
  })

  it('returns null on non-429 error_code', () => {
    const err = { error_code: 400, parameters: { retry_after: 7 } }
    expect(extractDraft429RetryAfterSecs(err)).toBeNull()
  })

  it('returns null when retry_after is missing', () => {
    const err = { error_code: 429 }
    expect(extractDraft429RetryAfterSecs(err)).toBeNull()
  })

  it('returns null when retry_after is non-positive', () => {
    expect(extractDraft429RetryAfterSecs({ error_code: 429, parameters: { retry_after: 0 } })).toBeNull()
    expect(extractDraft429RetryAfterSecs({ error_code: 429, parameters: { retry_after: -1 } })).toBeNull()
  })

  it('returns null on primitive errors', () => {
    expect(extractDraft429RetryAfterSecs(null)).toBeNull()
    expect(extractDraft429RetryAfterSecs(undefined)).toBeNull()
    expect(extractDraft429RetryAfterSecs('boom')).toBeNull()
    expect(extractDraft429RetryAfterSecs(42)).toBeNull()
  })
})

describe('isDraft429 (PR D)', () => {
  it('returns true when 429 carries method=sendMessageDraft', () => {
    const err = {
      error_code: 429,
      parameters: { retry_after: 5 },
      method: 'sendMessageDraft',
    }
    expect(isDraft429(err)).toBe(true)
  })

  it('returns true when 429 description mentions sendMessageDraft', () => {
    const err = {
      error_code: 429,
      parameters: { retry_after: 5 },
      description: 'sendMessageDraft: Too Many Requests: retry after 5',
    }
    expect(isDraft429(err)).toBe(true)
  })

  it('returns false on 429 from a different method', () => {
    const err = {
      error_code: 429,
      parameters: { retry_after: 5 },
      method: 'sendMessage',
    }
    expect(isDraft429(err)).toBe(false)
  })

  it('returns false on non-429 errors even when mentioning sendMessageDraft', () => {
    const err = {
      error_code: 400,
      description: 'sendMessageDraft: bad request',
    }
    expect(isDraft429(err)).toBe(false)
  })
})
