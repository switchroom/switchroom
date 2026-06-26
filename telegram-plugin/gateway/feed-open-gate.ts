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
 *
 * ## Lever 4 — no card OPEN below an EARLIER turn's answer (§9 lever 4, race C/D)
 *
 * The CROSS-turn case. Lever 1's `finalAnswerEverDelivered` latch is PER-TURN —
 * it is reset to `false` at every turn ctor (mirroring `activityEverOpened`). So
 * a SYNTHETIC turn born from a cross-turn surface — the `obligation_represent`
 * re-delivery (`obligationSweep`, race D) or the liveness/heartbeat timer firing
 * on it — starts with a cleared latch EVEN WHEN a substantive answer already
 * reached the user in an EARLIER turn of this exchange. Its first drain would
 * then OPEN a "thinking…" card BELOW that already-delivered reply (higher
 * message_id → reorders, breaking the scoped "reply is last" invariant §6 across
 * the turn boundary). This is the cousin of the §5 represent-duplicate bug, at
 * the card layer instead of the message layer.
 *
 * Lever 4 closes it with a cross-turn signal the CALLER computes and passes in:
 * `crossTurnAnswerDelivered` is true iff (a) this is a cross-turn synthetic
 * surface (a represent / owed-reply turn — NOT the foreground turn's own card)
 * AND (b) a SUBSTANTIVE (≥`FINAL_ANSWER_MIN_CHARS`) outbound reply has already
 * been delivered to this chat SINCE THE OBLIGATION/TIMER WAS RAISED — checked via
 * the SAME `hasOutboundDeliveredSince` history predicate the represent guard uses
 * (`represent-guard.ts`), not a parallel mechanism. When true, NO producer may
 * OPEN a card; edits of an already-open id are still allowed. Checked FIRST.
 *
 * Three deliberate scoping properties keep it from over-firing:
 *   - SCOPED to synthetic cross-turn surfaces by the caller (a normal foreground
 *     turn passes `false`), so it can never suppress the foreground turn's card.
 *   - Keys on SUBSTANTIVE delivery (the 200-char proxy), never on an ack — so it
 *     does NOT regress #2141: an ack-then-work turn has no substantive row and
 *     its feed still opens.
 *   - Does NOT touch the represent SEND itself — only the decorative card. A
 *     genuinely-unanswered obligation is STILL re-asked (the represent guard, not
 *     this gate, owns suppressing an already-satisfied represent). This gate only
 *     suppresses the card that would otherwise narrate beneath an answer the user
 *     already received.
 */

/** Which producer triggered this drain — determines lever-5 OPEN eligibility. */
export type FeedOpenProducer =
  /** Narrative SHOW (producer A): plain assistant text, no tool, no time
   *  threshold. May only EDIT, never OPEN, while the turn has 0 tool labels. */
  | 'narrative'
  /** Tool label (producer B): the model dispatched a tool. OPEN-eligible unless a
   *  substantive final already landed (lever 1).
   *  Foreground sub-agent renders (a Task tool) are tool work too → 'tool'. */
  | 'tool'
  /** Liveness timer (producer C): a genuine ≥12s thinking-gap open, or the
   *  labelled-feed heartbeat maintaining an open card. OPEN-eligible unless a
   *  substantive final already landed (lever 1). */
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
  /** Lever 4 (cross-turn / race C/D). True iff this is a cross-turn SYNTHETIC
   *  surface (an `obligation_represent` / owed-reply turn, or the liveness timer
   *  firing on it) AND a SUBSTANTIVE reply has already been delivered to this
   *  chat since the obligation/timer was raised — computed by the caller via the
   *  reused `hasOutboundDeliveredSince` history predicate with the obligation's
   *  `openedAt` cutoff. When true, no producer may OPEN a card (it would land
   *  below the earlier reply). A normal foreground turn passes `false` (or omits
   *  it), so lever 4 is inert there. Defaults to `false`. */
  crossTurnAnswerDelivered?: boolean
  /** Post-answer real activity exception (restore #2547 visibility under
   *  determinism gate). When true AND `producer === 'tool'`, lever 1's blanket
   *  OPEN-block is lifted: genuine new sub-agent/tool activity detected AFTER
   *  the answer (via `lastToolLabelAt > finalAnswerDeliveredAt`) is allowed to
   *  OPEN a card below the prior reply. Idle thinking-gaps (no new
   *  `lastToolLabelAt` advance) never set this, so the suppression of
   *  idle-liveness-after-final is preserved. Defaults to `false`. */
  postAnswerRealActivity?: boolean
}

