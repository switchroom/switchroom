/**
 * Unit tests for telegram-plugin/model-unavailable.ts.
 *
 * Covers the three load-bearing surfaces of issue #394 Fix 2:
 *   - detectModelUnavailable correctly classifies the common stderr
 *     shapes Anthropic / Claude Code emit when the model is down
 *   - the resetAt parser handles the Anthropic-style "resets …" hints
 *     and ISO timestamps without choking on weird input
 *   - formatModelUnavailableCard renders a stable HTML card naming
 *     the three actionable commands (/authfallback, /auth add, /usage)
 */

import { describe, it, expect } from 'vitest'
import {
  detectModelUnavailable,
  formatModelUnavailableCard,
  resolveModelUnavailableFromOperatorEvent,
  type ModelUnavailableDetection,
} from '../model-unavailable.js'

// ─── detectModelUnavailable ──────────────────────────────────────────────────

describe('detectModelUnavailable — quota / billing strings', () => {
  it("classifies Anthropic's 'You're out of extra usage' message", () => {
    const d = detectModelUnavailable("You're out of extra usage · resets May 3, 11am")
    expect(d?.kind).toBe('quota_exhausted')
  })

  it('classifies credit_balance_too_low SDK error', () => {
    const d = detectModelUnavailable(
      JSON.stringify({ type: 'credit_balance_too_low', message: 'Your credit balance is too low' }),
    )
    expect(d?.kind).toBe('quota_exhausted')
  })

  it('classifies "usage limit" plain-text errors', () => {
    expect(detectModelUnavailable('Reached usage limit for the 5h window')?.kind).toBe(
      'quota_exhausted',
    )
  })

  it('classifies "quota exhausted" verbatim', () => {
    expect(detectModelUnavailable('quota exhausted on slot main')?.kind).toBe('quota_exhausted')
  })
})

describe('detectModelUnavailable — overload / 429 / 5xx strings', () => {
  it('classifies overloaded_error JSON', () => {
    const d = detectModelUnavailable(
      JSON.stringify({ type: 'overloaded_error', message: 'Overloaded' }),
    )
    expect(d?.kind).toBe('overload')
  })

  it('classifies a bare HTTP 429 line', () => {
    expect(detectModelUnavailable('HTTP 429 Too Many Requests')?.kind).toBe('overload')
  })

  it('classifies rate_limit_error', () => {
    expect(detectModelUnavailable('rate_limit_error: too many requests')?.kind).toBe('overload')
  })

  it('classifies HTTP 503 Service Unavailable', () => {
    expect(detectModelUnavailable('upstream returned 503 Service Unavailable')?.kind).toBe(
      'overload',
    )
  })
})

describe('detectModelUnavailable — network failures', () => {
  it('classifies ECONNREFUSED', () => {
    expect(detectModelUnavailable('connect ECONNREFUSED 1.2.3.4:443')?.kind).toBe('network')
  })

  it('classifies ETIMEDOUT', () => {
    expect(detectModelUnavailable('Error: ETIMEDOUT api.anthropic.com:443')?.kind).toBe('network')
  })

  it('classifies "fetch failed"', () => {
    expect(detectModelUnavailable('TypeError: fetch failed')?.kind).toBe('network')
  })

  it('classifies DNS getaddrinfo failures', () => {
    expect(detectModelUnavailable('getaddrinfo EAI_AGAIN api.anthropic.com')?.kind).toBe('network')
  })
})

describe('detectModelUnavailable — non-matches', () => {
  it('returns null for empty / non-string input', () => {
    expect(detectModelUnavailable('')).toBeNull()
    expect(detectModelUnavailable(undefined as unknown as string)).toBeNull()
  })

  it('returns null for routine assistant chatter', () => {
    expect(detectModelUnavailable('OK, I will read the file now.')).toBeNull()
  })

  it('returns null for unrelated errors (auth, malformed JSON)', () => {
    expect(detectModelUnavailable('authentication_error: invalid bearer token')).toBeNull()
  })

  it('truncates pathologically long input rather than scanning it all', () => {
    // 100KB of "A" then a quota signal — detector samples the first 16KB so
    // this should NOT match. Confirms the slice guard fires.
    const huge = 'A'.repeat(100_000) + ' out of extra usage'
    expect(detectModelUnavailable(huge)).toBeNull()
  })
})

