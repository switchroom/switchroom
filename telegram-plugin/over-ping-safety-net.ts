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
 * The slot is claimed BEFORE the actual send (caller responsibility).
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
  /** Deterministic clock for tests; defaults to Date.now() in callers. */
  nowMs: number
}

export interface OverPingDecision {
  /** True iff the caller should override `disableNotification` to
   *  `true` (i.e. send this reply silently). Implies a contract
   *  violation by the model — caller should log + emit a metric. */
  suppress: boolean
  /** True iff the caller should claim the slot —
   *  `turn.firstPingAt = nowMs`. Mutually exclusive with `suppress`. */
  claimSlot: boolean
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
  if (!input.modelRequestedPing) {
    // Model already chose silent — nothing for the safety net to do.
    return { suppress: false, claimSlot: false, sinceFirstPingMs: null }
  }
  if (input.firstPingAt != null) {
    // Slot already claimed by an earlier ping this turn — suppress.
    return {
      suppress: true,
      claimSlot: false,
      sinceFirstPingMs: input.nowMs - input.firstPingAt,
    }
  }
  // First ping this turn — let it through and claim the slot.
  return { suppress: false, claimSlot: true, sinceFirstPingMs: null }
}
