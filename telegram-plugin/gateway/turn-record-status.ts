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

/**
 * The ONE way a turn's `duration_ms` is computed, shared by every emitter
 * (`buildTurnRecord` → turns.jsonl, and all three `turn_ended` runtime-metric
 * sites: the two stream-render turn-end paths + the liveness framework_fallback).
 *
 * Why a single helper: the three `turn_ended` emitters each hand-rolled the
 * subtraction, and one drifted. `stream-render.ts` guarded with
 * `startedAt > 0 ? now - startedAt : 0`; the framework_fallback path in
 * `liveness-wiring.ts` did a bare `Date.now() - turnStartedAt` with only a
 * `!= null` presence check. When `activeTurnStartedAt` held `0` (or any
 * non-positive / non-finite value), that path emitted `duration_ms = now - 0`,
 * i.e. the absolute Unix-epoch-ms — a ~56,000-year "duration". This poisoned the
 * analysed turn_ended dataset (observed: 110 rows where `duration_ms === ts`),
 * making every latency aggregate unusable.
 *
 * The invariant this helper enforces: a `duration_ms` is ALWAYS a non-negative
 * elapsed-milliseconds value derived from a positive, finite start stamp — never
 * an absolute epoch value, never negative (clock step back), never NaN. A start
 * that is missing / zero / bogus yields `0` (a bounded, filterable sentinel)
 * instead of a value that destroys aggregates.
 */
export function computeTurnDurationMs(
  startedAt: number | null | undefined,
  now: number,
): number {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) {
    return 0
  }
  return Math.max(0, now - startedAt)
}

/** The status strings written to turns.jsonl. `send_failed` is new in PR B. */
export type TurnStatus = 'complete' | 'no_reply' | 'send_failed'

/**
 * How this turn's answer actually reached (or failed to reach) the user — the
 * honest delivery route, recorded alongside `status` so the fleet-health
 * detector can tell a flush-recovered turn apart from a genuine silent no-op.
 *
 * - `reply`  — the reply tool delivered the answer (the normal path), OR the
 *              flush short-circuited because reply had already delivered.
 * - `stream` — the answer landed via the streaming/draft path without a reply
 *              tool call (final answer delivered, `replyCalled` false).
 * - `flush`  — a turn-flush / outbox-sweep backstop delivered the answer after
 *              the reply tool was bypassed (terminal prose, `tools:0`). This is
 *              the case that used to masquerade as a silent no-op.
 * - `none`   — nothing reached the user (send failed, or a genuine no-reply).
 */
export type TurnRoute = 'reply' | 'stream' | 'flush' | 'none'

/**
 * Epoch of when the honest `route` field shipped on turns.jsonl rows — a FIXED
 * literal cutoff the fleet-health detector uses to age out the pre-route legacy
 * backlog (rows written before this field existed carry no `route`, so the
 * detector cannot classify them and must not escalate them as silent no-ops).
 *
 * UNIX SECONDS, not milliseconds: turns.jsonl `ts` is written as
 * `Math.floor(endedAt / 1000)` (see `buildTurnRecord`), and the detector
 * compares this constant against that seconds-valued `ts`. It intentionally
 * mirrors the units of `SILENT_NOOP_FLOOR_TS` in `src/fleet-health/detect.ts`.
 *
 * Value = 2026-07-31T00:00:00Z (`date -u -d @1785456000`). Fixed, not rolling:
 * a rolling window would hide a genuine ongoing regression that drops the field.
 */
export const ROUTE_FIELD_SHIP_TS = 1_785_456_000

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
 * Derive the honest delivery `route` from the SAME resolved delivery state
 * `computeTurnStatus` reads — never speculative. `deliveryOutcome` (when
 * present) is authoritative; when absent we fall back to the legacy
 * `finalAnswerDelivered` / `replyCalled` reading, exactly as `computeTurnStatus`
 * does for `status`.
 *
 *   failed              → none    (nothing reached the user)
 *   delivered           → flush   (a backstop send delivered the answer)
 *   suppressed          → reply   (flush short-circuited; reply already delivered)
 *   undefined (legacy)  → finalAnswerDelivered
 *                            ? (replyCalled ? reply : stream)
 *                            : none
 */
export function computeTurnRoute(turn: {
  finalAnswerDelivered: boolean
  replyCalled: boolean
  deliveryOutcome?: DeliveryOutcome
}): TurnRoute {
  switch (turn.deliveryOutcome) {
    case 'failed':
      return 'none'
    case 'delivered':
      return 'flush'
    case 'suppressed':
      return 'reply'
    default:
      return turn.finalAnswerDelivered
        ? turn.replyCalled
          ? 'reply'
          : 'stream'
        : 'none'
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
  /**
   * The honest delivery route for this turn (see `TurnRoute`). Recorded on every
   * row so the fleet-health detector can distinguish a flush-recovered turn
   * (`route: 'flush'`, answer delivered by a backstop after the reply tool was
   * bypassed) from a genuine silent no-op (`route: 'none'`). Always emitted.
   */
  route: TurnRoute
  /**
   * How many landed message ids of this turn's backstop delivery the read-back
   * probe never corroborated (`sentIds` minus the confirmed subset). OMITTED
   * when zero, so an ordinary row is byte-identical to before.
   *
   * This is the measurable counterpart of the delivery verdict: since an
   * inconclusive probe counts as delivered, a `complete` row carrying
   * `landed_unconfirmed > 0` is a turn we called delivered on the Bot API's
   * ack alone. Counting those is how the fleet can tell whether that optimism
   * is ever wrong (a `landed_unconfirmed` turn followed by a "you never
   * answered me" is the falsifying observation). It is NOT a failure signal and
   * nothing escalates on it.
   */
  landed_unconfirmed?: number
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
    replyCalled?: boolean
    deliveryOutcome?: DeliveryOutcome
    landedUnconfirmed?: number
  },
  endedAt: number,
): TurnRecordRow {
  return {
    ts: Math.floor(endedAt / 1000),
    agent: turn.agent,
    duration_ms: computeTurnDurationMs(turn.startedAt, endedAt),
    tools: turn.toolCallCount ?? 0,
    status: computeTurnStatus(turn),
    turn_id: turn.turnId,
    route: computeTurnRoute({
      finalAnswerDelivered: turn.finalAnswerDelivered,
      replyCalled: turn.replyCalled ?? false,
      deliveryOutcome: turn.deliveryOutcome,
    }),
    // Emitted ONLY when non-zero (see `TurnRecordRow.landed_unconfirmed`).
    ...(turn.landedUnconfirmed != null && turn.landedUnconfirmed > 0
      ? { landed_unconfirmed: turn.landedUnconfirmed }
      : {}),
  }
}
