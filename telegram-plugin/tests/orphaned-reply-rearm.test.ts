/**
 * Unit tests for the activity-feed-teardown fix (orphaned-reply backstop).
 *
 * Root cause: the orphaned-reply backstop fired a synthetic turn_end
 * (`durationMs: -1`) after 30 s of silence, even mid-tool-call. That nulled
 * `currentTurn` and dropped every subsequent `tool_label`, darkening the live
 * activity feed for the rest of the turn.
 *
 * Fix: three layers described in the PR.
 *   PRIMARY   — fuse fires mid-tool → re-arm instead (bounded by ORPHANED_REPLY_MAX_REARMS).
 *   SECONDARY — tool_label re-arms the fuse so active label streams keep it fresh.
 *   DEFENSIVE — turn_end entry rejects the synthetic event if tools are in flight.
 *
 * These tests cover the pure / unit-testable surfaces:
 *   - shouldArmOrphanedReplyTimeout (existing, now with midToolCall param)
 *   - ORPHANED_REPLY_MAX_REARMS constant math
 *   - The re-arm guard logic (pure decision extracted from the closure)
 *   - The defensive turn_end discriminator (durationMs === -1 + in-flight check)
 */

import { describe, it, expect } from 'vitest'
import {
  shouldArmOrphanedReplyTimeout,
  ORPHANED_REPLY_TIMEOUT_MS,
  ORPHANED_REPLY_MAX_REARMS,
} from '../context-exhaustion.js'
import { ToolFlightTracker } from '../gateway/interrupt-defer.js'

// ---------------------------------------------------------------------------
// Helpers — pure decision functions mirroring the gateway closure logic.
// These extract the discriminable parts of the fix so they are unit-testable
// without instantiating the full gateway.
// ---------------------------------------------------------------------------

/**
 * Mirrors the PRIMARY fix decision inside the setTimeout callback:
 * should the backstop re-arm (true) or fire turn_end (false)?
 */
function shouldRearmInsteadOfFire(opts: {
  midToolCall: boolean
  rearmCount: number
  maxRearms: number
}): boolean {
  return opts.midToolCall && opts.rearmCount < opts.maxRearms
}

/**
 * Mirrors the DEFENSIVE fix at turn_end entry:
 * should a synthetic turn_end (durationMs === -1) be suppressed?
 */
function shouldSuppressSyntheticTurnEnd(opts: {
  durationMs: number
  midToolCall: boolean
}): boolean {
  return opts.durationMs === -1 && opts.midToolCall
}

// ---------------------------------------------------------------------------
// Tests: ORPHANED_REPLY_MAX_REARMS constant
// ---------------------------------------------------------------------------

