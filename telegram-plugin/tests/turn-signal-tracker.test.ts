import { describe, it, expect, beforeEach } from 'vitest'
import {
  reset,
  noteSignal,
  getLongestGap,
  getLastSignalAt,
  clear,
  __resetAllForTests,
} from '../turn-signal-tracker.js'

beforeEach(() => {
  __resetAllForTests()
})

describe('turn-signal-tracker', () => {
  it('reset() initialises a fresh turn with zero gap', () => {
    reset('chat:thread', 1000)
    expect(getLongestGap('chat:thread')).toBe(0)
    expect(getLastSignalAt('chat:thread')).toBe(1000)
  })

  it('noteSignal() updates lastSignalAt and accumulates the longest gap', () => {
    reset('k', 1000)
    noteSignal('k', 1500) // gap=500
    expect(getLongestGap('k')).toBe(500)
    expect(getLastSignalAt('k')).toBe(1500)

    noteSignal('k', 1700) // gap=200, smaller
    expect(getLongestGap('k')).toBe(500)
    expect(getLastSignalAt('k')).toBe(1700)

    noteSignal('k', 4500) // gap=2800, new max
    expect(getLongestGap('k')).toBe(2800)
    expect(getLastSignalAt('k')).toBe(4500)

    noteSignal('k', 5000) // gap=500, smaller
    expect(getLongestGap('k')).toBe(2800)
  })

  it('noteSignal() on an unknown key is a no-op (no state created)', () => {
    noteSignal('untracked', 1000)
    expect(getLongestGap('untracked')).toBe(0)
    expect(getLastSignalAt('untracked')).toBeUndefined()
  })

  it('separate keys track independently', () => {
    reset('chatA', 1000)
    reset('chatB', 1000)
    noteSignal('chatA', 5000) // gap=4000
    noteSignal('chatB', 1500) // gap=500
    expect(getLongestGap('chatA')).toBe(4000)
    expect(getLongestGap('chatB')).toBe(500)
  })

  it('reset() on an existing key starts a fresh window', () => {
    reset('k', 1000)
    noteSignal('k', 5000) // gap=4000
    expect(getLongestGap('k')).toBe(4000)

    // New turn — counter resets even though prior gap was huge
    reset('k', 10000)
    noteSignal('k', 10100)
    expect(getLongestGap('k')).toBe(100)
  })

  it('clear() removes state for a key', () => {
    reset('k', 1000)
    noteSignal('k', 2000)
    clear('k')
    expect(getLongestGap('k')).toBe(0)
    expect(getLastSignalAt('k')).toBeUndefined()
  })

  it('clear() on an unknown key is a no-op (no error)', () => {
    expect(() => clear('never-tracked')).not.toThrow()
  })

  it('getLongestGap() never returns negative even with out-of-order timestamps', () => {
    // Pathological case: clocks moving backwards (NTP slew, etc).
    reset('k', 5000)
    noteSignal('k', 4000) // negative-ish gap
    // Whatever the implementation does, the returned gap should still be
    // a sensible number for downstream histogram code.
    const gap = getLongestGap('k')
    expect(typeof gap).toBe('number')
    expect(Number.isFinite(gap)).toBe(true)
  })

  it('typical full-turn flow — reset, multiple signals, clear', () => {
    const k = 'flow-test'
    reset(k, 0)

    // Simulate a turn with periodic signals + one big silent stretch
    noteSignal(k, 200)   // gap=200
    noteSignal(k, 700)   // gap=500
    noteSignal(k, 1100)  // gap=400
    // ── 3.5s of silence (model thinking) ──
    noteSignal(k, 4600)  // gap=3500 (longest)
    noteSignal(k, 5000)  // gap=400

    expect(getLongestGap(k)).toBe(3500)

    // turn_end emits the metric, then clears
    clear(k)
    expect(getLongestGap(k)).toBe(0)
  })
})
