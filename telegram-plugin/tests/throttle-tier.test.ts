/**
 * Unit tests for telegram-plugin/throttle-tier.ts — the 429 throttle tier.
 *
 * Pins the operator-approved decision matrix ("retry in place under 5 min,
 * else mark + failover, honest reset messaging"):
 *   - transient wording + reset ≤ threshold  → throttle (stay put)
 *   - transient wording + reset > threshold  → failover (escalate)
 *   - transient wording + unparseable reset  → throttle, now+60s default
 *   - non-transient (wall) wording           → none (caller's existing path)
 * plus the per-account notice cooldown and the notice text itself.
 */

import { describe, it, expect } from 'vitest'
import {
  build429ClassifiedMetric,
  classify429Detail,
  decideThrottleTier,
  evaluateThrottleNotice,
  isAccountScopedThrottle,
  renderThrottleEscalationNotice,
  renderThrottleNotice,
  throttleRetryInPlaceMaxMs,
  THROTTLE_DEFAULT_WAIT_MS,
  THROTTLE_NOTICE_COOLDOWN_MS,
  THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT,
  type ThrottleNoticeState,
} from '../throttle-tier.js'
import { formatModelUnavailableCard, parseResetTime } from '../model-unavailable.js'

const NOW = Date.UTC(2026, 6, 12, 8, 0, 0) // 2026-07-12T08:00:00Z
const THRESHOLD = THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT // 5 min

// The canonical transient-negation wording (Anthropic burst-429 shape).
const TRANSIENT = (suffix: string): string =>
  `This request would exceed your account's rate limit (not your usage limit). ${suffix}`

