/**
 * A reply that was rate-limited and then DELIVERED on retry must not raise a
 * fleet-health delivery-failure alert (#3931).
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * `installTgPostLogger` is a grammy API transformer, so it runs INSIDE the
 * function the retry policy calls — it observes one POST ATTEMPT, never the
 * logical send's outcome. A 429 that `createRetryApiCall` slept and retried
 * successfully therefore left a `tg-post method=sendRichMessage … status=err`
 * line in the gateway log, and fleet-health's `reply-delivery-failure`
 * signature (`src/fleet-health/detect.ts`) matches per LINE. Result: a
 * severity-3 "the answer never reached the principal" escalation for an answer
 * the operator had already read. Under flood pressure (the class of event that
 * produces 429s in the first place) that is the alarm that fires most.
 *
 * ── The fix these tests pin ──────────────────────────────────────────────
 * The retry policy publishes its attempt context; the transformer labels an
 * attempt the policy is about to repeat `status=retry`. `status=err` now means
 * the logical send is OVER and nothing landed. Nothing is suppressed — the
 * retry lines are still written, they just no longer masquerade as outcomes.
 *
 * These tests drive a REAL grammy `Bot` (a mock-`api` harness sits above the
 * transformer layer, so it would be a false guard) through the REAL retry
 * policy, and feed the REAL emitted lines to the REAL detector.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Bot } from 'grammy'
import { installTgPostLogger } from '../shared/bot-runtime.js'
import { createRetryApiCall, willRetryTelegramFailure } from '../retry-api-call.js'
import { detectGatewayFindings, scanAgent } from '../../src/fleet-health/detect.js'

/** A real Bot whose transport answers with `envelopes[i]` for the i-th call. */
function makeBot(envelopes: Array<Record<string, unknown>>): Bot {
  let i = 0
  const fakeFetch = (async () => {
    const envelope = envelopes[Math.min(i, envelopes.length - 1)]
    i++
    // A Bot API rejection is an HTTP 200 carrying `ok:false` — which is
    // precisely why it RESOLVES the transformer chain (see #3927).
    return { ok: true, status: 200, json: async () => envelope } as unknown as Response
  }) as unknown as typeof fetch

  const bot = new Bot('123456:TEST_TOKEN', {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
    client: { fetch: fakeFetch },
  })
  installTgPostLogger(bot)
  return bot
}

const OK_ENVELOPE = {
  ok: true,
  result: { message_id: 7, date: 0, chat: { id: 4242, type: 'private' } },
}
const FLOOD_429 = {
  ok: false,
  error_code: 429,
  description: 'Too Many Requests: retry after 3',
  parameters: { retry_after: 3 },
}

/**
 * Send one user-facing reply through the production composition
 * (retry policy → transformer → wire) and return the gateway log lines it
 * produced, shaped exactly as `gateway-supervisor.log` carries them.
 */
