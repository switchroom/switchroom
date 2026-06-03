/**
 * Serialize-until-replied buffer-drain gate (multitopic reply-routing).
 *
 * Pure decision: when a turn ends and a cross-topic inbound is sitting in
 * `pendingInboundBuffer`, may the gateway drain (re-deliver) that buffered
 * inbound *right now*?
 *
 * ## The bug this closes
 *
 * In a forum supergroup one agent owns the whole supergroup — a single
 * sequential `claude` CLI with a singleton `currentTurn`. Two questions in
 * two topics (Brevo=thread 4, then Meta=thread 3) were both answered into
 * Meta. Root cause #1 of two coupled defects:
 *
 *   The buffer drain (`redeliverBufferedInbound`, fired from
 *   `purgeReactionTracking` and `releaseTurnBufferGate`) ran whenever
 *   `!turnInFlightForGate()` — i.e. on the bare turn-end signal —
 *   REGARDLESS of whether the turn that just ended had actually delivered
 *   its reply. When the Brevo turn emitted its turn-end event BEFORE its
 *   late reply landed (~42s later), the buffered Meta message drained
 *   immediately and started the Meta turn. By the time the Brevo reply
 *   executed, `currentTurn` had flipped to Meta and the reply routed to
 *   Meta's thread (defect #2, fixed separately by turn-origin routing).
 *
 * ## The guarantee
 *
 * A buffered cross-topic inbound drains only after the just-ended turn
 * delivered its reply to its OWN thread. Concretely: Brevo's buffered-Meta
 * drain waits until Brevo's reply lands in thread 4. Because the canonical
 * reply path (`executeReply`) sets `finalAnswerDelivered = true` and then
 * calls `releaseTurnBufferGate`, the drain now happens FROM the reply, not
 * from the bare turn_end.
 *
 * ## Liveness — the no-reply case is NOT handled here
 *
 * A turn that legitimately ends with NO reply (greeting already handled,
 * handback ack, NO_REPLY / HEARTBEAT_OK marker, silent-end) has
 * `finalAnswerDelivered === false` and would block the drain FOREVER under
 * this predicate. That is intentional: liveness for the no-reply case is
 * restored by a *separate* bounded escape-hatch timer in
 * `endCurrentTurnAtomic` (`SWITCHROOM_SERIALIZE_NOREPLY_DRAIN_MS`), plus
 * the existing 300s silence-poke unwedge fallback as the long-stop. This
 * predicate stays pure and total — it never reasons about timers.
 *
 * ## Kill switch
 *
 * `SWITCHROOM_SERIALIZE_UNTIL_REPLIED=0` reverts to legacy behaviour
 * (drain on bare turn-end). The kill switch is read by the CALLER, which
 * passes `enabled` here; when disabled the predicate degenerates to the
 * old `!turnInFlight` check.
 */

export interface DrainGateInput {
  /** A turn is in flight RIGHT NOW (`turnInFlightForGate()`), evaluated at
   *  the drain site. When true, never drain — claude is busy. */
  turnInFlight: boolean
  /** Whether the ending turn delivered its final answer. Read from the
   *  ending turn's `finalAnswerDelivered`. `undefined` / `null` means
   *  there is no ending turn handle at this drain site (sibling-key purge,
   *  restart-init cleanup, idle sweep) — treated as "no turn to wait on",
   *  so the gate doesn't block. */
  endingTurnFinalAnswerDelivered?: boolean | null
  /** Kill-switch state. When false the serialize-until-replied behaviour
   *  is OFF and the gate reduces to `!turnInFlight` (legacy). */
  enabled: boolean
}

/**
 * Pure. Returns true when the buffered inbound may be drained now.
 *
 * - turnInFlight → always false (claude is busy; never drain mid-turn).
 * - !enabled (kill switch off) → drain whenever idle (legacy behaviour).
 * - no ending-turn handle (undefined/null) → drain (nothing to wait on).
 * - ending turn delivered its final answer → drain.
 * - ending turn ended WITHOUT a final answer → do NOT drain here; the
 *   bounded no-reply escape hatch (separate timer) releases it.
 */
export function mayDrainBufferedInbound(input: DrainGateInput): boolean {
  if (input.turnInFlight) return false
  if (!input.enabled) return true
  const delivered = input.endingTurnFinalAnswerDelivered
  if (delivered == null) return true
  return delivered === true
}

export interface NoReplyDrainArmInput {
  /** Kill-switch state. Off → never arm (legacy behaviour drains on the
   *  bare turn-end, so there is nothing to rescue). */
  enabled: boolean
  /** Whether the just-ended turn delivered its final answer. A delivered
   *  turn already drained via the serialize gate — no rescue needed. */
  finalAnswerDelivered: boolean
  /** Number of inbounds sitting in the pending-inbound buffer for this
   *  agent. Only arm when something is actually waiting. */
  bufferedDepth: number
}

/**
 * Component 2 — should the bounded no-reply drain timer be armed when a
 * turn ends? Pure mirror of the guard inside `armNoReplyDrainTimer`. THIS
 * is the liveness guarantee in predicate form: a turn that ends with NO
 * reply (finalAnswerDelivered=false) AND a buffered inbound waiting must
 * arm the bounded force-drain so the queue can never wedge. A delivered
 * turn (already drained), an empty buffer (nothing to rescue), or the
 * feature being disabled → do not arm.
 */
export function shouldArmNoReplyDrain(input: NoReplyDrainArmInput): boolean {
  if (!input.enabled) return false
  if (input.finalAnswerDelivered === true) return false
  return input.bufferedDepth > 0
}
