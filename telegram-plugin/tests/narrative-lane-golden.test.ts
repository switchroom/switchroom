/**
 * Golden harness for the extracted narrative/activity lane
 * (#2996 P4-B, plan Amendments 1/5/9/10).
 *
 * ── Oracle standard (Amendment 10) ────────────────────────────────────────
 * gateway.ts cannot be driven in-place from a test runner, so the oracle is
 * the EXTRACTED-MODULE golden harness (the outbound-send-path /
 * stream-render-golden precedent): the REAL `createNarrativeLane` factory is
 * driven directly against a fake bot recorder, real leaf modules
 * (renderActivityFeedWithNested, NarrativeFlushController, narrative-dedup,
 * feed-open-gate), and fake gateway closures.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *   - narrative SHOW → feed card OPEN (sendRichMessage) with the clipped line
 *   - second SHOW → in-place EDIT of the SAME card (no second bubble)
 *   - composeTurnActivity: live vs final render (step-count on final only)
 *   - the narrative-dedup gate: a trailing draft-of-reply is SUPPRESSED at
 *     turn end; genuine trailing narration is SHOWN
 *   - clearActivitySummary finalize: terminal EDIT, no delete (default path)
 *   - THREE-MODULE cross-surface dedup (Amendment 1): the REAL P4-A
 *     handleSessionEvent turn-flush driven with the REAL P4-B lane wired into
 *     its deps records into ONE OutboundDedupCache, and the REAL P2 sendReply
 *     holding the SAME instance suppresses the late same-text reply
 *   - structural: the lane constructs NO OutboundDedupCache / ledger, never
 *     reads the `currentTurn` global, and gateway's wrappers delegate lazily
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createNarrativeLane } from '../gateway/narrative-lane.js'
import { handleSessionEvent, type StreamRenderDeps } from '../gateway/stream-render.js'
import { sendReply, type SendReplyGatewayDeps, type SendReplyRequest } from '../gateway/outbound-send-path.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { FlushedTurnSupersedeRegistry } from '../flushed-turn-supersede.js'
import { BackstopDeliveryLedger } from '../gateway/backstop-delivery.js'
import { redact } from '../secret-detect/redact.js'
import type { CurrentTurn, NarrativeLaneDeps } from '../gateway/gateway.js'
import type { ReplyOwnerTier } from '../reply-owner-resolve.js'

/** The owner-resolution shape `resolveReplyOwnerTurn` returns, including the
 *  candidate set the content-gate bypass corroborates against. These fixtures
 *  never exercise the supersede path, so the candidates mirror the resolved turn
 *  (the corroborated shape) with no override needed. */
function ownerRes(turn: CurrentTurn | null, tier: ReplyOwnerTier) {
  const id = turn?.turnId ?? null
  return {
    turn,
    tier,
    candidates: {
      liveTurnId: tier === 'live' ? id : null,
      originTurnId: null,
      quotedTurnId: null,
      latestEndedTurnId: id,
      latestEndedAgeMs: 1_000,
      latestEndedTtlMs: 60_000,
    },
  }
}


const CHAT = '1001'

// ── fake bot recorder ─────────────────────────────────────────────────────
interface RecordedCall {
  method: string
  chat_id: string
  text: string | null
  message_id?: number
}
function makeFakeBot() {
  const calls: RecordedCall[] = []
  let nextId = 3000
  const api = {
    sendRichMessage: async (c: string, b: { markdown: string }) => {
      const id = ++nextId
      calls.push({ method: 'sendRichMessage', chat_id: c, text: b.markdown, message_id: id })
      return { message_id: id }
    },
    sendMessage: async (c: string, t: string) => {
      const id = ++nextId
      calls.push({ method: 'sendMessage', chat_id: c, text: t, message_id: id })
      return { message_id: id }
    },
    editMessageText: async (c: string, m: number, b: unknown) => {
      calls.push({
        method: 'editMessageText', chat_id: c,
        text: typeof b === 'string' ? b : (b as { markdown: string }).markdown, message_id: m,
      })
      return {}
    },
    deleteMessage: async (c: string, m: number) => {
      calls.push({ method: 'deleteMessage', chat_id: c, text: null, message_id: m })
      return true
    },
  }
  return { api, calls }
}

