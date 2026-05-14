import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startTurn,
  noteOutbound,
  noteSubagentDispatch,
  noteThinking,
  noteToolStart,
  noteToolEnd,
  noteToolLabel,
  consumeArmedPoke,
  endTurn,
  silencePokeEnabled,
  formatPokeText,
  formatFrameworkFallbackText,
  __tickForTests,
  __setDepsForTests,
  __getStateForTests,
  __resetAllForTests,
  DEFAULT_THRESHOLDS,
  type SilencePokeMetric,
  type FrameworkFallbackContext,
} from '../silence-poke.js'

const ORIGINAL_KILL_SWITCH = process.env.SWITCHROOM_DISABLE_SILENCE_POKE

interface TestFixtures {
  emitted: SilencePokeMetric[]
  fallbacks: FrameworkFallbackContext[]
}

function setupDeps(opts?: { thresholds?: Partial<typeof DEFAULT_THRESHOLDS> }): TestFixtures {
  const fixtures: TestFixtures = { emitted: [], fallbacks: [] }
  __setDepsForTests({
    emitMetric: (e) => fixtures.emitted.push(e),
    onFrameworkFallback: (ctx) => { fixtures.fallbacks.push(ctx) },
    thresholdsMs: { ...DEFAULT_THRESHOLDS, ...(opts?.thresholds ?? {}) },
  })
  return fixtures
}

beforeEach(() => {
  __resetAllForTests()
  delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
})

afterEach(() => {
  __resetAllForTests()
  if (ORIGINAL_KILL_SWITCH != null) process.env.SWITCHROOM_DISABLE_SILENCE_POKE = ORIGINAL_KILL_SWITCH
  else delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
})

describe('silence-poke — kill switch', () => {
  it('startTurn is a no-op when SWITCHROOM_DISABLE_SILENCE_POKE=1', () => {
    process.env.SWITCHROOM_DISABLE_SILENCE_POKE = '1'
    expect(silencePokeEnabled()).toBe(false)
    startTurn('k', 1000)
    expect(__getStateForTests('k')).toBeUndefined()
  })

  it('startTurn is a no-op when SWITCHROOM_DISABLE_SILENCE_POKE=true', () => {
    process.env.SWITCHROOM_DISABLE_SILENCE_POKE = 'true'
    startTurn('k', 1000)
    expect(__getStateForTests('k')).toBeUndefined()
  })

  it('is enabled when kill switch is unset', () => {
    expect(silencePokeEnabled()).toBe(true)
    startTurn('k', 1000)
    expect(__getStateForTests('k')).toBeDefined()
  })
})

describe('silence-poke — escalation ladder', () => {
  it('soft poke fires at 75s', () => {
    const fx = setupDeps()
    startTurn('chat:0', 0)

    __tickForTests(70_000) // before threshold
    expect(consumeArmedPoke()).toBeNull()
    expect(fx.emitted).toHaveLength(0)

    __tickForTests(75_000) // at threshold
    expect(fx.emitted).toEqual([
      expect.objectContaining({ kind: 'silence_poke_fired', level: 'soft', subagent_wait: false }),
    ])
    const text = consumeArmedPoke()
    expect(text).toContain('[silence-poke]')
    expect(text).toContain('75s')
  })

  it('firm poke fires at 180s after soft', () => {
    const fx = setupDeps()
    startTurn('chat:0', 0)
    __tickForTests(75_000)
    consumeArmedPoke() // drain the soft
    __tickForTests(180_000)
    expect(fx.emitted.map((e) => e.kind)).toEqual([
      'silence_poke_fired',
      'silence_poke_fired',
    ])
    expect(fx.emitted[1]).toMatchObject({ level: 'firm' })
    const firm = consumeArmedPoke()
    expect(firm).toContain('3 minutes silent')
  })

  it('framework fallback fires at 300s with kind=working when no thinking signal', () => {
    const fx = setupDeps()
    startTurn('chatX:42', 0)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    expect(fx.fallbacks).toEqual([
      expect.objectContaining({ chatId: 'chatX', threadId: 42, fallbackKind: 'working' }),
    ])
    expect(fx.emitted.at(-1)).toMatchObject({ kind: 'silence_fallback_sent', fallback_kind: 'working' })
  })

  it('framework fallback fires with kind=thinking if a thinking event landed within 30s', () => {
    const fx = setupDeps()
    startTurn('c:0', 0)
    noteThinking('c:0', 280_000)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    expect(fx.fallbacks).toEqual([
      expect.objectContaining({ fallbackKind: 'thinking' }),
    ])
  })

  it('framework fallback fires at most once per turn', () => {
    const fx = setupDeps()
    startTurn('c:0', 0)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    __tickForTests(450_000) // continued silence
    __tickForTests(600_000)
    expect(fx.fallbacks).toHaveLength(1)
  })
})

