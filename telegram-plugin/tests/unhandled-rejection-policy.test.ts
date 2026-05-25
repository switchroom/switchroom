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

  it('returns "log_only" for "chat not found" (ziggy 2026-05-02 — stale group id in access.json crashed gateway)', () => {
    // Boot-time pin sweep + various other checks call getChat against
    // every allowlisted chat. Stale ids (bot removed from group, group
    // deleted, leftover config from a prior bot pairing) return this
    // 400. The wrapped sweep catches it visibly via boot-probe-failed,
    // but a leaked rejection from the same family was still crashing
    // the gateway into a restart loop. Don't restart-loop on
    // unreachable chats — log them and move on.
    const err = grammyError(400, 'Bad Request: chat not found')
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

  it('returns "shutdown" for GrammyError 400 with NEW unknown description', () => {
    // Use a description that's not in the benign list — the policy is
    // intentionally narrow so genuinely new bug categories still crash
    // (and surface via systemd restart) rather than silently masking.
    const err = grammyError(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS')
    expect(classifyRejection(err)).toBe('shutdown')
  })
})

describe('classifyRejection — transient API errors (2026-05-25 follow-up)', () => {
  // The pre-fix policy crashed on 429 + 5xx + network errors. That's
  // wrong shape: those errors are already handled by retry-api-call.ts
  // (3 attempts with backoff). When one leaks past the retry policy —
  // either because the caller didn't wrap, or because 3 sustained
  // attempts all failed — crashing the gateway is the worst outcome
  // (one bad packet = visible "agent-crashed" banner + restart loop
  // risk). log_only matches the daemon-stays-up posture.
  //
  // Surfaced 2026-05-25 on clerk: a sendMessage hit 429 after exhausting
  // retries, the rejection bubbled to the unhandledRejection handler,
  // shutdown fired, operator-event banner posted, "clerk seems to be
  // crashing" user-visible.

  it('returns "log_only" for GrammyError 429 (rate limit) — already handled by retry-api-call', () => {
    const err = grammyError(429, 'Too Many Requests: retry after 5')
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for GrammyError 500 (server error)', () => {
    const err = grammyError(500, 'Internal Server Error')
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for GrammyError 502 (Bad Gateway)', () => {
    const err = grammyError(502, 'Bad Gateway')
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for GrammyError 503 (Service Unavailable)', () => {
    const err = grammyError(503, 'Service Unavailable')
    expect(classifyRejection(err)).toBe('log_only')
  })

  it('returns "log_only" for HttpError (network failure) via injected detector', () => {
    // Real grammy HttpError surfaces as e.g. "Network request for
    // 'sendMessage' failed!" wrapping ECONNRESET / ETIMEDOUT / fetch
    // failed. We inject the detector so this test doesn't depend on
    // grammy internals; the production path uses `err instanceof
    // HttpError`.
    const fakeHttp = new Error("Network request for 'sendMessage' failed!")
    expect(
      classifyRejection(fakeHttp, { isHttpError: () => true }),
    ).toBe('log_only')
  })

  it('still returns "shutdown" for GrammyError 403 (forbidden) — must not be masked', () => {
    // 401 (covered above at line 101) and 403 are NOT transient — they
    // indicate a genuine configuration bug (revoked bot token, removed
    // from chat) and must crash so systemd surfaces the failure.
    const err = grammyError(403, 'Forbidden: bot was blocked by the user')
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
