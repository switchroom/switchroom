/**
 * Tests for the progress-card driver — per-chat state + emit cadence.
 *
 * Uses injected fake clock + fake setTimeout so the timing behaviour is
 * deterministic (no real wall-clock waits in CI).
 */
import { describe, it, expect, vi } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

function harness(minIntervalMs = 500, coalesceMs = 400) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; html: string; done: boolean }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs,
    coalesceMs,
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
  })

  const advance = (ms: number): void => {
    now += ms
    // Fire any scheduled timer whose fireAt is now or earlier, in order.
    for (;;) {
      timers.sort((a, b) => a.fireAt - b.fireAt)
      const next = timers[0]
      if (!next || next.fireAt > now) break
      timers.shift()
      next.fn()
    }
  }

  return { driver, emits, advance, tick: advance }
}

const enqueue = (chatId: string, text = 'hi'): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
})

describe('progress-card driver', () => {
  it('emits immediately on enqueue', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    expect(emits).toHaveLength(1)
    expect(emits[0].chatId).toBe('c1')
    expect(emits[0].done).toBe(false)
    expect(emits[0].html).toContain('💬 hi')
  })

  it('emits immediately on stage change (plan → run)', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    emits.length = 0
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].html).toContain('<b>🔧 Run</b>')
    expect(emits[0].html).toContain('⚡ Read')
  })

  it('emits immediately on turn_end with done=true', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    emits.length = 0
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].done).toBe(true)
    expect(emits[0].html).toContain('<b>✅ Done</b>')
  })

  it('coalesces bursts of non-stage-changing events', () => {
    const { driver, emits, advance } = harness(500, 400)
    driver.ingest(enqueue('c1'), null) // emit #1
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1') // emit #2 (stage change)
    // tool_result doesn't change stage (we're already in 'run')
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Grep' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'b', toolName: 'Grep' }, 'c1')
    expect(emits.length).toBe(2) // only the two stage changes so far
    // Advance through the coalesce delay + min-interval floor
    advance(1000)
    expect(emits.length).toBe(3) // exactly one more flush for the burst
    const last = emits[emits.length - 1]
    expect(last.html).toContain('✅ Read')
    expect(last.html).toContain('✅ Grep')
  })

  it('never emits the same HTML twice in a row (deduped)', () => {
    const { driver, emits, advance } = harness()
    driver.ingest(enqueue('c1'), null)
    emits.length = 0
    // Thinking events don't change the rendered output
    driver.ingest({ kind: 'thinking' }, 'c1')
    advance(2000)
    driver.ingest({ kind: 'thinking' }, 'c1')
    advance(2000)
    expect(emits).toHaveLength(0)
  })

  it('separate chats have separate state', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1', 'request-one'), null)
    driver.ingest(enqueue('c2', 'request-two'), null)
    expect(emits.map((e) => e.chatId)).toEqual(['c1', 'c2'])
    expect(emits[0].html).toContain('request-one')
    expect(emits[1].html).toContain('request-two')
  })

  it('turn_end drops state so next turn starts fresh', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(driver.peek('c1')).toBeUndefined()
    emits.length = 0

    // New turn
    driver.ingest(enqueue('c1', 'second'), null)
    expect(emits).toHaveLength(1)
    expect(emits[0].html).toContain('💬 second')
    // No leaked items from the prior turn
    expect(emits[0].html).not.toContain('Read')
  })

  it('respects minIntervalMs floor on back-to-back coalesced flushes', () => {
    const { driver, emits, advance } = harness(500, 400)
    driver.ingest(enqueue('c1'), null) // emit @1000
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1') // stage change, emit @1000
    emits.length = 0
    // Close out the Read — not a stage change, coalesces
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c1')
    // Coalesce window is 400ms; min-interval is 500ms (since last emit was @1000)
    // Expected: flush at max(400, 500-0) = 500ms from the last emit
    advance(400) // still inside min-interval — no flush yet
    expect(emits).toHaveLength(0)
    advance(200) // now past both windows
    expect(emits).toHaveLength(1)
  })
})
