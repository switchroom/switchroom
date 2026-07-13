/**
 * Idle auto-clear — what "idle" MEANS.
 *
 * On 2026-07-11 `overlord` worked for three hours straight (sub-agents, ~25 PRs
 * merged) and was `/clear`ed 12 s after the window elapsed — three hours of
 * session context destroyed. Root cause: the idle window was measured from the
 * last turn START, and nothing in a turn (tool calls, sub-agent work, the turn
 * ENDING) counted as activity. The invariant was inverted: the longer and more
 * productive the work, the more certain the wipe.
 *
 * These tests assert the OUTCOME: an agent that is doing things is not idle,
 * and an agent that is doing nothing still gets cleared.
 *
 * Deterministic virtual clock only (`T + n * H`) — no fake timers, no
 * `Date.now()`. Everything schedulable takes the clock as an argument, so the
 * whole 3h window is exercised in microseconds and the suite stays portable if
 * this file is ever moved to the bun runner. (It runs under vitest today: it is
 * not in `package.json`'s `test:bun` list and not excluded in
 * `vitest.config.ts`.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  decideIdleClear,
  classifyIdleEvent,
  idleDurationToMs,
  DEFAULT_IDLE_CLEAR_MS,
  IdleTracker,
  type IdleClearState,
} from '../gateway/idle-clear.js'
import * as pendingProgress from '../pending-work-progress.js'
import { isCronInjectFire } from '../gateway/cron-session.js'

const H = 3_600_000
const M = 60_000
/** Gateway's IDLE_CLEAR_CHECK_MS default. */
const TICK = 60_000

function state(p: Partial<IdleClearState>): IdleClearState {
  return {
    lastActivityAt: 0,
    lastTurnEndedAt: null,
    idleClearMs: 3 * H,
    alreadyCleared: false,
    turnInFlight: false,
    ...p,
  }
}

/**
 * Test harness that plays the role of the GATEWAY around the REAL `IdleTracker`
 * (#3115). It holds NO idle state and NO idle logic of its own — every stamp,
 * decision and latch delegates to the tracker the gateway itself holds. What it
 * owns is exactly what the gateway owns and the tracker does not: the
 * environment inputs (`idleClearMs`, `turnInFlight`, the background-work flag),
 * the periodic tick loop, and a log of when a clear fired.
 *
 * This is the whole point of #3115: the old `IdleModel` re-implemented
 * `markIdleActivity` / `markIdleTurnEnd` / the decide+latch in a mirror, so a
 * regression in the real gateway code (e.g. deleting the per-event stamp) left
 * every test green. Now a deleted stamp call fails a test, because the test
 * drives the same object the gateway drives.
 *
 * DELIBERATE STRUCTURAL LIMIT: `tick()` re-implements the gateway's ONE-LINE
 * orchestration around the tracker — the `decide → markClearFired` sequence
 * (maybeIdleClear, gateway.ts) and, in the #3114 block below, the
 * `!isCronInjectFire(meta)` stamp gate (onInjectInbound, gateway.ts). #3115
 * moved all the STATE and idle LOGIC into the importable `IdleTracker`, so those
 * are now driven directly; but gateway.ts is ~30k lines with import-time side
 * effects and cannot be imported, so the thin glue that wires the tracker into
 * the gateway is still asserted by re-implementing that glue here. A divergence
 * between the real gateway one-liner and this harness would NOT be caught — a
 * known, documented boundary, not an oversight. The residual glue is one line
 * per callsite; everything of substance is the real object.
 */
class TrackerHarness {
  readonly tracker: IdleTracker
  turnInFlight = false
  backgroundWorkInFlight: boolean | undefined = undefined
  clears: number[] = []

  constructor(
    startedAt: number,
    readonly idleClearMs = 3 * H,
  ) {
    this.tracker = new IdleTracker(startedAt)
  }

  /** A claude session-stream event → the gateway's handleSessionEvent stamp. */
  sessionEvent(kind: string, now: number, durationMs?: number): void {
    this.tracker.noteEvent(kind, now, durationMs)
  }

  /** Inbound / genuine cron fire → the gateway's markIdleActivity(). */
  activity(now: number): void {
    this.tracker.noteInbound(now)
  }

