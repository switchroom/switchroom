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
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleSessionEvent, type StreamRenderDeps } from '../gateway/stream-render.js'
import {
  sendReply,
  type SendReplyGatewayDeps,
  type SendReplyRequest,
} from '../gateway/outbound-send-path.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { FlushedTurnSupersedeRegistry } from '../flushed-turn-supersede.js'
import { BackstopDeliveryLedger } from '../gateway/backstop-delivery.js'
import { redact } from '../secret-detect/redact.js'
import type { CurrentTurn } from '../gateway/gateway.js'

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
    makeNarrativeGate: () => ({ show: noop, stage: noop, resolveOnTool: noop, flushAtTurnEnd: noop }),
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
    resolveReplyOwnerTurn: () => ({ turn: null, tier: 'none' as const }),
    getLastSubagentHandbackAt: () => null,
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
    s.deps.resolveReplyOwnerTurn = () => ({ turn, tier: 'latest-ended' as const })
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
    s.deps.resolveReplyOwnerTurn = () => ({ turn, tier: 'latest-ended' as const })
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
