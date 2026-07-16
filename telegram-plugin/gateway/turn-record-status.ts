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
  // Defense (Fix 5): a "send" that split into zero chunks delivered nothing —
  // do NOT let sentCount(0) < chunkCount(0) === false slip through to
  // 'delivered'/'complete' (which would trip the silent-no-op-candidate
  // detector on a tools:0 turn). Nothing sent → failed.
  if (args.chunkCount === 0) return 'failed'
  if (args.sentCount < args.chunkCount) return 'failed'
  return 'delivered'
}

/**
 * Resolve a backstop send's outcome using the #3276 RECEIPT gate: success
 * requires at least one FRESH, non-card chat message id. This supersedes the
 * naive chunk-count comparison for the turn-flush backstop, where a delivery
 * that landed only onto the (soon-swept) progress card must count as a failure,
 * not `complete`.
 *
 *   threw                              → failed
 *   no fresh non-card id delivered     → failed  (card-only "success")
 *   fewer fresh ids than chunks split  → failed  (partial delivery)
 *   >=1 fresh id AND all chunks landed → delivered
 *
 * `cardMessageId` is the taken-over progress-card id (or null); any id equal to
 * it is excluded from the delivered set before counting.
 */
export function backstopSendOutcomeGated(args: {
  threw: boolean
  sentIds: readonly number[]
  chunkCount: number
  cardMessageId: number | null
}): DeliveryOutcome {
  if (args.threw) return 'failed'
  if (args.chunkCount === 0) return 'failed'
  const freshCount = args.sentIds.filter(
    id => args.cardMessageId == null || id !== args.cardMessageId,
  ).length
  // Guard 7: a card-only delivery (zero fresh ids) is a hard failure.
  if (freshCount === 0) return 'failed'
  if (freshCount < args.chunkCount) return 'failed'
  return 'delivered'
}

/**
 * Stamp a turn's `deliveryOutcome` from a resolved backstop send using the
 * #3276 receipt gate (fresh non-card ids only). Mutates and returns the outcome.
 */
export function finalizeBackstopSendGated(
  turn: { deliveryOutcome?: DeliveryOutcome },
  send: { threw: boolean; sentIds: readonly number[]; chunkCount: number; cardMessageId: number | null },
): DeliveryOutcome {
  const outcome = backstopSendOutcomeGated(send)
  turn.deliveryOutcome = outcome
  return outcome
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
  send: { threw: boolean; sentCount: number; chunkCount: number },
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