  /** One IDLE_CLEAR_CHECK_MS tick → the core of maybeIdleClear's decide+latch. */
  tick(now: number): boolean {
    const { clear } = this.tracker.decide(now, {
      idleClearMs: this.idleClearMs,
      turnInFlight: this.turnInFlight,
      backgroundWorkInFlight: this.backgroundWorkInFlight,
    })
    if (clear) {
      this.tracker.markClearFired()
      this.clears.push(now)
    }
    return clear
  }

  /** Run the interval from `from` to `to` inclusive, one tick per TICK. */
  ticksThrough(from: number, to: number): void {
    for (let t = from; t <= to; t += TICK) this.tick(t)
  }
}

describe('idle-clear: a working agent is not idle', () => {
  it('HEADLINE — a turn that runs LONGER than the idle window is not cleared when it ends', () => {
    // The overlord incident, replayed. Window 3h. Turn starts at T, runs 3h08m
    // of real work (sub-agents, tool calls), ends at T+3h08m.
    const T = 100 * H
    const m = new TrackerHarness(T)

    m.turnInFlight = true
    m.sessionEvent('enqueue', T) // turn start

    // ... 3h08m of work. The gate suppresses the clear while in flight.
    m.ticksThrough(T, T + 3 * H + 8 * M)
    expect(m.clears).toEqual([])

    // Turn ends. `turnInFlight` flips false — the moment of truth.
    const end = T + 3 * H + 8 * M
    m.sessionEvent('turn_end', end, 11_314_000)
    m.turnInFlight = false

    // The very next tick (12 s later in production) must NOT clear...
    expect(m.tick(end + 12_000)).toBe(false)
    // ...nor the next several ticks, nor anything short of a full fresh window.
    m.ticksThrough(end, end + 3 * H - TICK)
    expect(m.clears).toEqual([])
  })

  it('in-turn work keeps the timer warm even when the gateway sees no turn boundary', () => {
    // What ACTUALLY happened to overlord: the last turn ended at 07:05 and the
    // agent then worked for ~3h under stop-hook continuations that opened no new
    // turn. `turnInFlight` was false the whole time, so only the per-event stamp
    // can save it.
    const T = 100 * H
    const m = new TrackerHarness(T)
    m.sessionEvent('turn_end', T, 34_596) // last turn boundary
    m.turnInFlight = false

    // 3h30m of real work with no turn boundary: tool calls + sub-agent activity
    // every ~10 min, and a tick between each.
    for (let t = T; t <= T + 3 * H + 30 * M; t += 10 * M) {
      m.sessionEvent('tool_use', t)
      m.sessionEvent('sub_agent_tool_use', t + 60_000)
      m.ticksThrough(t, t + 10 * M - TICK)
    }
    expect(m.clears).toEqual([])
  })

  it('every genuine session event counts as activity (sub-agents included)', () => {
    for (const kind of [
      'enqueue',
      'thinking',
      'model',
      'tool_use',
      'tool_result',
      'text',
      'sub_agent_started',
      'sub_agent_tool_use',
      'sub_agent_text',
      'sub_agent_turn_end',
    ]) {
      expect(classifyIdleEvent(kind).activity).toBe(true)
      expect(classifyIdleEvent(kind).turnEnded).toBe(false)
    }
    // A real turn_end is activity AND a turn boundary.
    expect(classifyIdleEvent('turn_end', 5_000)).toEqual({ activity: true, turnEnded: true })
    // The gateway's own synthetic turn_end (orphaned-reply backstop) is not the
    // model doing something — but it still ends the turn.
    expect(classifyIdleEvent('turn_end', -1)).toEqual({ activity: false, turnEnded: true })
  })

  it('a background sub-agent still emitting events after the main turn ends holds off the clear', () => {
    const T = 100 * H
    const m = new TrackerHarness(T)
    m.sessionEvent('turn_end', T, 30_000)
    m.turnInFlight = false
    // Worker grinds for 4h past the main turn end.
    for (let t = T; t <= T + 4 * H; t += 5 * M) {
      m.sessionEvent('sub_agent_tool_use', t)
      m.ticksThrough(t, t + 5 * M - TICK)
    }
    expect(m.clears).toEqual([])
  })
})

