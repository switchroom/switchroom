/**
 * #654 regression tests — deterministic double-message fix via card
 * takeover.
 *
 * Bug: when an agent's turn took longer than `initialDelayMs` (60s) AND
 * the agent emitted assistant text without calling `reply` /
 * `stream_reply` (turn-flush path), the user saw TWO outbound Telegram
 * messages — the pinned progress card AND the turn-flush bubble — for
 * one logical reply.
 *
 * Root cause: the gateway's turn-flush path issued a fresh
 * `bot.api.sendMessage` even when a progress card was already on screen
 * for that turn. The driver's `forceCompleteTurn` couldn't help because
 * once the deferred-emit timer had fired, no path existed to retract
 * the posted card — `flush()` would only edit it to "Done".
 *
 * Fix: add a `takeOverCard` method to the driver that:
 *   - cancels the pending deferred-emit timer if not yet fired
 *   - sets `cardTakenOver = true` so subsequent `flush()` calls
 *     short-circuit (no further "Done" edit)
 *   - returns `{ wasEmitted, turnKey }` so the caller (turn-flush)
 *     can look up the pinned messageId and rewrite it in place via
 *     `editMessageText` instead of creating a second message.
 *
 * The harness gap that hid the bug: no existing test wired a real
 * driver into a long-turn scenario. `turn-flush-safety.test.ts`
 * covered `decideTurnFlush()` only; `real-gateway-i6` covered turn-
 * flush replay/dedup but never modeled a card already on screen.
 *
 * These tests pin the driver-level contract. The gateway integration
 * is exercised in the bridged scenario at the bottom of this file.
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

function harness(opts?: { initialDelayMs?: number }) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{
    chatId: string
    threadId?: string
    turnKey: string
    html: string
    done: boolean
    isFirstEmit: boolean
  }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs: 0,
    coalesceMs: 0,
    initialDelayMs: opts?.initialDelayMs ?? 60_000,
    promoteAfterMs: 999_999,
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

let nextMsgId = 1
function enqueue(chatId: string, text = 'q', threadId: string | null = null): SessionEvent {
  return {
    kind: 'enqueue',
    chatId,
    messageId: String(nextMsgId++),
    threadId,
    rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
  } as unknown as SessionEvent
}

describe('takeOverCard — #654 regression', () => {
  it('returns wasEmitted=false when card has not yet emitted (pre-60s turn)', () => {
    // Fast-turn case: turn-flush fires before the deferred-emit timer.
    // Driver suppresses the card; turn-flush sends fresh.
    const { driver } = harness({ initialDelayMs: 60_000 })
    driver.ingest(enqueue('c1'), 'c1')
    // Don't advance — timer still pending.

    const result = driver.takeOverCard({ chatId: 'c1' })
    expect(result.wasEmitted).toBe(false)
    expect(result.turnKey).not.toBeNull()
    expect(typeof result.turnKey).toBe('string')
  })

  it('returns wasEmitted=true when deferred-emit timer has fired (the #654 path)', () => {
    // Slow-turn case: the card has been emitted to the chat. takeOverCard
    // signals that the caller should edit-in-place rather than send fresh.
    const { driver, emits, advance } = harness({ initialDelayMs: 60_000 })
    driver.ingest(
      enqueue('c1'),
      'c1',
    )
    advance(60_000)
    expect(emits.length).toBeGreaterThan(0) // card emitted

    const result = driver.takeOverCard({ chatId: 'c1' })
    expect(result.wasEmitted).toBe(true)
    expect(typeof result.turnKey).toBe('string')
    expect(result.turnKey).toContain('c1')
  })

  it('cancels the pending deferred-emit timer (no late card emission)', () => {
    // After takeOverCard cancels the timer, advancing past the original
    // delay must NOT produce a card emit.
    const { driver, emits, advance } = harness({ initialDelayMs: 60_000 })
    driver.ingest(
      enqueue('c1'),
      'c1',
    )
    expect(emits.length).toBe(0) // suppressed by initial delay

    driver.takeOverCard({ chatId: 'c1' })
    advance(120_000) // way past 60s

    expect(emits.length).toBe(0) // timer was cancelled — no late emit
  })

  it('blocks subsequent flushes — driver.ingest(turn_end) does NOT emit a "Done" edit', () => {
    // The bug case: after card is on screen, gateway calls takeOverCard,
    // then session-tail dispatches turn_end which the driver ingests.
    // Without the cardTakenOver guard, turn_end would call flush(forceDone)
    // → editMessageText("Done") — wasted edit. With the guard, no emit.
    const { driver, emits, advance } = harness({ initialDelayMs: 60_000 })
    driver.ingest(
      enqueue('c1'),
      'c1',
    )
    advance(60_000)
    const emitsAfterCard = emits.length
    expect(emitsAfterCard).toBeGreaterThan(0)

    driver.takeOverCard({ chatId: 'c1' })

    // Now simulate the driver receiving turn_end (as session-tail would
    // dispatch synchronously upstream of the gateway's turn-flush block).
    driver.ingest(
      { kind: 'turn_end', durationMs: 70_000 } as unknown as SessionEvent,
      'c1',
    )
    expect(emits.length).toBe(emitsAfterCard) // no additional edits
  })

  it('idempotent — second call returns same shape, no double-cancel side-effects', () => {
    const { driver, emits, advance } = harness({ initialDelayMs: 60_000 })
    driver.ingest(
      enqueue('c1'),
      'c1',
    )
    advance(60_000)
    const emitsAfter1 = emits.length

    const r1 = driver.takeOverCard({ chatId: 'c1' })
    const r2 = driver.takeOverCard({ chatId: 'c1' })
    expect(r1).toEqual(r2)
    expect(emits.length).toBe(emitsAfter1)
  })

  it('returns null turnKey when no active card exists for (chatId, threadId)', () => {
    const { driver } = harness({ initialDelayMs: 60_000 })
    const result = driver.takeOverCard({ chatId: 'never-enqueued' })
    expect(result).toEqual({ wasEmitted: false, turnKey: null })
  })

  it('routes by chatId+threadId — separate chats do not clobber each other', () => {
    const { driver } = harness({ initialDelayMs: 60_000 })
    driver.ingest(enqueue('c1'), 'c1')
    driver.ingest(enqueue('c2'), 'c2')

    // Take over c1 — c2's card must remain untouched.
    const r1 = driver.takeOverCard({ chatId: 'c1' })
    expect(r1.turnKey).toContain('c1')
    expect(r1.turnKey).not.toContain('c2')

    // c2 still has its own active card, distinct turnKey.
    const r2 = driver.takeOverCard({ chatId: 'c2' })
    expect(r2.turnKey).toContain('c2')
    expect(r2.turnKey).not.toContain('c1')
  })
})
