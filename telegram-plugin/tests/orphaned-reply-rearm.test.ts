/**
 * Unit tests for the orphaned-reply backstop, repointed at the REAL
 * LivenessTracker (the thinking-pause fix seam) — no replica decision helpers.
 *
 * Root cause: the orphaned-reply backstop fired a synthetic turn_end
 * (`durationMs: -1`) after 30 s of silence, even mid-work. That nulled
 * `currentTurn` and dropped every subsequent `tool_label`, darkening the live
 * activity feed for the rest of the turn.
 *
 * Fix layers (all now expressed through `LivenessTracker`):
 *   PRIMARY   — the fuse fires mid-work → re-arm instead. `decideOnExpiry`
 *               re-arms while working OR recently-streaming OR human-waiting,
 *               bounded by ORPHANED_REPLY_MAX_REARMS for the working /
 *               recently-streaming cases (human-wait is uncapped).
 *   SECONDARY — a genuine stream event (`onStreamEvent`) re-stamps liveness and
 *               zeroes the rearm counter, so an actively-progressing turn never
 *               hits the cap.
 *   DEFENSIVE — the gateway rejects a synthetic turn_end while the turn is
 *               legitimately working OR recently streaming (`recentlyStreaming`).
 */

import { describe, it, expect } from 'vitest'
import {
  shouldArmOrphanedReplyTimeout,
  ORPHANED_REPLY_TIMEOUT_MS,
  ORPHANED_REPLY_MAX_REARMS,
  ORPHANED_REPLY_STREAM_WINDOW_MS,
  LivenessTracker,
} from '../context-exhaustion.js'
import { ToolFlightTracker } from '../gateway/interrupt-defer.js'

const W = ORPHANED_REPLY_STREAM_WINDOW_MS
const MAX = ORPHANED_REPLY_MAX_REARMS

/**
 * A tracker whose last stream event is far enough in the past that
 * `recentlyStreaming` is false at `now`, so the ONLY thing keeping the turn
 * alive in a `decideOnExpiry` call is the `working` / `humanWaiting` inputs.
 * Lets us test the "no liveness except the tool" decisions in isolation.
 */
function staleTracker(): LivenessTracker {
  return new LivenessTracker(0)
}
const STALE_NOW = W + 10_000 // gap > window → recentlyStreaming false

// ---------------------------------------------------------------------------
// Tests: ORPHANED_REPLY_MAX_REARMS constant
// ---------------------------------------------------------------------------

