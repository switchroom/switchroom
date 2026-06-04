/**
 * Feed-reopen-after-ack gate (ack-first live-activity visibility).
 *
 * Pure decision: a `tool_label` arrived (the model is calling a tool, i.e.
 * still WORKING) for a turn that has already been classified as having
 * delivered its final answer. Should the gateway *re-open* the live
 * activity feed for the post-ack work?
 *
 * ## The bug this closes
 *
 * In a forum supergroup one agent owns the whole supergroup — a single
 * sequential `claude` CLI with a singleton `currentTurn`. When the model
 * ACKS FIRST ("on it, checking Brevo…") and then does the actual work,
 * that ack reply is classified as the *final answer* by
 * `isFinalAnswerReply` (final-answer-detect.ts) whenever it pings
 * (`!disable_notification`) OR is ≥200 chars — both common for a natural
 * human-feel ack. That sets `turn.finalAnswerDelivered = true`, and the
 * `tool_label` handler's `if (turn.finalAnswerDelivered) return` then
 * drops EVERY subsequent tool label → the live feed goes dark for the
 * real work. The agent looks silent after "On it".
 *
 * ## The decision
 *
 * A new tool label after `finalAnswerDelivered` means the earlier "final"
 * reply was actually an interim ACK — the turn has NOT delivered its final
 * answer if it is still doing tool work. So reclassify: re-open the feed.
 * The caller then resets `turn.finalAnswerDelivered = false` and
 * `turn.activityMessageId = null` (so a FRESH feed message opens below the
 * ack) and proceeds with the normal append + drain. When the model later
 * sends its REAL final answer, `executeReply` / `stream_reply` re-set
 * `finalAnswerDelivered = true` via `isFinalAnswerReply` and the feed gates
 * off correctly again.
 *
 * ## Interactions (the reset is correct for all three consumers)
 *
 *  1. #2137 deliver-before-drain gate (`mayDrainBufferedInbound`): reads the
 *     ending turn's `finalAnswerDelivered` at turn-end. With the reset, an
 *     ack-first turn that is still working keeps it false → the next topic
 *     is correctly HELD (no mid-work cross-topic bleed); the bounded
 *     no-reply drain timer (~2.5s) still releases the queue if the turn
 *     truly ends without a final answer.
 *  2. silent-end re-prompt: a turn that acks, works, then ends with NO real
 *     final answer keeps `finalAnswerDelivered=false` → the re-prompt fires
 *     (correct — the user got only an ack, no answer).
 *  3. the feed gate itself — this module.
 *
 * ## Kill switch
 *
 * `SWITCHROOM_FEED_REOPEN_AFTER_ACK=0` reverts to the legacy behaviour: a
 * tool label after `finalAnswerDelivered` is dropped (`return`), and the
 * post-ack feed stays dark. The kill switch is read by the CALLER, which
 * passes `enabled` here.
 */

export interface FeedReopenInput {
  /** Whether the turn has already been classified as having delivered its
   *  final answer (`turn.finalAnswerDelivered`). On an ack-first turn this
   *  is set true by the ack reply (it pinged or was ≥200 chars), even
   *  though the model is still working. */
  finalAnswerDelivered: boolean
  /** Kill-switch state. When false the reopen behaviour is OFF and a tool
   *  label after `finalAnswerDelivered` is dropped (legacy). */
  enabled: boolean
}

/**
 * Pure. Given a tool label has just arrived (the model is calling a tool,
 * so it is still working), returns true when the live activity feed should
 * be RE-OPENED for the post-ack work.
 *
 * - !finalAnswerDelivered → false: the feed was never gated off; the normal
 *   append/drain path applies (no reopen needed).
 * - finalAnswerDelivered && !enabled (kill switch off) → false: legacy
 *   behaviour, the label is dropped by the caller.
 * - finalAnswerDelivered && enabled → true: the "final" reply was an
 *   interim ack; re-open the feed.
 */
export function shouldReopenFeedAfterAck(input: FeedReopenInput): boolean {
  if (!input.finalAnswerDelivered) return false
  return input.enabled === true
}

/** The feed-state fields the caller mutates on reopen. */
export interface FeedReopenState {
  finalAnswerDelivered: boolean
  activityMessageId: number | null
  activityLastSentRender: string | null
}

/** The branch outcome the tool_label handler takes for a finalAnswer-
 *  delivered turn: either drop the label (legacy `return`) or reopen the
 *  feed with the given reset state. */
export interface FeedReopenOutcome {
  /** True → the handler returns early (legacy: label dropped, feed dark). */
  dropLabel: boolean
  /** When dropLabel is false, the new feed-state fields to write on `turn`
   *  before the normal append/drain proceeds. */
  reset?: FeedReopenState
}

/**
 * Pure. The complete tool_label decision for a turn already marked
 * finalAnswerDelivered. Mirrors exactly what the gateway handler does:
 *  - reopen disabled / not applicable → drop the label (legacy `return`).
 *  - reopen → reclassify the interim ack: finalAnswerDelivered back to
 *    false (the turn has NOT delivered its final answer while still doing
 *    tool work), activityMessageId cleared so a FRESH feed message opens
 *    below the ack, and activityLastSentRender cleared so the drain loop's
 *    `pending !== lastSent` guard never mistakes the fresh render for an
 *    already-sent one.
 *
 * Returning the deltas (rather than mutating) keeps the decision unit-
 * testable; the handler applies them to the live `turn` atom.
 */
export function decideFeedReopen(input: FeedReopenInput): FeedReopenOutcome {
  if (!shouldReopenFeedAfterAck(input)) {
    return { dropLabel: true }
  }
  return {
    dropLabel: false,
    reset: {
      finalAnswerDelivered: false,
      activityMessageId: null,
      activityLastSentRender: null,
    },
  }
}
