/**
 * Race-condition / interleaving tests for Phase 1 integration.
 *
 * Exercises the ordering invariants the steering/queue + streaming
 * observability changes depend on. Uses the same plugin-state harness
 * as e2e.test.ts — see that file's preamble for why we don't import
 * server.ts directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseQueuePrefix,
  parseSteerPrefix,
  formatPriorAssistantPreview,
  buildChannelMetaAttributes,
} from '../steering.js'
import {
  consumeHandoffTopic,
  formatHandoffLine,
  HANDOFF_TOPIC_FILENAME,
} from '../handoff-continuity.js'

// ---- harness (copy of e2e.test.ts's — intentional; tests stay isolated) ----

function statusKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}
function streamKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? 'default'}`
}

interface PluginState {
  activeStatusReactions: Map<string, { chatId: string; threadId?: number }>
  activeTurnStartedAt: Map<string, number>
  suppressPtyPreview: Set<string>
  currentSessionChatId: string | null
  currentTurnStartedAt: number
}

function freshState(): PluginState {
  return {
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    suppressPtyPreview: new Set(),
    currentSessionChatId: null,
    currentTurnStartedAt: 0,
  }
}

function simulateInbound(
  state: PluginState,
  opts: {
    chatId: string
    threadId?: number
    rawBody: string
    priorAssistantText?: string
    now: number
  },
): {
  body: string
  metaAttrs: string
  notifiedAsSteering: boolean
  notifiedAsQueued: boolean
  secondsSinceTurnStart: number | undefined
} {
  const { chatId, threadId, rawBody, now } = opts
  const key = statusKey(chatId, threadId)

  const { queued: isQueuedPrefix, body } = parseQueuePrefix(rawBody)
  const priorStartedAt = state.activeTurnStartedAt.get(key)
  const priorTurnInProgress = state.activeStatusReactions.has(key)
  const isSteering = priorTurnInProgress && !isQueuedPrefix

  const preview = priorTurnInProgress && opts.priorAssistantText
    ? formatPriorAssistantPreview(opts.priorAssistantText)
    : ''

  const secondsSince =
    priorStartedAt != null && priorStartedAt > 0
      ? (now - priorStartedAt) / 1000
      : undefined

  const metaAttrs = buildChannelMetaAttributes({
    queued: isQueuedPrefix,
    steering: isSteering,
    priorTurnInProgress,
    secondsSinceTurnStart: secondsSince,
    priorAssistantPreview: preview || undefined,
  })

  if (!priorTurnInProgress) {
    state.activeStatusReactions.set(key, { chatId, threadId })
    state.activeTurnStartedAt.set(key, now)
  }

  return {
    body,
    metaAttrs,
    notifiedAsSteering: isSteering,
    notifiedAsQueued: isQueuedPrefix,
    secondsSinceTurnStart: secondsSince,
  }
}

function simulateTurnEnd(s: PluginState, chatId: string, threadId?: number): void {
  const k = statusKey(chatId, threadId)
  s.activeStatusReactions.delete(k)
  s.activeTurnStartedAt.delete(k)
  s.suppressPtyPreview.delete(streamKey(chatId, threadId))
  s.currentSessionChatId = null
  s.currentTurnStartedAt = 0
}
function simulateControllerError(s: PluginState, c: string, t?: number): void {
  const k = statusKey(c, t)
  s.activeStatusReactions.delete(k)
  s.activeTurnStartedAt.delete(k)
}
function simulateBackstopSuccess(s: PluginState, c: string, t?: number): void {
  // same shape as turn_end — backstop terminates the controller, then the
  // finally block in server.ts deletes the maps.
  simulateTurnEnd(s, c, t)
}
function simulateBackstopError(s: PluginState, c: string, t?: number): void {
  // same shape as controller error — finally block deletes both maps.
  simulateControllerError(s, c, t)
}
function simulateCancelOnNewInbound(s: PluginState, c: string, t?: number): void {
  // Server.ts cancels an existing controller when a fresh non-steering
  // inbound arrives in pathological cases; both maps cleared.
  simulateControllerError(s, c, t)
}
function simulateContextExhaustion(s: PluginState, c: string, t?: number): void {
  const k = statusKey(c, t)
  s.activeStatusReactions.delete(k)
  s.activeTurnStartedAt.delete(k)
  s.currentSessionChatId = null
  s.currentTurnStartedAt = 0
}

// ---------------------------------------------------------------------------
// Interleaving tests
// ---------------------------------------------------------------------------

describe('Race: inbound A mid-turn, then turn_end, then inbound B', () => {
  it('A gets steering="true"; B (after turn_end) does NOT', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'start', now: 0 })
    const a = simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'correction A',
      priorAssistantText: 'thinking',
      now: 2000,
    })
    expect(a.notifiedAsSteering).toBe(true)
    simulateTurnEnd(s, 'c1')
    const b = simulateInbound(s, { chatId: 'c1', rawBody: 'fresh B', now: 10_000 })
    expect(b.notifiedAsSteering).toBe(false)
    expect(b.metaAttrs).toBe('')
  })
})

describe('Race: two inbounds mid-turn against same controller', () => {
  it('B is steering against the SAME controller A created; seconds from A arrival', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'start', now: 1_000_000 })
    const startedAt = s.activeTurnStartedAt.get(statusKey('c1'))
    expect(startedAt).toBe(1_000_000)

    simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'mid A',
      priorAssistantText: 'x',
      now: 1_000_000 + 3000,
    })
    // still the same controller, still the same start time
    expect(s.activeTurnStartedAt.get(statusKey('c1'))).toBe(1_000_000)

    const b = simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'mid B',
      priorAssistantText: 'x',
      now: 1_000_000 + 7000,
    })
    expect(b.notifiedAsSteering).toBe(true)
    // Seconds since A's arrival (start of the turn), not since the prior inbound.
    expect(b.secondsSinceTurnStart).toBe(7)
    expect(b.metaAttrs).toContain('seconds_since_turn_start="7"')
  })
})

describe('Race: reply tool claims PTY preview suppression gate', () => {
  it('suppressPtyPreview blocks a subsequent PTY partial for the same chat+thread', () => {
    const s = freshState()
    const k = streamKey('c1', 42)
    s.suppressPtyPreview.add(k)

    // Unit-level gate check: the PTY partial handler in server.ts checks
    // `if (suppressPtyPreview.has(streamKey(chatId, threadId))) return;`
    // before emitting. Model that here.
    function ptyPartialEmit(chatId: string, threadId?: number): boolean {
      if (s.suppressPtyPreview.has(streamKey(chatId, threadId))) return false
      return true
    }
    expect(ptyPartialEmit('c1', 42)).toBe(false)
    expect(ptyPartialEmit('c1')).toBe(true) // different key (no thread)
  })
})

describe('Race: handoff topic consumed once, second reply no-ops', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'handoff-race-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('topic consumed on first reply; second reply sees null', () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), 'topic\n', 'utf8')
    const first = consumeHandoffTopic(tmp)
    expect(first).toBe('topic')
    const second = consumeHandoffTopic(tmp)
    expect(second).toBeNull()
  })
})

describe('Race: activeTurnStartedAt cleanup on every exit path', () => {
  // Parameterized test — exercises every code path that deletes a
  // status controller in server.ts and asserts the Map is empty after.
  const paths: Array<{ name: string; runExit: (s: PluginState, c: string) => void }> = [
    { name: 'turn_end', runExit: (s, c) => simulateTurnEnd(s, c) },
    { name: 'controller error', runExit: (s, c) => simulateControllerError(s, c) },
    { name: 'backstop success', runExit: (s, c) => simulateBackstopSuccess(s, c) },
    { name: 'backstop error', runExit: (s, c) => simulateBackstopError(s, c) },
    { name: 'cancel on new inbound', runExit: (s, c) => simulateCancelOnNewInbound(s, c) },
    { name: 'context exhaustion', runExit: (s, c) => simulateContextExhaustion(s, c) },
  ]

  for (const p of paths) {
    it(`exit path "${p.name}" clears both activeStatusReactions and activeTurnStartedAt`, () => {
      const s = freshState()
      simulateInbound(s, { chatId: 'c1', rawBody: 'x', now: 1 })
      expect(s.activeStatusReactions.size).toBe(1)
      expect(s.activeTurnStartedAt.size).toBe(1)
      p.runExit(s, 'c1')
      expect(s.activeStatusReactions.size).toBe(0)
      expect(s.activeTurnStartedAt.size).toBe(0)
    })
  }
})

describe('Race: /queue prefix mid-turn preserves prior preview', () => {
  it('queued="true" is set, steering is NOT, but prior_assistant_preview still included', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })
    const r = simulateInbound(s, {
      chatId: 'c1',
      rawBody: '/queue new task',
      priorAssistantText: 'currently working on first',
      now: 5000,
    })
    expect(r.notifiedAsQueued).toBe(true)
    expect(r.notifiedAsSteering).toBe(false)
    expect(r.metaAttrs).toContain('queued="true"')
    expect(r.metaAttrs).not.toContain('steering="true"')
    // Model still sees that something is in flight — crucial so it can decide
    // whether to mention the prior work.
    expect(r.metaAttrs).toContain('prior_turn_in_progress="true"')
    expect(r.metaAttrs).toContain('prior_assistant_preview="currently working on first"')
  })
})

describe('Race: context-exhaustion restart mid-steer', () => {
  it('restart code path clears activeTurnStartedAt for the key', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'big', now: 1 })
    simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'steer',
      priorAssistantText: 'Prompt is too long',
      now: 500,
    })
    expect(s.activeTurnStartedAt.has(statusKey('c1'))).toBe(true)
    simulateContextExhaustion(s, 'c1')
    expect(s.activeTurnStartedAt.has(statusKey('c1'))).toBe(false)
    expect(s.activeStatusReactions.has(statusKey('c1'))).toBe(false)
    expect(s.currentSessionChatId).toBeNull()
  })
})

describe('Race: fake-timer-based timing assertions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // bun's vitest shim doesn't implement setSystemTime. The test only
    // needs Date.now() to move with advanceTimersByTime — useFakeTimers
    // already provides that on both vitest and bun. Guard so the test
    // runs on either runtime without requiring setSystemTime.
    if (typeof (vi as { setSystemTime?: (d: Date) => void }).setSystemTime === 'function') {
      vi.setSystemTime(new Date('2026-04-13T00:00:00Z'))
    }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('seconds_since_turn_start is monotonic across advancing fake time', () => {
    const s = freshState()
    simulateInbound(s, { chatId: 'c1', rawBody: 'a', now: Date.now() })
    vi.advanceTimersByTime(5000)
    const r1 = simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'b',
      priorAssistantText: 'x',
      now: Date.now(),
    })
    expect(r1.secondsSinceTurnStart).toBe(5)
    vi.advanceTimersByTime(10_000)
    const r2 = simulateInbound(s, {
      chatId: 'c1',
      rawBody: 'c',
      priorAssistantText: 'x',
      now: Date.now(),
    })
    expect(r2.secondsSinceTurnStart).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// Queue lifecycle harness (models gateway.ts behavior)
//
// The gateway introduced a new default: mid-turn messages are queued unless
// the user explicitly prefixes with `/steer` or `/s`. This harness tracks
// the full lifecycle: inbound classification → queue notification → enqueue
// cleanup → meta attributes.
// ---------------------------------------------------------------------------

interface QueueNotification {
  chatId: string
  messageId: number
  threadId: number | undefined
  pinned: boolean
  deleted: boolean
}

interface GatewayState {
  activeStatusReactions: Map<string, { chatId: string; threadId?: number }>
  activeTurnStartedAt: Map<string, number>
  pendingQueueNotifications: Map<string, QueueNotification>
  suppressPtyPreview: Set<string>
  currentSessionChatId: string | null
  currentTurnStartedAt: number
  /** Auto-incrementing message id for simulated bot-sent notifications. */
  _nextBotMsgId: number
}

