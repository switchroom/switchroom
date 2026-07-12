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
  decideThrottleTier,
  evaluateThrottleNotice,
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
