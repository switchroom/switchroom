/**
 * Integration tests for the progress-card / bridge-disconnect fix (#393).
 *
 * Uses the same harness pattern as progress-card-driver.test.ts
 * (driver + mock emit + fake timers).
 *
 * Tests 11-16 cover the core bridge-disconnect scenarios.
 * Tests 17-20 cover edge cases: watcher stall, multi-sub-agent, etc.
 */

import { describe, it, expect, vi } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

// ─── Shared harness ────────────────────────────────────────────────────────

interface BridgeHarnessOpts {
  heartbeatMs?: number
  deferredCompletionTimeoutMs?: number
  maxIdleMs?: number
  coalesceMs?: number
  minIntervalMs?: number
  initialDelayMs?: number
  subAgentTickIntervalMs?: number
}

function bridgeHarness(opts: BridgeHarnessOpts = {}) {
  const {
    heartbeatMs = 5_000,
    deferredCompletionTimeoutMs = 3 * 60_000,
    maxIdleMs = 5 * 60_000,
    coalesceMs = 0,
    minIntervalMs = 0,
    initialDelayMs = 0,
    subAgentTickIntervalMs = 10_000,
  } = opts

  let now = 1_000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{
    chatId: string
    threadId?: string
    turnKey: string
    html: string
    done: boolean
    isFirstEmit: boolean
  }> = []
  const completeCalls: Array<{ chatId: string; turnKey: string }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    onTurnComplete: (a) => completeCalls.push({ chatId: a.chatId, turnKey: a.turnKey }),
    minIntervalMs,
    coalesceMs,
    heartbeatMs,
    initialDelayMs,
    deferredCompletionTimeoutMs,
    maxIdleMs,
    subAgentTickIntervalMs,
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (handle) => {
      const target = (handle as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === target)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (handle) => {
      const target = (handle as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === target)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })

  const advance = (ms: number): void => {
    now += ms
    for (;;) {
      timers.sort((a, b) => a.fireAt - b.fireAt)
      const next = timers[0]
      if (!next || next.fireAt > now) break
      if (next.repeat != null) {
        next.fireAt += next.repeat
        next.fn()
      } else {
        timers.shift()
        next.fn()
      }
    }
  }

  let msgId = 100

  const enqueueMsg = (chatId: string, text = 'do work'): SessionEvent => ({
    kind: 'enqueue',
    chatId,
    messageId: String(msgId++),
    threadId: null,
    rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
  })

  /** Simulate bridge disconnect (Option A fix). */
  const bridgeDisconnect = () => driver.dispose?.({ preservePending: true })

  /** Simulate bridge reconnect — just emit a new session event for the same chat. */
  const bridgeReconnectEvent = (chatId: string, event: SessionEvent) =>
    driver.ingest(event, chatId)

  return {
    driver,
    emits,
    completeCalls,
    advance,
    enqueueMsg,
    bridgeDisconnect,
    bridgeReconnectEvent,
  }
}

// ─── Test 11: Bridge disconnect mid-defer preserves state ─────────────────