function freshGatewayState(): GatewayState {
  return {
    activeStatusReactions: new Map(),
    activeTurnStartedAt: new Map(),
    pendingQueueNotifications: new Map(),
    suppressPtyPreview: new Set(),
    currentSessionChatId: null,
    currentTurnStartedAt: 0,
    _nextBotMsgId: 9000,
  }
}

/**
 * Models the gateway.ts inbound handling (lines 1638-1808).
 *
 * Key difference from the legacy simulateInbound above: plain mid-turn
 * messages default to queued (not steering). Only `/steer` or `/s` prefix
 * opts into steering. `/queue` and `/q` are legacy aliases for the default
 * queued behavior.
 */
function gatewaySimulateInbound(
  state: GatewayState,
  opts: {
    chatId: string
    threadId?: number
    rawBody: string
    priorAssistantText?: string
    now: number
  },
): {
  body: string
  reaction: '👀' | '🤝' | null
  queueNotificationCreated: boolean
  metaQueued: boolean
  metaSteering: boolean
  metaPriorTurnInProgress: boolean
  secondsSinceTurnStart: number | undefined
} {
  const { chatId, threadId, rawBody, now } = opts
  const key = statusKey(chatId, threadId)

  // Parse prefixes (mirrors gateway.ts lines 1642-1647)
  const parsedSteer = parseSteerPrefix(rawBody)
  const isSteerPrefix = parsedSteer.steering
  const parsedQueue = isSteerPrefix
    ? { queued: false, body: parsedSteer.body }
    : parseQueuePrefix(rawBody)
  const isQueuedPrefix = parsedQueue.queued
  const body = isSteerPrefix
    ? parsedSteer.body
    : isQueuedPrefix
      ? parsedQueue.body
      : rawBody

  // Detect prior turn in flight (gateway.ts lines 1654-1661)
  const priorActive = state.activeStatusReactions.has(key)
  const isSteering = priorActive && isSteerPrefix
  let priorTurnStartedAt: number | undefined
  if (priorActive) {
    priorTurnStartedAt = state.activeTurnStartedAt.get(key)
  }

  // Determine reaction and queue notification (gateway.ts lines 1663-1702)
  let reaction: '👀' | '🤝' | null = null
  let queueNotificationCreated = false

  if (isSteering) {
    // Explicit steer: 🤝 on the inbound message, no queue notification
    reaction = '🤝'
  } else if (priorActive) {
    // Queued mid-turn (default): 👀, plus queue notification
    reaction = '👀'
    const notifMsgId = state._nextBotMsgId++
    state.pendingQueueNotifications.set(key, {
      chatId,
      messageId: notifMsgId,
      threadId,
      pinned: true,
      deleted: false,
    })
    queueNotificationCreated = true
  } else {
    // Fresh turn: start tracking
    state.activeStatusReactions.set(key, { chatId, threadId })
    state.activeTurnStartedAt.set(key, now)
    reaction = '👀'
  }

  // Compute meta attributes (gateway.ts lines 1744-1803)
  const priorTurnInProgress = isSteering || priorTurnStartedAt != null
  const isQueuedMidTurn = priorTurnInProgress && !isSteering
  const secondsSince =
    priorTurnStartedAt != null && priorTurnStartedAt > 0
      ? Math.max(0, Math.floor((now - priorTurnStartedAt) / 1000))
      : undefined

  return {
    body,
    reaction,
    queueNotificationCreated,
    metaQueued: isQueuedMidTurn || isQueuedPrefix,
    metaSteering: isSteering,
    metaPriorTurnInProgress: priorTurnInProgress,
    secondsSinceTurnStart: secondsSince,
  }
}

