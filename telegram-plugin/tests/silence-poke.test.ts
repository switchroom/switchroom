import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  startTurn,
  noteOutbound,
  noteThinking,
  noteToolStart,
  noteToolEnd,
  noteToolLabel,
  endTurn,
  silenceMsForKey,
  silencePokeEnabled,
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

function setupDeps(opts?: {
  thresholds?: Partial<typeof DEFAULT_THRESHOLDS> & { fallbackHardCeiling?: number }
  deferFallbackWhileToolInFlight?: boolean
}): TestFixtures {
  const fixtures: TestFixtures = { emitted: [], fallbacks: [] }
  __setDepsForTests({
    emitMetric: (e) => fixtures.emitted.push(e),
    onFrameworkFallback: (ctx) => { fixtures.fallbacks.push(ctx) },
    thresholdsMs: {
      ...DEFAULT_THRESHOLDS,
      ...(opts?.thresholds ?? {}),
    },
    ...(opts?.deferFallbackWhileToolInFlight != null
      ? { deferFallbackWhileToolInFlight: opts.deferFallbackWhileToolInFlight }
      : {}),
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

// Post-retirement: the model-targeted nudge ladder (ack/soft/firm) and
// the 60s awareness ping are gone. The ONLY framework action left is the
// 300s fallback, which the gateway turns into a user-visible "still
// working…" message AND an unwedge. These tests pin that single terminal
// action.
describe('silence-poke — framework fallback (the only remaining action)', () => {
  it('does not fire before the 300s threshold', () => {
    const fx = setupDeps()
    startTurn('chat:0', 0)
    __tickForTests(120_000)
    __tickForTests(299_000)
    expect(fx.fallbacks).toHaveLength(0)
    expect(fx.emitted).toHaveLength(0)
  })

  it('fires at 300s with kind=working when no thinking signal', () => {
    const fx = setupDeps()
    startTurn('chatX:42', 0)
    __tickForTests(300_000)
    expect(fx.fallbacks).toEqual([
      expect.objectContaining({ chatId: 'chatX', threadId: 42, fallbackKind: 'working' }),
    ])
    expect(fx.emitted.at(-1)).toMatchObject({ kind: 'silence_fallback_sent', fallback_kind: 'working' })
  })

  it('fires with kind=thinking if a thinking event landed within 30s', () => {
    const fx = setupDeps()
    startTurn('c:0', 0)
    noteThinking('c:0', 280_000)
    __tickForTests(300_000)
    expect(fx.fallbacks).toEqual([
      expect.objectContaining({ fallbackKind: 'thinking' }),
    ])
  })

  it('fires at most once per turn', () => {
    const fx = setupDeps()
    startTurn('c:0', 0)
    __tickForTests(300_000)
    __tickForTests(450_000) // continued silence
    __tickForTests(600_000)
    expect(fx.fallbacks).toHaveLength(1)
  })
})

describe('silence-poke — outbound resets the silence clock', () => {
  it('noteOutbound pushes the fallback measurement to the last outbound', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteOutbound('k', 250_000)
    // 300s from turn start, but only 50s since the outbound — no fire.
    __tickForTests(300_000)
    expect(fx.fallbacks).toHaveLength(0)
    // 300s after the outbound — now it fires.
    __tickForTests(550_000)
    expect(fx.fallbacks).toHaveLength(1)
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
describe('silence-poke — abnormal turn-end invariants (CC-5 follow-up)', () => {
  it('endTurn before the 300s fallback threshold prevents the fallback from firing', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(180_000) // turn alive; model could still recover
    // Gateway aborts the turn at t=250s (context exhaust, wedge,
    // crash teardown — any abnormal bail) BEFORE the 300s threshold.
    endTurn('k')
    // Five minutes total elapse. If endTurn left the state in the Map,
    // the framework fallback would fire here. The contract: it MUST NOT.
    __tickForTests(300_000)
    expect(fx.fallbacks).toHaveLength(0)
    expect(
      fx.emitted.filter((e) => e.kind === 'silence_fallback_sent'),
    ).toHaveLength(0)
  })

  // #1289: the flush-backstop turn-end branch in the gateway (the path
  // taken when the agent emits assistant text but never calls the reply
  // tool) was retrofitted in #1067 to null `currentTurn` early but never
  // had `silencePoke.endTurn` added — leaving state populated so the
  // 300s framework fallback fired after the gateway already flushed the
  // captured prose and considered the turn over. Pin the contract: a
  // turn that records an outbound (the flushed message) and then calls
  // endTurn must not later fire a fallback even if 300s elapses from the
  // original turn start.
  it('#1289: flush-backstop turn-end (outbound + endTurn) suppresses the 300s fallback', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(60_000)
    noteOutbound('k', 60_000)
    endTurn('k')
    __tickForTests(360_000)
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

  it('raw mcp__ tool name with a human label drops the technical name and leads with the label', () => {
    // mcp__hindsight__reflect is the internal MCP identifier — looks
    // like a leak when surfaced to a user. The label table emits
    // "Searching memory" for it (see hooks/tool-label-pretool.mjs);
    // the fallback message should lead with the label, not concatenate
    // both.
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'mcp__hindsight__reflect', label: 'Searching memory', durationMs: 305_000 },
    ])
    expect(text).toBe(
      'Searching memory for 5m (no update from agent in 5 min)',
    )
  })

  it('raw mcp__ tool name with NO label falls back to the bare name (no leak-but-no-better-option)', () => {
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'mcp__some-third-party__do_thing', label: null, durationMs: 305_000 },
    ])
    expect(text).toBe(
      'running mcp__some-third-party__do_thing for 5m (no update from agent in 5 min)',
    )
  })

  it('built-in tool (Grep) with a label keeps the prior "running Name label" shape — name is already human-readable', () => {
    const text = formatFrameworkFallbackText('working', 305_000, [
      { name: 'Grep', label: 'foo', durationMs: 305_000 },
    ])
    expect(text).toBe(
      'running Grep foo for 5m (no update from agent in 5 min)',
    )
  })

  it('empty inFlightTools falls back to the base "still working" wording', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, []),
    ).toBe('still working… (no update from agent in 5 min)')
    expect(
      formatFrameworkFallbackText('thinking', 305_000, []),
    ).toBe('still thinking… (no update from agent in 5 min)')
    expect(
      formatFrameworkFallbackText('working', 305_000),
    ).toBe('still working… (no update from agent in 5 min)')
  })

  it('blockedOnApproval names the real blocker instead of the dishonest "still working…"', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [], true),
    ).toBe('waiting for your approval — tap Approve or Deny on the card above (5 min)')
  })

  it('blockedOnApproval takes precedence over an in-flight tool (a tool awaiting approval is not "running")', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'Bash', label: 'rm -rf build', durationMs: 305_000 },
      ], true),
    ).toBe('waiting for your approval — tap Approve or Deny on the card above (5 min)')
  })

  it('blockedOnApproval=false keeps the existing wording (default, back-compat)', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [], false),
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
    __tickForTests(305_000)
    expect(fx.fallbacks).toHaveLength(1)
    expect(fx.fallbacks[0]!.inFlightTools).toHaveLength(0)
  })

  it('late noteToolLabel updates the in-flight entry in place', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteToolStart('k', 'T1', 'Grep', null, 30_000)
    noteToolLabel('k', 'T1', '"refined-from-sidecar"')
    __tickForTests(305_000)
    expect(fx.fallbacks[0]!.inFlightTools[0]!.label).toBe('"refined-from-sidecar"')
  })

  it('endTurn drains inFlightTools', () => {
    setupDeps()
    startTurn('k', 0)
    noteToolStart('k', 'T1', 'Grep', 'foo', 30_000)
    expect(__getStateForTests('k')!.inFlightTools.size).toBe(1)
    endTurn('k')
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
    __tickForTests(305_000)
    const snap = fx.fallbacks[0]!.inFlightTools
    expect(snap.map(t => t.name)).toEqual(['Grep', 'Bash', 'Read'])
  })

  it('tool churn does NOT reset the silence clock (header invariant preserved)', () => {
    // The whole point of #1292 (b) over (a) is that we enrich the
    // fallback TEXT, never the timing. Tool activity must not delay
    // or suppress the 300s fallback.
    const fx = setupDeps()
    startTurn('k', 0)
    // A constant stream of tool churn through the entire 5min window —
    // each tool ends quickly so inFlightTools is empty by fallback.
    for (let t = 5_000; t <= 295_000; t += 10_000) {
      noteToolStart('k', `T-${t}`, 'Grep', 'foo', t)
      noteToolEnd('k', `T-${t}`, t + 500)
    }
    __tickForTests(305_000)
    expect(fx.fallbacks).toHaveLength(1)
  })

  it('silenceMsForKey reports silence from last outbound (or turn start), null when unknown', () => {
    setupDeps()
    startTurn('k', 1_000)
    // No outbound yet → silence measured from turnStartedAt.
    expect(silenceMsForKey('k', 1_000 + 120_000)).toBe(120_000)
    noteOutbound('k', 1_000 + 50_000)
    // After an outbound → silence measured from lastOutboundAt.
    expect(silenceMsForKey('k', 1_000 + 120_000)).toBe(70_000)
    // Unknown key / ended turn → null (used by the sibling purge to treat a
    // dangling key as stale).
    expect(silenceMsForKey('never-started', 999_999)).toBeNull()
    endTurn('k')
    expect(silenceMsForKey('k', 999_999)).toBeNull()
  })

  it('Task tool populates inFlightTools so the fallback names it as the observable', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    // Gateway calls noteToolStart for a Task tool_use (mirrors the
    // wiring at gateway.ts onSessionEvent).
    noteToolStart('k', 'T1', 'Task', 'spinning up @researcher', 10_000)
    __tickForTests(305_000)
    expect(fx.fallbacks).toHaveLength(1)
    const snap = fx.fallbacks[0]!.inFlightTools
    expect(snap[0]!.name).toBe('Task')
    expect(snap[0]!.label).toBe('spinning up @researcher')
  })

  it('noteToolStart on an unknown key is a no-op (no crash, no state)', () => {
    setupDeps()
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
    expect(text.length).toBeLessThan(120)
    expect(text).toContain('…')
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
    noteOutbound('a:0', 250_000)
    __tickForTests(300_000)
    // a's clock was reset to 250_000 (silence=50s) — no fire.
    // b's clock is still at 0 (silence=300s) — fallback fires.
    expect(fx.fallbacks).toHaveLength(1)
    expect(fx.fallbacks[0]).toMatchObject({ key: 'b:0' })
  })
})

