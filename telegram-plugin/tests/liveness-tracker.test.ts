/**
 * liveness-tracker.test.ts — drives the REAL LivenessTracker (the testability
 * seam of the orphaned-reply thinking-pause fix).
 *
 * Root cause being fixed: the orphaned-reply fuse (ORPHANED_REPLY_TIMEOUT_MS =
 * 30 s) was reset ONLY by `tool_label` / `text` events. During a long model
 * reasoning pause the gateway sees NO such events (thinking carries no text),
 * so the fuse ran down and force-ended a genuinely-live turn mid-work.
 *
 * The fix stamps `lastStreamEventAt` on ANY genuine stream event; if a genuine
 * event landed within `windowMs` (default 120 s) the turn is "recently
 * streaming" and the fuse re-arms instead of firing. A genuine multi-minute
 * hang (no events at all) still fires.
 *
 * These tests use the REAL class — no replica helpers.
 *
 * NOTE on onStreamEvent's signature: it is `(kind, durationMs, now)`. The
 * tracker is time-only — it never reads text content (the "Prompt is too long"
 * marker matters to the gateway's context-exhaustion detection, not to the
 * tracker). Where the fix spec wrote `onStreamEvent('text','Prompt is too
 * long',0)` we pass `undefined` as durationMs (it is not a turn_end).
 */

import { describe, it, expect } from 'vitest'
import {
  LivenessTracker,
  ORPHANED_REPLY_STREAM_WINDOW_MS,
  ORPHANED_REPLY_TIMEOUT_MS,
  ORPHANED_REPLY_MAX_REARMS,
} from '../context-exhaustion.js'

const W = ORPHANED_REPLY_STREAM_WINDOW_MS // 120_000
const MAX = ORPHANED_REPLY_MAX_REARMS // 20
const FUSE = ORPHANED_REPLY_TIMEOUT_MS // 30_000

function expiry(
  t: LivenessTracker,
  now: number,
  opts?: { working?: boolean; humanWaiting?: boolean },
) {
  return t.decideOnExpiry({
    working: opts?.working ?? false,
    humanWaiting: opts?.humanWaiting ?? false,
    now,
    windowMs: W,
    maxRearms: MAX,
  })
}

describe('LivenessTracker — pinned constants', () => {
  it('window is 120 s and fuse tick is 30 s', () => {
    expect(W).toBe(120_000)
    expect(FUSE).toBe(30_000)
    expect(MAX).toBe(20)
  })
})

describe('T1 — thinking-pause survival', () => {
  it('text→tool_use→tool_result then a 45s stream gap keeps re-arming (gap < window)', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('text', undefined, 0)
    t.onStreamEvent('tool_use', undefined, 1_000)
    t.onStreamEvent('tool_result', undefined, 2_000)

    // +30s past the last event (t=32s): recently streaming → re-arm.
    const d1 = expiry(t, 32_000)
    expect(d1).toEqual({ rearm: true, countsAgainstCap: true })
    expect(t.orphanedReplyRearmCount).toBe(1)

    // +45s past the last event (t=47s): still within the 120s window → re-arm.
    const d2 = expiry(t, 47_000)
    expect(d2).toEqual({ rearm: true, countsAgainstCap: true })
    expect(t.orphanedReplyRearmCount).toBe(2)
  })

  it('the next genuine stream event ZEROES the rearm counter and re-stamps liveness', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('tool_result', undefined, 2_000)
    expiry(t, 32_000)
    expiry(t, 47_000)
    expect(t.orphanedReplyRearmCount).toBe(2)

    t.onStreamEvent('tool_label', undefined, 48_000)
    expect(t.orphanedReplyRearmCount).toBe(0)
    expect(t.lastStreamEventAt).toBe(48_000)
  })

  it('a synthetic turn_end (durationMs === -1) does NOT stamp or reset (F4 boundary)', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('tool_label', undefined, 48_000)
    expiry(t, 60_000) // counter → 1
    expect(t.orphanedReplyRearmCount).toBe(1)

    t.onStreamEvent('turn_end', -1, 70_000)
    expect(t.lastStreamEventAt).toBe(48_000) // unchanged — synthetic excluded
    expect(t.orphanedReplyRearmCount).toBe(1) // not reset

    // A REAL turn_end (durationMs >= 0) DOES stamp — harmless, the turn is
    // ending anyway (spec #3).
    t.onStreamEvent('turn_end', 0, 71_000)
    expect(t.lastStreamEventAt).toBe(71_000)
    expect(t.orphanedReplyRearmCount).toBe(0)
  })
})

describe('T2 — production repro (48s tool_result, 78s expiry)', () => {
  it('text@0, tool_use@1s, tool_result@48s → expiry@78s re-arms (78-48=30 < 120)', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('text', undefined, 0)
    t.onStreamEvent('tool_use', undefined, 1_000)
    t.onStreamEvent('tool_result', undefined, 48_000)

    const d = expiry(t, 78_000)
    expect(d.rearm).toBe(true)
    expect(t.orphanedReplyRearmCount).toBe(1)

    // tool_label@80s zeroes the counter (progress observed).
    t.onStreamEvent('tool_label', undefined, 80_000)
    expect(t.orphanedReplyRearmCount).toBe(0)
  })
})

