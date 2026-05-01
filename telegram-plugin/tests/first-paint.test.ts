/**
 * First-paint seam tests — Phase 2 of #545.
 *
 * Drives `firstPaintTurn` directly with fake bot api, fake progress driver,
 * and a stub `controllerFactory`. Measures wall-clock deltas against the
 * spec-doc deadlines (waiting-ux-spec.md):
 *
 *   F2 ("instant draft / status reaction"):
 *      bot.api.setMessageReaction(... '👀' ...) within 800ms of seam entry.
 *   F3 ("progress card start"):
 *      progressDriver.startTurn within 800ms of seam entry. (The spec only
 *      pins 800ms on the status reaction; we mirror that bound here because
 *      progress-card start is a synchronous side effect of the same seam
 *      and shares the "first visible signal" contract.)
 *
 * The seam is a pure async fn, so 'within Xms' really means 'before any
 * fake-timer advance' — we assert with the wall clock pinned, then verify
 * elapsed-fake-time stays <800ms.
 *
 * RED-or-GREEN: Phase 2 is allowed to surface real seam bugs. Do NOT alter
 * production code to force these green; if a deadline is missed, that's a
 * bug to file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  firstPaintTurn,
  type FirstPaintCtx,
  type FirstPaintDeps,
} from '../first-paint.js'
import type { StatusReactionController } from '../status-reactions.js'
import type { DraftStreamHandle } from '../draft-stream.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100
const STATUS_REACTION_DEADLINE_MS = 800
const PROGRESS_CARD_DEADLINE_MS = 800

type ReactionCall = {
  chatId: string | number
  messageId: number
  emoji: string
  /** Wall-clock at invocation (Date.now under fake timers). */
  ts: number
}

type StartTurnCall = {
  chatId: string
  threadId?: string
  userText: string
  replyToMessageId?: number
  ts: number
}

interface Harness {
  deps: FirstPaintDeps
  ctx: FirstPaintCtx
  reactionCalls: ReactionCall[]
  startTurnCalls: StartTurnCall[]
  controllerCalls: { setQueued: number; cancel: number }
  errors: string[]
}

