/**
 * F2 — "no instant draft / typing signal" — RED test against real-gateway harness.
 *
 * Symptom from #545: when a user DMs the agent, the chat sits silent
 * for "ages" before any acknowledgement (👀 reaction, typing draft,
 * etc). Spec contract from `waiting-ux-spec.md`:
 *
 *   F2 deadline: firstReactionAt - inboundAt < 800ms for ALL turn classes.
 *
 * Phase 1's harness called `controller.setQueued()` synchronously inside
 * its `inbound()` helper, so the F2 deadline was satisfied trivially —
 * not because the production code was correct, but because the harness
 * was lying about the inbound flow.
 *
 * The Phase 3 real-gateway harness wires the production
 * `InboundCoalescer` (default `gapMs=1500`) BEFORE first-paint, faithfully
 * reproducing what every Telegram-only user sees: 👀 fires only after
 * the coalesce window closes, ~1500ms after their message landed. That's
 * ~700ms over the 800ms deadline.
 *
 * This test is **expected to fail** on `main` until the F2 fix lands —
 * it's a red marker that the bug exists. The fix moves first-paint out
 * of the coalesced flush so 👀 fires on raw arrival; the deadline is
 * then trivially met regardless of the coalesce window.
 *
 * Tracking: #545 (parent), #553 (Phase 3 harness).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ─────────────────────────────────────────────────────────────────────
// F2 deadline — fix not yet landed; the assertion below SHOULD fail
// once the harness wires the real coalescer + production first-paint.
// Skipped until the F2 fix flips it green.
// TODO(#553-F2): un-skip once first-paint moves out of the coalesce flush.
// ─────────────────────────────────────────────────────────────────────
describe.skip('F2 — first-paint deadline (👀 within 800ms of inbound)', () => {
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
