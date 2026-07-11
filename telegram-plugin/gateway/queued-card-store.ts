/**
 * queued-card-store.ts — durable handle for the component-5 queued-status
 * placeholder and the #2995 mid-flight busy-ack card, so a gateway restart
 * mid-turn can reap the orphaned card instead of leaving a permanent stale
 * "⏳ Queued…" line in the chat.
 *
 * Why this exists (#3002): both cards track their sent Telegram message id ONLY
 * in the in-memory `queuedStatusMsgIds` Map in gateway.ts. A gateway/container
 * restart between posting a card and its in-process promote/reap empties that
 * Map, so the card is stranded: a permanent "⏳ Queued — replying in another
 * topic first…" (or busy-ack) line that never gets promoted or deleted, sitting
 * above the real answer.
 *
 * The fix mirrors `activity-card-store.ts` / `status-pin-store.ts` in shape: a
 * tiny durable snapshot on the per-agent state volume (STATE_DIR), written
 * whenever a card is POSTED, cleared the moment it is reaped/deleted in-process.
 * On boot, AFTER this gateway wins the startup mutex (same ordering constraint
 * as the status-pin/activity-card cleanups — this is a shared per-agent file, so
 * a losing double-boot must never touch it), a one-shot reaper DELETES any
 * leftover card via the Bot API and clears the store.
 *
 * DELETION is the honest terminal (deliberate — reap-on-boot only, NO
 * promote-across-restart): a "Queued" / "On it — replying now" claim is ALWAYS
 * wrong after a restart (the turn it referred to is over or being re-run from
 * scratch), so the only correct move is to remove the card. We do NOT attempt to
 * re-promote or re-adopt it across the restart; the resumed/replayed turn owns
 * fresh surfaces.
 *
 * Crash-safety: write-tmp + atomic rename (identical convention to
 * activity-card-store.ts / status-pin-store.ts). A corrupt or unreadable file
 * fails open to `[]` — never crashes boot, worst case an orphan isn't reaped
 * this boot, no worse than pre-fix behaviour.
 *
 * IDEMPOTENCY: the reaper deletes each record from the on-disk store BEFORE
 * attempting its Telegram delete (delete-first, mirroring the activity-card
 * reaper), so a crash mid-reap or a second boot re-reading the file can never
 * re-issue a delete for a message already handled. A Telegram delete of an
 * already-gone message is itself harmless (the caller tolerates "message not
 * found"); delete-first simply keeps the store honest.
 */

export interface QueuedCardStoreFsSeam {
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  /** Atomic same-dir replace (POSIX rename) so a crash mid-write can't tear
   *  the snapshot. */
  renameSync: (from: string, to: string) => void
  existsSync: (path: string) => boolean
}

/** One persisted queued/busy-ack card: enough to delete the orphaned Telegram
 *  message on a future boot, without any live turn state. */
export interface QueuedCardRecord {
  /** Stable per-topic key (`statusKey(chatId, threadId)` shape) — also the
   *  upsert key: a fresh post for the same topic replaces any stale row. */
  key: string
  chatId: string
  /** Forum topic id, or null for a DM / General-topic card. */
  threadId: number | null
  messageId: number
}

interface SnapshotEnvelope {
  v: 1
  cards: QueuedCardRecord[]
}

function isCardRow(x: unknown): x is QueuedCardRecord {
  if (x == null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.key === 'string' &&
    o.key.length > 0 &&
    typeof o.chatId === 'string' &&
    o.chatId.length > 0 &&
    (o.threadId === null || typeof o.threadId === 'number') &&
    typeof o.messageId === 'number'
  )
}

/**
 * Load the persisted card set. Returns [] on a missing, unreadable, or
 * malformed file — fail-open, never throws.
 */
