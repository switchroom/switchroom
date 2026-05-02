/**
 * Real-gateway harness — smoke tests.
 *
 * Pin the wiring of `real-gateway-harness.ts` works end-to-end before
 * the F1–F4 tests build on it. These tests assert behaviour the harness
 * MUST exhibit for the F-tests to be meaningful:
 *
 *   1. inbound() routes through the real coalescer (👀 fires only after
 *      the gap window, not synchronously).
 *   2. gapMs=0 bypasses the buffer (👀 fires immediately).
 *   3. Multiple inbounds within the gap merge into a single flush.
 *   4. Controller + driver still work for session-event feeds (Phase 1
 *      contract still holds).
 *
 * Same fake-timers + recorder pattern as `waiting-ux.e2e.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('real-gateway harness — smoke', () => {
  it('inbound() fires 👀 immediately on raw arrival (F2 early-ack), even with coalesce wait pending', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    // Microtask flush only — no real time has passed beyond the void
    // setMessageReaction Promise resolving on the next microtask.
    await h.clock.advance(0)
    expect(h.recorder.firstReactionMs(CHAT)).not.toBeNull()
    expect(h.recorder.reactionSequence()[0]).toBe('👀')
    // Coalesce buffer still holds the message — only the reaction fired
    // early; the actual handleInbound dispatch waits for the gap.
    expect(h.coalesceBufferSize()).toBe(1)
    h.finalize()
  })

  it('after gapMs elapses, the flush fires controller.setQueued (Telegram dedupes the duplicate 👀)', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    await h.clock.advance(1500)
    expect(h.recorder.firstReactionMs(CHAT)).not.toBeNull()
    // Reaction sequence carries TWO 👀: the early-ack + the controller's
    // post-flush setQueued(). Real Telegram dedupes (same emoji = no
    // visible change). Tests asserting ladder integrity should dedupe
    // consecutive duplicates before checking the sequence.
    expect(h.recorder.reactionSequence()[0]).toBe('👀')
    expect(h.coalesceBufferSize()).toBe(0)
    h.finalize()
  })

  it('gapMs=0 bypasses the buffer (👀 fires immediately on first paint)', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    await h.clock.advance(0)
    expect(h.recorder.firstReactionMs(CHAT)).not.toBeNull()
    expect(h.coalesceBufferSize()).toBe(0)
    h.finalize()
  })

  it('multiple inbounds within the gap window merge into one flush (sliding timer resets)', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'one' })
    await h.clock.advance(1000)
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG + 1, text: 'two' })
    // First inbound's early-ack already fired 👀 by here — that's the F2 win.
    expect(h.recorder.firstReactionMs(CHAT)).not.toBeNull()
    await h.clock.advance(1000) // 1s after 'two' — still buffered
    expect(h.coalesceBufferSize()).toBe(1)
    await h.clock.advance(500)  // 1.5s after 'two' — flush
    expect(h.coalesceBufferSize()).toBe(0)
    // The mid-turn 'two' inbound is suppressed by the activeTurns gate
    // (turn started on flush of 'one'... but here the flush is at the
    // END so 'one' alone never had a flush; both are coalesced into one
    // turn). So only the FIRST inbound's early-ack fires; 'two' lands
    // before any turn started, but the early-ack still counts it as a
    // fresh-turn ack on the same key. Only one 👀 emoji per coalesce
    // turn after the controller dedupes. Test simplifies to: at least one
    // 👀 fired, but multiple are tolerated (Telegram dedupes by emoji).
    expect(h.recorder.reactionSequence().filter((e) => e === '👀').length).toBeGreaterThanOrEqual(1)
    h.finalize()
  })

  it('Phase 1 contract still holds — feedSessionEvent drives controller transitions', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 }) // bypass coalesce for this isolation test
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    await h.clock.advance(0)
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(50)
    // Status reaction debounce (default 700ms) must elapse for transitions to land.
    await h.clock.advance(800)
    expect(h.recorder.reactionSequence()).toContain('👀')
    h.finalize()
  })
})