// ── a CurrentTurn sufficient for the lane paths ───────────────────────────
function makeLaneTurn(lane: ReturnType<typeof createNarrativeLane>, over: Partial<CurrentTurn> = {}): CurrentTurn {
  const turn = {
    turnId: 'turn-lane-1',
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
    ...over,
  } as unknown as CurrentTurn
  ;(turn as { narrativeGate?: unknown }).narrativeGate = lane.makeNarrativeGate(turn)
  return turn
}

// ── lane deps (minimal runtime-faithful fakes; real leaf modules imported by
//    the lane itself) ──────────────────────────────────────────────────────
function makeLane(opts?: { getCurrentTurn?: () => CurrentTurn | null }) {
  const { api, calls } = makeFakeBot()
  const noop = () => {}
  const fakeEA = {
    mayDrain: () => true,
    openOrEditCard: (_p: string, fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
  }
  const deps = {
    ACTIVITY_CARD_STORE_PATH: `${tmpdir()}/lane-golden-activity-cards.json`,
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
    getCurrentTurn: opts?.getCurrentTurn ?? (() => null),
    reconcileStatusPin: noop,
    robustApiCall: (fn: () => Promise<unknown>) => fn(),
    statusKey: (c: string, t?: number | null) => `${c}:${t ?? 'main'}`,
  } as unknown as NarrativeLaneDeps
  const lane = createNarrativeLane(deps)
  return { lane, calls }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

// ── the cases ─────────────────────────────────────────────────────────────

describe('narrative-lane golden — SHOW path opens then edits ONE feed card', () => {
  it('first SHOW opens the card (sendRichMessage) with the clipped narrative line', async () => {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    lane.showNarrativeStep(turn, 'Checking the gateway config for stale entries')
    await turn.activityInFlight
    const sends = calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('Checking the gateway config for stale entries')
    expect(turn.activityMessageId).toBe(sends[0]!.message_id)
    expect(turn.activityEverOpened).toBe(true)
  })

  it('second SHOW edits the SAME card in place — never a second bubble', async () => {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    lane.showNarrativeStep(turn, 'Step one of the work')
    await turn.activityInFlight
    lane.showNarrativeStep(turn, 'Step two of the work')
    await turn.activityInFlight
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
    const edits = calls.filter((c) => c.method === 'editMessageText')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    const last = edits[edits.length - 1]!
    expect(last.message_id).toBe(turn.activityMessageId)
    expect(last.text).toContain('Step two of the work')
  })

  it('composeTurnActivity: live render omits the step total; final render carries it', () => {
    const { lane } = makeLane()
    const turn = makeLaneTurn(lane, { labeledToolCount: 3 })
    turn.mirrorLines.push('Read the file', 'Ran the tests', 'Pushed the branch')
    const live = lane.composeTurnActivity(turn)
    const final = lane.composeTurnActivity(turn, true)
    expect(live).toBeTruthy()
    expect(final).toBeTruthy()
    expect(final!).toMatch(/3 steps/)
    expect(live!).not.toMatch(/3 steps/)
  })

  it('composeTurnActivity: the FINAL render ends with the ✅ + delivered-answer footer', () => {
    // Parity with the 🛠 worker card, which has always closed on `✅ <summary>`.
    // The agent card's analogue of the worker's `latestSummary` is the answer
    // the turn actually delivered (`turn.lastReplyText`); the lane threads it
    // into the header as `resultText` and the SHARED `deriveCardResult` renders
    // it. Fails on the pre-fix lane, which passed no result text at all.
    const { lane } = makeLane()
    const turn = makeLaneTurn(lane, { labeledToolCount: 2 })
    turn.mirrorLines.push('Read the file', 'Ran the tests')
    turn.lastReplyText = 'Standing by for the background merge waiter to complete.'
    const live = lane.composeTurnActivity(turn)
    const final = lane.composeTurnActivity(turn, true)
    expect(final!).toContain('─────')
    expect(final!.endsWith('✅ _Standing by for the background merge waiter to complete._')).toBe(true)
    // The LIVE render must not leak the footer — the turn is not finished.
    expect(live!).not.toContain('✅')
  })

  it('composeTurnActivity: a turn that delivered no answer renders NO footer (no fabrication)', () => {
    const { lane } = makeLane()
    const turn = makeLaneTurn(lane, { labeledToolCount: 2 })
    turn.mirrorLines.push('Read the file', 'Ran the tests')
    turn.lastReplyText = ''
    const final = lane.composeTurnActivity(turn, true)
    expect(final!).not.toContain('─────')
    expect(final!).not.toContain('✅')
  })
})

describe('narrative-lane golden — the narrative-dedup gate at turn end', () => {
  it('genuine trailing narration is SHOWN (lands in the feed card)', async () => {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    lane.stagePendingNarrative(turn, 'Done - all checks green, wrapping up.')
    lane.flushPendingNarrativeAtTurnEnd(turn, 'Here is your answer: the fix is deployed.')
    await turn.activityInFlight
    const sends = calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('Done - all checks green')
  })

  it('a trailing draft-of-reply is SUPPRESSED (zero card writes)', async () => {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    const answer = 'The fix is deployed and the tests are green.'
    lane.stagePendingNarrative(turn, answer)
    lane.flushPendingNarrativeAtTurnEnd(turn, answer)
    await settle()
    expect(calls).toHaveLength(0)
  })
})

describe('narrative-lane golden — clearActivitySummary finalize', () => {
  it('finalizes the open card with a terminal EDIT (default: no delete)', async () => {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane, { labeledToolCount: 1 })
    lane.showNarrativeStep(turn, 'Doing the work now')
    await turn.activityInFlight
    const cardId = turn.activityMessageId
    expect(cardId).not.toBeNull()
    lane.clearActivitySummary(turn)
    await settle()
    const edits = calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId)
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    // tracking released so a late render can't resurrect the card
    expect(turn.activityMessageId).toBeNull()
  })
})

