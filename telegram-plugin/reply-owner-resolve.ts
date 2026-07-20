/**
 * Reply owner-turn resolution + answer-delivered latch decision
 * (2026-07 double-reply-on-DM fix — completes the #3236 turnId-keyed dedup for
 * the late-reply / DM path).
 *
 * ## The bug this closes
 *
 * On a DM agent a turn double-sent: the answer-ready quiescence flush posted the
 * composed terminal answer as message A (no quote), then the model's REAL `reply`
 * tool call landed a moment later and sent message B (quoted). The user should
 * have received exactly ONE message (the quoted reply).
 *
 * #3236 shipped `flushed-turn-supersede.ts` — a turnId-identity-keyed dedup that
 * is text-agnostic BY DESIGN. It missed here not because of the text rewording
 * but because the reply's owner turn resolved to `null` on the late path:
 *
 *   - At reply consumption the gateway resolved the owner turn as
 *     `currentTurn ?? findTurnByOriginId(origin_turn_id) ?? null`.
 *   - `currentTurn` was already nulled by the flush's synthetic turn_end.
 *   - `origin_turn_id` is a forum-supergroup field, ABSENT in DMs, so
 *     `findTurnByOriginId` returned null.
 *   - ⇒ the resolved live turnId was `null`, and `decideSupersede` deliberately
 *     never lets a null live turn supersede a turnId-bearing flush record. No
 *     supersede fired → message A survived AND the reply sent message B.
 *
 * The DECISIVE divergence: the gateway's *thread-routing* path DID recover the
 * owner turn for the same late reply — via `findTurnByQuotedMessageId` (the
 * framework-owned default quote target) and `findLatestEndedTurnForChat` (the
 * chat's most-recently-ended turn). The supersede resolver chain omitted BOTH
 * recoveries, so the two resolvers disagreed on who owned the reply. This module
 * unifies them onto ONE precedence so they can never diverge again.
 *
 * ## Why a pure module
 *
 * `gateway.ts` is not importable in tests (heavy top-level side effects), so the
 * repo's convention — `decideTurnFlush`, `decideSupersede`,
 * `decideCapturedProseDelivery` — is to extract the decision core into a pure,
 * unit-testable function and have the gateway run the EXACT code the regression
 * tests exercise. The gateway performs the four turn lookups (currentTurn,
 * findTurnByOriginId, findTurnByQuotedMessageId, findLatestEndedTurnForChat) and
 * feeds their resolved turnIds here; the precedence lives in one place.
 */

/**
 * The four owner-turn candidate ids, in the gateway's resolution precedence.
 * Each is the `turnId` of the turn a given lookup resolved, or null when that
 * lookup found nothing.
 */
export interface ReplyOwnerCandidates {
  /** The LIVE `currentTurn` at reply-consumption time (null once the flush's
   *  synthetic turn_end has torn the atom down — the late-reply case). */
  liveTurnId: string | null
  /** `findTurnByOriginId(origin_turn_id)` — the turn the model echoed back.
   *  Null in DMs (no `origin_turn_id`) and when the model omitted the echo. */
  originTurnId: string | null
  /** `findTurnByQuotedMessageId(chat_id, reply_to)` — the framework-owned
   *  quoted message id, resolved with NO model thread assertion. */
  quotedTurnId: string | null
  /** `findLatestEndedTurnForChat(chat_id)` — the chat's most-recently-ended
   *  turn. The deterministic late-reply fallback (the DM path's recovery). */
  latestEndedTurnId: string | null
  /** Age (ms) of the latest-ended turn — `now - turn.endedAt`. The latest-ended
   *  tier carries DESTRUCTIVE authority (it drives supersede deletion), so it is
   *  honoured ONLY when the turn ended within `latestEndedTtlMs` (the supersede
   *  TTL). Without the bound, a late reply belonging to an OLDER turn could
   *  resolve its owner to a NEWER turn now sitting at the registry tail and
   *  delete THAT turn's legit answer. Undefined/null ⇒ unbounded (back-compat:
   *  callers that don't supply an age keep the pre-F2 behaviour). */
  latestEndedAgeMs?: number | null
  /** The supersede TTL bound applied to `latestEndedAgeMs`. Undefined ⇒
   *  unbounded. */
  latestEndedTtlMs?: number
}

/**
 * Whether the latest-ended candidate is fresh enough to carry supersede
 * (deletion) authority. A missing age or TTL means unbounded (back-compat).
 */
function latestEndedAccepted(candidates: ReplyOwnerCandidates): boolean {
  if (candidates.latestEndedTurnId == null) return false
  const age = candidates.latestEndedAgeMs
  const ttl = candidates.latestEndedTtlMs
  if (age == null || ttl == null) return true
  return age <= ttl
}

