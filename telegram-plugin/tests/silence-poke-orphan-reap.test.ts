/**
 * switchroom#3552 — the silence-poke timer leak.
 *
 * `startTurn(key)` arms per-turn state that only `endTurn(key)` drops. Several
 * turn-end paths never reached an `endTurn` call (bridge death via
 * `disconnect-flush`, keyed teardowns that bypass the `turn_end` handler), so
 * the state outlived its turn and was disarmed only when the 300s fallback
 * eventually fired against the dead key, recognised the late fire and logged
 * `turn_ended_cleanly_during_window` — 504 such skips vs 110 real fires in 14
 * days on the fleet.
 *
 * The fix is the `isTurnLive` reaper predicate consulted on every poll tick.
 * These tests assert the OUTCOME (state gone, no fallback delivered, real fires
 * unaffected), not merely that the code path runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  startTurn,
  noteOutbound,
  __tickForTests,
  __setDepsForTests,
  __getStateForTests,
  __resetAllForTests,
  DEFAULT_THRESHOLDS,
  type SilencePokeMetric,
  type FrameworkFallbackContext,
} from '../silence-poke.js'

const ORIGINAL_KILL_SWITCH = process.env.SWITCHROOM_DISABLE_SILENCE_POKE

interface Fixtures {
  emitted: SilencePokeMetric[]
  fallbacks: FrameworkFallbackContext[]
  live: Set<string>
}

function setup(opts?: { wireReaper?: boolean }): Fixtures {
  const f: Fixtures = { emitted: [], fallbacks: [], live: new Set<string>() }
  __setDepsForTests({
    emitMetric: (e) => f.emitted.push(e),
    onFrameworkFallback: (ctx) => { f.fallbacks.push(ctx) },
    thresholdsMs: { ...DEFAULT_THRESHOLDS },
    ...(opts?.wireReaper === false ? {} : { isTurnLive: (key: string) => f.live.has(key) }),
  })
  return f
}

beforeEach(() => {
  __resetAllForTests()
  delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
})

afterEach(() => {
  __resetAllForTests()
  if (ORIGINAL_KILL_SWITCH == null) delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
  else process.env.SWITCHROOM_DISABLE_SILENCE_POKE = ORIGINAL_KILL_SWITCH
})

describe('#3552 silence-poke orphan reap', () => {
  const KEY = '-100999:_'

  it('drops state on the next tick once the turn is no longer live — no 300s wait', () => {
    const f = setup()
    f.live.add(KEY)
    startTurn(KEY, 0)
    __tickForTests(5_000)
    expect(__getStateForTests(KEY)).toBeDefined()

    // The turn ends via a path that forgot to call endTurn().
    f.live.delete(KEY)
    __tickForTests(10_000)

    expect(__getStateForTests(KEY)).toBeUndefined()
    expect(f.emitted.filter((e) => e.kind === 'silence_poke_orphan_reaped')).toHaveLength(1)
    // The outcome that matters: the 300s fallback can never fire for this key.
    __tickForTests(400_000)
    expect(f.fallbacks).toHaveLength(0)
  })

  it('does NOT reap a turn that is still live but silent — the real fire still happens', () => {
    const f = setup()
    f.live.add(KEY)
    startTurn(KEY, 0)

    __tickForTests(299_000)
    expect(f.fallbacks).toHaveLength(0)
    expect(__getStateForTests(KEY)).toBeDefined()

    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1)
    expect(f.fallbacks[0]!.key).toBe(KEY)
    expect(f.emitted.some((e) => e.kind === 'silence_poke_orphan_reaped')).toBe(false)
  })

  it('does NOT reap a live turn that merely released its buffer gate mid-turn', () => {
    // `releaseTurnBufferGate` clears `activeTurnStartedAt` on every final-answer
    // reply while the turn keeps running. The production predicate ANDs that
    // with "no current turn", so the key stays live here — silence-poke must
    // keep watching the post-answer housekeeping work.
    const f = setup()
    f.live.add(KEY)
    startTurn(KEY, 0)
    noteOutbound(KEY, 1_000) // the final answer landed; gate released, turn alive
    __tickForTests(60_000)
    expect(__getStateForTests(KEY)).toBeDefined()
    expect(f.emitted.some((e) => e.kind === 'silence_poke_orphan_reaped')).toBe(false)
  })

  it('reaps only the dead key, leaving a live sibling topic armed', () => {
    const f = setup()
    const DEAD = '-100999:11'
    const LIVE = '-100999:22'
    f.live.add(DEAD)
    f.live.add(LIVE)
    startTurn(DEAD, 0)
    startTurn(LIVE, 0)

    f.live.delete(DEAD)
    __tickForTests(10_000)

    expect(__getStateForTests(DEAD)).toBeUndefined()
    expect(__getStateForTests(LIVE)).toBeDefined()
  })

  it('is inert when the predicate is not wired (back-compat harnesses)', () => {
    const f = setup({ wireReaper: false })
    startTurn(KEY, 0)
    __tickForTests(10_000)
    expect(__getStateForTests(KEY)).toBeDefined()
    expect(f.emitted.some((e) => e.kind === 'silence_poke_orphan_reaped')).toBe(false)
  })
})