// ── #4348 — silent-sentinel activity card is SUPPRESSED (deleted, not finalized) ─
// A turn whose entire user-facing outcome is a bare NO_REPLY / HEARTBEAT_OK
// (the sentinel-reply-guard dropped the sentinel-only reply, or the flush net
// classified the captured text as silent) must leave NO visible telemetry card
// in the chat — most visibly on the forced-synthesis handback turns a
// background sub-agent injects. A real reply's card must still finalize.
describe('narrative-lane golden — silent-sentinel card suppression (#4348)', () => {
  // Open the feed card on a fresh (working) turn FIRST — the card-open gate
  // (mayOpenActivityCard) won't open one once the answer is already delivered —
  // then stamp the turn's terminal outcome, exactly as the real turn does:
  // the card opens mid-work, and lastReplyText / finalAnswerEverDelivered are
  // only known at turn end.
  async function openThenClear(over: Partial<CurrentTurn>) {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    lane.showNarrativeStep(turn, 'Doing the work now')
    await turn.activityInFlight
    const cardId = turn.activityMessageId
    expect(cardId).not.toBeNull()
    Object.assign(turn, over)
    lane.clearActivitySummary(turn)
    await settle()
    return { calls, cardId, turn }
  }

  it('reply("NO_REPLY") turn: DELETES the card, never edits a done record', async () => {
    // The guard drops the sentinel-only reply before chat, but the blocked
    // tool_use still stamps lastReplyText — the exact `✓ NO_REPLY` noise card.
    const { calls, cardId, turn } = await openThenClear({
      replyCalled: true,
      lastReplyText: 'NO_REPLY',
      finalAnswerEverDelivered: false,
    })
    expect(calls.filter((c) => c.method === 'deleteMessage' && c.message_id === cardId)).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId)).toHaveLength(0)
    expect(turn.activityMessageId).toBeNull()
  })

  it('HEARTBEAT_OK. (trailing punctuation, case-insensitive) is also suppressed', async () => {
    const { calls, cardId } = await openThenClear({
      replyCalled: true,
      lastReplyText: 'heartbeat_ok.',
      finalAnswerEverDelivered: false,
    })
    expect(calls.filter((c) => c.method === 'deleteMessage' && c.message_id === cardId)).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId)).toHaveLength(0)
  })

  it('flush path (no reply): prose + trailing NO_REPLY (H6/#2053) is suppressed', async () => {
    const { calls, cardId } = await openThenClear({
      replyCalled: false,
      lastReplyText: '',
      capturedText: ["Nothing actionable in today's digest.", 'NO_REPLY'],
      finalAnswerEverDelivered: false,
    })
    expect(calls.filter((c) => c.method === 'deleteMessage' && c.message_id === cardId)).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId)).toHaveLength(0)
  })

  it('normal reply turn: still FINALIZES the card (edit, no delete)', async () => {
    // The guarantee the fix must not break: a real answer keeps its record.
    const { calls, cardId, turn } = await openThenClear({
      replyCalled: true,
      lastReplyText: 'The fix is deployed and the tests are green.',
      finalAnswerEverDelivered: true,
    })
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId).length)
      .toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(turn.activityMessageId).toBeNull()
  })

  it('reply "prose\\nNO_REPLY" that WAS delivered (finalAnswerEverDelivered) keeps its card', async () => {
    // The guard does NOT drop a reply with non-marker content, so its prose
    // reached chat — endsWithSilentMarker must NOT suppress a delivered reply.
    const { calls, cardId } = await openThenClear({
      replyCalled: true,
      lastReplyText: 'Here is the full answer to your question.\nNO_REPLY',
      finalAnswerEverDelivered: true,
    })
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId).length)
      .toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
  })
})