/**
 * Which precedence tier resolved a reply's owner turn.
 *
 *   - `'live'` / `'origin'` / `'quoted'` are POSITIVE attributions: the reply
 *     is tied to a specific turn by a live atom, the model's own echo, or the
 *     framework-owned quoted message id — it IS that turn's answer.
 *   - `'latest-ended'` is the ambiguous FALLBACK: no positive link exists, so
 *     the reply is merely attributed to the chat's most-recently-ended turn.
 *     This tier cannot tell the turn's OWN late reply from an async sub-agent
 *     handback that has no live turn and no quote linkage — both land here with
 *     the same resolved turnId (#3429). The supersede content gate
 *     (`flushedAnswerMatchesReply`) is therefore applied ONLY on this tier.
 *   - `'none'` — every lookup missed (a genuinely unattributable reply).
 */
export type ReplyOwnerTier = 'live' | 'origin' | 'quoted' | 'latest-ended' | 'none'

/**
 * The tier that WINS owner resolution for these candidates — the single source
 * of the precedence order, consumed by both `resolveReplyOwnerTurnId` (which id)
 * and the gateway (which discrimination the supersede applies). Same precedence,
 * first non-null wins; the destructive latest-ended tier is honoured only when
 * fresh (`latestEndedAccepted`).
 */
export function resolveReplyOwnerTier(candidates: ReplyOwnerCandidates): ReplyOwnerTier {
  if (candidates.liveTurnId != null) return 'live'
  if (candidates.originTurnId != null) return 'origin'
  if (candidates.quotedTurnId != null) return 'quoted'
  if (latestEndedAccepted(candidates)) return 'latest-ended'
  return 'none'
}

/**
 * Resolve the turnId that OWNS a landing reply, using the SAME full chain the
 * thread-router uses. Precedence, first non-null wins:
 *
 *   1. the live `currentTurn`;
 *   2. the model-echoed `origin_turn_id` turn;
 *   3. the framework-owned quoted-message turn;
 *   4. the chat's most-recently-ended turn.
 *
 * Returns null only when EVERY lookup missed (a genuinely unattributable reply),
 * in which case `decideSupersede` keeps its null-safety semantics and declines
 * to delete any turnId-bearing flush record.
 */
export function resolveReplyOwnerTurnId(candidates: ReplyOwnerCandidates): string | null {
  switch (resolveReplyOwnerTier(candidates)) {
    case 'live':
      return candidates.liveTurnId
    case 'origin':
      return candidates.originTurnId
    case 'quoted':
      return candidates.quotedTurnId
    case 'latest-ended':
      return candidates.latestEndedTurnId
    case 'none':
      return null
  }
}

/**
 * The answer-delivered latch value — SOURCE-TAGGED (#3426).
 *
 * `false`   — no answer delivered this turn (latch unarmed).
 * `'flush'` — the TURN-FLUSH backstop delivered (or is mid-delivering) this
 *             turn's answer as its own message A. Set synchronously at
 *             flush-fire time, and at supersede-record consumption (the
 *             resurrection window — a flush record existed for this turn).
 * `'reply'` — a normally-delivered `reply` tool call carried this turn's
 *             answer (no flush involved).
 *
 * Why the tag exists: the late-reply suppression below is a race backstop for
 * FLUSH duplicates only. A boolean latch also suppressed the async sub-agent
 * handback pattern (#3426): the parent turn's interim ack (a substantive
 * `reply`) armed the latch, the turn ended, and the sub-agent completion
 * handback — a genuinely NEW answer arriving with no live gateway turn —
 * resolved the ended turn as owner (latest-ended tier, inside the 60 s
 * supersede TTL), saw the stale latch, and was silently dropped with a false
 * "deduped" success. Tagging the source lets the suppression fire ONLY for the
 * flush races it exists for; byte-identical replays of a reply-delivered
 * answer remain covered by the content-keyed outbound dedup (#546).
 *
 * Honest bound on that dedup cover: the #546 TTL (60 s) is anchored at reply
 * RECORD time, while the latest-ended owner tier's 60 s is anchored at the
 * turn's `endedAt` — later by the reply→turn_end gap. A byte-identical replay
 * landing >60 s after record but ≤60 s after endedAt is evicted from dedup yet
 * still resolves the ended turn, so it DELIVERS as a duplicate message. That
 * is a conscious trade: this fix also drops the weak "reworded/bridge-replayed
 * duplicate" suppression the reply-armed boolean latch used to provide —
 * replays of an un-acked tool_call are byte-identical (content dedup's case),
 * and a model-REGENERATED paraphrase is indistinguishable from a genuinely new
 * handback, so delivering it is the correct default. A rare duplicate message
 * beats the silent handback drop.
 */
