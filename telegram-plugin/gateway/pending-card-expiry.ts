/**
 * Pure, injectable core for expiring an agent-initiated approval card
 * (vault_request_access / vault_request_save / request_secret /
 * mental_model_propose) whose TTL elapsed with no operator tap.
 *
 * Extracted from gateway.ts so the ORDERING and FAULT-ISOLATION contract is
 * unit-testable behaviorally (pending-card-expiry.test.ts), not just pinned by
 * source-text regex:
 *
 *   1. remove() FIRST — the in-memory map entry + durable store record are
 *      dropped before anything else, so the expiry is single-shot: a second
 *      reaper tick (or a concurrent lazy sweep) can never double-fire the
 *      synthetic wake for the same card.
 *   2. editCard() — best-effort ⌛ card strip; a Telegram failure never blocks
 *      the wake.
 *   3. recordMiss() — the missed-approvals re-offer entry is written BEFORE
 *      the deliver attempt, so a throwing IPC socket can't lose the re-offer:
 *      even if the wake never lands, the operator's return re-surfaces it.
 *   4. deliver() — the timeout synthetic, wrapped in try/catch. A half-dead
 *      client socket that throws on write is contained here: the error is
 *      logged, `delivered: false` is returned, and the caller's sweep loop
 *      continues to the remaining entries/families.
 *
 * Every step is individually guarded — one failing dependency never skips the
 * later steps or escapes to the caller (the reaper's setInterval callback,
 * where an escaped throw would take the whole gateway down via
 * uncaughtException).
 */

import type { InboundMessage } from './ipc-protocol.js'

export interface ExpireCardDeps {
  /** Drop the in-memory map entry AND the durable store record. Runs first. */
  remove: () => void
  /** Best-effort ⌛ card edit (strip keyboard). Failures are swallowed. */
  editCard: () => void
  /** Build the timeout synthetic inbound for this card's family. */
  buildInbound: () => InboundMessage
  /** Inject the synthetic (turn-safe gate). May throw on a dead socket. */
  deliver: (inbound: InboundMessage) => boolean
  /** Record the missed-approvals re-offer entry. Runs BEFORE deliver. */
  recordMiss: () => void
  /** Error sink (stderr in production). */
  log: (msg: string) => void
}

export interface ExpireCardResult {
  delivered: boolean
}

export function expirePendingCard(deps: ExpireCardDeps): ExpireCardResult {
  // 1. Single-shot: entry gone before any fallible side effect.
  deps.remove()
  // 2. Card strip is cosmetic — never let it block the wake.
  try {
    deps.editCard()
  } catch (err) {
    deps.log(`card-expiry: card edit failed: ${(err as Error).message}`)
  }
  // 3. Re-offer entry BEFORE the deliver attempt so a throwing deliver can't
  //    lose it (the operator's return still re-surfaces the missed card).
  try {
    deps.recordMiss()
  } catch (err) {
    deps.log(`card-expiry: missed-approval record failed: ${(err as Error).message}`)
  }
  // 4. The wake itself — contained so one dead socket doesn't skip the
  //    remaining entries in the caller's sweep loop.
  let delivered = false
  try {
    delivered = deps.deliver(deps.buildInbound())
  } catch (err) {
    deps.log(`card-expiry: timeout synthetic delivery failed: ${(err as Error).message}`)
  }
  return { delivered }
}

/**
 * Sweep one pending-card map: expire every entry past its TTL via `expire`,
 * guarding each entry so one throwing expiry can't skip the rest of the map
 * (or, at the caller, the remaining families).
 */
export function sweepExpiredEntries<T>(
  map: Map<string, T>,
  isExpired: (value: T, now: number) => boolean,
  expire: (stageId: string, value: T, now: number) => void,
  now: number,
  log: (msg: string) => void,
): void {
  for (const [k, v] of map) {
    if (!isExpired(v, now)) continue
    try {
      expire(k, v, now)
    } catch (err) {
      log(`card-expiry: expire threw for stage=${k}: ${(err as Error).message}`)
    }
  }
}