describe('decideThrottleTier — decision matrix', () => {
  it('transient wording + reset within threshold → throttle at the parsed reset', () => {
    const d = decideThrottleTier({
      detail: TRANSIENT('Please retry after 90 seconds.'),
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({
      action: 'throttle',
      throttledUntilMs: NOW + 90_000,
      resetParsed: true,
    })
  })

  it('transient wording + "resets in 3m" → throttle (≤ 5 min)', () => {
    const d = decideThrottleTier({
      detail: TRANSIENT('resets in 3m'),
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({
      action: 'throttle',
      throttledUntilMs: NOW + 3 * 60_000,
      resetParsed: true,
    })
  })

  it('transient wording + reset beyond threshold → failover with the parsed reset', () => {
    const d = decideThrottleTier({
      detail: TRANSIENT('resets in 2h 15m'),
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({
      action: 'failover',
      resetAtMs: NOW + (2 * 60 + 15) * 60_000,
    })
  })

  it('transient wording + NO parseable reset → throttle for the 60s default', () => {
    const d = decideThrottleTier({
      detail: TRANSIENT('try again later.'),
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({
      action: 'throttle',
      throttledUntilMs: NOW + THROTTLE_DEFAULT_WAIT_MS,
      resetParsed: false,
    })
  })

  it('transient wording + reset in the PAST → throttle for the 60s default', () => {
    const past = new Date(NOW - 60_000).toISOString()
    const d = decideThrottleTier({
      detail: TRANSIENT(`resets ${past}`),
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({
      action: 'throttle',
      throttledUntilMs: NOW + THROTTLE_DEFAULT_WAIT_MS,
      resetParsed: false,
    })
  })

  it('genuine wall wording (no transient negation) → none (existing quota path owns it)', () => {
    const d = decideThrottleTier({
      detail: "You've hit your limit · resets 8:50am (Australia/Melbourne)",
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({ action: 'none' })
  })

  it('SERVER-side transient wording (529 shape) → none — never account-throttled', () => {
    // This carries the transient NEGATION ("not your usage limit") but does
    // NOT affirm the account's own rate limit — it is a server-wide
    // condition; an account-scoped throttle + restart nudge would be the
    // wrong action. It stays on the existing calm rate-limited path.
    const d = decideThrottleTier({
      detail: 'Server is temporarily limiting requests (not your usage limit). retry after 60 seconds',
      now: NOW,
      thresholdMs: THRESHOLD,
    })
    expect(d).toEqual({ action: 'none' })
  })

  it('honours a custom threshold (boundary: exactly at threshold stays in place)', () => {
    const atThreshold = decideThrottleTier({
      detail: TRANSIENT('retry after 300 seconds'),
      now: NOW,
      thresholdMs: 5 * 60_000,
    })
    expect(atThreshold.action).toBe('throttle')
    const beyond = decideThrottleTier({
      detail: TRANSIENT('retry after 301 seconds'),
      now: NOW,
      thresholdMs: 5 * 60_000,
    })
    expect(beyond.action).toBe('failover')
  })
})

// Verbatim LiteLLM proxy-local 429 shapes (provenance on
// `litellmProxyLocal429Signals`, model-unavailable.ts).
const LITELLM_TPM_CAP =
  'Deployment over user-defined ratelimit. tpm limit=8000. current usage=8241. ' +
  'id=abc123def, model_group=claude-fable-5'
const LITELLM_KEY_LIMIT =
  'Rate limit exceeded for api_key: hashed-key-1a2b3c. Limit type: tokens. ' +
  'Current limit: 8000, Remaining: 0. Limit resets at: 2026-07-12 08:05:00 UTC'
const LITELLM_ROUTER_COOLDOWN =
  'No deployments available for selected model, Try again in 27.5 seconds. ' +
  "Passed model=claude-fable-5. pre-call-checks=False, cooldown_list=['abc123def']"
// v3 limiter, descriptor NOT in the enumerated signal list — matched by the
// litellmV3LimiterSignalPair co-occurrence rule (model-unavailable.ts).
const LITELLM_TEAM_MODEL_LIMIT =
  'Rate limit exceeded for model_per_team: team-1a2b3c:claude-fable-5. ' +
  'Limit type: tokens. Current limit: 50000, Remaining: 0. ' +
  'Limit resets at: 2026-07-12 08:05:00 UTC'

describe('decideThrottleTier — LiteLLM-proxy-local 429s never enter the tier', () => {
  // OUTCOME pin: `none` is what keeps a proxy-local cap trip off the
  // account-scoped machinery — no broker mark-throttled, no throttle-tier
  // runner fire, no failover escalation. The gateway additionally gates on
  // classify429Detail, but the decision module must agree.
  it.each([
    ['deployment tpm cap', LITELLM_TPM_CAP],
    ['virtual-key tpm_limit', LITELLM_KEY_LIMIT],
    ['router cooldown', LITELLM_ROUTER_COOLDOWN],
    ['team model cap (non-enumerated v3 descriptor)', LITELLM_TEAM_MODEL_LIMIT],
  ])('%s → none (calm path owns it)', (_name, detail) => {
    expect(decideThrottleTier({ detail, now: NOW, thresholdMs: THRESHOLD })).toEqual({
      action: 'none',
    })
  })
})

describe('classify429Detail — three-way origin classification', () => {
  it('classifies LiteLLM limiter wordings as litellm-local', () => {
    expect(classify429Detail(LITELLM_TPM_CAP)).toBe('litellm-local')
    expect(classify429Detail(LITELLM_KEY_LIMIT)).toBe('litellm-local')
    expect(classify429Detail(LITELLM_ROUTER_COOLDOWN)).toBe('litellm-local')
    // Non-enumerated v3 descriptor — the co-occurrence pair, not a list
    // entry, carries this one.
    expect(classify429Detail(LITELLM_TEAM_MODEL_LIMIT)).toBe('litellm-local')
  })

  it('classifies Anthropic account-affirming wording as account-scoped', () => {
    expect(classify429Detail(TRANSIENT('resets in 3m'))).toBe('account-scoped')
    expect(
      classify429Detail('would exceed your account’s rate limit'),
    ).toBe('account-scoped')
  })

  it('classifies server-side / bare rate-limit wording as generic-transient', () => {
    expect(
      classify429Detail('Server is temporarily limiting requests (not your usage limit)'),
    ).toBe('generic-transient')
    expect(classify429Detail('overloaded_error 529')).toBe('generic-transient')
    expect(classify429Detail('rate_limit_error: try again later')).toBe('generic-transient')
  })

  it('TIE-BREAK: account-affirming wording wins over LiteLLM wording when both appear', () => {
    // The pass-through shape: LiteLLM wraps a FORWARDED upstream Anthropic
    // account 429 (exception mapping / limiter prose in the same body).
    // LiteLLM never emits the account wording itself, so its presence means
    // Anthropic really throttled the account — the broker throttle mark and
    // the throttle tier must still run.
    const mixed =
      `litellm.RateLimitError: ${LITELLM_TPM_CAP} — upstream said: ` +
      "This request would exceed your account's rate limit. Please try again later."
    expect(classify429Detail(mixed)).toBe('account-scoped')
    // And the tier decision still engages (not 'none').
    expect(
      decideThrottleTier({ detail: mixed, now: NOW, thresholdMs: THRESHOLD }).action,
    ).not.toBe('none')
  })

  it('a bare litellm.RateLimitError wrapper WITHOUT limiter wording stays generic-transient', () => {
    // The exception-mapping prefix alone is not proxy-local evidence.
    expect(
      classify429Detail('litellm.RateLimitError: RateLimitError: 429 try again later'),
    ).toBe('generic-transient')
  })

  it('never throws on weird input', () => {
    expect(classify429Detail('')).toBe('generic-transient')
    expect(classify429Detail(undefined as unknown as string)).toBe('generic-transient')
    expect(classify429Detail(9000 as unknown as string)).toBe('generic-transient')
    expect(classify429Detail('A'.repeat(200_000))).toBe('generic-transient')
  })
})

describe('build429ClassifiedMetric — instrumentation payload', () => {
  it('litellm-local deployment cap → limit fields + calm action', () => {
    const m = build429ClassifiedMetric({
      agent: 'carrie',
      detail: LITELLM_TPM_CAP,
      classification: 'litellm-local',
      action: 'calm',
      now: NOW,
    })
    expect(m).toEqual({
      kind: 'rate_limit_429_classified',
      agent: 'carrie',
      classification: 'litellm-local',
      action: 'calm',
      reset_at_ms: null,
      reset_in_ms: null,
      limit_type: 'tpm',
      limit: 8000,
      current_usage: 8241,
    })
  })

  it('litellm-local NON-enumerated v3 descriptor (model_per_team) → full metric payload', () => {
    // Finding-pin: a team-level model cap must produce the metric (it used
    // to miss every signal → quota-exhausted → no metric at all).
    const m = build429ClassifiedMetric({
      agent: 'carrie',
      detail: LITELLM_TEAM_MODEL_LIMIT,
      classification: 'litellm-local',
      action: 'calm',
      now: NOW,
    })
    expect(m.kind).toBe('rate_limit_429_classified')
    expect(m.classification).toBe('litellm-local')
    expect(m.limit_type).toBe('tokens')
    expect(m.limit).toBe(50_000)
    expect(m.reset_at_ms).toBe(Date.UTC(2026, 6, 12, 8, 5, 0))
  })

  it('litellm-local v3 key limit → tokens limit type + parsed "Limit resets at" UTC reset', () => {
    const m = build429ClassifiedMetric({
      agent: 'carrie',
      detail: LITELLM_KEY_LIMIT,
      classification: 'litellm-local',
      action: 'calm',
      now: NOW,
    })
    expect(m.limit_type).toBe('tokens')
    expect(m.limit).toBe(8000)
    expect(m.reset_at_ms).toBe(Date.UTC(2026, 6, 12, 8, 5, 0))
    expect(m.reset_in_ms).toBe(Date.UTC(2026, 6, 12, 8, 5, 0) - NOW)
  })

  it('account-scoped 429 → Anthropic-parsed reset, no limit fields', () => {
    const m = build429ClassifiedMetric({
      agent: 'carrie',
      detail: TRANSIENT('resets in 3m'),
      classification: 'account-scoped',
      action: 'throttle',
      now: NOW,
    })
    expect(m.classification).toBe('account-scoped')
    expect(m.action).toBe('throttle')
    expect(m.reset_at_ms).toBe(NOW + 3 * 60_000)
    expect(m.reset_in_ms).toBe(3 * 60_000)
    expect(m.limit_type).toBeNull()
    expect(m.limit).toBeNull()
    expect(m.current_usage).toBeNull()
  })

  it('never throws on weird detail; nulls out unparseable resets', () => {
    const m = build429ClassifiedMetric({
      agent: 'carrie',
      detail: undefined as unknown as string,
      classification: 'generic-transient',
      action: 'calm',
      now: NOW,
    })
    expect(m.reset_at_ms).toBeNull()
    expect(m.reset_in_ms).toBeNull()
  })
})

describe('isAccountScopedThrottle — the tier gate', () => {
  it("matches account-affirming wording (both apostrophe variants + 'not your account')", () => {
    expect(isAccountScopedThrottle("would exceed your account's rate limit")).toBe(true)
    expect(isAccountScopedThrottle('would exceed your account’s rate limit')).toBe(true)
    expect(isAccountScopedThrottle("this is not your account's limit")).toBe(true)
  })

  it('rejects server-side transient / 529 wordings and walls', () => {
    expect(isAccountScopedThrottle('Server is temporarily limiting requests (not your usage limit)')).toBe(false)
    expect(isAccountScopedThrottle('temporarily rate limited, overloaded_error 529')).toBe(false)
    expect(isAccountScopedThrottle("You've hit your limit · resets 8:50am")).toBe(false)
    expect(isAccountScopedThrottle('')).toBe(false)
  })
})

describe('throttleRetryInPlaceMaxMs — env resolution', () => {
  it('defaults to 5 minutes', () => {
    expect(throttleRetryInPlaceMaxMs({})).toBe(5 * 60_000)
  })

  it('reads SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS', () => {
    expect(
      throttleRetryInPlaceMaxMs({ SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS: '120000' }),
    ).toBe(120_000)
  })

  it('falls back to the default on junk / non-positive values', () => {
    expect(
      throttleRetryInPlaceMaxMs({ SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS: 'soon' }),
    ).toBe(THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT)
    expect(
      throttleRetryInPlaceMaxMs({ SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS: '-5' }),
    ).toBe(THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT)
  })
})

describe('evaluateThrottleNotice — per-account cooldown', () => {
  it('sends the first notice and suppresses a repeat inside the window', () => {
    let state: ThrottleNoticeState = { lastSentAtMsByAccount: {} }
    const first = evaluateThrottleNotice(state, 'acct-a', NOW)
    expect(first.send).toBe(true)
    state = first.next
    const repeat = evaluateThrottleNotice(state, 'acct-a', NOW + 60_000)
    expect(repeat.send).toBe(false)
  })

  it('a DIFFERENT account is not suppressed by the first account\'s window', () => {
    const first = evaluateThrottleNotice({ lastSentAtMsByAccount: {} }, 'acct-a', NOW)
    const other = evaluateThrottleNotice(first.next, 'acct-b', NOW + 1)
    expect(other.send).toBe(true)
  })

  it('sends again once the cooldown window has elapsed', () => {
    const first = evaluateThrottleNotice({ lastSentAtMsByAccount: {} }, 'acct-a', NOW)
    const later = evaluateThrottleNotice(
      first.next,
      'acct-a',
      NOW + THROTTLE_NOTICE_COOLDOWN_MS,
    )
    expect(later.send).toBe(true)
  })
})

describe('renderThrottleNotice — honest reset messaging', () => {
  it('names the account, the agent, the reset, and that it is NOT a quota wall', () => {
    const text = renderThrottleNotice({
      account: 'alice',
      agent: 'carrie',
      throttledUntilMs: NOW + 3 * 60_000,
      resetParsed: true,
      now: new Date(NOW),
    })
    expect(text).toContain('alice')
    expect(text).toContain('carrie')
    expect(text).toContain('resets in 3m')
    expect(text).toContain('not a quota wall')
    expect(text).toContain('Staying on')
    expect(text).toContain('no failover')
  })

  it('degrades honestly when the account is unknown (broker unreachable)', () => {
    const text = renderThrottleNotice({
      account: null,
      agent: 'carrie',
      throttledUntilMs: NOW + THROTTLE_DEFAULT_WAIT_MS,
      resetParsed: false,
      now: new Date(NOW),
    })
    expect(text).toContain('the active account')
    expect(text).toContain('retrying in ~60s')
  })
})

describe('renderThrottleEscalationNotice — corroborated-wall announcement', () => {
  it('names the account, the trigger agent, and the roll target', () => {
    const text = renderThrottleEscalationNotice({
      account: 'alice',
      agent: 'carrie',
      rolledTo: 'bob',
    })
    expect(text).toContain('alice')
    expect(text).toContain('carrie')
    expect(text).toContain('bob')
    expect(text).toContain('actually a wall')
  })

  it('renders the all-blocked variant when no fallback had quota', () => {
    const text = renderThrottleEscalationNotice({
      account: 'alice',
      agent: 'carrie',
      rolledTo: null,
    })
    expect(text).toContain('all blocked')
    expect(text).toContain('/auth add')
  })

  it('strict-pinned caller: null rolledTo renders the riding-it-out variant, NOT all-blocked', () => {
    // A strict pin (agents.<name>.auth.strict) deliberately does not roll —
    // the broker reports caller_pinned_strict so this null is not misread as
    // a fleet-wide exhaustion while the fleet is healthy.
    const text = renderThrottleEscalationNotice({
      account: 'work',
      agent: 'workbot',
      rolledTo: null,
      callerPinnedStrict: true,
    })
    expect(text).toContain('strictly pinned')
    expect(text).toContain('fleet is unaffected')
    expect(text).not.toContain('all blocked')
    expect(text).not.toContain('/auth add')
  })
})

describe('rate_limited escalation card wording (model-unavailable integration)', () => {
  it('formatModelUnavailableCard names the rate limit, not quota exhaustion', () => {
    const card = formatModelUnavailableCard(
      { kind: 'rate_limited', resetAt: new Date(NOW + 30 * 60_000), raw: 'x' },
      'carrie',
      { now: new Date(NOW), autoFallbackInFlight: true },
    )
    expect(card).toContain('account rate-limited')
    expect(card).toContain('resets in 30m')
    expect(card).not.toContain('quota exhausted')
  })
})

describe('parseResetTime (exported for the throttle tier)', () => {
  it('parses "retry after N seconds" relative to the injected clock', () => {
    const d = parseResetTime('retry after 45 seconds', new Date(NOW))
    expect(d?.getTime()).toBe(NOW + 45_000)
  })

  it('returns undefined for prose with no reset hint', () => {
    expect(parseResetTime('temporarily limiting requests', new Date(NOW))).toBeUndefined()
  })
})
