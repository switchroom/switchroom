/**
 * Inbound delivery gate (#1556 — the lawgpt composer-wedge).
 *
 * Pure decision: given the live turn state, should a freshly-received
 * Telegram inbound be delivered to the bridge *now*, or held in the
 * pending-inbound buffer until claude is idle?
 *
 * ## Why this exists
 *
 * The gateway used to `ipcServer.sendToAgent(inbound)` unconditionally,
 * buffering ONLY when the bridge was offline. The load-bearing (and
 * false) assumption — stated verbatim in three places before this fix
 * (`pending-inbound-buffer.ts`, the idle-drain comment, and the
 * implicit unconditional send) — was:
 *
 *   "a message delivered while a turn is active is queued normally by
 *    the bridge, same as a live arrival, not lost."
 *
 * It is not. The bridge converts an inbound into an MCP
 * `notifications/claude/channel` notification (`bridge.ts:onInbound`).
 * When claude receives that notification mid-turn, the unmodified CLI
 * types the text into its TUI composer and relies on an auto-submit
 * once the turn ends. That submit races turn-completion and frequently
 * does not fire — the message strands in the composer, claude sits at
 * an idle prompt with the user's instruction un-actioned, and nothing
 * self-heals it (the turn-active watchdog only catches *in-turn* hangs;
 * this is *between-turns*-with-undelivered-input, which reads as
 * healthy idle). Observed live: agent `lawgpt`, 2026-05-19 — a
 * follow-up message sat unsubmitted indefinitely; only a restart
 * cleared it, and the restart *lost* the message.
 *
 * ## The deterministic guarantee
 *
 * A non-steering inbound is delivered to the bridge ONLY when no turn
 * is in flight. The channel notification therefore always lands at an
 * idle claude prompt, where it submits cleanly as a fresh turn. It can
 * be *delayed* (until the current turn completes) but can never strand
 * in the composer. The turn-complete hook
 * (`purgeReactionTracking`) and the turn-gated idle-drain timer flush
 * the buffer the instant `activeTurnStartedAt.size === 0`.
 *
 * ## Steering is deliberately exempt
 *
 * An explicit `/steer` (`/s`) message is *meant* to reach claude
 * mid-turn — that is the whole point of the steering feature (redirect
 * the agent while it works). Steering messages keep immediate delivery.
 * The wedge only ever affected the queued-mid-turn default path.
 */

export interface InboundDeliveryGateInput {
  /** A turn is in flight RIGHT NOW (live: `activeTurnStartedAt.size > 0`),
   *  evaluated at delivery time — not a receipt-time snapshot, so a turn
   *  that completed between receipt and here correctly reads as idle. */
  turnInFlight: boolean
  /** This inbound carried an explicit `/steer` (`/s`) prefix and is an
   *  intentional mid-turn redirect. */
  isSteering: boolean
}

export type InboundDeliveryDecision =
  /** Send to the bridge now (idle prompt, or an intentional steer). */
  | 'deliver'
  /** Hold in the pending-inbound buffer; the turn-complete hook /
   *  turn-gated idle-drain flushes it when claude goes idle. */
  | 'buffer-until-idle'

/**
 * Pure. The ONLY condition that defers delivery is "a turn is in flight
 * AND this is not a steering message". Everything else delivers
 * immediately (idle → submits at once; steering → intentional mid-turn).
 */
export function decideInboundDelivery(
  input: InboundDeliveryGateInput,
): InboundDeliveryDecision {
  if (input.turnInFlight && !input.isSteering) return 'buffer-until-idle'
  return 'deliver'
}
