/**
 * handback-orphan-recovery.ts — the gateway-side EFFECTS for deterministic
 * recovery of a genuinely-orphaned sub-agent handback.
 *
 * The decision ("is this an orphan, should it be re-injected, has it exhausted
 * its retries") lives in `handback-preturn-signal.ts`. This module owns only the
 * three side effects that decision drives, so they live in a module instead of
 * inline in gateway.ts (switchroom#2996 anti-inflation ratchet — new logic goes
 * into a seam, not into the 24k-line gateway):
 *
 *   1. `deleteCard`       — DELETE (never edit) the frozen pre-turn card. The
 *      old behaviour rewrote it to an operator-facing string asking a human to
 *      manually nudge a system that must recover itself. That string is gone
 *      from the codebase; the card is removed outright.
 *   2. `reinjectHandback` — push the handback back through the pending-inbound
 *      buffer (the same path live synthesis + boot replay use) so the idle drain
 *      re-delivers it and the machine re-processes it. The seam stamps the retry
 *      counter on `inbound.meta` before calling this, so the cap survives the
 *      round trip.
 *   3. `escalateOrphan`   — retries exhausted → fleet-health TELEMETRY, never a
 *      chat card. A structured line on the gateway log that the nightly
 *      fleet-health sensor (`src/fleet-health/scan.ts`) reads; the
 *      `handback orphan escalation` marker is greppable and carries the join key.
 *
 * Every effect is injected, so the contract is asserted by a unit test with spy
 * transports (`tests/handback-orphan-recovery.test.ts`) rather than by reading
 * gateway.ts.
 */

import type { InboundMessage } from './ipc-protocol.js'
import type { HandbackOrphanEscalation, PreTurnCardRecord } from './handback-preturn-signal.js'

export interface HandbackOrphanRecoveryDeps {
  /** Delete a message. The gateway supplies its `robustApiCall`-wrapped
   *  `bot.api.deleteMessage`; rejections are swallowed here (best-effort). */
  deleteMessage: (chatId: string, messageId: number, threadId: number | null) => Promise<unknown>
  /** The gateway's `pendingInboundBuffer.push`, pre-bound to this agent. */
  pushInbound: (inbound: InboundMessage) => void
  /** Telemetry sink. Defaults to the gateway log (stderr). */
  writeLog?: (line: string) => void
}

/** Structured, greppable telemetry line for an exhausted-retry orphan. Exported
 *  so the test asserts the exact marker + join keys the fleet-health sensor
 *  greps for, not just that "something was logged". */
export function formatOrphanEscalation(esc: HandbackOrphanEscalation): string {
  return (
    `telegram gateway: handback orphan escalation key=${esc.statusKey} ` +
    `turnId=${esc.adoptTurnId} reinjects=${esc.reinjectCount} ageMs=${esc.ageMs} ` +
    `— deterministic recovery exhausted, no operator nudge issued\n`
  )
}

export function createHandbackOrphanRecovery(deps: HandbackOrphanRecoveryDeps): {
  deleteCard: (record: PreTurnCardRecord) => Promise<void>
  reinjectHandback: (inbound: InboundMessage) => void
  escalateOrphan: (escalation: HandbackOrphanEscalation) => void
} {
  const writeLog = deps.writeLog ?? ((line: string) => void process.stderr.write(line))
  return {
    deleteCard: (record) =>
      deps
        .deleteMessage(record.chatId, record.activityMessageId, record.threadId)
        .then(() => undefined)
        .catch(() => undefined),
    reinjectHandback: (inbound) => deps.pushInbound(inbound),
    escalateOrphan: (esc) => writeLog(formatOrphanEscalation(esc)),
  }
}