// ── #45 — HOLLOW activity card is SUPPRESSED (deleted, not finalized) ──────────
// A turn injected into the session (typically a duplicate sub-agent handback
// beat) adopts a per-turn activity card at turn START, then ends having done
// ZERO surfaced tool work, never calling reply, delivering no final answer, and
// emitting no captured/reply text. The card was posted but never got content —
// the contentless `🤖 Agent · done · 0 tools · Ns` record. The #4348 sentinel
// gate can't catch it (no NO_REPLY/HEARTBEAT_OK text to match), so the hollow
// gate must DELETE it. A turn with ANY real content keeps its card.
describe('narrative-lane golden — hollow-ghost card suppression (#45)', () => {
  // Same open-then-stamp shape as the #4348 suite: open the feed card on a
  // fresh (working) turn, then set the turn's terminal outcome and clear.
  async function openThenClear(over: Partial<CurrentTurn>) {
    const { lane, calls } = makeLane()
    const turn = makeLaneTurn(lane)
    lane.showNarrativeStep(turn, 'Doing the work now')
    await turn.activityInFlight
    const cardId = turn.activityMessageId
    expect(cardId).not.toBeNull()
    Object.assign(turn, over)
    lane.clearActivitySummary(turn)
    await settle()
    return { calls, cardId, turn }
  }

  it('genuinely hollow turn (0 tools, no reply, no text, no narration): DELETES the card, no done edit', async () => {
    // The exact #45 ghost-reply signature Ken reported: a card opened by the
    // liveness timer that stayed contentless — `mirrorLines` EMPTY. FAILS
    // pre-fix: clearActivitySummary finalizes a contentless `done · 0 tools`
    // card with an editMessageText instead of deleting it.
    //
    // `mirrorLines: []` is set explicitly: `openThenClear` opens the card via
    // `showNarrativeStep`, which pushes a line into `mirrorLines`; resetting it
    // to empty here isolates Ken's real signature (card open via the timer, no
    // surfaced narration) from the narration-only case pinned below.
    const { calls, cardId, turn } = await openThenClear({
      replyCalled: false,
      labeledToolCount: 0,
      mirrorLines: [],
      capturedText: [],
      lastReplyText: '',
      finalAnswerEverDelivered: false,
    })
    expect(calls.filter((c) => c.method === 'deleteMessage' && c.message_id === cardId)).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId)).toHaveLength(0)
    // Tracking released so a late render / superseded-prior finalize can't
    // resurrect the card.
    expect(turn.activityMessageId).toBeNull()
  })

  it('a narration-only turn (a rendered mirror line, 0 tools/reply/text) KEEPS its card (edit, no delete)', async () => {
    // The regression the edit-flood-fuse pin
    // (activity-drain-fuse-drop-not-failure.test.ts "a terminal card render is
    // never shed") protects, pinned here in the fix's own suite: a turn that
    // surfaced a `showNarrativeStep` line the user SAW is legitimate content —
    // NOT Ken's empty ghost card — so the card must FINALIZE, never be deleted.
    // `openThenClear` already surfaced "Doing the work now" into `mirrorLines`;
    // we deliberately do NOT reset it, so the hollow gate must keep the card.
    const { calls, cardId } = await openThenClear({
      replyCalled: false,
      labeledToolCount: 0,
      capturedText: [],
      lastReplyText: '',
      finalAnswerEverDelivered: false,
    })
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId).length)
      .toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
  })

  it('a turn that did surfaced tool work is NOT hollow — its card FINALIZES (edit, no delete)', async () => {
    // The guarantee the fix must not break: a card carrying a real `✓ N steps`
    // body stays as a record even when the turn never replied.
    const { calls, cardId } = await openThenClear({
      replyCalled: false,
      labeledToolCount: 3,
      capturedText: [],
      lastReplyText: '',
      finalAnswerEverDelivered: false,
    })
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId).length)
      .toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
  })

  it('a turn that delivered a final answer keeps its card (edit, no delete)', async () => {
    const { calls, cardId } = await openThenClear({
      replyCalled: true,
      labeledToolCount: 0,
      lastReplyText: 'The three services are all green.',
      finalAnswerEverDelivered: true,
    })
    expect(calls.filter((c) => c.method === 'editMessageText' && c.message_id === cardId).length)
      .toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
  })
})

