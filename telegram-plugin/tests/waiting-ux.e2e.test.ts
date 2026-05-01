/**
 * Waiting-UX E2E contract tests — Phase 1 of #545 (RED).
 *
 * These tests assert the deterministic time-sequence contract for the
 * three turn classes specified in #545. They are intentionally RED on
 * `main` — each one catches one of the four observed failure modes from
 * the live demo:
 *
 *   F1. Status reaction collapses straight to 👍 (skips 👀→🤔→🔥).
 *   F2. No instant draft/typing signal — silence "for ages" after inbound.
 *   F3. Progress card renders late.
 *   F4. Pre-tool interim text is static — no refresh on step transitions.
 *
 * Phase 1 scope is tests-only — no production fixes. Once these go green
 * we know the underlying behaviour matches the spec.
 *
 * All time control is via `vi.useFakeTimers()`. The harness records every
 * outbound bot.api call with `Date.now()` at invocation time, so first-
 * paint and ladder assertions are wall-clock deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWaitingUxHarness, type HarnessHandle } from './waiting-ux-harness.js'
import type { SessionEvent } from '../session-tail.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── Class A — Instant reply (no tool calls, <2s) ────────────────────────

describe('Class A — instant reply', () => {
  it('first-paint deadline: 👀 reaction lands within 800ms of inbound (catches F2)', async () => {
    const h = createWaitingUxHarness()
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    // Allow microtasks + the controller's queued (immediate, no debounce).
    await h.clock.advance(50)
    const firstReaction = h.recorder.firstReactionMs(CHAT)
    expect(firstReaction).not.toBeNull()
    expect((firstReaction ?? Infinity) - inboundAt).toBeLessThan(800)
    expect(h.recorder.reactionSequence()[0]).toBe('👀')
    h.finalize()
  })

  it('no progress card is sent for an instant turn (catches F3 / spec class A)', async () => {
    const h = createWaitingUxHarness({ driverInitialDelayMs: 30_000 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    // Class A: enqueue → small thinking burst → reply → turn_end, all <2s.
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(100)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(200)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 1500 })
    await h.clock.advance(2_000)
    expect(h.recorder.progressCardSendMs(CHAT)).toBeNull()
    h.finalize()
  })

  it('terminates with 👍 and no spurious intermediate states', async () => {
    const h = createWaitingUxHarness()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'hi' })
    await h.clock.advance(50)
    await h.streamReply({ chat_id: CHAT, text: 'hello back', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 800 })
    await h.clock.advance(1_500)
    expect(h.recorder.lastReactionEmoji(CHAT)).toBe('👍')
    h.finalize()
  })
})

// ─── Class B — short turn (1–3 tools, <15s) ──────────────────────────────

describe('Class B — short turn', () => {
  it('ladder integrity: 👀 → (🤔 or working glyph) before 👍 — catches F1 (straight-to-👍 collapse)', async () => {
    const h = createWaitingUxHarness({ debounceMs: 700 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'read foo.txt' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'read foo.txt' })
    // 200ms in — model starts thinking
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    // 1s in — Read tool (debounced by 700ms — should still land before turn_end)
    await h.clock.advance(800)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' })
    // Wait long enough for the tool reaction to flush past debounce.
    await h.clock.advance(1_500)
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Read' })
    await h.streamReply({ chat_id: CHAT, text: 'contents: ...', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 4_000 })
    await h.clock.advance(2_000)

    const seq = h.recorder.reactionSequence()
    // Must start with 👀
    expect(seq[0]).toBe('👀')
    // Must NOT collapse straight to 👍 — at least one intermediate before final.
    expect(seq.length).toBeGreaterThanOrEqual(3)
    const finalIdx = seq.length - 1
    expect(seq[finalIdx]).toBe('👍')
    // Intermediate states must include a thinking/working emoji, not just 👀.
    const intermediates = seq.slice(1, finalIdx)
    const hasIntermediate = intermediates.some((e) =>
      ['🤔', '🤓', '✍', '⚡', '👌', '👨‍💻', '🔥'].includes(e),
    )
    expect(hasIntermediate, `ladder collapsed: ${JSON.stringify(seq)}`).toBe(true)
    h.finalize()
  })

  it('interim refresh: pre-tool preamble updates ≥1× across step transitions (catches F4)', async () => {
    const h = createWaitingUxHarness()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'do thing' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'do thing' })
    // Initial preamble before any tool runs.
    await h.streamReply({ chat_id: CHAT, text: 'looking…' })
    await h.clock.advance(500)
    // Step transition #1 — tool_use lands.
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read', toolUseId: 't1' })
    await h.clock.advance(500)
    // Step transition #2 — second different tool category.
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'WebFetch', toolUseId: 't2' })
    await h.clock.advance(500)
    await h.streamReply({ chat_id: CHAT, text: 'final answer', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })

    // Across the two step transitions we must see ≥1 update to the
    // pre-tool preamble surface (sendMessage or editMessageText for the
    // active stream). Today's behaviour: a single static preamble then
    // silence — this assertion catches that.
    const edits = h.recorder.edits(CHAT)
    expect(edits.length, 'pre-tool preamble never refreshed').toBeGreaterThanOrEqual(1)
    h.finalize()
  })
})

// ─── Class C — long / multi-agent ────────────────────────────────────────

describe('Class C — long / multi-agent', () => {
  it('progress card renders early, before turn_end, for a multi-second turn (catches F3)', async () => {
    const h = createWaitingUxHarness({
      driverInitialDelayMs: 500, // production tunes this; harness asserts the contract
      driverCoalesceMs: 100,
      driverMinIntervalMs: 100,
    })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'big task' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'big task' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(300)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1' })
    // By 2s, the card MUST be visible — not at turn_end.
    await h.clock.advance(1_500)
    const cardAt = h.recorder.progressCardSendMs(CHAT)
    expect(cardAt, 'progress card never rendered').not.toBeNull()
    expect((cardAt ?? Infinity) - inboundAt).toBeLessThan(2_500)
    // Drain the rest of the turn so afterEach doesn't leak timers.
    h.feedSessionEvent({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' })
    await h.streamReply({ chat_id: CHAT, text: 'done', done: true })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 5_000 })
    await h.clock.advance(2_000)
    h.finalize()
  })

  it('card stays stable until ALL background work hits terminal — Done ≥ last sub-agent terminal', async () => {
    const h = createWaitingUxHarness({
      driverInitialDelayMs: 200,
      driverCoalesceMs: 100,
      driverMinIntervalMs: 100,
    })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'multi-agent' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'multi-agent' })
    await h.clock.advance(300)
    // Spawn two sub-agents.
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a1', firstPromptText: 'a1' })
    h.feedSessionEvent({ kind: 'sub_agent_started', agentId: 'a2', firstPromptText: 'a2' })
    await h.clock.advance(1_000)
    // a1 finishes early.
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a1' })
    const a1TerminalAt = h.clock.now()
    await h.clock.advance(2_000)
    // Main turn_end arrives BEFORE a2 finishes — the card must NOT mark
    // Done yet (spec: stable until all workers terminal).
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 3_000 })
    await h.clock.advance(500)
    // a2 finishes last — this is the true terminal.
    h.feedSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'a2' })
    const a2TerminalAt = h.clock.now()
    await h.clock.advance(2_000)

    // Find the card edit/send that marks Done. Production cards
    // typically include a "Done" / "✅" / "✓" glyph in the final HTML.
    const cardOps = h.recorder.calls.filter(
      (c) =>
        (c.kind === 'sendMessage' || c.kind === 'editMessageText') &&
        c.chat_id === CHAT &&
        (c.payload?.includes('Done') === true ||
          c.payload?.includes('✅') === true ||
          c.payload?.includes('✓') === true),
    )
    expect(cardOps.length, 'card never reached a Done state').toBeGreaterThan(0)
    const doneAt = cardOps[cardOps.length - 1].ts
    expect(
      doneAt,
      `card Done (${doneAt}) fired before last sub-agent terminal (${a2TerminalAt})`,
    ).toBeGreaterThanOrEqual(a2TerminalAt)
    // Sanity: a1 was earlier than a2.
    expect(a1TerminalAt).toBeLessThan(a2TerminalAt)
    h.finalize()
  })

  it('first-paint deadline still ≤800ms even on long turns', async () => {
    const h = createWaitingUxHarness({ driverInitialDelayMs: 500 })
    const inboundAt = h.clock.now()
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'long' })
    await h.clock.advance(50)
    const firstReaction = h.recorder.firstReactionMs(CHAT)
    expect(firstReaction).not.toBeNull()
    expect((firstReaction ?? Infinity) - inboundAt).toBeLessThan(800)
    // Cleanup.
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'long' })
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 100 })
    await h.clock.advance(2_000)
    h.finalize()
  })
})