describe('silence-poke — outbound resets clock + success measurement', () => {
  it('noteOutbound resets the silence clock', () => {
    setupDeps()
    startTurn('k', 0)
    noteOutbound('k', 50_000)
    __tickForTests(120_000) // 70s after outbound — under 75s soft threshold
    expect(consumeArmedPoke()).toBeNull()
  })

  it('emits silence_poke_succeeded when outbound lands within success window after a poke', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000) // soft poke armed
    noteOutbound('k', 80_000) // 5s later — within 15s success window
    expect(fx.emitted.map((e) => e.kind)).toContain('silence_poke_succeeded')
    const success = fx.emitted.find((e) => e.kind === 'silence_poke_succeeded')!
    expect(success).toMatchObject({ level: 'soft', latency_ms: 5_000 })
  })

  it('does NOT emit silence_poke_succeeded if outbound is later than the success window', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    noteOutbound('k', 95_000) // 20s later — outside 15s window
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_succeeded')).toHaveLength(0)
  })

  it('outbound resets pokesFired so the next 75s silence can re-arm', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000) // soft fires
    noteOutbound('k', 100_000) // reset
    __tickForTests(180_000) // 80s since outbound — under threshold
    __tickForTests(180_000 + 50_000) // would be 130s if not reset; still no fire because clock zero = 100_000, so silence = 130s
    // Actually 230 - 100 = 130s past outbound, > 75s soft threshold:
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired')).toHaveLength(2)
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired').at(-1)).toMatchObject({ level: 'soft' })
  })
})

