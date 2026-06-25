/**
 * over-ping-safety-net.ts — pure decision predicate for #1674's
 * "at-most-one device-ping per turn" framework safety net.
 *
 * Background. `reference/rfcs/conversational-pacing.md` beat 5 is
 * explicit: the model should deliver the answer as a fresh `reply`
 * omitting `disable_notification` (i.e. pinging the device once).
 * EXACTLY ONE ping per turn. The model occasionally violates this
 * — fleet UAT 2026-05-23 reproduced a substantive Step 3 answer
 * pinged + a wrap-up "Delivered all three steps with a wrap-up
 * summary." ALSO pinged, two device beeps for a turn that should
 * have produced one.
 *
 * This module is the framework safety net. The IO live in the
 * gateway's `executeReply` (mutate `turn.firstPingAt`, emit log +
 * runtime-metric, override `disableNotification`); keeping the
 * *decision* pure makes the predicate unit-testable without
 * standing up a gateway.
 *
 * Contract:
 *   - When the model requested a ping (`!disable_notification`) AND
 *     the current turn already had a ping land (`firstPingAt != null`),
 *     the decision says SUPPRESS — the caller downgrades to silent.
 *   - When the model requested a ping AND no prior ping this turn,
 *     the decision says CLAIM the slot — caller sets `firstPingAt`.
 *   - When the model requested silent, this module is a no-op.
 *
 * Notification ownership (R8 / PR-2). The bare "first ping wins" rule
 * above has a residual failure: an interim ACK that pings first claims
 * the turn's single slot, and the later SUBSTANTIVE answer is then
 * downgraded to silent — "the reply is last but the phone never buzzed
 * for the answer." To fix that without re-introducing model double-pings,
 * the decision is now aware of WHO holds the slot and WHO is asking:
 *
 *   - A SUBSTANTIVE final asking to ping while the slot is held by a
 *     NON-substantive (ack) send ⇒ do NOT suppress; let the answer ping
 *     and UPGRADE the slot to substantive (the answer owns the ping even
 *     though the ack already buzzed once — a deliberate, bounded second
 *     ping so the user is notified of the actual answer).
 *   - An ACK asking to ping while the slot is held by a SUBSTANTIVE send
 *     ⇒ suppress (no spurious double-ping AFTER the real answer).
 *   - A SUBSTANTIVE asking while the slot is held by a SUBSTANTIVE ⇒
 *     suppress (preserves the #1674 model-double-ping guard: answer +
 *     wrap-up should be one beep, not two).
 *   - An ACK while the slot is held by an ACK ⇒ suppress (unchanged).
 *
 * The slot is claimed BEFORE the actual send (caller responsibility).
 * On a CLAIM or an UPGRADE the caller MUST set `firstPingAt` AND
 * `firstPingWasSubstantive` ATOMICALLY (same synchronous block, no await
 * between) so a racing second reply reads a consistent pair.
 * Trade-off documented inline in `gateway.ts:executeReply`.
 */

export interface OverPingDecisionInput {
  /** True iff the model requested a device ping
   *  (`disable_notification:false` or omitted, since the default is to
   *  ping per Telegram Bot API). The caller computes this from the
   *  inbound `args.disable_notification === true` check. */
  modelRequestedPing: boolean
  /** Wall-clock ms of the FIRST ping this turn, or null if no ping
   *  has landed yet. Caller threads this through from
   *  `CurrentTurn.firstPingAt`. */
  firstPingAt: number | null
  /** True iff THIS reply is a substantive final answer (stream `done`,
   *  or text length ≥ FINAL_ANSWER_MIN_CHARS) — as opposed to a short
   *  interim ack. Caller computes via `isSubstantiveFinalReply`. Defaults
   *  to `false` (treat as a non-substantive ack) when omitted, which
   *  preserves the pre-PR-2 "first ping wins, the rest suppress" behaviour
   *  for callers that don't yet thread it. */
  substantive?: boolean
  /** True iff the send that CLAIMED the turn's ping slot was itself a
   *  substantive final answer. Caller threads this through from
   *  `CurrentTurn.firstPingWasSubstantive`. Meaningless (and ignored)
   *  when `firstPingAt == null`. Defaults to `false`. */
  firstPingWasSubstantive?: boolean
  /** Deterministic clock for tests; defaults to Date.now() in callers. */
  nowMs: number
}

export interface OverPingDecision {
  /** True iff the caller should override `disableNotification` to
   *  `true` (i.e. send this reply silently). Implies a contract
   *  violation by the model — caller should log + emit a metric. */
  suppress: boolean
  /** True iff the caller should claim the slot —
   *  `turn.firstPingAt = nowMs` AND
   *  `turn.firstPingWasSubstantive = substantive`. Mutually exclusive
   *  with `suppress`. Set both on a fresh claim (no prior ping) and on
   *  an UPGRADE (a substantive answer pinging over an ack's slot). */
  claimSlot: boolean
  /** True iff this is an UPGRADE — a substantive final answer claiming
   *  the ping slot that was previously held by a NON-substantive ack.
   *  The answer pings even though the ack already buzzed once. Implied
   *  by `claimSlot && firstPingAt != null` but surfaced explicitly so
   *  the caller can log/meter the (intentional) second ping distinctly
   *  from a normal first claim. Always false on a suppress or a no-op. */
  upgrade: boolean
  /** When `suppress` is true, how long the first ping has been
   *  "active" (ms since `firstPingAt`). Caller surfaces this in the
   *  log + metric for forensic analysis (e.g. tight rapid double-pings
   *  vs delayed wrap-ups). Null otherwise. */
  sinceFirstPingMs: number | null
}

/**
 * Pure decision: should the framework suppress this reply's ping?
 * No mutation, no IO, deterministic under a fixed `nowMs`.
 */
export function decideOverPing(input: OverPingDecisionInput): OverPingDecision {
  const substantive = input.substantive === true
  const firstPingWasSubstantive = input.firstPingWasSubstantive === true

  if (!input.modelRequestedPing) {
    // Model already chose silent — nothing for the safety net to do.
    return { suppress: false, claimSlot: false, upgrade: false, sinceFirstPingMs: null }
  }
  if (input.firstPingAt != null) {
    // The turn's ping slot is already held. WHO holds it and WHO is
    // asking decides whether this is a notification-ownership UPGRADE or
    // a double-ping to suppress (see the module doc-comment for the full
    // matrix).
    if (substantive && !firstPingWasSubstantive) {
      // The substantive ANSWER is pinging over a slot held by an ack.
      // Let it ping and upgrade the slot to substantive — the answer
      // owns the turn's notification, not the earlier ack.
      return {
        suppress: false,
        claimSlot: true,
        upgrade: true,
        sinceFirstPingMs: null,
      }
    }
    // Every other slot-held case is a double-ping to suppress:
    //   - ack over substantive: a spurious wrap-up after the real answer
    //   - substantive over substantive: the #1674 answer+wrap-up guard
    //   - ack over ack: the original one-ping-per-turn behaviour
    return {
      suppress: true,
      claimSlot: false,
      upgrade: false,
      sinceFirstPingMs: input.nowMs - input.firstPingAt,
    }
  }
  // First ping this turn — let it through and claim the slot.
  return { suppress: false, claimSlot: true, upgrade: false, sinceFirstPingMs: null }
}