describe('detectModelUnavailable — reset-time extraction', () => {
  it('parses "retry after 60 seconds" relative to now', () => {
    const d = detectModelUnavailable('429 rate_limit_error. Retry after 60 seconds.')
    expect(d?.kind).toBe('overload')
    expect(d?.resetAt).toBeInstanceOf(Date)
  })

  it('parses "resets in 2h 15m" relative to now', () => {
    const d = detectModelUnavailable("You're out of extra usage. Resets in 2h 15m")
    expect(d?.kind).toBe('quota_exhausted')
    expect(d?.resetAt).toBeInstanceOf(Date)
    // Should be within the next 3 hours
    const deltaMs = (d?.resetAt as Date).getTime() - Date.now()
    expect(deltaMs).toBeGreaterThan(60 * 60_000)
    expect(deltaMs).toBeLessThan(3 * 60 * 60_000)
  })

  it('parses bare ISO-8601 timestamps embedded in the string', () => {
    const d = detectModelUnavailable('quota exhausted, retry at 2026-05-03T11:00:00Z')
    expect(d?.resetAt?.toISOString()).toBe('2026-05-03T11:00:00.000Z')
  })

  it('omits resetAt when nothing parseable is present', () => {
    const d = detectModelUnavailable("You're out of extra usage")
    expect(d?.kind).toBe('quota_exhausted')
    expect(d?.resetAt).toBeUndefined()
  })

  it('network failures never carry a resetAt', () => {
    const d = detectModelUnavailable('ECONNREFUSED — retry after 60 seconds')
    expect(d?.kind).toBe('network')
    expect(d?.resetAt).toBeUndefined()
  })
})

// ─── formatModelUnavailableCard ──────────────────────────────────────────────

describe('formatModelUnavailableCard — actionable card', () => {
  const NOW = new Date('2026-05-03T08:00:00Z')

  function detection(
    kind: 'overload' | 'quota_exhausted' | 'network',
    resetAt?: Date,
  ): ModelUnavailableDetection {
    return resetAt ? { kind, resetAt, raw: 'test' } : { kind, raw: 'test' }
  }

  it('quota_exhausted with reset → snapshot-stable card', () => {
    const card = formatModelUnavailableCard(
      detection('quota_exhausted', new Date('2026-05-03T13:00:00Z')),
      'gymbro',
      { now: NOW },
    )
    expect(card).toMatchInlineSnapshot(`
      "⚠️ <b>Model unavailable</b> on agent <b>gymbro</b>
      Reason: quota exhausted (resets in 5h)

      <b>What to try</b>
      • <code>/authfallback</code> — switch to the next account slot
      • <code>/auth add</code> — attach another subscription
      • <code>/usage</code> — show quota breakdown"
    `)
  })

  it('overload without reset omits the parenthetical', () => {
    const card = formatModelUnavailableCard(detection('overload'), 'clerk', { now: NOW })
    expect(card).toContain('Reason: model overloaded')
    expect(card).not.toContain('(resets')
  })

  it('network never includes a reset window', () => {
    const card = formatModelUnavailableCard(detection('network'), 'clerk', { now: NOW })
    expect(card).toContain('Reason: network unreachable')
    expect(card).not.toContain('(resets')
  })

  it('always includes the three actionable suggestions', () => {
    const card = formatModelUnavailableCard(detection('quota_exhausted'), 'gymbro', { now: NOW })
    expect(card).toContain('<code>/authfallback</code>')
    expect(card).toContain('<code>/auth add</code>')
    expect(card).toContain('<code>/usage</code>')
  })

  it('names the slot in the header when one is supplied', () => {
    const card = formatModelUnavailableCard(detection('quota_exhausted'), 'gymbro', {
      slot: 'pro-1',
      now: NOW,
    })
    expect(card).toContain('slot <b>pro-1</b>')
  })

  it('escapes HTML in agent and slot names', () => {
    const card = formatModelUnavailableCard(detection('overload'), '<evil>', {
      slot: '"injected"',
      now: NOW,
    })
    expect(card).toContain('&lt;evil&gt;')
    expect(card).toContain('&quot;injected&quot;')
    expect(card).not.toContain('<evil>')
  })
})

