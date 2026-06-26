import { describe, expect, it } from 'vitest'

import { mayOpenActivityCard } from '../gateway/feed-open-gate.js'

/**
 * Feed-OPEN gate — pure decision (design `docs/message-emission-determinism.md`
 * §9 levers 1 + 4). Gates WHEN the activity card may first OPEN (fresh
 * sendMessage). An EDIT of an already-open card is never routed through this
 * (the drain only consults it when activityMessageId == null).
 *
 * Lever 5 — INERT (#2588 fix): the original Lever 5 blocked narrative from
 * opening a card on 0-tool turns to prevent a "triplication" reorder. This
 * over-suppressed conversational turns. Lever 2 (clearActivitySummary, gateway
 * executeReply) already guarantees reply-is-last ordering by editing the
 * narrative card in-place before the reply sends — Lever 5 was redundant.
 * Pre-answer narrative now DOES open a card; post-answer is blocked by Lever 1.
 *
 * Lever 1 (reply-is-last): once a SUBSTANTIVE final answer has been delivered
 * (the sticky finalAnswerEverDelivered latch), no card may open below it — for
 * ANY producer, EXCEPT when `postAnswerSubagentActivity === true && producer ===
 * 'tool'` (Fix 2 / #2587 supersede: background-agent liveness below the reply).
 * The latch is NOT the mutable finalAnswerDelivered (reopen clears that
 * mid-turn, #2141); an ack does not set it, so the ack-then-work feed opens.
 */
describe('mayOpenActivityCard — Lever 5 INERT: narrative opens pre-answer (Fix 1 / #2588)', () => {
  it('narrative SHOW on a 0-tool turn DOES open a card pre-answer (Lever 5 removed)', () => {
    // Lever 5 was: producer === "narrative" && labeledToolCount === 0 → false.
    // Now it is INERT: pre-answer narrative may open. Lever 2 (clearActivitySummary)
    // guarantees the card edits in-place before the reply sends — reply-is-last
    // is preserved without Lever 5. This is the #2588 fix.
    expect(
      mayOpenActivityCard({
        producer: 'narrative',
        finalAnswerEverDelivered: false,
        labeledToolCount: 0,
      }),
    ).toBe(true)
  })

  it('a tool label DOES open a card (producer B, unchanged)', () => {
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
      }),
    ).toBe(true)
  })

  it('the liveness timer DOES open a 0-tool thinking-gap card (producer C, unchanged)', () => {
    expect(
      mayOpenActivityCard({
        producer: 'liveness',
        finalAnswerEverDelivered: false,
        labeledToolCount: 0,
      }),
    ).toBe(true)
  })

  it('narrative SHOW once a tool label has landed DOES open (the accumulated narration renders; R4)', () => {
    // A turn that starts conversational then dispatches a tool: labeledToolCount
    // is now > 0, so even a narrative-driven drain may open and render the
    // accumulated narration.
    expect(
      mayOpenActivityCard({
        producer: 'narrative',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
      }),
    ).toBe(true)
  })
})

describe('mayOpenActivityCard — lever 1 (no OPEN after a substantive final)', () => {
  it('blocks a tool-label OPEN after a substantive final (race A/B/E)', () => {
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: true,
        labeledToolCount: 3,
      }),
    ).toBe(false)
  })

  it('blocks a liveness OPEN after a substantive final', () => {
    expect(
      mayOpenActivityCard({
        producer: 'liveness',
        finalAnswerEverDelivered: true,
        labeledToolCount: 0,
      }),
    ).toBe(false)
  })

  it('blocks a narrative OPEN after a substantive final', () => {
    expect(
      mayOpenActivityCard({
        producer: 'narrative',
        finalAnswerEverDelivered: true,
        labeledToolCount: 2,
      }),
    ).toBe(false)
  })

  it('does NOT block when no substantive final yet — an ack (latch false) leaves opening allowed (#2141)', () => {
    // An ack sets finalAnswerDelivered (mutable) but NOT the sticky latch, so
    // a post-ack tool label still opens the reopened feed.
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
      }),
    ).toBe(true)
  })
})

