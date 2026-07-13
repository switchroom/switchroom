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
 * This registry closes the class DETERMINISTICALLY, keyed on the turn IDENTITY
 * (the per-turn `turnId` nonce) rather than on text. When a flush sends, it
 * records `{ turnId, messageIds }` for the chat/thread. When a `reply` for the
 * SAME turn later lands, the gateway SUPERSEDES the flushed message(s) — deletes
 * them and lets the canonical reply send path deliver exactly one clean message
 * (delete+resend; the caller may also edit-in-place). A reply for a DIFFERENT
 * (newer) live turn never supersedes — that turn owns its own message.
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
  /** The text the flush delivered — retained for diagnostics/logging only. The
   *  supersede decision NEVER compares text (that is the whole point: it fires
   *  even when the flushed text differs from the reply text). */
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
  /** Machine-readable reason (for logs / tests). */
  reason: 'supersede' | 'no-record' | 'expired' | 'different-turn'
}

/**
 * Decide whether a landing reply supersedes a recorded flush.
 *
 * Supersede IFF the record is present, fresh (within TTL), AND belongs to the
 * reply's turn: either no live turn is pinned (`liveTurnId == null` — the
 * flushed turn already ended and its reply is a late replay, the common
 * duplicate case) OR the live turn IS the flushed turn (`liveTurnId ===
 * record.turnId`). A reply arriving while a DIFFERENT newer turn is live
 * (`liveTurnId !== record.turnId`) is that new turn's own answer and must send
 * fresh — never clobber it.
 *
 * When the record's `turnId` is null (a synthetic/no-nonce flush) it can only be
 * superseded by a null-live-turn reply — a conservative fallback that never
 * clobbers a live turn.
 */
export function decideSupersede(
  record: FlushedTurnRecord | undefined,
  args: { liveTurnId: string | null; now: number; ttlMs?: number },
): SupersedeDecision {
  const ttlMs = args.ttlMs ?? DEFAULT_SUPERSEDE_TTL_MS
  if (record == null) return { supersede: false, deleteMessageIds: [], reason: 'no-record' }
  if (args.now - record.ts > ttlMs) {
    return { supersede: false, deleteMessageIds: [], reason: 'expired' }
  }
  const sameTurn =
    args.liveTurnId == null ||
    (record.turnId != null && record.turnId === args.liveTurnId)
  if (!sameTurn) {
    return { supersede: false, deleteMessageIds: [], reason: 'different-turn' }
  }
  return { supersede: true, deleteMessageIds: [...record.messageIds], reason: 'supersede' }
}

/**
 * In-memory registry of recently-flushed turns, keyed by `chatId|threadId`.
 * Bounded by TTL eviction on every access; chat count per gateway is small.
 */
export class FlushedTurnSupersedeRegistry {
  private readonly entries = new Map<string, FlushedTurnRecord>()
  private readonly ttlMs: number

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SUPERSEDE_TTL_MS
  }

  /** Record a flush's posted message(s) so a later same-turn reply supersedes
   *  them. A fresh record for a chat/thread replaces any prior one (the newest
   *  flush is the only one whose message is still on screen for that lane). No
   *  record is kept when the flush posted zero messages. */
  record(
    chatId: string,
    threadId: number | undefined,
    rec: { turnId: string | null; messageIds: number[]; text: string },
    now: number,
  ): void {
    if (rec.messageIds.length === 0) return
    this.entries.set(makeKey(chatId, threadId), {
      turnId: rec.turnId,
      messageIds: [...rec.messageIds],
      text: rec.text,
      ts: now,
    })
  }

  /** Decide supersede for a landing reply WITHOUT consuming the record. */
  peek(
    chatId: string,
    threadId: number | undefined,
    args: { liveTurnId: string | null; now: number },
  ): SupersedeDecision {
    const key = makeKey(chatId, threadId)
    const rec = this.entries.get(key)
    return decideSupersede(rec, { liveTurnId: args.liveTurnId, now: args.now, ttlMs: this.ttlMs })
  }

  /** Decide supersede AND, on a supersede, consume the record (so a second
   *  replay of the same reply doesn't try to delete the same — now gone —
   *  messages again). Returns the same decision `peek` would. */
  take(
    chatId: string,
    threadId: number | undefined,
    args: { liveTurnId: string | null; now: number },
  ): SupersedeDecision {
    const key = makeKey(chatId, threadId)
    const decision = this.peek(chatId, threadId, args)
    if (decision.supersede) this.entries.delete(key)
    return decision
  }

  /** Drop the record for a chat/thread (e.g. after the flushed message was
   *  deleted through another path). Idempotent. */
  forget(chatId: string, threadId: number | undefined): void {
    this.entries.delete(makeKey(chatId, threadId))
  }

  /** Test-only: clear all entries. */
  clear(): void {
    this.entries.clear()
  }

  /** Test-only: live entry count after TTL eviction. */
  size(now: number): number {
    let total = 0
    for (const [key, rec] of this.entries) {
      if (now - rec.ts > this.ttlMs) this.entries.delete(key)
      else total++
    }
    return total
  }
}

function makeKey(chatId: string, threadId: number | undefined): string {
  return threadId == null ? chatId : `${chatId}|${threadId}`
}
