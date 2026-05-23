/**
 * Unit suite for #1674's over-ping safety net predicate.
 * Pins the decision logic in isolation from the gateway's
 * `executeReply` IO so a future refactor can't silently regress.
 */

import { describe, expect, it } from 'vitest'

import { decideOverPing } from '../over-ping-safety-net.js'

describe('decideOverPing — at-most-one-ping-per-turn safety net', () => {
  it('lets the FIRST ping through and tells caller to claim the slot', () => {
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: null,
      nowMs: 1_000,
    })
    expect(d.suppress).toBe(false)
    expect(d.claimSlot).toBe(true)
    expect(d.sinceFirstPingMs).toBeNull()
  })

  it('SUPPRESSES subsequent ping in the same turn and reports elapsed', () => {
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 1_000,
      nowMs: 4_500,
    })
    expect(d.suppress).toBe(true)
    expect(d.claimSlot).toBe(false)
    expect(d.sinceFirstPingMs).toBe(3_500)
  })

  it('is a no-op when the model already requested silent (regardless of slot state)', () => {
    // No prior ping
    const d1 = decideOverPing({
      modelRequestedPing: false,
      firstPingAt: null,
      nowMs: 1_000,
    })
    expect(d1).toEqual({ suppress: false, claimSlot: false, sinceFirstPingMs: null })

    // Prior ping already landed — silent reply still no-op, NOT claimed
    const d2 = decideOverPing({
      modelRequestedPing: false,
      firstPingAt: 1_000,
      nowMs: 5_000,
    })
    expect(d2).toEqual({ suppress: false, claimSlot: false, sinceFirstPingMs: null })
  })

  it('handles the edge case where firstPingAt equals nowMs (instant double-call)', () => {
    // Same-tick double-fire: the second call comes in with firstPingAt
    // exactly at nowMs. Elapsed is 0; suppress fires.
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 1_000,
      nowMs: 1_000,
    })
    expect(d.suppress).toBe(true)
    expect(d.claimSlot).toBe(false)
    expect(d.sinceFirstPingMs).toBe(0)
  })

  it('reports large elapsed deltas honestly (late wrap-up after long work)', () => {
    // Real-world reproducer pattern: substantive answer pings at +30s,
    // wrap-up "Delivered all three steps…" pings at +36s. The safety
    // net catches the second; sinceFirstPingMs reflects the 6s gap.
    const d = decideOverPing({
      modelRequestedPing: true,
      firstPingAt: 30_000,
      nowMs: 36_000,
    })
    expect(d.suppress).toBe(true)
    expect(d.sinceFirstPingMs).toBe(6_000)
  })

  it('claim-vs-suppress is mutually exclusive', () => {
    // Defensive invariant — no caller path should ever see both flags
    // true at once.
    const cases: Array<{
      modelRequestedPing: boolean
      firstPingAt: number | null
      nowMs: number
    }> = [
      { modelRequestedPing: true, firstPingAt: null, nowMs: 100 },
      { modelRequestedPing: true, firstPingAt: 50, nowMs: 100 },
      { modelRequestedPing: false, firstPingAt: null, nowMs: 100 },
      { modelRequestedPing: false, firstPingAt: 50, nowMs: 100 },
    ]
    for (const c of cases) {
      const d = decideOverPing(c)
      expect(d.suppress && d.claimSlot).toBe(false)
    }
  })
})
