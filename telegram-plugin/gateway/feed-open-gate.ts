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
 * ## Lever 5 — INERT (pre-answer narrative OPEN now permitted, #2588)
 *
 * Lever 5 was added in #2557 to prevent a "triplication" reorder: a 0-tool
 * conversational turn would open a card (message_id N), then the reply would
 * send (message_id N+1) ABOVE the card, and then a Stop-hook re-prompt caused
 * a second card below. The fix over-suppressed: it killed the card entirely
 * rather than fixing the G2/G3 half of the triplication.
 *
 * **Lever 2 (`clearActivitySummary`) already owns reply-is-last ordering:** it
 * edits the narrative card IN-PLACE before the reply chunks send, keeping its
 * lower message_id and guaranteeing the reply lands above it — no reorder.
 * Lever 5's open-suppression is therefore redundant and harms visibility:
 * a pre-answer narrative on a 0-tool turn (the agent thinking aloud before
 * dispatching tools) is exactly the kind of step operators want to see.
 *
 * Lever 5 is now INERT for the pre-answer case. Post-answer is already blocked
 * by Lever 1 (`finalAnswerEverDelivered`), so Lever 5 was unreachable there
 * anyway. The `labeledToolCount` field remains in `FeedOpenInput` — it is still
 * used by R4 (a turn that starts conversational then dispatches a tool opens on
 * the first label) and by tests.
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

/**
 * Inputs for the liveness early-open WHEN-decision (`shouldEarlyOpenLiveness`).
 * Separate from the OPEN-gate levers above: those answer *may* a card open at
 * all (reply-is-last / cross-turn); this answers *is it time yet* for the
 * minimal "Working…" placeholder on a 0-label turn. Both must say yes — the
 * caller routes the actual open through `mayOpenActivityCard` after this clears.
 */
export interface EarlyLivenessOpenInput {
  /** Feature flag (`SWITCHROOM_FEED_LIVENESS_OPEN`). Off ⇒ never early-open. */
  enabled: boolean
  /** Turn age in ms (`now - turn.startedAt`). Must be ≥ `thresholdMs`. */
  ageMs: number
  /** The early-open threshold (`FEED_LIVENESS_OPEN_MS`). */
  thresholdMs: number
  /** Count of surfaced tool steps this turn (`turn.mirrorLines.length`). >0 ⇒ a
   *  real label already drives the labelled-feed heartbeat; the placeholder must
   *  not fight it, so it never opens (unless `forceNarrative` — see below). */
  mirrorLineCount: number
  /** Single in-place card transport id. Non-null ⇒ a card is already OPEN, so
   *  this is a maintain/no-op, not a fresh OPEN. */
  activityMessageId: number | null
  /** The session chat id. `null` ⇒ no surface to open on. */
  sessionChatId: string | null
}

/**
 * Pure: is the minimal "Working…" liveness placeholder due to OPEN for a 0-label
 * turn? True iff the feature is on, the turn has a target chat, it has been alive
 * past the threshold, and NO card is already open. Once `mirrorLineCount > 0` a
 * real tool label drives the feed, EXCEPT the edge where narration staged
 * `mirrorLines` but no card opened yet (`activityMessageId == null`) — there the
 * accumulated narration should still render on the early open, so it is allowed.
 *
 * This is the WHEN gate. The caller still routes the OPEN through
 * `mayOpenActivityCard` (lever 1/4) so a card never opens below a delivered
 * answer or on a cross-turn synthetic surface. Two callers consult this — the
 * enqueue-time early-open timer and the 6 s heartbeat — and because an already-
 * open card returns false here (and the drain EDITs rather than re-OPENs), they
 * can never double-open.
 */
export function shouldEarlyOpenLiveness(input: EarlyLivenessOpenInput): boolean {
  if (!input.enabled) return false
  if (input.sessionChatId == null) return false
  // A card is already open → maintain via the drain's EDIT path, not a fresh
  // OPEN. Never double-open. (Reaching past here implies `activityMessageId ==
  // null`, so a non-zero `mirrorLineCount` is the "narration staged but no card
  // opened yet" edge — allowed below so the accumulated narration renders.)
  if (input.activityMessageId != null) return false
  if (input.ageMs < input.thresholdMs) return false
  return true
}

