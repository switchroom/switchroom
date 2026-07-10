/**
 * activity-card-store.ts — durable handle for the mid-turn activity card, so a
 * gateway restart mid-turn can finalize the orphaned card instead of leaving it
 * frozen forever.
 *
 * Why this exists (reference/rfcs/deterministic-turn-liveness.md Known Gap 1):
 * `CurrentTurn.activityMessageId` / `startedAt` and the live `currentTurn`
 * itself live ONLY in gateway memory. If the gateway restarts while a turn's
 * activity card is open, the new process has no handle to the old card — it
 * is never edited again and sits frozen on its last pre-restart text forever.
 * The resumed turn (if any) opens a FRESH card; the old one is orphaned.
 *
 * The fix mirrors `status-pin-store.ts` byte-for-byte in shape: a tiny durable
 * snapshot on the per-agent state volume (STATE_DIR), written whenever a card
 * OPENS, cleared the moment it closes/finalizes normally. On boot, AFTER this
 * gateway wins the startup mutex (same ordering constraint as the status-pin
 * cleanup — this is a shared per-agent file, so a losing double-boot must
 * never touch it), a one-shot reaper reads any leftover record and finalizes
 * the orphaned card with a SINGLE honest edit (never a new message — edits do
 * not notify, so no ping). We do NOT attempt to resume climbing the old card
 * across the restart; the resumed turn (if any) owns a fresh card. Honest
 * finalization — not resumption — is the goal.
 *
 * Crash-safety: write-tmp + atomic rename (identical convention to
 * status-pin-store.ts / obligation-store.ts). A corrupt or unreadable file
 * fails open to `[]` — never crashes boot, worst case an orphan isn't cleaned
 * up this boot, no worse than pre-fix behaviour.
 *
 * DELIVERED GUARANTEE — AT-MOST-ONCE finalization (be honest about it):
 * the reaper deletes a record from the on-disk store BEFORE attempting its
 * finalizing edit (not after) and swallows every Telegram failure with no
 * retry. That ordering buys strict idempotency — a crash mid-reap, or a second
 * boot re-reading the file, can never double-edit or double-unpin the same
 * message — at the cost of durability: if the single edit fails (flood-wait
 * exhausted, transient 5xx, chat momentarily unreachable), the orphaned card is
 * FORFEIT and stays frozen, because its record is already gone. So the promise
 * is NOT "finalized on the very next boot" — it is "finalized AT MOST ONCE, on
 * the next boot, best-effort". We deliberately chose at-most-once over
 * at-least-once: a retry-until-success design cannot preserve the
 * second-boot-zero-edits property across a crash between a successful edit and
 * its post-edit delete (that window would re-edit an already-finalized card),
 * and a stale re-finalize on a chat the user has since moved on from is a worse
 * failure than one frozen orphan. A benign-400 (message already
 * deleted/vanished, or "not modified") is NOT counted as a finalize — nothing
 * was delivered — see the `vanished` tally in `runActivityCardBootReaper`.
 *
 * The UNPIN half is different (#3001): unpinning is idempotent, so it gets
 * AT-LEAST-ONCE (capped) semantics — a failed unpin re-persists the record
 * with `finalizeAttempted: true` + an `unpinAttempts` counter so the next boot
 * retries ONLY the unpin (never the edit), up to BOOT_UNPIN_MAX_ATTEMPTS.
 */

export interface ActivityCardStoreFsSeam {
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  /** Atomic same-dir replace (POSIX rename) so a crash mid-write can't tear
   *  the snapshot. */
  renameSync: (from: string, to: string) => void
  existsSync: (path: string) => boolean
}

/** One persisted card handle: enough to identify and finalize the orphaned
 *  Telegram message on a future boot, without any live turn state. */
export interface ActivityCardRecord {
  /** Stable per-topic key (`statusKey(chatId, threadId)` shape) — also the
   *  upsert key: a fresh OPEN for the same topic replaces any stale row. */
  turnKey: string
  chatId: string
  threadId: number | null
  activityMessageId: number
  /** Wall-clock ms the turn started — carried through so the finalize text
   *  can be honest about elapsed time even after a restart. */
  startedAt: number
  /** Whether this card was silently pinned when it opened (the gateway pins
   *  every fresh activity card via `reconcileStatusPin('fg:'+turnKey, …)`).
   *  The boot reaper must unpin it too — a frozen card that's ALSO still
   *  pinned is a worse orphan (it stays glued to the top of the chat
   *  forever). Optional so a v1-shape record (pre-unpin-tracking) still
   *  loads and degrades to "don't attempt an unpin", never a crash. */
  pinned?: boolean
  /** Set when the boot reaper retains a record ONLY to retry its failed
   *  unpin (#3001). The finalizing edit stays AT-MOST-ONCE: a retained
   *  record's edit was already attempted, so the next boot skips the edit
   *  and only retries the (idempotent) unpin. */
  finalizeAttempted?: boolean
  /** Boot-reaper unpin retry counter (#3001); the record is forfeited at
   *  BOOT_UNPIN_MAX_ATTEMPTS. Absent = 0. */
  unpinAttempts?: number
}

