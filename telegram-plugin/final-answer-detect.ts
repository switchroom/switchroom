/**
 * final-answer-detect.ts — #1664 "did this reply deliver the final answer?"
 *
 * Background. An agent often ends a turn with its real answer as plain
 * assistant transcript text instead of a `reply` / `stream_reply` tool
 * call. The gateway renders that transcript as a live Telegram draft
 * (`sendMessageDraft`) and, at turn_end, retracts the draft — so the
 * answer is never finalized and the user watches it vanish (#1664).
 *
 * The gateway's `replyCalled` flag flips on the FIRST reply / stream_reply
 * tool use and stays true for the rest of the turn. It cannot distinguish
 * "the model sent an interim ack" from "the model sent its real answer" —
 * both set `replyCalled`. The silent-end re-prompt safety net needs a
 * finer signal: it must engage when a turn ended with only an interim
 * ack and the real answer left as transcript text.
 *
 * This module is that finer signal — a pure predicate the gateway calls
 * for each reply that lands. A turn whose every reply was classified
 * "interim" ends with `CurrentTurn.finalAnswerDelivered === false`, which
 * triggers the re-prompt; a turn with at least one "final" reply does not.
 *
 * Keeping the policy in one unit-testable function is the point — the
 * gateway is a multi-thousand-line module that's expensive to import in a
 * test. See `telegram-plugin/tests/final-answer-detect.test.ts`.
 *
 * The fix re-prompts the model; it never materializes the draft into a
 * message (`reference/principles.md`: the model communicates, the
 * framework is the safety net). So a false "interim" classification is
 * cheap (one extra re-prompt) and a false "final" classification is the
 * dangerous one (a real answer left undelivered) — the length backstop
 * exists to make the dangerous miss rare.
 */

/**
 * Length backstop for the final-answer classification. The pacing
 * contract (`docs/telegram-style.md`) says interim updates pass
 * `disable_notification: true` and the final answer omits it — so a
 * notification-bearing reply is the primary "final answer" signal. But a
 * model that mis-marks a genuinely substantive reply as interim
 * (`disable_notification: true` on what is really the answer) would
 * otherwise leave the turn looking undelivered. Any reply at or above
 * this many characters therefore ALSO counts as the final answer,
 * regardless of the notification flag. 200 chars is comfortably longer
 * than a typical interim ack ("on it", "looking into that…", "give me a
 * sec") and short enough that a real answer almost always clears it.
 */
export const FINAL_ANSWER_MIN_CHARS = 200

export interface FinalAnswerReplyInput {
  /** The reply text the model sent (the model's own answer text, before
   * any HTML conversion or Telegraph-link substitution). */
  text: string
  /** The `disable_notification` argument the reply tool was called with.
   * `true` is the pacing contract's "interim update" marker; the final
   * answer omits it (effectively `false`). */
  disableNotification: boolean
  /** For `stream_reply` only: whether this call carried `done: true`. A
   * `done: true` call explicitly closes the stream and IS the final
   * answer by definition. Pass `false` for the plain `reply` tool. */
  done?: boolean
}

/**
 * Pure predicate: did this reply deliver the turn's final answer (as
 * opposed to an interim ack)? `true` if ANY of:
 *
 *   - `done === true` — a `stream_reply` terminal call; the model
 *     explicitly closed the stream, so this is the final answer.
 *   - `disableNotification === false` — the pacing contract's explicit
 *     "final answer" signal (interim updates set it `true`).
 *   - `text.length >= FINAL_ANSWER_MIN_CHARS` — the length backstop for
 *     a substantive answer mis-marked as interim.
 *
 * The gateway ORs this across every reply in a turn; once one reply
 * qualifies, `CurrentTurn.finalAnswerDelivered` latches true and the
 * silent-end re-prompt will not engage for that turn.
 */
export function isFinalAnswerReply(input: FinalAnswerReplyInput): boolean {
  if (input.done === true) return true
  if (!input.disableNotification) return true
  if (input.text.length >= FINAL_ANSWER_MIN_CHARS) return true
  return false
}

/**
 * Pure predicate: was this reply a *substantive* final answer (as opposed
 * to a reply that is only "final" because it pinged)? `true` if EITHER:
 *
 *   - `done === true` — a `stream_reply` terminal call closing the stream.
 *   - `text.length >= FINAL_ANSWER_MIN_CHARS` — a substantive-length answer.
 *
 * This is `isFinalAnswerReply` MINUS the notification-only path. The
 * distinction matters for the feed-reopen-after-ack gate
 * (`feed-reopen-gate.ts`): a *short pinging* reply ("on it, checking
 * Brevo…") is classified final by `isFinalAnswerReply` (because it pings)
 * yet is NOT substantive — it is an interim ACK. Only such an ack should
 * cause the live activity feed to re-open when post-ack tool work arrives.
 *
 * A genuine final answer (long, or a stream `done: true`) followed by
 * routine post-answer housekeeping (a memory write / TodoWrite / Bash —
 * none of which are surface tools, so they reach the tool_label handler)
 * must NOT re-open the feed and must NOT reset `finalAnswerDelivered`,
 * otherwise the silent-end re-prompt would spuriously fire and the agent
 * would re-deliver a duplicate / garbled answer.
 *
 * Residual: a reply that is genuinely the final answer yet is BOTH short
 * (<200 chars) AND pinging (e.g. "Done!") is indistinguishable here from
 * an ack, so post-answer housekeeping after it still re-opens the feed.
 * That is much rarer than the housekeeping-after-long-answer case this
 * predicate protects, and is kill-switchable via
 * `SWITCHROOM_FEED_REOPEN_AFTER_ACK=0`.
 */
export function isSubstantiveFinalReply(input: FinalAnswerReplyInput): boolean {
  if (input.done === true) return true
  if (input.text.length >= FINAL_ANSWER_MIN_CHARS) return true
  return false
}
