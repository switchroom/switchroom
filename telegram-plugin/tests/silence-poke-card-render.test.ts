/**
 * #4330 — a visibly-updating pinned activity card must not be treated as
 * silence by the 300s terminal fallback.
 *
 * The bug (user-reported, with screenshot): the framework fired the terminal
 * unwedge — "⚠️ no output for 5 min — the framework ended that stalled turn"
 * — on a HEALTHY turn whose pinned "→ Working… · Nm · N tools" status card
 * WAS actively updating the whole time. The card edits are driven by
 * `feedHeartbeatTick` (the 0-label climb / labelled-step elapsed re-render)
 * through `drainActivitySummary`'s editMessageText, and that transport path
 * had NO `noteProduction`/`noteOutbound` site — deliberately, because the
 * heartbeat climbs on pure wall clock and an unbounded clock RESET would keep
 * a genuinely hung turn alive forever (the #1556 class). So when every defer
 * signal (in-flight tool, pending async dispatch, alive shells, compaction)
 * read false at the 300s tick, the fallback tore down the very card the user
 * was watching and re-asked their message.
 *
 * The fix: `drainActivitySummary` stamps `silencePoke.noteCardRender` on
 * every card render that actually lands (open or non-shed edit); tick()
 * DEFERS the terminal fallback while the last landed render is younger than
 * `CARD_RENDER_FRESH_MS`, bounded by `fallbackHardCeiling` exactly like the
 * #1292/#3519/#4058 defers. These tests drive the REAL tick loop (and, for
 * the wiring case, the REAL narrative-lane transport) and assert outcomes:
 *   - card renders arriving faster than the fresh window → NO fire past 300s;
 *   - renders that keep coming forever → STILL fires at the hard ceiling
 *     (a hung turn's heartbeat keeps climbing, so the net must stay bounded);
 *   - a genuinely silent turn (no renders, no tool, no reply) → STILL fires
 *     at 300s (the safety net is not disabled);
 *   - renders that STOP → the fallback fires once silence ≥ threshold and
 *     the last render has aged out (no unearned extension);
 *   - wiring: a card edit through the REAL `createNarrativeLane` drain
 *     defers the fallback for its status key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createNarrativeLane } from '../gateway/narrative-lane.js'
import type { CurrentTurn, NarrativeLaneDeps } from '../gateway/gateway.js'
import * as silencePoke from '../silence-poke.js'
import {
  startTurn,
  noteCardRender,
  __tickForTests,
  __setDepsForTests,
  __getStateForTests,
  __resetAllForTests,
  DEFAULT_THRESHOLDS,
  CARD_RENDER_FRESH_MS,
  type SilencePokeMetric,
  type FrameworkFallbackContext,
  type ThresholdsMs,
} from '../silence-poke.js'

const HARD_CEILING = 900_000 // SILENCE_FALLBACK_HARD_MS default

interface TestFixtures {
  emitted: SilencePokeMetric[]
  fallbacks: FrameworkFallbackContext[]
}

function setupDeps(opts?: { thresholdsMs?: ThresholdsMs }): TestFixtures {
  const fixtures: TestFixtures = { emitted: [], fallbacks: [] }
  __setDepsForTests({
    emitMetric: (e) => fixtures.emitted.push(e),
    onFrameworkFallback: (ctx) => { fixtures.fallbacks.push(ctx) },
    thresholdsMs: opts?.thresholdsMs
      ?? { ...DEFAULT_THRESHOLDS, fallbackHardCeiling: HARD_CEILING },
    // Mirror production wiring: the callback path is active (liveness-wiring
    // always wires isLegitimatelyWorking), returning false = "no tool work".
    isLegitimatelyWorking: () => false,
  })
  return fixtures
}

beforeEach(() => {
  __resetAllForTests()
  delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
  delete process.env.SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS
})

afterEach(() => {
  __resetAllForTests()
})

describe('silence-poke — #4330 card-render defer (outcome)', () => {
  it('a turn whose ONLY output is card renders faster than the fresh window is NOT torn down past 300s', () => {
    const fx = setupDeps()
    startTurn('chat:1', 0)
    // The heartbeat edits the card every ~6s; simulate a card that keeps
    // visibly updating for 10 minutes with no reply, no tool, no draft.
    for (let t = 6_000; t <= 600_000; t += 6_000) {
      noteCardRender('chat:1', t)
      __tickForTests(t)
    }
    // Pre-fix this fired at the first tick with silence >= 300_000 — the
    // exact "framework ended that stalled turn" false positive.
    expect(fx.fallbacks).toHaveLength(0)
    expect(fx.emitted).toHaveLength(0)
  })

  it('card renders that keep coming forever STILL fire the fallback at the hard ceiling (bounded defer)', () => {
    const fx = setupDeps()
    startTurn('chat:2', 0)
    // A hung turn: the framework heartbeat keeps climbing the card on pure
    // wall clock even though the model is dead. The defer must stay bounded.
    let fired: number | null = null
    for (let t = 6_000; t <= 1_200_000; t += 6_000) {
      noteCardRender('chat:2', t)
      __tickForTests(t)
      if (fx.fallbacks.length > 0 && fired == null) fired = t
    }
    expect(fx.fallbacks).toHaveLength(1)
    expect(fired).not.toBeNull()
    expect(fired!).toBeGreaterThanOrEqual(HARD_CEILING)
    // Fires promptly AT the ceiling, not some window after it.
    expect(fired!).toBeLessThanOrEqual(HARD_CEILING + 6_000)
  })

  it('a genuinely silent turn (no card renders, no tool, no reply) STILL fires at 300s — the net is intact', () => {
    const fx = setupDeps()
    startTurn('chat:3', 0)
    __tickForTests(299_000)
    expect(fx.fallbacks).toHaveLength(0)
    __tickForTests(300_000)
    expect(fx.fallbacks).toHaveLength(1)
    expect(fx.emitted.at(-1)).toMatchObject({ kind: 'silence_fallback_sent' })
  })

  it('card renders that STOP do not extend the window — fallback fires once the last render ages out', () => {
    const fx = setupDeps()
    startTurn('chat:4', 0)
    // Card updated until t=100s (turn wedged after; heartbeat drain stuck /
    // card torn down), then nothing.
    for (let t = 6_000; t <= 100_000; t += 6_000) {
      noteCardRender('chat:4', t)
      __tickForTests(t)
    }
    // At 305s: silence (never reset by noteCardRender) is 305s >= 300s and
    // the last render is 200s+ old — well past CARD_RENDER_FRESH_MS. Fires.
    __tickForTests(305_000)
    expect(fx.fallbacks).toHaveLength(1)
    expect(fx.fallbacks[0]!.silenceMs).toBe(305_000)
  })

  it('noteCardRender never resets the silence clock or re-arms a fired fallback', () => {
    setupDeps()
    startTurn('chat:5', 0)
    noteCardRender('chat:5', 250_000)
    const s = __getStateForTests('chat:5')!
    expect(s.lastOutboundAt).toBeNull() // clock untouched — defer only
    expect(s.lastCardRenderAt).toBe(250_000)
    expect(s.fallbackFired).toBe(false)
  })
})

// ── wiring proof: the REAL narrative-lane card drain stamps the defer ─────

const CHAT = '1001'

function makeLane() {
  const noop = () => {}
  let nextId = 3000
  const calls: Array<{ method: string }> = []
  const api = {
    sendRichMessage: async () => {
      calls.push({ method: 'sendRichMessage' })
      return { message_id: ++nextId }
    },
    editMessageText: async () => {
      calls.push({ method: 'editMessageText' })
      return {}
    },
    deleteMessage: async () => true,
  }
  const fakeEA = {
    mayDrain: () => true,
    openOrEditCard: (_p: string, fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
  }
  const deps = {
    ACTIVITY_CARD_STORE_PATH: `${tmpdir()}/silence-card-render-activity-cards.json`,
    CLEAR_STATUS_ON_COMPLETION: false,
    FEED_HEARTBEAT_ENABLED: false,
    FEED_HEARTBEAT_MIN_STALE_MS: 6000,
    FEED_LIVENESS_OPEN_ENABLED: false,
    FEED_LIVENESS_OPEN_MS: 5000,
    PIN_STATUS_WHILE_WORKING: false,
    POST_ANSWER_LIVENESS_STALE_MS: 90000,
    STATIC: false,
    activeDraftStreams: new Map(),
    activityCardPersistEnabled: false,
    activityCardStoreFs: { readFileSync: () => '', writeFileSync: noop, mkdirSync: noop, renameSync: noop, unlinkSync: noop },
    bot: { api },
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    currentTurnMap: { get: () => null, byKey: new Map() },
    earlyLivenessOpenTimers: new Map(),
    emissionAuthorityFor: () => fakeEA,
    feedOpenGateDeps: () => ({ hasOutboundDeliveredSince: () => false, historyEnabled: false, finalAnswerMinChars: 200 }),
    getCurrentTurn: () => null,
    reconcileStatusPin: noop,
    robustApiCall: (fn: () => Promise<unknown>) => fn(),
    // Same key shape silence-poke is driven with below.
    statusKey: (c: string, t?: number | null) => `${c}:${t ?? ''}`,
  } as unknown as NarrativeLaneDeps
  const lane = createNarrativeLane(deps)
  return { lane, calls }
}

function makeLaneTurn(lane: ReturnType<typeof createNarrativeLane>): CurrentTurn {
  const turn = {
    turnId: 'turn-card-render-1',
    sessionChatId: CHAT,
    sessionThreadId: undefined,
    sourceMessageId: null,
    registryKey: null,
    startedAt: Date.now() - 3000,
    currentModel: null,
    totalTokens: 0,
    labeledToolCount: 0,
    mirrorLines: [] as string[],
    foregroundSubAgents: new Map<string, string[]>(),
    activityPendingRender: null as string | null,
    activityLastSentRender: null as string | null,
    activityMessageId: null as number | null,
    activityInFlight: null as Promise<void> | null,
    activityEverOpened: false,
    activityDrainFailures: 0,
    finalAnswerEverDelivered: false,
    finalAnswerDelivered: false,
    replyCalled: false,
    capturedText: [] as string[],
    lastReplyText: '',
    answerStream: null,
    liveness: { recentlyStreaming: () => false, onStreamEvent: () => {}, note: () => {} },
  } as unknown as CurrentTurn
  ;(turn as { narrativeGate?: unknown }).narrativeGate = lane.makeNarrativeGate(turn)
  return turn
}

describe('silence-poke — #4330 wiring: the REAL card drain defers the fallback', () => {
  it('a card render landed through drainActivitySummary defers a due fallback; without it the fallback fires', async () => {
    const key = `${CHAT}:`
    const now = Date.now()
    // Real wall clock end-to-end: tiny fallback threshold, real
    // CARD_RENDER_FRESH_MS (the lane stamps Date.now()).
    const fx = setupDeps({
      thresholdsMs: { fallback: 1_000, fallbackHardCeiling: HARD_CEILING },
    })

    // Control first: a turn past the threshold with NO card render fires.
    startTurn(key, now - 5_000)
    __tickForTests(now)
    expect(fx.fallbacks).toHaveLength(1)

    // Now the same shape, but a card render lands through the REAL lane
    // transport before the tick — the fallback must be deferred.
    __resetAllForTests()
    const fx2 = setupDeps({
      thresholdsMs: { fallback: 1_000, fallbackHardCeiling: HARD_CEILING },
    })
    startTurn(key, Date.now() - 5_000)
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    lane.showNarrativeStep(turn, 'Compiling the release notes')
    await turn.activityInFlight
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
    const st = __getStateForTests(key)!
    expect(st.lastCardRenderAt).not.toBeNull() // the drain stamped it
    __tickForTests(Date.now())
    expect(fx2.fallbacks).toHaveLength(0) // deferred: the card just moved

    // And the defer stays bounded: past the hard ceiling it fires anyway,
    // even with a render landed inside the fresh window at fire time.
    const tFinal = Date.now() + HARD_CEILING + CARD_RENDER_FRESH_MS
    noteCardRender(key, tFinal - 1_000) // card still "moving" at the ceiling
    __tickForTests(tFinal)
    expect(fx2.fallbacks).toHaveLength(1)
  })
})

// ── structural: progress_update (a model-driven user-visible send inside the
//    gateway IIFE, not instantiable in-process — same pattern as
//    silence-liveness-wiring.test.ts) must reset the silence clock ──────────

describe('silence-poke — #4330 progress_update liveness wiring (structural)', () => {
  it('the progress_update handler calls silencePoke.noteOutbound after the send lands', () => {
    const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')
    const start = "if (!args.chat_id) throw new Error('progress_update: chat_id is required')"
    const end = '`ask_user` MCP tool'
    const block = (gatewaySrc.split(start)[1] ?? '').split(end)[0] ?? ''
    expect(block.length).toBeGreaterThan(100) // sanity: slice found the handler
    // A progress_update is a fresh user-visible outbound the model authored —
    // it must reset the 300s silence clock exactly like a reply send does
    // (outbound-send-path.ts). Pre-#4330 only signalTracker was ticked, so a
    // turn narrating solely via progress_update was torn down as "silent".
    expect(block).toMatch(/silencePoke\.noteOutbound\(key, Date\.now\(\)\)/)
  })
})
