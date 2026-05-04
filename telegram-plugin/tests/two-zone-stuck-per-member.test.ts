/**
 * P3 of #662 — per-member stuck escalation.
 *
 * Drives the real createProgressDriver heartbeat tick across the 60s
 * threshold and asserts the fleet member's `status` flips
 * `running` → `stuck` exactly when `now - lastActivityAt > 60_000`.
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

function harness(opts: { heartbeatMs?: number } = {}) {
  let now = 1000
  const timers: Timer[] = []
  let nextRef = 0
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
    heartbeatMs: opts.heartbeatMs ?? 5000,
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
    // Fire all due timers (including repeating heartbeat) up to target.
    // Loop until no due timers remain to handle re-scheduled timers
    // synthesised inside fired callbacks.
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
  return { driver, advance, getNow: () => now, timers }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P3 stuck escalation — per-member', () => {
  it('fleet member stays running at 59s of idle', () => {
    const { driver, advance } = harness({ heartbeatMs: 5000 })
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'work', subagentType: 'worker' },
      CHAT,
    )
    // Advance 59s — heartbeat fires multiple times but we are still
    // within the 60s idle window, so no stuck transition should happen.
    advance(59_000)
    const m = driver.peekFleet(CHAT)!.get('sa1')!
    expect(m.status).toBe('running')
  })

  it('fleet member flips to stuck at >60s of idle', () => {
    const { driver, advance } = harness({ heartbeatMs: 5000 })
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'work', subagentType: 'worker' },
      CHAT,
    )
    advance(61_000)
    const m = driver.peekFleet(CHAT)!.get('sa1')!
    expect(m.status).toBe('stuck')
  })
})
