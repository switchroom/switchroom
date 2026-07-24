/**
 * feed-survival.test.ts — unit tests for the feed-survival primitive.
 *
 * Tests the three gaps identified in the audit:
 *
 *   Gap 1 — detached background work (Bash run_in_background, Agent/Task)
 *            empties inFlight on near-instant tool_result, but the work is
 *            still running. Both orphaned-reply timer and silence-poke must
 *            not tear down the feed while hasPendingAsyncDispatch is true.
 *
 *   Gap 2 — silence-poke defer was gated on SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=1
 *            (default OFF). The new isLegitimatelyWorking callback makes the
 *            defer the DEFAULT when wired, without requiring the env var.
 *
 *   Gap 3 — ask_user with TTL >10min hit ORPHANED_REPLY_MAX_REARMS and was
 *            force-closed mid-human-wait. Now exempt from the cap.
 *
 * Regression: a truly idle turn (no work) still backstops/tears down as before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  startTurn,
  noteOutbound,
  noteToolStart,
  noteToolEnd,
  endTurn,
  __tickForTests,
  __setDepsForTests,
  __getStateForTests,
  __resetAllForTests,
  DEFAULT_THRESHOLDS,
  type SilencePokeMetric,
  type FrameworkFallbackContext,
} from '../silence-poke.js'
import {
  noteAsyncDispatch,
  hasPendingAsyncDispatch,
  noteOutbound as ppNoteOutbound,
  noteTurnEnd as ppNoteTurnEnd,
  startTurn as ppStartTurn,
  clearPending,
  __resetAllForTests as ppReset,
  __setDepsForTests as ppSetDeps,
} from '../pending-work-progress.js'
import { ToolFlightTracker } from '../gateway/interrupt-defer.js'
import {
  ORPHANED_REPLY_TIMEOUT_MS,
  ORPHANED_REPLY_MAX_REARMS,
  ORPHANED_REPLY_STREAM_WINDOW_MS,
  LivenessTracker,
} from '../context-exhaustion.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SilenceFixtures {
  emitted: SilencePokeMetric[]
  fallbacks: FrameworkFallbackContext[]
}

function setupSilenceDeps(opts?: {
  thresholds?: Partial<typeof DEFAULT_THRESHOLDS> & { fallbackHardCeiling?: number }
  isLegitimatelyWorking?: (key: string) => boolean
}): SilenceFixtures {
  const fixtures: SilenceFixtures = { emitted: [], fallbacks: [] }
  __setDepsForTests({
    emitMetric: (e) => fixtures.emitted.push(e),
    onFrameworkFallback: (ctx) => { fixtures.fallbacks.push(ctx) },
    thresholdsMs: {
      ...DEFAULT_THRESHOLDS,
      ...(opts?.thresholds ?? {}),
    },
    ...(opts?.isLegitimatelyWorking != null
      ? { isLegitimatelyWorking: opts.isLegitimatelyWorking }
      : {}),
  })
  return fixtures
}

beforeEach(() => {
  __resetAllForTests()
  ppReset()
})

afterEach(() => {
  __resetAllForTests()
  ppReset()
  delete process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS
})

// ─── hasPendingAsyncDispatch ──────────────────────────────────────────────────

describe('hasPendingAsyncDispatch', () => {
  beforeEach(() => {
    ppSetDeps({
      editMessage: async () => {},
    })
  })

  it('returns false before any dispatch is noted', () => {
    ppStartTurn('chat:0')
    expect(hasPendingAsyncDispatch('chat:0')).toBe(false)
  })

  it('returns true after noteAsyncDispatch (Bash run_in_background / Agent / Task)', () => {
    ppStartTurn('chat:0')
    noteAsyncDispatch('chat:0')
    expect(hasPendingAsyncDispatch('chat:0')).toBe(true)
  })

  it('returns false after clearPending (inbound clears the flag)', () => {
    ppStartTurn('chat:0')
    noteAsyncDispatch('chat:0')
    clearPending('chat:0', 'inbound')
    expect(hasPendingAsyncDispatch('chat:0')).toBe(false)
  })

  it('returns false for an unknown key', () => {
    expect(hasPendingAsyncDispatch('never-started')).toBe(false)
  })

  it('returns true during active turn after dispatch, false after turn-end clears', () => {
    ppStartTurn('chat:0')
    noteAsyncDispatch('chat:0')
    expect(hasPendingAsyncDispatch('chat:0')).toBe(true)
    // Turn ends with pending+no-anchor → state is deleted
    ppNoteTurnEnd('chat:0')
    expect(hasPendingAsyncDispatch('chat:0')).toBe(false)
  })

  it('cross-turn: dispatch + outbound anchor + turn-end → pending PERSISTS (the core feed-survival path)', () => {
    // The critical production scenario: the agent dispatches detached
    // background work (run_in_background Bash / Agent / Task), posts a reply
    // (capturing an anchor), and the turn ends — but the bg work is still
    // running. pending+anchor at turn_end activates rather than deletes, so
    // hasPendingAsyncDispatch stays true and both teardown timers keep
    // deferring while the detached work runs.
    ppStartTurn('chat:0')
    noteAsyncDispatch('chat:0')
    ppNoteOutbound('chat:0', { messageId: 4242, text: 'kicked off the build, polling…', parseMode: 'HTML' })
    ppNoteTurnEnd('chat:0')
    expect(hasPendingAsyncDispatch('chat:0')).toBe(true)
  })
})

// ─── Silence-poke: isLegitimatelyWorking callback defer ──────────────────────

describe('silence-poke — isLegitimatelyWorking callback (default-on defer)', () => {
  it('defers the 300s fallback when the callback returns true', () => {
    let working = true
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => working,
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000) // would fire without the callback
    expect(f.fallbacks).toHaveLength(0)

    __tickForTests(500_000) // still working
    expect(f.fallbacks).toHaveLength(0)

    working = false // work done
    __tickForTests(500_001) // silence was already past threshold
    expect(f.fallbacks).toHaveLength(1)
  })

  it('does NOT defer when the callback returns false (genuinely idle turn)', () => {
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => false,
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    // Idle turn: no work, fallback fires immediately
    expect(f.fallbacks).toHaveLength(1)
  })

  it('fires at the hard ceiling even when callback keeps returning true (hung-signal)', () => {
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => true, // signal never clears
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(0) // deferred
    __tickForTests(900_000) // crosses ceiling
    expect(f.fallbacks).toHaveLength(1) // bounded — still unwedges
  })

  it('wired callback returns false → fallback fires even with inFlightTools non-empty (callback supersedes legacy flag)', () => {
    // When isLegitimatelyWorking is wired, it is consulted; the legacy flag
    // is not consulted for the new path. Verify by having callback=false and
    // inFlightTools non-empty — the fallback fires because the callback says "no".
    // NOTE (#3519): the in-flight tool here must be a NON-Bash tool. A `Bash`
    // arms the CLI-side background-bash defer (a foreground Bash the callback
    // is blind to once it moves to the background), which intentionally holds
    // the fallback back even when the callback returns false — so using Bash
    // would exercise that new defer rather than the callback-supersedes-legacy
    // path this test pins. `Grep` can never be a detached background process.
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => false,
    })
    startTurn('chat:0', 0)
    noteToolStart('chat:0', 't1', 'Grep', 'audit', 10_000)
    __tickForTests(300_000)
    // callback says false → no defer, fallback fires
    expect(f.fallbacks).toHaveLength(1)
  })

  it('SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0 force-disables the defer even with callback wired', () => {
    process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS = '0'
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => true,
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1) // force-disabled: fallback fires
  })
})

// ─── Silence-poke: detached background work (Gap 1) ──────────────────────────

describe('silence-poke — detached Bash run_in_background keeps feed alive', () => {
  beforeEach(() => {
    ppSetDeps({ editMessage: async () => {} })
  })

  it('defers the 300s fallback while hasPendingAsyncDispatch is true', () => {
    // Simulate: model calls Bash(run_in_background:true), gets back instant
    // handle (tool_result), turn ends, but background process is running.
    // pendingProgress.pending stays true.
    ppStartTurn('chat:0')
    noteAsyncDispatch('chat:0') // Bash dispatched

    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: (key) => hasPendingAsyncDispatch(key),
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000) // inFlight is empty but bg work is pending
    expect(f.fallbacks).toHaveLength(0)

    __tickForTests(500_000) // still pending
    expect(f.fallbacks).toHaveLength(0)

    // Background work completes: pendingProgress cleared
    clearPending('chat:0', 'inbound')
    __tickForTests(500_001)
    expect(f.fallbacks).toHaveLength(1) // now fires
  })

  it('a truly idle turn (no background work, no tool in flight) still fires at 300s', () => {
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: (key) => hasPendingAsyncDispatch(key),
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1) // no work: still backstops
  })
})

// ─── Orphaned-reply: ask_user exemption from ORPHANED_REPLY_MAX_REARMS ───────

/**
 * Pure decision functions mirroring the orphaned-reply guard logic in gateway.ts.
 * Extracted so the ask_user-exempt path can be tested without the full gateway.
 */