/** Cap on cross-boot unpin retries — same rationale as the status-pin
 *  store's BOOT_UNPIN_MAX_ATTEMPTS (bound a permanently-undeliverable
 *  unpin; unpins themselves are idempotent so retrying is safe). */
export const BOOT_UNPIN_MAX_ATTEMPTS = 5

interface SnapshotEnvelope {
  v: 1
  cards: ActivityCardRecord[]
}

function isCardRow(x: unknown): x is ActivityCardRecord {
  if (x == null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.turnKey === 'string' &&
    o.turnKey.length > 0 &&
    typeof o.chatId === 'string' &&
    o.chatId.length > 0 &&
    (o.threadId === null || typeof o.threadId === 'number') &&
    typeof o.activityMessageId === 'number' &&
    typeof o.startedAt === 'number' &&
    (o.pinned === undefined || typeof o.pinned === 'boolean') &&
    (o.finalizeAttempted === undefined || typeof o.finalizeAttempted === 'boolean') &&
    (o.unpinAttempts === undefined || typeof o.unpinAttempts === 'number')
  )
}

/**
 * Load the persisted card-handle set. Returns [] on a missing, unreadable, or
 * malformed file — fail-open, never throws.
 */
export function loadActivityCards(
  path: string,
  fs: ActivityCardStoreFsSeam,
): ActivityCardRecord[] {
  if (!fs.existsSync(path)) return []
  let raw = ''
  try {
    raw = fs.readFileSync(path)
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed == null || typeof parsed !== 'object') return []
  const env = parsed as Record<string, unknown>
  if (env.v !== 1 || !Array.isArray(env.cards)) return []
  return env.cards.filter(isCardRow)
}

/**
 * Persist the card-handle set atomically (write sibling tmp → rename). Never
 * throws — a write failure is logged and the store degrades to in-memory-only
 * for this process (same contract as `status-pin-store.ts`).
 */
export function persistActivityCards(
  path: string,
  fs: ActivityCardStoreFsSeam,
  snapshot: readonly ActivityCardRecord[],
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const env: SnapshotEnvelope = { v: 1, cards: [...snapshot] }
  const tmp = path + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(env))
    fs.renameSync(tmp, path)
  } catch (err) {
    log(
      `activity-card-store: persist FAILED path=${path}: ${(err as Error).message} — ` +
        `durability degraded to in-memory\n`,
    )
  }
}

/**
 * Upsert the card-handle row for `turnKey` (replacing any stale row for the
 * same topic — e.g. a prior turn's card that was never cleared). Called the
 * moment a card OPENs (activityMessageId transitions null → set).
 */
export function writeActivityCardRecord(
  path: string,
  fs: ActivityCardStoreFsSeam,
  record: ActivityCardRecord,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const current = loadActivityCards(path, fs)
  const others = current.filter((c) => c.turnKey !== record.turnKey)
  persistActivityCards(path, fs, [...others, record], log)
}

/**
 * Remove the card-handle row for `turnKey`, if present. Called the moment a
 * card closes/finalizes normally (clearActivitySummary), and by the boot
 * reaper (BEFORE attempting the finalizing edit — the idempotency guard).
 *
 * REAP-RACE guard: when `activityMessageId` is supplied, only a row matching
 * BOTH `turnKey` AND `activityMessageId` is removed. During a slow multi-record
 * reap (e.g. a 429 flood-wait between records), a fresh live turn can upsert a
 * NEW record under the same `turnKey` (its own, different `activityMessageId`).
 * A turnKey-only clear would then delete the LIVE card's durable protection.
 * Scoping the clear to the exact message id the reaper (or the closing turn) is
 * handling leaves the live card's record intact. Omit `activityMessageId` only
 * when you genuinely mean "clear whatever row exists for this topic".
 */
