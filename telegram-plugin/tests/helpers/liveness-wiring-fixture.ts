/**
 * Test fixture for the REAL `buildSilencePokeOptions` wiring (#3575 review B3).
 *
 * The two highest-blast-radius pieces of `liveness-wiring.ts` — the `isTurnLive`
 * reaper predicate and the `onFrameworkFallback` teardown + notice — had NO
 * executing coverage: `buildSilencePokeOptions` has exactly one caller (the
 * gateway's module-load `startTimer`) and no test imported it, so the suite
 * either stubbed the predicate or asserted regexes against the function's own
 * SOURCE TEXT. A hand-retyped copy of a predicate cannot detect divergence, and
 * a source regex passes even if the handler is never invoked.
 *
 * `buildSilencePokeOptions` is a pure function of its deps object (its only
 * gateway import is `import type`), so the whole options object CAN be built in
 * a unit test. This fixture supplies the collaborators the fallback actually
 * touches, with spies on the two observable effects (`sendSilenceText`,
 * `endCurrentTurnForKey`).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { buildSilencePokeOptions } from '../../gateway/liveness-wiring.js'

type Deps = Parameters<typeof buildSilencePokeOptions>[0]

export interface SentText {
  chatId: string
  threadId: number | null
  text: string
  silent: boolean
}

export interface LivenessFixture {
  deps: Deps
  sent: SentText[]
  endedKeys: string[]
  /** The gateway's `activeTurnStartedAt` map, writable by the test. */
  activeTurnStartedAt: Map<string, number>
  /** Swap the "current turn" the wiring reads. */
  setCurrentTurn: (t: unknown) => void
  /**
   * Start a turn FOR A TOPIC KEY. With a `turnMap` supplied (the flag-ON
   * `CurrentTurnMap`), this is the gateway's `setCurrentTurn(turn, key)`: it
   * writes the per-topic entry AND flips the most-recent-set mirror. Without
   * one, it degrades to the flag-OFF singleton assignment.
   */
  setCurrentTurnForKey: (key: string, t: unknown) => void
  /** Open obligation ids the per-turn `representWillFollow` lookup consults. */
  openObligations: Set<string>
}

/**
 * The subset of the REAL `CurrentTurnMap` (gateway/current-turn-map.ts) the
 * liveness wiring touches. #3580 tests pass a genuine instance, re-imported
 * under `SWITCHROOM_EMISSION_AUTHORITY=1` via the module's read-once seam, so
 * the flag-ON mirror-vs-keyed semantics under test are the production ones and
 * not a hand-retyped model of them.
 */
export interface TurnMapLike {
  get(key?: string): unknown
  set(turn: never, key: string): void
  isLiveForKey(turn: never, key: string): boolean
  endTurnForKey(turn: never, key: string): boolean
  purgeChatStale(chatId: string, isStale?: (key: string) => boolean): string[]
}

export function statusKeyForTests(chatId: string, threadId: number | null | undefined): string {
  return `${chatId}:${threadId ?? '_'}`
}

/** Minimal but REAL-shaped CurrentTurn for the fields the fallback reads. */
export function makeTurn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionChatId: '-100999',
    sessionThreadId: undefined,
    turnId: '-100999#42',
    registryKey: null,
    role: 'user',
    finalAnswerDelivered: false,
    capturedText: [],
    lastAssistantMsgId: null,
    lastAssistantDone: false,
    toolCallCount: 0,
    ...over,
  }
}

export function makeLivenessFixture(
  over: Partial<Record<string, unknown>> = {},
  turnMap?: TurnMapLike,
): LivenessFixture {
  const sent: SentText[] = []
  const endedKeys: string[] = []
  const activeTurnStartedAt = new Map<string, number>()
  const openObligations = new Set<string>()
  let currentTurn: unknown = null

  // Mirrors gateway.ts's `gatewayLivenessWiringDeps()` exactly. Without a
  // `turnMap` the fixture models the flag-OFF gateway, where `currentTurnMap`
  // holds only the singleton and the keyed read `currentTurnMap.get(key)`
  // returns it — hence `getCurrentTurnForKey` ignoring the key here is the
  // production flag-OFF behaviour, not a shortcut. With a `turnMap` it is the
  // real keyed store and every accessor delegates to it.
  const turnMapDeps = turnMap == null
    ? {
        getCurrentTurn: () => currentTurn,
        getCurrentTurnForKey: (_key: string) => currentTurn,
        currentTurnMap: { purgeChatStale: () => {} },
        turnLiveForItsTopic: () => true,
        endCurrentTurnForKey: (_turn: unknown, key: string) => {
          endedKeys.push(key)
          currentTurn = null
          return true
        },
      }
    : {
        getCurrentTurn: () => turnMap.get() ?? null,
        getCurrentTurnForKey: (key: string) => turnMap.get(key) ?? null,
        currentTurnMap: turnMap,
        turnLiveForItsTopic: (turn: { sessionChatId: string; sessionThreadId?: number | null }) =>
          turnMap.isLiveForKey(
            turn as never,
            statusKeyForTests(turn.sessionChatId, turn.sessionThreadId),
          ),
        endCurrentTurnForKey: (turn: unknown, key: string) => {
          endedKeys.push(key)
          return turnMap.endTurnForKey(turn as never, key)
        },
      }

  const deps = {
    SILENCE_FALLBACK_MS: 300_000,
    SILENCE_FALLBACK_HARD_MS: 900_000,
    SILENCE_FLOOR_MS: 90_000,
    SILENCE_DEFER_INFLIGHT_TOOLS: false,
    isObligationOpenForTurn: (originTurnId: string | null): boolean =>
      originTurnId != null && openObligations.has(originTurnId),
    TURN_PREVIEW_MAX: 200,
    STATE_DIR: mkdtempSync(join(tmpdir(), 'liveness-wiring-')),
    isLegitimatelyWorking: () => false,
    ...turnMapDeps,
    getInFlightUpdate: () => null,
    getTurnsDb: () => null,
    getInboundSpool: () => undefined,
    sendToAgent: () => true,
    sendSilenceText: async (chatId: string, threadId: number | null, text: string, silent: boolean) => {
      sent.push({ chatId, threadId, text, silent })
    },
    getMyAgentName: () => 'test-agent',
    statusKey: statusKeyForTests,
    activeTurnStartedAt,
    activeStatusReactions: new Map(),
    lastPtyPreviewByChat: new Map(),
    preambleSuppressor: { dropNow: () => {} },
    purgeReactionTracking: () => {},
    getPendingInboundBuffer: () => ({ drain: () => [] }),
    trackRedeliveredInbound: () => {},
    closeActivityLane: () => {},
    closeProgressLane: () => {},
    hangRestart: null,
    ...over,
  } as unknown as Deps

  return {
    deps,
    sent,
    endedKeys,
    activeTurnStartedAt,
    setCurrentTurn: (t: unknown) => {
      if (turnMap != null) throw new Error('use setCurrentTurnForKey with a keyed turnMap')
      currentTurn = t
    },
    setCurrentTurnForKey: (key: string, t: unknown) => {
      if (turnMap == null) { currentTurn = t; return }
      turnMap.set(t as never, key)
    },
    openObligations,
  }
}