describe('ORPHANED_REPLY_MAX_REARMS', () => {
  it('is 20 (20 × 30 s = 10 min cap)', () => {
    expect(ORPHANED_REPLY_MAX_REARMS).toBe(20)
  })

  it('combined with ORPHANED_REPLY_TIMEOUT_MS covers at least 10 min of tool activity', () => {
    const coverageMs = ORPHANED_REPLY_MAX_REARMS * ORPHANED_REPLY_TIMEOUT_MS
    expect(coverageMs).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })

  it('fuse duration is still 30 s', () => {
    expect(ORPHANED_REPLY_TIMEOUT_MS).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// Tests: PRIMARY fix — re-arm via decideOnExpiry (REAL tracker)
// ---------------------------------------------------------------------------

describe('PRIMARY fix: re-arm guard (LivenessTracker.decideOnExpiry)', () => {
  it('re-arms while working and under the cap (recentlyStreaming false)', () => {
    const t = staleTracker()
    const d = t.decideOnExpiry({ working: true, humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX })
    expect(d).toEqual({ rearm: true, countsAgainstCap: true })
  })

  it('fires once the working rearm count reaches the cap (recentlyStreaming false)', () => {
    const t = staleTracker()
    let last: { rearm: boolean } | undefined
    for (let k = 0; k <= MAX; k++) {
      last = t.decideOnExpiry({ working: true, humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX })
    }
    // MAX re-arms proceeded (counter 1..MAX); the (MAX+1)th fires.
    expect(last!.rearm).toBe(false)
    expect(t.orphanedReplyRearmCount).toBe(MAX)
  })

  it('fires immediately when nothing keeps the turn alive (idle, not recently streaming)', () => {
    const t = staleTracker()
    const d = t.decideOnExpiry({ working: false, humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX })
    expect(d).toEqual({ rearm: false, countsAgainstCap: false })
  })

  it('re-arms while recently streaming even when NOT working (thinking-pause survival)', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('text', undefined, 0)
    const d = t.decideOnExpiry({ working: false, humanWaiting: false, now: 30_000, windowMs: W, maxRearms: MAX })
    expect(d).toEqual({ rearm: true, countsAgainstCap: true })
  })
})

// ---------------------------------------------------------------------------
// Tests: DEFENSIVE fix — recentlyStreaming keeps the synthetic turn_end at bay
// ---------------------------------------------------------------------------

describe('DEFENSIVE fix: recentlyStreaming suppression window', () => {
  it('is true within the window of the last genuine stream event', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('tool_use', undefined, 5_000)
    expect(t.recentlyStreaming(5_000, W)).toBe(true)
    expect(t.recentlyStreaming(5_000 + W - 1, W)).toBe(true)
  })

  it('is false once the window lapses (genuine hang, teardown proceeds)', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('tool_use', undefined, 5_000)
    expect(t.recentlyStreaming(5_000 + W, W)).toBe(false)
  })

  it('a synthetic turn_end (-1) does not extend the window', () => {
    const t = new LivenessTracker(0)
    t.onStreamEvent('tool_use', undefined, 5_000)
    t.onStreamEvent('turn_end', -1, 5_500) // ignored
    expect(t.lastStreamEventAt).toBe(5_000)
    expect(t.recentlyStreaming(5_000 + W, W)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: ToolFlightTracker → working input → decideOnExpiry
// ---------------------------------------------------------------------------

describe('ToolFlightTracker drives the `working` input', () => {
  it('re-arm fires when a Bash tool is in flight (working=true)', () => {
    const flight = new ToolFlightTracker()
    flight.onEvent({ kind: 'tool_use', toolUseId: 'bash_1' })
    const t = staleTracker()
    const d = t.decideOnExpiry({
      working: flight.isMidToolCall(),
      humanWaiting: false,
      now: STALE_NOW,
      windowMs: W,
      maxRearms: MAX,
    })
    expect(d.rearm).toBe(true)
  })

  it('fires normally after tool_result completes the tool (working=false, not recently streaming)', () => {
    const flight = new ToolFlightTracker()
    flight.onEvent({ kind: 'tool_use', toolUseId: 'bash_1' })
    flight.onEvent({ kind: 'tool_result', toolUseId: 'bash_1' })
    const t = staleTracker()
    const d = t.decideOnExpiry({
      working: flight.isMidToolCall(),
      humanWaiting: false,
      now: STALE_NOW,
      windowMs: W,
      maxRearms: MAX,
    })
    expect(d.rearm).toBe(false)
  })

  it('parallel tools: re-arm persists while ANY tool is in flight', () => {
    const flight = new ToolFlightTracker()
    flight.onEvent({ kind: 'tool_use', toolUseId: 'read_1' })
    flight.onEvent({ kind: 'tool_use', toolUseId: 'read_2' })
    flight.onEvent({ kind: 'tool_use', toolUseId: 'edit_1' })
    const t = staleTracker()
    expect(
      t.decideOnExpiry({ working: flight.isMidToolCall(), humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX }).rearm,
    ).toBe(true)

    flight.onEvent({ kind: 'tool_result', toolUseId: 'read_1' })
    flight.onEvent({ kind: 'tool_result', toolUseId: 'read_2' })
    expect(
      t.decideOnExpiry({ working: flight.isMidToolCall(), humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX }).rearm,
    ).toBe(true) // edit_1 still open

    flight.onEvent({ kind: 'tool_result', toolUseId: 'edit_1' })
    const t2 = staleTracker() // fresh so the earlier rearms don't confound the cap
    expect(
      t2.decideOnExpiry({ working: flight.isMidToolCall(), humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX }).rearm,
    ).toBe(false) // all complete, not recently streaming → fire
  })

  it('cap fires even mid-tool after 20 re-arms (wedged tool surfaces)', () => {
    const flight = new ToolFlightTracker()
    flight.onEvent({ kind: 'tool_use', toolUseId: 'hung_bash' })
    const t = staleTracker()
    for (let i = 0; i < MAX; i++) {
      expect(
        t.decideOnExpiry({ working: flight.isMidToolCall(), humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX }).rearm,
      ).toBe(true)
    }
    // Cap exceeded — fire despite in-flight.
    expect(
      t.decideOnExpiry({ working: flight.isMidToolCall(), humanWaiting: false, now: STALE_NOW, windowMs: W, maxRearms: MAX }).rearm,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: shouldArmOrphanedReplyTimeout (existing surface, unchanged)
// ---------------------------------------------------------------------------

describe('shouldArmOrphanedReplyTimeout (existing — unchanged by this fix)', () => {
  it('arms when conditions are met', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: '123',
        capturedTextCount: 1,
        replyCalled: false,
      }),
    ).toBe(true)
  })

  it('does not arm after reply has been called', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: '123',
        capturedTextCount: 5,
        replyCalled: true,
      }),
    ).toBe(false)
  })

  it('does not arm when no chat is active', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: null,
        capturedTextCount: 1,
        replyCalled: false,
      }),
    ).toBe(false)
  })

  it('does not arm when no text captured yet', () => {
    expect(
      shouldArmOrphanedReplyTimeout({
        currentSessionChatId: '123',
        capturedTextCount: 0,
        replyCalled: false,
      }),
    ).toBe(false)
  })
})