/**
 * Models the enqueue session event handler (server.ts lines 2332-2367).
 * Cleans up the pending queue notification for this chat.
 */
function gatewaySimulateEnqueue(
  state: GatewayState,
  chatId: string,
  threadId?: number,
): { unpinnedMessageId: number | null; deletedMessageId: number | null } {
  const key = statusKey(chatId, threadId)
  state.currentSessionChatId = chatId
  state.currentTurnStartedAt = Date.now()

  const qn = state.pendingQueueNotifications.get(key)
  if (qn != null) {
    state.pendingQueueNotifications.delete(key)
    qn.pinned = false
    qn.deleted = true
    return { unpinnedMessageId: qn.messageId, deletedMessageId: qn.messageId }
  }
  return { unpinnedMessageId: null, deletedMessageId: null }
}

/**
 * Models turn_end for the gateway state.
 */
function gatewaySimulateTurnEnd(state: GatewayState, chatId: string, threadId?: number): void {
  const k = statusKey(chatId, threadId)
  state.activeStatusReactions.delete(k)
  state.activeTurnStartedAt.delete(k)
  state.suppressPtyPreview.delete(streamKey(chatId, threadId))
  state.currentSessionChatId = null
  state.currentTurnStartedAt = 0
}

// ---------------------------------------------------------------------------
// Queue lifecycle tests
// ---------------------------------------------------------------------------

