import { describe, it, expect, beforeEach } from 'vitest'
import {
  reset,
  noteOutbound,
  getOutboundMetrics,
  clear,
  __resetAllForTests,
} from '../turn-signal-tracker.js'

/**
 * switchroom#1892-follow-up — regression guard for the post-fallback
 * outbound under-count.
 *
 * Scenario reproduced from clerk's 2026-05-27 wedge:
 *   1. Turn starts (signalTracker.reset)
 *   2. Model goes silent for 300s — silence-poke ladder fires, then
 *      framework_fallback fires + emits turn_ended with outbound_count=0
 *   3. Model recovers — sends 2 late reply tool calls → executeReply
 *      calls signalTracker.noteOutbound
 *   4. Canonical silent-marker turn-end path runs → reads metrics
 *      again → emits final turn_ended
 *
 * Pre-fix (b6cd7e5...): framework_fallback called signalTracker.clear
 * after emitting its turn_ended. Late noteOutbound calls hit cleared
 * state and no-op. Silent-marker path re-read the empty default and
 * reported outbound_count=0 again — late replies invisible to KPIs.
 *
 * Post-fix: framework_fallback no longer clears; only the canonical
 * paths do. Late replies accumulate; the canonical turn_ended carries
 * the correct count.
 */
beforeEach(() => {
  __resetAllForTests()
})

describe('signal-tracker survives framework-fallback for late-reply accounting (#1892)', () => {
  it('late noteOutbound after fallback (without clear) increments outbound_count', () => {
    const key = 'chat:thread'
    const turnStart = 1_000_000
    reset(key, turnStart)

    // Simulate framework_fallback at +300s — emits turn_ended with
    // outbound_count=0 but DOES NOT clear (the fix).
    const beforeFallback = getOutboundMetrics(key)
    expect(beforeFallback.outboundCount).toBe(0)
    expect(beforeFallback.ttfoMs).toBeNull()

    // Model recovers post-fallback and sends two late replies.
    noteOutbound(key, turnStart + 312_000) // first late reply at +312s
    noteOutbound(key, turnStart + 358_000) // second late reply at +358s

    // Canonical silent-marker turn-end reads metrics again and clears.
    const afterRecovery = getOutboundMetrics(key)
    expect(afterRecovery.outboundCount).toBe(2)
    expect(afterRecovery.ttfoMs).toBe(312_000)

    clear(key)
    expect(getOutboundMetrics(key).outboundCount).toBe(0)
  })

  it('regression guard: clearing state mid-turn would silently lose late outbounds', () => {
    // The buggy pre-fix sequence — kept here as the inverse case so a
    // future change that re-introduces clear-at-fallback fails this
    // test loudly with the late-reply count going to zero.
    const key = 'chat:thread'
    reset(key, 1_000_000)
    clear(key) // simulates the pre-fix framework_fallback clear

    noteOutbound(key, 1_000_312_000) // late reply after the bogus clear
    noteOutbound(key, 1_000_358_000)

    const metrics = getOutboundMetrics(key)
    // This is the pre-fix bug: late replies are invisible because
    // noteOutbound is a no-op when state is missing.
    expect(metrics.outboundCount).toBe(0)
    expect(metrics.ttfoMs).toBeNull()
  })
})
