/**
 * Tests for the progress-card driver — per-chat state + emit cadence.
 *
 * Uses injected fake clock + fake setTimeout so the timing behaviour is
 * deterministic (no real wall-clock waits in CI).
 */
import { describe, it, expect, vi } from 'vitest'
import { createProgressDriver, summariseTurn } from '../progress-card-driver.js'
import { initialState, reduce } from '../progress-card.js'
import type { SessionEvent } from '../session-tail.js'

function harness(minIntervalMs = 500, coalesceMs = 400, opts?: { captureSummaries?: boolean }) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; html: string; done: boolean }> = []
  const summaries: string[] = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    onTurnEnd: opts?.captureSummaries ? (s) => summaries.push(s) : undefined,
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

  return { driver, emits, summaries, advance, tick: advance }
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

  it('startTurn fires an initial "Working…" render BEFORE any tool_use event', () => {
    // This is the anti-latency fix: the inbound-message handler calls
    // startTurn synchronously, so the card lands within ~1s of the user's
    // message even if the session-tail enqueue event is still several
    // hundred ms away.
    const { driver, emits } = harness()
    driver.startTurn({ chatId: 'c1', userText: 'please investigate' })
    expect(emits).toHaveLength(1)
    expect(emits[0].chatId).toBe('c1')
    expect(emits[0].done).toBe(false)
    // Distinctive Working… banner is present.
    expect(emits[0].html).toContain('⚙️ <b>Working…</b>')
    // No tool_use has been fed in yet — there must be no checklist items.
    expect(emits[0].html).not.toContain('⚡ <b>')
    // And the echoed user request shows up so the card ties back to the
    // user's message.
    expect(emits[0].html).toContain('please investigate')
  })

  it('startTurn passes threadId through for forum-topic chats', () => {
    const { driver, emits } = harness()
    driver.startTurn({ chatId: 'c1', threadId: 't42', userText: 'hi' })
    expect(emits).toHaveLength(1)
    expect(emits[0].threadId).toBe('t42')
  })

  it('emits immediately on stage change (plan → run)', () => {
    const { driver, emits } = harness()
    driver.ingest(enqueue('c1'), null)
    emits.length = 0
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    expect(emits).toHaveLength(1)
    expect(emits[0].html).toContain('<b>🔧 Run</b>')
    expect(emits[0].html).toContain('⚡ <b>Read</b>')
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

  it('fires onTurnEnd with a one-line summary at turn_end', () => {
    const { driver, summaries } = harness(500, 400, { captureSummaries: true })
    driver.ingest(enqueue('c1', 'fix the tests'), null)
    driver.ingest({ kind: 'tool_use', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 'c1')
    driver.ingest({ kind: 'tool_use', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'tool_result', toolUseId: 'b', toolName: 'Bash' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('2 tools')
    expect(summaries[0]).toContain('fix the tests')
  })

  it('does not fire onTurnEnd when callback is not supplied', () => {
    const { driver, summaries } = harness() // no captureSummaries
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'turn_end', durationMs: 0 }, 'c1')
    expect(summaries).toHaveLength(0)
  })
})

describe('summariseTurn', () => {
  const base = (now: number, userRequest: string) =>
    reduce(initialState(), {
      kind: 'enqueue',
      chatId: 'c',
      messageId: '1',
      threadId: null,
      rawContent: `<channel chat_id="c">${userRequest}</channel>`,
    }, now)

  it('zero tools renders as "no tools"', () => {
    const s = base(1000, 'hi')
    expect(summariseTurn(s, 2000)).toBe('no tools, 1s — hi')
  })

  it('pluralises correctly', () => {
    let s = base(1000, 'x')
    s = reduce(s, { kind: 'tool_use', toolName: 'Read' }, 1100)
    s = reduce(s, { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 1200)
    expect(summariseTurn(s, 5000)).toBe('1 tool, 4s — x')
  })

  it('m:ss format above 60 seconds', () => {
    const s = base(1000, 'long')
    expect(summariseTurn(s, 1000 + 125_000)).toBe('no tools, 2:05 — long')
  })

  it('falls back gracefully without a user request', () => {
    let s = reduce(initialState(), {
      kind: 'enqueue', chatId: 'c', messageId: null, threadId: null, rawContent: '',
    }, 1000)
    s = reduce(s, { kind: 'tool_use', toolName: 'Read' }, 1100)
    s = reduce(s, { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 1200)
    expect(summariseTurn(s, 2000)).toBe('1 tool, 1s')
  })
})
