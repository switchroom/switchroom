/**
 * escalation-bridge-gate.ts — the bridge-alive gate for the obligation sweep's
 * ESCALATE branch, extracted from obligationSweep so the "do NOT direct-send the
 * 'I may have missed this' nudge while the Telegram bridge is down" decision
 * (#2788 Gap A) is EXECUTABLE in a pure unit test.
 *
 * The bug (#2788 Gap A): the obligation sweep keeps running while the Telegram
 * bridge is disconnected. Unlike the represent branch (which goes through the
 * bridge → buffer and is naturally stranded behind a dead bridge), the escalate
 * branch DIRECT-SENDS via `bot.api.sendMessage`, bypassing the bridge. So during
 * a transient bridge flap the user could receive a false "I may have missed this"
 * even though the real reply is simply queued behind the outage and will land the
 * moment the bridge recovers.
 *
 * The fix is a deferral, not a drop: obligations already survive bridge death
 * (they live in the durable ledger and are re-evaluated every sweep), so gating
 * the escalate SEND on bridge-alive and returning without closing leaves the
 * obligation OPEN. The next sweep after the bridge reconnects re-drives it — the
 * nudge is deferred until it can reflect a real, post-recovery miss. This adds NO
 * unbounded liveness dependency: the entire gateway's inbound delivery already
 * rests on the bridge eventually reconnecting / the process restarting.
 *
 * PURE — no Telegram, no IPC; the gateway injects `bridgeAlive` (read from
 * `ipcServer.getClient(agent)?.isAlive()`).
 */

export interface EscalationBridgeGateDeps {
  /**
   * True when this agent's bridge sidecar is currently registered and alive on
   * the IPC server — i.e. a direct escalate send can actually reflect delivery
   * reality rather than racing a queued-behind-a-dead-bridge reply.
   */
  bridgeAlive: boolean
}

/**
 * Decide whether the escalate branch should DEFER (skip this sweep, leave the
 * obligation OPEN) because the bridge is down.
 *
 * Returns true ⇒ defer: do not send the nudge, do not close — the durable
 * obligation is re-driven on a later sweep once the bridge recovers.
 * Returns false ⇒ the bridge is alive; proceed with escalation.
 */
export function shouldDeferEscalationForBridge(deps: EscalationBridgeGateDeps): boolean {
  return !deps.bridgeAlive
}
