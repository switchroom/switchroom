/**
 * Turn-flush supersede registry (2026-07 duplicate-reply fix).
 *
 * The duplicate-reply class this closes:
 *
 *   1. A turn-flush (the answer-ready quiescence flush OR the older turn-end
 *      backstop) posts the model's terminal text as a Telegram message, because
 *      the turn appeared to end without a `reply` tool call.
 *   2. ~10 s later the model's REAL `reply` tool call lands (it was still
 *      composing it when the flush fired, or claude-code replayed an un-acked
 *      tool_call after a bridge reconnect).
 *   3. The gateway sends that as a SECOND message → the user sees a duplicate.
 *
 * The pre-existing `OutboundDedupCache` did NOT catch this because it matches on
 * EXACT normalised-text equality: a flush that dumped `narration\n\nanswer`
 * never equals the clean `answer`-only reply, so the containment case slipped
 * through (216 occurrences in older logs via the turn-end backstop alone).
 *
 * This registry SUBSTANTIALLY REDUCES the class, keyed on the turn IDENTITY
 * (the per-turn `turnId` nonce) rather than on text. When a flush sends, it
 * records `{ turnId, messageIds }` for the chat/thread. When a `reply` for the
 * SAME turn later lands, the gateway SUPERSEDES the flushed message(s) — deletes
 * them and lets the canonical reply send path deliver exactly one clean message
 * (delete+resend; the caller may also edit-in-place). A reply for a DIFFERENT
 * (newer) turn never supersedes — that turn owns its own message.
 *
 * NOT fully deterministic — a residual race remains. The flush→reply direction
 * this registry covers, plus the controller's fire-time recount for the
 * reply→flush direction, close the COMMON ~10 s replay-gap case; but if a reply
 * and a flush interleave so the reply's `take()` runs BEFORE the flush's
 * `record()` (a much smaller window), `take` finds no record and the duplicate
 * can still slip through. We deliberately trade that residual window for the
 * safety guarantee that we NEVER delete a message we cannot positively attribute
 * to the reply's own turn (identity-scoped supersede — see `decideSupersede`).
 *
 * #3429 content gate: identity is NECESSARY but not sufficient. Because the
 * flush ends its turn before recording, an async sub-agent handback landing
 * within the TTL resolves the flush-delivered ENDED turn as its owner too —
 * same identity as the turn's own late replay. When the caller supplies the
 * landing reply's text, `decideSupersede` additionally requires it to BE the
 * flushed answer (`flushedAnswerMatchesReply`); otherwise the decision is
 * 'new-content' and the gateway sends fresh (a notifying new message) with the
 * record left intact.
 *
 * Pure module: no I/O, no globals, no clock reads beyond the caller-supplied
 * `now`. Fully unit-testable; the gateway wires the actual delete/send.
 */

/** TTL after which a recorded flush is forgotten. 60 s comfortably spans the
 *  observed ~10 s flush→reply replay gap with margin, and matches the outbound
 *  dedup window so the two mechanisms age out together. */
export const DEFAULT_SUPERSEDE_TTL_MS = 60_000

export interface FlushedTurnRecord {
  /** The per-turn `turnId` nonce (`deriveTurnId` shape) of the flushed turn.
   *  Keying on this — NOT the stable `chatId:threadId` statusKey — is what makes
   *  the supersede turn-identity-scoped: a later, unrelated turn on the same
   *  chat has a different `turnId` and must NOT clobber this record's message. */
  turnId: string | null
  /** The Telegram message id(s) the flush posted (edit target + any extra
   *  chunk messages). Superseding deletes all of them. */
  messageIds: number[]
  /** The text the flush delivered. Originally diagnostics-only; since #3429 it
   *  also feeds the new-content gate (`flushedAnswerMatchesReply`): an
   *  identity-matched reply that is NOT the same answer (neither equal nor a
   *  bounded containment) is an async handback and must send fresh instead of
   *  editing/deleting the flushed message. */
  text: string
  /** Wall-clock ms when recorded. */
  ts: number
}

/**
 * The supersede decision for a landing reply. Pure so the gateway runs the
 * exact code the regression tests exercise (`gateway.ts` is not importable in
 * tests — the repo's `decideTurnFlush` / `decideCapturedProseDelivery` pattern).
 */