describe('ORPHANED_REPLY_MAX_REARMS', () => {
  it('is 20 (20 × 30 s = 10 min cap)', () => {
    expect(ORPHANED_REPLY_MAX_REARMS).toBe(20)
  })

  it('combined with ORPHANED_REPLY_TIMEOUT_MS covers at least 10 min of tool activity', () => {
    const coverageMs = ORPHANED_REPLY_MAX_REARMS * ORPHANED_REPLY_TIMEOUT_MS
    // 20 × 30 000 ms = 600 000 ms = 10 min
    expect(coverageMs).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })

  it('fuse duration is still 30 s', () => {
    expect(ORPHANED_REPLY_TIMEOUT_MS).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// Tests: PRIMARY fix — re-arm guard
// ---------------------------------------------------------------------------

describe('PRIMARY fix: re-arm guard (shouldRearmInsteadOfFire)', () => {
  it('re-arms when a tool is in flight and rearm count is under the cap', () => {
    expect(shouldRearmInsteadOfFire({ midToolCall: true, rearmCount: 0, maxRearms: 20 })).toBe(true)
    expect(shouldRearmInsteadOfFire({ midToolCall: true, rearmCount: 19, maxRearms: 20 })).toBe(true)
  })

  it('fires once rearm count reaches the cap, even mid-tool-call', () => {
    expect(shouldRearmInsteadOfFire({ midToolCall: true, rearmCount: 20, maxRearms: 20 })).toBe(false)
    expect(shouldRearmInsteadOfFire({ midToolCall: true, rearmCount: 21, maxRearms: 20 })).toBe(false)
  })

  it('fires immediately when no tool is in flight, regardless of rearm count', () => {
    expect(shouldRearmInsteadOfFire({ midToolCall: false, rearmCount: 0, maxRearms: 20 })).toBe(false)
    expect(shouldRearmInsteadOfFire({ midToolCall: false, rearmCount: 5, maxRearms: 20 })).toBe(false)
  })

  it('rearm count transitions: 0 → cap-1 → cap fires', () => {
    const max = ORPHANED_REPLY_MAX_REARMS
    for (let i = 0; i < max; i++) {
      expect(shouldRearmInsteadOfFire({ midToolCall: true, rearmCount: i, maxRearms: max })).toBe(true)
    }
    // At exactly the cap: fire
    expect(shouldRearmInsteadOfFire({ midToolCall: true, rearmCount: max, maxRearms: max })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: DEFENSIVE fix — synthetic turn_end suppressor
// ---------------------------------------------------------------------------

describe('DEFENSIVE fix: synthetic turn_end suppressor', () => {
  it('suppresses a synthetic turn_end (durationMs === -1) when tools are in flight', () => {
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: -1, midToolCall: true })).toBe(true)
  })

  it('does NOT suppress a synthetic turn_end when no tools are in flight', () => {
    // No tools → the backstop should fire normally (turn is genuinely orphaned)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: -1, midToolCall: false })).toBe(false)
  })

  it('does NOT suppress an authoritative turn_end (durationMs >= 0)', () => {
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 0, midToolCall: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 1, midToolCall: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 12345, midToolCall: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 0, midToolCall: false })).toBe(false)
  })

  it('only durationMs === -1 is the synthetic discriminator', () => {
    // Values near -1 must not accidentally trigger suppression
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: -2, midToolCall: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: -0.5, midToolCall: true })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: ToolFlightTracker integration with the guard logic
// ---------------------------------------------------------------------------

describe('ToolFlightTracker + guard integration', () => {
  it('re-arm fires when a Bash tool is in flight', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'bash_1' })

    expect(shouldRearmInsteadOfFire({
      midToolCall: tracker.isMidToolCall(),
      rearmCount: 0,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe(true)
  })

  it('fires normally after tool_result completes the tool', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'bash_1' })
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'bash_1' })

    expect(shouldRearmInsteadOfFire({
      midToolCall: tracker.isMidToolCall(),
      rearmCount: 0,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe(false)
  })

  it('defensive guard suppresses synthetic turn_end mid-Bash', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'bash_2' })

    expect(shouldSuppressSyntheticTurnEnd({
      durationMs: -1,
      midToolCall: tracker.isMidToolCall(),
    })).toBe(true)
  })

  it('defensive guard allows synthetic turn_end after all tools complete', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'bash_2' })
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'bash_2' })

    expect(shouldSuppressSyntheticTurnEnd({
      durationMs: -1,
      midToolCall: tracker.isMidToolCall(),
    })).toBe(false)
  })

  it('parallel tools: re-arm persists while ANY tool is in flight', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'read_1' })
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'read_2' })
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'edit_1' })

    // Still re-arming: 3 tools open
    expect(shouldRearmInsteadOfFire({
      midToolCall: tracker.isMidToolCall(),
      rearmCount: 0,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe(true)

    // Two complete
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'read_1' })
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'read_2' })

    // Still re-arming: edit_1 open
    expect(shouldRearmInsteadOfFire({
      midToolCall: tracker.isMidToolCall(),
      rearmCount: 1,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe(true)

    // All complete
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'edit_1' })

    expect(shouldRearmInsteadOfFire({
      midToolCall: tracker.isMidToolCall(),
      rearmCount: 2,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe(false)
  })

  it('cap fires even mid-tool after 20 re-arms (wedged tool surfaces)', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'hung_bash' })

    // First 20 re-arms proceed
    for (let i = 0; i < ORPHANED_REPLY_MAX_REARMS; i++) {
      expect(shouldRearmInsteadOfFire({
        midToolCall: tracker.isMidToolCall(),
        rearmCount: i,
        maxRearms: ORPHANED_REPLY_MAX_REARMS,
      })).toBe(true)
    }

    // 21st: cap exceeded — fire despite in-flight
    expect(shouldRearmInsteadOfFire({
      midToolCall: tracker.isMidToolCall(),
      rearmCount: ORPHANED_REPLY_MAX_REARMS,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe(false)
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
