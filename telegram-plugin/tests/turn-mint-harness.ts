/**
 * Shared harness for the #3927 turn-mint tests (FIX A / FIX B). NOT a test file
 * — it drives the REAL `handleSessionEvent` against fake gateway closures, the
 * extracted-module golden-harness oracle used by `stream-render-golden.test.ts`.
 */
import { tmpdir } from 'node:os'
import type { CurrentTurn, StreamRenderDeps } from '../gateway/gateway.js'

export const CHAT = '1001'

/** `<channel …>` envelope shaped like the real inbound wrapper the CLI queues. */
export function inbound(messageId: string, text: string): string {
  return (
    `<channel source="switchroom-telegram" chat_id="${CHAT}" ` +
    `message_id="${messageId}" user="tester">${text}</channel>`
  )
}

export interface Harness {
  deps: StreamRenderDeps
  /** Every card the early-liveness open posted, in order (one per minted turn). */
  cardsOpened: Array<{ turnId: string; sourceMessageId: number | null }>
  /** Turns handed to `clearActivitySummary`, in order (FIX B's observable). */
  finalized: CurrentTurn[]
  /** `drainActivitySummary` calls: which turn's feed was drained, and its text. */
  drains: Array<{ turnId: string; render: string | null }>
  /** Ordered trace of surface effects: `finalize:<turnId>` / `open:<turnId>`. */
  seq: string[]
  current: () => CurrentTurn | null
}

export function makeHarness(): Harness {
  let curTurn: CurrentTurn | null = null
  const cardsOpened: Harness['cardsOpened'] = []
  const finalized: CurrentTurn[] = []
  const drains: Harness['drains'] = []
  const seq: string[] = []
  const noop = () => {}
  const key = (c: string, t?: number | null) => `${c}:${t ?? 'main'}`

  const deps = {
    // config
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
    // state
    activeDraftStreams: new Map(),
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    backstopDeliveryLedger: { has: () => false, record: noop },
    bot: { api: {} },
    deliveryQueue: {},
    flushedTurnSupersede: { record: noop },
    handbackPreturnSignal: { tryAdopt: () => null },
    idleTracker: { noteEvent: noop },
    lastPtyPreviewByChat: new Map(),
    obligationLedger: { close: noop, noteTurnEnded: noop },
    outboundDedup: { check: () => null, record: noop },
    pendingCrossTurnGate: new Map(),
    preambleSuppressor: { dropNow: noop, flushNow: noop, onText: noop, onTool: noop, reset: noop },
    progressDriver: null,
    reactionTransitionCounts: new Map(),
    sessionModelSource: { noteTranscriptModel: noop },
    suppressPtyPreview: new Set(),
    toolFlightTracker: { inFlightCount: () => 0 },
    typingWrapper: { drainAll: noop, onToolResult: noop, onToolUse: noop },
    robustApiCall: (fn: () => Promise<unknown>) => fn(),
    swallowingApiCall: async (fn: () => Promise<unknown>) => { try { return await fn() } catch { return undefined } },
    // accessors
    getCurrentTurn: () => curTurn,
    setCurrentTurn: (t: CurrentTurn) => { curTurn = t },
    getLastContextExhaustionWarningAt: () => 0,
    setLastContextExhaustionWarningAt: noop,
    getPendingPtyPartial: () => null,
    setPendingPtyPartial: noop,
    // closures we observe
    clearActivitySummary: (t: CurrentTurn) => { finalized.push(t); seq.push(`finalize:${t.turnId}`) },
    scheduleEarlyLivenessOpen: (t: CurrentTurn) => {
      // Models the real early-open: ONE card per minted turn. Pre-fix this ran
      // for every enqueue, which is exactly how the duplicate card appeared.
      cardsOpened.push({ turnId: t.turnId, sourceMessageId: t.sourceMessageId })
      seq.push(`open:${t.turnId}`)
    },
    drainActivitySummary: (t: CurrentTurn) => {
      drains.push({ turnId: t.turnId, render: t.activityPendingRender })
      return Promise.resolve()
    },
    // rest of the closure surface
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    clearAnswerReadyFlushTimeout: noop,
    closeActivityLane: noop,
    closeProgressLane: noop,
    completeProgressCardTurn: null,
    composeTurnActivity: () => null,
    confirmMemoryLegibility: noop,
    deliverAnswer: async () => ({ sentIds: [], chunkCount: 0, delivered: false, exhausted: false }),
    deliverCapturedProse: async () => {},
    emissionAuthorityFor: () => ({
      mayDrain: () => true,
      openOrEditCard: (_p: string, run: () => void) => run(),
      claimOrDowngradePing: (_i: unknown, _s: unknown, _a: unknown, disabled: () => void) => disabled(),
      markSubstantiveFinalDelivered: (fn: () => void) => fn(),
      finalizeCard: (fn: () => void) => fn(),
    }),
    emitTurnRecord: noop,
    endCurrentTurnAtomic: () => null,
    extractUserPromptPreview: () => null,
    finalizeStatusReaction: noop,
    flushPendingNarrativeAtTurnEnd: noop,
    getPinnedProgressCardMessageId: null,
    handlePtyPartial: noop,
    isDmChatId: () => true,
    isLegitimatelyWorking: () => false,
    makeNarrativeGate: () => ({ show: noop, stage: noop, resolveOnTool: noop, flushAtTurnEnd: noop, teardown: noop }),
    promoteQueuedStatus: noop,
    purgeReactionTracking: noop,
    redactOutboundText: (t: string) => t,
    rememberRecentTurn: noop,
    resetAnswerReadyFlushTimeout: noop,
    resetOrphanedReplyTimeout: noop,
    resolvePendingNarrativeOnTool: noop,
    stagePendingNarrative: noop,
    startTurnTypingLoop: noop,
    statusKey: key,
    streamKey: key,
    surfaceMemoryLegibility: noop,
    turnLiveForItsTopic: () => true,
    turnsDb: null,
    unpinProgressCardForChat: null,
  } as unknown as StreamRenderDeps

  return { deps, cardsOpened, finalized, drains, seq, current: () => curTurn }
}

export function enqueue(messageId: string | null, text = 'hi', threadId: string | null = null) {
  return {
    kind: 'enqueue' as const,
    chatId: CHAT,
    messageId,
    threadId,
    rawContent: messageId == null ? text : inbound(messageId, text),
  }
}