// ─── resolveModelUnavailableFromOperatorEvent — gateway integration ──────────

describe('resolveModelUnavailableFromOperatorEvent — kind-driven mapping', () => {
  it('always treats kind=quota-exhausted as model-unavailable, even with empty detail', () => {
    const d = resolveModelUnavailableFromOperatorEvent({ kind: 'quota-exhausted', detail: '' })
    expect(d?.kind).toBe('quota_exhausted')
  })

  it('always treats kind=rate-limited as overload', () => {
    const d = resolveModelUnavailableFromOperatorEvent({ kind: 'rate-limited', detail: '' })
    expect(d?.kind).toBe('overload')
  })

  it('always treats kind=unknown-5xx as overload', () => {
    const d = resolveModelUnavailableFromOperatorEvent({
      kind: 'unknown-5xx',
      detail: 'something went wrong upstream',
    })
    expect(d?.kind).toBe('overload')
  })

  it('preserves the parsed reset hint from the detail when one is present', () => {
    const d = resolveModelUnavailableFromOperatorEvent({
      kind: 'quota-exhausted',
      detail: "You're out of extra usage. Resets in 2h",
    })
    expect(d?.resetAt).toBeInstanceOf(Date)
  })
})

describe('resolveModelUnavailableFromOperatorEvent — pattern-driven fallback', () => {
  it('returns null for credentials-expired (auth issue, not model-down)', () => {
    expect(
      resolveModelUnavailableFromOperatorEvent({
        kind: 'credentials-expired',
        detail: 'OAuth token expired',
      }),
    ).toBeNull()
  })

  it('returns null for agent-crashed', () => {
    expect(
      resolveModelUnavailableFromOperatorEvent({
        kind: 'agent-crashed',
        detail: 'Process exit code 1',
      }),
    ).toBeNull()
  })

  it('rescues unknown-4xx when its detail carries a quota signal', () => {
    const d = resolveModelUnavailableFromOperatorEvent({
      kind: 'unknown-4xx',
      detail: "You're out of extra usage",
    })
    expect(d?.kind).toBe('quota_exhausted')
  })
})

// ─── End-to-end: operator-event detail → rendered card text ──────────────────

describe('integration — gateway suppresses raw stderr in favour of the card', () => {
  it("turns 'You're out of extra usage' into the actionable card, not the raw text", () => {
    const rawStderr = "You're out of extra usage · resets May 3, 11am"
    const detected = resolveModelUnavailableFromOperatorEvent({
      kind: 'quota-exhausted',
      detail: rawStderr,
    })
    expect(detected).not.toBeNull()

    const card = formatModelUnavailableCard(detected as ModelUnavailableDetection, 'gymbro')

    // The actionable card replaces the raw verbatim error.
    expect(card).toContain('Model unavailable')
    expect(card).toContain('quota exhausted')
    expect(card).toContain('/authfallback')
    expect(card).toContain('/auth add')
    expect(card).toContain('/usage')

    // And the raw stderr text never appears in the user-facing card.
    expect(card).not.toContain('out of extra usage')
    expect(card).not.toContain('May 3, 11am')
  })

  it('lets non-model events fall through to the default operator-event renderer', () => {
    expect(
      resolveModelUnavailableFromOperatorEvent({
        kind: 'credentials-invalid',
        detail: 'Invalid API key',
      }),
    ).toBeNull()
  })
})
