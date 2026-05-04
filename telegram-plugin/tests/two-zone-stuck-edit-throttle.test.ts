/**
 * P3 of #662 — stuck escalation respects the edit throttle.
 *
 * Tests that stuck-detection adds at most one extra emit beyond the
 * heartbeat baseline. Compares two 100s runs: one where keep-alive
 * events prevent the member from going stuck, one where it does.
 * The difference should be ≤1 (the stuck transition itself).
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

function createHarness() {
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
  return { driver, advance, emits, getNow: () => now }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

const toolUse = (toolUseId: string): SessionEvent => ({
  kind: 'sub_agent_tool_use',
  agentId: 'sa1',
  toolUseId,
  toolName: 'Read',
  input: { file_path: '/tmp/x' },
})

function runHarness(keepAlive: boolean): { emitCount: number } {
  const { driver, advance, emits, getNow } = createHarness()
  const CHAT = 'c1'
  driver.ingest(enqueue(CHAT), null)
  driver.ingest(
    { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'work', subagentType: 'worker' },
    CHAT,
  )
  const startEmits = emits.length

  // Run 100s total. If keepAlive, dispatch tool_use events at 30s intervals
  // to keep lastActivityAt fresh and prevent the member from going stuck.
  // Otherwise, let it go stuck at ~60s.
  if (keepAlive) {
    for (let elapsed = 0; elapsed < 100_000; elapsed += 30_000) {
      driver.ingest(toolUse(`tu-${elapsed}`), CHAT)
      advance(30_000)
    }
  } else {
    advance(100_000)
  }

  return { emitCount: emits.length - startEmits }
}

describe('P3 stuck escalation — edit throttle', () => {
  it('stuck-detection adds at most one extra emit beyond heartbeat baseline', () => {
    // Baseline: 100s with keep-alive events every 30s. Member never goes
    // stuck. Heartbeat fires ~20 times due to elapsed-time changes (by
    // design, matches #314's elapsed-ticker JTBD).
    const baseline = runHarness(true)

    // With stuck transition: 100s with no keep-alive. Member crosses stuck
    // threshold at ~60s; markStuck flips status once.
    const stuck = runHarness(false)

    // The delta should be 0 or 1 — the stuck transition is content-changing
    // so it could add one emit, but it likely lands on a heartbeat tick that
    // was emitting anyway.
    // The stuck path must not emit a storm — at most one extra emit
    // beyond the keep-alive baseline. (The keep-alive baseline can be
    // HIGHER than the stuck path because each tool_use event is itself
    // content-changing; that's fine — we only care that stuck-detection
    // doesn't ADD emits beyond the heartbeat-driven elapsed updates.)
    expect(stuck.emitCount).toBeLessThanOrEqual(baseline.emitCount + 1)
  })

  it('stuck transition does not produce a runaway edit storm', () => {
    // Sanity: 100s of pure silence (no keep-alive) emits well under the
    // ~20-tick heartbeat ceiling plus a single stuck transition. This
    // catches a regression where markStuck would re-fire every tick.
    const stuck = runHarness(false)
    expect(stuck.emitCount).toBeLessThanOrEqual(25)
  })
})