describe('Queue lifecycle: mid-turn message defaults to queued', () => {
  it('plain mid-turn message gets queued="true", NOT steering="true"', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first task', now: 0 })

    const mid = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'second task while first is running',
      now: 5000,
    })

    expect(mid.metaQueued).toBe(true)
    expect(mid.metaSteering).toBe(false)
    expect(mid.metaPriorTurnInProgress).toBe(true)
    expect(mid.reaction).toBe('👀')
  })

  it('/queue prefix mid-turn also yields queued="true" (legacy alias)', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })

    const mid = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: '/queue do something else',
      now: 3000,
    })

    expect(mid.metaQueued).toBe(true)
    expect(mid.metaSteering).toBe(false)
    expect(mid.body).toBe('do something else')
  })

  it('first inbound (no prior turn) is NOT queued or steering', () => {
    const s = freshGatewayState()
    const first = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'hello',
      now: 0,
    })

    expect(first.metaQueued).toBe(false)
    expect(first.metaSteering).toBe(false)
    expect(first.metaPriorTurnInProgress).toBe(false)
  })
})

describe('Queue lifecycle: queue notification created on mid-turn message', () => {
  it('plain mid-turn message creates a queue notification', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })

    const mid = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'queued message',
      now: 5000,
    })

    expect(mid.queueNotificationCreated).toBe(true)
    const key = statusKey('c1')
    const notif = s.pendingQueueNotifications.get(key)
    expect(notif).toBeDefined()
    expect(notif!.chatId).toBe('c1')
    expect(notif!.pinned).toBe(true)
    expect(notif!.deleted).toBe(false)
  })

  it('/queue prefix mid-turn also creates a queue notification', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })

    const mid = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: '/queue new task',
      now: 3000,
    })

    expect(mid.queueNotificationCreated).toBe(true)
    expect(s.pendingQueueNotifications.size).toBe(1)
  })

  it('first inbound (no prior turn) does NOT create queue notification', () => {
    const s = freshGatewayState()
    const first = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'hello',
      now: 0,
    })

    expect(first.queueNotificationCreated).toBe(false)
    expect(s.pendingQueueNotifications.size).toBe(0)
  })
})

