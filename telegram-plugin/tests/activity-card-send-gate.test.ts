/**
 * Regression: the live activity/progress card must be RATE-BOUND by the send
 * gate (#3620).
 *
 * ── The bug this pins ─────────────────────────────────────────────────────
 * `drainActivitySummary` edited the card with
 *     robustApiCall(() => bot.api.editMessageText(...), { chat_id, verb })
 * — no `messageId`, no `editPayload`. `sendGate.gate()` only routes to its
 * edit path when BOTH are present, so every card edit fell through to the
 * plain-send path and got NONE of the per-message protections:
 *   - no 1500ms per-message edit floor
 *   - no last-write-wins coalescing  (the incident logged `coalesced=0`)
 *   - no identical-payload no-op skip (`dropped=0`)
 *   - no long-horizon per-message edit budget
 * and, being untagged, it was admitted as `critical` (UNTAGGED_SEND_CLASS) —
 * never shed, queued unbounded. One message could therefore be edited at the
 * per-chat bucket rate for as long as a turn ran, which earned agent
 * `overlord` a 3713s Telegram flood ban on 2026-07-25.
 *
 * ── Oracle ────────────────────────────────────────────────────────────────
 * The REAL `createNarrativeLane` driven against a fake bot recorder, with the
 * REAL `createSendGate` wired into `robustApiCall` on a deterministic fake
 * clock — i.e. the exact production seam, no re-implementation.
 *
 * ── The outcome asserted (not the code path) ──────────────────────────────
 * The per-chat/global buckets are configured WIDE OPEN so they cannot be the
 * thing doing the limiting; the only remaining brake is the per-message edit
 * discipline. Then N=40 renders over 10s of fake time must produce a bounded
 * number of API calls AND the last call must carry the NEWEST body. On the
 * pre-fix code this test fails on the call count (40 edits issued).
 */
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { createNarrativeLane } from '../gateway/narrative-lane.js'
import { createSendGate, SEND_GATE_DEFAULTS, type Clock, type SendGateOpts } from '../send-gate.js'
import type { CurrentTurn, NarrativeLaneDeps } from '../gateway/gateway.js'

const CHAT = '1001'

// ── deterministic clock (same shape as send-gate.test.ts) ─────────────────
class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []

  now(): number {
    return this.cur
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }

  async advance(ms: number): Promise<void> {
    const target = this.cur + ms
    for (;;) {
      await flush()
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]!
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
    await flush()
  }
}

function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
}

// ── fake bot recorder ─────────────────────────────────────────────────────
interface RecordedCall { method: string; text: string; message_id?: number; at: number }

function makeFakeBot(clock: FakeClock) {
  const calls: RecordedCall[] = []
  let nextId = 3000
  const api = {
    sendRichMessage: async (_c: string, b: { markdown: string }) => {
      const id = ++nextId
      calls.push({ method: 'sendRichMessage', text: b.markdown, message_id: id, at: clock.now() })
      return { message_id: id }
    },
    sendMessage: async (_c: string, t: string) => {
      const id = ++nextId
      calls.push({ method: 'sendMessage', text: t, message_id: id, at: clock.now() })
      return { message_id: id }
    },
    editMessageText: async (_c: string, m: number, b: unknown) => {
      calls.push({
        method: 'editMessageText',
        text: typeof b === 'string' ? b : (b as { markdown: string }).markdown,
        message_id: m,
        at: clock.now(),
      })
      return {}
    },
    deleteMessage: async () => true,
  }
  return { api, calls }
}

