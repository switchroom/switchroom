/**
 * F3 — "late progress card" — regression test against real-gateway harness.
 *
 * Symptom from #545: on long-running turns (Class C), the progress card
 * renders late — sometimes after `turn_end`, sometimes never. User sits
 * watching status reactions cycle for 10+ seconds with no card visible,
 * then either gets a sudden card right before the reply or just the
 * reply with no card at all.
 *
 * Root cause: `progress-card-driver` defaults `initialDelayMs=30000`
 * (30 seconds — designed to suppress cards for instant replies). The
 * existing `promoteFirstEmit` mechanism short-circuits the wait under
 * specific conditions:
 *
 *   - parent tool count ≥ `promoteOnParentToolCount` (default 3)
 *   - any sub-agent started
 *   - carried-over sub-agents at enqueue
 *   - sub-agent stalled
 *
 * **Gap**: a long single-tool turn (e.g. one Bash that takes 10 seconds)
 * never crosses any promotion threshold. Card waits the full 30s, then
 * fast-turn-suppression cancels it at `turn_end`. F3 directly observed.
 *
 * Fix: add a time-based promotion — after Ns of activity (any session
 * event) in still-`isFirstEmit` state, promote. 5s gives users a clear
 * "agent is working" signal without breaking instant-reply suppression
 * (sub-2s turns still skip the card).
 *
 * Spec contract from `waiting-ux-spec.md` Class C:
 *   - Status card renders early, **stays pinned-feel and stable**
 *
 * Tracking: #545 (parent), #553 (Phase 3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('F3 — progress card renders early on long turns', () => {
  it('long single-tool turn (~10s): card renders before turn_end', async () => {
    // Production defaults: initialDelayMs=30000, promoteOnParentToolCount=3.
    // A 10s single-tool turn crosses neither — card waits the full 30s,
    // then fast-turn-suppression cancels it. This is exactly F3.
    const h = createRealGatewayHarness({ gapMs: 0 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'long task' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'long task' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(500)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    // Tool runs ~10s — well past the 5s promotion threshold the fix introduces.
    await h.clock.advance(10_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    await h.clock.advance(200)

    // Spec: card MUST be visible by now (well within the 10s tool window).
    const cardAt = h.recorder.progressCardSendMs(CHAT)
    expect(cardAt, 'progress card never rendered for a 10s long turn').not.toBeNull()
    // Card should have rendered within ~5s of inbound (the time-promotion
    // threshold), not at the 30s initialDelay.
    expect((cardAt ?? Infinity) - inboundAt).toBeLessThan(8_000)

    // Drain the rest of the turn so afterEach doesn't leak timers.
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 11_000 })
    await h.clock.advance(2_000)
    h.finalize()
  })

  it('two-tool turn (~6s): card renders within 5-6s of inbound', async () => {
    // 2 tools — below the parent_tool_count promotion threshold (3).
    // Without time-based promotion, this turn would wait 30s then
    // suppress. With the fix, it promotes around the 5s mark.
    const h = createRealGatewayHarness({ gapMs: 0 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'two tools' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'two tools' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(500)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' })
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't2' })
    await h.clock.advance(3_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't2', toolName: 'Bash' })
    await h.clock.advance(500)

    const cardAt = h.recorder.progressCardSendMs(CHAT)
    expect(cardAt, 'progress card never rendered for a 6s 2-tool turn').not.toBeNull()
    expect((cardAt ?? Infinity) - inboundAt).toBeLessThan(7_000)

    // Drain
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 7_000 })
    await h.clock.advance(2_000)
    h.finalize()
  })

  it('instant reply (Class A, <2s, no tools): card is STILL suppressed (regression guard)', async () => {
    // The fix must not regress fast-turn suppression — a sub-2s turn
    // with no tools should still skip the card entirely.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(500)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 1_500 })
    await h.clock.advance(2_000)

    // Class A: no card. Pin so the F3 fix doesn't blanket-promote.
    expect(h.recorder.progressCardSendMs(CHAT)).toBeNull()
    h.finalize()
  })
})
