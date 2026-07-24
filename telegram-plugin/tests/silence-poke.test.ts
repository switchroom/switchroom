import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { projectTranscriptLine } from '../session-tail.js'
import {
  startTurn,
  noteOutbound,
  noteProduction,
  noteThinking,
  noteToolStart,
  noteToolEnd,
  noteToolLabel,
  noteBackgroundShellAlive,
  noteBackgroundShellDead,
  __bgMarkerParserConfirmedForTests,
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
  isLegitimatelyWorking?: (key: string) => boolean
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
    ...(opts?.isLegitimatelyWorking != null
      ? { isLegitimatelyWorking: opts.isLegitimatelyWorking }
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

// Production-liveness (2026-06-05): an activity-feed render or draft update is
// the agent visibly working — it resets the silence clock so a long
// tool/composition turn isn't torn down mid-work.
describe('silence-poke — noteProduction resets the silence clock', () => {
  it('a feed/draft render at 250s pushes the fallback measurement to it', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteProduction('k', 250_000)
    __tickForTests(300_000) // 50s since production — no fire
    expect(fx.fallbacks).toHaveLength(0)
    __tickForTests(550_000) // 300s since production — fires
    expect(fx.fallbacks).toHaveLength(1)
  })

  it('repeated production every 60s keeps a long turn alive indefinitely', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    for (let t = 60_000; t <= 600_000; t += 60_000) {
      noteProduction('k', t)
      __tickForTests(t)
    }
    // 10 min of steady feed/draft renders — never torn down.
    expect(fx.fallbacks).toHaveLength(0)
  })

  it('production STOPS → the fallback fires 300s after the last render (genuine wedge)', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteProduction('k', 100_000) // last render at 100s, then silence
    __tickForTests(390_000) // 290s since last render — no fire
    expect(fx.fallbacks).toHaveLength(0)
    __tickForTests(401_000) // 301s since last render — fires
    expect(fx.fallbacks).toHaveLength(1)
  })

  it('is a no-op for an unknown key (no turn state)', () => {
    setupDeps()
    expect(() => noteProduction('nope', 1_000)).not.toThrow()
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

  // The "no update from agent in N min" stall notice is a retired stop-gap
  // (operator: obsolete now that the live draft + the model's own pacing beats
  // carry progress). `formatFrameworkFallbackText` now returns null for every
  // stall variant — the generic "still working / still thinking" notice AND the
  // #1292 tool-aware enrichment — so the gateway sends nothing for a plain
  // stall (it still runs the unwedge teardown). Only `blockedOnApproval`
  // still produces a user-visible string. The tests below pin that contract.

  it('stall notice (in-flight tool) returns null — no user-visible send', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'Grep', label: '"foo"', durationMs: 275_000 },
      ]),
    ).toBeNull()
  })

  it('stall notice (multiple in-flight tools) returns null', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'Grep', label: '"foo"', durationMs: 275_000 },
        { name: 'Read', label: 'config.ts', durationMs: 120_000 },
        { name: 'Bash', label: null, durationMs: 60_000 },
      ]),
    ).toBeNull()
  })

  it('stall notice (raw mcp__ tool, with or without label) returns null', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'mcp__hindsight__reflect', label: 'Searching memory', durationMs: 305_000 },
      ]),
    ).toBeNull()
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'mcp__some-third-party__do_thing', label: null, durationMs: 305_000 },
      ]),
    ).toBeNull()
  })

  it('generic stall notice (empty inFlightTools, working AND thinking) returns null', () => {
    expect(formatFrameworkFallbackText('working', 305_000, [])).toBeNull()
    expect(formatFrameworkFallbackText('thinking', 305_000, [])).toBeNull()
    expect(formatFrameworkFallbackText('working', 305_000)).toBeNull()
  })

  it('blockedOnApproval still names the real blocker (the one surviving user-visible send)', () => {
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

  it('blockedOnApproval=false is a stall → returns null (stop-gap retired)', () => {
    expect(
      formatFrameworkFallbackText('working', 305_000, [], false),
    ).toBeNull()
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

  it('in-flight tool stall (any duration/label) returns null — stop-gap retired', () => {
    // Previously rendered "running Grep foo for 12s (…)" / truncated long
    // labels. The whole tool-aware stall enrichment is gone now, so the
    // duration + label formatting paths no longer surface — they return null.
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'Grep', label: 'foo', durationMs: 12_000 },
      ]),
    ).toBeNull()
    const longLabel = '"' + 'x'.repeat(120) + '"'
    expect(
      formatFrameworkFallbackText('working', 305_000, [
        { name: 'Grep', label: longLabel, durationMs: 305_000 },
      ]),
    ).toBeNull()
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
// (`reference/rfcs/conversational-pacing.md` § Safety net). The stall notice is
// a retired stop-gap — its wording is gone (returns null). The ONE surviving
// user-visible string is the approval-blocked re-ping; snapshot it here so a
// refactor that drops the phrase fails loud. The `N min` parenthetical is still
// derived from silenceMs (honest), so pin that too.
describe('silence-poke — wording snapshots (CC-4)', () => {
  it('framework fallback — generic stall (working/thinking) emits no message', () => {
    expect(formatFrameworkFallbackText('working', 300_000)).toBeNull()
    expect(formatFrameworkFallbackText('thinking', 300_000)).toBeNull()
  })

  it('approval-blocked re-ping — exact wording', () => {
    expect(formatFrameworkFallbackText('working', 300_000, [], true)).toMatchInlineSnapshot(
      `"waiting for your approval — tap Approve or Deny on the card above (5 min)"`,
    )
  })

  it('approval-blocked — minutes derived from silenceMs, not hard-coded', () => {
    expect(formatFrameworkFallbackText('working', 360_000, [], true)).toBe(
      'waiting for your approval — tap Approve or Deny on the card above (6 min)',
    )
    expect(formatFrameworkFallbackText('working', 600_000, [], true)).toBe(
      'waiting for your approval — tap Approve or Deny on the card above (10 min)',
    )
  })

  it('approval-blocked — minutes floor at 1 even when silenceMs is small', () => {
    expect(formatFrameworkFallbackText('working', 30_000, [], true)).toBe(
      'waiting for your approval — tap Approve or Deny on the card above (1 min)',
    )
    expect(formatFrameworkFallbackText('working', 0, [], true)).toBe(
      'waiting for your approval — tap Approve or Deny on the card above (1 min)',
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

// ─── #3519: CLI-side background-bash defer — the stacked-cards regression ─────
// Root cause of the operator-visible bug: a single turn ran a foreground `Bash`
// that the claude CLI auto-moved to the background at its foreground timeout.
// The tool_result returned (draining `inFlightTools`), so every existing "still
// working" signal — `isLegitimatelyWorking()`'s foreground/async-dispatch/
// ask_user checks — went false while the process kept running and the model sat
// silent waiting on it. At 300s the framework fallback fired: it nulled
// `currentTurn` and tore down the pinned progress card (the `onFrameworkFallback`
// callback → liveness-wiring.ts:427-441 `endCurrentTurnForKey`), and the next
// tool burst minted a BRAND-NEW pinned card. Each > 300s gap repeated it →
// 2..N stacked cards on ONE turn.
//
// These are OUTCOME assertions: `fixtures.fallbacks` counts every fallback fire,
// and a fire is exactly a currentTurn-null + card teardown (the trigger for a
// re-minted card). The production wiring is reproduced faithfully:
// `isLegitimatelyWorking` IS wired (the gateway always wires it) and it returns
// FALSE for the whole gap (the CLI-side background bash is invisible to it by
// construction). Reverting the `sawBashThisTurn` defer turns these RED — the
// fallback fires on every gap and multiple cards are minted.
describe('silence-poke — #3519 background-bash defer (stacked-cards regression guard)', () => {
  const PROD = {
    thresholds: { fallbackHardCeiling: 900_000 }, // SILENCE_FALLBACK_HARD_MS
    isLegitimatelyWorking: () => false,            // background bash is invisible
  }

  it('a foreground Bash moved to background does NOT tear down the card at 300s (mid-work)', () => {
    const f = setupDeps(PROD)
    startTurn('c:0', 0)
    // Foreground bash starts, then auto-moves to background at ~120s: its
    // tool_result returns so inFlightTools drains. isLegitimatelyWorking is
    // false throughout — every existing signal says "idle".
    noteToolStart('c:0', 't1', 'Bash', 'find / -name x', 5_000)
    noteToolEnd('c:0', 't1', 125_000)
    // The silent gap the model spends waiting on the background process.
    __tickForTests(300_000)
    __tickForTests(306_000) // well past the 300s base threshold
    // BUG behaviour: fallback fires here (currentTurn nulled, card torn down).
    // FIXED: deferred — the pinned card stays live, no re-mint.
    expect(f.fallbacks).toHaveLength(0)
  })

  it('exactly ONE card survives a whole turn with two > 300s background-bash gaps', () => {
    const f = setupDeps(PROD)

    // Model the gateway's pinned-card lifecycle so the surviving card is
    // asserted POSITIVELY, not merely inferred from zero teardowns. In
    // production a fallback fire IS a card teardown (currentTurn nulled +
    // pinned card unpinned, liveness-wiring.ts:427-441), and the next tool
    // burst mints a BRAND-NEW pinned card — that re-mint is exactly the
    // stacking. Here: mint one card when the turn starts, and replay a
    // teardown + fresh re-mint for every fallback the silence-poke tick
    // records. `mintedCards.length` is then the true number of cards that
    // ever existed for the turn, and `pinnedCardId` is the live one.
    const mintedCards: string[] = []
    let pinnedCardId: string | null = null
    const mintCard = (): void => {
      const id = `card-${mintedCards.length + 1}`
      mintedCards.push(id)
      pinnedCardId = id
    }
    const syncCardsAfterTick = (): void => {
      // Each recorded fallback == one teardown of the live card + a fresh
      // re-mint by the resuming burst (the stacked-cards mechanism). Replay
      // any teardown not yet modelled.
      while (mintedCards.length - 1 < f.fallbacks.length) {
        pinnedCardId = null // teardown unpins the live card
        mintCard() // next tool burst mints a brand-new pinned card (a stack)
      }
    }

    startTurn('c:0', 0)
    mintCard() // the turn's first pinned progress card ("card-1")
    // Gap 1 — first backgrounded find.
    noteToolStart('c:0', 't1', 'Bash', 'find / -name a', 5_000)
    noteToolEnd('c:0', 't1', 125_000)
    __tickForTests(306_000)
    syncCardsAfterTick()
    expect(f.fallbacks).toHaveLength(0) // no Card B minted (zero teardowns)
    // POSITIVE: the ORIGINAL pinned card is still the live one after gap 1,
    // and it is the ONLY card that has ever existed.
    expect(pinnedCardId).toBe('card-1')
    expect(mintedCards).toHaveLength(1)
    // Model resumes and updates the SAME pinned card (production resets the
    // silence clock on that render), then launches a second backgrounded find.
    noteProduction('c:0', 310_000)
    noteToolStart('c:0', 't2', 'Bash', 'find / -name b', 315_000)
    noteToolEnd('c:0', 't2', 435_000)
    // Gap 2 — > 300s of silence since the last render (310_000).
    __tickForTests(620_000)
    syncCardsAfterTick()
    expect(f.fallbacks).toHaveLength(0) // no Card C minted (zero teardowns)
    // POSITIVE: still the same single original card, updated in place across
    // BOTH gaps — no second/third card was ever minted (no stacking).
    expect(pinnedCardId).toBe('card-1')
    expect(mintedCards).toEqual(['card-1'])
  })

  it('still bounded: a genuinely wedged bash-turn unwedges ONCE at the hard ceiling (not 3×)', () => {
    const f = setupDeps(PROD)
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'find /', 5_000)
    noteToolEnd('c:0', 't1', 125_000)
    __tickForTests(306_000)
    expect(f.fallbacks).toHaveLength(0) // deferred, not fired 3×
    __tickForTests(900_000) // crosses SILENCE_FALLBACK_HARD_MS
    expect(f.fallbacks).toHaveLength(1) // exactly one bounded unwedge
  })

  it('the defer is Bash-specific: a non-Bash idle turn still fires at 300s (fix is scoped)', () => {
    const f = setupDeps(PROD)
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Grep', 'foo', 5_000)
    noteToolEnd('c:0', 't1', 60_000) // Grep can't be a background process
    __tickForTests(306_000)
    expect(f.fallbacks).toHaveLength(1) // genuine silence → unwedges normally
  })

  it('honours the SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0 kill switch', () => {
    const prev = process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS
    process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS = '0'
    try {
      const f = setupDeps(PROD)
      startTurn('c:0', 0)
      noteToolStart('c:0', 't1', 'Bash', 'find /', 5_000)
      noteToolEnd('c:0', 't1', 125_000)
      __tickForTests(306_000)
      expect(f.fallbacks).toHaveLength(1) // defer force-disabled → legacy fire
    } finally {
      if (prev != null) process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS = prev
      else delete process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS
    }
  })
})

// ─── #3519 SHARPEN: PROVEN-alive defer, driven by REAL captured markers ───────
// The coarse `sawBashThisTurn` guard above deferred EVERY bash-turn to the 900s
// ceiling. This sharpens it: defer only while a background shell is PROVEN
// alive (its structured `backgroundTaskId` launch marker seen, no completion
// yet), and recover at ~300s the moment it finishes. The alive/dead facts here
// are PARSED FROM REAL JSONL (tests/fixtures/bg-shell-liveness-3519.jsonl —
// carrie session 1db49136-…, claude v2.1.185; line 35 auto-background launch,
// line 68 `<task-notification>` completion) through the SAME projectTranscriptLine
// path the gateway uses, then fed to silence-poke exactly as the gateway feeds
// it (tool_result.backgroundTaskId → noteBackgroundShellAlive; task_notification
// → noteBackgroundShellDead). So every fixture value is traceable to a real byte.
describe('silence-poke — #3519 sharpen: proven-alive defer (real markers)', () => {
  const PROD = {
    thresholds: { fallbackHardCeiling: 900_000 }, // SILENCE_FALLBACK_HARD_MS
    isLegitimatelyWorking: () => false,            // background bash invisible to it
  }
  const FIXTURE = join(__dirname, 'fixtures', 'bg-shell-liveness-3519.jsonl')
  const fxLines = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.length > 0)
  // Derive the REAL ids straight from the fixtures via the production parser.
  const aliveEv = projectTranscriptLine(fxLines[0]).find(e => e.kind === 'tool_result')
  const deadEv = projectTranscriptLine(fxLines[1])[0]
  const LIVE_ID = aliveEv?.kind === 'tool_result' ? aliveEv.backgroundTaskId! : ''
  const DEAD_ID = deadEv.kind === 'task_notification' ? deadEv.taskId : ''

  it('sanity: the fixtures really carry a matching background-shell id', () => {
    expect(LIVE_ID).toBe('bweqqjn9r')
    expect(DEAD_ID).toBe('bweqqjn9r')
  })

  // (a) A shell PROVEN alive across a > 300s gap must NOT tear down the card —
  //     and exactly ONE card survives (positive assertion, not inferred).
  it('(a) live shell across a > 300s gap → no teardown, exactly one card', () => {
    const f = setupDeps(PROD)
    const mintedCards: string[] = []
    let pinnedCardId: string | null = null
    const mintCard = (): void => {
      mintedCards.push(`card-${mintedCards.length + 1}`)
      pinnedCardId = mintedCards[mintedCards.length - 1]
    }
    const syncCardsAfterTick = (): void => {
      while (mintedCards.length - 1 < f.fallbacks.length) { pinnedCardId = null; mintCard() }
    }

    startTurn('c:0', 0)
    mintCard() // the turn's first pinned progress card
    // Foreground Bash auto-moved to background at ~120s: its tool_result
    // returns (drains inFlightTools) carrying the real backgroundTaskId.
    noteToolStart('c:0', 't1', 'Bash', 'find / -name x', 5_000)
    noteToolEnd('c:0', 't1', 125_000)
    noteBackgroundShellAlive('c:0', LIVE_ID) // gateway does this from the parsed event
    __tickForTests(306_000)
    syncCardsAfterTick()
    __tickForTests(500_000) // still alive, still silent, still well past 300s
    syncCardsAfterTick()
    expect(f.fallbacks).toHaveLength(0)     // deferred — no teardown
    expect(pinnedCardId).toBe('card-1')     // POSITIVE: original card still live
    expect(mintedCards).toEqual(['card-1']) // and it is the ONLY card ever minted
    expect(__bgMarkerParserConfirmedForTests()).toBe(true) // marker proven working
  })

  // (b) THE NEW capability: once the shell FINISHES (real completion marker),
  //     a subsequent > 300s wedge recovers at ~300s — NOT held to 900s.
  it('(b) shell went DEAD then a > 300s wedge → fallback fires at ~300s (fast recovery)', () => {
    const f = setupDeps(PROD)
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'find / -name x', 5_000)
    noteToolEnd('c:0', 't1', 125_000)
    noteBackgroundShellAlive('c:0', LIVE_ID)   // backgrounded at ~120s
    noteBackgroundShellDead('c:0', DEAD_ID)    // real <task-notification> completed at ~200s
    // Model then goes silent on a genuine wedge. Because the CLI marker PARSED
    // (confirmed), the coarse sawBash degradation is OFF, so the empty
    // alive-set means this is real silence → recover at the 300s base window,
    // not the 900s ceiling.
    __tickForTests(306_000)
    expect(f.fallbacks).toHaveLength(1) // FAST recovery restored (would be 0 under the old coarse guard)
  })

  // (c) SAFE DEGRADATION: if a future CLI renames the markers so NOTHING parses
  //     (backgroundTaskId never resolves → parser never confirmed), we must not
  //     regress to stacking — fall back to the 900s-bounded coarse guard.
  it('(c) unmatched/changed CLI marker → degrades to the 900s-bounded guard', () => {
    const f = setupDeps(PROD)
    // Mutate the REAL alive line so neither the structured field nor the string
    // matches — exactly what a marker rename looks like. Parse it as the gateway
    // would; it yields NO backgroundTaskId, so noteBackgroundShellAlive is never
    // called and the parser stays unconfirmed.
    const mutated = JSON.parse(fxLines[0])
    delete mutated.toolUseResult.backgroundTaskId
    mutated.message.content[0].content = 'Task moved to background (id withheld by a newer CLI).'
    const ev = projectTranscriptLine(JSON.stringify(mutated)).find(e => e.kind === 'tool_result')
    expect(ev?.kind === 'tool_result' ? ev.backgroundTaskId : 'X').toBeUndefined()

    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'find / -name x', 5_000) // sawBashThisTurn armed
    noteToolEnd('c:0', 't1', 125_000)
    // No alive registration (marker unparseable) → parser NOT confirmed.
    expect(__bgMarkerParserConfirmedForTests()).toBe(false)
    __tickForTests(306_000)
    expect(f.fallbacks).toHaveLength(0) // still deferred by the coarse guard (no stacking)
    __tickForTests(900_000)             // crosses the hard ceiling
    expect(f.fallbacks).toHaveLength(1) // bounded unwedge — never hangs forever
  })

  // (d) Still bounded even while genuinely alive: a shell that never reports
  //     dead still unwedges ONCE at the 900s ceiling (not indefinitely).
  it('(d) a never-completing live shell still unwedges once at the 900s ceiling', () => {
    const f = setupDeps(PROD)
    startTurn('c:0', 0)
    noteToolStart('c:0', 't1', 'Bash', 'find /', 5_000)
    noteToolEnd('c:0', 't1', 125_000)
    noteBackgroundShellAlive('c:0', LIVE_ID) // alive, never dies
    __tickForTests(306_000)
    expect(f.fallbacks).toHaveLength(0) // deferred while alive
    __tickForTests(900_000)             // hard ceiling
    expect(f.fallbacks).toHaveLength(1) // exactly one bounded unwedge
  })

  it('honours the SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=0 kill switch even with a live shell', () => {
    const prev = process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS
    process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS = '0'
    try {
      const f = setupDeps(PROD)
      startTurn('c:0', 0)
      noteToolStart('c:0', 't1', 'Bash', 'find /', 5_000)
      noteToolEnd('c:0', 't1', 125_000)
      noteBackgroundShellAlive('c:0', LIVE_ID)
      __tickForTests(306_000)
      expect(f.fallbacks).toHaveLength(1) // force-disabled → no defer at all
    } finally {
      if (prev != null) process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS = prev
      else delete process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS
    }
  })
})