function makeLaneTurn(lane: ReturnType<typeof createNarrativeLane>): CurrentTurn {
  const turn = {
    turnId: 'turn-gate-1',
    sessionChatId: CHAT,
    sessionThreadId: undefined,
    sourceMessageId: null,
    registryKey: null,
    startedAt: 0,
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

/**
 * The lane wired to the REAL send gate. `bucketOverrides` lets a case widen the
 * chat/global buckets so the ONLY brake left is the per-message edit discipline
 * (that is what makes the assertion a statement about the fix and not about the
 * unrelated per-chat bucket).
 */
function makeGatedLane(bucketOverrides: Record<string, number> = {}) {
  const clock = new FakeClock()
  const { api, calls } = makeFakeBot(clock)
  const gate = createSendGate({
    enabled: true,
    clock,
    globalPerSec: 1000,
    globalBurst: 1000,
    perChatPerSec: 1000,
    perChatBurst: 1000,
    perGroupPerMin: 100000,
    perGroupBurst: 100000,
    ...bucketOverrides,
  })
  const noop = () => {}
  const fakeEA = {
    mayDrain: () => true,
    openOrEditCard: (_p: string, fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
  }
  const deps = {
    ACTIVITY_CARD_STORE_PATH: `${tmpdir()}/lane-sendgate-activity-cards.json`,
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
    activityCardStoreFs: {
      readFileSync: () => '', writeFileSync: noop, mkdirSync: noop, renameSync: noop, unlinkSync: noop,
    },
    bot: { api },
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    currentTurnMap: { get: () => null, byKey: new Map() },
    earlyLivenessOpenTimers: new Map(),
    emissionAuthorityFor: () => fakeEA,
    feedOpenGateDeps: () => ({ hasOutboundDeliveredSince: () => false, historyEnabled: false, finalAnswerMinChars: 200 }),
    getCurrentTurn: () => null,
    reconcileStatusPin: noop,
    robustApiCall: (fn: () => Promise<unknown>, opts?: SendGateOpts) => gate.gate(fn, opts),
    statusKey: (c: string, t?: number | null) => `${c}:${t ?? 'main'}`,
  } as unknown as NarrativeLaneDeps
  const lane = createNarrativeLane(deps)
  return { lane, calls, clock, gate }
}

describe('activity card ↔ send gate (#3620)', () => {
  it('40 rapid card updates over 10s collapse to a handful of edits, newest last', async () => {
    // Buckets are wide open: whatever bounds the edits here is the PER-MESSAGE
    // edit discipline, which is exactly what the fix engages.
    const { lane, calls, clock } = makeGatedLane()
    const turn = makeLaneTurn(lane)

    lane.showNarrativeStep(turn, 'Step 0 opening the card')
    await clock.advance(10)
    await turn.activityInFlight
    expect(turn.activityMessageId).not.toBeNull()

    const N = 40
    const windowMs = 10_000
    for (let i = 1; i <= N; i++) {
      lane.showNarrativeStep(turn, `Step ${i} of the work`)
      await clock.advance(windowMs / N)
    }
    // Let any in-flight floor sleep settle so the newest body is painted.
    await clock.advance(SEND_GATE_DEFAULTS.editFloorMs * 2)
    await turn.activityInFlight
    await lane.drainActivitySummary(turn)
    await clock.advance(SEND_GATE_DEFAULTS.editFloorMs * 2)
    await turn.activityInFlight

    const edits = calls.filter((c) => c.method === 'editMessageText')
    // (a) BOUNDED: 10s of fake time under a 1500ms floor admits at most
    // ceil(10000/1500)+1 = 8 edits (+2 for the post-window settle drains). The
    // pre-fix code issues one edit per render (40) and fails here.
    const K = Math.ceil(windowMs / SEND_GATE_DEFAULTS.editFloorMs) + 3
    expect(edits.length).toBeLessThanOrEqual(K)
    expect(edits.length).toBeGreaterThan(0)
    // Every edit went to the one card — never a second bubble.
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
    expect(edits.every((e) => e.message_id === turn.activityMessageId)).toBe(true)
    // (b) NEWEST WINS: the last edit carries the latest state, and no
    // intermediate frame is issued after it.
    expect(edits[edits.length - 1]!.text).toContain(`Step ${N} of the work`)
    // (c) SPACING: consecutive edits of the same message respect the floor.
    for (let i = 1; i < edits.length; i++) {
      expect(edits[i]!.at - edits[i - 1]!.at).toBeGreaterThanOrEqual(SEND_GATE_DEFAULTS.editFloorMs)
    }
  })

  it('a shed card edit is not treated as painted — the newest render survives for the next drain', async () => {
    // A one-token-per-minute chat bucket: the card open consumes it, so the
    // next COSMETIC card edit sheds.
    const { lane, calls, clock } = makeGatedLane({ perChatPerSec: 1 / 60, perChatBurst: 1 })
    const turn = makeLaneTurn(lane)

    lane.showNarrativeStep(turn, 'Opening the card')
    await clock.advance(10)
    await turn.activityInFlight
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)

    lane.showNarrativeStep(turn, 'A shed update')
    await clock.advance(10)
    await turn.activityInFlight
    // Shed → nothing hit the API, and the render is still PENDING (not
    // mis-recorded as sent), so it is not silently lost.
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(turn.activityPendingRender).not.toBeNull()
    expect(turn.activityPendingRender).not.toBe(turn.activityLastSentRender)

    // Once the bucket refills, the next drain paints the NEWEST body — not the
    // shed intermediate one.
    lane.showNarrativeStep(turn, 'The newest update')
    await clock.advance(120_000)
    await turn.activityInFlight
    await lane.drainActivitySummary(turn)
    await clock.advance(10_000)
    await turn.activityInFlight

    const edits = calls.filter((c) => c.method === 'editMessageText')
    expect(edits.length).toBeGreaterThan(0)
    expect(edits[edits.length - 1]!.text).toContain('The newest update')
  })
})