describe('silence-poke — fallback handler errors do not break timer', () => {
  it('continues to function if onFrameworkFallback throws', () => {
    const fx: TestFixtures = { emitted: [], fallbacks: [] }
    __setDepsForTests({
      emitMetric: (e) => fx.emitted.push(e),
      onFrameworkFallback: () => { throw new Error('oh no') },
      thresholdsMs: { ...DEFAULT_THRESHOLDS },
    })
    startTurn('k', 0)
    expect(() => {
      __tickForTests(300_000)
    }).not.toThrow()
    expect(fx.emitted.some((e) => e.kind === 'silence_fallback_sent')).toBe(true)
  })

  it('continues to function if onFrameworkFallback returns a rejected promise', async () => {
    const fx: TestFixtures = { emitted: [], fallbacks: [] }
    __setDepsForTests({
      emitMetric: (e) => fx.emitted.push(e),
      onFrameworkFallback: () => Promise.reject(new Error('async fail')),
      thresholdsMs: { ...DEFAULT_THRESHOLDS },
    })
    startTurn('k', 0)
    __tickForTests(300_000)
    await new Promise((r) => setTimeout(r, 0))
    expect(fx.emitted.some((e) => e.kind === 'silence_fallback_sent')).toBe(true)
  })
})

// CC-4 from `docs/status-ask-cause-classes.md`: wording is load-bearing
// (`reference/conversational-pacing.md` § Safety net). Snapshot the exact
// strings here so a refactor that drops a key phrase fails loud at test
// time. If you genuinely need to change the wording, update the snapshot
// AND the design doc together.
describe('silence-poke — wording snapshots (CC-4)', () => {
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
    expect(formatFrameworkFallbackText('working', 360_000)).toBe(
      'still working… (no update from agent in 6 min)',
    )
    expect(formatFrameworkFallbackText('working', 600_000)).toBe(
      'still working… (no update from agent in 10 min)',
    )
  })

  it('framework fallback — minutes floor at 1 even when silenceMs is small', () => {
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
    __tickForTests(75_000) // under fallback threshold — pure iteration cost
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)
  })
})

