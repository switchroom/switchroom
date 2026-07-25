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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import { buildSilencePokeOptions } from '../gateway/liveness-wiring.js'
import { makeLivenessFixture, type TurnMapLike } from './helpers/liveness-wiring-fixture.js'

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

  /** Source lines with comments stripped — a canonical string in a comment must never pay for a code site. */
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })

  it('is wired with BOTH clauses ANDed — the near-miss this fix turns on', () => {
    const line = codeLines.find((l) => l.includes('isTurnLive:'))
    expect(line, 'isTurnLive must be wired in liveness-wiring.ts').toBeDefined()
    // EXACT text, not a bag of fragments. #3575 review: the previous form
    // asserted four independent regexes that each had to match SOMEWHERE on the
    // line, with nothing anchoring the end of the arrow body and nothing
    // forbidding extra conjuncts — so mutants SURVIVED it, including
    //   `!(A == null && B == null) && activeTurnStartedAt.get(key) != null`
    // which boolean-reduces to exactly the naive `activeTurnStartedAt`-only
    // predicate this test is NAMED after, plus `&& false` (reaper disabled for
    // every key) and an inverted `=== false`. Both halves must be present,
    // negated TOGETHER, and nothing else may be ANDed on:
    // `activeTurnStartedAt` ALONE is the wrong predicate, because
    // `releaseTurnBufferGate` clears it mid-turn on every final-answer reply,
    // so a predicate missing (or effectively cancelling) the `getCurrentTurn()`
    // clause silently reaps live turns doing post-answer work.
    //
    // #3580: the second clause is the KEYED read. `getCurrentTurn()` is the
    // most-recent-set MIRROR under SWITCHROOM_EMISSION_AUTHORITY=1, so an
    // unkeyed read answers about whichever topic started a turn LAST — not
    // about `key` — and false-reaps a live turn whose buffer gate was released.
    expect(line!.trim()).toBe(
      'isTurnLive: (key) => !(activeTurnStartedAt.get(key) == null && getCurrentTurnForKey(key) == null),',
    )
    // Belt and braces on the mutation the exact-equality pin exists for: the
    // reaper must not read the unkeyed singleton at all.
    expect(line!).not.toMatch(/getCurrentTurn\(\)/)
  })

  it('the two late-fire guards read keyed too — exact lines, so no site can drift back', () => {
    // #3580 M1: all three sites change TOGETHER. One keyed + two unkeyed leaves
    // the reaper and the guards disagreeing about liveness, which is worse than
    // the consistent-but-wrong state it replaces. Exact trimmed equality (not
    // fragment regexes) is the only form that forbids an extra conjunct.
    const guards = codeLines
      .map((l) => l.trim())
      .filter((t) => t.includes('activeTurnStartedAt.get(ctx.key)'))
    expect(guards).toEqual([
      // onMidTurnFloor
      'if (activeTurnStartedAt.get(ctx.key) == null && getCurrentTurnForKey(ctx.key) == null) return',
      // onFrameworkFallback
      'if (activeTurnStartedAt.get(ctx.key) == null && getCurrentTurnForKey(ctx.key) == null) {',
    ])
  })

  it('matches the late-fire guard it was deliberately copied from', () => {
    // Same condition, so a mid-turn buffer-gate release can never be reaped by
    // one and treated as live by the other. If someone tightens/loosens one
    // site only, the two drift and the reaper starts disagreeing with the guard.
    //
    // #3575 review: scan CODE only. Counting occurrences across the raw file let
    // an OR-for-AND swap survive by leaving the canonical text behind in a stale
    // comment — the comment paid for the missing code site.
    const code = codeLines.join('\n')
    const predicate = /activeTurnStartedAt\.get\(([\w.]+)\) == null && getCurrentTurnForKey\(\1\) == null/g
    expect((code.match(predicate) ?? []).length).toBe(3)
    // ...and no site may drift BACK to the unkeyed singleton read (#3580).
    const unkeyed = /activeTurnStartedAt\.get\([\w.]+\) == null && getCurrentTurn\(\) == null/g
    expect(code.match(unkeyed) ?? []).toEqual([])
  })

  // #3575 review B3 — EXECUTE the real predicate. The previous version of this
  // block re-typed the expression by hand into a local `productionPredicate`,
  // which by construction cannot detect divergence from the wiring it claims to
  // cover. `buildSilencePokeOptions` is a pure function of its deps (its only
  // gateway import is `import type`), so the real options object — including the
  // real `isTurnLive` closure — can be built here.
  function realPredicate(activeTurnStartedAt: Map<string, number>, currentTurn: object | null) {
    const fx = makeLivenessFixture()
    for (const [k, v] of activeTurnStartedAt) fx.activeTurnStartedAt.set(k, v)
    fx.setCurrentTurn(currentTurn)
    const isTurnLive = buildSilencePokeOptions(fx.deps).isTurnLive
    expect(isTurnLive, 'the wiring must supply isTurnLive').toBeTypeOf('function')
    return isTurnLive!
  }

  it('calls a mid-turn buffer-gate release LIVE (the near-miss), where the naive predicate would not', () => {
    const m = new Map<string, number>()
    m.set(KEY, 0)
    const liveTurn = { turnId: 'c:3#1' }
    // `releaseTurnBufferGate` / `finalizeStatusReaction('done')` fire mid-turn
    // on every final-answer reply and clear this entry while the turn runs on.
    m.delete(KEY)
    expect(realPredicate(m, liveTurn)(KEY)).toBe(true)
    // The predicate I nearly shipped — activeTurnStartedAt alone — would have
    // reaped this live turn, permanently and silently.
    const naive = (key: string) => m.get(key) != null
    expect(naive(KEY)).toBe(false)
  })

  it('calls a genuinely finished turn DEAD (so the reap still happens)', () => {
    expect(realPredicate(new Map(), null)(KEY)).toBe(false)
  })

  it('calls a turn with its gate still set LIVE even when the singleton is null', () => {
    const m = new Map<string, number>([[KEY, 0]])
    expect(realPredicate(m, null)(KEY)).toBe(true)
  })

  // #3580 — the case #3575 could only DOCUMENT (as "with BOTH signals dead the
  // tick reaps, even mid-turn") is now FIXED, so this asserts the opposite
  // outcome. `releaseTurnBufferGate` (turn-end.ts) deletes the
  // `activeTurnStartedAt` entry on EVERY reply finalize — including a mid-turn
  // interim ack — while the turn keeps running. Under
  // SWITCHROOM_EMISSION_AUTHORITY=1 the singleton is a most-recent-set MIRROR,
  // so once topic B started and ended a turn the UNKEYED read said null for
  // topic A too: A read dead on BOTH clauses and was false-reaped — permanent
  // and silent (nothing re-arms until the next `startTurn`), costing A its
  // mid-turn beat and its 300 s #1122 unwedge. The keyed read resolves A's OWN
  // entry, so A stays armed.
  //
  // The `CurrentTurnMap` here is the REAL production class, re-imported with
  // the flag ON through its read-once seam (mirroring per-topic-current-turn's
  // `loadMap`) — not a hand-modelled stand-in of the mirror semantics.
  async function loadFlagOnTurnMap(): Promise<TurnMapLike> {
    const prev = process.env.SWITCHROOM_EMISSION_AUTHORITY
    process.env.SWITCHROOM_EMISSION_AUTHORITY = '1'
    try {
      vi.resetModules()
      const mod = await import('../gateway/current-turn-map.js')
      expect(mod.EMISSION_AUTHORITY_ENABLED, 'the re-import seam must observe the flag').toBe(true)
      return new mod.CurrentTurnMap<unknown>() as unknown as TurnMapLike
    } finally {
      if (prev == null) delete process.env.SWITCHROOM_EMISSION_AUTHORITY
      else process.env.SWITCHROOM_EMISSION_AUTHORITY = prev
    }
  }

  const KEY_B = '-100999:22'

  it('flag-ON: a mid-turn topic A survives topic B starting AND ending a turn (the false reap #3580 closes)', async () => {
    const emitted: SilencePokeMetric[] = []
    const fallbacks: FrameworkFallbackContext[] = []
    const turnMap = await loadFlagOnTurnMap()
    const fx = makeLivenessFixture({}, turnMap)
    const turnA = { turnId: 'a#1', sessionChatId: '-100999', sessionThreadId: 11 }
    const turnB = { turnId: 'b#1', sessionChatId: '-100999', sessionThreadId: 22 }

    // Topic A is live for THIS key.
    fx.activeTurnStartedAt.set(KEY, 0)
    fx.setCurrentTurnForKey(KEY, turnA)
    __setDepsForTests({
      ...buildSilencePokeOptions(fx.deps),
      emitMetric: (e) => emitted.push(e),
      onFrameworkFallback: async (ctx) => { fallbacks.push(ctx) },
    })
    startTurn(KEY, 0)
    __tickForTests(5_000)
    expect(__getStateForTests(KEY)).toBeDefined()

    // A's final answer lands: releaseTurnBufferGate drops A's activeTurnStartedAt
    // entry while A keeps doing post-answer work.
    fx.activeTurnStartedAt.delete(KEY)
    // Then topic B starts (flipping the most-recent-set mirror off A) and ends.
    fx.setCurrentTurnForKey(KEY_B, turnB)
    fx.deps.endCurrentTurnForKey(turnB as never, KEY_B)

    // Ground truth of the trap: BOTH signals a naive/unkeyed reader consults
    // now say "dead" for A, even though A is running.
    expect(fx.activeTurnStartedAt.get(KEY) == null).toBe(true)
    expect(fx.deps.getCurrentTurn() == null).toBe(true)
    // ...but the keyed read still resolves A's own topic.
    expect(fx.deps.getCurrentTurnForKey(KEY)).toBe(turnA)

    __tickForTests(10_000)

    // The outcome that matters: A is NOT reaped, so it keeps its mid-turn beat.
    expect(__getStateForTests(KEY)).toBeDefined()
    expect(emitted.some((e) => e.kind === 'silence_poke_orphan_reaped')).toBe(false)
    // ...and its 300 s unwedge still fires — the #1122 protection survives.
    __tickForTests(310_000)
    expect(fallbacks.map((f) => f.key)).toEqual([KEY])
  })

  it('flag-ON: a topic whose OWN turn ended is still reaped (the keyed read did not disable the reaper)', async () => {
    const emitted: SilencePokeMetric[] = []
    const turnMap = await loadFlagOnTurnMap()
    const fx = makeLivenessFixture({}, turnMap)
    const turnA = { turnId: 'a#1', sessionChatId: '-100999', sessionThreadId: 11 }
    const turnB = { turnId: 'b#1', sessionChatId: '-100999', sessionThreadId: 22 }

    fx.activeTurnStartedAt.set(KEY, 0)
    fx.setCurrentTurnForKey(KEY, turnA)
    // A live sibling B exists the whole time — under an unkeyed read its
    // presence would have kept the dead A armed forever.
    fx.setCurrentTurnForKey(KEY_B, turnB)
    __setDepsForTests({
      ...buildSilencePokeOptions(fx.deps),
      emitMetric: (e) => emitted.push(e),
      onFrameworkFallback: async () => {},
    })
    startTurn(KEY, 0)
    __tickForTests(5_000)
    expect(__getStateForTests(KEY)).toBeDefined()

    // A ends via a path that forgot endTurn(): gate cleared, keyed entry gone.
    fx.activeTurnStartedAt.delete(KEY)
    fx.deps.endCurrentTurnForKey(turnA as never, KEY)
    __tickForTests(10_000)

    expect(__getStateForTests(KEY)).toBeUndefined()
    expect(emitted.filter((e) => e.kind === 'silence_poke_orphan_reaped')).toHaveLength(1)
  })

  it('keeps a live turn armed whenever EITHER liveness signal survives (the conjunction is load-bearing)', () => {
    // The two survivable shapes of the buffer-gate window, through the real
    // predicate on the real tick. Either signal alone must hold the state.
    for (const shape of ['gate-only', 'singleton-only'] as const) {
      __resetAllForTests()
      const emitted: SilencePokeMetric[] = []
      const fx = makeLivenessFixture()
      if (shape === 'gate-only') fx.activeTurnStartedAt.set(KEY, 0)
      else fx.setCurrentTurn({ turnId: 'a#1' })
      __setDepsForTests({
        ...buildSilencePokeOptions(fx.deps),
        emitMetric: (e) => emitted.push(e),
        onFrameworkFallback: async () => {},
      })
      startTurn(KEY, 0)
      __tickForTests(10_000)
      expect(__getStateForTests(KEY), shape).toBeDefined()
      expect(emitted.some((e) => e.kind === 'silence_poke_orphan_reaped'), shape).toBe(false)
    }
  })
})
