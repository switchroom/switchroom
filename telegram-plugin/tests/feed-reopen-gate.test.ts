import { describe, expect, it } from 'vitest'

import {
  decideFeedReopen,
  shouldReopenFeedAfterAck,
} from '../gateway/feed-reopen-gate.js'

/**
 * Feed-reopen-after-ack — pure decision gate.
 *
 * A supergroup agent that ACKS FIRST ("on it, checking Brevo…") then works
 * had its live activity feed go dark for the real work: the ack reply is
 * classified as the final answer by isFinalAnswerReply (it pings or is ≥200
 * chars), setting turn.finalAnswerDelivered=true, and the tool_label handler
 * then dropped every subsequent label. This predicate decides whether a tool
 * label arriving after finalAnswerDelivered (the model is still working)
 * should RE-OPEN the feed.
 */
describe('shouldReopenFeedAfterAck', () => {
  it('reopens when finalAnswerDelivered AND enabled (the ack-first fix)', () => {
    expect(
      shouldReopenFeedAfterAck({ finalAnswerDelivered: true, enabled: true }),
    ).toBe(true)
  })

  it('does NOT reopen when the kill switch is off (legacy: drop the label)', () => {
    expect(
      shouldReopenFeedAfterAck({ finalAnswerDelivered: true, enabled: false }),
    ).toBe(false)
  })

  it('does NOT reopen when the final answer was never delivered (no reopen needed)', () => {
    // The feed was never gated off — the normal append/drain path applies.
    expect(
      shouldReopenFeedAfterAck({ finalAnswerDelivered: false, enabled: true }),
    ).toBe(false)
    expect(
      shouldReopenFeedAfterAck({ finalAnswerDelivered: false, enabled: false }),
    ).toBe(false)
  })
})

describe('decideFeedReopen — tool_label branch outcome for a delivered turn', () => {
  it('tool_label after finalAnswerDelivered (kill switch ON) → reset + render proceeds', () => {
    // The exact contract the gateway tool_label handler applies: the interim
    // ack is reclassified — finalAnswerDelivered back to false, a FRESH feed
    // message (activityMessageId null), last-sent render cleared so the drain
    // re-sends. dropLabel false → the handler proceeds to append + drain.
    const outcome = decideFeedReopen({
      finalAnswerDelivered: true,
      enabled: true,
    })
    expect(outcome.dropLabel).toBe(false)
    expect(outcome.reset).toEqual({
      finalAnswerDelivered: false,
      activityMessageId: null,
      activityLastSentRender: null,
    })
  })

  it('kill switch OFF → drops the label (legacy early return, feed stays dark)', () => {
    const outcome = decideFeedReopen({
      finalAnswerDelivered: true,
      enabled: false,
    })
    expect(outcome.dropLabel).toBe(true)
    expect(outcome.reset).toBeUndefined()
  })

  it('finalAnswerDelivered false → no reopen branch (handler never reaches it)', () => {
    // The handler only calls decideFeedReopen inside `if (finalAnswerDelivered)`,
    // but the predicate is total: a false flag yields dropLabel (no reset).
    const outcome = decideFeedReopen({
      finalAnswerDelivered: false,
      enabled: true,
    })
    expect(outcome.dropLabel).toBe(true)
    expect(outcome.reset).toBeUndefined()
  })
})