describe('bridge disconnect mid-deferred-completion (fix #393)', () => {
  it('test 11: bridge disconnect mid-defer preserves state and heartbeat continues', () => {
    const { driver, emits, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    // Set up a turn with a background sub-agent
    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    // Parent turn ends while sub-agent is still running → pendingCompletion=true
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    // Verify the card is still alive (deferred completion)
    expect(driver.peek('chat1')).toBeDefined()

    const emitsBeforeDisconnect = emits.length
    // Simulate bridge disconnect
    bridgeDisconnect()

    // Chat state must still be alive (preserved)
    expect(driver.peek('chat1')).toBeDefined()

    // Advance 5 seconds — heartbeat tick should fire editMessageText (emit)
    advance(5_000)
    expect(emits.length).toBeGreaterThan(emitsBeforeDisconnect)
  })

  // Test 12: Heartbeat continues firing post-disconnect
  it('test 12: heartbeat continues firing multiple times after bridge disconnect', () => {
    const { driver, emits, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    const emitsBeforeDisconnect = emits.length
    bridgeDisconnect()

    // Advance 30 seconds — heartbeat fires every 5s (~6 ticks). Each tick
    // re-renders, but the driver's change-only emit dedupes ticks where the
    // rendered HTML is identical. The strong invariant: at least one emit
    // must land post-disconnect (matching the existing heartbeat test
    // pattern at progress-card-driver.test.ts:528).
    advance(30_000)
    const emitsDelta = emits.length - emitsBeforeDisconnect
    expect(emitsDelta).toBeGreaterThanOrEqual(1)
  })

  // Test 13: deferredCompletionTimeoutMs fires after disconnect → stalledClose
  it('test 13: deferredCompletionTimeoutMs fires after disconnect with stalledClose header', () => {
    const { driver, emits, completeCalls, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,  // 3 minutes
      maxIdleMs: 10 * 60_000,                    // 10 min zombie ceiling — won't interfere
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    bridgeDisconnect()

    // Advance 3 minutes (deferred-completion timeout)
    advance(3 * 60_000 + 5_000)

    // onTurnComplete must have fired
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0].chatId).toBe('chat1')

    // The final emit must be done=true with stalledClose header.
    // Asserting on the specific "forced close" / "Stalled" text — a generic
    // ⚠️ check would also match silentEnd or stuckMs renders.
    const finalEmit = [...emits].reverse().find(e => e.chatId === 'chat1')
    expect(finalEmit?.done).toBe(true)
    expect(finalEmit?.html).toContain('Stalled')
    expect(finalEmit?.html).toContain('forced close')
  })

  // Test 14: maxIdleMs zombie ceiling fires after disconnect
  it('test 14: maxIdleMs zombie ceiling force-closes card after disconnect', () => {
    const { driver, emits, completeCalls, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 0,  // disabled so maxIdleMs path runs
      maxIdleMs: 5 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    bridgeDisconnect()

    // Advance 5 minutes + extra for heartbeat tick to fire
    advance(5 * 60_000 + 10_000)

    // Card must have been force-closed
    expect(completeCalls).toHaveLength(1)
    const finalEmit = [...emits].reverse().find(e => e.chatId === 'chat1')
    expect(finalEmit?.done).toBe(true)
  })

  // Test 15: Bridge reconnect attaches to preserved chat state, no duplicate cards
  it('test 15: new bridge connection routes events to existing chat state without creating a duplicate card', () => {
    const { driver, emits, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    // Count isFirstEmit=true emits before disconnect (should be exactly 1)
    const firstEmitsBefore = emits.filter(e => e.isFirstEmit).length

    bridgeDisconnect()
    advance(5_000)

    // Simulate reconnect: a new bridge sends a sub_agent_tool_use for the existing sub-agent
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'bg1', toolName: 'Read', toolUseId: 'tu1', toolLabel: 'Read' }, 'chat1')
    advance(0)

    // No new card should have been created — isFirstEmit should still be exactly 1
    const firstEmitsAfter = emits.filter(e => e.isFirstEmit).length
    expect(firstEmitsAfter).toBe(firstEmitsBefore)

    // Verify the new event actually mutated the PRESERVED chat state — i.e.,
    // the sub-agent's currentTool was set by the sub_agent_tool_use event.
    // If the new bridge had created a duplicate state slot, the preserved-
    // state's currentTool would still be undefined. This is the strong
    // assertion that state was REUSED, not duplicated.
    // (toolCount is incremented on tool_result, not tool_use — Gap 5 #316.)
    const preservedState = driver.peek('chat1')
    expect(preservedState).toBeDefined()
    const sa = preservedState!.subAgents.get('bg1')
    expect(sa).toBeDefined()
    expect(sa!.currentTool?.tool).toBe('Read')
  })

  // Test 16: Multiple bridge connect/disconnect cycles — no chat-state corruption
  it('test 16: 5 bridge disconnect/reconnect cycles produce no duplicate cards or corruption', () => {
    const { driver, emits, completeCalls, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    // Simulate 5 bridge disconnect/reconnect cycles
    for (let i = 0; i < 5; i++) {
      bridgeDisconnect()
      advance(2_000) // heartbeat fires between cycles
      // Reconnect: sub-agent sends an event
      driver.ingest({ kind: 'sub_agent_text', agentId: 'bg1', text: `thinking ${i}` }, 'chat1')
      advance(0)
    }

    // No premature completion
    expect(completeCalls).toHaveLength(0)

    // Exactly 1 card (no duplicate first-emit cards)
    const firstEmits = emits.filter(e => e.isFirstEmit)
    expect(firstEmits).toHaveLength(1)

    // Chat state still healthy
    expect(driver.peek('chat1')).toBeDefined()

    // Finally, sub-agent finishes → completion fires
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'bg1' }, 'chat1')
    advance(0)
    expect(completeCalls).toHaveLength(1)
  })
})

