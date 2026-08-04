/**
 * stale-pin-sweep-store.ts — the durable OBLIGATION ledger for the stale-pin
 * sweep (`stale-pin-sweep.ts`).
 *
 * Why an obligation and not a "did we sweep this boot?" flag
 * ---------------------------------------------------------
 * Draining a deep pin stack is not one API call. In a DM each pop costs a
 * re-pin plus an unpin, both rate-gated, so a chat with 21 orphans (klanker,
 * observed 2026-07-29) takes north of a minute of wall clock. The old
 * once-per-boot in-memory `Set` (`dm-pin-sweep.ts`) forgot everything the
 * instant the process died: a gateway restarted mid-drain simply started over
 * — or, once the per-boot pop budget was in play, never finished at all.
 *
 * So the sweep is modelled as a persisted OBLIGATION per `(chatId, threadId)`
 * target: seeded from the pin stores at boot, advanced as pops land, and
 * discharged (`done: true`) only once the drain is VERIFIED empty. A restart
 * mid-sweep reloads the ledger and RESUMES from `popped` rather than forgetting.
 *
 * Durability: the write goes through `atomicWriteFileSync` (src/util/atomic.ts)
 * — tempfile in the same directory, `fsync` on the fd, then `rename(2)`. A
 * power cut leaves either the previous complete ledger or the new one, and the
 * bytes of whichever survives are on the platter. A plain
 * `writeFileSync`+`rename` would give atomicity without durability: the rename
 * can be ordered before the data reaches disk, which is exactly how a crashed
 * host comes back with a zero-length ledger and a chat full of orphan pins that
 * nothing remembers to clean.
 *
 * Shape choice mirrors `status-pin-store.ts`: a whole-file SNAPSHOT, because
 * the obligation set is tiny (one row per chat/topic the agent has ever pinned
 * in) and rewriting it is trivially cheap. PURE with respect to the injected fs
 * seam, so the ledger semantics are unit-testable without touching a disk.
 */

/** Chat classes the sweep treats differently. See `classifyChatForSweep`. */
export type SweepChatKind = 'dm' | 'forum-topic' | 'supergroup'

/** One persisted sweep obligation for a single `(chatId, threadId)` target. */
export interface SweepCursor {
  /** Chat the orphan pins live in. */
  chatId: string
  /**
   * Forum topic the target is scoped to, when known.
   *
   * This is the `(chat, thread)` half of the registry key. Telegram's pin stack
   * is CHAT-WIDE — MTProto `messages.updatePinnedMessage` carries no
   * `top_msg_id` and the Bot API's `pinChatMessage`/`unpinChatMessage` accept no
   * `message_thread_id` — so a "topic pin" is really a chat-level pin whose
   * message happens to live in that thread, and clients render the topic bar by
   * filtering. A bot therefore cannot enumerate pins or target a topic with
   * pin/unpin. The ONE topic-scoped verb it does have is
   * `unpinAllForumTopicMessages(chat_id, message_thread_id)`, and that verb is
   * the whole reason this field must be persisted: without it, a boot after a
   * crash knows a forum chat has orphans but not which topic to drain.
   */
  threadId?: number
  /** Chat class, decided when the obligation was seeded. */
  kind: SweepChatKind
  /** Pops (or drain attempts) committed so far, ACROSS boots. */
  popped: number
  /** True once the drain was verified empty — the obligation is discharged. */
  done: boolean
  /**
   * Boots that have attempted this obligation. Bounded by
   * {@link SWEEP_MAX_ATTEMPTS} so a permanently-undrainable chat (bot kicked,
   * rights revoked, a chat that flood-waits forever) cannot re-burn the pop
   * budget on every boot for the rest of time.
   */
  attempts: number
  /**
   * Message ids this obligation has already issued a targeted unpin for.
   *
   * Load-bearing for the GROUP path, which is not a blind stack drain but a
   * bounded pass over the ids the gateway is on record as having pinned. When a
   * boot spends its per-minute budget half way through that list, this is what
   * lets the next boot resume at the right place instead of re-issuing (and
   * re-charging the flood ledger for) every unpin from the start.
   *
   * Unused by the DM path, which drains by observation and has no id list.
   */
  doneIds?: number[]
  /** Last terminal-ish reason, for operator forensics. Never load-bearing. */
  lastStatus?: string
  /** Wall-clock ms of the last write. */
  updatedAt: number
}

/**
 * How many boots may attempt one obligation before it is forfeited. Generous
 * because a legitimate deep stack is deliberately spread over several boots
 * (the per-minute pin-op budget, and in a DM the 40-pop-per-chat cap): 8 boots
 * covers far more than anything observed on the fleet.
 */
export const SWEEP_MAX_ATTEMPTS = 8

/** Injected fs seam — same shape as the status-pin store's, so the gateway can
 *  bind one durable writer for both. `writeFileSync` MUST be durable (fsync +
 *  atomic rename); the gateway binds `atomicWriteFileSync`. */
export interface SweepStoreFsSeam {
  readFileSync: (path: string) => string
  /** Durable atomic replace of `path` with `data` (fsync then rename). */
  writeFileSync: (path: string, data: string) => void
  existsSync: (path: string) => boolean
}

/**
 * Envelope. Same bump rule as `status-pin-store.ts` (#3957): every field added
 * after v1 is OPTIONAL, and the reader is version-TOLERANT so a row written by
 * a newer build survives a downgrade rather than being discarded. Discarding is
 * not "do nothing" for an obligation ledger — it forgets an obligation, which
 * is precisely the orphaned-pin failure this module exists to close.
 */
interface SweepEnvelope {
  v: number
  cursors: SweepCursor[]
}

