/**
 * Turn-origin answer-thread resolution (multitopic reply-routing,
 * component 3).
 *
 * Pure decision: which forum-topic thread should an ANSWER reply
 * (`reply` / `stream_reply`) land in?
 *
 * ## The bugs this closes
 *
 * **(a) currentTurn flip (2026-06-05).** In a forum supergroup one sequential
 * `claude` CLI owns every topic with a singleton `currentTurn`. A late reply
 * landed after `currentTurn` had flipped to a successor topic, so the answer
 * went to the wrong topic. Fixed by pinning to the ORIGIN turn's thread (tier 1).
 *
 * **(b) model-chosen topic override (2026-06-08).** A General-topic question's
 * answer landed in the CRM topic because the model passed an explicit
 * `message_thread_id` and the resolver let that win OUTRIGHT over the
 * framework's record of where the question came from. General is the trap: its
 * messages carry no thread id, so nothing forces the reply back — and the
 * model's explicit "post to CRM" overrode the General origin. The user, reading
 * General, saw silence. This is a model-dependency: a reply's topic must not be
 * the model's free choice.
 *
 * ## The precedence (answer paths) — FRAMEWORK AUTHORITY (default)
 *
 * The topic a reply lands in is owned by the TURN it answers, not the model's
 * `message_thread_id`. The model's explicit thread is demoted to a last resort
 * — used only when the framework has NO turn anchor at all (a genuinely
 * orphaned / proactive send). Precedence:
 *
 *   1. ORIGIN turn's thread — the turn matched by the reply's `origin_turn_id`
 *      (echoed) or a quoted `reply_to` (framework reverse-index). Authoritative
 *      even when `currentTurn` flipped (closes bug a). A General/DM origin
 *      yields `undefined`, which correctly routes to the main chat / General.
 *   2. LIVE in-flight turn's thread — keyed on the turn's PRESENCE, not its
 *      thread value, so a General live turn (thread `undefined`) still anchors
 *      the reply to the General conversation. The model's explicit cannot
 *      redirect a reply that belongs to an in-flight turn (closes bug b).
 *   3. EXPLICIT model thread — only now, when there is neither an origin nor a
 *      live turn (a late / proactive send with no framework anchor). Here the
 *      model's `message_thread_id` is the only signal, so honour it.
 *   4. LATE-reply recovery — no explicit, no origin, no live turn: recover the
 *      origin topic from the most-recently-ended turn for this chat, so an
 *      orphaned-backstop reply lands in its topic instead of defaulting to the
 *      main chat (General). Not the `chatThreadMap` last-seen heuristic.
 *
 * Setting `frameworkTopicAuthority: false` (kill switch
 * SWITCHROOM_REPLY_TOPIC_AUTHORITY=0) restores the legacy explicit-first
 * precedence (the model's thread wins outright).
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
   *  "origin turn exists and its thread is undefined (a DM/General origin)" from
   *  "no origin turn" — both surface as `originThreadId === undefined`. */
  originResolved: boolean
  /** Thread of the LIVE `currentTurn` at execution time, or undefined
   *  (no live turn, or a DM/General live turn). */
  liveThreadId?: number | undefined
  /** Whether a LIVE in-flight turn exists at execution time. Distinguishes a
   *  General (thread-undefined) live turn — still a valid framework anchor —
   *  from no live turn at all. Mirrors `originResolved`. Absent in the legacy
   *  path (which keys off `liveThreadId != null`). */
  liveTurnPresent?: boolean
  /**
   * Late-reply topic recovery (2026-06-05). Thread of the most-recently-ended
   * turn for THIS chat (from `recentTurnsById`), used as a deterministic
   * fallback when the model echoed no `origin_turn_id` AND there is no live
   * turn — the late-reply-after-turn-end case. Without it, a reply that fires
   * after the orphaned-reply backstop closed its turn defaults to the main chat
   * (General topic in a supergroup), so its answer vanishes from the topic the
   * user is reading. A DM origin yields undefined, which is correct.
   */
  lastEndedThreadIdForChat?: number | undefined
  /** Whether a recently-ended turn exists for this chat — distinguishes
   *  "ended turn exists, DM (thread undefined)" from "no ended turn at all". */
  lastEndedResolvedForChat?: boolean
  /**
   * When true (default), the framework's turn anchor (origin → live) owns the
   * reply topic and the model's `explicitThreadId` is a last resort (consulted
   * only when no anchor exists). When false, the legacy explicit-first
   * precedence (the model's thread wins outright). Undefined is treated as
   * true. Kill switch SWITCHROOM_REPLY_TOPIC_AUTHORITY=0.
   */
  frameworkTopicAuthority?: boolean
}

/**
 * Pure. Returns the thread id to send the answer to, or undefined for the
 * main chat (DM / General / no thread).
 *
 * Default (framework authority): origin turn → live in-flight turn → explicit
 * model thread → late-ended recovery. The model's `explicitThreadId` cannot
 * override a resolved origin or a live turn — it is consulted only when neither
 * exists. The chat last-seen `chatThreadMap` heuristic is NOT in this chain.
 */
export function resolveAnswerThreadId(input: AnswerThreadInput): number | undefined {
  if (input.frameworkTopicAuthority === false) {
    // ── Legacy precedence (kill switch): the model's explicit thread wins. ──
    if (input.explicitThreadId != null) return input.explicitThreadId
    if (input.originResolved) return input.originThreadId
    if (input.liveThreadId != null) return input.liveThreadId
    if (input.lastEndedResolvedForChat) return input.lastEndedThreadIdForChat
    return input.liveThreadId
  }
  // ── Framework-authority precedence (default) ───────────────────────────────
  // (1) origin turn → its thread (authoritative across a currentTurn flip; a
  //     General/DM origin yields undefined → main chat / General).
  if (input.originResolved) return input.originThreadId
  // (2) a live in-flight turn → its thread. Key off PRESENCE, not the thread
  //     value: a General live turn has an undefined thread but is still the
  //     anchor, so the model's explicit can't pull the reply out of it.
  if (input.liveTurnPresent) return input.liveThreadId
  // (3) no framework anchor (genuinely orphaned / proactive) → honour the
  //     model's explicit thread, its only signal here.
  if (input.explicitThreadId != null) return input.explicitThreadId
  // (4) late reply, no anchor, no explicit → recover the chat's last-ended topic.
  if (input.lastEndedResolvedForChat) return input.lastEndedThreadIdForChat
  return input.liveThreadId
}