// ─── Tests 17-20: Edge cases ──────────────────────────────────────────────

describe('edge cases — bridge disconnect + watcher stall (#393)', () => {
  // Test 17: Watcher stall produces card edit via onSubAgentStall
  it('test 17: onSubAgentStall triggers a heartbeat re-render with stall indicator', () => {
    const { driver, emits, enqueueMsg, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    const countBefore = emits.length
    // Simulate watcher detecting a stall
    driver.onSubAgentStall('bg1', 65_000, 'bg task')

    // Advance one heartbeat tick — the stall should force a re-render
    advance(5_000)
    expect(emits.length).toBeGreaterThan(countBefore)
  })

  // Test 18: Stall callback fires AFTER bridge disconnect
  it('test 18: stall callback still produces card edit after bridge disconnect (original bug scenario)', () => {
    const { driver, emits, enqueueMsg, bridgeDisconnect, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'bg task' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    // Bridge disconnects (the regression scenario)
    bridgeDisconnect()

    const countBeforeStall = emits.length
    // Watcher detects stall AFTER bridge disconnect
    driver.onSubAgentStall('bg1', 65_000, 'bg task')

    // Heartbeat tick: must produce a card edit because dispose preserved chat state
    advance(5_000)
    expect(emits.length).toBeGreaterThan(countBeforeStall)
  })

  // Test 19: Multi-sub-agent — one stalls, one finishes
  it('test 19: two sub-agents — finishing one does not trigger overall completion when other is stalled', () => {
    const { driver, emits, completeCalls, enqueueMsg, advance } = bridgeHarness({
      heartbeatMs: 5_000,
      deferredCompletionTimeoutMs: 3 * 60_000,
    })

    driver.ingest(enqueueMsg('chat1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'agent-A', firstPromptText: 'task A' }, 'chat1')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'agent-B', firstPromptText: 'task B' }, 'chat1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chat1')
    advance(0)

    // agent-A stalls
    driver.onSubAgentStall('agent-A', 65_000, 'task A')
    advance(5_000)

    // Verify card still visible (both still pending)
    expect(driver.peek('chat1')).toBeDefined()

    // agent-B finishes
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'agent-B' }, 'chat1')
    advance(0)

    // Overall completion must NOT fire yet — agent-A is still running
    expect(completeCalls).toHaveLength(0)
    expect(driver.peek('chat1')).toBeDefined()

    // agent-A also finishes → now completion fires
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'agent-A' }, 'chat1')
    advance(0)
    expect(completeCalls).toHaveLength(1)
  })

  // Test 20: sub-agent JSONL gone mid-stall — onSubAgentStall for unknown agentId is a no-op
  it('test 20: onSubAgentStall with unknown agentId does not crash (defensive)', () => {
    const { driver, enqueueMsg, advance } = bridgeHarness()

    driver.ingest(enqueueMsg('chat1'), null)
    advance(0)

    // agentId not tracked in any chat state → must silently no-op
    expect(() => {
      driver.onSubAgentStall('nonexistent-agent', 65_000, 'ghost task')
    }).not.toThrow()
  })
})
