/**
 * Golden-transcript harness for the extracted stream/render dispatcher
 * (#2996 P4-A, plan Amendments 1/5/9/10).
 *
 * ── Oracle standard (Amendment 10) ────────────────────────────────────────
 * gateway.ts cannot be driven in-place from a test runner (`handleSessionEvent`
 * was unexported; `bot` is assigned only inside the isGatewayMain boot). The
 * coordinator-accepted oracle is therefore the EXTRACTED-MODULE golden harness
 * (the merged send-reply-golden precedent): the real `handleSessionEvent` is
 * driven with synthetic SessionEvent sequences against a fake bot recorder +
 * the REAL `OutboundDedupCache`, with gateway-scoped closures faked.
 *
 * ── The load-bearing case (Amendment 1, BLOCKING) ─────────────────────────
 * CROSS-SURFACE stream-then-reply dedup spanning BOTH extracted modules on ONE
 * shared `OutboundDedupCache`: the REAL P4 `handleSessionEvent` turn-flush path
 * records the delivered answer into the cache, then the REAL P2 `sendReply`
 * (a DIFFERENT module) checking that SAME instance suppresses a late same-text
 * reply — zero wire calls. A negative control proves a second cache reinstates
 * the duplicate. This is the exact duplicate-reply class the shared-singleton
 * injection (never a re-`new`) exists to kill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  handleSessionEvent,
  __resetParkedTurnStartsForTest,
  flushCompletionTracker,
  closeFlushCompletionWindows,
  type StreamRenderDeps,
} from '../gateway/stream-render.js'
import {
  sendReply,
  type SendReplyGatewayDeps,
  type SendReplyRequest,
} from '../gateway/outbound-send-path.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { FlushedTurnSupersedeRegistry, SUPERSEDE_COMPLETED_GRACE_MS } from '../flushed-turn-supersede.js'
import { BackstopDeliveryLedger } from '../gateway/backstop-delivery.js'
import { redact } from '../secret-detect/redact.js'
import { createTurnTypingLoop } from '../gateway/turn-typing-loop.js'
import {
  createTypingEmitter,
  TYPING_FLOOR_MS,
  TYPING_REFRESH_MS,
} from '../typing-emitter.js'
import type { CurrentTurn } from '../gateway/gateway.js'
import type { ReplyOwnerTier } from '../reply-owner-resolve.js'

// The parked turn-start store is module-scope and `bun test` runs every file in
// ONE process, so the two describe-scoped `beforeEach` resets below clean ENTRY
// only — a case that ends mid-park still leaks into the next FILE, where the
// obligation sweep reads the leftover as a busy session (#4611). File-level so
// it covers every case here, not just the two blocks that reset on entry.
afterEach(() => {
  __resetParkedTurnStartsForTest()
})

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

// ── fake bot recorder (shared shape with send-reply-golden) ────────────────
interface RecordedCall {
  method: string
  chat_id: string
  text: string | null
  opts: Record<string, unknown>
  reply_markup: unknown
  message_id?: number
}
function makeFakeBot() {
  const calls: RecordedCall[] = []
  let nextId = 2000
  const rec = (method: string, chat_id: string, text: string | null, opts: Record<string, unknown> = {}) => {
    const id = ++nextId
    calls.push({ method, chat_id, text, opts, reply_markup: opts.reply_markup ?? null, message_id: id })
    return { message_id: id }
  }
  const api = {
    sendRichMessage: async (c: string, b: { markdown: string }, o: Record<string, unknown> = {}) => rec('sendRichMessage', c, b.markdown, o),
    sendMessage: async (c: string, t: string, o: Record<string, unknown> = {}) => rec('sendMessage', c, t, o),
    editMessageText: async (c: string, m: number, b: unknown, o: Record<string, unknown> = {}) => {
      // Preserve the REAL edit target id (m) so tests can assert an edit-in-place
      // hit the flushed message, not a synthetic fresh id.
      calls.push({ method: 'editMessageText', chat_id: c, text: typeof b === 'string' ? b : (b as { markdown: string }).markdown, opts: o, reply_markup: o.reply_markup ?? null, message_id: m })
      return {}
    },
    deleteMessage: async (c: string, m: number) => { rec('deleteMessage', c, null); return true },
  }
  return { api, calls }
}

// ── a CurrentTurn sufficient for the turn-flush record path ────────────────
function makeTurn(over: Partial<CurrentTurn> = {}): CurrentTurn {
  return {
    turnId: 'turn-flush-1',
    sessionChatId: CHAT,
    sessionThreadId: undefined,
    registryKey: null,
    sourceMessageId: null,
    startedAt: Date.now() - 5000,
    replyCalled: false,
    lastReplyText: '',
    answerStream: null,
    capturedText: ['The composed terminal answer that the model never sent via reply.'],
    capturedBlockMeta: [false],
    finalAnswerDelivered: false,
    finalAnswerSubstantive: false,
    answerDelivered: false,
    deliveryOutcome: undefined,
    orphanedReplyTimeoutId: null,
    orphanedReplyStreamMsgId: null,
    activityPendingRender: null,
    liveness: { recentlyStreaming: () => false, onStreamEvent: () => {}, note: () => {} },
    ...over,
  } as unknown as CurrentTurn
}

// ── the full injected deps, minimal but runtime-faithful fakes ─────────────
interface StreamHarness {
  deps: StreamRenderDeps
  calls: RecordedCall[]
  dedup: OutboundDedupCache
  ledger: BackstopDeliveryLedger
  delivered: string[]
}
function makeStreamDeps(opts?: {
  dedup?: OutboundDedupCache
  turn?: CurrentTurn | null
  deliverResult?: { sentIds: number[]; chunkCount: number; delivered: boolean; exhausted: boolean }
  flushedTurnSupersede?: FlushedTurnSupersedeRegistry
}): StreamHarness {
  const { api, calls } = makeFakeBot()
  const dedup = opts?.dedup ?? new OutboundDedupCache()
  const ledger = new BackstopDeliveryLedger()
  const delivered: string[] = []
  let curTurn = opts?.turn ?? null
  const key = (c: string, t?: number | null) => `${c}:${t ?? 'main'}`
  const noop = () => {}
  const fakeEA = {
    claimOrDowngradePing: (_i: unknown, _s: unknown, _a: unknown, disabled: () => void) => disabled(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
  }
  const deps = {
    // config
    ANSWER_LANE: { visibleEnabled: false } as unknown,
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
    // state singletons
    activeDraftStreams: new Map(),
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    backstopDeliveryLedger: ledger,
    bot: { api },
    flushedTurnSupersede: opts?.flushedTurnSupersede ?? new FlushedTurnSupersedeRegistry(),
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
    // volatile accessors
    getCurrentTurn: () => curTurn,
    getLastContextExhaustionWarningAt: () => 0,
    setLastContextExhaustionWarningAt: noop,
    getPendingPtyPartial: () => null,
    setPendingPtyPartial: noop,
    setCurrentTurn: (t: CurrentTurn) => { curTurn = t },
    // local-closure fakes
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    clearActivitySummary: noop,
    clearAnswerReadyFlushTimeout: noop,
    closeActivityLane: noop,
    closeProgressLane: noop,
    completeProgressCardTurn: null,
    composeTurnActivity: () => null,
    confirmMemoryLegibility: noop,
    deliverAnswer: async (a: { text: string }) => {
      delivered.push(a.text)
      return opts?.deliverResult ?? { sentIds: [4242], chunkCount: 1, delivered: true, exhausted: false }
    },
    deliverCapturedProse: async () => {},
    drainActivitySummary: async () => {},
    emissionAuthorityFor: () => fakeEA,
    emitTurnRecord: noop,
    endCurrentTurnAtomic: () => null,
    extractUserPromptPreview: () => null,
    finalizeStatusReaction: noop,
    flushPendingNarrativeAtTurnEnd: noop,
    getPinnedProgressCardMessageId: null,
    handlePtyPartial: noop,
    isDmChatId: () => true,
    isLegitimatelyWorking: () => false,
    // `teardown` is exercised when a SECOND enqueue supersedes a prior turn.
    makeNarrativeGate: () => ({ show: noop, stage: noop, resolveOnTool: noop, flushAtTurnEnd: noop, teardown: noop }),
    promoteQueuedStatus: noop,
    purgeReactionTracking: noop,
    redactOutboundText: (t: string) => redact(t),
    rememberRecentTurn: noop,
    resetAnswerReadyFlushTimeout: noop,
    resetOrphanedReplyTimeout: noop,
    resolvePendingNarrativeOnTool: noop,
    scheduleEarlyLivenessOpen: noop,
    stagePendingNarrative: noop,
    startTurnTypingLoop: noop,
    statusKey: key,
    streamKey: key,
    surfaceMemoryLegibility: noop,
    turnLiveForItsTopic: () => true,
    turnsDb: null,
    unpinProgressCardForChat: null,
  } as unknown as StreamRenderDeps
  return { deps, calls, dedup, ledger, delivered }
}

// ── the P2 sendReply harness (same content, sharing the ONE cache) ─────────
function makeSendReplyDeps(dedup: OutboundDedupCache, sharedSupersede?: FlushedTurnSupersedeRegistry) {
  const { api, calls } = makeFakeBot()
  const key = (c: string, t?: number | null) => `${c}:${t ?? 'main'}`
  const deps = {
    outboundDedup: dedup,
    flushedTurnSupersede: sharedSupersede ?? new FlushedTurnSupersedeRegistry(),
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
    // #4176 — no sub-agent live (these suites drive the parent session's own
    // flush→reply collapse). The gate is exercised in send-reply-golden.test.ts.
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

// give the turn-flush IIFE (500ms internal setTimeout) time to reach the record
const settle = () => new Promise((r) => setTimeout(r, 650))

// ── the cases ──────────────────────────────────────────────────────────────

describe('stream-render — turn-flush records into the shared OutboundDedupCache', () => {
  it('drives the REAL handleSessionEvent turn-flush path to outboundDedup.record', async () => {
    const turn = makeTurn()
    const answer = turn.capturedText.join('')
    const h = makeStreamDeps({ turn })
    handleSessionEvent(h.deps, { kind: 'turn_end', durationMs: 1200 })
    await settle()
    expect(h.delivered).toContain(answer)
    // the module's OWN record statement (stream-render.ts:1784) ran
    expect(h.dedup.check(CHAT, undefined, answer, Date.now(), null)).not.toBeNull()
  })
})

// ── #3237 HARD GATE: block provenance survives stream-render accumulation ───
// The whole fix hinges on `ev.lastInMessage` surviving the `case 'text'`
// accumulation into `turn.capturedBlockMeta` and reaching selectFlushDeliveryText
// via decideTurnFlush. These drive the REAL handleSessionEvent text path (not a
// preset capturedText) so the accumulation code actually runs, then assert BOTH
// the accumulated provenance AND the flush's delivered text. Each case is
// engineered so the OPPOSITE outcome would result if provenance were lost and
// the strip fell back to the opener heuristic — proving structure is consulted.
describe('#3237 — block provenance survives accumulation and reaches the flush strip', () => {
  function driveTextTurn(blocks: Array<{ text: string; lastInMessage: boolean }>) {
    const turn = makeTurn({ capturedText: [], capturedBlockMeta: [], answerStream: null })
    const h = makeStreamDeps({ turn })
    blocks.forEach((b, i) =>
      handleSessionEvent(h.deps, {
        kind: 'text',
        text: b.text,
        blockIndex: i,
        lastInMessage: b.lastInMessage,
      }),
    )
    return { turn, h }
  }

  it('narration FOLLOWED by a tool_use (lastInMessage=false) → provenance=[true,false], flush strips the preamble', async () => {
    // "Here are the figures." matches NO opener regex — if provenance were lost
    // the opener-only strip would KEEP it and deliver the whole blob. Structure
    // ([true,false]) strips it. Asserting answer-only proves structure was used.
    const narration = 'Here are the figures you asked about.'
    const answer = 'All three services are green.'
    const { turn, h } = driveTextTurn([
      { text: narration, lastInMessage: false }, // a tool_use followed it in its message
      { text: answer, lastInMessage: true }, // terminal
    ])
    // Provenance survived the accumulation into the parallel array.
    expect(turn.capturedBlockMeta).toEqual([true, false])
    handleSessionEvent(h.deps, { kind: 'turn_end', durationMs: 1200 })
    await settle()
    expect(h.delivered.join('\n')).toContain(answer)
    expect(h.delivered.join('\n')).not.toContain('Here are the figures')
  })

  it('#3237 real answer: two paragraphs, NEITHER followed by a tool_use (lastInMessage=true) → provenance=[false,false], flush keeps BOTH (no truncation)', async () => {
    // p1 OPENS with "Let me explain…" — the opener strip WOULD drop it if
    // provenance were lost. Structure ([false,false]) keeps the full answer.
    const p1 = 'Let me explain the plan in two parts.'
    const p2 = 'Part two: we ship it behind the existing flag.'
    const { turn, h } = driveTextTurn([
      { text: p1, lastInMessage: true },
      { text: p2, lastInMessage: true },
    ])
    expect(turn.capturedBlockMeta).toEqual([false, false])
    handleSessionEvent(h.deps, { kind: 'turn_end', durationMs: 1200 })
    await settle()
    const out = h.delivered.join('\n')
    expect(out).toContain('Let me explain the plan')
    expect(out).toContain('Part two')
  })
})

describe('cross-surface dedup — ONE OutboundDedupCache across P4 stream + P2 reply (Amendment 1)', () => {
  it('a P4 turn-flush record suppresses the P2 same-text reply (zero wire calls)', async () => {
    const dedup = new OutboundDedupCache()
    const turn = makeTurn()
    const answer = turn.capturedText.join('')
    // P4 surface (real handleSessionEvent) records into the shared cache.
    const h = makeStreamDeps({ dedup, turn })
    handleSessionEvent(h.deps, { kind: 'turn_end', durationMs: 1200 })
    await settle()
    expect(h.dedup.check(CHAT, undefined, answer, Date.now(), null)).not.toBeNull()

    // P2 surface (real sendReply) holding the SAME instance dedups the late reply.
    const s = makeSendReplyDeps(dedup)
    const res = await sendReply(s.deps, req(answer))
    expect(res.content[0]!.text).toBe('sent (deduped — same content sent via earlier path)')
    expect(s.calls).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: a SECOND cache reinstates the duplicate reply', async () => {
    const streamCache = new OutboundDedupCache()
    const turn = makeTurn()
    const answer = turn.capturedText.join('')
    const h = makeStreamDeps({ dedup: streamCache, turn })
    handleSessionEvent(h.deps, { kind: 'turn_end', durationMs: 1200 })
    await settle()
    expect(streamCache.check(CHAT, undefined, answer, Date.now(), null)).not.toBeNull()

    // A DIFFERENT instance (the forbidden re-`new`) never saw the P4 record.
    const s = makeSendReplyDeps(new OutboundDedupCache())
    await sendReply(s.deps, req(answer))
    expect(s.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
  })
})

// ── F3 (dup-audit 2026-07-21): the flush RECORD wiring is load-bearing ──────
//
// The entire flush→reply dedup depends on stream-render.ts recording the
// flush's delivered ids into the shared FlushedTurnSupersedeRegistry
// (`flushedTurnSupersede.record(...)`). Every OTHER outcome test seeds that
// record by hand (send-reply-golden's seedRecord/seedFlushRecord), so DELETING
// the record call would reintroduce the dominant flush→reply duplicate with all
// those tests still green. This drives the REAL flush record() end-to-end (no
// pre-seed) across ONE shared registry and asserts the reworded same-turn reply
// collapses to EXACTLY ONE message — so it goes RED if the record() call is
// removed. This is the guard the audit flagged as missing.
describe('F3 — flush record() → same-turn reworded reply collapse (end-to-end, no pre-seed)', () => {
  const settleFlush = () => new Promise((r) => setTimeout(r, 650))
  const FLUSHED_ANSWER =
    'All twelve agents are healthy right now. The gateway, the vault broker and the ' +
    'approval kernel all report green health checks, and no container has restarted in ' +
    'the last twenty four hours, so there is nothing that needs your attention at the moment.'
  const REWORDED =
    'Good news on the fleet. Every one of the twelve agents is running fine at the moment. ' +
    'Gateway, vault broker and approval kernel are all green, and nothing has restarted in ' +
    'the past day, so you do not need to do anything right now.'

  it('flush → record → late reworded reply collapses to ONE message ' +
    '(RED if stream-render flushedTurnSupersede.record is removed)', async () => {
    // ONE shared supersede registry across BOTH surfaces — exactly the gateway
    // singleton wiring. The flush RECORDS (the real stream-render.ts:1828 call);
    // the reply CONSUMES. Nothing is pre-seeded.
    const supersede = new FlushedTurnSupersedeRegistry()
    const turn = makeTurn({ capturedText: [FLUSHED_ANSWER], capturedBlockMeta: [true] })
    const sh = makeStreamDeps({ turn, flushedTurnSupersede: supersede })

    // Drive the REAL turn-flush path: it delivers message A (deliverAnswer → id
    // 4242) AND records {turnId, [4242]} into the shared registry.
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: 1200 })
    await settleFlush()
    expect(sh.delivered).toContain(FLUSHED_ANSWER)
    // The record actually landed (this is what a removal breaks first).
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() }).reason,
    ).toBe('supersede')

    // The model's REAL reply lands late with a REWORDED version of the same
    // answer: no live turn, latest-ended tier, NO handback in flight (CASE A).
    const s = makeSendReplyDeps(new OutboundDedupCache(), supersede)
    s.deps.resolveReplyOwnerTurn = () => ownerRes(turn, 'latest-ended')
    // (getLastSubagentHandbackAt returns null in the base deps → own answer.)

    const res = await sendReply(s.deps, req(REWORDED))

    // EXACTLY ONE client-visible message: the flushed message (4242) edited in
    // place into the reworded reply — NO fresh second bubble. Without the
    // record(), the reply finds no record, falls to the latch branch, sees
    // reworded ≠ flushed content, does NOT suppress, and ships a DUPLICATE
    // sendRichMessage (edits=0, sends=1) → these assertions fail.
    const edits = s.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(4242)
    expect(s.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })
})

// ── F5 (dup-audit): true take()-before-record() interleaving ────────────────
//
// The residual race the supersede registry cannot reach: a reply whose
// supersede take() runs in the window AFTER the flush FIRED but BEFORE it
// recorded its message ids. The flush arms `turn.answerDelivered='flush'` (+
// flushedAnswerText) SYNCHRONOUSLY at fire time — before its async deliver and
// before record — so a same-answer reply landing in that window is suppressed by
// the latch, not shipped as a duplicate. This drives a genuine two-emitter
// interleave (inverted ordering: reply take() strictly before flush record())
// and asserts exactly one delivered message.
describe('F5 — take()-before-record() interleaving delivers exactly one message', () => {
  const settleFlush = () => new Promise((r) => setTimeout(r, 650))
  // ≥200 chars so the late reply is a substantive final answer (the floor the
  // flush latch is scoped to) — else it would never trip the suppression.
  const ANSWER =
    'Yes, that is all done and confirmed. The migration ran cleanly against the staging ' +
    'database, every integration check passed on the first attempt, the rollback plan is ' +
    'staged in case it is ever needed, and I have written the full run log to the shared ' +
    'drive so the team can review exactly what changed and when it happened.'

  it('a reply whose take() runs BEFORE the flush record() is suppressed by the ' +
    'flush-armed latch — one delivered message, not two', async () => {
    const supersede = new FlushedTurnSupersedeRegistry()
    const turn = makeTurn({ capturedText: [ANSWER], capturedBlockMeta: [true] })
    const sh = makeStreamDeps({ turn, flushedTurnSupersede: supersede })

    // Fire the flush. Its latch is set SYNCHRONOUSLY here; deliverAnswer + record
    // run in the async IIFE that has NOT completed — the pre-record window.
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: 1200 })
    // INVERTED ORDERING: the reply's take() runs now, before the flush record().
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() }).reason,
    ).toBe('no-record') // record genuinely not written yet

    const s = makeSendReplyDeps(new OutboundDedupCache(), supersede)
    s.deps.resolveReplyOwnerTurn = () => ownerRes(turn, 'latest-ended')
    // The same answer landing again in the race window → latch backstop suppresses.
    const res = await sendReply(s.deps, req(ANSWER))

    expect(s.calls).toHaveLength(0) // the reply shipped nothing
    expect(res.content[0]!.text).toContain('deduped')

    await settleFlush() // let the flush's async deliver + record complete
    // Exactly one message reached the user: the flush's message A.
    expect(sh.delivered).toHaveLength(1)
    expect(sh.delivered[0]).toContain('done and confirmed')
  })
})

// ── Double-flush idempotency at the delivery primitive (audit §3.5) ─────────
//
// The E2-vs-E3 double flush (answer-ready quiescence THEN turn-end backstop for
// the SAME turn) is guarded by backstopDeliveryLedger.claim. The ledger is
// unit-tested, but the audit wanted it pinned at the SEND-COUNT level in the
// flush integration. Two turn_end dispatches for one turn must deliver once.
describe('double-flush idempotency — deliverAnswer fires once (send-count level)', () => {
  const settleFlush = () => new Promise((r) => setTimeout(r, 650))
  it('two turn_end dispatches for the same turn deliver the answer EXACTLY once', async () => {
    const turn = makeTurn()
    const answer = turn.capturedText.join('')
    const sh = makeStreamDeps({ turn })
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: 1200 }) // claims the latch
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: 1200 }) // claim fails → no-op
    await settleFlush()
    expect(sh.delivered).toEqual([answer])
  })
})

describe('structural — the singleton lives once in gateway, never in the modules (Amendment 1)', () => {
  const gatewaySrc = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  const streamSrc = readFileSync(new URL('../gateway/stream-render.ts', import.meta.url), 'utf8')
  const sendSrc = readFileSync(new URL('../gateway/outbound-send-path.ts', import.meta.url), 'utf8')

  it('gateway constructs EXACTLY ONE OutboundDedupCache; neither extracted module constructs any', () => {
    expect(gatewaySrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(1)
    expect(streamSrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(0)
    expect(sendSrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(0)
  })

  it('both gateway deps builders inject the SAME outboundDedup binding (never a re-new)', () => {
    for (const builder of ['function gatewayStreamRenderDeps(', 'function gatewaySendReplyDeps(']) {
      const after = gatewaySrc.split(builder)[1] ?? ''
      const body = after.split('\nfunction ')[0]?.split('\nexport ')[0] ?? after
      expect(body).toMatch(/\n\s{4}outboundDedup,/)
    }
  })

  it('handleSessionEvent is a thin wrapper delegating to the extracted module', () => {
    const after = gatewaySrc.split('function handleSessionEvent(ev: SessionEvent): void {')[1] ?? ''
    const body = after.split('\n}')[0] ?? after
    expect(body).toContain('handleSessionEventCore(gatewayStreamRenderDeps(), ev)')
  })

  it('#3544 — the handback seam\'s hasLiveTurn wiring verifies the live turn OWNS the key', () => {
    // Under the emission-authority flag OFF (default) `currentTurnMap.get(key)`
    // returns the most-recent singleton regardless of key. Without the
    // statusKey ownership check, a live turn on ANOTHER chat would suppress the
    // orphan reap's stop and leak a typing interval forever.
    const after = gatewaySrc.split('hasLiveTurn: (key) => {')[1] ?? ''
    const body = after.split('\n  },')[0] ?? after
    expect(body).toContain('currentTurnMap.get(key)')
    expect(body).toContain('live.endedAt != null')
    expect(body).toMatch(/statusKey\(live\.sessionChatId, live\.sessionThreadId\) === key/)
  })

  it('the module never reads the currentTurn global — only getCurrentTurn() (Amendment 9)', () => {
    const fnBody = streamSrc.split('export function handleSessionEvent(')[1] ?? ''
    // No bare `currentTurn` value reads survive outside comments; the live-read
    // contract routes through the injected accessor.
    const codeOnly = fnBody
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(codeOnly).not.toMatch(/[^.\w]currentTurn\b(?!\s*[:,)])/)
    expect(codeOnly).toMatch(/getCurrentTurn\(\)/)
  })
})

// ── #3544: every minted turn is lit, not just an ADOPTING handback turn ─────
// The defect: the turn-long `typing…` loop was armed only inside
// `if (handbackAdoption != null)`. A handback whose pre-turn entry was deduped
// (parallel workers on one topic), had no derivable turn id, or was already
// reaped adopts NOTHING — and, being a synthetic turn, never went through the
// real-inbound arm in turn-start-surfaces either. Result: zero typing for the
// whole compose window. These drive the REAL `handleSessionEvent` enqueue seam
// against a REAL `createTurnTypingLoop` over the REAL `createTypingEmitter`, so
// the assertion is the OUTCOME the user sees — chat actions on the wire — not
// the call.
describe('#3544 — turn-start typing is unconditional at the enqueue seam', () => {
  // #3927's parked turn-start store is module-scope (one CLI session, one
  // queue), so reset it between cases for determinism.
  beforeEach(() => { __resetParkedTurnStartsForTest() })
  interface TypingRig {
    h: StreamHarness
    sent: Array<{ chatId: string; threadId: number | null }>
    emitter: ReturnType<typeof createTypingEmitter>
    loop: ReturnType<typeof createTurnTypingLoop>
    clock: { t: number }
  }
  function makeTypingRig(opts?: { adopts?: boolean }): TypingRig {
    const h = makeStreamDeps({ turn: null })
    const sent: Array<{ chatId: string; threadId: number | null }> = []
    const clock = { t: 1_000_000 }
    const tKey = (c: string, t: number | null) => `${c}:${t ?? '_'}`
    // The REAL shared floor — the 2026-07-11 flood-ban guard.
    const emitter = createTypingEmitter({
      chatKey: tKey,
      now: () => clock.t,
      send: (chatId, threadId) => { sent.push({ chatId, threadId }) },
    })
    const loop = createTurnTypingLoop({
      sendChatAction: (c, t) => { emitter.emit(c, t, 'typing') },
      chatKey: tKey,
      refreshMs: TYPING_REFRESH_MS,
    })
    const d = h.deps as unknown as Record<string, unknown>
    d.HANDBACK_PRETURN_ENABLED = true
    // Adoption MISSES — the deduped-parallel-worker case from #3544.
    d.handbackPreturnSignal = { tryAdopt: () => (opts?.adopts === true ? { statusKey: `${CHAT}:main`, chatId: CHAT, threadId: null, activityMessageId: null, startedAt: clock.t, pinned: false } : null) }
    d.startTurnTypingLoop = (c: string, t: number | null) => loop.start(c, t)
    return { h, sent, emitter, loop, clock }
  }
  const enqueue = (chatId = CHAT) => ({
    kind: 'enqueue' as const,
    chatId,
    messageId: null,
    threadId: null,
    rawContent: '🤝 A background worker you dispatched has finished.',
  })

  it('a handback turn whose pre-turn entry was DEDUPED (adoption misses) still emits typing', () => {
    const rig = makeTypingRig({ adopts: false })
    handleSessionEvent(rig.h.deps, enqueue())
    // Pre-fix this was []: no adoption ⇒ no loop ⇒ a dark compose window.
    expect(rig.sent).toEqual([{ chatId: CHAT, threadId: null }])
    expect(rig.loop.activeCount()).toBe(1)
    rig.loop.stopAll()
  })

  it('an ADOPTING handback turn is unchanged — still exactly one arm, one action', () => {
    const rig = makeTypingRig({ adopts: true })
    handleSessionEvent(rig.h.deps, enqueue())
    expect(rig.sent).toHaveLength(1)
    expect(rig.loop.activeCount()).toBe(1)
    rig.loop.stopAll()
  })

  it('FLOOD GUARD: N turns arming on ONE chat inside the floor cost at most ONE chat action', () => {
    const rig = makeTypingRig({ adopts: false })
    // #3927: a repeated bare `enqueue` no longer mints a turn — while one is
    // live it PARKS, and the CLI's `dequeue` is what starts the next turn. This
    // guard is about N turn STARTS coalescing, so drive real starts: the first
    // enqueue mints (idle) and each later enqueue+dequeue pair mints one more.
    const startTurn = () => {
      handleSessionEvent(rig.h.deps, enqueue())
      handleSessionEvent(rig.h.deps, { kind: 'dequeue' })
    }
    // 12 arms on one chat inside a single floor window: a real-inbound arm
    // (turn-start-surfaces) plus repeated turn-start seams / restarts.
    rig.loop.start(CHAT, null) // stand-in for the real-inbound path's arm
    for (let i = 0; i < 11; i++) startTurn()
    expect(rig.sent).toHaveLength(1) // the floor coalesced all 12
    expect(rig.loop.activeCount()).toBe(1) // restart-safe: no interval pile-up
    // Crossing the floor lets exactly one more through, then the floor holds again.
    rig.clock.t += TYPING_FLOOR_MS
    for (let i = 0; i < 5; i++) startTurn()
    expect(rig.sent).toHaveLength(2)
    rig.loop.stopAll()
    rig.emitter.reset()
  })
})


// ── #4173 — the turn-completion window wiring, driven through the REAL paths ──
//
// The pure three-phase rule is pinned in flushed-turn-supersede.test.ts /
// reply-owner-resolve.test.ts; THESE tests pin the stream-render WIRING — the
// quiescence flush OPENING the window and the real turn_end CLOSING it — which
// nothing else covers (deleting either hook leaves every pure test green).
describe('#4173 — quiescence flush opens the completion window; the real turn_end closes it', () => {
  const settleFlush = () => new Promise((r) => setTimeout(r, 650))
  const ANSWER =
    'The composed terminal answer that the model never sent via reply, long enough to be a ' +
    'genuine substantive flush delivery for the completion-window wiring tests.'

  beforeEach(() => {
    // drain module-scope tracker state left by other suites
    flushCompletionTracker.closeAll(Date.now())
  })

  it('END-TO-END: the synthetic quiescence turn_end OPENS the window (atom + record ' +
    'claimable far past any fixed TTL); the REAL turn_end then CLOSES both to the ' +
    'replay grace', async () => {
    const supersede = new FlushedTurnSupersedeRegistry()
    // Pre-stamp a bogus value so the OPEN assertion proves the flush branch
    // actively nulled it (not that it was merely never written).
    const turn = makeTurn({ capturedText: [ANSWER], realEndObservedAt: 111 } as Partial<CurrentTurn>)
    const sh = makeStreamDeps({ turn, flushedTurnSupersede: supersede })

    // The answer-ready quiescence flush: a SYNTHETIC turn_end.
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: -1, reason: 'answer-ready-quiescence' })
    await settleFlush()
    expect(sh.delivered).toContain(ANSWER)

    // OPEN: the atom's window was re-opened at fire time…
    expect((turn as unknown as { realEndObservedAt: number | null }).realEndObservedAt).toBeNull()
    // …and the record is claimable 20 minutes out (a /compact longer than any
    // tuned TTL still collapses to one bubble — the #4166 unbounded case).
    // Removing the flush branch's `flushCompletionTracker.open(turn)` leaves
    // the record born-completed via turn-end stamping in prod; in this harness
    // the observable red is the atom assertion above.
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + 20 * 60_000 }).reason,
    ).toBe('supersede')

    // The session's REAL turn_end lands later — the completion signal.
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: 1200 })
    await settleFlush()

    // CLOSED: the atom is stamped…
    const stamped = (turn as unknown as { realEndObservedAt: number | null }).realEndObservedAt
    expect(stamped).not.toBeNull()
    // …the record still honours the bounded tool-call-replay grace…
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + 1_000 }).reason,
    ).toBe('supersede')
    // …and EXPIRES past it: a decoupled same-bridge reply (the Task-sub-agent-
    // after-parent-turn-end shape) can no longer edit over the flushed answer.
    // Removing the close hook (`closeFlushCompletionWindows` in case 'turn_end')
    // turns THIS red — the record would stay open for 30 minutes.
    expect(
      supersede.peek(CHAT, undefined, {
        liveTurnId: turn.turnId,
        now: Date.now() + SUPERSEDE_COMPLETED_GRACE_MS + 5_000,
      }).reason,
    ).toBe('expired')
  })

  it('the REAL-turn_end backstop variant does NOT re-open the window ' +
    '(the `durationMs === -1` conditional is load-bearing)', async () => {
    const supersede = new FlushedTurnSupersedeRegistry()
    const turn = makeTurn({ capturedText: [ANSWER], realEndObservedAt: 999 } as Partial<CurrentTurn>)
    const sh = makeStreamDeps({ turn, flushedTurnSupersede: supersede })

    // The turn-end BACKSTOP: the flush fires ON a real turn_end. The session
    // already stopped, so the window must stay closed (born completed).
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: 1200 })
    await settleFlush()
    expect(sh.delivered).toContain(ANSWER)

    // Unconditionally opening in the flush branch (dropping the -1 check)
    // nulls this and turns the test red.
    expect((turn as unknown as { realEndObservedAt: number | null }).realEndObservedAt).not.toBeNull()
    // The record was born completed (inherited from the atom), so it expires
    // on the grace, never the 30-minute open cap.
    expect(
      supersede.peek(CHAT, undefined, {
        liveTurnId: turn.turnId,
        now: Date.now() + SUPERSEDE_COMPLETED_GRACE_MS + 5_000,
      }).reason,
    ).toBe('expired')
  })
})

// ── LOW #2 (#4167 review) — the two CLOSE PROXIES, which nothing covered ──────
//
// `closeFlushCompletionWindows` has three call sites: the real turn_end (pinned
// by the #4173 block above) and two PROXIES — a new turn minting on the serial
// session (`case 'enqueue'`), and the main bridge dying (gateway.ts). Both were
// untested: deleting the `beginTurn` call left all 18 stream-render tests green,
// and the bridge-death sweep had no coverage at all. A silently-dropped proxy
// leaves a flushed turn's window OPEN for the full 30-minute crash cap, which is
// exactly the tail that makes an edit-over of a delivered answer possible.
describe('#4173 close proxies — a new turn mint and bridge death both close open windows', () => {
  const settleFlush = () => new Promise((r) => setTimeout(r, 650))
  const ANSWER =
    'The composed terminal answer that the model never sent via reply, long enough to be a ' +
    'genuine substantive flush delivery for the close-proxy wiring tests.'
  const CLOSED_BY_GRACE = SUPERSEDE_COMPLETED_GRACE_MS + 5_000
  // Well inside the 30-minute OPEN cap: if the window did NOT close, the record
  // is still claimable here — which is what makes these assertions bite.
  const STILL_OPEN_AT = 10 * 60_000

  beforeEach(() => {
    __resetParkedTurnStartsForTest()
    flushCompletionTracker.closeAll(Date.now())
  })

  async function flushWithOpenWindow(supersede: FlushedTurnSupersedeRegistry) {
    const turn = makeTurn({ capturedText: [ANSWER], realEndObservedAt: 111 } as Partial<CurrentTurn>)
    const sh = makeStreamDeps({ turn, flushedTurnSupersede: supersede })
    handleSessionEvent(sh.deps, { kind: 'turn_end', durationMs: -1, reason: 'answer-ready-quiescence' })
    await settleFlush()
    expect(sh.delivered).toContain(ANSWER)
    // Precondition: the window is genuinely OPEN (claimable 10 minutes out).
    expect((turn as unknown as { realEndObservedAt: number | null }).realEndObservedAt).toBeNull()
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + STILL_OPEN_AT }).reason,
    ).toBe('supersede')
    return { turn, sh }
  }

  it('PROXY A: a NEW TURN minting (case `enqueue`) closes the prior flush window — ' +
    'the record then expires on the replay grace, not the 30-minute open cap', async () => {
    const supersede = new FlushedTurnSupersedeRegistry()
    const { turn, sh } = await flushWithOpenWindow(supersede)

    // The serial session moved on: the CLI enqueues the next turn. The harness's
    // fake `endCurrentTurnAtomic` does not null the turn, so clear it here — an
    // idle session is what makes `enqueue` MINT rather than park.
    ;(sh.deps as unknown as { setCurrentTurn: (t: CurrentTurn | null) => void }).setCurrentTurn(null)
    handleSessionEvent(sh.deps, {
      kind: 'enqueue',
      chatId: CHAT,
      messageId: null,
      threadId: null,
      rawContent: 'the next user message',
    })

    // The atom is stamped…
    expect((turn as unknown as { realEndObservedAt: number | null }).realEndObservedAt).not.toBeNull()
    // …the bounded replay grace still honours the flushed turn's own late reply…
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + 1_000 }).reason,
    ).toBe('supersede')
    // …and past the grace it is EXPIRED. Deleting `closeFlushCompletionWindows`
    // from `beginTurn` turns BOTH of the assertions below red (the record would
    // still read 'supersede' out to the 30-minute cap).
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + CLOSED_BY_GRACE }).reason,
    ).toBe('expired')
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + STILL_OPEN_AT }).reason,
    ).toBe('expired')
  })

  it('PROXY B: the bridge-death sweep (`closeFlushCompletionWindows`) closes an open ' +
    'window to the grace and reports how many atoms it stamped', async () => {
    const supersede = new FlushedTurnSupersedeRegistry()
    const { turn } = await flushWithOpenWindow(supersede)

    // The main claude bridge disconnected: the exact call gateway.ts makes.
    const closed = closeFlushCompletionWindows(supersede, Date.now())
    expect(closed).toBe(1) // the open atom was stamped, not silently skipped

    expect((turn as unknown as { realEndObservedAt: number | null }).realEndObservedAt).not.toBeNull()
    expect(
      supersede.peek(CHAT, undefined, { liveTurnId: turn.turnId, now: Date.now() + CLOSED_BY_GRACE }).reason,
    ).toBe('expired')
    // Idempotent: a second disconnect sweep stamps nothing further.
    expect(closeFlushCompletionWindows(supersede, Date.now())).toBe(0)
  })

  it('PROXY B wiring: gateway.ts calls the sweep on MAIN-bridge disconnect and the ' +
    '#4176 sub-agent liveness reset alongside it (gateway.ts is not importable)', () => {
    const src = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
    const call = 'const closedWindows = closeFlushCompletionWindows(flushedTurnSupersede, Date.now())'
    expect(src).toContain(call)
    // The sweep must sit under the main-bridge guard: a CRON bridge dying says
    // nothing about the main session's flush windows, so closing there would
    // shorten a live window on an unrelated session.
    const idx = src.indexOf(call)
    expect(idx).toBeGreaterThan(0)
    const before = src.slice(Math.max(0, idx - 1200), idx)
    expect(before).toContain('isCronIdentity')
    // #4176 — the sub-agents die with the session; the reset is co-located.
    expect(before).toContain('subagentReplyAuthority.reset()')
  })
})
