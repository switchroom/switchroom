/**
 * F4 — "static interim text" — regression guard.
 *
 * Symptom from #545: on multi-step turns, the pre-tool preamble shows
 * once and then stays static — user sees "Let me check X" once, then
 * silence through the rest of the tool chain.
 *
 * Investigation finding (#553 PR 5): the deterministic harness CAN'T
 * currently reproduce F4 with well-spaced text → tool steps. Each text
 * event passes `extractNarrativeLabel` (any non-empty single line is a
 * label), gets a new narrative entry, and the renderer's
 * branch=narratives path picks them up. The driver diag log confirms
 * "narratives=3 items=3" for a 3-step turn — all preambles land.
 *
 * Where F4 may still manifest in production:
 *   - Rapid text bursts within `coalesceMs` (~400ms) — only the latest
 *     narrative survives the coalesce flush
 *   - `edit_budget_threshold` throttling — subsequent edits dropped
 *   - Specific text shapes that break `extractNarrativeLabel` (multi-
 *     line prose with the "real" label not on line 1)
 *
 * Under v2 (#553 PR 4): the card is suppressed for tool-only turns
 * under 60s (Class B). The original 7s tool-chain version of this test
 * no longer renders a card by design — preamble text in Class B lives
 * in the answer-text stream, not the card. To keep the F4 regression
 * guard meaningful, the test now uses a sub-agent turn (Class C) so
 * the card actually renders and we can inspect its preamble updates.
 *
 * Spec contract from `waiting-ux-spec.md`:
 *
 *   F4: pre-tool preamble updates at least once per "step transition"
 *   (configurable heuristic: new tool category, or >Ns since last
 *   refresh).
 *
 * Tracking: #545 (parent), #553 (Phase 3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('F4 — preamble refresh on step transitions (regression guard)', () => {
  it('three well-spaced text → tool steps produce three distinct preamble updates in the rendered card', async () => {
    // Class C turn (sub-agent present) so the card actually renders
    // under the v2 gate. The sub-agent dispatches up front (promotes
    // the card immediately), then three text → tool step transitions
    // exercise the F4 narrative refresh path.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'multi-step task' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'multi-step task' })
    await h.clock.advance(200)

    // Sub-agent dispatched — Class C, card renders.
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a1', firstPromptText: 'background work' })
    await h.clock.advance(200)

    // Step 1: text + tool
    h.feedSessionEvent({ kind: 'text', text: 'First, let me check the logs.' })
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' })

    // Step 2: text + tool (NEW narrative)
    h.feedSessionEvent({ kind: 'text', text: 'Now searching for errors in the output.' })
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Grep', toolUseId: 't2' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't2', toolName: 'Grep' })

    // Step 3: text + tool (NEW narrative)
    h.feedSessionEvent({ kind: 'text', text: 'Found the issue, let me apply the fix.' })
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Edit', toolUseId: 't3' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't3', toolName: 'Edit' })

    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a1' })
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 7_000 })
    await h.clock.advance(2_000)

    // Inspect the rendered card edits — each step's preamble should
    // appear in at least one card edit. If F4 is real, fewer than 3
    // distinct preambles will show up.
    const cardEdits = h.recorder.calls.filter(
      (c) => (c.kind === 'sendMessage' || c.kind === 'editMessageText') && c.chat_id === CHAT,
    )
    const edits = cardEdits.map((c) => c.payload ?? '')
    const sawStep1 = edits.some((e) => e.includes('check the logs'))
    const sawStep2 = edits.some((e) => e.includes('searching for errors'))
    const sawStep3 = edits.some((e) => e.includes('apply the fix'))
    expect(sawStep1, 'step 1 preamble missing from card').toBe(true)
    expect(sawStep2, 'step 2 preamble missing from card').toBe(true)
    expect(sawStep3, 'step 3 preamble missing from card').toBe(true)
    h.finalize()
  })
})
