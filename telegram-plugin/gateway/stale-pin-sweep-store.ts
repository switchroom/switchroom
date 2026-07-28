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
  /** Last terminal-ish reason, for operator forensics. Never load-bearing. */
  lastStatus?: string
  /** Wall-clock ms of the last write. */
  updatedAt: number
}

/**
 * How many boots may attempt one obligation before it is forfeited. Generous
 * because a legitimate deep stack in a supergroup is deliberately spread over
 * several boots (10 pops per chat per sweep — see `GROUP_SWEEP_GATE`): 8 boots
 * covers an 80-deep stack, well past anything observed.
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

interface SweepEnvelope {
  v: 1
  cursors: SweepCursor[]
}

const SWEEP_ENVELOPE_VERSIONS = new Set([1])

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
  if (
    typeof env.v !== 'number' ||
    !SWEEP_ENVELOPE_VERSIONS.has(env.v) ||
    !Array.isArray(env.cursors)
  ) {
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
  const env: SweepEnvelope = { v: 1, cursors: [...cursors] }
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

/** Drop discharged and forfeited rows — called once the ledger is reseeded. */
export function pruneSweepCursors(cursors: readonly SweepCursor[]): SweepCursor[] {
  return cursors.filter((c) => !c.done && c.attempts < SWEEP_MAX_ATTEMPTS)
}
