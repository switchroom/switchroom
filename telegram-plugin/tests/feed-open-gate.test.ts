import { describe, expect, it } from 'vitest'

import { mayOpenActivityCard } from '../gateway/feed-open-gate.js'

/**
 * Feed-OPEN gate — pure decision (design `docs/message-emission-determinism.md`
 * §9 levers 1 + 5). Gates WHEN the activity card may first OPEN (fresh
 * sendMessage). An EDIT of an already-open card is never routed through this
 * (the drain only consults it when activityMessageId == null).
 *
 * Lever 5 base case (the triplication fix): a narrative-SHOW producer alone on
 * a 0-tool turn must NOT open a card. A tool label DOES open. The liveness
 * timer (genuine ≥12s thinking-gap) still opens a 0-tool card.
 *
 * Lever 1 (reply-is-last): once a SUBSTANTIVE final answer has been delivered
 * (the sticky finalAnswerEverDelivered latch), no card may open below it — for
 * ANY producer. The latch is NOT the mutable finalAnswerDelivered (reopen
 * clears that mid-turn, #2141); an ack does not set it, so the ack-then-work
 * feed still opens.
 */
describe('mayOpenActivityCard — lever 5 base case (narrative-SHOW alone must not OPEN)', () => {
  it('narrative SHOW on a 0-tool turn does NOT open a card (the triplication)', () => {
    expect(
      mayOpenActivityCard({
        producer: 'narrative',
        finalAnswerEverDelivered: false,
        labeledToolCount: 0,
      }),
    ).toBe(false)
  })

  it('a tool label DOES open a card (producer B)', () => {
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
      }),
    ).toBe(true)
  })

  it('the liveness timer DOES open a 0-tool thinking-gap card (producer C, preserved)', () => {
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
