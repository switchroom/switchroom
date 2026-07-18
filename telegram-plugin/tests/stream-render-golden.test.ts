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
    editMessageText: async (c: string, m: number, b: unknown, o: Record<string, unknown> = {}) => { rec('editMessageText', c, typeof b === 'string' ? b : (b as { markdown: string }).markdown, o); return {} },
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
    resolveReplyOwnerTurn: () => null,
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
