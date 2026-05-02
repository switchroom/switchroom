/**
 * Waiting-UX v2 spec — RED tests pinning the new three-class contract.
 *
 * This is PR 1 of the #553 series. All `describe` blocks here are
 * `describe.skip`'d on purpose — these tests author the contract for
 * the rewrite, but the production fixes that turn them green land in
 * subsequent PRs (2 through 5). Each block carries a `// TODO(#553-PR-N)`
 * marker for which PR un-skips it.
 *
 * Spec contract — three turn classes, gated on tools and elapsed time:
 *
 *   Class A — instant (<2s, NO tools):
 *     👀 reaction → answer text. No placeholder. No progress card.
 *
 *   Class B — short (2–60s, tools, NO sub-agents):
 *     👀 → ladder reactions (🤔, 🔥, etc.) → answer text streams.
 *     No placeholder. No progress card.
 *
 *   Class C — long-running (>60s OR sub-agents/background workers):
 *     👀 → ladder → progress card appears once
 *     `(elapsed >= 60s) OR (any sub-agent has appeared)`. Card stays
 *     pinned-feel until ALL work terminal.
 *
 * Key invariants:
 *   - A "background worker" ≡ a sub-agent dispatched with
 *     `Agent({ run_in_background: true })` — there is no separate concept.
 *   - The card is gated on `(elapsed >= 60s) OR (any sub-agent appeared)`.
 *     Tool-use alone NEVER triggers the card.
 *   - The placeholder strings (`🔵 thinking`, `📚 recalling memories`,
 *     `💭 thinking`) are removed entirely in PR 5 — none should appear
 *     in any payload, ever.
 *   - First-answer-text deadline: <800ms for Class A, TBD by PR 3 for
 *     Class B/C.
 *   - Sub-agent header count must equal rendered-list-length (no drift).
 *
 * RED-state intent: each `it(...)` is authored so that, when un-skipped
 * against current main, it FAILS. That failure is the bug. PRs 2–5
 * make the failure go away.
 *
 *   PR 2 — kill instant-draft placeholder + early 👀 path
 *           → un-skips Class A and the ladder/no-placeholder bits of B
 *   PR 3 — first-answer-text deadline (Class B/C TBD value)
 *           → un-skips the answer-text-deadline assertions
 *   PR 4 — card-gate rewrite: `(>=60s) OR (sub-agent appeared)`
 *           → un-skips Class C card-gate tests + Class B "no card" test
 *   PR 5 — remove placeholder strings entirely + sub-agent header
 *           count = list length
 *           → un-skips the "no placeholder" assertions repo-wide and
 *           the sub-agent count = list length test
 *
 * Tracking: #553 (parent series), waiting-ux-spec.md (contract source).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

// First-answer-text deadlines per spec. Class A is pinned at 1500ms
// (covers the 800ms 👀 deadline + token-stream first chunk). Class
// B/C are TBD by PR 3 — placeholder values picked here as the upper
// bound the implementer should beat; tighten when the real numbers
// land.
const CLASS_A_ANSWER_TEXT_DEADLINE_MS = 1500
const CLASS_BC_ANSWER_TEXT_DEADLINE_MS = 5_000 // TBD: PR 3

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ─── Class A — instant (<2s, NO tools) ───────────────────────────────────
//
// TODO(#553-PR-2): un-skip after instant-draft placeholder removal +
// early-ack 👀 lands. TODO(#553-PR-5): the no-placeholder assertion
// only goes fully green once the placeholder strings are deleted from
// the production code paths.
describe.skip('v2 spec — Class A (instant, <2s, no tools)', () => {
  it('emits NO placeholder text edits at any point', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 600 })
    await h.clock.advance(500)

    expect(h.expectNoPlaceholderEdits(CHAT)).toEqual([])
    h.finalize()
  })

  it('emits NO progress card', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 600 })
    await h.clock.advance(500)

    expect(h.expectNoCardSent(CHAT)).toBeNull()
    h.finalize()
  })

  it('👀 reaction lands within 800ms of inbound', async () => {
    const h = createRealGatewayHarness({ gapMs: 1500 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    await h.clock.advance(800)

    const firstReactionMs = h.recorder.firstReactionMs(CHAT)
    expect(firstReactionMs).not.toBeNull()
    expect((firstReactionMs ?? Infinity) - inboundAt).toBeLessThan(800)
    h.finalize()
  })

  it(`first answer text lands within ${CLASS_A_ANSWER_TEXT_DEADLINE_MS}ms of inbound`, async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    await h.clock.advance(50)

    const answerAt = h.firstAnswerTextMs(CHAT)
    expect(answerAt, 'no answer text recorded').not.toBeNull()
    expect((answerAt ?? Infinity) - inboundAt).toBeLessThan(CLASS_A_ANSWER_TEXT_DEADLINE_MS)
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 600 })
    await h.clock.advance(500)
    h.finalize()
  })

  it('emits NO `sendMessageDraft`-style placeholder draft sends', async () => {
    // Currently the production "instant draft" flow can `sendMessage`
    // a placeholder body that gets edited later. The v2 contract
    // bans that — the first sendMessage to the user MUST be real
    // answer text. We assert this by re-using the placeholder
    // helper: any placeholder sendMessage is a draft send.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 600 })
    await h.clock.advance(500)

    const draftSends = h
      .expectNoPlaceholderEdits(CHAT)
      .filter((c) => c.kind === 'sendMessage')
    expect(draftSends).toEqual([])
    h.finalize()
  })
})

// ─── Class B — short (2–60s, tools, no sub-agents) ───────────────────────
//
// TODO(#553-PR-2): un-skip the no-placeholder + answer-text bits.
// TODO(#553-PR-4): un-skip "no progress card" once the card gate
// changes from "elapsed > initialDelayMs OR tool-count threshold" to
// "elapsed >= 60s OR sub-agent appeared".
// TODO(#553-PR-5): ladder integrity is final-state RED only after PR 5
// removes the placeholder fallback that currently masks the regression.
describe.skip('v2 spec — Class B (short, 2–60s, tools, no sub-agents)', () => {
  it('emits NO placeholder text edits', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'do a thing' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'do a thing' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    await h.clock.advance(3_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    await h.streamReply({ chat_id: CHAT, text: 'all done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 4_000 })
    await h.clock.advance(500)

    expect(h.expectNoPlaceholderEdits(CHAT)).toEqual([])
    h.finalize()
  })

  it('emits NO progress card (turn under 60s, no sub-agents)', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'short tool turn' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'short tool turn' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    // Two tools, total turn ~10s — well under 60s, no sub-agents.
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' })
    await h.clock.advance(3_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' })
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't2' })
    await h.clock.advance(5_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't2', toolName: 'Bash' })
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 9_000 })
    await h.clock.advance(500)

    expect(h.expectNoCardSent(CHAT)).toBeNull()
    h.finalize()
  })

  it('ladder integrity: 👀 → at least one tool reaction → 👍 (no straight-to-👍 collapse)', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'ladder' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'ladder' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    await h.clock.advance(3_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 4_000 })
    await h.clock.advance(1_500)

    const seq = h.recorder.reactionSequence()
    // Dedupe consecutive duplicates (early-ack + setQueued both emit 👀).
    const ladder: string[] = []
    for (const e of seq) if (ladder[ladder.length - 1] !== e) ladder.push(e)
    expect(ladder[0]).toBe('👀')
    expect(ladder[ladder.length - 1]).toBe('👍')
    expect(ladder.length).toBeGreaterThanOrEqual(3)
    h.finalize()
  })

  it(`first answer text lands within ${CLASS_BC_ANSWER_TEXT_DEADLINE_MS}ms of inbound`, async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'short tool' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'short tool' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    // Answer text begins streaming as soon as the model resumes — pin
    // the deadline to the spec value (TBD: PR 3 may tighten).
    await h.streamReply({ chat_id: CHAT, text: 'partial...', done: false })
    await h.clock.advance(50)

    const answerAt = h.firstAnswerTextMs(CHAT)
    expect(answerAt, 'no answer text recorded').not.toBeNull()
    expect((answerAt ?? Infinity) - inboundAt).toBeLessThan(CLASS_BC_ANSWER_TEXT_DEADLINE_MS)

    await h.streamReply({ chat_id: CHAT, text: 'partial... done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })
    await h.clock.advance(500)
    h.finalize()
  })
})

// ─── Class C — long-running (>60s OR sub-agents/background workers) ───────
//
// TODO(#553-PR-4): un-skip the card-gate tests once the gate is
// `(elapsed >= 60s) OR (sub-agent appeared)`.
// TODO(#553-PR-5): un-skip the no-placeholder + sub-agent count tests.
describe.skip('v2 spec — Class C (long-running OR sub-agents)', () => {
  it('progress card appears when a sub-agent dispatches (regardless of elapsed time)', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'spawn a worker' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'spawn a worker' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    // Sub-agent appears well under the 60s elapsed threshold — the
    // card MUST still render because of the sub-agent gate.
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a1', firstPromptText: 'do work' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a1' })
    await h.clock.advance(500)

    expect(h.expectNoCardSent(CHAT), 'card MUST render when a sub-agent dispatches').not.toBeNull()

    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })
    await h.clock.advance(500)
    h.finalize()
  })

  it('progress card appears when elapsed >= 60s even without a sub-agent', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'long single tool' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'long single tool' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    // Cross the 60s threshold.
    await h.clock.advance(61_000)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    await h.clock.advance(500)

    expect(h.expectNoCardSent(CHAT), 'card MUST render after 60s elapsed').not.toBeNull()

    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 62_000 })
    await h.clock.advance(500)
    h.finalize()
  })

  it('card stays pinned-feel: not marked Done while any sub-agent is in flight', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'fanout' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'fanout' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a1', firstPromptText: 'first' })
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a2', firstPromptText: 'second' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a1' })
    // a2 still in flight — the card must NOT show Done yet, even though
    // the parent turn could complete.
    await h.clock.advance(500)
    const editsBeforeA2Done = h.recorder.edits(CHAT).map((e) => e.payload ?? '')
    const sawPrematureDone = editsBeforeA2Done.some((p) => /done/i.test(p) && !/working/i.test(p))
    expect(sawPrematureDone, 'card marked Done while a sub-agent was still running').toBe(false)

    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a2' })
    await h.streamReply({ chat_id: CHAT, text: 'all done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })
    await h.clock.advance(500)
    h.finalize()
  })

  it('emits NO placeholder text edits across the full turn', async () => {
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'long with workers' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'long with workers' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a1', firstPromptText: 'work' })
    await h.clock.advance(2_000)
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a1' })
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })
    await h.clock.advance(500)

    expect(h.expectNoPlaceholderEdits(CHAT)).toEqual([])
    h.finalize()
  })

  it('sub-agent header count equals rendered-list-length (no drift)', async () => {
    // The card header summarises "N workers"; the rendered bullet list
    // should have exactly N entries. Pre-fix, the two diverge on rapid
    // start/end events.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'spawn three' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'spawn three' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a1', firstPromptText: 'first' })
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a2', firstPromptText: 'second' })
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a3', firstPromptText: 'third' })
    await h.clock.advance(2_000)

    const cardEdits = h.recorder.calls.filter(
      (c) => (c.kind === 'sendMessage' || c.kind === 'editMessageText') && c.chat_id === CHAT,
    )
    expect(cardEdits.length, 'no card render captured').toBeGreaterThan(0)
    const last = cardEdits[cardEdits.length - 1].payload ?? ''
    // Match a "N workers" / "N sub-agents" header and the bullet list.
    const headerMatch = last.match(/(\d+)\s+(?:workers?|sub[- ]?agents?)/i)
    expect(headerMatch, 'card payload missing worker-count header').not.toBeNull()
    const headerCount = Number(headerMatch?.[1] ?? -1)
    const bulletCount = (last.match(/^[•\-*]\s/gm) ?? []).length
    expect(headerCount).toBe(bulletCount)

    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a1' })
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a2' })
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a3' })
    await h.streamReply({ chat_id: CHAT, text: 'all done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })
    await h.clock.advance(500)
    h.finalize()
  })
})