// ─── Fix A: defer the unwedge while a parent tool is genuinely in flight ──────
// A long quiet tool stretch (foreground sub-agent / big research) crossed the
// 300s fallback and nulled currentTurn, darkening the live activity feed
// mid-work. The opt-in defer keeps the turn alive while a tool is in flight,
// bounded by a hard ceiling so a hung-mid-tool turn still unwedges.
describe('silence-poke — Fix A: in-flight-tool defer', () => {
  it('legacy default (defer OFF): fires at 300s even with a tool in flight', () => {
    const f = setupDeps() // deferFallbackWhileToolInFlight unset → off
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'long audit', 10_000)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1) // unchanged legacy behaviour
  })

  it('defer ON: does NOT fire at 300s while a tool is in flight', () => {
    const f = setupDeps({ deferFallbackWhileToolInFlight: true, thresholds: { fallbackHardCeiling: 900_000 } })
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'long audit', 10_000)
    __tickForTests(300_000)
    __tickForTests(450_000) // still working, tool still in flight
    expect(f.fallbacks).toHaveLength(0) // deferred — the live feed stays alive
  })

  it('defer ON: fires once the tool ends and the turn stays silent past threshold', () => {
    const f = setupDeps({ deferFallbackWhileToolInFlight: true, thresholds: { fallbackHardCeiling: 900_000 } })
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', null, 10_000)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(0) // deferred while in flight
    noteToolEnd('c:0', 't1', 400_000) // tool completes, no reply follows
    __tickForTests(400_001) // silence (from turn start) already well past 300s
    expect(f.fallbacks).toHaveLength(1) // now unwedges promptly
  })

  it('defer ON: fires at the hard ceiling even with a tool still in flight (hung-mid-tool)', () => {
    const f = setupDeps({ deferFallbackWhileToolInFlight: true, thresholds: { fallbackHardCeiling: 900_000 } })
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'wedged tool', 10_000)
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(0) // deferred
    __tickForTests(900_000) // crosses the hard ceiling
    expect(f.fallbacks).toHaveLength(1) // bounded — still unwedges
  })

  it('defer ON: a turn with NO in-flight tool fires at the base threshold (genuine silence)', () => {
    const f = setupDeps({ deferFallbackWhileToolInFlight: true, thresholds: { fallbackHardCeiling: 900_000 } })
    startTurn('c:0', 0)
    // no tool ever started — genuinely silent/wedged
    __tickForTests(300_000)
    expect(f.fallbacks).toHaveLength(1) // unaffected by the defer
  })

  it('defer ON without a hard ceiling: defers indefinitely while the tool stays in flight', () => {
    const f = setupDeps({ deferFallbackWhileToolInFlight: true }) // no fallbackHardCeiling → Infinity
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', null, 10_000)
    __tickForTests(300_000)
    __tickForTests(3_600_000) // an hour in
    expect(f.fallbacks).toHaveLength(0)
  })
})