export function clearActivityCardRecord(
  path: string,
  fs: ActivityCardStoreFsSeam,
  turnKey: string,
  activityMessageId?: number,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const current = loadActivityCards(path, fs)
  if (current.length === 0) return
  const next = current.filter(
    (c) =>
      c.turnKey !== turnKey ||
      (activityMessageId !== undefined && c.activityMessageId !== activityMessageId),
  )
  if (next.length === current.length) return
  persistActivityCards(path, fs, next, log)
}

/**
 * Boot-time orphan reaper, extracted as a pure routine over injected seams
 * (mirrors `runStatusPinBootCleanup`). The gateway's thin wrapper binds the
 * live fs, a Telegram edit call, and the logger.
 *
 * CRITICAL ordering, identical constraint to the status-pin cleanup: the
 * caller MUST only invoke this AFTER winning the startup mutex. The store is
 * a shared per-agent file; a losing double-boot running this would finalize
 * cards the still-alive holder's in-flight turn still legitimately owns.
 *
 * Deletes each record from disk BEFORE attempting its edit/unpin (not
 * after), so a crash mid-reap, or a second boot re-reading the file, can
 * never re-finalize (and thus never double-edit, never double-unpin) the
 * same message. `finalizeCard` / `unpinCard` failures (message already
 * deleted, chat unreachable, permissions changed, already-unpinned, etc.)
 * are swallowed — non-fatal, logged, and never re-attempted since the
 * record is already gone.
 *
 * Unpin runs AFTER the finalizing edit, only for a record with `pinned:
 * true` (a v1-shape record with no `pinned` field is left un-unpinned —
 * conservative degrade, not a crash), and its failure is independent of the
 * edit's outcome (an edit failure — e.g. message already deleted — must not
 * skip the unpin attempt, since Telegram allows unpinning a deleted
 * message's id to no-op harmlessly, and conversely an unpin failure must
 * never re-attempt the edit).
 */
export async function runActivityCardBootReaper(args: {
  path: string
  fs: ActivityCardStoreFsSeam
  /** Returns the Telegram result: a truthy value (the edited Message) on a
   *  real delivered edit, or `null`/`undefined` when the underlying
   *  `robustApiCall` swallowed a benign 400 (message already deleted /
   *  vanished / "not modified") — i.e. nothing was actually finalized. */
  finalizeCard: (record: ActivityCardRecord) => Promise<unknown>
  unpinCard: (record: ActivityCardRecord) => Promise<unknown>
  log?: (line: string) => void
}): Promise<{ finalized: number; vanished: number; unpinned: number; total: number }> {
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const persisted = loadActivityCards(args.path, args.fs)
  if (persisted.length === 0) return { finalized: 0, vanished: 0, unpinned: 0, total: 0 }
  let finalized = 0
  let vanished = 0
  let unpinned = 0
  for (const record of persisted) {
    // Delete BEFORE attempting the edit/unpin — the idempotency guard. If the
    // gateway crashes here, or a second boot re-reads the file, this record
    // no longer exists on disk, so it can never be finalized or unpinned
    // twice. Scoped to the exact activityMessageId (reap-race guard): a live
    // turn that upserted a fresh card under the same turnKey mid-reap keeps
    // its own (different-id) record.
    clearActivityCardRecord(args.path, args.fs, record.turnKey, record.activityMessageId, log)
    // The finalizing EDIT stays at-most-once: skip it for a record retained by
    // a prior boot purely to retry its failed unpin (finalizeAttempted).
    if (!record.finalizeAttempted) {
      try {
        // Count a finalize ONLY when the edit actually landed. robustApiCall
        // resolves to undefined on a benign-400 (the card was already deleted or
        // the chat is gone) — that delivered nothing, so it is a `vanished`
        // orphan, not a `finalized` one. Counting it as finalized (the pre-fix
        // behaviour) over-reported the guarantee in the boot log.
        const res = await args.finalizeCard(record)
        if (res != null) finalized++
        else vanished++
      } catch (err) {
        log(
          `activity-card-store: boot reaper finalize failed ` +
            `(chat=${record.chatId} msg=${record.activityMessageId}): ` +
            `${(err as Error).message}\n`,
        )
      }
    }
    if (record.pinned) {
      try {
        await args.unpinCard(record)
        unpinned++
      } catch (err) {
        // Retry-safe unpin (#3001): unlike the edit (at-most-once by design),
        // an unpin is idempotent — so a failed one is RE-PERSISTED with an
        // attempt counter and retried on the next boot, up to the cap, instead
        // of being forfeited. `finalizeAttempted` guarantees the retained
        // record can never re-run its edit.
        const attempts = (record.unpinAttempts ?? 0) + 1
        log(
          `activity-card-store: boot reaper unpin failed ` +
            `(chat=${record.chatId} msg=${record.activityMessageId} ` +
            `attempt=${attempts}): ${(err as Error).message}\n`,
        )
        if (attempts < BOOT_UNPIN_MAX_ATTEMPTS) {
          writeActivityCardRecord(
            args.path,
            args.fs,
            { ...record, finalizeAttempted: true, unpinAttempts: attempts },
            log,
          )
        }
      }
    }
  }
  return { finalized, vanished, unpinned, total: persisted.length }
}