describe('silence-poke — subagent dispatch extension', () => {
  it('extends soft threshold to 300s when noteSubagentDispatch was called', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteSubagentDispatch('k')
    __tickForTests(120_000) // past 75s but under 300s subagent threshold
    expect(fx.emitted).toHaveLength(0)
    __tickForTests(300_000)
    expect(fx.emitted).toHaveLength(1)
    expect(fx.emitted[0]).toMatchObject({ level: 'soft', subagent_wait: true })
  })

  it('subagent flag PERSISTS through narrating outbound (PR4 fix)', () => {
    // Reviewer note from PR2 #1125 — the parent's "spinning up @reviewer"
    // narration is the outbound that opens the wait. Clearing the
    // subagent flag at that moment would defeat the extended-threshold
    // guarantee for the wait that follows. The flag must persist until
    // endTurn().
    const fx = setupDeps()
    startTurn('k', 0)
    noteSubagentDispatch('k')
    noteOutbound('k', 60_000) // parent narrates "spinning up @reviewer"
    // Subagent wait continues. With the flag persistent, soft threshold
    // is still 300s, so a 90s gap should NOT fire.
    __tickForTests(60_000 + 90_000)
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired')).toHaveLength(0)
    // At 300s past the outbound, the soft poke fires (subagent wait
    // is genuinely long).
    __tickForTests(60_000 + 300_000)
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired')).toHaveLength(1)
    expect(fx.emitted[0]).toMatchObject({ level: 'soft', subagent_wait: true })
  })

  it('subagent flag clears on endTurn', () => {
    setupDeps()
    startTurn('k', 0)
    noteSubagentDispatch('k')
    // Take snapshot
    const before = __getStateForTests('k')
    expect(before?.subagentDispatchActive).toBe(true)
    endTurn('k')
    expect(__getStateForTests('k')).toBeUndefined()
  })

  // CC-5 defensive invariant (`docs/status-ask-cause-classes.md`):
  // the original catalog claim was that `subagentDispatchActive` can
  // leak across turns if `endTurn` is skipped (turn dies abnormally,
  // gateway crashes between turn_end signal and cleanup). Investigation
  // shows the claim doesn't hold — `startTurn` calls `state.set(key, ...)`
  // unconditionally with `subagentDispatchActive: false`, so the next
  // turn's startTurn wipes any stale flag.
  //
  // We're pinning that invariant here as a regression guard. If a future
  // refactor changes `startTurn` to a read-modify-write (merge instead
  // of overwrite), this test breaks immediately. Keeps the catalog's
  // worry productive: even though it's not currently a bug, the
  // invariant that makes it not-a-bug is now load-bearing.
  it('startTurn overwrites stale subagentDispatchActive when endTurn was skipped (CC-5 invariant)', () => {
    const fx = setupDeps()
    // Turn 1: dispatch a subagent, then SKIP endTurn (simulating an
    // abnormal abort path — context-exhaustion, gateway crash mid-turn,
    // etc).
    startTurn('k', 0)
    noteSubagentDispatch('k')
    expect(__getStateForTests('k')?.subagentDispatchActive).toBe(true)

    // Turn 2 in the same key: startTurn MUST clear the flag.
    startTurn('k', 1_000_000)
    expect(__getStateForTests('k')?.subagentDispatchActive).toBe(false)

    // Verify the soft poke fires at the normal 75s threshold, not at
    // the extended 300s subagentSoft threshold. If the flag had leaked,
    // ticking at 75s after the new turn start would find subagentSoft
    // active and skip the fire.
    __tickForTests(1_000_000 + 75_000)
    const fired = fx.emitted.filter((e) => e.kind === 'silence_poke_fired')
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ level: 'soft', subagent_wait: false })
  })
})

// Pin the contract the gateway must uphold for ABNORMAL turn-ends:
// every code path that abandons a turn before turn_end (context-
// exhaust bail, gateway-side wedge timeout, silent-end recovery)
// MUST call `endTurn(key)`. If it doesn't, the silence-poke state
// lingers in the Map and the 300s framework fallback fires later
// for a turn the gateway already considers dead — sending the user
// a "still working… (no update from agent in 5 min)" message that
// contradicts the gateway's earlier "⚠️ Context window full" / etc.
//
// Surfaced during CC-5 investigation (`docs/status-ask-cause-classes.md`).
// The fix lives in the gateway (context-exhaust path adds the
// endTurn call); these tests pin the invariant at the silence-poke
// level so the contract is verifiable in isolation of the gateway.
describe('silence-poke — abnormal turn-end invariants (CC-5 follow-up)', () => {
  it('endTurn before the 300s fallback threshold prevents the fallback from firing', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    // Soft + firm pokes arm; turn is alive and the model could still
    // recover.
    __tickForTests(75_000)
    __tickForTests(180_000)
    // Gateway aborts the turn at t=250s (context exhaust, wedge,
    // crash teardown — any abnormal bail). The contract: endTurn
    // gets called BEFORE the 300s threshold.
    endTurn('k')
    // Five minutes total elapse from the original turn start. If
    // endTurn left the state in the Map, the framework fallback
    // would fire here. The contract is: it MUST NOT.
    __tickForTests(300_000)
    expect(fx.fallbacks).toHaveLength(0)
    expect(
      fx.emitted.filter((e) => e.kind === 'silence_fallback_sent'),
    ).toHaveLength(0)
  })

  it('endTurn after a soft poke fired does not later emit a stale fallback', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000) // soft fires
    expect(
      fx.emitted.filter((e) => e.kind === 'silence_poke_fired'),
    ).toHaveLength(1)
    // Turn aborts well before firm/fallback thresholds.
    endTurn('k')
    __tickForTests(180_000)
    __tickForTests(300_000)
    // No firm, no fallback after the turn-abort.
    expect(
      fx.emitted.filter((e) => e.kind === 'silence_poke_fired'),
    ).toHaveLength(1) // unchanged: only the original soft
    expect(fx.fallbacks).toHaveLength(0)
  })

  // #1289: the flush-backstop turn-end branch in the gateway (the path
  // taken when the agent emits assistant text but never calls the reply
  // tool) was retrofitted in #1067 to null `currentTurn` early but never
  // had `silencePoke.endTurn` added — leaving state2 populated so the
  // 300s framework fallback fired after the gateway already flushed the
  // captured prose and considered the turn over. Pin the contract at
  // the silence-poke level: a turn that records an outbound (the
  // flushed message) and then calls endTurn must not later fire a
  // fallback even if 300s elapses from the original turn start.
  it('#1289: flush-backstop turn-end (outbound + endTurn) suppresses the 300s fallback', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    // Some time passes while the agent generates prose without calling
    // the reply tool. No soft/firm armed yet.
    __tickForTests(60_000)
    // Gateway turn-flush fires: captured text is sent as an outbound,
    // then the flush branch nulls currentTurn AND (post-fix) calls
    // signalTracker.clear + silencePoke.endTurn.
    noteOutbound('k', 60_000)
    endTurn('k')
    // 300s elapses from the original turn start. Pre-fix: the framework
    // fallback fired here. Post-fix: the state is drained, no fallback.
    __tickForTests(240_000)
    expect(fx.fallbacks).toHaveLength(0)
    expect(
      fx.emitted.filter((e) => e.kind === 'silence_fallback_sent'),
    ).toHaveLength(0)
  })
})

