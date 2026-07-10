// #2995 — mid-flight busy ack.
//
// A mid-turn inbound that is neither a steer nor an interrupt is buffered
// until the running turn goes idle (`buffer-until-idle`). When the turn is
// sitting inside ONE long blocking tool call (`gh pr checks --watch`, a
// long `sleep`, a slow build), that wait can be minutes — from the phone
// the question reads as ignored. The user's message got only a 👀 reaction
// and then silence until the blocking step returned (observed live
// 2026-07-10: a trivial "are any agents working?" waited 2 minutes behind
// a `--watch`).
//
// This module is the PURE half of the fix: a deterministic, model-free
// decision — should the gateway post a silent "⏳ Queued — currently
// inside <tool> …" card into the inbound's own chat/topic right now? No
// tokens, no model calls; the gateway supplies live readings (delivery-gate
// decision, tool-flight state, current step age, dedupe state) and this
// module answers. Extracted so the policy is unit-testable without the
// gateway IIFE (same pattern as `interrupt-defer.ts` / `feed-reopen-gate.ts`).
//
// Wording contract: the buffered-path card MUST say "Queued" — the
// steer-or-queue job spec (`reference/jobs/steer-or-queue-mid-flight.md`)
// requires the chosen classification to be visible in the chat, never
// inferred. A steer-path card must NOT say "Queued" (it wasn't queued);
// it says the steer was noted and will fold in at the step boundary.

/** How the inbound was classified/handled by the delivery gate. Only the
 *  two mid-turn shapes are ack-eligible; a plain fresh-turn `deliver`
 *  needs no busy ack (the turn starts immediately). */
export type BusyAckGateDecision = 'buffer-until-idle' | 'steer' | 'deliver'

/**
 * Minimum age of the CURRENT tool step before a busy ack fires. Below
 * this the step is about to return anyway and the buffered inbound will
 * flush in a beat — an ack would fire when the agent was seconds from
 * answering (the job spec's explicit Bad bullet). 12s sits well above the
 * common fast-tool envelope (reads/greps/short bashes finish in <5s) and
 * well below the "reads as ignored" horizon (~30s+); it also matches the
 * UAT latency promise (visible ack <10s of the ping, for a step that has
 * already proven itself long).
 */
export const BUSY_ACK_STEP_AGE_THRESHOLD_MS = 12_000

export interface BusyAckDecisionInput {
  /** Delivery-gate outcome for this inbound ('steer' when it was
   *  delivered mid-turn as a steering amend). */
  gateDecision: BusyAckGateDecision
  /** Live `ToolFlightTracker.isMidToolCall()` reading — at least one
   *  top-level tool call currently open. */
  midToolCall: boolean
  /** Age (ms) of the LONGEST-running in-flight tool step, or null when no
   *  step is tracked (e.g. the turn is thinking between tools). */
  stepAgeMs: number | null
  /** True when a busy-ack/queued-status card already exists (or was
   *  already posted this turn) for the inbound's chat/topic — at most one
   *  card per turn per chat/topic; a second ping gets no second card. */
  alreadyAcked: boolean
}

/**
 * Pure decision: post the busy-ack card now?
 *
 *  - only for mid-turn shapes (buffered, or delivered as a steer)
 *  - only while genuinely mid-tool-call
 *  - only once the current step is older than the threshold (a young
 *    step returns soon; the normal flush covers it)
 *  - at most once per turn per chat/topic (dedupe)
 */
export function shouldPostBusyAck(input: BusyAckDecisionInput): boolean {
  if (input.gateDecision !== 'buffer-until-idle' && input.gateDecision !== 'steer') return false
  if (!input.midToolCall) return false
  if (input.stepAgeMs == null || input.stepAgeMs < BUSY_ACK_STEP_AGE_THRESHOLD_MS) return false
  if (input.alreadyAcked) return false
  return true
}

export interface BusyAckTextInput {
  gateDecision: 'buffer-until-idle' | 'steer'
  /** Bare tool name as tracked (e.g. "Bash"). Null when unknown. */
  toolName: string | null
  /** Natural-language descriptor from the PreToolUse sidecar's
   *  `toolLabel()` (e.g. `sleep 90`), or null. */
  toolLabel: string | null
}

/**
 * Render the card text. Deterministic, no model. The buffered variant
 * says "Queued" (classification-visibility invariant); the steer variant
 * says the steer is noted — never "Queued".
 *
 * Deliberately carries NO elapsed figure: the card is posted once and
 * never re-rendered while the blocking step runs, so any point-in-time
 * number ("2m elapsed") would silently go stale on screen — a decaying
 * claim on a card whose whole point is honesty. The activity name alone
 * is time-invariant.
 */
export function formatBusyAckText(input: BusyAckTextInput): string {
  const name = input.toolName ?? 'a long-running step'
  const activity =
    input.toolLabel != null && input.toolLabel.length > 0
      ? `${name}: ${input.toolLabel}`
      : name
  if (input.gateDecision === 'steer') {
    return `⏳ Steer noted — currently inside \`${activity}\`; I'll fold it in when this step finishes.`
  }
  return `⏳ Queued — currently inside \`${activity}\`; I'll answer when this step finishes.`
}