// ── THREE-MODULE cross-surface dedup (Amendment 1) ────────────────────────
// The REAL P4-A handleSessionEvent turn-flush, with the REAL P4-B lane wired
// into its deps, records the delivered answer into ONE OutboundDedupCache;
// the REAL P2 sendReply holding the SAME instance then suppresses the late
// same-text reply. One shared cache across all three extracted modules.

function makeStreamDepsWithRealLane(dedup: OutboundDedupCache, turn: CurrentTurn, lane: ReturnType<typeof createNarrativeLane>) {
  const { api } = makeFakeBot()
  const noop = () => {}
  const delivered: string[] = []
  const fakeEA = {
    claimOrDowngradePing: (_i: unknown, _s: unknown, _a: unknown, disabled: () => void) => disabled(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
    mayDrain: () => true,
    openOrEditCard: (_p: string, fn: () => void) => fn(),
  }
  const deps = {
    ANSWER_LANE: { visibleEnabled: false },
    CAPTURED_PROSE_DELIVERY_ENABLED: false,
    CONTEXT_EXHAUSTION_COOLDOWN_MS: 600000,
    DELIVERY_CONFIRM_ENABLED: false,
    FEED_REOPEN_AFTER_ACK_ENABLED: false,
    HANDBACK_PRETURN_ENABLED: false,
    HISTORY_ENABLED: false,
    LIVENESS_TERMINAL_HONESTY: true,
    OBLIGATION_LEDGER_ENABLED: false,
    ORPHANED_REPLY_STREAM_WINDOW_MS: 120000,
    SILENCE_LIVENESS_PRODUCTION: false,
    STATE_DIR: tmpdir(),
    TURN_FLUSH_SAFETY_ENABLED: true,
    TURN_PREVIEW_MAX: 200,
    activeDraftStreams: new Map(),
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    backstopDeliveryLedger: new BackstopDeliveryLedger(),
    bot: { api },
    flushedTurnSupersede: new FlushedTurnSupersedeRegistry(),
    idleTracker: { noteEvent: noop },
    lastPtyPreviewByChat: new Map(),
    obligationLedger: { close: noop, noteTurnEnded: noop },
    outboundDedup: dedup,
    pendingCrossTurnGate: new Map(),
    preambleSuppressor: { dropNow: noop, flushNow: noop, onText: noop, onTool: noop, reset: noop },
    progressDriver: null,
    reactionTransitionCounts: new Map(),
    suppressPtyPreview: new Set(),
    toolFlightTracker: { inFlightCount: () => 0 },
    deliveryQueue: {},
    handbackPreturnSignal: { tryAdopt: () => null },
    sessionModelSource: { noteTranscriptModel: noop },
    typingWrapper: { drainAll: noop, onToolResult: noop, onToolUse: noop },
    robustApiCall: (fn: () => Promise<unknown>) => fn(),
    swallowingApiCall: async (fn: () => Promise<unknown>) => { try { return await fn() } catch { return undefined } },
    getCurrentTurn: () => turn,
    getLastContextExhaustionWarningAt: () => 0,
    setLastContextExhaustionWarningAt: noop,
    getPendingPtyPartial: () => null,
    setPendingPtyPartial: noop,
    setCurrentTurn: noop,
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    // ── the REAL P4-B lane wired in (not fakes) ──
    clearActivitySummary: lane.clearActivitySummary,
    closeActivityLane: lane.closeActivityLane,
    closeProgressLane: lane.closeProgressLane,
    composeTurnActivity: lane.composeTurnActivity,
    drainActivitySummary: lane.drainActivitySummary,
    flushPendingNarrativeAtTurnEnd: lane.flushPendingNarrativeAtTurnEnd,
    makeNarrativeGate: lane.makeNarrativeGate,
    resolvePendingNarrativeOnTool: lane.resolvePendingNarrativeOnTool,
    stagePendingNarrative: lane.stagePendingNarrative,
    scheduleEarlyLivenessOpen: lane.scheduleEarlyLivenessOpen,
    // ────────────────────────────────────────────
    clearAnswerReadyFlushTimeout: noop,
    completeProgressCardTurn: null,
    confirmMemoryLegibility: noop,
    deliverAnswer: async (a: { text: string }) => {
      delivered.push(a.text)
      return { sentIds: [4242], chunkCount: 1, delivered: true, exhausted: false }
    },
    deliverCapturedProse: async () => {},
    emissionAuthorityFor: () => fakeEA,
    emitTurnRecord: noop,
    endCurrentTurnAtomic: () => null,
    extractUserPromptPreview: () => null,
    finalizeStatusReaction: noop,
    getPinnedProgressCardMessageId: null,
    handlePtyPartial: noop,
    isDmChatId: () => true,
    isLegitimatelyWorking: () => false,
    promoteQueuedStatus: noop,
    purgeReactionTracking: noop,
    redactOutboundText: (t: string) => redact(t),
    rememberRecentTurn: noop,
    resetAnswerReadyFlushTimeout: noop,
    resetOrphanedReplyTimeout: noop,
    startTurnTypingLoop: noop,
    statusKey: (c: string, t?: number | null) => `${c}:${t ?? 'main'}`,
    streamKey: (c: string, t?: number | null) => `${c}:${t ?? 'main'}`,
    surfaceMemoryLegibility: noop,
    turnLiveForItsTopic: () => true,
    turnsDb: null,
    unpinProgressCardForChat: null,
  } as unknown as StreamRenderDeps
  return { deps, delivered }
}

function makeSendReplyDeps(dedup: OutboundDedupCache) {
  const { api, calls } = makeFakeBot()
  const key = (c: string, t?: number | null) => `${c}:${t ?? 'main'}`
  const deps = {
    outboundDedup: dedup,
    flushedTurnSupersede: new FlushedTurnSupersedeRegistry(),
    firstTextReplyLogged: new Set<string>(),
    suppressPtyPreview: new Set<string>(),
    activeDraftStreams: new Map(),
    lastPtyPreviewByChat: new Map(),
    voiceOnDemandCache: { put: () => {} },
    voicePreSynthQueue: { enqueue: () => {} },
    pendingProgress: { clearPending: () => {}, noteOutbound: () => {} },
    signalTracker: { noteOutbound: () => {}, noteSignal: () => {} },
    silencePoke: { noteOutbound: () => {} },
    getCurrentTurn: () => null,
    getLastActiveTurnChatId: () => undefined,
    HISTORY_ENABLED: false,
    TURN_ORIGIN_ROUTING_ENABLED: true,
    AUTOCLASSIFY_MIDTURN_SHADOW: false,
    MAX_ATTACHMENT_BYTES: 50 * 1024 * 1024,
    MAX_CHUNK_LIMIT: 4096,
    PHOTO_EXTS: new Set(['.jpg', '.png']),
    lockedBot: { api },
    robustApiCall: (fn: () => Promise<unknown>) => fn(),
    swallowingApiCall: async (fn: () => Promise<unknown>) => { try { return await fn() } catch { return undefined } },
    loadAccess: () => ({ allowFrom: [CHAT], groups: {}, disableLinkPreview: true }),
    redactOutboundText: (t: string) => redact(t),
    assertAllowedChat: () => {},
    assertSendable: () => {},
    statusKey: key,
    streamKey: key,
    resolveReplyOwnerTurn: () => ownerRes(null, 'none'),
    getLastSubagentHandbackAt: () => null,
    // #4176 — no sub-agent live on this session (see subagent-reply-authority.ts).
    subagentReplyAuthority: { subagentCouldOwnReply: () => false },
    findTurnByOriginId: () => null,
    findTurnByQuotedMessageId: () => null,
    resolveAnswerThreadWithLog: (_c: string, explicit: number | undefined) => explicit,
    resolveThreadId: (_c: string, explicit?: string | number | null) => (explicit != null ? Number(explicit) : undefined),
    getLatestInboundMessageId: () => null,
    recordOutbound: () => {},
    emissionAuthorityFor: () => ({
      claimOrDowngradePing: (_i: unknown, _s: unknown, _a: unknown, disabled: () => void) => disabled(),
      markSubstantiveFinalDelivered: (fn: () => void) => fn(),
      finalizeCard: (fn: () => void) => fn(),
    }),
    clearActivitySummary: () => {},
    startTypingLoop: () => {},
    stopTypingLoop: () => {},
    logOutbound: () => {},
    closeObligationOnSubstantiveReply: () => {},
    finalizeStatusReaction: () => {},
    releaseTurnBufferGate: () => {},
    reapQueuedStatus: () => {},
    noteAgentOutputAt: () => {},
    rememberAgentButtonMeta: () => {},
    resolveVoiceOutPlan: () => null,
    synthesizeVoiceOut: async () => null,
    publishToTelegraph: async () => null,
    clearSilentEndState: () => {},
    emitRuntimeMetric: () => {},
    shadowEmit: () => {},
    progressDriver: null,
  } as unknown as SendReplyGatewayDeps
  return { deps, calls }
}
function req(text: string): SendReplyRequest {
  return { args: { chat_id: CHAT, text }, turn: null }
}

describe('THREE-MODULE cross-surface dedup — one OutboundDedupCache across P4-B lane + P4-A stream + P2 reply', () => {
  it('turn-flush through the REAL stream module (REAL lane wired in) records; the REAL sendReply dedups', async () => {
    const dedup = new OutboundDedupCache()
    const { lane } = makeLane()
    const answer = 'The lane-wired terminal answer the model never sent via reply.'
    const turn = makeLaneTurn(lane, { capturedText: [answer], turnId: 'turn-3mod' })
    const { deps } = makeStreamDepsWithRealLane(dedup, turn, lane)
    handleSessionEvent(deps, { kind: 'turn_end', durationMs: 1200 })
    await new Promise((r) => setTimeout(r, 650))
    expect(dedup.check(CHAT, undefined, answer, Date.now(), null)).not.toBeNull()

    const s = makeSendReplyDeps(dedup)
    const res = await sendReply(s.deps, req(answer))
    expect(res.content[0]!.text).toBe('sent (deduped — same content sent via earlier path)')
    expect(s.calls).toHaveLength(0)
  })
})

describe('structural — singleton + wrapper discipline (#2996 P4-B)', () => {
  const gatewaySrc = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  const laneSrc = readFileSync(new URL('../gateway/narrative-lane.ts', import.meta.url), 'utf8')

  it('the lane constructs NO OutboundDedupCache and NO BackstopDeliveryLedger', () => {
    expect(laneSrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(0)
    expect(laneSrc.match(/new BackstopDeliveryLedger\(/g) ?? []).toHaveLength(0)
    // gateway still constructs exactly ONE dedup cache (the injected singleton).
    expect(gatewaySrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(1)
  })

  it('the lane never reads the currentTurn global — only the injected accessor', () => {
    const codeOnly = laneSrc
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(codeOnly).not.toMatch(/[^.\w]currentTurn\b(?!\s*[:,)])/)
    expect(codeOnly).toMatch(/getCurrentTurn\(\)/)
  })

  it('gateway builds the lane LAZILY with the injected deps and delegates via same-name wrappers', () => {
    expect(gatewaySrc).toContain('narrativeLaneInstance ??= createNarrativeLane(gatewayNarrativeLaneDeps())')
    for (const fn of ['composeTurnActivity', 'drainActivitySummary', 'clearActivitySummary', 'feedHeartbeatTick', 'flushPendingNarrativeAtTurnEnd']) {
      expect(gatewaySrc).toMatch(new RegExp(`narrativeLane\\(\\)\\.${fn}\\(`))
    }
    // the deps builder injects the live-turn accessor (Amendment 9)
    const after = gatewaySrc.split('function gatewayNarrativeLaneDeps(')[1] ?? ''
    const body = after.split('\nexport ')[0] ?? after
    expect(body).toContain('getCurrentTurn: () => currentTurn')
  })
})