export interface SupersedeDecision {
  /** True → the reply belongs to an already-flushed turn; the gateway must
   *  delete `deleteMessageIds` and deliver the reply as the single message. */
  supersede: boolean
  /** Message ids the gateway must delete before/instead of the fresh send.
   *  Empty when `supersede` is false. */
  deleteMessageIds: number[]
  /** Machine-readable reason (for logs / tests). `'new-content'` (#3429): the
   *  record matched by identity + TTL but the landing reply carries genuinely
   *  DIFFERENT content than the flushed answer — an async handback attributed
   *  to the flush-delivered ended turn, NOT that turn's own answer landing
   *  late. The gateway must send FRESH (a notifying new message), never
   *  edit/delete the flushed message; the record is NOT consumed. */
  reason: 'supersede' | 'no-record' | 'expired' | 'different-turn' | 'new-content'
  /** The matched record's flushed text — populated whenever a fresh record for
   *  the reply's turn identity was found (`reason` 'supersede' or
   *  'new-content'). The gateway stashes it on the owner turn atom so the
   *  answer-delivered latch can make the same content-vs-flush discrimination
   *  on the no-record retry/race paths (#3429). */
  recordText?: string
}

/**
 * #3429 — minimum length a CONTAINED text must have for a containment match.
 * The legitimate containment class is a flush that delivered
 * `narration\n\nanswer` being corrected by the clean `answer`-only reply — the
 * contained side is a full answer, comfortably long. A trivially short
 * contained string (e.g. a reply "Done." that happens to appear inside the
 * flushed blob) is NOT positive evidence of the same answer, and a false match
 * here silently edits/suppresses genuinely new content — the exact #3429
 * failure. Below this floor only whitespace-normalized EQUALITY matches; the
 * worst case of declining is a rare duplicate message, which beats a silent
 * drop (the #3426/#3428 precedent).
 */
export const SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS = 32

/** Collapse whitespace runs so flush-pipeline vs reply-pipeline spacing
 *  (paragraph spacers, hard-break promotion) never defeats the comparison. */
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * #3429 — is the landing reply the SAME ANSWER the flush already delivered
 * (a late canonical correction), as opposed to genuinely new content (an async
 * handback that merely resolved the flush-delivered ended turn as its owner)?
 *
 * Deterministic string decision, no timing:
 *   - whitespace-normalized equality → same answer;
 *   - containment either direction (flush = `narration\n\nanswer` ⊇ reply, or
 *     reply ⊇ a partially-delivered flush), guarded by
 *     `SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS` on the CONTAINED side so a short
 *     coincidental substring can never claim a match.
 *
 * A model-REGENERATED paraphrase of the same answer is indistinguishable from
 * new content and therefore sends fresh — a rare duplicate message, the same
 * conscious trade #3428 shipped for the reply-armed latch. A silent
 * drop/edit-in-place of a genuinely new handback is the strictly worse
 * failure.
 */
export function flushedAnswerMatchesReply(flushedText: string, replyText: string): boolean {
  const flushed = normalizeForMatch(flushedText)
  const reply = normalizeForMatch(replyText)
  if (flushed.length === 0 || reply.length === 0) return false
  if (flushed === reply) return true
  if (reply.length >= SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS && flushed.includes(reply)) return true
  if (flushed.length >= SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS && reply.includes(flushed)) return true
  return false
}

/**
 * Decide whether a landing reply supersedes a recorded flush.
 *
 * Supersede IFF the record is present, fresh (within TTL), AND positively
 * attributable to the reply's turn by IDENTITY:
 *   - a turnId-bearing record is superseded ONLY by a reply whose resolved
 *     `liveTurnId` equals `record.turnId`;
 *   - a null-turnId record (a synthetic/no-nonce flush) is superseded ONLY by a
 *     reply that ALSO has no resolvable turn (`liveTurnId == null`).
 *
 * Crucially, a reply with `liveTurnId == null` does NOT supersede a
 * turnId-bearing record: we never delete a message we cannot positively
 * attribute to the reply's own turn. (The earlier revision superseded ANY
 * record on a null live turn, which — combined with a single overwriting lane
 * slot — could late-delete a DIFFERENT turn's legitimate message. The gateway
 * now resolves a last-known turnId for the reply before calling in, so the
 * common late-replay case still matches by identity rather than relying on the
 * promiscuous null branch.)
 *
 * #3429 content gate: identity alone is NOT sufficient. The flush ends its
 * turn synchronously BEFORE recording (stream-render `endCurrentTurnAtomic` →
 * `record`), so EVERY superseding reply is a late reply, and an async
 * sub-agent handback landing within the TTL with no live gateway turn resolves
 * the flush-delivered ENDED turn as its owner via the latest-ended tier —
 * exactly the same identity as the turn's own canonical late replay. The
 * observed failure (msgs 10482/10486, 2026-07-20): the handback consumed the
 * record and EDITED the flushed message in place with unrelated new content —
 * Telegram edits do not re-notify, so the handback never surfaced client-side
 * AND the flushed answer was destroyed. When the caller supplies `replyText`
 * and it is NOT the same answer (`flushedAnswerMatchesReply`), the decision is
 * `'new-content'`: no supersede, record left intact for the genuine replay,
 * and the gateway sends the reply FRESH. Callers that omit `replyText`
 * (identity-only legacy shape) keep the pre-#3429 behaviour.
 */