export type AnswerDeliveredLatch = false | 'flush' | 'reply'

/**
 * The answer-delivered latch inputs (Part 2 — the race backstop).
 *
 * The unified resolver (Part 1) closes the common late-reply case where the
 * flush fully COMPLETED (recorded its supersede entry) before the reply landed:
 * supersede then deletes message A and the reply delivers as the single clean
 * message B. But a residual race remains — a reply whose supersede `take()` runs
 * in the window AFTER the flush FIRED but BEFORE it recorded its message ids.
 * There `flushed-turn-supersede` finds no record (nothing to delete yet) and the
 * reply would ship message B as a duplicate of the flush's message A.
 *
 * The latch closes that window: the gateway sets `answerDelivered = 'flush'` on
 * the turn atom SYNCHRONOUSLY at flush-fire time — before the ~500 ms async send
 * and before the record — and the flag persists on the ended turn (readable via
 * the unified resolver after `currentTurn` is null). A reply landing in the race
 * window then sees the flush latch already set and suppresses itself.
 */
export interface AnswerLatchSuppressInput {
  /** True when Part 1's supersede already fired for THIS reply (message A was
   *  deleted and this reply IS the sanctioned replacement). The latch must NOT
   *  then also suppress — that would leave the turn with ZERO messages. */
  superseded: boolean
  /** True when the landing reply is a substantive terminal answer (the same
   *  ≥200-char `FINAL_ANSWER_MIN_CHARS` floor the flush latch is scoped to).
   *  A sub-floor interim ack (short, `disable_notification`) is never a final
   *  answer, so it neither sets nor trips the latch. */
  replySubstantive: boolean
  /** True when this is a LATE reply — `currentTurn` was already null at
   *  consumption. The flush-duplicate ALWAYS lands late (the flush's synthetic
   *  turn_end nulled the atom); scoping suppression to the late path leaves a
   *  legitimate second in-turn substantive reply (a genuine multi-message
   *  answer, live currentTurn) untouched. */
  isLateReply: boolean
  /** The resolved owner turn's source-tagged `answerDelivered` latch. */
  ownerAnswerDelivered: AnswerDeliveredLatch
  /** #3429 — content evidence: does the landing reply carry the SAME answer
   *  the flush delivered (`flushedAnswerMatchesReply` against the supersede
   *  record's text or the owner turn's stashed `flushedAnswerText`)?
   *    - `false`  → POSITIVE evidence of genuinely new content (an async
   *                 handback attributed to the flush-delivered ended turn).
   *                 Suppressing it would silently drop the user's answer —
   *                 never suppress.
   *    - `true`   → the reply is the flushed answer landing again — suppress
   *                 (the flush race the latch exists for).
   *    - `null` / omitted → no flushed text available to compare (legacy atom,
   *                 pre-#3429 caller). Conservative: keep the pre-#3429
   *                 flush-armed suppression. */
  replyMatchesFlushedAnswer?: boolean | null
}

/**
 * Decide whether the answer-delivered latch suppresses a landing reply.
 *
 * Suppress IFF: Part 1 did NOT already supersede, the reply is a substantive
 * final answer, it is a late reply (no live turn), AND the owner turn's latch
 * was armed by the TURN-FLUSH path (`'flush'` — the flush delivered the same
 * substantive answer as message A in the pre-record race window, or the
 * supersede-consumed resurrection window). Otherwise the reply sends.
 *
 * A `'reply'`-armed latch deliberately does NOT suppress (#3426): the prior
 * answer went out via a normal, completed `reply`, so a later late-landing
 * reply attributed to that ended turn is NOT a flush duplicate — it is
 * (typically) an async sub-agent handback carrying genuinely new content, and
 * suppressing it silently drops the user's answer. Byte-identical replays of
 * the delivered reply are still deduped by the content-keyed #546 cache.
 *
 * #3429 refinement: even a FLUSH-armed latch does not suppress when there is
 * POSITIVE content evidence (`replyMatchesFlushedAnswer === false`) that the
 * landing reply is NOT the flushed answer — an async handback attributed to a
 * flush-delivered ended turn must send fresh, not vanish. Absent evidence
 * (`null`/omitted) the flush-armed suppression holds, preserving the #2996
 * Part 2 race backstop.
 */
export function decideAnswerLatchSuppression(input: AnswerLatchSuppressInput): boolean {
  if (input.superseded) return false
  if (!input.replySubstantive) return false
  if (!input.isLateReply) return false
  if (input.replyMatchesFlushedAnswer === false) return false
  return input.ownerAnswerDelivered === 'flush'
}
