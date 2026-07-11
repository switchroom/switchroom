// #1667 — pure decision core for the `turn_end` handler's answer-delivery
// gate (originally landed inline in `gateway.ts` by #1664).
//
// The gateway's `case 'turn_end':` block resolves, in strict order, which of
// four terminal dispositions a just-ended turn takes:
//
//   1. silent-marker suppression  — the model's only output was a silent-turn
//      sentinel (NO_REPLY / HEARTBEAT_OK, or composite/ trailing silent
//      noise). `decideTurnFlush` returns `{kind:'skip', reason:'silent-marker'}`.
//      The gateway suppresses the card without a "Done" edit and returns.
//   2. turn-flush                 — the model skipped reply/stream_reply but
//      left substantive terminal prose; `decideTurnFlush` returns
//      `{kind:'flush', text}`. The gateway delivers that prose as the answer
//      (setting `finalAnswerDelivered = true`) and returns.
//   3. re-prompt (#1664 gate)     — the reply-called tail. The turn neither
//      suppressed nor flushed, and `finalAnswerDelivered === false`: the model
//      sent only an interim ack (or nothing) and never delivered a real
//      answer. The silent-end machinery re-prompts so the answer lands.
//   4. none                       — the reply-called tail with
//      `finalAnswerDelivered === true`: a genuine final answer was delivered;
//      no re-prompt.
//
// This module hoists that ordering into a single pure function so it is
// testable against the code the gateway actually runs (the gateway's
// `turn_end` case delegates to `decideTurnEndGate`). It is a strictly
// behaviour-preserving extraction — the exact conditionals and their order,
// no logic change.
//
// What deliberately remains inline in the gateway (side effects, not
// decisions): the synthetic-backstop `durationMs === -1` suppression, the
// `turn == null` guard, the answer-stream materialize/retract block (which may
// set `finalAnswerDelivered = true` BEFORE this gate is consulted), and every
// disposition's actual teardown / send / telemetry. Those are not part of the
// decision — they are what each decision drives. The gate is computed once,
// immediately after `flushDecision`, reading `finalAnswerDelivered` at its
// tail value (the answer-stream branch has already run by then; the flush
// branch, which also sets it, is not yet entered and does not influence the
// gate's own outcome).

import type { FlushDecision } from '../turn-flush-safety.js'

/**
 * The terminal disposition of a `turn_end`, in the gateway's evaluation order.
 * - `silent_end`  → silent-marker suppression path (no reply, no card edit).
 * - `flush`       → turn-flush delivers the model's terminal prose as the answer.
 * - `reprompt`    → #1664 gate: no final answer delivered → silent-end re-prompt.
 * - `none`        → final answer delivered; normal terminal, no re-prompt.
 */
export type TurnEndDecision = 'silent_end' | 'flush' | 'reprompt' | 'none'

export interface TurnEndGateSnapshot {
  /** The result of `decideTurnFlush(...)` for this turn (or the synthetic
   * `{kind:'skip', reason:'reply-called'}` the gateway substitutes when the
   * answer-stream already materialised the answer). */
  flushDecision: FlushDecision
  /**
   * `turn.finalAnswerDelivered` at the point the gate is consulted — i.e. after
   * the answer-stream materialize branch may have set it true, but reflecting
   * whether a genuine final answer (not a bare interim ack) has been delivered.
   * Only consulted on the reply-called tail (neither silent-marker nor flush).
   */
  finalAnswerDelivered: boolean
}

/**
 * Pure decision core for the `turn_end` answer-delivery gate. Mirrors the
 * gateway's branch ordering exactly: silent-marker early-return, then
 * turn-flush early-return, then the `finalAnswerDelivered === false` re-prompt
 * gate, else no re-prompt. No side effects.
 */
export function decideTurnEndGate(snapshot: TurnEndGateSnapshot): TurnEndDecision {
  const { flushDecision, finalAnswerDelivered } = snapshot

  // 1. Silent-marker suppression takes precedence: the model's only output was
  //    a silent-turn sentinel. Suppress without a card edit; never re-prompt.
  if (flushDecision.kind === 'skip' && flushDecision.reason === 'silent-marker') {
    return 'silent_end'
  }

  // 2. Turn-flush: the model left substantive terminal prose without calling
  //    the reply tool. Deliver it as the answer; the turn IS answered.
  if (flushDecision.kind === 'flush') {
    return 'flush'
  }

  // 3. Reply-called tail. #1664: the trigger is "no final answer delivered",
  //    not "zero outbound". An interim-ack-only turn (reply called, but
  //    finalAnswerDelivered still false) re-prompts; a delivered final answer
  //    does not. A zero-outbound turn also lands here with
  //    finalAnswerDelivered === false and re-prompts.
  if (finalAnswerDelivered === false) {
    return 'reprompt'
  }
  return 'none'
}