describe('idle-clear: a genuinely idle agent is still cleared', () => {
  it('no turn, no inbound, no session event for a full window → cleared exactly once', () => {
    const T = 100 * H
    const m = new TrackerHarness(T)
    m.ticksThrough(T, T + 6 * H)
    expect(m.clears).toEqual([T + 3 * H])
  })

  it('cleared once per idle period, and re-arms on the next inbound', () => {
    const T = 100 * H
    const m = new TrackerHarness(T)
    m.ticksThrough(T, T + 5 * H)
    expect(m.clears).toEqual([T + 3 * H])

    const inbound = T + 5 * H
    m.activity(inbound) // operator comes back
    m.ticksThrough(inbound, inbound + 3 * H - TICK)
    expect(m.clears).toEqual([T + 3 * H]) // not yet
    m.ticksThrough(inbound, inbound + 3 * H)
    expect(m.clears).toEqual([T + 3 * H, inbound + 3 * H])
  })

  it('a turn that ends is cleared one full window after it ended (not before)', () => {
    const T = 100 * H
    const m = new TrackerHarness(T)
    m.turnInFlight = true
    m.sessionEvent('enqueue', T)
    const end = T + 3 * H + 8 * M
    m.sessionEvent('turn_end', end, 11_314_000)
    m.turnInFlight = false

    m.ticksThrough(end, end + 3 * H - TICK)
    expect(m.clears).toEqual([]) // still warm
    m.ticksThrough(end, end + 3 * H + TICK)
    expect(m.clears).toEqual([end + 3 * H]) // now genuinely idle → cleared
  })
})

describe('IdleTracker wiring (#3115) — the real object, not a mirror', () => {
  // These are the tests the old IdleModel COULD NOT be: they assert the real
  // tracker's stamp calls are load-bearing. Delete `noteEvent`'s activity
  // stamp, or gateway.ts's `idleTracker.noteEvent(...)` call, and these fail —
  // whereas against the IdleModel mirror the same regression stayed green.

  it('noteEvent advances lastActivityAt on every genuine session event', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    expect(t.activityAt).toBe(T)
    // A stream of events, each newer than the last, must walk the clock forward.
    for (const [i, kind] of [
      'enqueue', 'thinking', 'tool_use', 'tool_result', 'text',
      'sub_agent_started', 'sub_agent_tool_use',
    ].entries()) {
      const now = T + (i + 1) * M
      t.noteEvent(kind, now)
      expect(t.activityAt).toBe(now) // load-bearing: the stamp actually fired
    }
  })

  it('noteEvent stamps the turn-end clock on a real turn_end but the synthetic one does not stamp activity', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    t.noteEvent('turn_end', T + M, 5_000) // real turn end: activity + turn-end
    expect(t.activityAt).toBe(T + M)
    expect(t.turnEndedAt).toBe(T + M)
    // Gateway's synthetic turn_end (durationMs === -1): ends the turn, NOT activity.
    t.noteEvent('turn_end', T + 2 * M, -1)
    expect(t.activityAt).toBe(T + M) // unchanged — not real activity
    expect(t.turnEndedAt).toBe(T + 2 * M) // but the turn-end clock advanced
  })

  it('the re-entrancy guard (isDispatching) makes an overlapping tick a no-op until endDispatch', () => {
    // maybeIdleClear early-returns while a /clear inject is in flight
    // (gateway.ts: `if (idleTracker.isDispatching) return`). Model that gate
    // against the REAL tracker: begin a dispatch, then a tick that arrives
    // before the async inject settles must NOT fire a second clear, and normal
    // behaviour must resume once the dispatch ends.
    const T = 100 * H
    const t = new IdleTracker(T)
    const inputs = { idleClearMs: 3 * H, turnInFlight: false }

    // The window has elapsed → first tick clears and opens a dispatch.
    expect(t.isDispatching).toBe(false)
    expect(t.decide(T + 3 * H, inputs).clear).toBe(true)
    t.markClearFired()
    t.beginDispatch()
    expect(t.isDispatching).toBe(true)

    // A second tick arrives mid-dispatch. The gateway's guard short-circuits
    // BEFORE decide(), so no second clear fires. Assert both the guard signal
    // and that a bypassing decide() would still be latched off anyway.
    let secondClearFired = false
    if (!t.isDispatching) {
      // (unreached while dispatching — this is the gateway's guarded path)
      const { clear } = t.decide(T + 4 * H, inputs)
      if (clear) secondClearFired = true
    }
    expect(secondClearFired).toBe(false) // guard held: no double-dispatch
    // Even if the guard were bypassed, the fire-once latch blocks a re-clear.
    expect(t.decide(T + 4 * H, inputs).clear).toBe(false)

    // Dispatch settles. The guard reopens; still latched (no activity yet).
    t.endDispatch()
    expect(t.isDispatching).toBe(false)
    expect(t.decide(T + 5 * H, inputs).clear).toBe(false) // alreadyCleared

    // Fresh activity re-arms → normal behaviour resumes, one window later.
    t.noteInbound(T + 6 * H)
    expect(t.decide(T + 9 * H, inputs).clear).toBe(true)
  })

  it('the fire-once latch survives across ticks and re-arms only on activity', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    const inputs = { idleClearMs: 3 * H, turnInFlight: false }
    // Window elapsed → clears once, then latched.
    expect(t.decide(T + 3 * H, inputs).clear).toBe(true)
    t.markClearFired()
    expect(t.cleared).toBe(true)
    expect(t.decide(T + 4 * H, inputs).clear).toBe(false) // latched
    // Fresh activity re-arms.
    t.noteInbound(T + 5 * H)
    expect(t.cleared).toBe(false)
    expect(t.decide(T + 8 * H, inputs).clear).toBe(true) // one window after re-arm
  })
})