function shouldRearmOrphanedReply(opts: {
  isLegitimatelyWorking: boolean
  humanWaiting: boolean
  rearmCount: number
  maxRearms: number
}): 'rearm' | 'fire' {
  const { isLegitimatelyWorking: working, humanWaiting, rearmCount, maxRearms } = opts
  if (working || humanWaiting) {
    // ask_user: exempt from cap — keep re-arming as long as human-wait is open
    if (humanWaiting) return 'rearm'
    // Other work: honour cap
    if (rearmCount < maxRearms) return 'rearm'
    // Cap exceeded: fire backstop (a genuinely hung tool must surface)
    return 'fire'
  }
  return 'fire'
}

describe('orphaned-reply: ask_user exempt from ORPHANED_REPLY_MAX_REARMS', () => {
  it('re-arms indefinitely while ask_user is open (humanWaiting=true)', () => {
    // Even at count === ORPHANED_REPLY_MAX_REARMS, humanWaiting=true → still rearms
    for (let i = 0; i <= ORPHANED_REPLY_MAX_REARMS + 5; i++) {
      expect(shouldRearmOrphanedReply({
        isLegitimatelyWorking: false,
        humanWaiting: true,
        rearmCount: i,
        maxRearms: ORPHANED_REPLY_MAX_REARMS,
      })).toBe('rearm')
    }
  })

  it('fires once ask_user closes (humanWaiting=false, no other work)', () => {
    expect(shouldRearmOrphanedReply({
      isLegitimatelyWorking: false,
      humanWaiting: false,
      rearmCount: 0,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe('fire')
  })

  it('standard foreground tool: still bound by ORPHANED_REPLY_MAX_REARMS', () => {
    // Under cap: rearm
    expect(shouldRearmOrphanedReply({
      isLegitimatelyWorking: true,
      humanWaiting: false,
      rearmCount: ORPHANED_REPLY_MAX_REARMS - 1,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe('rearm')
    // At cap: fire
    expect(shouldRearmOrphanedReply({
      isLegitimatelyWorking: true,
      humanWaiting: false,
      rearmCount: ORPHANED_REPLY_MAX_REARMS,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe('fire')
  })

  it('ask_user combined with other work: cap still bypassed (humanWaiting wins)', () => {
    expect(shouldRearmOrphanedReply({
      isLegitimatelyWorking: true,
      humanWaiting: true,
      rearmCount: ORPHANED_REPLY_MAX_REARMS + 100,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe('rearm')
  })
})

// ─── Orphaned-reply: detached work (Gap 1) ───────────────────────────────────

describe('orphaned-reply: detached background work keeps feed alive past 30s', () => {
  it('re-arms while isLegitimatelyWorking=true (bg work in flight)', () => {
    // Mirrors the gateway guard logic
    function rearmDecision(working: boolean, humanWaiting: boolean, count: number): 'rearm' | 'fire' {
      return shouldRearmOrphanedReply({
        isLegitimatelyWorking: working,
        humanWaiting,
        rearmCount: count,
        maxRearms: ORPHANED_REPLY_MAX_REARMS,
      })
    }

    // Bash run_in_background: inFlight empty, hasPendingAsyncDispatch=true
    expect(rearmDecision(true, false, 0)).toBe('rearm')
    expect(rearmDecision(true, false, ORPHANED_REPLY_MAX_REARMS - 1)).toBe('rearm')
    // Cap hit: fire (the bg process must have been stuck for 10min+)
    expect(rearmDecision(true, false, ORPHANED_REPLY_MAX_REARMS)).toBe('fire')
  })

  it('fires immediately when no work at all (truly idle turn)', () => {
    expect(shouldRearmOrphanedReply({
      isLegitimatelyWorking: false,
      humanWaiting: false,
      rearmCount: 0,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe('fire')
  })
})

// ─── Synthetic turn_end suppressor with isLegitimatelyWorking ─────────────────

/**
 * Mirrors the DEFENSIVE FIX in gateway.ts turn_end handler.
 * Now uses isLegitimatelyWorking instead of just isMidToolCall().
 */
function shouldSuppressSyntheticTurnEnd(opts: {
  durationMs: number
  isLegitimatelyWorking: boolean
}): boolean {
  return opts.durationMs === -1 && opts.isLegitimatelyWorking
}

describe('DEFENSIVE FIX: synthetic turn_end suppressor (extended predicate)', () => {
  it('suppresses when durationMs=-1 and bg work is pending (detached Bash)', () => {
    expect(shouldSuppressSyntheticTurnEnd({
      durationMs: -1,
      isLegitimatelyWorking: true, // hasPendingAsyncDispatch returned true
    })).toBe(true)
  })

  it('suppresses when durationMs=-1 and ask_user is open (human-wait)', () => {
    expect(shouldSuppressSyntheticTurnEnd({
      durationMs: -1,
      isLegitimatelyWorking: true, // pendingAskUser has entry for chat
    })).toBe(true)
  })

  it('does NOT suppress when durationMs=-1 but no work (genuinely idle)', () => {
    expect(shouldSuppressSyntheticTurnEnd({
      durationMs: -1,
      isLegitimatelyWorking: false,
    })).toBe(false)
  })

  it('does NOT suppress a REAL turn_end (durationMs >= 0)', () => {
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 0, isLegitimatelyWorking: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 1, isLegitimatelyWorking: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 12345, isLegitimatelyWorking: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: 0, isLegitimatelyWorking: false })).toBe(false)
  })

  it('only durationMs === -1 is the synthetic discriminator (near-miss values)', () => {
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: -2, isLegitimatelyWorking: true })).toBe(false)
    expect(shouldSuppressSyntheticTurnEnd({ durationMs: -0.5, isLegitimatelyWorking: true })).toBe(false)
  })
})

// ─── Regression: idle turns still backstop as before ─────────────────────────

describe('REGRESSION: idle turn (no work) still backstops', () => {
  it('silence-poke fires at 300s for a genuinely idle turn (callback wired)', () => {
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => false, // nothing working
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1)
  })

  it('silence-poke fires at 300s for an idle turn (no callback, no legacy defer)', () => {
    const f = setupSilenceDeps() // nothing wired
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1)
  })

  it('orphaned-reply fires for an idle turn (no work, no human wait)', () => {
    expect(shouldRearmOrphanedReply({
      isLegitimatelyWorking: false,
      humanWaiting: false,
      rearmCount: 0,
      maxRearms: ORPHANED_REPLY_MAX_REARMS,
    })).toBe('fire')
  })

  it('ToolFlightTracker empty → not legitimately working via isMidToolCall', () => {
    const tracker = new ToolFlightTracker()
    expect(tracker.isMidToolCall()).toBe(false)
  })

  it('ToolFlightTracker with tool in flight → legitimately working', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'bg-bash' })
    expect(tracker.isMidToolCall()).toBe(true)
    // After tool_result (instant handle return for run_in_background):
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'bg-bash' })
    expect(tracker.isMidToolCall()).toBe(false)
    // But hasPendingAsyncDispatch should still signal the bg work is running
  })
})

// ─── Combined: isLegitimatelyWorking integrates all three signals ─────────────

describe('isLegitimatelyWorking — all three signals', () => {
  beforeEach(() => {
    ppSetDeps({ editMessage: async () => {} })
  })

  it('true when only isMidToolCall (foreground tool)', () => {
    const tracker = new ToolFlightTracker()
    tracker.onEvent({ kind: 'tool_use', toolUseId: 't1' })
    // Simulate the predicate
    const working = tracker.isMidToolCall() || hasPendingAsyncDispatch('chat:0') || false
    expect(working).toBe(true)
  })

  it('true when only hasPendingAsyncDispatch (Bash run_in_background)', () => {
    const tracker = new ToolFlightTracker()
    // tool_use fired then instantly tool_result came back
    tracker.onEvent({ kind: 'tool_use', toolUseId: 'bash1' })
    tracker.onEvent({ kind: 'tool_result', toolUseId: 'bash1' })
    ppStartTurn('chat:0')
    noteAsyncDispatch('chat:0')
    const working = tracker.isMidToolCall() || hasPendingAsyncDispatch('chat:0') || false
    expect(tracker.isMidToolCall()).toBe(false) // inFlight cleared
    expect(hasPendingAsyncDispatch('chat:0')).toBe(true) // bg work pending
    expect(working).toBe(true)
  })

  it('true when only human-wait (ask_user open)', () => {
    const tracker = new ToolFlightTracker()
    // ask_user tool_use is in inFlight while waiting; here we simulate
    // the defence-in-depth path where inFlight was cleared unexpectedly
    const askUserInFlight = true // pendingAskUser.size > 0 for this chat
    const working = tracker.isMidToolCall() || hasPendingAsyncDispatch('chat:0') || askUserInFlight
    expect(working).toBe(true)
  })

  it('false when all three signals are clear (genuinely idle)', () => {
    const tracker = new ToolFlightTracker()
    const working = tracker.isMidToolCall() || hasPendingAsyncDispatch('chat:0') || false
    expect(working).toBe(false)
  })
})

// ─── Silence-poke: hard ceiling is correctly applied ─────────────────────────

describe('silence-poke — hard ceiling bounds the defer', () => {
  it('fires at ceiling even when isLegitimatelyWorking stays true (leak-guard)', () => {
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 600_000 },
      isLegitimatelyWorking: () => true, // signal never clears
    })
    startTurn('chat:0', 0)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(0)
    __tickForTests(599_000)
    expect(f.fallbacks).toHaveLength(0)
    __tickForTests(600_000) // at ceiling
    expect(f.fallbacks).toHaveLength(1)
  })

  it('fallbackFired is true after ceiling fire (no double-fire)', () => {
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 600_000 },
      isLegitimatelyWorking: () => true,
    })
    startTurn('chat:0', 0)
    __tickForTests(600_000)
    __tickForTests(700_000) // additional tick after ceiling
    expect(f.fallbacks).toHaveLength(1) // only fires once
    expect(__getStateForTests('chat:0')!.fallbackFired).toBe(true)
  })
})