// #1292 — drive a deterministic, tool-aware fallback message from the
// gateway's `tool_use` / `tool_result` event stream. The progress card
// was retired in #1122 PR3 in favour of the conversational shape; the
// remaining honesty gap was that the 300s framework fallback said
// "still working… no update in 5 min" on turns where the agent was
// clearly grinding through tool calls. These tests pin the behaviour:
// the silence clock is NOT reset by tool churn (header invariant
// preserved), but the fallback message body becomes tool-aware so the
// user sees the actual observable.
describe('silence-poke — #1292 tool-aware framework fallback', () => {
  it('fallback context exposes in-flight tool snapshot with duration', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteToolStart('k', 'T1', 'Grep', 'foo', 30_000)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(305_000)
    expect(fx.fallbacks).toHaveLength(1)
    const ctx = fx.fallbacks[0]!
    expect(ctx.inFlightTools).toHaveLength(1)
    expect(ctx.inFlightTools[0]!.name).toBe('Grep')
    expect(ctx.inFlightTools[0]!.label).toBe('foo')
    expect(ctx.inFlightTools[0]!.durationMs).toBe(305_000 - 30_000)
  })

  it('formatFrameworkFallbackText names the longest-running tool with duration', () => {
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'Grep', label: '"foo"', durationMs: 275_000 },
    ])
    expect(text).toBe(
      'running Grep "foo" for 5m (no update from agent in 5 min)',
    )
  })

  it('multiple in-flight tools render as "+ N more"', () => {
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'Grep', label: '"foo"', durationMs: 275_000 },
      { name: 'Read', label: 'config.ts', durationMs: 120_000 },
      { name: 'Bash', label: null, durationMs: 60_000 },
    ])
    expect(text).toBe(
      'running Grep "foo" + 2 more for 5m (no update from agent in 5 min)',
    )
  })

  it('tool with no label renders the bare name', () => {
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'Bash', label: null, durationMs: 305_000 },
    ])
    expect(text).toBe(
      'running Bash for 5m (no update from agent in 5 min)',
    )
  })

  it('empty inFlightTools falls back to the base "still working" wording', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, []),
    ).toBe('still working… (no update from agent in 5 min)')
    expect(
      formatFrameworkFallbackText('thinking', 305_000, []),
    ).toBe('still thinking… (no update from agent in 5 min)')
    // No third arg → same as empty array.
    expect(
      formatFrameworkFallbackText('working', 305_000),
    ).toBe('still working… (no update from agent in 5 min)')
  })

  it('tool-aware wording wins over "thinking" — the actual observable beats the inferred kind', () => {
    const text = formatFrameworkFallbackText('thinking', 305_000, [
      { name: 'Grep', label: '"foo"', durationMs: 305_000 },
    ])
    expect(text.startsWith('running Grep')).toBe(true)
    expect(text).not.toContain('still thinking')
  })

  it('tool completed before the fallback → empty snapshot → base wording', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteToolStart('k', 'T1', 'Grep', 'foo', 30_000)
    noteToolEnd('k', 'T1', 200_000)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(305_000)
    expect(fx.fallbacks).toHaveLength(1)
    expect(fx.fallbacks[0]!.inFlightTools).toHaveLength(0)
  })

  it('late noteToolLabel updates the in-flight entry in place', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteToolStart('k', 'T1', 'Grep', null, 30_000)
    noteToolLabel('k', 'T1', '"refined-from-sidecar"')
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(305_000)
    expect(fx.fallbacks[0]!.inFlightTools[0]!.label).toBe('"refined-from-sidecar"')
  })

  it('endTurn drains inFlightTools', () => {
    setupDeps()
    startTurn('k', 0)
    noteToolStart('k', 'T1', 'Grep', 'foo', 30_000)
    expect(__getStateForTests('k')!.inFlightTools.size).toBe(1)
    endTurn('k')
    // A fresh turn under the same key has an empty map.
    startTurn('k', 1_000_000)
    expect(__getStateForTests('k')!.inFlightTools.size).toBe(0)
  })

  it('parallel tools sort by startedAt ascending — longest-running rendered first', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    // Order intentionally NOT chronological to verify sort.
    noteToolStart('k', 'T-late', 'Read', 'recent.ts', 250_000)
    noteToolStart('k', 'T-early', 'Grep', '"oldest"', 20_000)
    noteToolStart('k', 'T-mid', 'Bash', null, 100_000)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(305_000)
    const snap = fx.fallbacks[0]!.inFlightTools
    expect(snap.map(t => t.name)).toEqual(['Grep', 'Bash', 'Read'])
  })

  it('tool churn does NOT reset the silence clock (header invariant preserved)', () => {
    // The whole point of #1292 (b) over (a) is that we enrich the
    // fallback TEXT, never the timing. Tool activity must not delay
    // or suppress the soft/firm/fallback escalation ladder.
    const fx = setupDeps()
    startTurn('k', 0)
    // A constant stream of tool churn through the entire 5min window —
    // each tool ends quickly so inFlightTools is empty by fallback.
    for (let t = 5_000; t <= 295_000; t += 10_000) {
      noteToolStart('k', `T-${t}`, 'Grep', 'foo', t)
      noteToolEnd('k', `T-${t}`, t + 500)
    }
    __tickForTests(75_000) // soft
    __tickForTests(180_000) // firm
    __tickForTests(305_000) // fallback
    expect(
      fx.emitted.filter(e => e.kind === 'silence_poke_fired'),
    ).toHaveLength(2)
    expect(fx.fallbacks).toHaveLength(1)
  })

  it('Task tool sets subagentDispatchActive AND populates inFlightTools', () => {
    // Two flags are independent: the soft-threshold extension still
    // works for sub-agent waits (existing behaviour), AND the fallback
    // message names the Task tool as the actual observable.
    const fx = setupDeps()
    startTurn('k', 0)
    // Gateway calls both for a Task tool_use (mirrors the wiring at
    // gateway.ts onSessionEvent).
    noteSubagentDispatch('k')
    noteToolStart('k', 'T1', 'Task', 'spinning up @researcher', 10_000)
    // Soft threshold extends to 300s under subagent — so no soft poke
    // fires at 75s and no firm fires at 180s (firm requires pokesFired===1,
    // i.e. soft must fire first). Once we cross the 300s subagent-soft,
    // soft fires; each tick fires one level via the `continue` in tick(),
    // so we need three ticks to walk soft → firm → fallback.
    __tickForTests(75_000)   // suppressed by subagent
    __tickForTests(180_000)  // still suppressed
    __tickForTests(305_000)  // soft fires (subagent soft = 300s)
    __tickForTests(305_001)  // firm fires
    __tickForTests(305_002)  // fallback fires
    expect(fx.fallbacks).toHaveLength(1)
    const snap = fx.fallbacks[0]!.inFlightTools
    expect(snap[0]!.name).toBe('Task')
    expect(snap[0]!.label).toBe('spinning up @researcher')
  })

  it('noteToolStart on an unknown key is a no-op (no crash, no state)', () => {
    setupDeps()
    // No startTurn first — silence-poke ignores the call.
    noteToolStart('k-never-started', 'T1', 'Grep', 'foo', 30_000)
    expect(__getStateForTests('k-never-started')).toBeUndefined()
  })

  it('noteToolEnd on an unknown id is a no-op', () => {
    setupDeps()
    startTurn('k', 0)
    noteToolEnd('k', 'never-started', 100_000)
    expect(__getStateForTests('k')!.inFlightTools.size).toBe(0)
  })

  it('formatFrameworkFallbackText sub-minute durations render as "Ns"', () => {
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'Grep', label: 'foo', durationMs: 12_000 },
    ])
    expect(text).toBe(
      'running Grep foo for 12s (no update from agent in 5 min)',
    )
  })

  it('formatFrameworkFallbackText truncates very long labels', () => {
    const longLabel = '"' + 'x'.repeat(120) + '"'
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'Grep', label: longLabel, durationMs: 305_000 },
    ])
    // 60-char cap (with trailing ellipsis) — verify clipping without
    // pinning exact bytes.
    expect(text.length).toBeLessThan(120)
    expect(text).toContain('…')
  })
})

