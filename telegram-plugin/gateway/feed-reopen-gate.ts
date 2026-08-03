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
 * reply MIGHT have been an interim ACK — the turn has NOT delivered its
 * final answer if it is still doing tool work. So reclassify: re-open the
 * feed. The caller then resets `turn.finalAnswerDelivered = false` and
 * `turn.activityMessageId = null` (so a FRESH feed message opens below the
 * ack) and proceeds with the normal append + drain. When the model later
 * sends its REAL final answer, `executeReply` / `stream_reply` re-set
 * `finalAnswerDelivered = true` via `isFinalAnswerReply` and the feed gates
 * off correctly again.
 *
 * ## ACK-ONLY refinement
 *
 * `finalAnswerDelivered` latches true for BOTH a short pinging ack AND a
 * substantive final answer — `isFinalAnswerReply` treats any pinging reply
 * as "final". So reopening unconditionally is HARMFUL after a *genuine*
 * final answer: routine post-answer housekeeping (a memory write /
 * TodoWrite / Bash — none of these are surface tools, so they reach the
 * tool_label handler) fires a tool label → an unconditional reopen would
 * reset `finalAnswerDelivered=false` → the turn-end silent-end re-prompt
 * (`if (turn.finalAnswerDelivered === false)`, NOT gated on zero-outbound)
 * would FIRE → the agent re-delivers a DUPLICATE / garbled answer. Agents
 * routinely write memory after answering, so this would be frequent.
 *
 * The fix: reopen ONLY when the prior reply that set `finalAnswerDelivered`
 * was a SHORT ACK, not a substantive answer. The caller tracks this on the
 * turn as `finalAnswerSubstantive` (set via `isSubstantiveFinalReply` at
 * every site that sets `finalAnswerDelivered = true`). Reopen iff
 * `finalAnswerDelivered && !finalAnswerSubstantive`. When the prior final
 * was substantive, drop the label (legacy gate) — no reopen, no reset — so
 * the silent-end re-prompt and the #2137 drain both see the genuine final
 * correctly.
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
 * ## Post-SUBSTANTIVE reopen (long multi-phase turns)
 *
 * The ACK-only refinement above deliberately keeps the feed dark after a
 * GENUINE final answer — routine post-answer housekeeping (a memory write /
 * TodoWrite) should not resurrect the card. But that same gate blanks the
 * feed for a legitimately DIFFERENT shape: a turn that delivers a substantive
 * reply EARLY ("Here's the plan — starting now") and then keeps doing real
 * tool work for 10+ minutes. The user sees the reply, then goes completely
 * dark for the rest of the turn even though the agent is visibly working.
 *
 * The post-substantive reopen closes that gap WITHOUT reintroducing the
 * duplicate-answer hazard the ACK-only refinement fixed:
 *  - It fires only after `SUBSTANTIVE_REOPEN_MIN_LABELS` (>= 2) post-answer
 *    tool labels have arrived, so a genuinely-final single-reply turn (0-1
 *    housekeeping tools) never flaps the card.
 *  - Crucially it does NOT clear `finalAnswerDelivered` (the ack path does):
 *    clearing it would trip the turn-end silent-end re-prompt (`turn-end-
 *    gate.ts`: `finalAnswerDelivered === false → reprompt`) → the exact
 *    duplicate-answer failure the ACK-only guard exists to prevent. The
 *    substantive answer STAYS delivered; only the visual feed reopens.
 *  - Because the sticky lever-1 latch stays true (it is never cleared by a
 *    reopen), the caller must LIFT lever 1 for this drain so the fresh card opens
 *    BELOW the delivered reply — exactly the exemption the post-answer
 *    sub-agent liveness path already uses (`feed-open-gate.ts`,
 *    `postAnswerSubagentActivity`). The outcome flags this via `liftLeverOne`.
 *
 * Gated by its own flag `SWITCHROOM_FEED_REOPEN_AFTER_SUBSTANTIVE` (default
 * ON), passed by the caller as `reopenAfterSubstantiveEnabled`. When that flag
 * is off (or omitted), the substantive branch returns `false` exactly as
 * before — byte-identical legacy behaviour.
 *
 * ## Kill switch
 *
 * `SWITCHROOM_FEED_REOPEN_AFTER_ACK=0` reverts to the legacy behaviour: a
 * tool label after `finalAnswerDelivered` is dropped (`return`), and the
 * post-ack feed stays dark. The kill switch is read by the CALLER, which
 * passes `enabled` here.
 */

/** Number of post-substantive-answer tool labels that must arrive before the
 *  activity feed re-opens for a still-working turn. Two (not one) so a
 *  genuinely-final single-reply turn with a stray bit of post-answer
 *  housekeeping (0-1 tools) never flaps the card. */
export const SUBSTANTIVE_REOPEN_MIN_LABELS = 2

