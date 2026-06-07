/**
 * Unit tests for the shared exhaustion-`until` decision (exhaust-until.ts) and
 * the 429-path composition it sits in.
 *
 * The load-bearing invariant (vision.md pillar 3 + the #2218 weekly-wall
 * rollback): the value handed to markExhausted is NEVER undefined, so a weekly
 * wall can never fall back to the broker's ~5h default and un-exhaust early.
 *
 * The 429-path composition test runs the REAL detectModelUnavailable
 * (model-unavailable.ts) into the REAL resolveExhaustUntil — proving the gateway
 * 429 branch (`resolveExhaustUntil(modelUnavailable.resetAt?.getTime())`) threads
 * a finite `until` for both the rolling and the unparseable-weekly wordings.
 */

import { describe, it, expect } from 'vitest'
import { resolveExhaustUntil, EXHAUST_WEEKLY_FLOOR_MS } from '../gateway/exhaust-until.js'
import { detectModelUnavailable } from '../model-unavailable.js'

const NOW = Date.UTC(2026, 5, 7, 0, 0, 0) // 2026-06-07

describe('resolveExhaustUntil', () => {
  it('passes through a finite reset in the future', () => {
    const reset = NOW + 2 * 60 * 60 * 1000 // +2h (a rolling window)
    expect(resolveExhaustUntil(reset, NOW)).toBe(reset)
  })

  it('undefined → +7d floor (the WEEKLY-wall case), never undefined', () => {
    const until = resolveExhaustUntil(undefined, NOW)
    expect(until).toBe(NOW + EXHAUST_WEEKLY_FLOOR_MS)
    expect(until).toBeGreaterThan(NOW + 5 * 60 * 60 * 1000) // past the ~5h default
  })

  it('a past / now / NaN / non-finite reset → +7d floor (treated as unparsed)', () => {
    expect(resolveExhaustUntil(NOW - 1, NOW)).toBe(NOW + EXHAUST_WEEKLY_FLOOR_MS)
    expect(resolveExhaustUntil(NOW, NOW)).toBe(NOW + EXHAUST_WEEKLY_FLOOR_MS)
    expect(resolveExhaustUntil(Number.NaN, NOW)).toBe(NOW + EXHAUST_WEEKLY_FLOOR_MS)
    expect(resolveExhaustUntil(Number.POSITIVE_INFINITY, NOW)).toBe(NOW + EXHAUST_WEEKLY_FLOOR_MS)
  })

  it('the floor is comfortably longer than the broker ~5h mark-exhausted default', () => {
    expect(EXHAUST_WEEKLY_FLOOR_MS).toBeGreaterThan(5 * 60 * 60 * 1000)
    expect(EXHAUST_WEEKLY_FLOOR_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('429-path composition: detectModelUnavailable → resolveExhaustUntil', () => {
  // This mirrors gateway.ts's 429 branch:
  //   const untilMs = resolveExhaustUntil(modelUnavailable.resetAt?.getTime())
  // NB: parseResetTime anchors RELATIVE wordings ("in 2h", "retry after Ns") at
  // the real Date.now() — not injectable through detectModelUnavailable — so the
  // rolling-window assertions check the SHAPE (finite, future, well below the
  // +7d floor, no longer than the stated window), never an exact epoch.
  function untilFor(stderr: string): { u: number; before: number } {
    const before = Date.now()
    const d = detectModelUnavailable(stderr)
    expect(d).not.toBeNull()
    return { u: resolveExhaustUntil(d?.resetAt?.getTime(), before), before }
  }

  it('ROLLING wording ("resets in 2h 15m") → a finite ~2h until, NOT the +7d floor', () => {
    const { u, before } = untilFor('usage limit reached · resets in 2h 15m')
    expect(Number.isFinite(u)).toBe(true)
    expect(u).toBeGreaterThan(before)
    const window = (2 * 60 + 15) * 60 * 1000
    expect(u).toBeLessThanOrEqual(before + window + 2000) // ~2h15m, allow detect/resolve skew
    expect(u).toBeLessThan(before + EXHAUST_WEEKLY_FLOOR_MS / 2) // unmistakably NOT the floor
  })

  it('ROLLING wording ("retry after 60 seconds") → a finite ~60s until, NOT the +7d floor', () => {
    const { u, before } = untilFor('rate_limit_error: retry after 60 seconds — usage limit')
    expect(u).toBeGreaterThan(before)
    expect(u).toBeLessThanOrEqual(before + 60 * 1000 + 2000)
    expect(u).toBeLessThan(before + EXHAUST_WEEKLY_FLOOR_MS / 2)
  })

  it("WEEKLY wording (\"resets Jun 9, 5am (tz)\") is UNPARSEABLE on the 429 path → +7d floor, NOT undefined/5h", () => {
    // parseResetTime can't read the calendar weekly wording — Invalid Date →
    // resetAt undefined. resolveExhaustUntil MUST floor it to +7d, otherwise
    // markExhausted's ~5h default re-wedges the weekly-walled account.
    const d = detectModelUnavailable("You've hit your limit · resets Jun 9, 5am (Australia/Melbourne)")
    expect(d?.kind).toBe('quota_exhausted')
    expect(d?.resetAt).toBeUndefined() // pins the parser-blind-spot premise
    const u = resolveExhaustUntil(d?.resetAt?.getTime(), NOW)
    expect(u).toBe(NOW + EXHAUST_WEEKLY_FLOOR_MS)
  })
})