describe('T3 — long active turn (A2: counter reset is load-bearing)', () => {
  it('tool_label every 60s + expiry every 60s+30s NEVER fires across 15 min; counter never exceeds 1', () => {
    const t = new LivenessTracker(0)
    for (let k = 0; k < 15; k++) {
      t.onStreamEvent('tool_label', undefined, k * 60_000) // progress → reset
      const d = expiry(t, k * 60_000 + 30_000, { working: true })
      expect(d.rearm).toBe(true) // never fires
      expect(t.orphanedReplyRearmCount).toBeLessThanOrEqual(1)
    }
  })

  it('WITHOUT the progress reset the SAME cadence hits cap=20 near t=600s (proves reset load-bearing)', () => {
    const t = new LivenessTracker(0)
    let firedAt = -1
    for (let k = 1; k <= 25; k++) {
      const now = k * 30_000
      // working:true so it would re-arm indefinitely IF the counter didn't
      // accumulate — but with no onStreamEvent reset it climbs to the cap.
      const d = expiry(t, now, { working: true })
      if (!d.rearm) {
        firedAt = now
        break
      }
    }
    // 20th re-arm lands at t=600s; the 21st expiry (t=630s) fires at the cap.
    expect(t.orphanedReplyRearmCount).toBe(MAX)
    expect(firedAt).toBeGreaterThanOrEqual(600_000)
  })
})

describe('T4 — genuine hang caught (no events at all)', () => {
  it('tool_result@0 then silence: re-arms via recentlyStreaming @30/60/90s, FIRES @120s (window lapsed)', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('tool_result', undefined, 0)

    for (const now of [30_000, 60_000, 90_000]) {
      const d = expiry(t, now) // working:false — kept alive only by recentlyStreaming
      expect(d.rearm).toBe(true)
    }

    // t=120s: now - lastStreamEventAt = 120_000 >= window → not recently
    // streaming, working false → fail-safe FIRE.
    const d = expiry(t, 120_000)
    expect(d).toEqual({ rearm: false, countsAgainstCap: false })
  })
})

describe('T5 — context-exhaustion recovery COMPLETES (not suppressed forever)', () => {
  it('a "Prompt is too long" text event stamps liveness; defensive-guard predicate is true@30s, false@>=120s', () => {
    const t = new LivenessTracker(0)
    // The marker is a genuine `text` event (content is not a tracker concern).
    t.onStreamEvent('text', undefined, 0)

    // Context exhaustion means no tool is in flight: working === false. The
    // defensive-guard suppression predicate is `working || recentlyStreaming`.
    const working = false

    // @30s: recentlyStreaming true → synthetic turn_end is suppressed. This
    // DOCUMENTS the accepted ~30s→~120s recovery-latency growth (F3).
    expect(working || t.recentlyStreaming(30_000, W)).toBe(true)

    // @120s: window lapsed → NOT suppressed → teardown COMPLETES.
    expect(working || t.recentlyStreaming(120_000, W)).toBe(false)

    // @150s: still not suppressed — recovery is delayed, never forever.
    expect(working || t.recentlyStreaming(150_000, W)).toBe(false)
  })
})

describe('T7 — cap semantics', () => {
  it('interleaved expiry/genuine-event: count 1 → 0 → 1 → 2', () => {
    const t = new LivenessTracker(0)

    expect(expiry(t, 10_000).rearm).toBe(true)
    expect(t.orphanedReplyRearmCount).toBe(1)

    t.onStreamEvent('tool_label', undefined, 11_000) // genuine event resets
    expect(t.orphanedReplyRearmCount).toBe(0)

    expiry(t, 20_000)
    expect(t.orphanedReplyRearmCount).toBe(1)

    expiry(t, 30_000) // consecutive silence (last event 11_000, gap 19s < 120s)
    expect(t.orphanedReplyRearmCount).toBe(2)
  })

  it('21 consecutive recently-streaming expiries (no reset): 21st fires at the cap', () => {
    const t = new LivenessTracker(0)
    let last: { rearm: boolean; countsAgainstCap: boolean } | undefined
    for (let k = 1; k <= 21; k++) {
      // now = k*1000 keeps the gap from the seed (0) under the 120s window,
      // so recentlyStreaming stays true throughout — the ONLY bound is the cap.
      last = expiry(t, k * 1_000)
    }
    expect(last).toEqual({ rearm: false, countsAgainstCap: true })
    expect(t.orphanedReplyRearmCount).toBe(MAX)

    // humanWaiting past the cap → uncapped re-arm.
    const dHuman = expiry(t, 22_000, { humanWaiting: true })
    expect(dHuman).toEqual({ rearm: true, countsAgainstCap: false })

    // recentlyStreaming false + working false + humanWaiting false → fail-safe FIRE.
    const dFire = expiry(t, 200_000)
    expect(dFire).toEqual({ rearm: false, countsAgainstCap: false })
  })
})
