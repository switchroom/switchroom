/**
 * Tests for issue #334 — cross-turn sub-agent visibility.
 *
 * A background sub-agent dispatched in turn N (via Agent({run_in_background:true}))
 * must remain visible on the new progress card that appears when turn N+1 starts.
 */
import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

let nextMsgId = 100

function harness(initialDelayMs = 0) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs: 0,
    coalesceMs: 0,
    initialDelayMs,
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

  return { driver, emits, advance }
}

function enqueue(chatId: string, text = 'hi'): SessionEvent {
  return {
    kind: 'enqueue',
    chatId,
    messageId: String(nextMsgId++),
    threadId: null,
    rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
  }
}

describe('cross-turn sub-agent visibility (#334)', () => {
  it('Test 1: background sub-agent from turn 1 appears on turn 2 card', () => {
    const { driver, emits } = harness()

    // Turn 1: dispatch a background sub-agent, then turn ends.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg-agent', firstPromptText: 'do work' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Turn 1 is now in pendingCompletion (sub-agent still running).
    // Turn 2 starts — this should seed the new card with the running sub-agent.
    driver.startTurn({ chatId: 'c1', userText: 'new prompt' })

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    expect(turn2State!.subAgents.has('bg-agent')).toBe(true)
    expect(turn2State!.subAgents.get('bg-agent')!.state).toBe('running')
  })

  it('Test 2: sub-agent finishing after turn 1 ends updates turn 2 card', () => {
    const { driver, emits } = harness()

    // Turn 1: dispatch background sub-agent.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg-agent', firstPromptText: 'do work' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Turn 2 starts.
    driver.startTurn({ chatId: 'c1', userText: 'next prompt' })

    // Sub-agent finishes while turn 2 is running.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'bg-agent', durationMs: 5000 }, 'c1')

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    // The sub-agent should now show as done on the turn 2 card.
    const sa = turn2State!.subAgents.get('bg-agent')
    expect(sa).toBeDefined()
    expect(sa!.state).toBe('done')
  })

  it('Test 3: foreground sub-agent (completes mid-turn 1) does NOT appear on turn 2', () => {
    const { driver, emits } = harness()

    // Turn 1: foreground sub-agent — starts and finishes before turn ends.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'fg-agent', firstPromptText: 'quick task' }, 'c1')
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'fg-agent', durationMs: 200 }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 800 }, 'c1')

    // Turn 2 starts.
    driver.startTurn({ chatId: 'c1', userText: 'next prompt' })

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    // Foreground sub-agent completed in turn 1 — must NOT bleed into turn 2.
    expect(turn2State!.subAgents.has('fg-agent')).toBe(false)
  })

  it('multiple background sub-agents: all running ones carry over', () => {
    const { driver } = harness()

    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'task 1' }, 'c1')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg2', firstPromptText: 'task 2' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    driver.startTurn({ chatId: 'c1', userText: 'turn 2' })

    const state = driver.peek('c1', undefined)
    expect(state!.subAgents.has('bg1')).toBe(true)
    expect(state!.subAgents.has('bg2')).toBe(true)
    expect(state!.subAgents.get('bg1')!.state).toBe('running')
    expect(state!.subAgents.get('bg2')!.state).toBe('running')
  })

  it('different chats do not cross-contaminate', () => {
    const { driver } = harness()

    // Chat A has a background sub-agent.
    driver.ingest(enqueue('chatA'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'agentA', firstPromptText: 'A' }, 'chatA')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chatA')

    // Chat B starts a new turn (no sub-agents in chat B).
    driver.startTurn({ chatId: 'chatB', userText: 'hello' })

    const stateB = driver.peek('chatB', undefined)
    expect(stateB!.subAgents.has('agentA')).toBe(false)
    expect(stateB!.subAgents.size).toBe(0)
  })

  it('sub-agents seeded into turn 2 are independent: finishing in turn 2 does not affect turn 3 seed', () => {
    // Verifies that the sub-agent finishing in turn 2 removes it from the
    // chat-scoped registry so turn 3 does NOT see it (independence of turns).
    const { driver } = harness()

    // Turn 1: background sub-agent dispatched.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'shared?' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Turn 2: sub-agent is seeded in.
    driver.startTurn({ chatId: 'c1', userText: 'turn 2' })
    expect(driver.peek('c1', undefined)!.subAgents.has('bg1')).toBe(true)

    // Sub-agent finishes during turn 2 — this should remove it from the registry.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'bg1', durationMs: 3000 }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c1')

    // Turn 3: the finished sub-agent must NOT appear.
    driver.startTurn({ chatId: 'c1', userText: 'turn 3' })
    const stateT3 = driver.peek('c1', undefined)
    expect(stateT3).toBeDefined()
    // bg1 completed in turn 2; turn 3 should start clean.
    expect(stateT3!.subAgents.has('bg1')).toBe(false)
  })
})