describe('mayOpenActivityCard — lever 1 exception: post-answer sub-agent liveness (Fix 2 / #2587 supersede)', () => {
  // When a background sub-agent continues working after the parent's substantive
  // reply, `postAnswerSubagentActivity=true` + `producer='tool'` lifts Lever 1
  // so the heartbeat can open a liveness card below the reply. This signal is
  // driven by `turn.subagentActivityAt`, written by the watcher's onProgress
  // callback INDEPENDENTLY of the tool_label path (so the drop-guard cannot gate
  // it). Idle producers (liveness, narrative) remain blocked — the reply-is-last
  // invariant holds for idle post-answer gaps.

  it('post-answer REAL sub-agent activity DOES open a card (tool + postAnswerSubagentActivity)', () => {
    // The core Fix 2 assertion: a background worker is still active after the
    // answer → a liveness card surfaces below the reply.
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: true,
        labeledToolCount: 3,
        postAnswerSubagentActivity: true,
      }),
    ).toBe(true)
  })

  it('post-answer idle liveness does NOT open (no postAnswerSubagentActivity)', () => {
    // Without the signal, Lever 1 stays fully active — idle heartbeat after the
    // answer is still suppressed. Idle-gap suppression preserved.
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: true,
        labeledToolCount: 3,
        postAnswerSubagentActivity: false,
      }),
    ).toBe(false)
  })

  it('post-answer liveness producer stays blocked even with the signal (not tool producer)', () => {
    // Only 'tool' is exempted. A 'liveness' producer (wall-clock heartbeat
    // with no new watcher step) may not open a card after the final answer.
    expect(
      mayOpenActivityCard({
        producer: 'liveness',
        finalAnswerEverDelivered: true,
        labeledToolCount: 0,
        postAnswerSubagentActivity: true,
      }),
    ).toBe(false)
  })

  it('post-answer narrative producer stays blocked even with the signal', () => {
    // Narrative alone after the final answer may not open — reply-is-last.
    expect(
      mayOpenActivityCard({
        producer: 'narrative',
        finalAnswerEverDelivered: true,
        labeledToolCount: 2,
        postAnswerSubagentActivity: true,
      }),
    ).toBe(false)
  })
})

describe('mayOpenActivityCard — lever 4 (no OPEN below an EARLIER turn answer; race C/D)', () => {
  // The cross-turn case: a synthetic represent/owed-reply turn starts with a
  // CLEARED per-turn `finalAnswerEverDelivered` latch even though a substantive
  // answer already reached the user in a PRIOR turn. The caller computes
  // `crossTurnAnswerDelivered` (via hasOutboundDeliveredSince, obligation
  // openedAt cutoff, 200-char substantive threshold) and passes it here.

  it('blocks a tool-label OPEN when a substantive answer was already delivered cross-turn', () => {
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false, // fresh synthetic turn — its own latch is clear
        labeledToolCount: 2,
        crossTurnAnswerDelivered: true, // but the exchange already got an answer
      }),
    ).toBe(false)
  })

  it('blocks a liveness/heartbeat OPEN cross-turn (the heartbeat surface on the synthetic turn)', () => {
    expect(
      mayOpenActivityCard({
        producer: 'liveness',
        finalAnswerEverDelivered: false,
        labeledToolCount: 0,
        crossTurnAnswerDelivered: true,
      }),
    ).toBe(false)
  })

  it('blocks a narrative OPEN cross-turn', () => {
    expect(
      mayOpenActivityCard({
        producer: 'narrative',
        finalAnswerEverDelivered: false,
        labeledToolCount: 3,
        crossTurnAnswerDelivered: true,
      }),
    ).toBe(false)
  })

  it('does NOT block when the obligation is genuinely unanswered (no substantive reply since it was raised) — represent still surfaces', () => {
    // The inverse / no-regression: an obligation with NO delivered answer since
    // it was raised → crossTurnAnswerDelivered false → the represent turn's card
    // opens as normal. (The represent SEND itself is owned by the represent
    // guard, not this gate; this asserts the gate does not over-suppress.)
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered: false,
      }),
    ).toBe(true)
  })

  it('is inert on a normal foreground turn (crossTurnAnswerDelivered omitted/false)', () => {
    // A foreground turn never carries the cross-turn gate, so the caller passes
    // false/undefined and lever 4 cannot affect it — the foreground card opens.
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
      }),
    ).toBe(true)
  })

  it('does NOT regress #2141: an ack-then-work cross-turn surface with no SUBSTANTIVE reply still opens', () => {
    // crossTurnAnswerDelivered keys on SUBSTANTIVE (≥200-char) delivery. An ack
    // ("On it…") is not substantive, so the caller computes false and the
    // ack-then-work feed still opens.
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered: false,
      }),
    ).toBe(true)
  })
})
