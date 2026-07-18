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
 *  - a per-chunk sent LEDGER with a pre-send pending marker (guard 6) so a
 *    retry after a partial send or a lost ack resumes at the first unsent
 *    chunk and NEVER re-sends chunk 0;
 *  - a bounded in-turn RETRY orchestrator (`runBackstopDelivery`) that is the
 *    live caller of the ledger's resume machinery — the real fix for the
 *    `send_failed` silent-drop: it retries mid-chunk before giving up, and
 *    reports whether the answer was actually delivered so the caller can leave
 *    the delivery obligation OPEN on terminal failure;
 *  - a RECEIPT GATE (guard 7) that counts only fresh, non-card chat message ids
 *    — a card message id can never satisfy the delivery obligation;
 *  - a once-per-turn double-fire LATCH (guard 5) so a turn that already fired a
 *    backstop (answer-ready quiescence, then the turn-end backstop) does not
 *    deliver twice.
 *
 * Every function here is pure over its arguments (the ledger is an explicit
 * per-turn store the caller owns); nothing reads gateway module state.
 */

/**
 * Per-turn double-fire latch + per-chunk idempotency ledger for the turn-flush
 * backstop. One instance is held at gateway module scope; entries are keyed by
 * the per-turn `turnId` nonce so distinct turns never collide.
 */
export class BackstopDeliveryLedger {
  /** turnIds that have claimed the backstop double-fire latch (guard 5). */
  private latched = new Set<string>()
  /** turnId -> (chunkIndex -> landed message ids for that chunk). */
  private chunks = new Map<string, Map<number, number[]>>()
  /** turnId -> chunk indices with an in-flight (pre-ack) send (guard 6). */
  private pending = new Map<string, Set<number>>()
  /** turnId -> chunk indices whose read-back probe CONFIRMED the message
   *  actually exists in the chat (#3278). A chunk with a landed message id but
   *  no confirmation is `landed-unconfirmed` — the Bot API accepted the send but
   *  a server-side silent discard (flood/anti-spam) can return a fresh id for a
   *  message the user never sees, so an id alone is NOT proof of delivery. */
  private confirmed = new Map<string, Set<number>>()

  /**
   * Guard 5 — once-per-turn BACKSTOP double-fire latch. Returns `true` on the
   * FIRST claim for this `turnId` and `false` on every subsequent claim.
   * Synchronous, so the backstop can arm it at flush-fire time BEFORE any
   * `await` in the send: a second fire for the same turn (answer-ready
   * quiescence followed by the turn-end backstop) is deterministically a no-op.
   *
   * NOTE (scope honesty): this arbitrates backstop-vs-backstop only. The
   * backstop-vs-late-reply arbitration is NOT this latch — it is
   * `flushedTurnSupersede` (real message ids) plus the `turn.answerDelivered`
   * flag, exactly as on `main`. This latch is redundant-but-cheap with the
   * `currentTurn == null` bail the synthetic turn_end already performs.
   */
  claim(turnId: string): boolean {
    if (this.latched.has(turnId)) return false
    this.latched.add(turnId)
    return true
  }

  /**
   * Release the latch for a turn whose send delivered NOTHING (retries
   * exhausted with zero landed chunks). Leaving it armed would let a spurious
   * re-fire stay suppressed; releasing lets the normal recovery paths run.
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

  /** The landed message id(s) for one chunk (empty when unsent). The read-back
   *  probe reads these to confirm every id of the chunk (guard A7 — a
   *  length-resplit chunk lands >1 id and all must exist to count confirmed). */
  chunkIds(turnId: string, index: number): number[] {
    return (this.chunks.get(turnId)?.get(index) ?? []).slice()
  }

  /**
   * #3278 — transition a landed-unconfirmed chunk to `landed-confirmed` after a
   * read-back probe proved the message exists in the chat. Only a confirmed
   * chunk counts toward delivery / `complete`.
   */
  confirmChunk(turnId: string, index: number): void {
    let set = this.confirmed.get(turnId)
    if (set == null) {
      set = new Set()
      this.confirmed.set(turnId, set)
    }
    set.add(index)
  }