describe('IdleTracker #3116 — write-time re-eval suppresses a clear when activity arrives in the gap', () => {
  // maybeIdleClear latches `alreadyCleared=true` before the async /clear inject
  // (re-entrancy). The write-time precondition (`decideIgnoringLatch`) must
  // therefore judge idleness on the LIVE clocks, ignoring that latch, so a new
  // inbound in the check-to-send gap still aborts the buffered /clear.
  const inputs = { idleClearMs: 3 * H, turnInFlight: false }

  it('re-eval returns not-idle after an inbound lands in the gap (latch ignored)', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    // Gate fires at the window; gateway latches the fire-once guard.
    expect(t.decide(T + 3 * H, inputs).clear).toBe(true)
    t.markClearFired()
    t.beginDispatch()
    // Inbound arrives in the check-to-send gap → re-arms the activity clock.
    t.noteInbound(T + 3 * H + 5 * M)
    // Write-time re-eval (ignoring the latch) now sees a warm clock → abort.
    expect(t.decideIgnoringLatch(T + 3 * H + 6 * M, inputs).clear).toBe(false)
  })

  it('with no activity in the gap the write-time re-eval still says clear (latch ignored, not the gate)', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    expect(t.decide(T + 3 * H, inputs).clear).toBe(true)
    t.markClearFired()
    // No inbound; the clock is still cold → the buffered /clear proceeds.
    expect(t.decideIgnoringLatch(T + 3 * H + M, inputs).clear).toBe(true)
  })

  it('#3117 composes at write time: a background dispatch in the gap suppresses the buffered /clear', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    expect(t.decide(T + 3 * H, { ...inputs, backgroundWorkInFlight: false }).clear).toBe(true)
    t.markClearFired()
    // A detached worker gets dispatched in the gap → re-eval honours it for free.
    expect(
      t.decideIgnoringLatch(T + 3 * H + M, { ...inputs, backgroundWorkInFlight: true }).clear,
    ).toBe(false)
  })
})

describe('IdleTracker #3114 — a cron fire does not warm the clock, a human inbound does', () => {
  // Behavioural coverage that REPLACES 3114's source-text wiring pin: drives the
  // REAL isCronInjectFire predicate + the REAL IdleTracker through the exact
  // gateway rule (`if (!isCronInjectFire(meta)) tracker.noteInbound(now)`). A
  // regression in EITHER the predicate or the stamp fails this — the old
  // source-scrape asserted only that a string appeared in gateway.ts.

  /** The gateway's onInjectInbound stamp rule, applied to the real objects. */
  function injectFire(t: IdleTracker, meta: Record<string, unknown> | undefined, now: number): void {
    if (!isCronInjectFire(meta)) t.noteInbound(now)
  }

  it('frequent cron fires (cadence < window) never re-arm the clock → idle-clear still fires', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    const inputs = { idleClearMs: 3 * H, turnInFlight: false }
    // A cron fires every 10 min for well over the window, doing NO real work
    // (no session events). On main this re-armed the clock every fire → never idle.
    for (let now = T; now <= T + 3 * H + 30 * M; now += 10 * M) {
      injectFire(t, { session: 'cron', source: 'cron' }, now) // Tier-1 cheap cron
      injectFire(t, { source: 'cron' }, now) // Tier-2 main-session cron
    }
    // The clock never moved off T → the tracker is genuinely idle and clears.
    expect(t.activityAt).toBe(T)
    expect(t.decide(T + 3 * H, inputs).clear).toBe(true)
  })

  it('a genuine operator inbound (reaction/vault/resume/manual) DOES warm the clock', () => {
    const T = 100 * H
    const t = new IdleTracker(T)
    injectFire(t, { source: 'reaction' }, T + M)
    expect(t.activityAt).toBe(T + M)
    injectFire(t, undefined, T + 2 * M) // bare manual inject
    expect(t.activityAt).toBe(T + 2 * M)
    // And a warmed clock defers the clear a full window past the last inbound.
    const inputs = { idleClearMs: 3 * H, turnInFlight: false }
    expect(t.decide(T + 2 * M + 3 * H - 1, inputs).clear).toBe(false)
    expect(t.decide(T + 2 * M + 3 * H, inputs).clear).toBe(true)
  })
})

