/**
 * Feed-OPEN gate (deterministic activity-card OPEN gating).
 *
 * Pure decision: the activity-card drain (`drainActivitySummary`) is about to
 * OPEN a brand-new card (`activityMessageId == null` → a fresh `sendMessage`).
 * Should it be allowed to? This module encodes the two OPEN-suppression levers
 * from `docs/message-emission-determinism.md` §9, so the gateway has ONE place
 * to reason about WHEN a card may first appear on screen.
 *
 * Only the OPEN (first `sendMessage`) is gated. An EDIT of an already-open card
 * (`activityMessageId != null`) is never blocked — once a card exists it must
 * keep rendering, and an edit never reorders on screen.
 *
 * ## Lever 1 — no card OPEN after a substantive final (§9 lever 1, race A/B/E)
 *
 * Once a *substantive* final answer has been delivered this turn, no new card
 * may open — it would land below the reply (higher message_id) and break the
 * scoped "reply is last" invariant (§6). This keys on the STICKY
 * `finalAnswerEverDelivered` latch, NOT the mutable `finalAnswerDelivered`
 * (which the ack-reopen path clears mid-turn, `feed-reopen-gate.ts:157`). Keying
 * on the mutable flag would be a no-op on exactly the ack-first turn where the
 * reorder originates (design §9 preamble / R0). The sticky latch is set once a
 * substantive final lands and is never cleared by reopen — so an "On it…" ack
 * (non-substantive) does NOT trip it and the #2141 ack-then-work feed still
 * opens.
 *
 * ## Lever 5 base case — narrative-SHOW alone must not OPEN (§9 lever 5, G1)
 *
 * The triplication: a 0-tool conversational turn opened a full card from
 * narration text alone. Rule: the narrative-SHOW producer (A) may only EDIT an
 * already-open card, never OPEN one. Only a tool label (producer B) or the
 * liveness timer (producer C, a genuine ≥12s thinking-gap) may OPEN a card.
 *
 * So a narrative-SHOW-triggered OPEN is refused while the turn has surfaced ZERO
 * tool labels (`labeledToolCount === 0`). Once a tool label arrives
 * (`labeledToolCount > 0`) the card opens and the accumulated narration renders;
 * a turn that starts conversational then dispatches a tool DOES open (R4). The
 * liveness path (producer C) is exempt — it owns the genuine thinking-gap open.
 */

/** Which producer triggered this drain — determines lever-5 OPEN eligibility. */
export type FeedOpenProducer =
  /** Narrative SHOW (producer A): plain assistant text, no tool, no time
   *  threshold. May only EDIT, never OPEN, while the turn has 0 tool labels. */
  | 'narrative'
  /** Tool label (producer B): the model dispatched a tool. Always OPEN-eligible.
   *  Foreground sub-agent renders (a Task tool) are tool work too → 'tool'. */
  | 'tool'
  /** Liveness timer (producer C): a genuine ≥12s thinking-gap open, or the
   *  labelled-feed heartbeat maintaining an open card. Always OPEN-eligible. */
  | 'liveness'

export interface FeedOpenInput {
  /** Which producer triggered the drain (see FeedOpenProducer). */
  producer: FeedOpenProducer
  /** Sticky latch: has a *substantive* final answer ever been delivered this
   *  turn? Set once and never cleared by reopen (lever 1 / R0). */
  finalAnswerEverDelivered: boolean
  /** Count of surfaced tool steps this turn (`turn.labeledToolCount`). 0 means
   *  no tool has ever produced a label — pure conversation / thinking. */
  labeledToolCount: number
}

/**
 * Pure. Given the drain is about to OPEN a fresh card, returns true when the
 * OPEN is allowed. An EDIT (caller has a non-null `activityMessageId`) does NOT
 * consult this — only the OPEN branch does.
 *
 *  - finalAnswerEverDelivered → false: lever 1. A substantive final already
 *    landed; no card may open below it (any producer).
 *  - producer 'narrative' && labeledToolCount === 0 → false: lever 5 base case.
 *    Narration alone on a 0-tool turn may not open a card (the triplication).
 *  - producer 'tool' → true (unless lever 1): a real tool dispatched → open.
 *  - producer 'liveness' → true (unless lever 1): the genuine thinking-gap open
 *    (producer C) is untouched by lever 5.
 */
export function mayOpenActivityCard(input: FeedOpenInput): boolean {
  // Lever 1 — sticky: nothing opens after a substantive final answer.
  if (input.finalAnswerEverDelivered) return false
  // Lever 5 base case — narrative SHOW alone on a 0-tool turn may not OPEN.
  if (input.producer === 'narrative' && input.labeledToolCount === 0) return false
  return true
}