  /**
   * #3278 — demote a chunk back to `unsent` on a POSITIVE absence read-back
   * (Telegram `400 message to edit not found`): the send was silently dropped,
   * so re-sending it is safe (it never reached the user). Clears the landed ids,
   * the pending marker, and any stale confirmation. NEVER call this on an
   * ambiguous probe (429/5xx/network) — that would risk a duplicate.
   */
  demoteChunk(turnId: string, index: number): void {
    this.chunks.get(turnId)?.delete(index)
    this.pending.get(turnId)?.delete(index)
    this.confirmed.get(turnId)?.delete(index)
  }

  /** True only for a `landed-confirmed` chunk (read-back proved it exists). */
  hasConfirmedChunk(turnId: string, index: number): boolean {
    return this.confirmed.get(turnId)?.has(index) ?? false
  }

  /** Chunk indices that have landed at least one id but are NOT yet confirmed —
   *  the set the read-back probe must resolve (confirm / demote / leave). */
  landedUnconfirmedIndices(turnId: string, chunkCount: number): number[] {
    const out: number[] = []
    for (let i = 0; i < chunkCount; i++) {
      if (this.hasChunk(turnId, i) && !this.hasConfirmedChunk(turnId, i)) out.push(i)
    }
    return out
  }

  /** True IFF every chunk 0..chunkCount-1 is `landed-confirmed`. `chunkCount===0`
   *  is never "all confirmed" (nothing was delivered). */
  allConfirmed(turnId: string, chunkCount: number): boolean {
    if (chunkCount <= 0) return false
    for (let i = 0; i < chunkCount; i++) {
      if (!this.hasConfirmedChunk(turnId, i)) return false
    }
    return true
  }