/**
 * Pure. Given the drain is about to OPEN a fresh card, returns true when the
 * OPEN is allowed. An EDIT (caller has a non-null `activityMessageId`) does NOT
 * consult this — only the OPEN branch does.
 *
 *  - crossTurnAnswerDelivered → false: lever 4. A cross-turn synthetic surface
 *    whose exchange already delivered a substantive answer in an EARLIER turn;
 *    no card may open below it (any producer). Checked FIRST.
 *  - finalAnswerEverDelivered → false: lever 1. A substantive final already
 *    landed THIS turn; no card may open below it (any producer).
 *    EXCEPTION: when `postAnswerRealActivity` is true AND `producer === 'tool'`,
 *    lever 1 is lifted — genuine new sub-agent/tool work detected after the
 *    answer is allowed to OPEN a card below the prior reply (restores #2547
 *    visibility). Idle liveness (`producer !== 'tool'` or no `lastToolLabelAt`
 *    advance) still cannot open after a final — idle-gap suppression preserved.
 *  - producer 'narrative' && labeledToolCount === 0 → false: lever 5 base case.
 *    Narration alone on a 0-tool turn may not open a card (the triplication).
 *  - producer 'tool' → true (unless lever 1/4): a real tool dispatched → open.
 *  - producer 'liveness' → true (unless lever 1/4): the genuine thinking-gap open
 *    (producer C) is untouched by lever 5.
 */
export function mayOpenActivityCard(input: FeedOpenInput): boolean {
  // Lever 4 — cross-turn: nothing opens on a synthetic represent/owed-reply
  // surface whose exchange already delivered a substantive answer in an earlier
  // turn (race C/D). Checked FIRST, above lever 1, and scoped to cross-turn
  // synthetic surfaces by the caller so it can never fire on a foreground turn.
  if (input.crossTurnAnswerDelivered) return false
  // Lever 1 — sticky: nothing opens after a substantive final answer.
  // EXCEPTION: genuine post-answer real tool activity (sub-agent/background
  // work that actually dispatched a new tool AFTER the answer) may open a card
  // below the reply — restoring #2547 visibility under the #2564 gate. The
  // caller sets `postAnswerRealActivity` only when `lastToolLabelAt` has
  // advanced past `finalAnswerDeliveredAt`, so idle thinking-gaps after the
  // answer continue to be suppressed (idle-gap suppression preserved).
  if (input.finalAnswerEverDelivered) {
    if (!(input.postAnswerRealActivity === true && input.producer === 'tool')) return false
  }
  // Lever 5 base case — narrative SHOW alone on a 0-tool turn may not OPEN.
  if (input.producer === 'narrative' && input.labeledToolCount === 0) return false
  return true
}

/**
 * Injected dependencies for the lever-4 cross-turn history check (PR-4b).
 *
 * Passed in EXPLICITLY so `feed-open-gate.ts` stays sqlite-free — it does NOT
 * import `history.js`, so the module (and its vitest suite) never transitively
 * pulls in `bun:sqlite`. The gateway centralizes the wiring (the real
 * `hasOutboundDeliveredSince` predicate + `HISTORY_ENABLED` + the substantive
 * `FINAL_ANSWER_MIN_CHARS` floor) in one place (`emissionAuthorityFor`); tests
 * inject the real history harness (`cross-turn-card-gate.test.ts`) or a stub.
 */
export interface FeedOpenGateDeps {
  /** The represent-guard's delivered-since predicate (`history.ts`). Returns
   *  true iff a ≥`minChars` outbound landed in `chatId`/`threadId` since
   *  `sinceMs`. Injected so this module never imports `history.js`. */
  hasOutboundDeliveredSince: (
    chatId: string,
    sinceMs: number,
    threadId: number | null | undefined,
    minChars: number,
  ) => boolean
  /** Whether history is enabled (the gateway's `HISTORY_ENABLED`). When false,
   *  the cross-turn check short-circuits to false — exactly as the drain does. */
  historyEnabled: boolean
  /** The substantive 200-char floor (`FINAL_ANSWER_MIN_CHARS`) — an ack never
   *  trips lever 4 (keeps #2141 green). */
  finalAnswerMinChars: number
}