async function gatewayLinesForReply(
  envelopes: Array<Record<string, unknown>>,
): Promise<{ lines: string[]; threw: boolean }> {
  const written: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    written.push(String(chunk))
    return true
  }) as unknown as typeof process.stderr.write)
  let threw = false
  try {
    const bot = makeBot(envelopes)
    // The real policy, with sleeping stubbed out so a 3s flood-wait doesn't
    // cost the suite 3 seconds. Everything else is production behaviour.
    const robustApiCall = createRetryApiCall({ sleep: async () => {} })
    await robustApiCall(() =>
      bot.api.sendRichMessage(4242, { markdown: 'the answer' }),
    ).catch(() => {
      threw = true
    })
  } finally {
    spy.mockRestore()
  }
  const lines = written
    .filter((l) => l.startsWith('tg-post '))
    .map((l) => `2026-08-01T12:00:00Z gateway: ${l.trimEnd()}`)
  return { lines, threw }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('#3931 — a retried-and-delivered reply raises no delivery-failure alert', () => {
  it('429-then-ok: fleet-health sees zero reply-delivery-failures and does not escalate', async () => {
    const { lines, threw } = await gatewayLinesForReply([FLOOD_429, OK_ENVELOPE])

    // Ground truth: the reply WAS delivered. If this ever fails, the fixture
    // stopped modelling the scenario and the assertions below mean nothing.
    expect(threw).toBe(false)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('status=ok')

    // THE outcome: the detector raises nothing, and the agent is not escalated.
    const { gw_hits, findings } = detectGatewayFindings('alpha', lines.join('\n'))
    expect(gw_hits['reply-delivery-failure']).toBe(0)
    expect(findings.filter((f) => f.signal === 'reply-delivery-failure')).toHaveLength(0)
    expect(scanAgent('alpha', '', lines.join('\n')).escalate).toBe(false)

    // The evidence is not hidden — the rate-limit attempt is still on the log,
    // honestly labelled as an attempt rather than an outcome.
    expect(lines[0]).toContain('status=retry')
    expect(lines[0]).toContain('code=429')
  })

  it('an ok:true reply is untouched — no retry tier leaks onto the happy path', async () => {
    const { lines, threw } = await gatewayLinesForReply([OK_ENVELOPE])
    expect(threw).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('status=ok')
    expect(lines[0]).toContain('err=- code=- desc=-')
  })
})

describe('#3931 — a genuinely undelivered reply still escalates', () => {
  it('a terminal 403 escalates', async () => {
    const { lines, threw } = await gatewayLinesForReply([
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    ])
    expect(threw).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('status=err')

    expect(detectGatewayFindings('alpha', lines.join('\n')).gw_hits['reply-delivery-failure']).toBe(1)
    expect(scanAgent('alpha', '', lines.join('\n')).escalate).toBe(true)
  })

  it('a 429 on EVERY attempt (retries exhausted, nothing landed) escalates exactly once', async () => {
    const { lines, threw } = await gatewayLinesForReply([FLOOD_429])
    expect(threw).toBe(true)
    // Three attempts: two survivable, the last one terminal.
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => l.includes('status=retry'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes('status=err'))).toHaveLength(1)

    // One alert for one lost answer — not one per attempt.
    expect(detectGatewayFindings('alpha', lines.join('\n')).gw_hits['reply-delivery-failure']).toBe(1)
    expect(scanAgent('alpha', '', lines.join('\n')).escalate).toBe(true)
  })
})

describe('willRetryTelegramFailure — the predicate mirrors the retry loop', () => {
  const ctx = { attempt: 0, maxRetries: 3, maxFloodSleepMs: 120_000 }

  it('is false with no enclosing retry policy (a raw bot.api.* call is its own outcome)', () => {
    expect(willRetryTelegramFailure({ errorCode: 429, retryAfterSec: 3 }, undefined)).toBe(false)
  })

  it('is false on the last attempt — the loop falls through to give-up', () => {
    expect(
      willRetryTelegramFailure({ errorCode: 429, retryAfterSec: 3 }, { ...ctx, attempt: 2 }),
    ).toBe(false)
  })

  it('is false for a 429 over the in-process sleep ceiling (FLOOD_WAIT_ACTIVE, not retried)', () => {
    expect(willRetryTelegramFailure({ errorCode: 429, retryAfterSec: 15908 }, ctx)).toBe(false)
  })

  it('is true for a 429 under the ceiling and for a transient transport error', () => {
    expect(willRetryTelegramFailure({ errorCode: 429, retryAfterSec: 3 }, ctx)).toBe(true)
    expect(willRetryTelegramFailure({ message: 'ECONNRESET' }, ctx)).toBe(true)
  })

  it('is false for the error classes the loop rethrows immediately', () => {
    expect(willRetryTelegramFailure({ errorCode: 400, message: 'Bad Request' }, ctx)).toBe(false)
    expect(willRetryTelegramFailure({ errorCode: 403 }, ctx)).toBe(false)
    // Local disk exhaustion must NOT look retryable — retrying it is what
    // trips the flood ban in the first place (#2923).
    expect(willRetryTelegramFailure({ message: 'ENOSPC: no space left on device' }, ctx)).toBe(false)
  })
})