describe('Queue lifecycle: enqueue cleans up queue notification', () => {
  it('enqueue unpins and deletes the pending notification', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'queued', now: 5000 })

    expect(s.pendingQueueNotifications.size).toBe(1)
    const key = statusKey('c1')
    const notifBefore = s.pendingQueueNotifications.get(key)
    const notifMsgId = notifBefore!.messageId

    const result = gatewaySimulateEnqueue(s, 'c1')

    expect(result.unpinnedMessageId).toBe(notifMsgId)
    expect(result.deletedMessageId).toBe(notifMsgId)
    expect(s.pendingQueueNotifications.size).toBe(0)
  })

  it('enqueue with no pending notification is a no-op', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })

    // No mid-turn message, so no queue notification
    const result = gatewaySimulateEnqueue(s, 'c1')

    expect(result.unpinnedMessageId).toBeNull()
    expect(result.deletedMessageId).toBeNull()
  })

  it('enqueue for a different chat does not touch another chat\'s notification', () => {
    const s = freshGatewayState()
    // Chat c1: start a turn, then queue a mid-turn message
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first', now: 0 })
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'mid-turn c1', now: 3000 })

    // Chat c2: start a turn
    gatewaySimulateInbound(s, { chatId: 'c2', rawBody: 'first c2', now: 1000 })

    expect(s.pendingQueueNotifications.size).toBe(1)

    // Enqueue fires for c2 — should NOT clean up c1's notification
    gatewaySimulateEnqueue(s, 'c2')

    expect(s.pendingQueueNotifications.size).toBe(1)
    expect(s.pendingQueueNotifications.has(statusKey('c1'))).toBe(true)
  })
})