describe('silence-poke — consumeArmedPoke draining', () => {
  it('drains the armed flag so the next call returns null', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    expect(consumeArmedPoke()).not.toBeNull()
    expect(consumeArmedPoke()).toBeNull()
  })

  it('returns null when nothing is armed', () => {
    setupDeps()
    startTurn('k', 0)
    expect(consumeArmedPoke()).toBeNull()
  })

  it('returns the matching level text', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    expect(consumeArmedPoke()).toContain('75s')
    __tickForTests(180_000)
    expect(consumeArmedPoke()).toContain('3 minutes')
  })
})

describe('silence-poke — endTurn cleanup', () => {
  it('endTurn drops state', () => {
    setupDeps()
    startTurn('k', 0)
    expect(__getStateForTests('k')).toBeDefined()
    endTurn('k')
    expect(__getStateForTests('k')).toBeUndefined()
  })

  it('endTurn on an unknown key is a no-op', () => {
    setupDeps()
    expect(() => endTurn('never-tracked')).not.toThrow()
  })
})

describe('silence-poke — independence across turns', () => {
  it('two turns in different chats fire independently', () => {
    const fx = setupDeps()
    startTurn('a:0', 0)
    startTurn('b:0', 0)
    noteOutbound('a:0', 50_000)
    __tickForTests(75_000)
    // a's clock was reset to 50_000, silence=25s — no fire.
    // b's clock is still at 0, silence=75s — soft fires.
    expect(fx.emitted).toHaveLength(1)
    expect(fx.emitted[0]).toMatchObject({ key: 'b:0', level: 'soft' })
  })
})

