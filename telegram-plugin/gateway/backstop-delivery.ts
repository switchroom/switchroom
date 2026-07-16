/**
 * Deterministic turn-flush backstop delivery core (#3276).
 *
 * The turn-flush backstop historically delivered a flushed answer by EDITING
 * the ephemeral progress card (`editMessageText` onto the taken-over card) and
 * then counted that card-edit as an answer delivery (`sentIds` included the
 * card message id). The card is garbage-collected ~60-90s later, so the turn
 * record said `complete` while nothing durable ever reached the chat.
 *
 * This module owns the pure, side-effect-free arbitration + accounting the
 * backstop needs so it can be unit-tested without the 30k-line gateway:
 *
 *  - a once-per-turn delivery LATCH keyed on `turnId` (guard 5) — the real
 *    arbiter of backstop-vs-reply, replacing the blind 2s recent-outbound
 *    window as the primary decision;
 *  - a per-chunk sent LEDGER with a pre-send pending marker (guard 6) so a
 *    retry after a partial send or a lost ack resumes at the first unsent
 *    chunk and NEVER re-sends chunk 0;
 *  - a RECEIPT GATE (guard 7) that counts only fresh, non-card chat message ids
 *    — a card message id can never satisfy the delivery obligation.
 *
 * Every function here is pure over its arguments (the ledger is an explicit
 * per-turn store the caller owns); nothing reads gateway module state.
 */

/**
 * Per-turn delivery latch + per-chunk idempotency ledger for the turn-flush
 * backstop. One instance is held at gateway module scope; entries are keyed by
 * the per-turn `turnId` nonce so distinct turns never collide.
 */
export class BackstopDeliveryLedger {
  /** turnIds that have claimed the delivery latch (guard 5). */
  private latched = new Set<string>()
  /** turnId -> (chunkIndex -> landed message ids for that chunk). */
  private chunks = new Map<string, Map<number, number[]>>()
  /** turnId -> chunk indices with an in-flight (pre-ack) send (guard 6). */
  private pending = new Map<string, Set<number>>()

  /**
   * Guard 5 — once-per-turn delivery latch. Returns `true` on the FIRST claim
   * for this `turnId` and `false` on every subsequent claim. Synchronous, so
   * the backstop can arm it at flush-fire time BEFORE any `await` in the send
   * (guard 2) and a concurrent second fire (or a late reply consulting
   * `isLatched`) is deterministically arbitrated.
   */
  claim(turnId: string): boolean {
    if (this.latched.has(turnId)) return false
    this.latched.add(turnId)
    return true
  }

  /** Whether this turn's delivery latch is armed. Read by the reply path so a
   *  late reply for an already-flushed turn is arbitrated by the latch rather
   *  than the blind recent-outbound window. */
  isLatched(turnId: string): boolean {
    return this.latched.has(turnId)
  }

  /**
   * Release the latch for a turn whose send delivered NOTHING (a throw before
   * any chunk landed). Leaving it armed would make a genuine late reply
   * suppress itself and the user would get zero messages. A partial send does
   * NOT release — the supersede record was written for the landed chunk(s) and
   * the late reply corrects those in place.
   */
  release(turnId: string): void {
    this.latched.delete(turnId)
  }

  /** Guard 6 — mark a chunk as in-flight BEFORE the wire call, so a crash/retry
   *  between the send and the ack can tell "attempted" from "landed". */
  markPending(turnId: string, index: number): void {
    let set = this.pending.get(turnId)
    if (set == null) {
      set = new Set()
      this.pending.set(turnId, set)
    }
    set.add(index)
  }

  /** Guard 6 — record the landed message id(s) for a chunk and clear its
   *  pending marker. Idempotent: recording the same index twice overwrites with
   *  the latest landed ids (a resumed send re-delivering an un-acked chunk). */
  recordChunk(turnId: string, index: number, messageIds: number[]): void {
    let m = this.chunks.get(turnId)
    if (m == null) {
      m = new Map()
      this.chunks.set(turnId, m)
    }
    m.set(index, messageIds.slice())
    this.pending.get(turnId)?.delete(index)
  }

  /** True once a chunk index has landed at least one message id — the resume
   *  predicate that stops a retry from re-sending an already-delivered chunk. */
  hasChunk(turnId: string, index: number): boolean {
    return (this.chunks.get(turnId)?.get(index)?.length ?? 0) > 0
  }

  /** All landed message ids for this turn, in chunk-index order. */
  sentIds(turnId: string): number[] {
    const m = this.chunks.get(turnId)
    if (m == null) return []
    const out: number[] = []
    for (const index of Array.from(m.keys()).sort((a, b) => a - b)) {
      out.push(...(m.get(index) ?? []))
    }
    return out
  }

  /** The chunk indices (0..chunkCount-1) NOT yet landed — the resume set a
   *  retry must send, in order. */
  unsentIndices(turnId: string, chunkCount: number): number[] {
    const out: number[] = []
    for (let i = 0; i < chunkCount; i++) {
      if (!this.hasChunk(turnId, i)) out.push(i)
    }
    return out
  }

  /** Drop all state for a turn (post-delivery GC; keeps the map bounded). */
  clear(turnId: string): void {
    this.latched.delete(turnId)
    this.chunks.delete(turnId)
    this.pending.delete(turnId)
  }
}

/**
 * Guard 7 — the RECEIPT gate. Given the raw delivered ids and the progress-card
 * message id (or null), return only the FRESH, non-card chat message ids. A
 * card-edit id can never count toward delivery: the card is swept ~60-90s
 * later, so an answer "delivered" only onto the card reaches the user as
 * nothing.
 */
export function backstopReceiptIds(
  sentIds: readonly number[],
  cardMessageId: number | null,
): number[] {
  return sentIds.filter(id => cardMessageId == null || id !== cardMessageId)
}

/**
 * Guard 7 — the delivery predicate the turn-record status derives from: a
 * backstop delivered its answer IFF at least one fresh non-card chat id landed.
 * Empty ⇒ the turn is `send_failed`, never `complete`.
 */
export function backstopDelivered(
  sentIds: readonly number[],
  cardMessageId: number | null,
): boolean {
  return backstopReceiptIds(sentIds, cardMessageId).length > 0
}