export function decideSupersede(
  record: FlushedTurnRecord | undefined,
  args: { liveTurnId: string | null; replyText?: string | null; now: number; ttlMs?: number },
): SupersedeDecision {
  const ttlMs = args.ttlMs ?? DEFAULT_SUPERSEDE_TTL_MS
  if (record == null) return { supersede: false, deleteMessageIds: [], reason: 'no-record' }
  if (args.now - record.ts > ttlMs) {
    return { supersede: false, deleteMessageIds: [], reason: 'expired' }
  }
  const sameTurn =
    record.turnId != null
      ? record.turnId === args.liveTurnId
      : args.liveTurnId == null
  if (!sameTurn) {
    return { supersede: false, deleteMessageIds: [], reason: 'different-turn' }
  }
  // #3429 — same turn identity, but genuinely different content: an async
  // handback attributed to the flush-delivered ended turn, not the turn's own
  // answer landing late. Never edit/delete the flushed message for it.
  if (args.replyText != null && !flushedAnswerMatchesReply(record.text, args.replyText)) {
    return { supersede: false, deleteMessageIds: [], reason: 'new-content', recordText: record.text }
  }
  return {
    supersede: true,
    deleteMessageIds: [...record.messageIds],
    reason: 'supersede',
    recordText: record.text,
  }
}

/**
 * How the gateway should CORRECT a flushed message once its canonical `reply`
 * lands. Historically the supersede always did `deleteMessage(A)` + fresh send
 * of the canonical reply B — visible to the user as a delete+replace flicker
 * plus a second device ping. When the reply fits a single message and matches
 * the flushed message's type (both plain text, the normal case), we can instead
 * edit message A in place with B's content: no delete, no flicker, no re-ping.
 *
 *   - `edit-in-place` → the gateway feeds `editMessageId` into the existing
 *     single-message edit path (the `previewMessageId` edit lane in
 *     `sendReplyChunks`), which renders the canonical reply with the SAME rich
 *     path a fresh reply uses and, on any edit 400 (message too old / can't be
 *     edited / not found), falls back to delete+resend — so correctness never
 *     regresses. `deleteMessageIds` is empty (message A becomes message B).
 *   - `delete-resend` → the legacy behaviour: delete every flushed message id,
 *     then send the canonical reply fresh. Chosen whenever edit-in-place isn't
 *     safe (multi-part reply, >1 flushed message, a file/voice-only reply, or a
 *     draft-stream preview already owns the single-message edit lane).
 */
export type SupersedeCorrection =
  | { mode: 'edit-in-place'; editMessageId: number; deleteMessageIds: number[] }
  | { mode: 'delete-resend'; deleteMessageIds: number[] }

/**
 * Decide how to correct a superseded flush. Pure so the gateway runs the exact
 * branch the regression tests exercise. Edit-in-place is chosen IFF the flush
 * posted exactly ONE message AND the canonical reply is a single plain-text
 * message with no competing edit target:
 *   - `flushMessageIds.length === 1` — a multi-message flush has no single
 *     edit target; delete all and resend.
 *   - `chunkCount === 1` — a multi-part reply can't collapse into one edit.
 *   - `!hasFiles` — a file/album reply is not a plain-text edit.
 *   - `!suppressText` — a voice-only reply sends no text body to edit into.
 *   - `!hasOpenPreview` — a live draft-stream preview already owns the
 *     single-message edit lane; deleting the flush and letting the preview edit
 *     keeps exactly one message.
 * `literalText` (`format:'text'`) stays eligible — it is still a text message,
 * and the edit lane renders literal vs rich identically to a fresh send.
 */
export function decideSupersedeCorrection(input: {
  flushMessageIds: number[]
  chunkCount: number
  hasFiles: boolean
  suppressText: boolean
  hasOpenPreview: boolean
}): SupersedeCorrection {
  const eligible =
    input.flushMessageIds.length === 1 &&
    input.chunkCount === 1 &&
    !input.hasFiles &&
    !input.suppressText &&
    !input.hasOpenPreview
  if (eligible) {
    return { mode: 'edit-in-place', editMessageId: input.flushMessageIds[0]!, deleteMessageIds: [] }
  }
  return { mode: 'delete-resend', deleteMessageIds: [...input.flushMessageIds] }
}

