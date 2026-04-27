/**
 * Unit tests for `classifyRejection` — the policy that decides whether
 * an unhandledRejection should crash the gateway or be logged-only.
 *
 * Regression for the klanker/lawgpt crash loops (issue #99 + sibling),
 * where Telegram 400 "message is not modified" errors triggered
 * `process.on('unhandledRejection')` → `shutdown()` → systemd restart →
 * loop.
 */

import { describe, it, expect } from 'bun:test'
import { GrammyError } from 'grammy'
import { classifyRejection } from '../gateway/unhandled-rejection-policy.js'

// ── Real GrammyError fixtures ──────────────────────────────────────────────

function grammyError(error_code: number, description: string): GrammyError {
  // GrammyError constructor signature: (message, payload, method, params)
  // We only need error_code and description on the surface; the rest is fine
  // as defaults.
  const err = new GrammyError(
    `Call to 'editMessageText' failed!`,
    {
      ok: false,
      error_code,
      description,
    },
    'editMessageText',
    {} as never,
  )
  return err
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyRejection — benign Telegram 400s', () => {
  it('returns "log_only" for "message is not modified" (klanker #99 + lawgpt)', () => {
    const err = grammyError(
      400,
      'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
    )
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for "message to edit not found"', () => {
    const err = grammyError(400, 'Bad Request: message to edit not found')
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for "message to delete not found"', () => {
    const err = grammyError(400, 'Bad Request: message to delete not found')
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for "can\'t parse entities" (issue #101 — formatDuration HTML parse error)', () => {
    const err = grammyError(
      400,
      "Bad Request: can't parse entities: Unsupported start tag \"1s\" at byte offset 42",
    )
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for "unsupported start tag" variant', () => {
    const err = grammyError(
      400,
      'Bad Request: unsupported start tag "b" at byte offset 10',
    )
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('case-insensitive description match', () => {
    const err = grammyError(400, 'Bad Request: MESSAGE IS NOT MODIFIED: blah')
    expect(classifyRejection(err)).toBe('log_only')
  })
})

describe('classifyRejection — genuine errors still crash', () => {
  it('returns "shutdown" for plain Error', () => {
    expect(classifyRejection(new Error('something blew up'))).toBe('shutdown')
  })

  it('returns "shutdown" for non-Error rejection', () => {
    expect(classifyRejection('a string was thrown')).toBe('shutdown')
    expect(classifyRejection(42)).toBe('shutdown')
    expect(classifyRejection(null)).toBe('shutdown')
    expect(classifyRejection(undefined)).toBe('shutdown')
  })

  it('returns "shutdown" for GrammyError 401 (auth) — must not be masked', () => {
    const err = grammyError(401, 'Bad Request: unauthorized')
    expect(classifyRejection(err)).toBe('shutdown')
  })

  it('returns "shutdown" for GrammyError 429 (rate limit) — should be retried not masked', () => {
    const err = grammyError(429, 'Too Many Requests: retry after 5')
    expect(classifyRejection(err)).toBe('shutdown')
  })

  it('returns "shutdown" for GrammyError 400 with NEW unknown description', () => {
    const err = grammyError(400, 'Bad Request: chat not found')
    expect(classifyRejection(err)).toBe('shutdown')
  })

  it('returns "shutdown" for GrammyError 500 server error', () => {
    const err = grammyError(500, 'Internal Server Error')
    expect(classifyRejection(err)).toBe('shutdown')
  })
})

describe('classifyRejection — duck typing via injected detector', () => {
  it('respects custom isGrammyError detector', () => {
    const fakeGrammy = {
      error_code: 400,
      description: 'Bad Request: message is not modified',
    }
    const result = classifyRejection(fakeGrammy, {
      isGrammyError: () => true,
    })
    expect(result).toBe('log_only')
  })

  it('treats unknown error type as shutdown when detector says false', () => {
    const fake = {
      error_code: 400,
      description: 'message is not modified',
    }
    const result = classifyRejection(fake, {
      isGrammyError: () => false,
    })
    expect(result).toBe('shutdown')
  })
})
