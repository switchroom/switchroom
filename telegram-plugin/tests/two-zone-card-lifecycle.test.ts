/**
 * P1 of #662 — lifecycle integration. Drive the real driver with
 * TWO_ZONE_CARD=1 set; assert the rendered HTML for a turn with 2
 * fleet members contains expected substrings (header phase, parent
 * bullets, fleet rows, fleet count).
 *
 * Uses the same lightweight harness pattern as
 * progress-card-driver-fleet-shadow.test.ts — no Telegram bot, just
 * record the emit calls and inspect their HTML payload.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; payload: string }> = []
  const driver = createProgressDriver({
    emit: (args) => {
      // Parent card emits only — sub-agent per-agent cards carry agentId.
      if ((args as { agentId?: string }).agentId == null) {
        emits.push({ chatId: args.chatId, payload: args.html })
      }
    },
    minIntervalMs: 0,
    coalesceMs: 0,
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
  return {
    driver,
    emits,
    advance: (ms: number) => {
      now += ms
      const due = timers.filter((t) => t.fireAt <= now)
      for (const t of due) {
        t.fn()
        if (t.repeat) {
          t.fireAt = now + t.repeat
        } else {
          const i = timers.indexOf(t)
          if (i >= 0) timers.splice(i, 1)
        }
      }
    },
    flush: () => {
      // Pump any pending timers
      const due = timers.filter((t) => t.fireAt <= now)
      for (const t of due) t.fn()
    },
  }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('two-zone-card lifecycle (TWO_ZONE_CARD=1)', () => {
  let prevFlag: string | undefined
  beforeEach(() => {
    prevFlag = process.env.TWO_ZONE_CARD
    process.env.TWO_ZONE_CARD = '1'
  })
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.TWO_ZONE_CARD
    else process.env.TWO_ZONE_CARD = prevFlag
  })

  it('renders two-zone card with fleet rows when flag is on', () => {
    const { driver, emits, advance } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)

    const events: SessionEvent[] = [
      { kind: 'tool_use', toolUseId: 'p1', toolName: 'Read', input: { file_path: '/tmp/foo.ts' } },
      { kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'do work', subagentType: 'worker' },
      { kind: 'sub_agent_started', agentId: 'sa2', firstPromptText: 'review', subagentType: 'reviewer' },
      { kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't1', toolName: 'Grep', input: { pattern: 'TODO' } },
    ]
    for (const ev of events) driver.ingest(ev, CHAT)
    // Drain the coalesce/min-interval setTimeout queue so deferred
    // sub-agent emits flush. Each ingest schedules a 0-delay timer
    // that is only invoked when fake time advances.
    advance(0)

    // Find the most recent emitted payload — it should be a two-zone card.
    const last = emits[emits.length - 1]
    expect(last).toBeDefined()
    const html = last.payload
    // Header substrings
    expect(html).toMatch(/Working/)
    // Fleet zone present with count
    expect(html).toContain('FLEET (2)')
    expect(html).toContain('worker')
    expect(html).toContain('reviewer')
    // Fleet ids (6 chars)
    expect(html).toContain('sa1')
    expect(html).toContain('sa2')
  })
})
