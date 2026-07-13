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

import { describe, it, expect } from 'vitest'
import {
  decideIdleClear,
  classifyIdleEvent,
  idleDurationToMs,
  DEFAULT_IDLE_CLEAR_MS,
  decideBackgroundSuppression,
  DEFAULT_IDLE_BG_SUPPRESS_TTL_MS,
  type IdleClearState,
} from '../gateway/idle-clear.js'

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

describe('decideBackgroundSuppression (#3117 — TTL-bounded suppressor)', () => {
  const TTL = 30 * M

  it('no background work → not suppressing, clock reset', () => {
    const d = decideBackgroundSuppression({
      backgroundInFlight: false,
      suppressingSince: 5 * H,
      now: 6 * H,
      ttlMs: TTL,
    })
    expect(d).toEqual({ suppress: false, suppressingSince: null })
  })

  it('first observation of in-flight work → start the clock and suppress', () => {
    const now = 100 * H
    const d = decideBackgroundSuppression({
      backgroundInFlight: true,
      suppressingSince: null,
      now,
      ttlMs: TTL,
    })
    expect(d).toEqual({ suppress: true, suppressingSince: now })
  })

  it('in-flight and within TTL → keeps suppressing from the original since', () => {
    const since = 100 * H
    const d = decideBackgroundSuppression({
      backgroundInFlight: true,
      suppressingSince: since,
      now: since + TTL - 1,
      ttlMs: TTL,
    })
    expect(d).toEqual({ suppress: true, suppressingSince: since })
  })

  it('in-flight but past TTL → STOPS suppressing (self-heals), retains since', () => {
    const since = 100 * H
    const d = decideBackgroundSuppression({
      backgroundInFlight: true,
      suppressingSince: since,
      now: since + TTL,
      ttlMs: TTL,
    })
    expect(d).toEqual({ suppress: false, suppressingSince: since })
  })

  it('default TTL is 30m', () => {
    expect(DEFAULT_IDLE_BG_SUPPRESS_TTL_MS).toBe(30 * M)
  })
})

describe('idle-clear + background suppressor — end-to-end outcomes (#3117)', () => {
  const TTL = 30 * M
  // Mirror the gateway's maybeIdleClear loop EXACTLY: run the base decider
  // first; if it would NOT clear, reset the suppression clock and stop; if it
  // WOULD clear, apply the TTL-bounded background suppressor (whose clock is
  // measured from this would-be-clear point).
  function run(opts: {
    idleClearMs: number
    ttlMs: number
    /** returns whether background work is in flight at time `now` */
    bgInFlight: (now: number) => boolean
    lastActivityAt: number
    from: number
    to: number
  }): number[] {
    let since: number | null = null
    let alreadyCleared = false
    const clears: number[] = []
    for (let now = opts.from; now <= opts.to; now += TICK) {
      const { clear: wouldClear } = decideIdleClear(
        {
          lastActivityAt: opts.lastActivityAt,
          lastTurnEndedAt: null,
          idleClearMs: opts.idleClearMs,
          alreadyCleared,
          turnInFlight: false,
        },
        now,
      )
      if (!wouldClear) {
        since = null
        continue
      }
      const bg = decideBackgroundSuppression({
        backgroundInFlight: opts.bgInFlight(now),
        suppressingSince: since,
        now,
        ttlMs: opts.ttlMs,
      })
      since = bg.suppressingSince
      if (bg.suppress) continue
      alreadyCleared = true
      clears.push(now)
    }
    return clears
  }

  it('a silent background worker in flight past the window (within TTL) is NOT cleared', () => {
    const T = 100 * H
    // Worker in flight the whole time, emits nothing. Idle window 3h.
    const clears = run({
      idleClearMs: 3 * H,
      ttlMs: TTL,
      bgInFlight: () => true,
      lastActivityAt: T,
      from: T,
      // window elapses at T+3h; suppression starts then and holds for TTL.
      to: T + 3 * H + TTL - TICK,
    })
    expect(clears).toEqual([])
  })

  it('a background flag stuck past window+TTL → clear STILL eventually fires (not disabled forever)', () => {
    const T = 100 * H
    const clears = run({
      idleClearMs: 3 * H,
      ttlMs: TTL,
      bgInFlight: () => true, // stuck flag: never clears
      lastActivityAt: T,
      from: T,
      to: T + 3 * H + TTL + 5 * TICK,
    })
    // Suppression engages when the window elapses (~T+3h) and self-heals TTL
    // later, so the clear fires once, near T + 3h + TTL.
    expect(clears).toHaveLength(1)
    expect(clears[0]).toBeGreaterThanOrEqual(T + 3 * H + TTL)
    expect(clears[0]).toBeLessThan(T + 3 * H + TTL + 2 * TICK)
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