/**
 * The per-turn surface the OPEN verdict reads. A structural subset of
 * `CurrentTurn` — kept SEPARATE from the façade's minimal `EmissionTurnView`
 * (which is scoped to the single-flight `activityInFlight` read) so neither
 * leaks the other's concern. Mirrors the exact fields the drain's inline
 * cross-turn computation + `mayOpenActivityCard` consult.
 */
export interface FeedOpenGateView {
  /** Single in-place card transport id. `null` ⇒ the next drain would OPEN a
   *  fresh card; non-null ⇒ an EDIT (never gated). */
  activityMessageId: number | null
  /** Sticky lever-1 latch (per-turn). */
  finalAnswerEverDelivered: boolean
  /** Surfaced tool steps this turn (lever-5 base case). */
  labeledToolCount: number
  /** Present ONLY on a cross-turn synthetic surface (represent / owed-reply).
   *  Carries the obligation's `openedAt` as the delivered-since cutoff. A
   *  foreground turn omits it, so lever 4 is inert there. */
  crossTurnGate?: { sinceMs: number }
  /** Chat the card targets (null ⇒ no history query). */
  sessionChatId: string | null
  /** Forum-topic thread, if any (scopes the delivered-since check). */
  sessionThreadId?: number | null
}

/**
 * Lever-4 cross-turn predicate — PURE, lifted VERBATIM from the inline
 * computation `drainActivitySummary` ran in main (the OPEN branch). True iff
 * this drain is about to OPEN a fresh card (`activityMessageId == null`) on a
 * cross-turn synthetic surface (`crossTurnGate != null`) whose exchange already
 * delivered a SUBSTANTIVE reply since the obligation was raised. Identical
 * inputs ⇒ identical result to the drain's own (now-redundant) gate, so flag-ON
 * and flag-OFF agree by construction.
 */
export function computeCrossTurnAnswerDelivered(
  view: FeedOpenGateView,
  deps: FeedOpenGateDeps,
): boolean {
  return (
    view.activityMessageId == null
    && view.crossTurnGate != null
    && view.sessionChatId != null
    && deps.historyEnabled
    && deps.hasOutboundDeliveredSince(
      view.sessionChatId,
      view.crossTurnGate.sinceMs,
      view.sessionThreadId,
      deps.finalAnswerMinChars,
    )
  )
}

/** The OPEN-gate verdict for a turn view + producer (PR-4b). */
export interface FeedOpenVerdict {
  /** A card is already open (`activityMessageId != null`) ⇒ this drain EDITs,
   *  which is NEVER gated. The façade applies unconditionally when `isOpen`. */
  isOpen: boolean
  /** Whether an OPEN would be allowed — the EXACT `mayOpenActivityCard(...)`
   *  result the drain computes (lever 1 + lever 4 + lever 5). When `!isOpen`
   *  and `!mayOpen`, the drain `break`s (refuses the OPEN); the façade skips
   *  `apply()`. When `isOpen`, this is consulted only by the equivalence test. */
  mayOpen: boolean
}

/**
 * Compute the OPEN-gate verdict for a turn view + producer (PR-4b). PURE: wraps
 * `mayOpenActivityCard` over `computeCrossTurnAnswerDelivered`, with history
 * deps injected. Returns BOTH `isOpen` (is a card already open → EDIT, never
 * gated) and `mayOpen` (the raw `mayOpenActivityCard` verdict).
 *
 * The façade relocates main's drain decision with this: main refuses (and
 * `break`s) iff `activityMessageId == null && !mayOpenActivityCard(...)`, i.e.
 * `!isOpen && !mayOpen`. So the façade calls `apply()` iff `isOpen || mayOpen`
 * — exactly the cases main did NOT `break`. Same pure inputs ⇒ same verdict on
 * flag-ON and flag-OFF, so no emitted message differs in either flag state.
 */
export function computeFeedOpenVerdict(
  view: FeedOpenGateView,
  producer: FeedOpenProducer,
  deps: FeedOpenGateDeps,
): FeedOpenVerdict {
  const isOpen = view.activityMessageId != null
  const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered(view, deps)
  const mayOpen = mayOpenActivityCard({
    producer,
    finalAnswerEverDelivered: view.finalAnswerEverDelivered,
    labeledToolCount: view.labeledToolCount,
    crossTurnAnswerDelivered,
  })
  return { isOpen, mayOpen }
}
