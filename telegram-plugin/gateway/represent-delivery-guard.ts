/**
 * represent-delivery-guard.ts — the DELIVERY-time half of the duplicate-represent
 * defence (fix/represent-double-send-delivery-recheck).
 *
 * Background — the race this closes (verified from history.db, 2026):
 *   1. A ~5-min silence poke fires the framework fallback, which clears the
 *      machine turn (`turnInFlightForGate()` → false) while the CLI session is
 *      STILL producing the answer (it lands ~17s later). stream-render's live-turn
 *      mirror (`currentTurn`/`parkedTurnStarts`) still knows the session is busy.
 *   2. With the machine turn cleared, `obligationSweep` runs; `shouldSuppressRepresent`
 *      correctly returns false (nothing has been sent YET) and the represent is
 *      buffered; the idle-drain flushes it into the live CLI queue.
 *   3. ~13s later the real answer is delivered + recorded (ledger closed by the
 *      normal path). Then the model consumes the already-queued represent and
 *      answers a SECOND time → the duplicate.
 *
 * The represent guard never FAILED — it was consulted BEFORE the reply existed,
 * and there was no re-check between decision → delivery → model consumption. This
 * module adds that missing re-check (F1) plus the bounded busy-defer for the
 * idle-drain gate (F2). Layer F2 (obligation-wiring's sweep + this drain defer)
 * keeps the represent BUFFERED while the session is busy so that, by the time a
 * drain actually hands it to the bridge, the real answer has landed and been
 * recorded — at which point F1 retracts the now-stale represent. `recordOutbound`
 * is a synchronous SQLite write that completes before the reply tool result
 * returns, so a post-reply drain observes the row.
 *
 * Both halves are PURE-ish factories (no Telegram, no SQLite) so the whole
 * decision is executable in a unit test; the gateway injects the ledger accessor,
 * the outbound-history predicate, and the logger.
 */

import type { InboundMessage } from './ipc-protocol.js'
import { shouldSuppressRepresent, type RepresentGuardObligation } from './represent-guard.js'

/** The minimal ledger surface the delivery re-check needs. */
export interface RepresentDeliveryLedger {
  /** The CURRENTLY-open obligation for `originTurnId`, or undefined if none is
   *  open (already closed — answered or cancelled — since the represent was
   *  buffered). */
  get(originTurnId: string): RepresentGuardObligation | undefined
  /** Close the obligation. Idempotent; returns whether an entry was removed. */
  close(originTurnId: string | null | undefined): boolean
}

export interface RepresentRedeliveryGuardDeps {
  /** OBLIGATION_LEDGER_ENABLED — when off, never retract (nothing is tracked). */
  enabled: boolean
  /** HISTORY_ENABLED — forwarded to the pure guard (no history ⇒ never suppress). */
  historyEnabled: boolean
  ledger: RepresentDeliveryLedger
  /** history.hasOutboundDeliveredSince, already curried with the chat query. */
  hasOutboundDeliveredSince: (
    chatId: string,
    sinceMs: number,
    threadId?: number,
    minChars?: number,
  ) => boolean
  /** The represent guard's OWN low reply-length threshold (a terse-but-real reply
   *  must still suppress the duplicate — #2472/#2474). */
  minReplyChars: number
  log: (line: string) => void
}

/**
 * Build the `beforeRedeliver` predicate the pending-inbound buffer consults for
 * EVERY message it is about to hand to the CLI bridge. Returns TRUE to proceed
 * with delivery, FALSE to RETRACT (drop) the message.
 *
 * Only `obligation_represent` inbounds are ever retracted; everything else always
 * proceeds. A represent is retracted when, AT DELIVERY TIME:
 *   - the obligation is no longer open (a reply landed and the normal close path
 *     fired, or it was cancelled) — re-delivering would duplicate / re-ask a
 *     resolved question; OR
 *   - it IS still open but `shouldSuppressRepresent` now returns true against the
 *     obligation's CURRENT cutoff (a reply landed since decision, but the normal
 *     close path missed it because its routing did not resolve back to the origin
 *     — the exact #2472 gap, now caught at delivery instead of only at decision).
 *
 * The cutoff is the obligation's own (`openedAt` for the first represent,
 * `lastRepresentedAt` thereafter) — encoded inside `shouldSuppressRepresent`, so
 * an OLD reply to a DIFFERENT earlier question does not suppress a legitimate new
 * represent (#2472 second-represent semantics). The genuine plain-text-no-reply
 * case (#2788) records NO outbound row, so the predicate reports false at BOTH
 * decision and here ⇒ the represent still fires exactly once.
 */
export function makeRepresentRedeliveryGuard(
  deps: RepresentRedeliveryGuardDeps,
): (msg: InboundMessage) => boolean {
  return (msg) => {
    if (!deps.enabled) return true
    if (msg.meta?.source !== 'obligation_represent') return true
    const originTurnId = msg.meta?.origin_turn_id
    if (originTurnId == null) return true

    const o = deps.ledger.get(originTurnId)
    if (o == null) {
      // Closed since this represent was buffered — a reply landed (normal close)
      // or the turn was cancelled/interrupted. Either way the buffered represent
      // is stale: drop it rather than re-ask an already-resolved obligation.
      deps.log(
        `telegram gateway: represent retracted at delivery — obligation already ` +
          `closed since decision (no re-fire) origin=${originTurnId}\n`,
      )
      return false
    }

    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: deps.historyEnabled,
      hasOutboundDeliveredSince: (chatId, sinceMs, threadId) =>
        deps.hasOutboundDeliveredSince(chatId, sinceMs, threadId, deps.minReplyChars),
    })
    if (suppress) {
      // A reply landed since this obligation's cutoff but the normal close path
      // missed it. Close the ledger entry ourselves and drop the represent.
      deps.ledger.close(originTurnId)
      deps.log(
        `telegram gateway: represent retracted at delivery — reply landed since ` +
          `decision (no re-fire) origin=${originTurnId}\n`,
      )
      return false
    }
    return true
  }
}

/**
 * Build the BOUNDED busy-defer predicate for the idle-drain gate (F2, drain
 * half). Returns TRUE while the drain should be DEFERRED because the session is
 * busy (stream-render's live-turn mirror), FALSE once it is safe to drain.
 *
 * Why bounded: the drain must not hand a buffered represent to a session that is
 * mid-answer (that re-queues it BEHIND the real answer → the duplicate). But a
 * session that is WEDGED busy forever must not silence a buffered represent
 * forever (red-team #2). So the deferral is capped: once the session has been
 * continuously busy for longer than `boundMs`, the drain proceeds regardless. The
 * clock resets to "not deferring" the moment the session reads idle, so an
 * ordinary busy turn (which ends well within the bound) defers cleanly and never
 * consumes the wedge budget.
 *
 * `boundMs <= 0` disables the busy-defer entirely (kill switch / parity with the
 * background-work grace being disabled).
 */
export function makeSessionBusyDrainDeferral(
  boundMs: number,
): (busy: boolean, now: number) => boolean {
  let deferringSince: number | null = null
  return (busy, now) => {
    if (!busy || boundMs <= 0) {
      deferringSince = null
      return false
    }
    if (deferringSince == null) deferringSince = now
    // Bounded: stop deferring once we have been busy past the ceiling, so a
    // wedged/hung session still eventually drains the buffered represent.
    return now - deferringSince < boundMs
  }
}