describe('silence-poke — fallback handler errors do not break timer', () => {
  it('continues to function if onFrameworkFallback throws', () => {
    const fx: TestFixtures = { emitted: [], fallbacks: [] }
    __setDepsForTests({
      emitMetric: (e) => fx.emitted.push(e),
      onFrameworkFallback: () => { throw new Error('oh no') },
      thresholdsMs: DEFAULT_THRESHOLDS,
    })
    startTurn('k', 0)
    expect(() => {
      __tickForTests(75_000)
      __tickForTests(180_000)
      __tickForTests(300_000)
    }).not.toThrow()
    // Telemetry still emitted
    expect(fx.emitted.some((e) => e.kind === 'silence_fallback_sent')).toBe(true)
  })

  it('continues to function if onFrameworkFallback returns a rejected promise', async () => {
    const fx: TestFixtures = { emitted: [], fallbacks: [] }
    __setDepsForTests({
      emitMetric: (e) => fx.emitted.push(e),
      onFrameworkFallback: () => Promise.reject(new Error('async fail')),
      thresholdsMs: DEFAULT_THRESHOLDS,
    })
    startTurn('k', 0)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    // Allow microtasks for the rejection-catch to fire
    await new Promise((r) => setTimeout(r, 0))
    expect(fx.emitted.some((e) => e.kind === 'silence_fallback_sent')).toBe(true)
  })
})