/** Sentinel key for records whose flush carried no turnId nonce. */
const NULL_TURN_KEY = '<<null-turn>>'

function turnKey(turnId: string | null): string {
  return turnId == null ? NULL_TURN_KEY : turnId
}

/**
 * In-memory registry of recently-flushed turns, keyed by `chatId|threadId` and
 * then by the flush's `turnId` nonce WITHIN that lane. Holding a per-turnId map
 * (rather than a single overwriting slot) is what makes the identity guarantee
 * airtight: two turns can each flush a message on the same lane, and each turn's
 * later reply supersedes ONLY its own flushed message — turn B's reply can never
 * reach turn A's record, and a late turn-A reply can never reach turn B's.
 *
 * Bounded by TTL eviction (swept on every `record`); chat count per gateway is
 * small and a lane holds at most a handful of concurrent-turn records.
 */
export class FlushedTurnSupersedeRegistry {
  private readonly entries = new Map<string, Map<string, FlushedTurnRecord>>()
  private readonly ttlMs: number

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SUPERSEDE_TTL_MS
  }

  /** Record a flush's posted message(s) so a later same-turn reply supersedes
   *  them, keyed on the flush's `turnId` within the chat/thread lane. No record
   *  is kept when the flush posted zero messages. Sweeps expired records first
   *  (lightweight active GC — LOW-2) so orphan records never accumulate. */
  record(
    chatId: string,
    threadId: number | undefined,
    rec: { turnId: string | null; messageIds: number[]; text: string },
    now: number,
  ): void {
    if (rec.messageIds.length === 0) return
    this.sweep(now)
    const lane = makeKey(chatId, threadId)
    let laneMap = this.entries.get(lane)
    if (laneMap == null) {
      laneMap = new Map<string, FlushedTurnRecord>()
      this.entries.set(lane, laneMap)
    }
    laneMap.set(turnKey(rec.turnId), {
      turnId: rec.turnId,
      messageIds: [...rec.messageIds],
      text: rec.text,
      ts: now,
    })
  }

  /** Decide supersede for a landing reply WITHOUT consuming the record. Selects
   *  the record whose turnId matches the reply's resolved `liveTurnId` (or the
   *  null-turnId record when `liveTurnId == null`). `replyText` (#3429) enables
   *  the new-content gate; omitting it keeps the identity-only legacy shape. */
  peek(
    chatId: string,
    threadId: number | undefined,
    args: { liveTurnId: string | null; replyText?: string | null; now: number },
  ): SupersedeDecision {
    const rec = this.entries.get(makeKey(chatId, threadId))?.get(turnKey(args.liveTurnId))
    return decideSupersede(rec, {
      liveTurnId: args.liveTurnId,
      replyText: args.replyText,
      now: args.now,
      ttlMs: this.ttlMs,
    })
  }

  /** Decide supersede AND, on a supersede, consume the matched record (so a
   *  second replay of the same reply doesn't try to delete the same — now gone —
   *  messages again). A `'new-content'` decision (#3429) does NOT consume: the
   *  record stays live for the turn's own canonical replay until the TTL.
   *  Returns the same decision `peek` would. */
  take(
    chatId: string,
    threadId: number | undefined,
    args: { liveTurnId: string | null; replyText?: string | null; now: number },
  ): SupersedeDecision {
    const lane = makeKey(chatId, threadId)
    const decision = this.peek(chatId, threadId, args)
    if (decision.supersede) {
      const laneMap = this.entries.get(lane)
      laneMap?.delete(turnKey(args.liveTurnId))
      if (laneMap != null && laneMap.size === 0) this.entries.delete(lane)
    }
    return decision
  }

  /** Drop all records for a chat/thread (e.g. after the flushed message was
   *  deleted through another path). Idempotent. */
  forget(chatId: string, threadId: number | undefined): void {
    this.entries.delete(makeKey(chatId, threadId))
  }

  /** Test-only: clear all entries. */
  clear(): void {
    this.entries.clear()
  }

  /** Evict every record past its TTL and prune emptied lanes. */
  private sweep(now: number): void {
    for (const [lane, laneMap] of this.entries) {
      for (const [tk, rec] of laneMap) {
        if (now - rec.ts > this.ttlMs) laneMap.delete(tk)
      }
      if (laneMap.size === 0) this.entries.delete(lane)
    }
  }

  /** Test-only: live record count after TTL eviction. */
  size(now: number): number {
    this.sweep(now)
    let total = 0
    for (const laneMap of this.entries.values()) total += laneMap.size
    return total
  }
}

function makeKey(chatId: string, threadId: number | undefined): string {
  return threadId == null ? chatId : `${chatId}|${threadId}`
}