function makeHarness(overrides: { ctx?: Partial<FirstPaintCtx> } = {}): Harness {
  const reactionCalls: ReactionCall[] = []
  const startTurnCalls: StartTurnCall[] = []
  const controllerCalls = { setQueued: 0, cancel: 0 }
  const errors: string[] = []

  const fakeController = {
    setQueued: () => {
      controllerCalls.setQueued += 1
    },
    cancel: () => {
      controllerCalls.cancel += 1
    },
    // Surface enough of the public API to satisfy callers; unused here.
    setThinking: () => {},
    setTool: () => {},
    setCompacting: () => {},
    setDone: () => {},
    setSilent: () => {},
    setError: () => {},
  } as unknown as StatusReactionController

  const deps: FirstPaintDeps = {
    bot: {
      api: {
        setMessageReaction: async (chatId, messageId, reactions) => {
          for (const r of reactions) {
            reactionCalls.push({
              chatId,
              messageId,
              emoji: r.emoji as string,
              ts: Date.now(),
            })
          }
        },
      },
    },
    progressDriver: {
      startTurn: (args) => {
        startTurnCalls.push({ ...args, ts: Date.now() })
      },
    },
    activeStatusReactions: new Map(),
    activeReactionMsgIds: new Map(),
    activeTurnStartedAt: new Map(),
    progressUpdateTurnCount: new Map(),
    activeDraftStreams: new Map<string, DraftStreamHandle>(),
    activeDraftParseModes: new Map(),
    suppressPtyPreview: new Set(),
    statusKey: (chatId, threadId) => `${chatId}:${threadId ?? '_'}`,
    streamKey: (chatId, threadId) => `${chatId}:${threadId ?? '_'}`,
    purgeReactionTracking: () => {},
    signalTracker: {
      noteSignal: () => {},
      reset: () => {},
    },
    resolveAgentDirFromEnv: () => null,
    addActiveReaction: () => {},
    logStreamingEvent: () => {},
    controllerFactory: () => fakeController,
    logError: (m) => {
      errors.push(m)
    },
  }

  const ctx: FirstPaintCtx = {
    chatId: CHAT,
    messageId: INBOUND_MSG,
    messageThreadId: undefined,
    isSteerPrefix: false,
    effectiveText: 'hi',
    inboundReceivedAt: Date.now(),
    access: { statusReactions: true },
    ...overrides.ctx,
  }

  return { deps, ctx, reactionCalls, startTurnCalls, controllerCalls, errors }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('firstPaintTurn — first-paint seam', () => {
  it('happy path: fresh turn fires status reaction (👀 via setQueued path) and startTurn in order', async () => {
    const h = makeHarness()
    const t0 = Date.now()

    await firstPaintTurn(h.deps, h.ctx)

    // Fresh turn: controllerFactory was used, setQueued called once.
    expect(h.controllerCalls.setQueued).toBe(1)
    expect(h.controllerCalls.cancel).toBe(0)

    // The fake controller is a stub, so the bot.api.setMessageReaction
    // path here is exercised only via the steer/queued branches — for a
    // fresh turn the seam delegates the actual emoji emission to the
    // controller (which our stub records as `setQueued`). Either way the
    // FIRST visible signal happens within the seam call. Assert startTurn
    // fired and the controller was queued before any timer advance.
    expect(h.startTurnCalls).toHaveLength(1)
    expect(h.startTurnCalls[0].chatId).toBe(CHAT)
    expect(h.startTurnCalls[0].userText).toBe('hi')
    expect(h.startTurnCalls[0].replyToMessageId).toBe(INBOUND_MSG)

    // No fake-time advance happened; both side effects fired synchronously.
    expect(Date.now() - t0).toBe(0)
    expect(h.errors).toHaveLength(0)
  })

  it('F2 — instant draft: status reaction fires within 800ms of seam entry (fresh turn)', async () => {
    const h = makeHarness()
    const t0 = Date.now()

    await firstPaintTurn(h.deps, h.ctx)

    // The "first visible signal" for a fresh turn is the controller's
    // queued state. Production wires this through the controller's emit
    // callback (which calls bot.api.setMessageReaction with 👀). Our
    // controllerFactory stub records `setQueued` instead — so we assert
    // setQueued landed within the deadline.
    expect(h.controllerCalls.setQueued).toBe(1)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(STATUS_REACTION_DEADLINE_MS)
  })

  it('F2 — instant draft (queued mid-turn branch): 👀 reaction fires synchronously within 800ms', async () => {
    const h = makeHarness()
    // Simulate prior turn in flight by seeding activeStatusReactions.
    const key = `${CHAT}:_`
    const placeholderCtrl = {
      cancel: () => {},
      setQueued: () => {},
    } as unknown as StatusReactionController
    h.deps.activeStatusReactions.set(key, placeholderCtrl)
    h.deps.activeTurnStartedAt.set(key, Date.now() - 5_000)

    const t0 = Date.now()
    await firstPaintTurn(h.deps, h.ctx)

    // Mid-turn queued branch posts 👀 directly via bot.api.
    const eyes = h.reactionCalls.find((c) => c.emoji === '👀')
    expect(eyes, 'expected a 👀 reaction call in mid-turn queued branch').toBeDefined()
    expect((eyes!.ts) - t0).toBeLessThan(STATUS_REACTION_DEADLINE_MS)
  })

  it('F3 — progress card: startTurn fires within 800ms of seam entry on a fresh turn', async () => {
    const h = makeHarness()
    const t0 = Date.now()

    await firstPaintTurn(h.deps, h.ctx)

    expect(h.startTurnCalls).toHaveLength(1)
    const elapsed = h.startTurnCalls[0].ts - t0
    expect(elapsed).toBeLessThan(PROGRESS_CARD_DEADLINE_MS)
  })

  it('F3 — does NOT fire startTurn when a prior turn is in flight (steer branch)', async () => {
    const h = makeHarness({ ctx: { isSteerPrefix: true } })
    const key = `${CHAT}:_`
    const placeholderCtrl = {
      cancel: () => {},
      setQueued: () => {},
    } as unknown as StatusReactionController
    h.deps.activeStatusReactions.set(key, placeholderCtrl)
    h.deps.activeTurnStartedAt.set(key, Date.now() - 5_000)

    const result = await firstPaintTurn(h.deps, h.ctx)

    expect(result.isSteering).toBe(true)
    expect(h.startTurnCalls).toHaveLength(0)
    // Steer branch posts 🤝, not a new card.
    expect(h.reactionCalls.find((c) => c.emoji === '🤝')).toBeDefined()
  })

  it('logError dep captures progress-card startTurn failures (does not write to stderr)', async () => {
    const h = makeHarness()
    h.deps.progressDriver = {
      startTurn: () => {
        throw new Error('boom')
      },
    }

    await firstPaintTurn(h.deps, h.ctx)

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toContain('progress-card startTurn failed')
    expect(h.errors[0]).toContain('boom')
  })
})
