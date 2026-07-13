/**
 * llm-error-present.test.ts — outcome-asserting tests for the humanized,
 * cross-surface-deduped LLM-error surfacing (no raw JSON passthrough).
 *
 * Each block is written to FAIL against pre-fix behaviour:
 *   - golden fan-out: pre-fix, the raw synthetic-error text fanned out to the
 *     reply + done-card surfaces (≥2 messages, raw bytes) — this asserts EXACTLY
 *     ONE JSON-free message across all three.
 *   - operator-card sanitize: pre-fix, renderOperatorEvent embedded the raw
 *     detail verbatim — this asserts the bytes are gone.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseLlmError,
  renderLlmError,
  renderLlmErrorSafe,
  stripRawErrorBytes,
  extractRequestId,
  formatResetLocal,
  decideErrorSurface,
  isActionableKind,
  ErrorPresenceGate,
  errorPresenceGate,
  ERROR_COLLAPSE_WINDOW_MS,
  type LlmErrorRetryState,
} from '../llm-error-present.js'
import { truncateDetailPreservingRequestId } from '../raw-error-scrub.js'
import { projectTranscriptLine, detectErrorInTranscriptLine } from '../session-tail.js'
import { renderOperatorEvent, type OperatorEvent } from '../operator-events.js'
import { redact } from '../secret-detect/redact.js'

// A raw byte-blob every surface must scrub.
const RAW_BYTES = `b'{"type":"error","error":{"type":"rate_limit_error","message":"rate limit"},"request_id":"req_abc123"}'`

function assertNoRawBytes(text: string): void {
  expect(text).not.toContain("b'{")
  expect(text).not.toContain('{"type":"error"')
  expect(text.toLowerCase()).not.toContain('api error:')
}

// ─── stripRawErrorBytes ──────────────────────────────────────────────────────

describe('stripRawErrorBytes', () => {
  it('removes the Python byte-blob, JSON error object, and API Error prefix', () => {
    const raw = `API Error: 429 Server is temporarily limiting requests · ${RAW_BYTES}`
    const out = stripRawErrorBytes(raw)
    assertNoRawBytes(out)
    expect(out).toContain('Server is temporarily limiting requests')
  })

  it('passes a clean human string through unchanged (modulo whitespace)', () => {
    expect(stripRawErrorBytes('Invalid API key')).toBe('Invalid API key')
    expect(stripRawErrorBytes('Rate limit exceeded')).toBe('Rate limit exceeded')
    expect(stripRawErrorBytes('')).toBe('')
  })

  it('strips a bare JSON blob down to empty', () => {
    expect(stripRawErrorBytes('{"type":"error","error":{"type":"overloaded_error"}}')).toBe('')
  })
})

// ─── extractRequestId ────────────────────────────────────────────────────────

describe('extractRequestId', () => {
  it('pulls an Anthropic request_id from a raw JSON string', () => {
    expect(extractRequestId(RAW_BYTES)).toBe('req_abc123')
    expect(extractRequestId('no id here')).toBeUndefined()
  })
})

// ─── parser table ────────────────────────────────────────────────────────────

describe('parseLlmError — classification table', () => {
  it('rate_limit (Anthropic account throttle)', () => {
    const p = parseLlmError(
      "This request would exceed your account's rate limit. Please try again later.",
    )
    expect(p.kind).toBe('rate_limit')
    expect(p.source).toBe('anthropic')
    assertNoRawBytes(p.coreText)
  })

  it('overload_529', () => {
    const p = parseLlmError('overloaded_error: Anthropic 529 overloaded')
    expect(p.kind).toBe('overload_529')
    expect(p.source).toBe('anthropic')
    assertNoRawBytes(p.coreText)
  })

  it('quota_wall with a parsed reset', () => {
    const p = parseLlmError("You've hit your limit · resets 8:50am (Australia/Melbourne)")
    expect(p.kind).toBe('quota_wall')
    expect(p.source).toBe('anthropic')
    expect(p.resetAt).toBeInstanceOf(Date)
    expect(p.terminal).toBe(true)
    assertNoRawBytes(p.coreText)
  })

  it('litellm-local proxy 429', () => {
    const p = parseLlmError(
      'litellm.RateLimitError: Deployment over user-defined ratelimit. tpm limit=8000. current usage=8241',
    )
    expect(p.kind).toBe('rate_limit')
    expect(p.source).toBe('litellm-local')
    assertNoRawBytes(p.coreText)
  })

  it('auth (credentials expired)', () => {
    const p = parseLlmError('authentication_error: OAuth token expired, please refresh')
    expect(p.kind).toBe('auth')
    expect(p.source).toBe('anthropic')
    expect(p.terminal).toBe(true)
    expect(p.autoRetrying).toBe(false)
  })

  it('network', () => {
    const p = parseLlmError('fetch failed: ECONNREFUSED getaddrinfo ENOTFOUND api.anthropic.com')
    expect(p.kind).toBe('transient')
    expect(p.source).toBe('network')
    assertNoRawBytes(p.coreText)
  })

  it('unknown falls through cleanly', () => {
    const p = parseLlmError('something entirely unrecognizable happened')
    expect(p.kind).toBe('unknown')
    assertNoRawBytes(p.coreText)
  })

  it('extracts model + requestId, and coreText is JSON-free even from a raw line', () => {
    const raw = `Server is temporarily limiting requests · model=claude-opus-4-8 · ${RAW_BYTES}`
    const p = parseLlmError(raw)
    expect(p.kind).toBe('rate_limit')
    expect(p.model).toBe('claude-opus-4-8')
    expect(p.requestId).toBe('req_abc123')
    assertNoRawBytes(p.coreText)
  })
})

// ─── local-time render ───────────────────────────────────────────────────────

describe('renderLlmError / formatResetLocal — local-time rendering', () => {
  const tz = 'Australia/Melbourne'
  // Pin now to a fixed instant. 2026-07-13T06:14:00Z = 4:14pm AEST (winter, +10).
  const now = new Date('2026-07-13T06:14:00Z')

  it('renders the reset in local wall-clock + relative tail, DST-correct', () => {
    // resetAt = 2026-07-13T06:52:00Z = 4:52pm AEST, ~38m out.
    const reset = new Date('2026-07-13T06:52:00Z')
    const line = formatResetLocal(reset, tz, now)
    expect(line).toContain('4:52pm')
    expect(line).toContain('AEST')
    expect(line).toContain('~in 38m')
  })

  it('renderLlmError produces a JSON-free card with the local reset', () => {
    const parsed = parseLlmError(
      `Server is temporarily limiting requests · resets 4:52pm (Australia/Melbourne) · ${RAW_BYTES}`,
    )
    const { text } = renderLlmError(parsed, 'gymbro', tz, now)
    assertNoRawBytes(text)
    expect(text).toContain('gymbro')
    expect(text).toContain('AEST')
  })

  // FIX 1 (Ken, CPO, 2026-07): the dead auth/quota action buttons are GONE —
  // renderLlmError never returns an inline_keyboard; the actionable classes
  // carry a plain-text recommendation line instead.
  it('auth card recommends re-authentication in text, with NO action buttons', () => {
    const auth = renderLlmError(parseLlmError('authentication_error: token expired'), 'a', tz, now)
    expect((auth as { keyboard?: unknown }).keyboard).toBeUndefined()
    expect(auth.text.toLowerCase()).toContain('re-authenticate')
  })

  it('quota_wall card recommends switch/wait in text (naming the reset), NO buttons', () => {
    const quota = renderLlmError(parseLlmError("You've hit your limit · resets 5pm"), 'a', tz, now)
    expect((quota as { keyboard?: unknown }).keyboard).toBeUndefined()
    const lower = quota.text.toLowerCase()
    expect(lower).toContain('switch to another account')
    expect(lower).toContain('wait for the quota to reset')
    // The reset instant is named in the recommendation line.
    expect(quota.text).toContain('AEST')
  })

  it('transient (rate_limit) card has neither buttons nor an action recommendation', () => {
    const rl = renderLlmError(parseLlmError('rate_limit_error: slow down'), 'a', tz, now)
    expect((rl as { keyboard?: unknown }).keyboard).toBeUndefined()
    expect(rl.text.toLowerCase()).not.toContain('re-authenticate')
    expect(rl.text).not.toContain('→')
  })

  // FIX 3 (crash guard): an invalid IANA timezone throws a RangeError out of the
  // raw renderer (local-time.ts's "never throws" claim is false for tz
  // construction). renderLlmErrorSafe MUST swallow it and degrade — asserting the
  // OUTCOME (no throw + a usable message), not just that the branch ran.
  it('renderLlmError DOES throw on an invalid tz with a reset present (documents the hazard)', () => {
    const parsed = parseLlmError("You've hit your limit · resets 5pm")
    expect(parsed.resetAt).toBeDefined()
    expect(() => renderLlmError(parsed, 'gymbro', 'Not/AZone', now)).toThrow()
  })

  it('renderLlmErrorSafe does NOT throw on an invalid tz and returns a usable line', () => {
    const parsed = parseLlmError("You've hit your limit · resets 5pm")
    let out: { text: string } | undefined
    expect(() => {
      out = renderLlmErrorSafe(parsed, 'gymbro', 'Not/AZone', now)
    }).not.toThrow()
    expect(out?.text).toContain('gymbro')
    assertNoRawBytes(out!.text)
  })
})

// ─── FIX 2: operator-card text is scrubbed by the REAL redactor ───────────────
//
// The gateway sends operator-event cards via a raw bot.api call that bypasses
// the normal outbound redact chokepoint; it now routes the rendered text through
// the same redact() the reply path uses. These tests assert the OUTCOME: a
// synthetic bearer token / sk- key / url-embedded credential planted in an error
// detail does NOT survive into the redacted card text. stripRawErrorBytes alone
// (a JSON-shape scrub) does NOT catch these — redact() is required.
describe('operator-card secret redaction (FIX 2)', () => {
  const now = new Date('2026-07-13T06:14:00Z')
  // Runtime-assembled so no contiguous Anthropic-token literal lands in source
  // (check-no-pii-secrets discipline). Resolves to a real sk-ant-shaped key that
  // redact()'s anthropic_api_key pattern masks.
  const BEARER = ['sk', 'ant', 'api03-ABCDEF1234567890abcdefGHIJKLMN'].join('-')
  const URL_SECRET = 'https://user:hunter2pass@api.anthropic.com/v1/x?api_key=abc123secretval456'

  const mkEvent = (kind: OperatorEvent['kind'], detail: string): OperatorEvent => ({
    agent: 'gymbro',
    kind,
    detail,
    suggestedActions: [],
    firstSeenAt: now,
  })

  // Mirrors emitGatewayOperatorEvent's transform: redact the DETAIL first (via
  // the real redact()), THEN render — so the scrub happens BEFORE the renderer's
  // escapeMarkdown, exactly as production now does. Redacting the already-escaped
  // final text would let url-query-param secrets (`api_key=…`) slip past.
  const renderCardAsSent = (ev: OperatorEvent): string =>
    renderOperatorEvent({ ...ev, detail: redact(ev.detail) }).text

  it('stripRawErrorBytes alone LEAKS a bearer/api-key (proves redact is needed)', () => {
    // Guard test: the shape-scrub inside the renderer is JSON-shape-only. If this
    // ever stops leaking, the shape-scrub grew secret awareness.
    expect(stripRawErrorBytes(`auth failed: Bearer ${BEARER}`)).toContain(BEARER)
  })

  it('pre-fix render (no redact) LEAKS the bearer; the production transform scrubs it', () => {
    const ev = mkEvent('credentials-expired', `token rejected: Bearer ${BEARER}`)
    // Renderer alone (pre-fix path): secret survives.
    expect(renderOperatorEvent(ev).text).toContain(BEARER)
    // Production transform (redact detail → render): secret is gone.
    expect(renderCardAsSent(ev)).not.toContain(BEARER)
  })

  it('masks a url-embedded credential in a credit-exhausted card', () => {
    const ev = mkEvent('credit-exhausted', `billing check: ${URL_SECRET}`)
    const sent = renderCardAsSent(ev)
    expect(sent).not.toContain('hunter2pass')
    expect(sent).not.toContain('abc123secretval456')
  })

  it('masks a bearer key in an unknown-4xx card', () => {
    const ev = mkEvent('unknown-4xx', `API Error: 400 · x-api-key ${BEARER}`)
    expect(renderCardAsSent(ev)).not.toContain(BEARER)
  })

  it('the humanized (renderLlmError) card never relays raw detail — no secret to leak', () => {
    // The humanized card's coreText is a per-kind TEMPLATE, never the raw detail,
    // so a secret in the detail cannot reach it even before redaction.
    const parsed = parseLlmError(`rate_limit_error · Bearer ${BEARER}`)
    expect(renderLlmError(parsed, 'gymbro', 'Australia/Melbourne', now).text).not.toContain(BEARER)
  })
})

// ─── dedup key ───────────────────────────────────────────────────────────────

describe('ErrorPresenceGate — dedup key semantics', () => {
  let gate: ErrorPresenceGate
  beforeEach(() => {
    gate = new ErrorPresenceGate()
  })

  it('same requestId → collapses to 1', () => {
    const p = { kind: 'rate_limit' as const, requestId: 'req_x' }
    const now = 1_000_000
    const k = gate.keyFor(p, 'agent', now)
    expect(gate.claim(k, now)).toBe(true)
    expect(gate.claim(gate.keyFor(p, 'agent', now + 5_000), now + 5_000)).toBe(false)
  })

  it('different requestId, same kind → 2 distinct claims', () => {
    const now = 1_000_000
    expect(gate.claim(gate.keyFor({ kind: 'rate_limit', requestId: 'a' }, 'g', now), now)).toBe(true)
    expect(gate.claim(gate.keyFor({ kind: 'rate_limit', requestId: 'b' }, 'g', now), now)).toBe(true)
  })

  it('no requestId, same kind: <window → 1, >window → 2', () => {
    const now = 5 * ERROR_COLLAPSE_WINDOW_MS
    const p = { kind: 'rate_limit' as const }
    expect(gate.claim(gate.keyFor(p, 'g', now), now)).toBe(true)
    // Within window (same bucket) → suppressed.
    const within = now + ERROR_COLLAPSE_WINDOW_MS - 1
    expect(gate.claim(gate.keyFor(p, 'g', within), within)).toBe(false)
    // Past window (next bucket) → new claim.
    const past = now + ERROR_COLLAPSE_WINDOW_MS + 1
    expect(gate.claim(gate.keyFor(p, 'g', past), past)).toBe(true)
  })
})

// ─── auto-retry silence ──────────────────────────────────────────────────────
//
// UNIT test of the module's own auto-retry-silence CONTRACT: given a retryState
// with attempt<max, a transient error is suppressed. This is NOT exercised by
// the production gateway wiring (it calls `parseLlmError(detail)` without a
// retryState, and session-tail already drops in-flight transients upstream — see
// the note in decideErrorSurface). These cases pin the module guarantee for any
// caller that DOES thread retryState; they do not imply the gateway does.

describe('decideErrorSurface — auto-retry silence (module contract, retryState-driven)', () => {
  beforeEach(() => errorPresenceGate.reset())

  it('a transient 529 mid-retry (attempt<max) is silenced on all surfaces', () => {
    const retry: LlmErrorRetryState = { retryAttempt: 1, maxRetries: 5 }
    const p = parseLlmError('overloaded_error 529 overloaded', retry)
    expect(p.autoRetrying).toBe(true)
    expect(p.terminal).toBe(false)
    expect(decideErrorSurface(p, 'g', { claim: true })).toBe('suppress')
  })

  it('the same 529 at attempt>=max renders exactly one card', () => {
    const retry: LlmErrorRetryState = { retryAttempt: 5, maxRetries: 5 }
    const p = parseLlmError('overloaded_error 529 overloaded', retry)
    expect(p.autoRetrying).toBe(false)
    expect(p.terminal).toBe(true)
    expect(decideErrorSurface(p, 'g', { claim: true })).toBe('render')
    // A second surface for the same terminal error collapses.
    expect(decideErrorSurface(p, 'g', { claim: true })).toBe('suppress')
  })
})

// ─── actionable never suppressed ─────────────────────────────────────────────

describe('decideErrorSurface — actionable kinds never suppressed', () => {
  beforeEach(() => errorPresenceGate.reset())

  it('auth + quota_wall always render even inside an active collapse window', () => {
    const auth = parseLlmError('authentication_error: credentials expired')
    const quota = parseLlmError("You've hit your limit · resets 5pm")
    expect(isActionableKind(auth.kind)).toBe(true)
    expect(isActionableKind(quota.kind)).toBe(true)
    // Pre-claim the same-kind window key to simulate a busy collapse window.
    const now = 2_000_000
    errorPresenceGate.claim(errorPresenceGate.keyFor(auth, 'g', now), now)
    errorPresenceGate.claim(errorPresenceGate.keyFor(quota, 'g', now), now)
    expect(decideErrorSurface(auth, 'g', { claim: true, now })).toBe('render')
    expect(decideErrorSurface(quota, 'g', { claim: true, now })).toBe('render')
  })
})

// ─── golden fan-out ──────────────────────────────────────────────────────────

describe('golden fan-out — one 429 line → exactly one JSON-free user message', () => {
  beforeEach(() => errorPresenceGate.reset())

  // The v2.1.x synthetic-assistant usage/rate-limit shape: the raw error text
  // lives inside message.content[].text, with the byte-blob attached.
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `Server is temporarily limiting requests (not your usage limit) · resets 4:52pm (Australia/Melbourne) · ${RAW_BYTES}`,
        },
      ],
    },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  })

  it('starves the reply + done-card surfaces and renders one operator card', () => {
    const userMessages: string[] = []

    // Surfaces #1 (done-card recap) and #3 (reply passthrough) both derive from
    // the projected transcript `text` events. Post-fix: NO text/thinking event
    // is projected for an isApiErrorMessage line, so neither surface can relay
    // the raw bytes as the turn's answer.
    const projected = projectTranscriptLine(line)
    for (const ev of projected) {
      if (ev.kind === 'text') userMessages.push(`reply:${ev.text}`)
    }
    expect(projected.some((e) => e.kind === 'text')).toBe(false)

    // Surface #2 (operator card): the SAME line is independently classified and
    // rendered as the ONE humanized card. This mirrors the production gateway
    // call exactly — `parseLlmError(detail)` with NO retryState (session-tail
    // has already dropped any in-flight transient before forwarding, so the
    // event that reaches the gateway is terminal by construction).
    const detected = detectErrorInTranscriptLine(line)
    expect(detected).not.toBeNull()
    expect(detected!.terminal).toBe(true)
    const parsed = parseLlmError(detected!.detail)
    if (decideErrorSurface(parsed, 'gymbro', { claim: true }) === 'render') {
      userMessages.push(renderLlmError(parsed, 'gymbro', 'Australia/Melbourne').text)
    }

    // EXACTLY ONE user-facing message, and it carries no raw bytes.
    expect(userMessages).toHaveLength(1)
    assertNoRawBytes(userMessages[0])
  })
})

// ─── operator-card sanitize (surface #2 regression) ──────────────────────────

describe('renderOperatorEvent — never relays raw error bytes', () => {
  function ev(kind: OperatorEvent['kind'], detail: string): OperatorEvent {
    return { kind, agent: 'g', detail, suggestedActions: [], firstSeenAt: new Date() }
  }

  it('strips raw bytes from a rate-limited detail', () => {
    const { text } = renderOperatorEvent(ev('rate-limited', `Rate limited · ${RAW_BYTES}`))
    assertNoRawBytes(text)
    expect(text).toContain('Rate limited')
  })

  it('strips raw bytes from an unknown-4xx detail', () => {
    const { text } = renderOperatorEvent(ev('unknown-4xx', `API Error: 400 bad · ${RAW_BYTES}`))
    assertNoRawBytes(text)
  })

  it('leaves a clean detail intact', () => {
    const { text } = renderOperatorEvent(ev('credentials-expired', 'token expired 2026-04-01'))
    expect(text).toContain('token expired 2026-04-01')
  })
})

// ─── request_id survives the 1000-char bridge truncation (MEDIUM) ─────────────

describe('truncateDetailPreservingRequestId — exact dedup key survives truncation', () => {
  beforeEach(() => errorPresenceGate.reset())

  // A realistic long Anthropic rate-limit body whose request_id sits PAST char
  // 1000 (the bridge's OPERATOR_EVENT_DETAIL_MAX). `filler` pads the human part.
  function longRateLimitLine(requestId: string): string {
    const filler = 'Server is temporarily limiting requests (not your usage limit). '.repeat(30)
    return `${filler} b'{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"},"request_id":"${requestId}"}'`
  }

  it('preserves the request_id that a naive slice(0,1000) would drop', () => {
    const line = longRateLimitLine('req_deadbeef01')
    expect(line.length).toBeGreaterThan(1000)
    // A naive slice loses the trailing id...
    expect(extractRequestId(line.slice(0, 1000))).toBeUndefined()
    // ...but the preserving truncation keeps it, within budget.
    const truncated = truncateDetailPreservingRequestId(line, 1000)
    expect(truncated.length).toBeLessThanOrEqual(1000)
    expect(extractRequestId(truncated)).toBe('req_deadbeef01')
  })

  it('two DISTINCT request_ids past char 1000 render TWO messages (exact key still fires)', () => {
    const now = 9_000_000
    const messages: string[] = []
    for (const rid of ['req_aaaaaaaa', 'req_bbbbbbbb']) {
      // Simulate the bridge hop: truncate-preserving, THEN parse gateway-side.
      const detail = truncateDetailPreservingRequestId(longRateLimitLine(rid), 1000)
      const parsed = parseLlmError(detail)
      expect(parsed.requestId).toBe(rid) // exact key preserved, not coarse fallback
      if (decideErrorSurface(parsed, 'gymbro', { claim: true, now }) === 'render') {
        messages.push(renderLlmError(parsed, 'gymbro', 'UTC', new Date(now)).text)
      }
    }
    // Pre-fix (id truncated away) both fall to the SAME `${kind}:${agent}:${bucket}`
    // key and collapse to ONE. With the id preserved, the exact keys differ → TWO.
    expect(messages).toHaveLength(2)
  })
})
