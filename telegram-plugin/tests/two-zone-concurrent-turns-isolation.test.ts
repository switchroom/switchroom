/**
 * P2 of #662 — concurrent-chat isolation. Two distinct chats each
 * spawn a background sub-agent. Routing must keep their fleets
 * completely independent: a tool_use event for chat A's bg sub-agent
 * must never bleed into chat B's fleet, and vice versa.
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })
  return { driver, advance: (ms: number) => { now += ms } }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P2: concurrent-chat fleet isolation', () => {
  it('two chats with their own background sub-agents do not cross-pollinate', () => {
    const { driver } = harness()

    // Chat A
    driver.ingest(enqueue('cA'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tuA',
        input: { prompt: 'pA', run_in_background: true },
      },
      'cA',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saA', firstPromptText: 'pA' }, 'cA')

    // Chat B
    driver.ingest(enqueue('cB'), null)
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tuB',
        input: { prompt: 'pB', run_in_background: true },
      },
      'cB',
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saB', firstPromptText: 'pB' }, 'cB')

    const fleetA = driver.peekFleet('cA')!
    const fleetB = driver.peekFleet('cB')!
    expect(fleetA.has('saA')).toBe(true)
    expect(fleetA.has('saB')).toBe(false)
    expect(fleetB.has('saB')).toBe(true)
    expect(fleetB.has('saA')).toBe(false)
    expect(fleetA.get('saA')!.status).toBe('background')
    expect(fleetB.get('saB')!.status).toBe('background')
  })
})
