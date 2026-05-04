/**
 * P3 of #662 — stuck → running recovery.
 *
 * After a member is marked stuck via the heartbeat tick, a new
 * sub_agent_tool_use event must reset status to running and refresh
 * lastActivityAt to the event's now.
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

interface Timer {
  fireAt: number
  fn: () => void
  ref: number
  repeat?: number
}

function harness() {
  let now = 1000
  const timers: Timer[] = []
  let nextRef = 0
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
    heartbeatMs: 5000,
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
  function advance(ms: number) {
    const target = now + ms
    while (true) {
      const due = timers
        .filter((t) => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const t = due[0]
      now = t.fireAt
      t.fn()
      if (t.repeat) {
        t.fireAt = now + t.repeat
      } else {
        const idx = timers.indexOf(t)
        if (idx !== -1) timers.splice(idx, 1)
      }
    }
    now = target
  }
  return { driver, advance, getNow: () => now }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P3 stuck escalation — recovery', () => {
  it('next sub_agent_tool_use after stuck flips status back to running and bumps lastActivityAt', () => {
    const { driver, advance, getNow } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'work', subagentType: 'worker' },
      CHAT,
    )
    advance(61_000)
    const stuck = driver.peekFleet(CHAT)!.get('sa1')!
    expect(stuck.status).toBe('stuck')

    // Now a real tool event arrives — recovery.
    driver.ingest(
      { kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't1', toolName: 'Read', input: { file_path: '/tmp/x.ts' } },
      CHAT,
    )
    const recovered = driver.peekFleet(CHAT)!.get('sa1')!
    expect(recovered.status).toBe('running')
    expect(recovered.lastActivityAt).toBe(getNow())
  })
})