export interface FeedReopenInput {
  /** Whether the turn has already been classified as having delivered its
   *  final answer (`turn.finalAnswerDelivered`). On an ack-first turn this
   *  is set true by the ack reply (it pinged or was ≥200 chars), even
   *  though the model is still working. */
  finalAnswerDelivered: boolean
  /** Whether the reply that set `finalAnswerDelivered` was a *substantive*
   *  final answer (stream `done`, or ≥200 chars) as opposed to a short
   *  pinging interim ACK (`turn.finalAnswerSubstantive`, set via
   *  `isSubstantiveFinalReply`). Only a short ACK should re-open the feed:
   *  reopening after a genuine final answer + post-answer housekeeping
   *  would spuriously trip the silent-end re-prompt → duplicate answer. */
  finalAnswerSubstantive: boolean
  /** Kill-switch state. When false the reopen behaviour is OFF and a tool
   *  label after `finalAnswerDelivered` is dropped (legacy). */
  enabled: boolean
  /** Post-SUBSTANTIVE reopen flag (`SWITCHROOM_FEED_REOPEN_AFTER_SUBSTANTIVE`,
   *  default ON). When true, a turn that delivered a substantive final answer
   *  and then kept doing tool work may RE-OPEN the feed once
   *  `postSubstantiveToolLabelCount >= SUBSTANTIVE_REOPEN_MIN_LABELS`. Omitted
   *  / false → the substantive branch returns false exactly as before (legacy).
   *  Distinct from `enabled` (the ack-first kill switch) so the two behaviours
   *  can be toggled independently. */
  reopenAfterSubstantiveEnabled?: boolean
  /** Count of tool labels that have arrived SINCE the substantive final answer
   *  was delivered this turn (`turn.postSubstantiveToolLabelCount`). Only
   *  consulted on the substantive branch; the reopen fires at
   *  `>= SUBSTANTIVE_REOPEN_MIN_LABELS`. Omitted → treated as 0 (no reopen). */
  postSubstantiveToolLabelCount?: number
}

/**
 * Pure. Given a tool label has just arrived (the model is calling a tool,
 * so it is still working), returns true when the live activity feed should
 * be RE-OPENED for the post-ack work.
 *
 * - !finalAnswerDelivered → false: the feed was never gated off; the normal
 *   append/drain path applies (no reopen needed).
 * - finalAnswerDelivered && finalAnswerSubstantive: the prior final was a
 *   genuine answer (not an ack). Reopen ONLY under the post-substantive path —
 *   `reopenAfterSubstantiveEnabled` AND `>= SUBSTANTIVE_REOPEN_MIN_LABELS`
 *   post-answer tool labels (a still-working multi-phase turn). Otherwise keep
 *   the legacy gate so post-answer housekeeping does not flap the card and the
 *   silent-end re-prompt / #2137 drain see the delivered final correctly.
 * - finalAnswerDelivered && !enabled (kill switch off) → false: legacy
 *   behaviour, the label is dropped by the caller.
 * - finalAnswerDelivered && !finalAnswerSubstantive && enabled → true: the
 *   "final" reply was a short interim ack; re-open the feed.
 */
export function shouldReopenFeedAfterAck(input: FeedReopenInput): boolean {
  if (!input.finalAnswerDelivered) return false
  if (input.finalAnswerSubstantive) {
    // Post-substantive reopen: a genuine answer landed, then the model kept
    // doing tool work. Reopen only under the dedicated flag AND once enough
    // post-answer labels have arrived that this is plainly a still-working
    // turn, not a single-reply turn with a stray housekeeping tool.
    if (input.reopenAfterSubstantiveEnabled !== true) return false
    return (input.postSubstantiveToolLabelCount ?? 0) >= SUBSTANTIVE_REOPEN_MIN_LABELS
  }
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
   *  before the normal append/drain proceeds. Present on the ACK-reopen path
   *  (which reclassifies the interim ack). ABSENT on the post-substantive
   *  reopen path: there `finalAnswerDelivered` MUST stay true (clearing it
   *  trips the turn-end re-prompt → duplicate answer) and `activityMessageId`
   *  is already null (the substantive answer's `clearActivitySummary` nulled
   *  it), so the drain opens a fresh card then edits it — no reset needed. */
  reset?: FeedReopenState
  /** Post-substantive reopen only. True → the caller must lift lever 1 for
   *  this drain (`drainActivitySummary(..., { postAnswerMainActivity: true })`)
   *  so the fresh card may OPEN below the already-delivered substantive reply.
   *  The sticky lever-1 latch stays set, so without this lift
   *  `mayOpenActivityCard` would refuse the OPEN. Absent/false on the ack path
   *  (an ack never sets the sticky latch, so lever 1 is inert there). */
  liftLeverOne?: boolean
}

/**
 * Pure. The complete tool_label decision for a turn already marked
 * finalAnswerDelivered. Mirrors exactly what the gateway handler does:
 *  - reopen disabled / substantive final / not applicable → drop the label
 *    (legacy `return`); the genuine final answer's gate is preserved.
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
  // Post-substantive reopen: KEEP finalAnswerDelivered true (clearing it would
  // trip the turn-end silent-end re-prompt → duplicate answer) and do NOT
  // reset activityMessageId (the substantive answer's clearActivitySummary
  // already nulled it; the drain OPENs once then EDITs). Only signal the
  // caller to lift lever 1 so the fresh card may open below the reply.
  if (input.finalAnswerSubstantive) {
    return { dropLabel: false, liftLeverOne: true }
  }
  // ACK reopen (legacy): reclassify the interim ack — finalAnswerDelivered
  // back to false, a FRESH feed message (activityMessageId null), last-sent
  // render cleared so the drain re-sends.
  return {
    dropLabel: false,
    reset: {
      finalAnswerDelivered: false,
      activityMessageId: null,
      activityLastSentRender: null,
    },
  }
}
