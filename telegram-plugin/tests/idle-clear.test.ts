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
  type IdleClearState,
} from '../gateway/idle-clear.js'
import * as pendingProgress from '../pending-work-progress.js'

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
 * A minimal model of the gateway's idle bookkeeping, driven by a virtual clock.
 * Mirrors gateway.ts: `markIdleActivity()` on inbound / cron / ANY session
 * event, `markIdleTurnEnd()` on a turn ending, `decideIdleClear()` on each
 * IDLE_CLEAR_CHECK_MS tick, `alreadyCleared` latched on fire.
 */
class IdleModel {
  lastActivityAt: number
  lastTurnEndedAt: number | null = null
  alreadyCleared = false
  turnInFlight = false
  clears: number[] = []

  constructor(
    startedAt: number,
    readonly idleClearMs = 3 * H,
  ) {
    this.lastActivityAt = startedAt
  }

  /** A claude session-stream event (the gateway's handleSessionEvent stamp). */
  sessionEvent(kind: string, now: number, durationMs?: number): void {
    const signal = classifyIdleEvent(kind, durationMs)
    if (signal.activity) {
      this.lastActivityAt = now
      this.alreadyCleared = false
    }
    if (signal.turnEnded) this.lastTurnEndedAt = now
  }

  /** Inbound / cron fire. */
  activity(now: number): void {
    this.lastActivityAt = now
    this.alreadyCleared = false
  }

  tick(now: number): boolean {
    const { clear } = decideIdleClear(
      {
        lastActivityAt: this.lastActivityAt,
        lastTurnEndedAt: this.lastTurnEndedAt,
        idleClearMs: this.idleClearMs,
        alreadyCleared: this.alreadyCleared,
        turnInFlight: this.turnInFlight,
      },
      now,
    )
    if (clear) {
      this.alreadyCleared = true
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
    const m = new IdleModel(T)

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
    const m = new IdleModel(T)
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
    const m = new IdleModel(T)
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
    const m = new IdleModel(T)
    m.ticksThrough(T, T + 6 * H)
    expect(m.clears).toEqual([T + 3 * H])
  })

  it('cleared once per idle period, and re-arms on the next inbound', () => {
    const T = 100 * H
    const m = new IdleModel(T)
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
    const m = new IdleModel(T)
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

  function decideNow(now: number): boolean {
    return decideIdleClear(
      {
        lastActivityAt: 0, // cold activity clock — window long elapsed
        lastTurnEndedAt: null,
        idleClearMs: 3 * H,
        alreadyCleared: false,
        turnInFlight: false,
        backgroundWorkInFlight: pendingProgress.anyPendingAsyncDispatchWithin(
          pendingProgress.BACKGROUND_WORK_SUPPRESS_TTL_MS,
        ),
      },
      now,
    ).clear
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