describe('Queue lifecycle: full turn_end → enqueue → process cycle', () => {
  it('queued message processes normally after turn_end and enqueue', () => {
    const s = freshGatewayState()

    // Turn 1: first message
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'task A', now: 0 })

    // Mid-turn: queued message arrives
    const mid = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'task B',
      now: 5000,
    })
    expect(mid.metaQueued).toBe(true)
    expect(mid.queueNotificationCreated).toBe(true)

    // Turn 1 ends
    gatewaySimulateTurnEnd(s, 'c1')
    expect(s.activeStatusReactions.size).toBe(0)
    expect(s.activeTurnStartedAt.size).toBe(0)

    // Queue notification is still pending until enqueue fires
    expect(s.pendingQueueNotifications.size).toBe(1)

    // Enqueue fires for the queued message — notification cleaned up
    const enqResult = gatewaySimulateEnqueue(s, 'c1')
    expect(enqResult.unpinnedMessageId).not.toBeNull()
    expect(enqResult.deletedMessageId).not.toBeNull()
    expect(s.pendingQueueNotifications.size).toBe(0)
  })

  it('after turn_end, next fresh inbound is NOT queued or steering', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'task A', now: 0 })
    gatewaySimulateTurnEnd(s, 'c1')

    const fresh = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'task B (fresh)',
      now: 20_000,
    })

    expect(fresh.metaQueued).toBe(false)
    expect(fresh.metaSteering).toBe(false)
    expect(fresh.metaPriorTurnInProgress).toBe(false)
    expect(fresh.queueNotificationCreated).toBe(false)
  })
})

