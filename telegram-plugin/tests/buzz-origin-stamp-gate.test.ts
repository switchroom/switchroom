import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import {
  handleSessionEvent,
  type StreamRenderDeps,
} from '../gateway/stream-render.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { FlushedTurnSupersedeRegistry } from '../flushed-turn-supersede.js'
import { BackstopDeliveryLedger } from '../gateway/backstop-delivery.js'
import { redact } from '../secret-detect/redact.js'
import type { CurrentTurn } from '../gateway/gateway.js'

/**
 * Buzz co-channel — Phase 2a MINOR-1 gate guard (behavioural, non-mocked).
 *
 * `stream-render.ts` computes `BUZZ_ORIGIN_STAMP_ACTIVE` at import time from
 * `BUZZ_ENABLED` + the routing kill switch; when it is false the turn ctor
 * stamps a plain Telegram origin WITHOUT calling `parseChannelOrigin`, so the
 * Telegram-only hot path is byte-identical.
 *
 * This runs with `BUZZ_ENABLED` UNSET (the default for every Telegram-only
 * agent), i.e. the gate is OFF. The OUTCOME it pins: a turn whose rawContent
 * carries a REAL buzz `<channel source="buzz" …>` envelope is STILL stamped
 * `telegram` with no coords — proving the parser was not consulted. If someone
 * deleted the gate, the parser would run on this same input and stamp
 * `originChannel: 'buzz'` with coords, and this test would fail. That makes it a
 * true regression guard for the flag-off invariant, not a code-path assertion.
 */

// A real captured buzz double-wrap envelope (same fixture as channel-route T-1c).
const CHAN = '6d18fdfe-601b-4e6c-82b5-aed8ac002dd4'
const EVT = '5e472ba250c45ea6f609f71d05e979a6992670ab12fd07781096bdcee6458c6b'
const PUB = 'fc97c126b783147458e8ea640cd714af5f2a2dd1dc39b27afc3b013df24faf1b'
const BUZZ_RAW =
  `<channel source="switchroom-telegram" source="buzz" buzz_channel_id="${CHAN}" ` +
  `buzz_event_id="${EVT}" buzz_pubkey="${PUB}" buzz_thread_root="${EVT}" user="buzz:fc97…af1b">\n` +
  `<channel source="buzz" buzz_channel_id="${CHAN}" buzz_event_id="${EVT}" buzz_pubkey="${PUB}" ` +
  `buzz_thread_root="${EVT}" user="buzz:fc97…af1b">[canary] inbound-path test</channel>\n</channel>`

const CHAT = '1001'

function makeStreamDeps(): { deps: StreamRenderDeps; getTurn: () => CurrentTurn | null } {
  let curTurn: CurrentTurn | null = null
  const key = (c: string, t?: number | null) => `${c}:${t ?? 'main'}`
  const noop = () => {}
  const fakeEA = {
    claimOrDowngradePing: (_i: unknown, _s: unknown, _a: unknown, disabled: () => void) => disabled(),
    markSubstantiveFinalDelivered: (fn: () => void) => fn(),
    finalizeCard: (fn: () => void) => fn(),
  }
  const deps = {
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
    activeDraftStreams: new Map(),
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    backstopDeliveryLedger: new BackstopDeliveryLedger(),
    bot: { api: {} },
    flushedTurnSupersede: new FlushedTurnSupersedeRegistry(),
    idleTracker: { noteEvent: noop },
    lastPtyPreviewByChat: new Map(),
    obligationLedger: { close: noop, noteTurnEnded: noop },
    outboundDedup: new OutboundDedupCache(),
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
    getCurrentTurn: () => curTurn,
    getLastContextExhaustionWarningAt: () => 0,
    setLastContextExhaustionWarningAt: noop,
    getPendingPtyPartial: () => null,
    setPendingPtyPartial: noop,
    setCurrentTurn: (t: CurrentTurn) => { curTurn = t },
    cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
    clearActivitySummary: noop,
    clearAnswerReadyFlushTimeout: noop,
    closeActivityLane: noop,
    closeProgressLane: noop,
    completeProgressCardTurn: null,
    composeTurnActivity: () => null,
    confirmMemoryLegibility: noop,
    deliverAnswer: async () => ({ sentIds: [4242], chunkCount: 1, delivered: true, exhausted: false }),
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
  return { deps, getTurn: () => curTurn }
}

describe('MINOR-1 — origin stamp gate OFF (default): parser is not consulted', () => {
  it('stamps a buzz-enveloped turn as TELEGRAM when BUZZ_ENABLED is unset', () => {
    // Guard: the process must actually be on the flag-off path for this to mean
    // what it claims. (Every Telegram-only agent runs exactly here.)
    expect(process.env.BUZZ_ENABLED === '1' || process.env.BUZZ_ENABLED === 'true').toBe(false)

    const { deps, getTurn } = makeStreamDeps()
    handleSessionEvent(deps, {
      kind: 'enqueue',
      chatId: CHAT,
      messageId: null,
      threadId: null,
      rawContent: BUZZ_RAW,
    } as unknown as Parameters<typeof handleSessionEvent>[1])

    const turn = getTurn()
    expect(turn).not.toBeNull()
    // The OUTCOME: despite a real buzz envelope, the gate-off ctor defaulted to
    // telegram WITHOUT calling parseChannelOrigin. Removing the gate would make
    // this 'buzz' with coords — the regression this test exists to catch.
    expect(turn!.originChannel).toBe('telegram')
    expect(turn!.buzzCoords).toBeUndefined()
  })
})
