import { describe, it, expect } from 'vitest'
import {
  decideIdleClear,
  idleDurationToMs,
  DEFAULT_IDLE_CLEAR_MS,
  type IdleClearState,
} from '../gateway/idle-clear.js'

const H = 3_600_000
function state(p: Partial<IdleClearState>): IdleClearState {
  return { lastActivityAt: 0, idleClearMs: 3 * H, alreadyCleared: false, turnInFlight: false, ...p }
}

describe('decideIdleClear', () => {
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
  })

  it('re-arms after activity (fresh lastActivityAt + alreadyCleared=false → waits again)', () => {
    // Simulated: after a clear, activity resets lastActivityAt to `now` and the flag.
    const now = 100 * H
    const reArmed = state({ lastActivityAt: now, alreadyCleared: false })
    expect(decideIdleClear(reArmed, now + 3 * H - 1).clear).toBe(false) // not yet
    expect(decideIdleClear(reArmed, now + 3 * H).clear).toBe(true) // again, one window later
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
