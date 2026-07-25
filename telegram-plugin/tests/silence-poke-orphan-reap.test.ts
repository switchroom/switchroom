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
import { readFileSync } from 'fs'
import { join } from 'path'
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

  it('the stubbed-live case: state survives while the predicate reports live (rule only, NOT the predicate)', () => {
    // NAMING IS DELIBERATE. This test stubs `isTurnLive`, so it asserts the
    // silence-poke RULE ("never reap a key the predicate calls live") and
    // nothing about the production predicate itself — it would pass identically
    // against a wrong predicate. The predicate is covered separately below, in
    // '#3552 — the production isTurnLive predicate'; do not read this one as
    // coverage of the buffer-gate near-miss.
    const f = setup()
    f.live.add(KEY)
    startTurn(KEY, 0)
    noteOutbound(KEY, 1_000)
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

describe('#3552 — the production isTurnLive predicate', () => {
  // The highest-blast-radius line in this PR is the predicate wired at
  // liveness-wiring.ts, and every behavioural test above STUBS it. A false reap
  // is permanent and silent — nothing re-arms until the next `startTurn` — so
  // the predicate gets its own coverage: a structural pin on the real source
  // (the technique this repo already uses for gateway-resident callbacks that
  // cannot be instantiated in a unit test), plus a behavioural model of the two
  // gateway maps it reads.
  const src = readFileSync(join(__dirname, '..', 'gateway', 'liveness-wiring.ts'), 'utf8')
  const KEY = '-100999:11'

  it('is wired with BOTH clauses ANDed — the near-miss this fix turns on', () => {
    const line = src.split('\n').find((l) => l.includes('isTurnLive:'))
    expect(line, 'isTurnLive must be wired in liveness-wiring.ts').toBeDefined()
    // Both halves must be present, negated together. `activeTurnStartedAt`
    // ALONE is the wrong predicate: `releaseTurnBufferGate` clears it mid-turn
    // on every final-answer reply, so a predicate missing the `getCurrentTurn()`
    // clause silently reaps live turns doing post-answer work.
    expect(line!).toMatch(/activeTurnStartedAt\.get\(key\) == null/)
    expect(line!).toMatch(/getCurrentTurn\(\) == null/)
    expect(line!).toMatch(/&&/)
    expect(line!).toMatch(/^\s*isTurnLive: \(key\) => !\(/)
  })

  it('matches the late-fire guard it was deliberately copied from', () => {
    // Same condition, so a mid-turn buffer-gate release can never be reaped by
    // one and treated as live by the other. If someone tightens/loosens one
    // site only, the two drift and the reaper starts disagreeing with the guard.
    const predicate = /activeTurnStartedAt\.get\([\w.]+\) == null && getCurrentTurn\(\) == null/g
    expect((src.match(predicate) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  // Behavioural model of the SAME expression over the two gateway maps, so the
  // buffer-gate case is asserted as an outcome rather than by stubbing.
  const productionPredicate = (
    activeTurnStartedAt: Map<string, number>,
    currentTurn: object | null,
  ) => (key: string) => !(activeTurnStartedAt.get(key) == null && currentTurn == null)

  it('calls a mid-turn buffer-gate release LIVE (the near-miss), where the naive predicate would not', () => {
    const m = new Map<string, number>()
    m.set(KEY, 0)
    const liveTurn = { turnId: 'c:3#1' }
    // `releaseTurnBufferGate` / `finalizeStatusReaction('done')` fire mid-turn
    // on every final-answer reply and clear this entry while the turn runs on.
    m.delete(KEY)
    expect(productionPredicate(m, liveTurn)(KEY)).toBe(true)
    // The predicate I nearly shipped — activeTurnStartedAt alone — would have
    // reaped this live turn, permanently and silently.
    const naive = (key: string) => m.get(key) != null
    expect(naive(KEY)).toBe(false)
  })

  it('calls a genuinely finished turn DEAD (so the reap still happens)', () => {
    expect(productionPredicate(new Map(), null)(KEY)).toBe(false)
  })

  it('calls a turn with its gate still set LIVE even when the singleton is null', () => {
    const m = new Map<string, number>([[KEY, 0]])
    expect(productionPredicate(m, null)(KEY)).toBe(true)
  })
})