/**
 * Mid-session periodic orphan reaper (#2918). The boot reaper above only runs
 * once at startup, so a card whose owning turn's process dies MID-session (SDK
 * subprocess SIGKILL / OOM / crash) without a clean finalize stays frozen on
 * its last "working…" frame until the NEXT gateway boot — hours later. This
 * variant runs inside the LIVE gateway on a timer and finalizes ONLY records
 * that are demonstrably orphaned:
 *
 *   - `isLive(record)` — the caller's liveness predicate (gateway:
 *     `currentTurnMap.byKey.has(record.turnKey)` OR the singleton `currentTurn`
 *     mirror owns this topic). A record whose topic is still live is NEVER
 *     touched, so the currently-spinning card of an in-flight turn is safe.
 *   - age gate — `now - startedAt >= ttlMs`, a secondary guard so a card that
 *     JUST opened (before its turn populated the live map) is protected.
 *
 * Same AT-MOST-ONCE contract as the boot reaper: each record is deleted from
 * the store BEFORE its finalize/unpin is attempted, and failures are swallowed
 * without retry. The two reapers share `runOneCardFinalize` semantics via the
 * identical delete-first ordering — a boot reaper and a mid-session sweep can
 * never double-finalize the same message (whichever deletes the record first
 * wins; the other sees an empty/short list).
 */
export async function runActivityCardMidSessionReaper(args: {
  path: string
  fs: ActivityCardStoreFsSeam
  /** True IFF the record's topic is still owned by a live in-flight turn. */
  isLive: (record: ActivityCardRecord) => boolean
  ttlMs: number
  now?: number
  finalizeCard: (record: ActivityCardRecord) => Promise<unknown>
  unpinCard: (record: ActivityCardRecord) => Promise<unknown>
  log?: (line: string) => void
}): Promise<{ finalized: number; vanished: number; unpinned: number; total: number }> {
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const now = args.now ?? Date.now()
  const cutoff = now - args.ttlMs
  const persisted = loadActivityCards(args.path, args.fs)
  // Only ownerless cards aged past the TTL. Liveness does the real work; the
  // age gate only closes the just-opened-not-yet-tracked race window.
  const stale = persisted.filter(
    (r) => !args.isLive(r) && r.startedAt <= cutoff,
  )
  if (stale.length === 0) return { finalized: 0, vanished: 0, unpinned: 0, total: 0 }
  let finalized = 0
  let vanished = 0
  let unpinned = 0
  for (const record of stale) {
    // Delete BEFORE the edit — the same idempotency guard the boot reaper uses.
    clearActivityCardRecord(args.path, args.fs, record.turnKey, record.activityMessageId, log)
    try {
      const res = await args.finalizeCard(record)
      if (res != null) finalized++
      else vanished++
    } catch (err) {
      log(
        `activity-card-store: mid-session reaper finalize failed ` +
          `(chat=${record.chatId} msg=${record.activityMessageId}): ` +
          `${(err as Error).message}\n`,
      )
    }
    if (record.pinned) {
      try {
        await args.unpinCard(record)
        unpinned++
      } catch (err) {
        log(
          `activity-card-store: mid-session reaper unpin failed ` +
            `(chat=${record.chatId} msg=${record.activityMessageId}): ` +
            `${(err as Error).message}\n`,
        )
      }
    }
  }
  return { finalized, vanished, unpinned, total: stale.length }
}

/**
 * Honest finalize text for an orphaned card — the single edit the boot
 * reaper applies. Mirrors `silentEndFallbackText`'s honesty-about-elapsed
 * convention (`telegram-plugin/silent-end.ts`): degenerate/unknown durations
 * omit the elapsed clause rather than printing a nonsensical "(0s)".
 */
export function restartOrphanCardFinalizeText(startedAt: number): string {
  const elapsedMs = Date.now() - startedAt
  const elapsed =
    Number.isFinite(elapsedMs) && elapsedMs > 0
      ? ` (was running ${Math.round(elapsedMs / 1000)}s)`
      : ''
  return `⚠️ Interrupted by a gateway restart${elapsed} — this turn did not finish.`
}
