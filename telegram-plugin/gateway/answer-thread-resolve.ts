/**
 * Turn-origin answer-thread resolution (multitopic reply-routing,
 * component 3).
 *
 * Pure decision: which forum-topic thread should an ANSWER reply
 * (`reply` / `stream_reply`) land in?
 *
 * ## The bug this closes
 *
 * In a forum supergroup one sequential `claude` CLI owns every topic with
 * a singleton `currentTurn`. The Brevo turn's reply landed ~42s after its
 * turn-end event; by then `currentTurn` had flipped to the Meta turn.
 * `executeReply` captured `const turn = currentTurn` at execution and, when
 * the model omitted `message_thread_id`, resolved the thread from
 * `turn.sessionThreadId` (Meta's thread) — so Brevo's answer landed in
 * Meta. A successor turn stole a predecessor's late reply.
 *
 * ## The precedence (answer paths)
 *
 *   1. An explicit `message_thread_id` the MODEL passed wins outright —
 *      the model is asserting the destination topic.
 *   2. Else the ORIGIN turn's thread: the turn matched by the reply's
 *      `origin_turn_id` (the meta field the model echoes back). This is
 *      authoritative even when `currentTurn` has flipped, because the
 *      origin turn is looked up in a recently-ended registry.
 *   3. Else the LIVE turn's thread — but ONLY when the live turn IS the
 *      origin turn (no flip happened) OR no origin turn could be resolved
 *      at all (origin id absent/unknown; legacy / pre-stamp path).
 *   4. Else (origin resolved AND it differs from the live turn) we pin to
 *      the origin thread and explicitly DO NOT fall through to the chat's
 *      last-seen `chatThreadMap` thread. For answer surfaces the chat
 *      last-seen heuristic is exactly what produced the wrong-topic bug.
 *
 * The `chatThreadMap` last-seen fallback is preserved for NON-answer
 * surfaces (`send_typing`, `forward_message`, `progress_update`) by NOT
 * routing them through this function — they keep calling `resolveThreadId`
 * directly.
 */

export interface AnswerThreadInput {
  /** Explicit `message_thread_id` the model passed (already coerced to a
   *  number), or undefined when omitted. */
  explicitThreadId?: number | undefined
  /** Thread of the turn matched by `origin_turn_id`, or undefined when the
   *  origin turn is a DM (no thread). Only meaningful when
   *  `originResolved` is true. */
  originThreadId?: number | undefined
  /** Whether an origin turn was resolved at all. Distinguishes
   *  "origin turn exists and its thread is undefined (a DM origin)" from
   *  "no origin turn" — both surface as `originThreadId === undefined`. */
  originResolved: boolean
  /** Thread of the LIVE `currentTurn` at execution time, or undefined
   *  (no live turn, or a DM live turn). The legacy (#1664) fallback when
   *  no origin turn is resolvable. */
  liveThreadId?: number | undefined
}

/**
 * Pure. Returns the thread id to send the answer to, or undefined for the
 * main chat (DM / no thread).
 *
 * Precedence: explicit model thread → origin turn's thread (authoritative
 * across a currentTurn flip; this is the wrong-topic fix) → live turn's
 * thread (legacy #1664 fallback when origin can't be resolved). Crucially
 * the chat last-seen `chatThreadMap` heuristic is NOT in this chain — that
 * heuristic is what produced the Brevo→Meta wrong-topic bug, so answer
 * paths never reach it.
 */
export function resolveAnswerThreadId(input: AnswerThreadInput): number | undefined {
  // (1) explicit model thread wins.
  if (input.explicitThreadId != null) return input.explicitThreadId
  // (2) origin turn resolved → pin to its thread (authoritative even when
  //     currentTurn has flipped to a successor). A DM origin yields
  //     undefined, which is correct.
  if (input.originResolved) return input.originThreadId
  // (3) no origin resolved (legacy / pre-stamp / evicted) → fall back to
  //     the live turn's thread, the existing turn-pinned behaviour (#1664).
  return input.liveThreadId
}
