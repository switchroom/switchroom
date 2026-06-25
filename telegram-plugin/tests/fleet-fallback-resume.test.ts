/**
 * Unit tests for the resume-after-swap gate (auth-failover-stall Fix 1).
 *
 * The gate owns the decision the gateway consults in doFireFleetAutoFallback
 * after a SUCCESSFUL swap: should we restart to resume the turn the mid-turn
 * 429 killed? It must:
 *   - return 'resume' on the first switched outcome (so exactly one restart
 *     fires), recorded so a follow-on swap is suppressed;
 *   - return 'skip-inflight' on a SECOND swap within the single-flight window
 *     (a 429 storm cannot loop-restart the agent);
 *   - return 'skip-stale' when the failed turn is older than maxAgeMs (an
 *     ancient interrupted turn is not resurrected);
 *   - never be consulted on all-blocked (verified by the gateway-seam test
 *     below, which only calls decide() on 'switched').
 *
 * The gate is pure (no process restart), so these tests run with a fake clock
 * and never touch a real process — the restart itself is a separate seam
 * (triggerSelfRestart) that the gateway wires to a 'resume' verdict.
 */

import { describe, it, expect } from 'vitest'
import {
  createFleetFallbackResumeGate,
  DEFAULT_RESUME_MAX_AGE_MS,
  DEFAULT_RESUME_SINGLE_FLIGHT_MS,
} from '../fleet-fallback-resume.js'

function fakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
  }
}

describe('createFleetFallbackResumeGate — resume verdict', () => {
  it("returns 'resume' on the first switched outcome", () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    // Failed turn started just now → fresh, not stale.
    expect(gate.decide(clk.now())).toBe('resume')
  })

  it("treats a null (unknown) failed-turn timestamp as resumable", () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    // null defers staleness to the boot-resume 3h failsafe → resume here.
    expect(gate.decide(null)).toBe('resume')
  })
})

describe('createFleetFallbackResumeGate — single-flight guard', () => {
  it('suppresses a SECOND swap inside the single-flight window (no double-resume)', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({
      nowFn: clk.now,
      singleFlightMs: DEFAULT_RESUME_SINGLE_FLIGHT_MS,
    })
    expect(gate.decide(clk.now())).toBe('resume')
    // A 429 storm: a second swap fires 1s later. Must NOT re-arm.
    clk.advance(1_000)
    expect(gate.decide(clk.now())).toBe('skip-inflight')
    // Still suppressed near the end of the window.
    clk.advance(DEFAULT_RESUME_SINGLE_FLIGHT_MS - 2_000)
    expect(gate.decide(clk.now())).toBe('skip-inflight')
  })

  it('re-arms once the single-flight window has fully elapsed', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now, singleFlightMs: 60_000 })
    expect(gate.decide(clk.now())).toBe('resume')
    clk.advance(60_001)
    // A genuinely new swap after the window resumes again (one per swap).
    expect(gate.decide(clk.now())).toBe('resume')
  })

  it('a rapid burst of N swaps yields exactly ONE resume', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now, singleFlightMs: 60_000 })
    let resumes = 0
    for (let i = 0; i < 10; i++) {
      if (gate.decide(clk.now()) === 'resume') resumes++
      clk.advance(500) // 0.5s between storm events, all inside the window
    }
    expect(resumes).toBe(1)
  })
})

describe('createFleetFallbackResumeGate — staleness guard', () => {
  it("suppresses ('skip-stale') a failed turn older than maxAgeMs", () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    const ancientStart = clk.now() - (DEFAULT_RESUME_MAX_AGE_MS + 60_000)
    expect(gate.decide(ancientStart)).toBe('skip-stale')
  })

  it('a stale verdict does NOT arm the single-flight window', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    expect(gate.decide(clk.now() - (DEFAULT_RESUME_MAX_AGE_MS + 1))).toBe('skip-stale')
    // A subsequent FRESH turn must still resume — the stale skip must not have
    // recorded an arm time.
    expect(gate.decide(clk.now())).toBe('resume')
  })

  it('a turn just under maxAgeMs still resumes', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now, maxAgeMs: 10_800_000 })
    expect(gate.decide(clk.now() - (10_800_000 - 1_000))).toBe('resume')
  })

  it('honours a custom maxAgeMs', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now, maxAgeMs: 60_000 })
    expect(gate.decide(clk.now() - 61_000)).toBe('skip-stale')
    expect(gate.decide(clk.now() - 30_000)).toBe('resume')
  })
})

describe('createFleetFallbackResumeGate — reset / inspect seams', () => {
  it('reset() clears the single-flight arm', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    expect(gate.decide(clk.now())).toBe('resume')
    expect(gate.decide(clk.now())).toBe('skip-inflight')
    gate.reset()
    expect(gate.inspect().lastResumedAtMs).toBe(Number.NEGATIVE_INFINITY)
    expect(gate.decide(clk.now())).toBe('resume')
  })
})

/**
 * Gateway-seam contract test. Mirrors how doFireFleetAutoFallback consults the
 * gate: it calls decide() ONLY on outcome.kind === 'switched', and translates a
 * 'resume' verdict into exactly one restart. We mock the restart as a counter,
 * so no process is touched. This pins the "all-blocked is a no-op" and
 * "exactly-once" contracts at the call-site shape.
 */
describe('gateway seam — decide() consulted only on switched, restart fires once', () => {
  type Outcome = { kind: 'switched' | 'all-blocked' }

  function simulateDispatch(
    gate: ReturnType<typeof createFleetFallbackResumeGate>,
    outcome: Outcome,
    failedTurnStartedAtMs: number | null,
    restart: () => void,
  ): void {
    // The actual gateway code path: resume is reached ONLY on 'switched'.
    if (outcome.kind === 'switched') {
      if (gate.decide(failedTurnStartedAtMs) === 'resume') restart()
    }
  }

  it('switched → restart fires exactly once', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    let restarts = 0
    simulateDispatch(gate, { kind: 'switched' }, clk.now(), () => restarts++)
    expect(restarts).toBe(1)
  })

  it('all-blocked → decide() is never consulted, restart never fires', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    let restarts = 0
    simulateDispatch(gate, { kind: 'all-blocked' }, clk.now(), () => restarts++)
    expect(restarts).toBe(0)
    // The gate stayed unarmed, so a subsequent real switch still resumes.
    simulateDispatch(gate, { kind: 'switched' }, clk.now(), () => restarts++)
    expect(restarts).toBe(1)
  })

  it('a 429 storm of switched outcomes restarts exactly once', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now, singleFlightMs: 60_000 })
    let restarts = 0
    for (let i = 0; i < 5; i++) {
      simulateDispatch(gate, { kind: 'switched' }, clk.now(), () => restarts++)
      clk.advance(1_000)
    }
    expect(restarts).toBe(1)
  })

  it('a stale switched outcome does not restart', () => {
    const clk = fakeClock()
    const gate = createFleetFallbackResumeGate({ nowFn: clk.now })
    let restarts = 0
    const ancient = clk.now() - (DEFAULT_RESUME_MAX_AGE_MS + 1)
    simulateDispatch(gate, { kind: 'switched' }, ancient, () => restarts++)
    expect(restarts).toBe(0)
  })
})
