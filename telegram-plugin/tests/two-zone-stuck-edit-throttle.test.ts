/**
 * P3 of #662 — stuck escalation respects the edit throttle.
 *
 * Drives many heartbeat ticks within a 10s window while a single
 * sub-agent member is idle (and crosses the 60s stuck threshold mid-
 * window). Asserts the emit count remains within the existing
 * heartbeat-bucket cap (≤ 2 emits per 10s for stuck-only transitions).
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
  const emits: Array<{ html: string; isFirstEmit: boolean }> = []
  const driver = createProgressDriver({
    emit: (e) => {
      emits.push({ html: e.html, isFirstEmit: e.isFirstEmit })
    },
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
  return { driver, advance, emits }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('P3 stuck escalation — edit throttle', () => {
  it('many heartbeat ticks across the stuck threshold do not produce a runaway edit storm', () => {
    const { driver, advance, emits } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'work', subagentType: 'worker' },
      CHAT,
    )
    const startEmits = emits.length
    // 100 seconds of idle — heartbeat fires ~20 times (every 5s).
    // The fleet member crosses the stuck threshold around t=60s.
    // After it's stuck, subsequent ticks must NOT keep editing.
    advance(100_000)
    const editsDuring = emits.length - startEmits
    // Conservative: at most a few emits — one for the stuck transition,
    // potentially elapsed-ticker emits, but nothing close to 20.
    expect(editsDuring).toBeLessThanOrEqual(5)
  })
})
