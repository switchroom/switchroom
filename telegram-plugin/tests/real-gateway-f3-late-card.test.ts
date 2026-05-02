/**
 * F3 — "late progress card" — REFRAMED under v2 (#553 PR 4).
 *
 * Original symptom from #545: on long-running turns (Class C), the
 * progress card rendered late — sometimes after `turn_end`, sometimes
 * never. Under v1, the user sat watching status reactions cycle for
 * 10+ seconds with no card visible, then either got a sudden card right
 * before the reply or just the reply with no card at all.
 *
 * **Under v2 (#553 PR 4), F3's symptom is by design — tool-only turns
 * never show the card.** The card now requires sub-agents OR
 * `elapsed >= 60s`. F3-style late-card is no longer a bug; it's the
 * spec. The driver defaults shifted from
 * `initialDelayMs=30_000, promoteAfterMs=5_000, promoteOnParentToolCount=3`
 * to `initialDelayMs=60_000, promoteAfterMs=0, promoteOnParentToolCount=0`.
 *
 * What this file now covers:
 *   - Long single-tool turn (~10s): card MUST NOT render (tools alone
 *     don't promote).
 *   - Two-tool turn (~6s): card MUST NOT render.
 *   - Class A instant reply (<2s, no tools): card MUST NOT render
 *     (regression guard, unchanged).
 *
 * The "card renders after >=60s" path is covered by the v2 spec test
 * (`real-gateway-spec.test.ts` → "Class C — progress card appears when
 * elapsed >= 60s even without a sub-agent"). The "card renders on
 * sub-agent" path is covered there too.
 *
 * Tracking: #545 (parent), #553 (Phase 3, PR 4 reframe).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('F3 — under v2: tool-only turns intentionally show no card', () => {
  it('long single-tool turn (~10s): NO card rendered (intentional, v2 spec)', async () => {
    // v2 defaults: initialDelayMs=60_000, promoteAfterMs=0 (disabled),
    // promoteOnParentToolCount=0 (disabled). A 10s single-tool turn
    // crosses neither the 60s threshold nor any tool/sub-agent promote
    // gate — the card is suppressed by design.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'long task' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'long task' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(500)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    // Tool runs ~10s — well under the 60s spec threshold.
    await h.clock.advance(10_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    await h.clock.advance(200)

    // Spec: tools alone never trigger the card.
    expect(h.recorder.progressCardSendMs(CHAT)).toBeNull()

    // Drain the rest of the turn so afterEach doesn't leak timers.
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 11_000 })
    await h.clock.advance(2_000)
    h.finalize()
  })

  it('two-tool turn (~6s): NO card rendered (intentional, v2 spec)', async () => {
    // 2 tools, ~6s — same v2 contract: tools alone don't promote, and
    // 6s is well under the 60s threshold. Card stays suppressed.
    const h = createRealGatewayHarness({ gapMs: 0 })
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

    expect(h.recorder.progressCardSendMs(CHAT)).toBeNull()

    // Drain
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 7_000 })
    await h.clock.advance(2_000)
    h.finalize()
  })

  it('instant reply (Class A, <2s, no tools): card is STILL suppressed (regression guard)', async () => {
    // Unchanged from the original F3 file — the v2 contract preserves
    // fast-turn suppression for instant replies. This is the only
    // "card should not appear" assertion that has the same meaning
    // pre- and post-v2.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(500)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 1_500 })
    await h.clock.advance(2_000)

    // Class A: no card.
    expect(h.recorder.progressCardSendMs(CHAT)).toBeNull()
    h.finalize()
  })
})