export function loadQueuedCards(
  path: string,
  fs: QueuedCardStoreFsSeam,
): QueuedCardRecord[] {
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
 * Persist the card set atomically (write sibling tmp → rename). Never throws —
 * a write failure is logged and the store degrades to in-memory-only for this
 * process (same contract as `activity-card-store.ts`).
 */
export function persistQueuedCards(
  path: string,
  fs: QueuedCardStoreFsSeam,
  snapshot: readonly QueuedCardRecord[],
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const env: SnapshotEnvelope = { v: 1, cards: [...snapshot] }
  const tmp = path + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(env))
    fs.renameSync(tmp, path)
  } catch (err) {
    log(
      `queued-card-store: persist FAILED path=${path}: ${(err as Error).message} — ` +
        `durability degraded to in-memory\n`,
    )
  }
}

/**
 * Upsert the card row for `key` (replacing any stale row for the same topic).
 * Called the moment a queued-status / busy-ack card is POSTED (its message id
 * is recorded into the in-memory `queuedStatusMsgIds` Map).
 */
export function writeQueuedCardRecord(
  path: string,
  fs: QueuedCardStoreFsSeam,
  record: QueuedCardRecord,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const current = loadQueuedCards(path, fs)
  const others = current.filter((c) => c.key !== record.key)
  persistQueuedCards(path, fs, [...others, record], log)
}

/**
 * Remove the card row for `key`, if present. Called the moment the card is
 * reaped/deleted in-process (reapQueuedStatus), and by the boot reaper (BEFORE
 * attempting the Telegram delete — the idempotency guard).
 *
 * When `messageId` is supplied, only a row matching BOTH `key` AND `messageId`
 * is removed (reap-race guard): during a slow multi-record reap a fresh live
 * turn could post a NEW card under the same key (its own, different messageId);
 * a key-only clear would then drop the live card's durable protection. Omit
 * `messageId` only when you mean "clear whatever row exists for this topic".
 */
export function clearQueuedCardRecord(
  path: string,
  fs: QueuedCardStoreFsSeam,
  key: string,
  messageId?: number,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const current = loadQueuedCards(path, fs)
  if (current.length === 0) return
  const next = current.filter(
    (c) => c.key !== key || (messageId !== undefined && c.messageId !== messageId),
  )
  if (next.length === current.length) return
  persistQueuedCards(path, fs, next, log)
}

/**
 * Boot-time orphan reaper, extracted as a pure routine over injected seams
 * (mirrors `runActivityCardBootReaper`). The gateway's thin wrapper binds the
 * live fs, a Telegram delete call, and the logger.
 *
 * CRITICAL ordering, identical constraint to the status-pin / activity-card
 * cleanups: the caller MUST only invoke this AFTER winning the startup mutex.
 * The store is a shared per-agent file; a losing double-boot running this would
 * delete a card the still-alive holder's in-flight turn still legitimately owns.
 *
 * Deletes each record from disk BEFORE attempting its Telegram delete (not
 * after), so a crash mid-reap, or a second boot re-reading the file, can never
 * re-issue a delete. A `deleteCard` failure (message already gone, chat
 * unreachable, permissions changed) is swallowed — non-fatal, logged, and never
 * re-attempted since the record is already gone. Returns counts for
 * logging/testing.
 */
export async function runQueuedCardBootReaper(args: {
  path: string
  fs: QueuedCardStoreFsSeam
  deleteCard: (record: QueuedCardRecord) => Promise<unknown>
  log?: (line: string) => void
}): Promise<{ deleted: number; total: number }> {
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const persisted = loadQueuedCards(args.path, args.fs)
  if (persisted.length === 0) return { deleted: 0, total: 0 }
  let deleted = 0
  for (const record of persisted) {
    // Delete BEFORE attempting the Telegram delete — the idempotency guard.
    clearQueuedCardRecord(args.path, args.fs, record.key, record.messageId, log)
    try {
      await args.deleteCard(record)
      deleted++
    } catch (err) {
      log(
        `queued-card-store: boot reaper delete failed ` +
          `(chat=${record.chatId} msg=${record.messageId}): ` +
          `${(err as Error).message}\n`,
      )
    }
  }
  return { deleted, total: persisted.length }
}
