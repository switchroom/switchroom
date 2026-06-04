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
 *
 * ACK-ONLY refinement: finalAnswerDelivered latches true for BOTH a short
 * pinging ack AND a substantive answer. Reopening after a GENUINE final
 * answer is harmful — post-answer housekeeping (memory write / TodoWrite /
 * Bash) would reset finalAnswerDelivered=false and trip the silent-end
 * re-prompt → duplicate answer. So the gate reopens ONLY when the prior
 * final was a short ack (finalAnswerSubstantive=false).
 */
describe('shouldReopenFeedAfterAck', () => {
  it('reopens when delivered AND NOT substantive AND enabled (the ack-first fix)', () => {
    expect(
      shouldReopenFeedAfterAck({
        finalAnswerDelivered: true,
        finalAnswerSubstantive: false,
        enabled: true,
      }),
    ).toBe(true)
  })

  it('does NOT reopen when the prior final was SUBSTANTIVE (the new guard)', () => {
    // A real final answer followed by post-answer housekeeping tool work:
    // keep the legacy gate (no reopen) so the silent-end re-prompt and the
    // #2137 drain see the delivered final correctly. This is the harmful
    // case the refinement closes.
    expect(
      shouldReopenFeedAfterAck({
        finalAnswerDelivered: true,
        finalAnswerSubstantive: true,
        enabled: true,
      }),
    ).toBe(false)
  })

  it('does NOT reopen when the kill switch is off (legacy: drop the label)', () => {
    expect(
      shouldReopenFeedAfterAck({
        finalAnswerDelivered: true,
        finalAnswerSubstantive: false,
        enabled: false,
      }),
    ).toBe(false)
  })

  it('does NOT reopen when the final answer was never delivered (no reopen needed)', () => {
    // The feed was never gated off — the normal append/drain path applies.
    expect(
      shouldReopenFeedAfterAck({
        finalAnswerDelivered: false,
        finalAnswerSubstantive: false,
        enabled: true,
      }),
    ).toBe(false)
    expect(
      shouldReopenFeedAfterAck({
        finalAnswerDelivered: false,
        finalAnswerSubstantive: false,
        enabled: false,
      }),
    ).toBe(false)
  })
})

describe('decideFeedReopen — tool_label branch outcome for a delivered turn', () => {
  it('tool_label after a SHORT ACK (not substantive, kill switch ON) → reset + render proceeds', () => {
    // The exact contract the gateway tool_label handler applies: the interim
    // ack is reclassified — finalAnswerDelivered back to false, a FRESH feed
    // message (activityMessageId null), last-sent render cleared so the drain
    // re-sends. dropLabel false → the handler proceeds to append + drain.
    const outcome = decideFeedReopen({
      finalAnswerDelivered: true,
      finalAnswerSubstantive: false,
      enabled: true,
    })
    expect(outcome.dropLabel).toBe(false)
    expect(outcome.reset).toEqual({
      finalAnswerDelivered: false,
      activityMessageId: null,
      activityLastSentRender: null,
    })
  })

  it('tool_label after a SUBSTANTIVE final → drops the label (the new guard, feed stays gated)', () => {
    // Genuine final answer + post-answer housekeeping: NO reopen, NO reset.
    // finalAnswerDelivered stays true so the silent-end re-prompt does not
    // fire and the #2137 drain proceeds correctly.
    const outcome = decideFeedReopen({
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
      enabled: true,
    })
    expect(outcome.dropLabel).toBe(true)
    expect(outcome.reset).toBeUndefined()
  })

  it('kill switch OFF → drops the label (legacy early return, feed stays dark)', () => {
    const outcome = decideFeedReopen({
      finalAnswerDelivered: true,
      finalAnswerSubstantive: false,
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
      finalAnswerSubstantive: false,
      enabled: true,
    })
    expect(outcome.dropLabel).toBe(true)
    expect(outcome.reset).toBeUndefined()
  })
})
