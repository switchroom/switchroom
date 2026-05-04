/**
 * P2 of #662 — completion gate: a turn with both foreground (done) and
 * background (still running) sub-agents must NOT fire onTurnComplete
 * until the background member also reaches a terminal state. This is
 * the "✅ Done only when everything is actually done" invariant; the
 * v2 renderer uses the same predicate to choose between the
 * ⏸ Background and ✅ Done header phases.
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import { hasLiveBackground } from '../fleet-state.js'
import type { SessionEvent } from '../session-tail.js'

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const completions: string[] = []
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
    onTurnComplete: (s) => completions.push(s.turnKey),
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
  return { driver, completions, advance: (ms: number) => { now += ms } }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P2: completion gates on background fleet members', () => {
  it('hasLiveBackground reflects fleet status correctly', () => {
    const fleet = new Map([
      ['a', { agentId: 'a', status: 'background' as const, terminalAt: null } as never],
      ['b', { agentId: 'b', status: 'done' as const, terminalAt: 2000 } as never],
    ])
    expect(hasLiveBackground(fleet as never)).toBe(true)
    fleet.set('a', { agentId: 'a', status: 'done' as const, terminalAt: 3000 } as never)
    expect(hasLiveBackground(fleet as never)).toBe(false)
  })

  it('foreground sub completes + background still running → no turn completion', () => {
    const { driver, completions } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)
    // Foreground Agent dispatch.
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tuFg',
        input: { prompt: 'fg', description: 'fg-job' },
      },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saFG', firstPromptText: 'fg' }, CHAT)
    // Background Agent dispatch.
    driver.ingest(
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'tuBg',
        input: { prompt: 'bg', description: 'bg-job', run_in_background: true },
      },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'saBG', firstPromptText: 'bg' }, CHAT)
    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    // Foreground completes.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saFG' }, CHAT)
    // Parent ends.
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, CHAT)

    // Background still running → no completion fired.
    expect(completions.length).toBe(0)
    const fleet = driver.peekFleet(CHAT)!
    expect(fleet.get('saFG')!.status).toBe('done')
    expect(fleet.get('saBG')!.status).toBe('background')

    // Background completes → completion fires.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'saBG' }, CHAT)
    expect(completions.length).toBe(1)
  })
})