/** Which producer triggered this drain — determines lever-5 OPEN eligibility. */
export type FeedOpenProducer =
  /** Narrative SHOW (producer A): plain assistant text, no tool, no time
   *  threshold. Pre-answer it is OPEN-eligible (lever 5 INERT); after a
   *  substantive final answer it is blocked by lever 1. */
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
  /**
   * Fix 2 (post-answer background-agent liveness, #2587 supersede): true when
   * the sub-agent/workflow watcher has produced a NEW activity step AFTER the
   * substantive final answer was delivered. This signal is updated by the watcher
   * callback INDEPENDENTLY of the tool_label path, so the drop-guard
   * (`shouldReopenFeedAfterAck` / `turn.finalAnswerSubstantive`) does NOT gate it.
   *
   * When true AND `producer === 'tool'`, Lever 1's blanket post-answer block is
   * lifted: a liveness card surfaces below the reply to show "background agent
   * still working". Idle producers (`liveness`, `narrative`) remain blocked after
   * the final answer — the reply-is-last invariant is preserved for idle gaps.
   * Only the `feedHeartbeatTick` post-answer branch sets this; it reads
   * `turn.subagentActivityAt > (turn.finalAnswerDeliveredAt ?? 0)` (a tool-label
   * rendered genuinely after the answer) rather than the frozen `lastToolLabelAt`.
   *
   * Defaults to `false` (Lever 1 stays fully active) — callers that don't pass
   * this see no behaviour change.
   */
  postAnswerSubagentActivity?: boolean
  /**
   * Post-substantive feed reopen (long multi-phase MAIN-agent turns). True when
   * the turn delivered a substantive final answer EARLY and then kept doing real
   * tool work — `>= SUBSTANTIVE_REOPEN_MIN_LABELS` post-answer tool labels have
   * arrived (`feed-reopen-gate.ts` → `decideFeedReopen().liftLeverOne`). The
   * sibling of `postAnswerSubagentActivity`, but for the foreground agent's own
   * post-answer tool labels rather than a sub-agent watcher.
   *
   * When true AND `producer === 'tool'`, Lever 1's blanket post-answer block is
   * lifted so a fresh activity card may open below the delivered reply to show
   * the still-working agent. Idle producers (`liveness`, `narrative`) stay
   * blocked. Defaults to `false` (Lever 1 fully active) — callers that don't
   * pass it see no behaviour change.
   */
  postAnswerMainActivity?: boolean
}

/**
 * Pure. Given the drain is about to OPEN a fresh card, returns true when the
 * OPEN is allowed. An EDIT (caller has a non-null `activityMessageId`) does NOT
 * consult this — only the OPEN branch does.
 *
 *  - crossTurnAnswerDelivered → false: lever 4. A cross-turn synthetic surface
 *    whose exchange already delivered a substantive answer in an EARLIER turn;
 *    no card may open below it (any producer). Checked FIRST.
 *  - finalAnswerEverDelivered && !(postAnswerSubagentActivity ||
 *    postAnswerMainActivity) → false: lever 1. A substantive final already
 *    landed THIS turn; no card may open below it. Exception: when EITHER
 *    post-answer activity signal is true AND `producer === 'tool'`, Lever 1 is
 *    lifted so a card can surface below the reply — the background-agent
 *    liveness heartbeat (`postAnswerSubagentActivity`) OR the foreground
 *    agent's own still-working post-answer tool labels (`postAnswerMainActivity`,
 *    the post-substantive feed reopen). Idle producers ('liveness', 'narrative')
 *    stay blocked — no card opens from wall-clock alone after the final answer.
 *  - producer 'narrative': always allowed when pre-answer (lever 5 is INERT —
 *    Lever 2 / clearActivitySummary guarantees reply-is-last ordering instead).
 *  - producer 'tool' or 'liveness' → true (unless lever 1/4).
 */
export function mayOpenActivityCard(input: FeedOpenInput): boolean {
  // Lever 4 — cross-turn: nothing opens on a synthetic represent/owed-reply
  // surface whose exchange already delivered a substantive answer in an earlier
  // turn (race C/D). Checked FIRST, above lever 1, and scoped to cross-turn
  // synthetic surfaces by the caller so it can never fire on a foreground turn.
  if (input.crossTurnAnswerDelivered) return false
  // Lever 1 — sticky: nothing opens after a substantive final answer, EXCEPT
  // when genuine post-answer sub-agent/watcher activity warrants a liveness card
  // (Fix 2 / #2587 supersede). Only 'tool' is exempted so idle liveness and
  // narrative producers remain blocked after the final answer.
  if (input.finalAnswerEverDelivered) {
    if (
      (input.postAnswerSubagentActivity || input.postAnswerMainActivity)
      && input.producer === 'tool'
    ) return true
    return false
  }
  // Lever 5 — INERT (see module comment above). Pre-answer narrative may now
  // open a card; Lever 2 (clearActivitySummary) handles reply-is-last ordering.
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
