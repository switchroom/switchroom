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