/** The version THIS build writes. Only the writer is pinned; see above. */
const SWEEP_ENVELOPE_VERSION = 1

/** Stable identity of a sweep target: chat plus topic (topic-less = `-`). */
export function sweepTargetKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '-'}`
}

function isCursorRow(x: unknown): x is SweepCursor {
  if (x == null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.chatId === 'string' &&
    o.chatId.length > 0 &&
    (o.threadId === undefined || typeof o.threadId === 'number') &&
    (o.kind === 'dm' || o.kind === 'forum-topic' || o.kind === 'supergroup') &&
    typeof o.popped === 'number' &&
    typeof o.done === 'boolean' &&
    typeof o.attempts === 'number' &&
    (o.doneIds === undefined ||
      (Array.isArray(o.doneIds) && o.doneIds.every((n) => typeof n === 'number'))) &&
    (o.lastStatus === undefined || typeof o.lastStatus === 'string') &&
    typeof o.updatedAt === 'number'
  )
}

/**
 * Load the obligation ledger. Fails OPEN to `[]` on a missing, unreadable or
 * malformed file: a corrupt ledger must never crash boot. Worst case the sweep
 * re-seeds from the pin stores, which is exactly the pre-ledger behaviour.
 */
export function loadSweepCursors(path: string, fs: SweepStoreFsSeam): SweepCursor[] {
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
  // Version-TOLERANT, structurally strict — see {@link SweepEnvelope}. An
  // unknown `v` still yields the cursor rows that validate.
  if (!Number.isInteger(env.v) || (env.v as number) < 1 || !Array.isArray(env.cursors)) {
    return []
  }
  return env.cursors.filter(isCursorRow)
}

/**
 * Persist the ledger durably. Best-effort relative to fs availability: a write
 * failure is logged, never thrown — a failing ledger degrades the sweep to
 * "forgets across restarts" (the old behaviour), it must not break the gateway.
 */
export function persistSweepCursors(
  path: string,
  fs: SweepStoreFsSeam,
  cursors: readonly SweepCursor[],
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const env: SweepEnvelope = { v: SWEEP_ENVELOPE_VERSION, cursors: [...cursors] }
  try {
    fs.writeFileSync(path, JSON.stringify(env))
  } catch (err) {
    log(
      `stale-pin-sweep-store: persist FAILED path=${path}: ${(err as Error).message} — ` +
        `durability degraded; a restart mid-sweep will re-seed instead of resume\n`,
    )
  }
}

/**
 * READ-MODIFY-WRITE one target's row against the file on disk, so a concurrent
 * writer's rows are never clobbered by a stale in-memory snapshot. Mirrors
 * `applyStatusPinRow` in status-pin-store.ts.
 */
export function upsertSweepCursor(
  path: string,
  fs: SweepStoreFsSeam,
  cursor: SweepCursor,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const key = sweepTargetKey(cursor.chatId, cursor.threadId)
  const others = loadSweepCursors(path, fs).filter(
    (c) => sweepTargetKey(c.chatId, c.threadId) !== key,
  )
  persistSweepCursors(path, fs, [...others, cursor], log)
}

/**
 * The obligations still owed at boot: not discharged and not forfeited.
 *
 * A `done` row is retained in the ledger (rather than deleted) only until the
 * next seed pass; `pruneSweepCursors` drops it. Keeping it for the duration of
 * one boot is what makes a mid-sweep restart idempotent — the resumed sweep
 * sees "already drained" instead of re-draining a chat it just cleared.
 */
export function pendingSweepCursors(cursors: readonly SweepCursor[]): SweepCursor[] {
  return cursors.filter((c) => !c.done && c.attempts < SWEEP_MAX_ATTEMPTS)
}

/**
 * Boot seed pass: drop DISCHARGED (`done: true`) rows ONLY, so a chat that
 * drained in a prior session is re-evaluated LIVE on the next sweep instead of
 * short-circuiting forever on a stale `done` (#3953 regression — the seed pass
 * was never wired, so `done` was effectively permanent).
 *
 * FORFEITED rows (`attempts >= SWEEP_MAX_ATTEMPTS`, still `!done`) are
 * deliberately RETAINED. Their whole purpose is to remember that a chat's
 * attempt budget is spent (bot kicked, pin rights revoked, a chat that
 * flood-waits forever). Pruning one would let the next boot re-seed it from the
 * pin stores and re-burn the full 8-attempt budget on every boot for the rest
 * of time — precisely the Telegram flood the attempt cap exists to prevent. So
 * this filters on `done` ALONE; it must NOT also gate on `attempts`.
 */
export function pruneSweepCursors(cursors: readonly SweepCursor[]): SweepCursor[] {
  return cursors.filter((c) => !c.done)
}

/**
 * BOOT-SEED reseed of the durable ledger (#3953): drop discharged (`done:true`)
 * rows so a `(chat, thread)` that drained in a prior session is re-evaluated
 * LIVE on the next sweep instead of short-circuiting forever on a stale `done`.
 * Forfeited rows are retained (see {@link pruneSweepCursors}).
 *
 * Writes ONLY when the prune changed the ledger, so a no-op boot never churns
 * the durable file. Never throws — a reseed failure degrades to the pre-fix
 * behaviour (the stale `done` survives one more boot), it must not break boot.
 *
 * BOOT-SCOPED BY CONTRACT: the caller must invoke this once at boot, never on
 * the per-inbound path (which fires on every message — re-arming a full re-drain
 * per message is a Telegram flood).
 */
export function reseedSweepLedger(
  path: string,
  fs: SweepStoreFsSeam,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const rows = loadSweepCursors(path, fs)
  const pruned = pruneSweepCursors(rows)
  if (pruned.length !== rows.length) persistSweepCursors(path, fs, pruned, log)
}