describe('silence-poke — system reminder text', () => {
  it('soft poke text references the 75s threshold and contains the system-reminder marker', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    const text = consumeArmedPoke()
    expect(text).toContain('[silence-poke]')
    expect(text).toContain('75s')
    expect(text).toContain('about to finish')
  })

  it('firm poke text references the 3-minute threshold', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    consumeArmedPoke()
    __tickForTests(180_000)
    const text = consumeArmedPoke()
    expect(text).toContain('3 minutes')
    expect(text).toContain('stuck')
  })
})

// CC-4 from `docs/status-ask-cause-classes.md`: wording is load-bearing
// (`reference/conversational-pacing.md` § Silence-poke ladder). Snapshot
// the exact strings here so a refactor that drops a key phrase fails
// loud at test time. If you genuinely need to change the wording,
// update the snapshot AND the design doc together.
describe('silence-poke — wording snapshots (CC-4)', () => {
  it('soft poke text is unchanged', () => {
    expect(formatPokeText('soft')).toMatchInlineSnapshot(
      `"[silence-poke] You've been silent to the user for 75s. If you're still working on this, send one short conversational reply — e.g. "still going, working through X" — so they know you're alive. Keep it brief; don't restate the task. If you're about to finish within the next few seconds, skip the update."`,
    )
  })

  it('firm poke text is unchanged', () => {
    expect(formatPokeText('firm')).toMatchInlineSnapshot(
      `"[silence-poke] 3 minutes silent. Please send an update now — what you're working on, or whether you're stuck. If something is taking unusually long (slow tool, network, waiting on a sub-agent), say so explicitly."`,
    )
  })

  it('framework fallback — working at 300s', () => {
    expect(formatFrameworkFallbackText('working', 300_000)).toMatchInlineSnapshot(
      `"still working… (no update from agent in 5 min)"`,
    )
  })

  it('framework fallback — thinking at 300s', () => {
    expect(formatFrameworkFallbackText('thinking', 300_000)).toMatchInlineSnapshot(
      `"still thinking… (no update from agent in 5 min)"`,
    )
  })

  it('framework fallback — minutes derived from silenceMs, not hard-coded', () => {
    // The "N min" suffix MUST track ctx.silenceMs so the wording stays
    // honest if the 300s threshold is tuned. If a refactor accidentally
    // hard-codes "5 min", these cases break.
    expect(formatFrameworkFallbackText('working', 360_000)).toBe(
      'still working… (no update from agent in 6 min)',
    )
    expect(formatFrameworkFallbackText('working', 600_000)).toBe(
      'still working… (no update from agent in 10 min)',
    )
  })

  it('framework fallback — minutes floor at 1 even when silenceMs is small', () => {
    // Defensive: a future caller might invoke with sub-minute silenceMs.
    // Rendering "0 min" reads as nonsense; floor at 1.
    expect(formatFrameworkFallbackText('working', 30_000)).toBe(
      'still working… (no update from agent in 1 min)',
    )
    expect(formatFrameworkFallbackText('working', 0)).toBe(
      'still working… (no update from agent in 1 min)',
    )
  })
})

describe('silence-poke — performance', () => {
  it('tick over many active turns stays fast', () => {
    setupDeps()
    for (let i = 0; i < 1000; i++) {
      startTurn(`chat${i}:0`, 0)
    }
    const start = performance.now()
    __tickForTests(75_000)
    const elapsed = performance.now() - start
    // 1000 turns should tick in well under 50ms — guards against an
    // accidentally-quadratic implementation.
    expect(elapsed).toBeLessThan(50)
  })
})
