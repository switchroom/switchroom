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
 *
 * #3276 — INDEPENDENT-RECEIPT REQUIREMENT. A backstop send is only `delivered`
 * when it produced a real, positive Telegram `message_id` receipt for every
 * chunk. `receiptIds` is the list of message ids the send loop actually
 * collected from resolved `sendMessage`/`sendRichMessage` results. This closes
 * the silent-drop the issue documents: a non-throwing API call (a status-card
 * mutation, a degraded/stubbed "ok", or any resolve that yields no usable
 * message id) must NOT be recorded `complete`. Delivery is proven by an
 * independent receipt, not by "the promise didn't throw".
 */
export function backstopSendOutcome(args: {
  threw: boolean
  chunkCount: number
  receiptIds: number[]
}): DeliveryOutcome {
  if (args.threw) return 'failed'
  // Defense (Fix 5): a "send" that split into zero chunks delivered nothing —
  // do NOT let a 0-chunk send slip through to 'delivered'/'complete' (which
  // would trip the silent-no-op-candidate detector on a tools:0 turn).
  if (args.chunkCount === 0) return 'failed'
  // #3276: count ONLY real, positive message-id receipts. A card edit / stub /
  // non-message "ok" contributes no positive id, so it can never reach the
  // chunkCount floor and can never be recorded delivered.
  const validReceipts = args.receiptIds.filter(
    (id) => typeof id === 'number' && Number.isInteger(id) && id > 0,
  ).length
  if (validReceipts < args.chunkCount) return 'failed'
  return 'delivered'
}

/**
 * Stamp a turn's `deliveryOutcome` from a resolved backstop send. This is the
 * exact accounting the turn-flush IIFE's `finally` performs — factored here so
 * the gateway and the tests run the SAME mapping (a real send that throws or
 * partially delivers must produce `send_failed`, never `complete`). Mutates and
 * returns the resolved outcome.
 */
export function finalizeBackstopSend(
  turn: { deliveryOutcome?: DeliveryOutcome },
  send: { threw: boolean; chunkCount: number; receiptIds: number[] },
): DeliveryOutcome {
  const outcome = backstopSendOutcome(send)
  turn.deliveryOutcome = outcome
  return outcome
}

/** The parsed shape of one turns.jsonl row. */
export interface TurnRecordRow {
  ts: number
  agent: string
  duration_ms: number
  tools: number
  status: TurnStatus
  turn_id: string
}

/**
 * Build the turns.jsonl row for a turn. The single source of truth for the
 * `status` field — `emitTurnRecord` serializes exactly this, so a test that
 * asserts on `buildTurnRecord(...).status` is asserting the value the gateway
 * actually writes (proving `emitTurnRecord` derives status from the resolved
 * `deliveryOutcome` via `computeTurnStatus`, not the speculative flag).
 */
export function buildTurnRecord(
  turn: {
    agent: string
    startedAt: number
    toolCallCount: number
    turnId: string
    finalAnswerDelivered: boolean
    deliveryOutcome?: DeliveryOutcome
  },
  endedAt: number,
): TurnRecordRow {
  return {
    ts: Math.floor(endedAt / 1000),
    agent: turn.agent,
    duration_ms: turn.startedAt > 0 ? endedAt - turn.startedAt : 0,
    tools: turn.toolCallCount ?? 0,
    status: computeTurnStatus(turn),
    turn_id: turn.turnId,
  }
}
