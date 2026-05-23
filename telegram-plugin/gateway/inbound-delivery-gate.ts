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
 * A non-steering inbound on the Telegram `handleInbound` path is
 * delivered to the bridge ONLY when no turn is in flight. The channel
 * notification therefore always lands at an idle claude prompt, where
 * it submits cleanly as a fresh turn. It can be *delayed* (until the
 * current turn completes) but can never strand in the composer. The
 * turn-complete hook (`purgeReactionTracking`) and the turn-gated
 * idle-drain timer flush the buffer the instant
 * `activeTurnStartedAt.size === 0`.
 *
 * Scope: this gates the Telegram `handleInbound` path only — the one
 * the lawgpt wedge hit. The `inject_inbound` IPC path (cron / synthetic
 * operator wakeups) reaches the bridge directly and is deliberately
 * NOT gated here: cron fires carry at-least-once replay semantics and
 * their delivery contract is a separate product decision, out of scope
 * for this bug.
 *
 * ## Steering is deliberately exempt
 *
 * An explicit `/steer` (`/s`) message is *meant* to reach claude
 * mid-turn — that is the whole point of the steering feature (redirect
 * the agent while it works). Steering messages keep immediate delivery.
 * The wedge only ever affected the queued-mid-turn default path.
 *
 * ## Interrupt-marker is also exempt (2026-05-24 fix)
 *
 * An inbound prefixed with `!` invokes the interrupt path
 * (`gateway.ts:handleInbound` parse + `tmux send-keys C-c` to the
 * bridge). The SIGINT kills the in-flight turn at the SDK level — but
 * the killed turn does NOT always emit `turn_complete`. Without that
 * event, the turn-complete buffer-flush never fires, and the
 * post-SIGINT inbound body (the `!` replacement instruction) rots in
 * `pendingInboundBuffer` indefinitely.
 *
 * 2026-05-24 live UAT trace: user fires `! actually reply hello`,
 * SIGINT delivered, killed turn never emits `turn_complete`, buffer
 * stays full, user sees no response. The Phase-3 audit had this UAT
 * `describe.skip`'d as "real interrupt-marker wedge or prompt-shape
 * issue" — confirmed real.
 *
 * Resolution: bypass the gate for interrupt inbounds. The interrupt
 * carve-out is a peer of `isSteering` — both are "intentional
 * mid-turn delivery" cases. Caller passes the interrupt flag from the
 * inbound parse; the gate returns `'deliver'` immediately.
 */

export interface InboundDeliveryGateInput {
  /** A turn is in flight RIGHT NOW (live: `activeTurnStartedAt.size > 0`),
   *  evaluated at delivery time — not a receipt-time snapshot, so a turn
   *  that completed between receipt and here correctly reads as idle. */
  turnInFlight: boolean
  /** This inbound carried an explicit `/steer` (`/s`) prefix and is an
   *  intentional mid-turn redirect. */
  isSteering: boolean
  /** This inbound was parsed by `parseInterruptMarker` as a `!`-prefixed
   *  interrupt request. The gateway has already (or is about to) deliver
   *  the SIGINT to claude via tmux send-keys; the body of the message
   *  (post-`!`) is the user's replacement instruction. Without this
   *  carve-out, the body rots in pendingInboundBuffer because the
   *  SIGINT'd turn doesn't reliably emit turn_complete to drain the
   *  buffer. Optional + defaults false for backward compat. */
  isInterrupt?: boolean
}

export type InboundDeliveryDecision =
  /** Send to the bridge now (idle prompt, or an intentional steer). */
  | 'deliver'
  /** Hold in the pending-inbound buffer; the turn-complete hook /
   *  turn-gated idle-drain flushes it when claude goes idle. */
  | 'buffer-until-idle'

/**
 * Pure. Defers delivery ONLY when a turn is in flight AND this inbound
 * is neither steering nor an interrupt. Idle → deliver. Steering → deliver
 * (intentional mid-turn redirect). Interrupt → deliver (the `!`
 * carve-out — see header doc; the killed turn may never drain the
 * buffer, so we must not buffer in the first place).
 */
export function decideInboundDelivery(
  input: InboundDeliveryGateInput,
): InboundDeliveryDecision {
  if (input.isSteering) return 'deliver'
  if (input.isInterrupt === true) return 'deliver'
  if (input.turnInFlight) return 'buffer-until-idle'
  return 'deliver'
}
