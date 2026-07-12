/**
 * premium-recovery-wiring.ts — the gateway GLUE for the "premium model
 * recovered" ping, behind injected deps so the never-storm orchestration is
 * unit-testable without importing the whole gateway (mirrors
 * tier-downgrade-wiring.ts).
 *
 * The pure recovery predicate (`decidePremiumRecovery`), the honest wording +
 * button (`renderPremiumRecoveryPing`), and the fleet-dedup key
 * (`premiumRecoveryClaimKey`) all live in premium-recovery.ts. This module owns
 * the ORDER-SENSITIVE side effects the gateway performs off that verdict — the
 * P0 at-most-once guarantee a review cares about:
 *
 *   - the marker is READ first; a missing/corrupt marker is a no-op (no send);
 *   - the pure decision gates the send: `fire === false` → NO clear, NO send
 *     (the marker survives for a later tick once the tier actually recovers);
 *   - a fleet-wide `claim-notification` gates against a bounce / concurrent
 *     tick; on `!granted` the marker is cleared (so it can't linger and
 *     re-attempt every tick) and we bail with NO send;
 *   - on a GRANTED claim the marker is cleared BEFORE the send (never-storm:
 *     at-most-once is the hard requirement — a transient send fault is covered
 *     by the caller's retry policy, a double-send is not recoverable);
 *   - EXACTLY ONE send per recorded chat, each carrying the session-scoped
 *     `mdl:alias:<premium>` switch-back button (the SAME apply path as the model
 *     menu — it does not bypass handleModelMenuCallback).
 *
 * Behaviour is a faithful extraction of the former inline
 * `maybePremiumRecoveryPing`; the ordering above is preserved exactly.
 */

import {
  renderPremiumRecoveryPing,
  premiumRecoveryClaimKey,
  type PremiumRecoveryPing,
} from '../premium-recovery.js'
import { MODEL_CALLBACK_ALIAS } from './model-command.js'

/** The one-tap switch-back keyboard (single callback button). */
export interface PremiumRecoveryKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

/** The minimal marker view the ping orchestration needs. */
export interface PremiumRecoveryMarkerView {
  /** The dropped premium `/model` token to offer switching back to. */
  premiumModel: string
  /** Chat ids to ping (the downgrade notice's allowFrom); may be empty → fallback. */
  chats: string[]
}

export interface PremiumRecoveryPingDeps {
  /** Bind-mounted agent state dir, or null when unresolvable (→ no-op). */
  getAgentDir: () => string | null
  /** Read the parsed `.premium-recovery` marker, or null when absent/corrupt. */
  readMarker: (agentDir: string) => PremiumRecoveryMarkerView | null
  /** Delete the marker (consume-once). Best-effort. */
  clearMarker: (agentDir: string) => void
  /** The agent name (for the fleet-dedup claim key). */
  getAgent: () => string
  /** The pure recovery predicate, bound to THIS tick's live accounts. Returns
   *  whether to fire (the marker is already known present when this is called). */
  decide: () => boolean
  /** Fleet-wide at-most-once claim for this premium token. Returns granted
   *  (fail-open: true on any broker error → degrades to at-least-once). */
  claimNotification: (claimKey: string) => Promise<boolean>
  /** Fallback chats when the marker records none (parity with the inline path). */
  fallbackChats: () => string[]
  /** Send the recovery ping (with the switch-back keyboard) to ONE chat. */
  sendToChat: (
    chatId: string,
    ping: PremiumRecoveryPing,
    keyboard: PremiumRecoveryKeyboard,
  ) => void
  /** Structured logger (stderr in prod, captured in test). */
  log: (msg: string) => void
}

/**
 * Run the premium-recovery ping glue. No-op unless a marker is pending, the
 * pure decision says fire, and the fleet claim is granted — then clears the
 * marker BEFORE fanning out exactly one send per chat. Async because the claim
 * is a broker round-trip; the caller `.catch`es (a convenience ping is never
 * allowed to throw the quota-watch tick).
 */
export async function runPremiumRecoveryPing(deps: PremiumRecoveryPingDeps): Promise<void> {
  const agentDir = deps.getAgentDir()
  if (!agentDir) return
  const marker = deps.readMarker(agentDir)
  if (marker == null) return
  // Pure decision gate: on `false` leave the marker in place (a later tick fires
  // once the tier recovers) — no clear, no claim, no send.
  if (!deps.decide()) return
  const agent = deps.getAgent()
  // Fleet-wide dedup: a fresh gateway boot or a second tick inside the window
  // must not re-send. Fail-open — a convenience ping degrades to at-least-once,
  // never lost.
  const granted = await deps.claimNotification(
    premiumRecoveryClaimKey(agent, marker.premiumModel),
  )
  if (!granted) {
    // Another gateway already owns this recovery ping — consume our marker so it
    // can't linger and re-attempt every tick, and bail (NO send).
    deps.clearMarker(agentDir)
    return
  }
  // Consume the marker BEFORE sending (never-storm: at-most-once is the hard
  // requirement for this ping; a transient send fault is covered by the
  // caller's retry policy, whereas a double-send is not recoverable).
  deps.clearMarker(agentDir)
  const ping = renderPremiumRecoveryPing(marker.premiumModel)
  const keyboard: PremiumRecoveryKeyboard = {
    inline_keyboard: [
      [{ text: ping.buttonText, callback_data: `${MODEL_CALLBACK_ALIAS}${marker.premiumModel}` }],
    ],
  }
  const chats = marker.chats.length > 0 ? marker.chats : deps.fallbackChats()
  for (const chatId of chats) {
    deps.sendToChat(chatId, ping, keyboard)
  }
  deps.log(
    `[premium-recovery] ${marker.premiumModel} servable again — ping sent agent=${agent} chats=${chats.length}`,
  )
}