describe('Queue lifecycle: steering messages (/steer prefix) get 🤝, no queue notification', () => {
  it('/steer prefix mid-turn gets steering="true" and 🤝 reaction, NOT queue notification', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'first task', now: 0 })

    const steer = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: '/steer actually do it this way',
      now: 3000,
    })

    expect(steer.metaSteering).toBe(true)
    expect(steer.metaQueued).toBe(false)
    expect(steer.metaPriorTurnInProgress).toBe(true)
    expect(steer.reaction).toBe('🤝')
    expect(steer.queueNotificationCreated).toBe(false)
    expect(steer.body).toBe('actually do it this way')
  })

  it('/s shorthand prefix mid-turn also gets steering + 🤝', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'working on it', now: 0 })

    const steer = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: '/s use TypeScript instead',
      now: 2000,
    })

    expect(steer.metaSteering).toBe(true)
    expect(steer.metaQueued).toBe(false)
    expect(steer.reaction).toBe('🤝')
    expect(steer.queueNotificationCreated).toBe(false)
    expect(steer.body).toBe('use TypeScript instead')
  })

  it('/steer prefix when NO prior turn is just a normal message (not steering)', () => {
    const s = freshGatewayState()

    const first = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: '/steer do something',
      now: 0,
    })

    // No prior turn, so this is treated as a fresh inbound — the /steer prefix
    // is still parsed but isSteering requires priorActive to be true.
    expect(first.metaSteering).toBe(false)
    expect(first.metaQueued).toBe(false)
    expect(first.metaPriorTurnInProgress).toBe(false)
    // Body is still stripped of the prefix
    expect(first.body).toBe('do something')
  })

  it('contrast: plain mid-turn gets 👀 + queue notification, /steer gets 🤝 + no notification', () => {
    // Simulate two chats to compare side by side
    const s = freshGatewayState()

    // Chat c1: start turn, then plain mid-turn
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'start c1', now: 0 })
    const queued = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'mid-turn plain',
      now: 3000,
    })

    // Chat c2: start turn, then /steer mid-turn
    gatewaySimulateInbound(s, { chatId: 'c2', rawBody: 'start c2', now: 0 })
    const steered = gatewaySimulateInbound(s, {
      chatId: 'c2',
      rawBody: '/steer course correction',
      now: 3000,
    })

    // Queued: 👀 + queue notification
    expect(queued.reaction).toBe('👀')
    expect(queued.queueNotificationCreated).toBe(true)
    expect(queued.metaQueued).toBe(true)
    expect(queued.metaSteering).toBe(false)

    // Steered: 🤝 + NO queue notification
    expect(steered.reaction).toBe('🤝')
    expect(steered.queueNotificationCreated).toBe(false)
    expect(steered.metaSteering).toBe(true)
    expect(steered.metaQueued).toBe(false)

    // Only c1 has a pending notification
    expect(s.pendingQueueNotifications.size).toBe(1)
    expect(s.pendingQueueNotifications.has(statusKey('c1'))).toBe(true)
    expect(s.pendingQueueNotifications.has(statusKey('c2'))).toBe(false)
  })
})

describe('Queue lifecycle: seconds_since_turn_start for queued and steered messages', () => {
  it('queued mid-turn message reports correct seconds', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'start', now: 1_000_000 })

    const mid = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'follow up',
      now: 1_000_000 + 7000,
    })

    expect(mid.secondsSinceTurnStart).toBe(7)
    expect(mid.metaPriorTurnInProgress).toBe(true)
  })

  it('/steer mid-turn message reports correct seconds', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'start', now: 1_000_000 })

    const steer = gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: '/steer change direction',
      now: 1_000_000 + 12000,
    })

    expect(steer.secondsSinceTurnStart).toBe(12)
    expect(steer.metaPriorTurnInProgress).toBe(true)
  })
})

describe('Queue lifecycle: multiple queued messages overwrite notification', () => {
  it('second queued mid-turn message overwrites the first notification', () => {
    const s = freshGatewayState()
    gatewaySimulateInbound(s, { chatId: 'c1', rawBody: 'turn 1', now: 0 })

    gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'queued A',
      now: 3000,
    })
    const firstNotif = s.pendingQueueNotifications.get(statusKey('c1'))
    const firstMsgId = firstNotif!.messageId

    gatewaySimulateInbound(s, {
      chatId: 'c1',
      rawBody: 'queued B',
      now: 6000,
    })

    // The map only holds the latest notification per key
    expect(s.pendingQueueNotifications.size).toBe(1)
    const secondNotif = s.pendingQueueNotifications.get(statusKey('c1'))
    expect(secondNotif!.messageId).not.toBe(firstMsgId)
  })
})