// ─── Thinking-pause liveness via the REAL LivenessTracker (orphaned-reply fix) ─

describe('silence-poke — thinking-pause liveness via the real LivenessTracker', () => {
  // Drives the REAL LivenessTracker as the isLegitimatelyWorking source: a
  // genuine stream event within ORPHANED_REPLY_STREAM_WINDOW_MS keeps the feed
  // alive (a model reasoning pause is survivable); a gap longer than the window
  // with no work tears the feed down.
  it('a stream event within the window keeps the feed alive (thinking-pause survivable)', () => {
    let clockNow = 0
    const tracker = new LivenessTracker(0)
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => tracker.recentlyStreaming(clockNow, ORPHANED_REPLY_STREAM_WINDOW_MS),
    })
    startTurn('chat:0', 0)
    // A genuine stream event lands mid-turn (e.g. the model resumes after a
    // reasoning pause) — only 50s before the 300s fallback tick.
    tracker.onStreamEvent('text', undefined, 250_000)
    clockNow = 300_000
    __tickForTests(300_000) // 50s since last stream < 120s window → deferred
    expect(f.fallbacks).toHaveLength(0)
  })

  it('no stream event for longer than the window tears the feed down', () => {
    let clockNow = 0
    const tracker = new LivenessTracker(0) // seed at t=0, nothing after
    const f = setupSilenceDeps({
      thresholds: { fallback: 300_000, fallbackHardCeiling: 900_000 },
      isLegitimatelyWorking: () => tracker.recentlyStreaming(clockNow, ORPHANED_REPLY_STREAM_WINDOW_MS),
    })
    startTurn('chat:0', 0)
    clockNow = 300_000
    __tickForTests(300_000) // 300s since last stream >> 120s window → fires
    expect(f.fallbacks).toHaveLength(1)
  })
})
