/**
 * Honest turn-record status derivation (PR B — "send-honesty" fix).
 *
 * `emitTurnRecord` historically wrote `status: finalAnswerDelivered ? 'complete'
 * : 'no_reply'`. On the turn-flush / backstop paths `finalAnswerDelivered` is set
 * BEFORE the async send actually runs, so a send that then throws (e.g.
 * `FLOOD_WAIT_ACTIVE` during a flood ban) was still recorded `complete` — a turn
 * where the user received NOTHING logged as delivered.
 *
 * The fix threads a per-turn `deliveryOutcome`, set only AFTER the send resolves,
 * and derives the recorded status from that real outcome. These helpers are pure
 * and injectable so the outcome ↔ status mapping is unit-testable without the
 * 30k-line gateway module (mirrors `turns-jsonl-rotate.ts`).
 */

/**
 * The resolved fate of a backstop (turn-flush) send, stamped on the turn only
 * once the send has actually resolved:
 * - `delivered`  — every chunk reached Telegram.
 * - `failed`     — the send threw, OR a partial multi-chunk delivery (chunk 1 ok,
 *                  a later chunk failed): the answer did not fully reach the user.
 * - `suppressed` — the flush short-circuited because the reply tool already
 *                  delivered this turn's answer (the 2s recent-outbound guard).
 */
export type DeliveryOutcome = 'delivered' | 'failed' | 'suppressed'

/** The status strings written to turns.jsonl. `send_failed` is new in PR B. */
export type TurnStatus = 'complete' | 'no_reply' | 'send_failed'

/**
 * Derive the recorded turn status from the turn's flags.
 *
 * `deliveryOutcome` (when present) is authoritative — it reflects the REAL send
 * resolution on the backstop paths. When it is absent (the synchronous
 * reply-tool tail, silent-marker, and genuine no-reply paths) we fall back to the
 * legacy `finalAnswerDelivered` reading, preserving existing semantics exactly.
 *
 *   delivered            → complete
 *   failed / partial     → send_failed   (NOT complete, NOT silently no_reply)
 *   suppressed           → complete iff the reply path delivered, else no_reply
 *   undefined (legacy)   → complete iff finalAnswerDelivered, else no_reply
 *                          (fail-safe: an IIFE that dies before stamping an
 *                          outcome never fabricates `complete`)
 */
export function computeTurnStatus(turn: {
  finalAnswerDelivered: boolean
  deliveryOutcome?: DeliveryOutcome
}): TurnStatus {
  switch (turn.deliveryOutcome) {
    case 'failed':
      return 'send_failed'
    case 'delivered':
      return 'complete'
    case 'suppressed':
      return turn.finalAnswerDelivered ? 'complete' : 'no_reply'
    default:
      return turn.finalAnswerDelivered ? 'complete' : 'no_reply'
  }
}

/**
 * Resolve a backstop send's outcome from what actually happened on the wire.
 * A throw is a failure; a no-throw send that delivered fewer chunks than it
 * split into is a partial delivery and is treated as `failed` (the user did not
 * receive the whole answer) — never silently `delivered`/`complete`.
 */
export function backstopSendOutcome(args: {
  threw: boolean
  sentCount: number
  chunkCount: number
}): DeliveryOutcome {
  if (args.threw) return 'failed'
  if (args.sentCount < args.chunkCount) return 'failed'
  return 'delivered'
}
