/**
 * F2 — "no instant draft / typing signal" — regression test.
 *
 * Spec contract from `waiting-ux-spec.md`:
 *
 *   F2 deadline: firstReactionAt - inboundAt < 800ms for ALL turn classes.
 *
 * Pre-fix history: Phase 1's harness (#547) called `setQueued()` synchronously
 * inside its `inbound()` helper, so F2 passed trivially — the harness was
 * lying about the inbound flow. The Phase 3 real-gateway harness (#553 PR 1)
 * wired the production `InboundCoalescer` BEFORE first-paint, exposing that
 * 👀 only fired AFTER the coalesce window (default 1500ms) — ~700ms over deadline.
 *
 * Fix (#553 PR 2): `gateway.ts handleInboundCoalesced` now fires the 👀
 * reaction directly on raw arrival via `bot.api.setMessageReaction`,
 * BEFORE the coalesce buffer. Eligibility: paired DM users on a fresh
 * turn (mid-turn messages preserve the current 🔥/🤔 state). The
 * controller's later `setQueued()` runs as before; Telegram dedupes
 * the duplicate 👀 emit.
 *
 * These tests pin the post-fix contract so the gap can never re-open.
 *
 * Tracking: #545 (parent), #553 (Phase 3 harness + fixes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('F2 — first-paint deadline (👀 within 800ms of inbound)', () => {
  it('Class A — instant reply: 👀 reaction within 800ms', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 }) // production default
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    // Allow up to 800ms for the deadline; do NOT advance through the
    // full coalesce window — the deadline says 👀 lands BEFORE the
    // coalesce flush would.
    await h.clock.advance(800)
    const firstReactionMs = h.recorder.firstReactionMs(CHAT)
    expect(firstReactionMs).not.toBeNull()
    expect((firstReactionMs ?? Infinity) - inboundAt).toBeLessThan(800)
    h.finalize()
  })

  it('Class B — short turn: 👀 reaction within 800ms even with later tool calls', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'do a thing' })
    await h.clock.advance(800)
    const firstReactionMs = h.recorder.firstReactionMs(CHAT)
    expect(firstReactionMs).not.toBeNull()
    expect((firstReactionMs ?? Infinity) - inboundAt).toBeLessThan(800)
    h.finalize()
  })

  it('Class C — long / multi-agent: 👀 reaction within 800ms regardless of total turn duration', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'big task' })
    await h.clock.advance(800)
    const firstReactionMs = h.recorder.firstReactionMs(CHAT)
    expect(firstReactionMs).not.toBeNull()
    expect((firstReactionMs ?? Infinity) - inboundAt).toBeLessThan(800)
    h.finalize()
  })

  it('still meets deadline when an operator tunes coalescingGapMs lower', async () => {
    const h = createRealGatewayHarness({ gapMs: 500 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    await h.clock.advance(800)
    const firstReactionMs = h.recorder.firstReactionMs(CHAT)
    expect(firstReactionMs).not.toBeNull()
    expect((firstReactionMs ?? Infinity) - inboundAt).toBeLessThan(800)
    h.finalize()
  })
})
