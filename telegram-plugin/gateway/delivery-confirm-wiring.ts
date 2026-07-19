/**
 * delivery-confirm-wiring.ts — the deliver-until-acked SWEEP wiring
 * (#2996 P8 PR-C1).
 *
 * Extracted VERBATIM from gateway.ts: the 5 s confirm-sweep tick body
 * (`runDeliveryConfirmSweep`), the strand re-delivery (`redeliverStrandedInbound`)
 * and the #2787 Mechanism A card-suspension scoper (`sweepSuspendedTargets`).
 * The gateway keeps thin same-name wrappers and OWNS the `setInterval`
 * (the P0c rule — a test import must stay side-effect-free).
 *
 * DI contract: state stays in gateway.ts (`deliveryQueue`, the pending-card
 * maps, `pendingInboundBuffer`); volatile handles cross as getters. The idle
 * gate deliberately reads `getCurrentTurnNull()` — the turn ATOM, not the
 * machine's eager in-turn state (the documented trap: `turnInFlightForGate`
 * stays set through a strand until the TTL tick, so it is NOT a usable idle
 * signal here). Design §3 PR-C1 risk row; harness case 4 pins mid-turn
 * suppression.
 *
 * `trackDelivery` enrolment callsites stay in gateway.ts unchanged — the two
 * twin-body sites live inside the P7-owned handleInbound window and are P7's
 * to delete (design §2 PR-C1 note).
 */
import type { InboundMessage } from './ipc-protocol.js'
import type { DeliveryConfirmWiringDeps } from './gateway.js'
import {
  trackDelivery,
  sweep as sweepDeliveryQueue,
  forgetDelivery,
  isRedeliverySuspended,
  type PendingDelivery,
} from './inbound-delivery-confirm.js'
import { chatKey } from './chat-key.js'

export function createDeliveryConfirmWiring(deps: DeliveryConfirmWiringDeps) {
  const {
    DELIVERY_CONFIRM_ENABLED,
    DELIVERY_CONFIRM_TIMEOUT_MS,
    getCurrentTurnNull,
    sendToAgent,
    deliveryQueue,
    pendingInboundBuffer,
    pendingPermissions,
    pendingAskUser,
  } = deps

// Re-deliver stranded inbounds until claude acks (the marko drop-wedge).
// Every few seconds, re-send any inbound that was handed to claude but never
// acked by an `enqueue` — it stranded unsubmitted in the composer. Re-clear
// the composer so the re-sent notification lands on a clean line, then
// re-send. Reuses the same delivery primitives; the message is never dropped.
// (Refs ipcServer / pendingInboundBuffer declared below — resolved at fire
// time, after module init.) unref so the interval never holds the process.
async function redeliverStrandedInbound(p: PendingDelivery<InboundMessage>): Promise<void> {
  const selfAgent = process.env.SWITCHROOM_AGENT_NAME ?? ''
  process.stderr.write(
    `telegram gateway: inbound strand (no enqueue ack) key=${p.key} — re-clearing composer + re-delivering\n`,
  )
  try {
    const { clearAgentComposer } = await import('../../src/agents/tmux.js')
    if (selfAgent) clearAgentComposer({ agentName: selfAgent })
  } catch { /* best-effort; re-deliver regardless */ }
  const ok = sendToAgent(selfAgent, p.inbound)
  if (ok) {
    // Survive an ack that raced the `await import` above: only `enqueue`
    // clears tracking, so if a concurrent ack removed the entry, re-affirm
    // it — never drop. Idempotent.
    if (!deliveryQueue.pending.has(p.key)) {
      trackDelivery(deliveryQueue, p.key, p.inbound, Date.now(), p.messageId)
    }
  } else {
    // Bridge offline between attempts — hand off to the offline buffer
    // (bridgeUp drains it) and stop tracking here; the spool owns it now.
    pendingInboundBuffer.push(selfAgent, p.inbound)
    forgetDelivery(deliveryQueue, p.key)
  }
}
// #2787 Mechanism A — which chats/topics currently hold a live permission or
// ask_user card. A pending card is a live interaction for ITS OWN chat, so the
// confirm sweep must not re-clear the composer + re-send there. But the OLD guard
// (`pendingPermissions.size > 0 || pendingAskUser.size > 0 → return`) suspended
// the sweep GLOBALLY: one card parked in a single topic (or in the operator DM,
// a different chatId entirely) froze re-delivery of every stranded inbound across
// EVERY topic until that one card resolved. This scopes the suspension to the
// card's own target. Returns per-topic chatKeys where the topic is known and bare
// chatIds where it isn't (a card fanned to operator DMs records chatId only, and
// a whole-chat suspension is the safe conservative fallback there); the callsite
// tests a delivery entry against both renderings.
function sweepSuspendedTargets(): { keys: Set<string>; chats: Set<string> } {
  const keys = new Set<string>()
  const chats = new Set<string>()
  for (const p of pendingPermissions.values()) {
    for (const c of p.cards) {
      if (c.threadId != null) keys.add(chatKey(c.chatId, c.threadId))
      else chats.add(c.chatId)
    }
    // A permission whose card send hasn't resolved yet (cards still empty) has
    // no recorded target — suspend nothing for it; the next sweep sees it once
    // the send resolves, and the currentTurn guard already covers the in-turn
    // window a fresh permission request lives in.
  }
  for (const a of pendingAskUser.values()) {
    if (a.threadId != null) keys.add(chatKey(a.chatId, a.threadId))
    else chats.add(a.chatId)
  }
  return { keys, chats }
}

// #2996 P0c/P8 PR-C1: the sweep TICK body (named in PR-A so the harness can
// drive it) — the GATEWAY still owns the `setInterval` (the P0c gate rule:
// modules export the tick body; the gateway registers the timer).
function runDeliveryConfirmSweep(): void {
  if (!DELIVERY_CONFIRM_ENABLED) return
  // Re-deliver ONLY when claude is genuinely idle. `currentTurn` is set solely
  // by the enqueue session-event and nulled at turn-end, so `currentTurn != null`
  // means a real turn is in flight — re-clearing the composer + re-sending now
  // would clobber it (the exact mid-turn wedge this queue exists to prevent).
  // NB: the machine's in-turn state (turnInFlightForGate) is advanced EAGERLY
  // at delivery and stays set through a strand until the TTL tick, so it is
  // NOT a usable "idle" signal here.
  if (!getCurrentTurnNull()) return
  // #2787 Mechanism A: a pending permission / ask_user card suspends re-delivery
  // ONLY for its own chat/topic — never globally. Skip just the stranded entries
  // whose target holds a live card; sweep the rest so unrelated topics keep
  // getting re-delivered.
  const suspended = sweepSuspendedTargets()
  for (const p of sweepDeliveryQueue(deliveryQueue, Date.now(), DELIVERY_CONFIRM_TIMEOUT_MS)) {
    if (isRedeliverySuspended(p.key, suspended)) continue
    void redeliverStrandedInbound(p)
  }
}

  return { runDeliveryConfirmSweep, redeliverStrandedInbound, sweepSuspendedTargets }
}