describe('decideIdleClear (pure gate)', () => {
  it('fires once the idle window has elapsed', () => {
    expect(decideIdleClear(state({ lastActivityAt: 0 }), 3 * H).clear).toBe(true)
    expect(decideIdleClear(state({ lastActivityAt: 0 }), 3 * H + 1).clear).toBe(true)
  })

  it('does NOT fire before the window', () => {
    expect(decideIdleClear(state({ lastActivityAt: 0 }), 3 * H - 1).clear).toBe(false)
  })

  it('never fires mid-turn (turnInFlight)', () => {
    expect(decideIdleClear(state({ lastActivityAt: 0, turnInFlight: true }), 10 * H).clear).toBe(false)
  })

  it('fires once per idle period (alreadyCleared guard)', () => {
    expect(decideIdleClear(state({ lastActivityAt: 0, alreadyCleared: true }), 10 * H).clear).toBe(false)
  })

  it('is disabled when idleClearMs <= 0', () => {
    expect(decideIdleClear(state({ lastActivityAt: 0, idleClearMs: 0 }), 10 * H).clear).toBe(false)
    expect(decideIdleClear(state({ lastActivityAt: 0, idleClearMs: -1 }), 10 * H).clear).toBe(false)
    // ...even with a fresh turn end in play.
    expect(
      decideIdleClear(state({ lastActivityAt: 0, lastTurnEndedAt: 9 * H, idleClearMs: 0 }), 10 * H).clear,
    ).toBe(false)
  })

  it('measures the window from max(lastActivityAt, lastTurnEndedAt)', () => {
    // Turn started at 0 (lastActivityAt), ended at 5h. At 5h the window has long
    // "elapsed" against the START — it must not be treated as idle.
    const justEnded = state({ lastActivityAt: 0, lastTurnEndedAt: 5 * H })
    expect(decideIdleClear(justEnded, 5 * H).clear).toBe(false)
    expect(decideIdleClear(justEnded, 8 * H - 1).clear).toBe(false)
    expect(decideIdleClear(justEnded, 8 * H).clear).toBe(true) // a full window after the END
    // Symmetric: activity newer than the turn end wins.
    const activeSince = state({ lastActivityAt: 6 * H, lastTurnEndedAt: 5 * H })
    expect(decideIdleClear(activeSince, 8 * H).clear).toBe(false)
    expect(decideIdleClear(activeSince, 9 * H).clear).toBe(true)
  })

  it('re-arms after activity (fresh lastActivityAt + alreadyCleared=false → waits again)', () => {
    const now = 100 * H
    const reArmed = state({ lastActivityAt: now, alreadyCleared: false })
    expect(decideIdleClear(reArmed, now + 3 * H - 1).clear).toBe(false) // not yet
    expect(decideIdleClear(reArmed, now + 3 * H).clear).toBe(true) // again, one window later
  })
})

describe('decideIdleClear: #3117 background-work suppressor', () => {
  it('suppresses the clear while a background sub-agent is in flight, even past the window', () => {
    // Window elapsed (10h >> 3h), main-turn gate open (turnInFlight:false), and
    // the activity clock is cold — yet a detached worker is in flight. On main
    // (no backgroundWorkInFlight branch) this would clear; the fix must not.
    const s = state({ lastActivityAt: 0, backgroundWorkInFlight: true })
    expect(decideIdleClear(s, 10 * H).clear).toBe(false)
  })

  it('allows the clear once background work is no longer in flight (TTL lapsed or dispatch cleared)', () => {
    const s = state({ lastActivityAt: 0, backgroundWorkInFlight: false })
    expect(decideIdleClear(s, 10 * H).clear).toBe(true)
  })

  it('undefined background flag preserves pre-#3117 behaviour (treated as false)', () => {
    const s = state({ lastActivityAt: 0 })
    delete (s as { backgroundWorkInFlight?: boolean }).backgroundWorkInFlight
    expect(decideIdleClear(s, 10 * H).clear).toBe(true)
  })
})