  /** Landed message ids of CONFIRMED chunks only, in chunk-index order — the set
   *  the delivery predicate counts (fresh non-card ids that are proven-present). */
  confirmedIds(turnId: string): number[] {
    const m = this.chunks.get(turnId)
    const set = this.confirmed.get(turnId)
    if (m == null || set == null) return []
    const out: number[] = []
    for (const index of Array.from(m.keys()).sort((a, b) => a - b)) {
      if (set.has(index)) out.push(...(m.get(index) ?? []))
    }
    return out
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

  /** Landed {index, messageIds} entries in chunk-index order — lets the caller
   *  build a history `texts` array ALIGNED to the actual sent ids (guard fix:
   *  a length-resplit chunk lands >1 id, so a naive `chunks.slice(0, n)` zip
   *  misaligns). */
  entries(turnId: string): Array<{ index: number; messageIds: number[] }> {
    const m = this.chunks.get(turnId)
    if (m == null) return []
    return Array.from(m.keys())
      .sort((a, b) => a - b)
      .map(index => ({ index, messageIds: (m.get(index) ?? []).slice() }))
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
    this.confirmed.delete(turnId)
  }
}

/**
 * #3278 — the tri-state a read-back probe resolves a landed chunk into:
 *  - `exists`    — a no-op `editMessageText` succeeded or returned "message is
 *                  not modified" ⇒ the message is present at the chat_id ⇒
 *                  `landed-confirmed` (counts toward delivery).
 *  - `absent`    — Telegram `400 message to edit not found` ⇒ positive absence
 *                  ⇒ demote to `unsent` (safe to re-send — it never landed).
 *  - `ambiguous` — 429 / 5xx / network / gate-shed / anything else ⇒ leave
 *                  `landed-unconfirmed`; NEVER re-send (a re-send would risk a
 *                  duplicate, and duplicate-risk beats missing-risk here).
 *
 * NOTE (honest limitation, #3278 §1.4): a passing probe proves only that the
 * message EXISTS at that chat_id. It does NOT prove the human's client rendered
 * it, and it does NOT catch a wrong-thread/chat misroute (the edit succeeds
 * because the message exists — just not where the operator is looking).
 * Read-back is necessary-but-not-sufficient; it is paired with the correct
 * chat/thread resolution already pinned by the backstop caller.
 */
export type ReadBackResult = 'exists' | 'absent' | 'ambiguous'

/**
 * Combine the per-id read-back results of ONE chunk into the chunk's verdict
 * (guard A7 — a length-resplit chunk lands >1 message id and every id must be
 * present for the chunk to count confirmed). Pure:
 *  - ANY id `absent`               ⇒ `absent`   (the chunk is incomplete on the
 *                                     wire → re-send the whole chunk)
 *  - ALL ids `exists`              ⇒ `exists`
 *  - otherwise (some `ambiguous`,
 *    none `absent`)                ⇒ `ambiguous` (never re-send)
 *  - empty id set                  ⇒ `ambiguous` (nothing to probe → don't
 *                                     fabricate a confirmation OR a demotion)
 */
export function combineReadBackResults(perId: readonly ReadBackResult[]): ReadBackResult {
  if (perId.length === 0) return 'ambiguous'
  if (perId.some(r => r === 'absent')) return 'absent'
  if (perId.every(r => r === 'exists')) return 'exists'
  return 'ambiguous'
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

/** Injected effects for {@link runBackstopDelivery}. Pure over its arguments;
 *  the gateway supplies real `sendChunk` (via `sendReplyChunks`) + history. */
export interface BackstopDeliveryDeps {
  /** Send ONE chunk. Resolves to the landed message id(s) (a length-resplit
   *  chunk may land >1). Rejects on an unrecoverable send failure. */
  sendChunk: (chunkIndex: number, text: string) => Promise<number[]>
  /** Record the delivered ids + aligned texts to history (called once, after
   *  the attempts resolve, with the full landed set). */
  recordOutbound?: (messageIds: number[], texts: string[]) => void
  /**
   * #3278 read-back confirmation. After a chunk lands a message id, a no-op
   * `editMessageText` probe re-confirms the message ACTUALLY exists in the chat
   * (a returned id is only an API accept, not proof of visibility). Returns the
   * chunk's {@link ReadBackResult} — `exists` ⇒ landed-confirmed, `absent` ⇒
   * demote to unsent + re-send, `ambiguous` ⇒ stay landed-unconfirmed and NEVER
   * re-send. Runs once per landed chunk after the send attempts resolve, and is
   * itself flood-window-paced by the caller (never a storm).
   *
   * When OMITTED, a landed chunk is confirmed on landing (pre-#3278 behavior) —
   * still gated by the fresh-non-card receipt filter, so a card-only "delivery"
   * is never counted. This is the hot-path default: read-back is scoped to the
   * RARE backstop delivery, so the reply-tool path issues ZERO probes (§1.3).
   */
  readBack?: (
    chunkIndex: number,
    messageIds: readonly number[],
    text: string,
  ) => Promise<ReadBackResult>
  /** Optional stderr sink for progress/resume logging. */
  stderr?: (s: string) => void
}

export interface BackstopDeliveryResult {
  /** All landed fresh chat message ids (card id already excluded upstream —
   *  `sendChunk` never targets the card). In chunk-index order. */
  sentIds: number[]
  /** Number of input chunks the answer was split into. */
  chunkCount: number
  /** True IFF every chunk landed at least one fresh non-card id. */
  delivered: boolean
  /** How many attempts ran (1..maxAttempts). */
  attempts: number
  /** True when retries were exhausted without full delivery (terminal fail). */
  exhausted: boolean
}

/**
 * Bounded in-turn retry orchestrator (guard 6's live caller, finding-1 fix).
 *
 * Sends `chunks` via `deps.sendChunk`, up to `maxAttempts` times. Each attempt
 * consults the ledger and RESUMES at the first unsent chunk — a chunk that
 * already landed on a prior attempt is never re-sent (so chunk 0 is delivered
 * exactly once even across retries). Only after all attempts are exhausted
 * without full delivery does it report `exhausted: true` / `delivered: false`,
 * so the caller can leave the delivery obligation OPEN for the liveness floor
 * to re-present — instead of the old silent `send_failed` drop.
 *
 * #3278 — after each attempt's sends resolve, every `landed-unconfirmed` chunk
 * is read-back-probed via `deps.readBack` (when provided): `exists` confirms it,
 * `absent` demotes it to `unsent` so the NEXT attempt re-sends only that chunk,
 * and `ambiguous` leaves it `landed-unconfirmed` — never re-sent (duplicate-risk
 * beats missing-risk). `delivered` now requires every chunk `landed-confirmed`,
 * so an API-ack'd-but-silently-dropped send (fresh id, absent on read-back) is
 * reported `delivered:false` and the caller leaves the obligation OPEN.
 *
 * `recordOutbound` (when provided) fires ONCE at the end with the full landed
 * set and a `texts` array ALIGNED to the actual sent ids (via `ledger.entries`).
 * The ledger is NOT cleared here — the caller clears it only after success or
 * exhaustion, so a resume can always read prior progress.
 */
export async function runBackstopDelivery(
  ledger: BackstopDeliveryLedger,
  turnId: string,
  chunks: readonly string[],
  cardMessageId: number | null,
  deps: BackstopDeliveryDeps,
  maxAttempts = 3,
): Promise<BackstopDeliveryResult> {
  const stderr = deps.stderr ?? (() => {})
  const chunkCount = chunks.length
  let attempts = 0

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    attempts = attempt
    // 1. SEND the `unsent` chunks (never-landed OR demoted by a prior absent
    //    read-back), resuming in chunk-index order. Guard 6 keeps a chunk that
    //    already landed from being re-sent.
    const resume = ledger.unsentIndices(turnId, chunkCount)
    let attemptThrew = false
    if (resume.length > 0) {
      if (attempt > 1) {
        stderr(
          `telegram gateway: backstop delivery retry ${attempt}/${maxAttempts} — ` +
          `resuming at unsent chunk(s) [${resume.join(', ')}] for turn ${turnId}\n`,
        )
      }
      try {
        for (const i of resume) {
          if (ledger.hasChunk(turnId, i)) continue
          ledger.markPending(turnId, i)
          const ids = await deps.sendChunk(i, chunks[i])
          ledger.recordChunk(turnId, i, ids) // → landed-unconfirmed
        }
      } catch (err) {
        attemptThrew = true
        stderr(
          `telegram gateway: backstop delivery attempt ${attempt}/${maxAttempts} failed: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }

    // 2. CONFIRM landed-unconfirmed chunks via read-back (#3278). Without a probe
    //    wired, landing IS confirmation (pre-#3278) — the fresh-non-card receipt
    //    filter below still rejects a card-only "delivery".
    let demotedAny = false
    for (const i of ledger.landedUnconfirmedIndices(turnId, chunkCount)) {
      if (deps.readBack == null) {
        ledger.confirmChunk(turnId, i)
        continue
      }
      let verdict: ReadBackResult
      try {
        verdict = await deps.readBack(i, ledger.chunkIds(turnId, i), chunks[i])
      } catch (err) {
        // A probe adapter that itself throws must NEVER trigger a re-send.
        verdict = 'ambiguous'
        stderr(
          `telegram gateway: backstop read-back probe threw for chunk ${i} ` +
          `(turn ${turnId}) — treating as ambiguous: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
      if (verdict === 'exists') {
        ledger.confirmChunk(turnId, i)
      } else if (verdict === 'absent') {
        // Positive absence — the send was silently dropped. Safe to re-send.
        ledger.demoteChunk(turnId, i)
        demotedAny = true
        stderr(
          `telegram gateway: backstop read-back — chunk ${i} not found in chat ` +
          `(turn ${turnId}); demoting to unsent for re-send\n`,
        )
      } else {
        // Ambiguous (429/5xx/network/gate-shed) — leave landed-unconfirmed and
        // NEVER re-send it (would risk a duplicate).
        stderr(
          `telegram gateway: backstop read-back — chunk ${i} ambiguous ` +
          `(turn ${turnId}); left landed-unconfirmed, not re-sending\n`,
        )
      }
    }

    // 3. Fully confirmed ⇒ done.
    if (ledger.allConfirmed(turnId, chunkCount)) break
    // 4. Another attempt ONLY re-sends chunks demoted to `unsent`. If nothing is
    //    unsent, the remaining non-confirmed chunks are all `landed-unconfirmed`
    //    (ambiguous) — re-sending them would duplicate, so stop here.
    if (ledger.unsentIndices(turnId, chunkCount).length === 0) break
    // 5. Guard against a spin: if this attempt neither sent, threw, nor demoted
    //    anything, another identical attempt is pointless.
    if (resume.length === 0 && !attemptThrew && !demotedAny) break
  }

  const sentIds = ledger.sentIds(turnId)
  // #3278 — delivered IFF every chunk is `landed-confirmed` AND at least one
  // confirmed id is a fresh non-card chat id (the receipt gate, guard 7).
  const delivered =
    ledger.allConfirmed(turnId, chunkCount) &&
    backstopReceiptIds(ledger.confirmedIds(turnId), cardMessageId).length > 0
  const exhausted = !delivered

  if (deps.recordOutbound && sentIds.length > 0) {
    const texts: string[] = []
    const ids: number[] = []
    for (const { index, messageIds } of ledger.entries(turnId)) {
      for (const id of messageIds) {
        ids.push(id)
        texts.push(chunks[index] ?? '')
      }
    }
    deps.recordOutbound(ids, texts)
  }

  return { sentIds, chunkCount, delivered, attempts, exhausted }
}