describe('#3117 end-to-end: pending dispatch TTL gates idle-clear', () => {
  // Drives the REAL pending-work-progress state (the source of
  // backgroundWorkInFlight) against decideIdleClear with an injected clock, so
  // the wiring — noteAsyncDispatch stamps, the TTL expires, the flag clears —
  // is exercised as an outcome, not mirrored.
  let clock = 0
  const KEY = 'chat-1:'

  beforeEach(() => {
    pendingProgress.__resetAllForTests()
    clock = 100 * H
    // Install a clock override without starting the real timer.
    pendingProgress.__setDepsForTests({
      editMessage: async () => {},
      nowMs: () => clock,
    })
  })
  afterEach(() => {
    pendingProgress.__setDepsForTests(null)
    pendingProgress.__resetAllForTests()
  })

  // Cold activity clock (started at 0, window long elapsed) held in the REAL
  // tracker; the gateway's exact background-work input is fed at decide time.
  const tracker = new IdleTracker(0)
  function decideNow(now: number): boolean {
    return tracker.decide(now, {
      idleClearMs: 3 * H,
      turnInFlight: false,
      backgroundWorkInFlight: pendingProgress.anyPendingAsyncDispatchWithin(
        pendingProgress.BACKGROUND_WORK_SUPPRESS_TTL_MS,
      ),
    }).clear
  }

  it('a pending dispatch inside the TTL suppresses the clear; past the TTL it self-heals', () => {
    // No dispatch yet → idle-clear fires (control).
    expect(decideNow(clock)).toBe(true)

    // Background worker dispatched. Now within the TTL: suppressed.
    pendingProgress.noteAsyncDispatch(KEY)
    expect(pendingProgress.hasPendingAsyncDispatch(KEY)).toBe(true)
    expect(decideNow(clock)).toBe(false)

    // Still within TTL (just under 30m) → still suppressed.
    clock += pendingProgress.BACKGROUND_WORK_SUPPRESS_TTL_MS - 1
    expect(decideNow(clock)).toBe(false)

    // TTL lapses (stuck/leaked flag) → suppression drops, idle-clear self-heals.
    clock += 2
    expect(pendingProgress.hasPendingAsyncDispatch(KEY)).toBe(true) // flag still set
    expect(decideNow(clock)).toBe(true)
  })

  it('a dispatch that clears (worker returned) re-allows the clear before the TTL', () => {
    pendingProgress.noteAsyncDispatch(KEY)
    expect(decideNow(clock)).toBe(false)
    // Worker handback / user inbound clears the pending flag well before TTL.
    clock += 5 * M
    pendingProgress.clearPending(KEY, 'handback')
    expect(decideNow(clock)).toBe(true)
  })

  it('a fresh dispatch re-arms the TTL (freshest legitimate work wins)', () => {
    pendingProgress.noteAsyncDispatch(KEY)
    // Advance to just before expiry, then a new dispatch re-stamps.
    clock += pendingProgress.BACKGROUND_WORK_SUPPRESS_TTL_MS - 1
    pendingProgress.noteAsyncDispatch(KEY)
    // Now advance past what WOULD have been the first dispatch's expiry.
    clock += 2
    expect(decideNow(clock)).toBe(false) // re-armed → still suppressed
  })
})

describe('idleDurationToMs', () => {
  it('parses s/m/h', () => {
    expect(idleDurationToMs('3h')).toBe(3 * H)
    expect(idleDurationToMs('90m')).toBe(90 * 60_000)
    expect(idleDurationToMs('7200s')).toBe(7_200_000)
    expect(idleDurationToMs('0s')).toBe(0) // disable sentinel
  })
  it('returns null on malformed input (caller falls back to default)', () => {
    expect(idleDurationToMs('3')).toBeNull()
    expect(idleDurationToMs('3d')).toBeNull()
    expect(idleDurationToMs('abc')).toBeNull()
    expect(idleDurationToMs('')).toBeNull()
  })
  it('default is 3h', () => {
    expect(DEFAULT_IDLE_CLEAR_MS).toBe(3 * H)
  })
})
