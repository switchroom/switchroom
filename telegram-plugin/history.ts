/**
 * Persistent message history for the Telegram plugin.
 *
 * Telegram's Bot API exposes no chat history endpoint, so the agent has no
 * way to recover "what were we just talking about" after a Claude Code
 * restart without asking the user. This module fills that gap by writing
 * every inbound and outbound message that flows through the plugin to a
 * local SQLite database, queryable via the `get_recent_messages` MCP tool.
 *
 * Storage is `bun:sqlite` (Bun's bundled SQLite, no extra dep). The DB file
 * lives at `${STATE_DIR}/history.db` and is chmod'd to 0600 to match the
 * plugin's existing credential-handling pattern.
 *
 * Capture is gated:
 *   - Inbound: only writes after the access gate, topic filter, and the
 *     permission-reply intercept have passed (see server.ts handleInbound).
 *   - Outbound: the reply/stream_reply/forward_message/edit_message handlers
 *     all assertAllowedChat() before reaching the capture call sites.
 *
 * Per-chunk rows: when a long `reply` is split into multiple Telegram
 * messages by the chunker, each chunk lands as its own row keyed by its
 * real message_id, with a shared `group_id` (the first chunk's id) so
 * the logical reply can be reconstructed if needed. This keeps
 * `before_message_id` pagination working — every visible message in the
 * chat exists in the DB.
 */

import { chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { adoptSqliteOwnership, mkdirStateSync } from '../src/util/state-owner.js'
import { redact } from './secret-detect/redact.js'

/**
 * `bun:sqlite` is a Bun built-in — Vite/Node loaders can't resolve it
 * statically, which would crash any vitest test that transitively
 * imports this module (every test that imports server.ts). Hide the
 * require behind an eval so static analysis passes; runtime resolution
 * is per-Bun and works fine.
 *
 * The Database class is loaded lazily on the first initHistory() call.
 * If we're somehow running under non-Bun (vitest fallback, ts-node, etc.)
 * the lazy load throws — but only when the caller actually tries to use
 * the history feature, not on module import.
 *
 * The only Database APIs we touch are constructor(path, opts), exec,
 * prepare, transaction, close — all stable across bun:sqlite versions.
 */
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown
  /**
   * `throwOnError` is bun:sqlite's "hard close" switch. The default
   * (`close()`) is a SOFT close that silently defers the real
   * `sqlite3_close` while any un-finalized `Statement` still references the
   * connection — and every one of our statements is created per-call by
   * `requireDb().prepare(...)`, so they are only reclaimed by GC.
   * `close(true)` instead THROWS (`database is locked`) when the close did
   * not actually happen, which is the only way to know. Load-bearing for
   * {@link reopenHistory}; see the long note there.
   */
  close(throwOnError?: boolean): void
}
type SqliteDatabaseConstructor = new (path: string, opts?: { create?: boolean }) => SqliteDatabase

let DatabaseClass: SqliteDatabaseConstructor | null = null
function loadDatabaseClass(): SqliteDatabaseConstructor {
  if (DatabaseClass != null) return DatabaseClass
  try {
    // Bun exposes a `require` on `import.meta` that works in ESM modules
    // and resolves built-in `bun:*` modules. Vite/esbuild's static
    // analyzer doesn't follow `import.meta.require(...)` calls (it only
    // resolves static `import` statements), so this hides the bun:sqlite
    // import from the test loader. Under non-Bun runtimes
    // `import.meta.require` is undefined and we throw a clear error.
    const metaRequire = (import.meta as { require?: (id: string) => unknown }).require
    if (typeof metaRequire !== 'function') {
      throw new Error('import.meta.require not available — Bun runtime required')
    }
    const mod = metaRequire('bun:sqlite') as { Database?: SqliteDatabaseConstructor }
    if (!mod.Database) throw new Error('bun:sqlite did not export Database')
    DatabaseClass = mod.Database
    return DatabaseClass
  } catch (err) {
    throw new Error(
      `history.ts requires Bun runtime (bun:sqlite). Caller: ${(err as Error).message}`,
    )
  }
}

/**
 * `system` is the CARD lane (#4571): a bot→user message the gateway posted as
 * a UI surface rather than as an answer — the mid-turn activity card, the
 * status pin, approval / boot / issues / worker-feed cards, restart notices,
 * `progress_update` lines. Those consume real Telegram message ids, so the
 * operator can (and does) quote-reply to one; before this lane existed the
 * row simply did not exist and the reply resolved to nothing.
 *
 * They are deliberately NOT `assistant`: every delivery-accounting predicate
 * in this file keys on `role = 'assistant'` meaning "the user was actually
 * answered" (`getRecentOutboundCount`, `hasOutboundDeliveredSince`,
 * `hasOutboundWithText`), and calling a card an answer would silently suppress
 * the silence/over-ping/represent safety nets. A distinct value keeps every
 * existing predicate byte-identical while making the id resolvable.
 */
export type MessageRole = 'user' | 'assistant' | 'system'

export interface RecordedMessage {
  chat_id: string
  thread_id: number | null
  message_id: number
  role: MessageRole
  user: string | null
  user_id: string | null
  ts: number
  text: string
  attachment_kind: string | null
  group_id: number | null
  /**
   * Set when the inbound user message was a Telegram-native reply to a
   * prior message. Lets get_recent_messages surface the reply context
   * the agent saw at delivery time.
   */
  reply_to_message_id: number | null
  reply_to_text: string | null
  /**
   * The most recent emoji reaction the user placed on this (assistant)
   * message. Null means no reaction or reaction was removed. Updated by
   * the message_reaction handler when Telegram delivers reaction events.
   * Only emoji reactions are tracked — custom emoji are ignored for v1.
   */
  user_reaction: string | null
  /**
   * Set when the inbound user message was FORWARDED: the server-stamped
   * `forward_origin` of the original message (Bot API 7.0+), so
   * get_recent_messages can surface who originally sent the content the
   * agent saw at delivery time. `forwarded_from` is the raw (truncated,
   * unescaped) human-readable name/title; `forwarded_from_type` is
   * user|hidden_user|chat|channel (hidden_user = self-reported display
   * name, no verifiable id); `forwarded_from_id` is the numeric id when
   * the origin shape exposes one; `forwarded_date` is the original
   * message's ISO timestamp; `forwarded_message_id` is the message id
   * inside the origin channel (channel origins only). For a multi-origin
   * coalesced burst only the PRIMARY (first) origin is persisted here —
   * origins 2+ exist only in the delivered channel tag's numbered attrs.
   */
  forwarded_from: string | null
  forwarded_from_type: string | null
  forwarded_from_id: string | null
  forwarded_date: string | null
  forwarded_message_id: number | null
  /**
   * Discriminator for a `system` (card) row: the send's `verb` tag as it was
   * passed to the gateway's retry wrapper, normalised (`activity-summary.send`
   * → `activity-summary`). Null for `user` / `assistant` rows and for an
   * untagged send. Surfaced to the agent as `reply_to_kind` when a native
   * reply points at one of these messages.
   */
  kind: string | null
}

export interface QueryOptions {
  chat_id: string
  thread_id?: number | null
  limit?: number
  before_message_id?: number
  /**
   * Include `system` (card) rows in the result. DEFAULT FALSE, deliberately:
   * cards are ephemeral UI, and `get_recent_messages` renders straight into
   * the operator-visible model context — a wall of activity-card rows there
   * would be a regression. Card rows stay RESOLVABLE by id (see
   * {@link lookupMessageRoleAndText}) without being LISTED.
   */
  include_system?: boolean
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

let db: SqliteDatabase | null = null
let dbPath: string | null = null

/**
 * Loud, unconditional failure logging for the history writer.
 *
 * Recording bugs are silent by construction: every gateway call site wraps
 * `recordOutbound` / `recordInbound` in a `try { … } catch {}` (or a catch that
 * logs a caller-shaped message), and several of those catches are EMPTY. When a
 * write throws or drops a row, the caller's empty catch hides it — the exact
 * failure mode behind the 2026-07-16 incident (turn-flush deliveries 18944 /
 * 18958 delivered to Telegram but absent from history.db, blinding
 * `getRecentOutboundCount` / `hasOutboundDeliveredSince`). We therefore log HERE,
 * inside the writer, BEFORE any throw — so even a caller's `catch {}` cannot
 * suppress the diagnostic. Deterministic surfacing, not prompt discipline.
 */
function warnHistory(msg: string): void {
  try {
    process.stderr.write(`telegram history: ${msg}\n`)
  } catch {
    /* stderr write must never itself break the record path */
  }
}

/**
 * A Telegram message_id is a positive 32-bit-ish integer. A null / undefined /
 * NaN / non-integer id can only arrive from a malformed send result (e.g. an
 * API wrapper that resolved without a real message object). Inserting it either
 * violates the NOT NULL PRIMARY KEY (throws → swallowed by an empty caller
 * catch) or silently corrupts the key space. We filter such ids out and log
 * loudly instead — a delivered-but-unrecorded row is a durability defect the
 * operator must see, not a silent drop.
 */
function isValidMessageId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0
}

/**
 * Open (or create) the history DB and run migrations + retention sweep.
 * Idempotent — safe to call once at server startup.
 *
 * `retentionDays` deletes rows older than the cutoff. 0 disables retention.
 */
export function initHistory(stateDir: string, retentionDays = 30): void {
  if (db != null) return
  const Database = loadDatabaseClass()
  mkdirStateSync(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, 'history.db')
  dbPath = path
  db = new Database(path, { create: true })
  // WAL is friendlier for concurrent reads while a long transaction writes,
  // and survives crashes more cleanly than rollback journal.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // Without a busy_timeout, bun:sqlite defaults to 0ms and a contending
  // writer fails IMMEDIATELY with SQLITE_BUSY. History rows feed owed-reply
  // logic (a dropped write can lose an owed reply), so wait-and-retry rather
  // than drop. Mirrors the registry DB's pattern (turns-schema.ts).
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      chat_id        TEXT    NOT NULL,
      thread_id      INTEGER,
      message_id     INTEGER NOT NULL,
      role           TEXT    NOT NULL,
      user           TEXT,
      user_id        TEXT,
      ts             INTEGER NOT NULL,
      text           TEXT    NOT NULL,
      attachment_kind TEXT,
      group_id       INTEGER,
      reply_to_message_id INTEGER,
      reply_to_text  TEXT,
      kind           TEXT,
      PRIMARY KEY (chat_id, thread_id, message_id)
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_recent
      ON messages (chat_id, thread_id, ts DESC)
  `)
  // Migration: add reply_to columns to existing DBs that pre-date issue #119,
  // and the forwarded_* origin columns (forward_origin metadata) to DBs that
  // pre-date them. SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN, so
  // we tolerate "duplicate column name" errors and re-throw anything else.
  for (const column of [
    "reply_to_message_id INTEGER",
    "reply_to_text TEXT",
    "user_reaction TEXT",
    "forwarded_from TEXT",
    "forwarded_from_type TEXT",
    "forwarded_from_id TEXT",
    "forwarded_date TEXT",
    "forwarded_message_id INTEGER",
    // #4571 — card/system-surface discriminator. Nullable with no default, so
    // the ALTER is instant on a multi-thousand-row live DB and every existing
    // row keeps its exact contents (SQLite backfills NULL without a rewrite).
    "kind TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${column}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/duplicate column name/i.test(msg)) throw err
    }
  }

  // Migration (review finding H5): make INSERT OR REPLACE idempotent for thread-less rows.
  //
  // The table's PRIMARY KEY is (chat_id, thread_id, message_id), but thread_id
  // is nullable and SQLite treats NULL as DISTINCT from NULL in a PK/UNIQUE
  // index. Every DM and every non-topic group message has thread_id = NULL, so
  // two inserts of the same (chat_id, message_id) with NULL thread do NOT
  // conflict — `INSERT OR REPLACE` APPENDS a duplicate row instead of replacing
  // it. On the documented at-least-once boot replay / synthesized-resume
  // re-record, an already-stored message is duplicated, inflating
  // get_recent_messages and the getRecentOutboundCount / hasOutboundDeliveredSince
  // counters that feed the silence / over-ping detectors.
  //
  // Fix: a UNIQUE index over COALESCE(thread_id, '') gives every logical
  // (chat, thread-or-general, message_id) key a NON-null uniqueness value, so
  // REPLACE conflict-resolves and dedupes thread-less rows too. INSERT OR
  // REPLACE resolves against ANY unique index, so no writer change is needed.
  // A forum-topic row (non-null thread) and a general row (NULL thread) that
  // share a message_id keep DISTINCT keys (the topic id vs ''), so they stay
  // separate. Stored thread_id values remain real NULLs, so every read path
  // (`thread_id IS NULL` / `thread_id = ?`) is unchanged.
  const LOGICAL_KEY_INDEX = 'idx_messages_logical_key'
  const logicalKeyIndexExists =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(LOGICAL_KEY_INDEX) != null
  if (!logicalKeyIndexExists) {
    // De-dupe rows an earlier (pre-fix) build already appended, keeping the
    // NEWEST row per logical key (highest ts, then highest rowid = the last
    // write, which is what INSERT OR REPLACE would have left). This MUST run
    // before the UNIQUE index is created, or CREATE UNIQUE INDEX would fail on
    // the existing duplicates. On a fresh/empty DB it is a harmless no-op.
    db.exec(`
      DELETE FROM messages
      WHERE rowid NOT IN (
        SELECT keep_rowid FROM (
          SELECT rowid AS keep_rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY chat_id, COALESCE(thread_id, ''), message_id
                   ORDER BY ts DESC, rowid DESC
                 ) AS rn
          FROM messages
        )
        WHERE rn = 1
      )
    `)
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${LOGICAL_KEY_INDEX} ` +
        `ON messages (chat_id, COALESCE(thread_id, ''), message_id)`,
    )
  }

  // Readable by owner and others so the web dashboard (different uid than the
  // agent) can stream replies back to Hermes Desktop. The WAL sidecar files
  // (-shm/-wal) are also chmod'd so SQLite readonly opens succeed for uid=1000.
  // 0644 is safe: the per-agent state dir is already operator-accessible.
  for (const suffix of ['', '-shm', '-wal']) {
    const f = path + suffix
    if (existsSync(f)) { try { chmodSync(f, 0o644) } catch { /* ignore */ } }
  }
  // Ownership rides the same hook as the mode, for the same reason. SQLite
  // creates `-wal`/`-shm` itself, in C, so no `node:fs` write helper can ever
  // see them — this is the only place we get to fix their owner. A root
  // gateway would otherwise leave root:root DB files in an agent-owned state
  // dir and EACCES every non-root reader. No-op off the root path.
  adoptSqliteOwnership(path)

  if (retentionDays > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
    db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff)
  }

  // Boot-time writer self-check (2026-07-16 incident hardening). "history
  // capture enabled" was logged at every boot — including the 02:17 and 04:58
  // restarts around the incident — yet a whole class of deliveries never
  // reached the DB. A successful `new Database(...)` + schema DDL does NOT prove
  // the row-insert path is functional (a read-only mount, a full disk, an
  // orphaned inode after an in-place dir replace, or a corrupt page all pass DDL
  // but fail INSERT). So we prove it with a real INSERT + SELECT + DELETE
  // round-trip on a sentinel row, and log LOUDLY if it fails. This turns a
  // silent, hours-later-discovered writer outage into a deterministic boot
  // signal the operator can see immediately.
  const check = verifyHistoryWritable()
  if (!check.ok) {
    warnHistory(
      `WRITER SELF-CHECK FAILED at boot (path=${path}): ${check.error ?? 'unknown'} — ` +
        `history recording is NOT durable; get_recent_messages recovery and the ` +
        `reply-backstop already-replied suppression will be blind. Investigate the ` +
        `DB path/mount/permissions before trusting delivery accounting.`,
    )
  }
}

/**
 * Prove the history writer's INSERT path actually works, not just that the DB
 * opened and the schema DDL ran. Performs a real INSERT + SELECT + DELETE of a
 * sentinel row keyed on a reserved chat_id that no live chat can collide with,
 * and cleans it up unconditionally. Returns `{ ok:false, error }` (never throws)
 * so the boot path and an operator self-check tool can both call it safely.
 *
 * This is the deterministic mechanism the 2026-07-16 incident lacked: a
 * writer that opens fine but cannot persist rows (read-only mount, full disk,
 * orphaned inode, corruption) is caught HERE at boot instead of being inferred
 * hours later from missing rows.
 *
 * No-op safe: returns `{ ok:false }` with an explanatory error if
 * `initHistory` was never called.
 */
export function verifyHistoryWritable(): { ok: boolean; error?: string } {
  if (db == null) return { ok: false, error: 'initHistory() not called' }
  const SENTINEL_CHAT = '__history_selfcheck__'
  const sentinelId = Date.now()
  try {
    // Clear any stale sentinel from a prior crashed self-check first.
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(SENTINEL_CHAT)
    db.prepare(
      `INSERT OR REPLACE INTO messages
         (chat_id, thread_id, message_id, role, ts, text)
       VALUES (?, NULL, ?, 'assistant', ?, ?)`,
    ).run(SENTINEL_CHAT, sentinelId, Math.floor(Date.now() / 1000), 'selfcheck')
    const row = db
      .prepare('SELECT text FROM messages WHERE chat_id = ? AND message_id = ?')
      .get(SENTINEL_CHAT, sentinelId) as { text?: string } | undefined
    if (row?.text !== 'selfcheck') {
      return { ok: false, error: 'sentinel row not read back after insert' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // Never leave the sentinel behind, even if the SELECT/assert path threw.
    try {
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(SENTINEL_CHAT)
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Read-only handle for the gateway boot-briefing builder
 * (`gateway/boot-briefing-wiring.ts`). Exposes only the `prepare(...).all`
 * subset the builder's `BriefingDb` seam needs; returns null before
 * `initHistory` (or when history is disabled) so the briefing degrades to
 * empty instead of throwing. Do NOT use for writes — every write path goes
 * through the record* functions above so redaction and validity checks
 * cannot be bypassed.
 */
export function getHistoryDbForBriefing(): {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
} | null {
  return db
}

/**
 * For tests — close the singleton and forget it. Production code never
 * needs this; the DB is held open for the lifetime of the process.
 */
export function _resetForTests(): void {
  if (db != null) {
    db.close()
    db = null
  }
}

/**
 * Issue a WAL checkpoint on the history DB, releasing `*.db-wal` pages
 * back to the main DB and truncating the WAL file. Called by the
 * gateway's periodic reaper so the WAL doesn't grow unbounded in
 * long-running agent sessions (issue #1073).
 *
 * Wrapped in try/catch — `PRAGMA wal_checkpoint(TRUNCATE)` can return
 * SQLITE_BUSY under reader pressure, which bun:sqlite raises as a thrown
 * error. That's non-fatal; the next reaper tick retries. Returns true
 * on success, false on a swallowed error.
 *
 * No-op (returns false) if `initHistory` was never called.
 */
export function checkpointWal(): boolean {
  if (db == null) return false
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
    // Re-apply permissions after WAL truncation (SQLite may recreate -wal/-shm)
    if (dbPath) {
      for (const suffix of ['-shm', '-wal']) {
        const f = dbPath + suffix
        if (existsSync(f)) { try { chmodSync(f, 0o644) } catch { /* ignore */ } }
      }
      // …and ownership with it: a TRUNCATE checkpoint DELETES and RE-CREATES
      // the sidecars, so the owner we set at init is gone by here.
      adoptSqliteOwnership(dbPath)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Drop the current history handle and re-open the DB from its path.
 *
 * THE FAILURE MODE THIS RECOVERS
 * ------------------------------
 * A FOREIGN process rw-opens `history.db`, and on exit — as the last
 * connection — checkpoints and UNLINKS `history.db-wal` / `-shm`. Our
 * long-lived connection keeps the deleted inodes mapped and keeps writing into
 * them; every INSERT still reports success and the rows are simply gone at the
 * next restart. Signature: `/proc/<pid>/fd/N -> …/history.db-wal (deleted)`.
 * A container restart heals it; this is that restart, in-process. Detection and
 * the call site live in `gateway/orphaned-db-sweep.ts`.
 *
 * WHY `close()` IS NOT ENOUGH (measured, not assumed)
 * ---------------------------------------------------
 * bun:sqlite's default `close()` is a SOFT close: it defers the real
 * `sqlite3_close` while any un-finalized `Statement` still holds the
 * connection, and every statement here is created per-call by
 * `requireDb().prepare(...)`, so they are only reclaimed by GC. Measured on
 * bun 1.3.13: after a plain `db.close()` the process STILL held
 * `h.db`, `h.db-wal (deleted)` and `h.db-shm (deleted)` in `/proc/self/fd`,
 * and the immediate re-open then failed with `SQLITE_IOERR_SHORT_READ`
 * (errno 522) — because SQLite's unix VFS keeps per-inode WAL-index state
 * alive for as long as any connection to that inode is open. A naive
 * close-and-reopen therefore turns silent row loss into a TOTAL history
 * outage. (The same DB file opened from a SEPARATE process reads fine, which
 * is how we know the on-disk DB is not corrupt and the poisoning is
 * in-process.)
 *
 * So the close has to be a HARD one, in two steps that are both load-bearing:
 *   1. Force statement finalization. `Bun.gc(true)` is a synchronous full
 *      collection; without it step 2 always throws.
 *   2. `close(true)`, which THROWS rather than silently deferring. That throw
 *      is the determinism: if we cannot actually close, we must NOT null `db`
 *      and pretend to have recovered — we rethrow so the sweep logs the
 *      failure and asks for a restart, leaving the (bad but working) old
 *      handle in place rather than a null one that fails every write.
 *
 * NO EXPLICIT SALVAGE CHECKPOINT
 * ------------------------------
 * We never issue `wal_checkpoint` through the orphaned handle. Once a new
 * `-shm` exists on disk, our handle and any other connection are in DISJOINT
 * locking domains and a checkpoint through the stale mapping can corrupt the
 * main DB. Losing rows is strictly better than corrupting the ones that landed.
 * `close()` does still run SQLite's IMPLICIT checkpoint-on-close through the
 * old fds — a knowingly accepted residual, not an oversight: it is exactly what
 * a clean container restart already does today, so this path is no more
 * dangerous than the restart it replaces. (In the isolated case it also
 * SALVAGES the orphaned rows; we do not rely on that, because the concurrent
 * case cannot.)
 *
 * `initHistory` early-returns when `db != null`, so nulling is load-bearing —
 * without it the reopen is a silent no-op and the orphaned handle keeps eating
 * rows. The re-init re-runs the idempotent DDL/migrations, the chmod/ownership
 * fixups, retention, and `verifyHistoryWritable()` — a free post-reopen proof
 * that the new handle can actually persist a row.
 *
 * Throws if the hard close or the re-init fails. Callers must treat a throw as
 * "history is still broken, restart required".
 */
export function reopenHistory(stateDir: string, retentionDays = 30): void {
  const current = db
  if (current != null) {
    // Reclaim the per-call prepared statements so the hard close below can
    // actually run. Guarded: `Bun.gc` is Bun-only and this must not be the
    // thing that throws.
    const gc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc
    if (typeof gc === 'function') {
      try { gc(true) } catch { /* best-effort; close(true) below reports the truth */ }
    }
    // Deliberately NOT caught: a failed close means the fds are still open and
    // a re-open would fail with SQLITE_IOERR_SHORT_READ. Propagate.
    current.close(true)
  }
  db = null
  initHistory(stateDir, retentionDays)
}

/**
 * Prune `messages` rows older than `retentionDays`. Used by the periodic
 * reaper (#1073) to catch the case where the gateway runs for weeks or
 * months — the init-time prune only fires once at boot.
 *
 * Returns the number of rows deleted (sum across all batches). No-op
 * if `retentionDays <= 0` or if `initHistory` was never called.
 *
 * Batched to keep transactions short; otherwise a years-old DB on first
 * boot after an upgrade would lock the inbound write path for the duration
 * of a single multi-million-row DELETE. Uses the rowid-subselect form
 * because bun:sqlite is built without SQLITE_ENABLE_UPDATE_DELETE_LIMIT
 * (same constraint as reaper.ts).
 */
export function pruneMessagesOlderThanDays(
  retentionDays: number,
  nowSec?: number,
  batchLimit = 5000,
): number {
  if (db == null) return 0
  if (retentionDays <= 0) return 0
  const cutoffSec = (nowSec ?? Math.floor(Date.now() / 1000)) - retentionDays * 86400
  const stmt = db.prepare(`
    DELETE FROM messages
    WHERE rowid IN (
      SELECT rowid FROM messages WHERE ts < ? LIMIT ?
    )
  `)
  let total = 0
  // Same defence-in-depth ceiling as reaper.ts — caps a single call at
  // 5M rows at the default batch size, more than any healthy fleet.
  for (let i = 0; i < 1000; i++) {
    const result = stmt.run(cutoffSec, batchLimit) as { changes: number }
    const n = result.changes ?? 0
    total += n
    if (n === 0) break
  }
  return total
}

function requireDb(): SqliteDatabase {
  if (db == null) {
    throw new Error('history: initHistory() must be called before any record/query operation')
  }
  return db
}

interface RecordInboundArgs {
  chat_id: string
  thread_id: number | null | undefined
  message_id: number | null | undefined
  user: string | null | undefined
  user_id: string | null | undefined
  ts: number
  text: string
  attachment_kind?: string | null | undefined
  /**
   * If the user replied to a prior message via Telegram's native reply
   * feature, the original message_id and a (truncated) preview of its
   * text. Populated from `ctx.message.reply_to_message` in the gateway
   * handler. See issue #119.
   */
  reply_to_message_id?: number | null | undefined
  reply_to_text?: string | null | undefined
  /**
   * If the message was forwarded, the server-stamped origin metadata
   * (Bot API 7.0 `forward_origin`). Populated from
   * `ctx.message.forward_origin` in the gateway handler. `forwarded_from`
   * is the RAW (truncated, unescaped) name — the XML-escaped form goes to
   * the channel meta only. `forwarded_date` is the origin message's ISO
   * timestamp; `forwarded_message_id` is set for channel origins only.
   */
  forwarded_from?: string | null | undefined
  forwarded_from_type?: string | null | undefined
  forwarded_from_id?: string | null | undefined
  forwarded_date?: string | null | undefined
  forwarded_message_id?: number | null | undefined
}

/**
 * Record an inbound (user → bot) message. Called from server.ts handleInbound
 * right next to the `notifications/claude/channel` emit, so the stored row
 * matches what the agent actually saw.
 *
 * If `message_id` is missing (which shouldn't happen for normal Telegram
 * messages, but defensively...) we silently skip — the PK requires it and
 * we'd rather lose the row than crash the inbound path.
 */
export function recordInbound(args: RecordInboundArgs): void {
  if (args.message_id == null) return
  if (!isValidMessageId(args.message_id)) {
    warnHistory(
      `recordInbound: dropping row with invalid message_id=${String(args.message_id)} ` +
        `(chat=${args.chat_id}) — a delivered inbound will be absent from history`,
    )
    return
  }
  const stmt = requireDb().prepare(`
    INSERT OR REPLACE INTO messages
      (chat_id, thread_id, message_id, role, user, user_id, ts, text, attachment_kind, group_id, reply_to_message_id, reply_to_text, forwarded_from, forwarded_from_type, forwarded_from_id, forwarded_date, forwarded_message_id)
    VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `)
  // Defense-in-depth: never persist a detected secret to the message store.
  // The inbound gate (server.ts handleInbound) already deletes + vaults a
  // high-confidence hit before reaching here, so for caught secrets this is
  // a no-op; it's the backstop for any shape the gate's pattern set misses.
  stmt.run(
    args.chat_id,
    args.thread_id ?? null,
    args.message_id,
    args.user ?? null,
    args.user_id ?? null,
    args.ts,
    redact(args.text),
    args.attachment_kind ?? null,
    args.reply_to_message_id ?? null,
    args.reply_to_text != null ? redact(args.reply_to_text) : (args.reply_to_text ?? null),
    // Origin names/titles are user-controlled display strings; run them
    // through the same secret-redaction backstop as message text.
    args.forwarded_from != null ? redact(args.forwarded_from) : null,
    args.forwarded_from_type ?? null,
    args.forwarded_from_id ?? null,
    args.forwarded_date ?? null,
    args.forwarded_message_id ?? null,
  )
}

interface RecordOutboundArgs {
  chat_id: string
  thread_id: number | null | undefined
  message_ids: number[]   // one entry per chunk
  texts: string[]         // parallel array, same length as message_ids
  ts?: number             // defaults to now
  attachment_kinds?: (string | null | undefined)[]
}

/**
 * Record an outbound (bot → user) message. The `reply` handler chunks long
 * text into multiple Telegram sends; pass them all here in one call so they
 * share a `group_id` (the first chunk's message_id). The other handlers
 * (`stream_reply`, `forward_message`, orphaned-reply backstop) typically
 * pass a single-element array.
 */
export function recordOutbound(args: RecordOutboundArgs): void {
  if (args.message_ids.length === 0) return
  const ts = args.ts ?? Math.floor(Date.now() / 1000)
  // Filter out invalid ids (null/undefined/NaN/non-positive) BEFORE the insert.
  // A malformed send result (an API wrapper that resolved without a real message
  // object) would otherwise inject a NULL/NaN message_id: the NOT NULL PRIMARY
  // KEY throws, and the caller's `catch {}` swallows it — the delivered reply is
  // then absent from history AND the failure is invisible. This was the shape of
  // the 2026-07-16 turn-flush loss (18944/18958 delivered, never recorded). We
  // log loudly and record only the valid rows instead of losing them silently.
  const validRows: Array<{ id: number; text: string; attachKind: string | null }> = []
  for (let i = 0; i < args.message_ids.length; i++) {
    const id = args.message_ids[i]
    if (!isValidMessageId(id)) {
      warnHistory(
        `recordOutbound: dropping chunk ${i} with invalid message_id=${String(id)} ` +
          `(chat=${args.chat_id}) — a delivered outbound will be absent from history, ` +
          `blinding the reply-backstop already-replied suppression`,
      )
      continue
    }
    validRows.push({
      id,
      // Outbound redaction: the agent→user direction has no other secret scrub,
      // so this is the chokepoint that keeps an agent-echoed secret out of the
      // message store. Masks the secret bytes in place; surrounding text kept.
      text: redact(args.texts[i] ?? ''),
      attachKind: args.attachment_kinds?.[i] ?? null,
    })
  }
  if (validRows.length === 0) return
  const groupId = validRows[0]!.id
  const stmt = requireDb().prepare(`
    INSERT OR REPLACE INTO messages
      (chat_id, thread_id, message_id, role, user, user_id, ts, text, attachment_kind, group_id)
    VALUES (?, ?, ?, 'assistant', NULL, NULL, ?, ?, ?, ?)
  `)
  // #4571 — a real reply ALWAYS wins over a provisional card row.
  //
  // The system-lane observer (gateway `robustApiCall`) records every sent
  // message the moment the API resolves, which is BEFORE the caller reaches
  // its own `recordOutbound`. `INSERT OR REPLACE` alone would not reliably
  // overwrite that row: the unique key folds `thread_id`, and the observer
  // derives the thread from the Telegram response (which sets
  // `message_thread_id` on reply chains in plain supergroups) while this
  // writer uses the gateway's own `threadId` — a mismatch would leave BOTH
  // rows and let the card row shadow the answer for id lookups. Deleting on
  // (chat_id, message_id) — unique within a chat regardless of thread, the
  // same assumption `recordEdit` / `recordReaction` already make — makes the
  // promotion exact and is a no-op when no observer row exists.
  const dropSystem = requireDb().prepare(
    `DELETE FROM messages WHERE chat_id = ? AND message_id = ? AND role = 'system'`,
  )
  // bun:sqlite has a transaction() helper. Cheap insurance against partial
  // writes if the process dies mid-loop. The transaction signature is
  // typed as variadic-unknown for genericity; cast the typed callback
  // through the wider shape.
  const tx = requireDb().transaction(((rows: Array<{ id: number; text: string; attachKind: string | null }>) => {
    for (const r of rows) {
      dropSystem.run(args.chat_id, r.id)
      stmt.run(args.chat_id, args.thread_id ?? null, r.id, ts, r.text, r.attachKind, groupId)
    }
  }) as (...args: unknown[]) => unknown)
  // Surface a write failure LOUDLY before rethrowing. Callers wrap this in a
  // `catch {}` / caller-shaped catch; without this log an insert failure (disk
  // full, read-only mount, lock exhaustion) would be completely invisible —
  // exactly the diagnostic gap the 2026-07-16 incident exposed. Rethrow so the
  // caller's existing control flow is unchanged.
  try {
    tx(validRows)
  } catch (err) {
    warnHistory(
      `recordOutbound: INSERT failed (chat=${args.chat_id} ids=[${validRows.map((r) => r.id).join(',')}]): ` +
        `${err instanceof Error ? err.message : String(err)} — this outbound will be absent from history`,
    )
    throw err
  }
}

export interface RecordSystemOutboundArgs {
  chat_id: string
  thread_id: number | null | undefined
  message_id: number
  /** Normalised send verb (`activity-summary`, `approval-card`, …) or null. */
  kind: string | null | undefined
  /** Rendered text as Telegram echoed it back. May be empty. */
  text: string
  /** Unix SECONDS. Defaults to now. */
  ts?: number
}

/**
 * Record a CARD / system-surface outbound (#4571).
 *
 * Conditional insert on (chat_id, message_id): if ANY row already exists for
 * that id — a real `assistant` reply recorded by `recordOutbound`, an inbound,
 * or a previously-recorded card — this is a no-op and returns false. That is
 * what makes the call safe to fire from a blanket send observer that cannot
 * distinguish a fresh send from an edit of a message it already knows: an edit
 * returns the SAME `message_id`, hits the `NOT EXISTS` guard, and falls through
 * to {@link updateSystemOutboundText} instead of duplicating a row per edit.
 *
 * Never throws — a card row is a nice-to-have, and a failure here must not
 * break the send path it is observing. Failures are logged via `warnHistory`.
 *
 * Returns true iff a new row was inserted.
 */
export function recordSystemOutbound(args: RecordSystemOutboundArgs): boolean {
  if (!isValidMessageId(args.message_id)) return false
  // History disabled / not yet initialised: stay silent. This is called from a
  // blanket send observer, so a warn here would be one stderr line per API call.
  if (db == null) return false
  try {
    const res = requireDb()
      .prepare(`
        INSERT INTO messages
          (chat_id, thread_id, message_id, role, user, user_id, ts, text, attachment_kind, group_id, kind)
        SELECT ?, ?, ?, 'system', NULL, NULL, ?, ?, NULL, NULL, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM messages WHERE chat_id = ? AND message_id = ?
         )
      `)
      .run(
        args.chat_id,
        args.thread_id ?? null,
        args.message_id,
        args.ts ?? Math.floor(Date.now() / 1000),
        // Same outbound redaction chokepoint as recordOutbound: a card body is
        // rendered from live tool activity and can quote a secret.
        redact(args.text),
        args.kind ?? null,
        args.chat_id,
        args.message_id,
      ) as { changes?: number }
    return (res?.changes ?? 0) > 0
  } catch (err) {
    warnHistory(
      `recordSystemOutbound: INSERT failed (chat=${args.chat_id} id=${args.message_id}): ` +
        `${err instanceof Error ? err.message : String(err)} — a posted card will not be ` +
        `resolvable if the operator quote-replies to it`,
    )
    return false
  }
}

/**
 * Refresh a card row's stored text in place (#4571). Only ever touches a
 * `system` row, so an edit of a real reply can never be rewritten through this
 * path (`recordEdit` owns that).
 *
 * `ts` is deliberately NOT bumped: it is the card's POST time, which is what
 * retention prunes on. Never throws. Returns true iff a row was updated.
 */
export function updateSystemOutboundText(args: {
  chat_id: string
  message_id: number
  text: string
}): boolean {
  try {
    const res = requireDb()
      .prepare(
        `UPDATE messages SET text = ? WHERE chat_id = ? AND message_id = ? AND role = 'system'`,
      )
      .run(redact(args.text), args.chat_id, args.message_id) as { changes?: number }
    return (res?.changes ?? 0) > 0
  } catch {
    return false
  }
}

interface RecordEditArgs {
  chat_id: string
  message_id: number
  text: string
}

/**
 * Update an existing outbound message's text in place. Called from the
 * `edit_message` tool handler. If the row doesn't exist (the bot is editing
 * a message it sent before history was enabled, or before this version
 * shipped), we silently no-op rather than inventing a row with role guessed.
 *
 * Telegram message_ids are unique within a chat regardless of thread, so
 * we don't filter on thread_id — that lets edits work even when the
 * original send-time thread isn't known at edit time.
 */
export function recordEdit(args: RecordEditArgs): void {
  requireDb()
    .prepare(`
      UPDATE messages
         SET text = ?
       WHERE chat_id = ? AND message_id = ?
    `)
    // Same outbound chokepoint as recordOutbound — an edit must not
    // reintroduce a raw secret into the stored row.
    .run(redact(args.text), args.chat_id, args.message_id)
}

export interface RecordReactionArgs {
  chat_id: string
  message_id: number
  /** The emoji string to store, or null to clear the reaction field. */
  emoji: string | null
}

/**
 * Update (or clear) the user_reaction field for a message row. Called from
 * the message_reaction gateway handler when Telegram delivers a reaction
 * event. If the row doesn't exist (the message predates history, or the
 * reaction was placed on an inbound message), silently no-ops.
 *
 * Telegram message_ids are unique within a chat regardless of thread, so
 * we match on (chat_id, message_id) and ignore thread_id — same as recordEdit.
 */
export function recordReaction(args: RecordReactionArgs): void {
  requireDb()
    .prepare(`
      UPDATE messages
         SET user_reaction = ?
       WHERE chat_id = ? AND message_id = ?
    `)
    .run(args.emoji, args.chat_id, args.message_id)
}

export interface DeleteFromHistoryArgs {
  chat_id: string
  message_id: number
}

/**
 * Remove a single row from the local history buffer. Called after a
 * successful `bot.api.deleteMessage` so the `get_recent_messages` tool
 * reflects the deletion. Best-effort: callers should catch errors and
 * log them rather than failing the deletion request.
 *
 * Telegram message_ids are unique within a chat regardless of thread, so
 * we match on (chat_id, message_id) and ignore thread.
 */
export function deleteFromHistory(args: DeleteFromHistoryArgs): void {
  requireDb()
    .prepare(`
      DELETE FROM messages
       WHERE chat_id = ? AND message_id = ?
    `)
    .run(args.chat_id, args.message_id)
}

/**
 * Fetch recent messages for a chat (or chat+thread).
 *
 * Returns oldest-first so the caller can paste them into a prompt without
 * reversing. `before_message_id` lets the caller paginate further back —
 * pass the smallest `message_id` from the previous page.
 *
 * `thread_id` filter semantics:
 *   - omitted / undefined → all messages in the chat across all threads
 *   - explicit number → only that thread
 *   - explicit null → only the chat-root (non-thread) messages
 */
/**
 * Count outbound messages sent to a chat within the last `withinSeconds`.
 * Used by the orphaned-reply backstop to detect if a reply tool handler
 * already sent a message during the backstop's delay window, avoiding
 * a duplicate send.
 */
/**
 * Look up the most recent inbound (user → bot) message id for a chat, optionally
 * scoped to a forum-topic thread. Returns `null` if no inbound message exists
 * yet (fresh chat, or history was disabled when the message arrived).
 *
 * Used by the `reply` and `stream_reply` tool handlers to auto-populate
 * `reply_parameters` so outbound messages quote-thread under whatever the
 * user last said — the common case for a conversational bot — without the
 * agent having to pass `reply_to` explicitly every turn.
 *
 * `thread_id` filter semantics match `query()`:
 *   - omitted / undefined → any message in the chat
 *   - explicit number → only that thread
 *   - explicit null → only chat-root (non-thread)
 */
export function getLatestInboundMessageId(
  chatId: string,
  threadId?: number | null,
): number | null {
  const params: unknown[] = [chatId]
  let sql = "SELECT message_id FROM messages WHERE chat_id = ? AND role = 'user'"
  if (threadId !== undefined) {
    if (threadId === null) {
      sql += ' AND thread_id IS NULL'
    } else {
      sql += ' AND thread_id = ?'
      params.push(threadId)
    }
  }
  sql += ' ORDER BY ts DESC, message_id DESC LIMIT 1'
  const row = requireDb().prepare(sql).get(...params as any[]) as
    | { message_id: number }
    | undefined
  return row?.message_id ?? null
}

/**
 * Look up the role + text of a single message by (chat_id, message_id).
 * Returns `null` if no row exists (the message predates history, the
 * row was reaped, or history is disabled). Used by the reaction-trigger
 * handler (#1074) to decide whether a reacted-to message is bot-authored
 * AND to pull the preview text for the synthesized inbound — both in
 * one DB hit, so the trigger predicate doesn't need a Telegram API call
 * per reaction.
 *
 * Telegram message_ids are unique within a chat regardless of thread,
 * so we match on (chat_id, message_id) and ignore thread_id — same as
 * recordEdit / recordReaction.
 */
export function lookupMessageRoleAndText(
  chatId: string,
  messageId: number,
  opts?: {
    /**
     * Also resolve `system` (card) rows. DEFAULT FALSE so the two
     * authorship-sensitive callers — the reaction trigger's
     * `role === 'assistant'` bot-authored predicate and the
     * `reaction_dispatch` preview — keep their exact pre-#4571 behaviour
     * (a card was invisible to them, and still is). The reply-antecedent
     * resolver opts IN: that is the whole point of the card lane.
     */
    includeSystem?: boolean
  },
): { role: MessageRole; text: string; kind: string | null } | null {
  const sql =
    `SELECT role, text, kind FROM messages WHERE chat_id = ? AND message_id = ?` +
    (opts?.includeSystem === true ? '' : ` AND role <> 'system'`) +
    ` LIMIT 1`
  const row = requireDb().prepare(sql).get(chatId, messageId) as
    | { role: MessageRole; text: string | null; kind: string | null }
    | undefined
  if (!row) return null
  return { role: row.role, text: row.text ?? '', kind: row.kind ?? null }
}

export function getRecentOutboundCount(
  chatId: string,
  withinSeconds: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - withinSeconds
  const row = requireDb()
    .prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ? AND role = ? AND ts >= ?',
    )
    .get(chatId, 'assistant', cutoff) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

/**
 * Returns true if at least one SUBSTANTIVE outbound (bot → user, role='assistant')
 * message was delivered to `chatId` (and optionally `threadId`) AFTER `sinceMs`
 * (wall-clock epoch milliseconds). Used by the obligation sweep to suppress a false
 * "I may have missed this" escalation when the agent visibly answered: if a
 * substantive outbound landed since the obligation was opened, the obligation is
 * stale — close it silently rather than alarming the user.
 *
 * SUBSTANTIVE: we never suppress escalation on a bare ack ("on it", "give me a
 * sec") — an agent that acks then ghosts must still escalate. The history schema
 * does not store a done/substantive flag, so we approximate: a row counts only
 * when LENGTH(text) >= `minChars` (default 200, the FINAL_ANSWER_MIN_CHARS
 * constant from final-answer-detect.ts). This is false-negative-safe for the
 * escalate branch: a genuine substantive answer that happens to be < 200 chars
 * will still fire an escalation, which is the conservative (safe) outcome. A
 * schema column would be more precise but is disproportionate for this predicate;
 * the reviewer accepted this approach.
 *
 * `minChars` semantics (decoupled per caller, #2474 follow-up):
 *   - The ESCALATE branch (Fix 4) keeps the 200 default: it must not stand down an
 *     escalation on a mere ack, so it still demands a substantive-LENGTH outbound.
 *   - The duplicate-represent GUARD (#2472) passes a LOW value (1): for that path
 *     ANY genuine assistant reply to the turn — even a terse "Yes — done." or
 *     "Merged, all three landed." — means the user was answered, so the duplicate
 *     represent must be suppressed. The 200-char proxy was borrowed from the
 *     escalate branch and is WRONG there: a short-but-real reply left the
 *     duplicate-represent bug (#2472) alive. This is safe because the rows this
 *     query counts (role='assistant') are ONLY ever written by recordOutbound —
 *     i.e. real bot→user messages (reply / stream_reply / silent-anchor content /
 *     command acks). Typing indicators and progress-card edits NEVER call
 *     recordOutbound, so they cannot be miscounted as "the user was answered".
 *
 * `threadId` semantics:
 *   - undefined → any message in the chat regardless of thread (DMs + supergroups)
 *   - explicit number → only that thread (precise for supergroups with topics)
 *   - explicit null → only chat-root (non-thread) messages
 *
 * Falls back to false (safe: never suppresses escalation) if history is not yet
 * initialised or the query fails.
 */
export function hasOutboundDeliveredSince(
  chatId: string,
  sinceMs: number,
  threadId?: number | null,
  minChars = 200,
): boolean {
  try {
    const cutoffSec = Math.floor(sinceMs / 1000)
    // Clamp to >= 1 so the predicate never counts an empty/whitespace-only row
    // (a degenerate outbound) as a delivered reply, even if a caller passes 0.
    const minLen = Math.max(1, Math.floor(minChars))
    const params: unknown[] = [chatId, cutoffSec, minLen]
    // LENGTH(text) >= minChars scopes to replies of at least the caller's
    // threshold. ESCALATE passes the default 200 (substantive-only — never stand
    // down on a mere ack). The duplicate-represent GUARD passes a low value so a
    // terse-but-real reply counts (#2472/#2474). The `done` flag is not stored in
    // the history schema, so length is the closest available proxy; rows here are
    // only ever recordOutbound writes (real bot→user sends), so progress-card
    // edits / typing indicators are structurally excluded.
    let sql =
      "SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant' AND ts >= ? AND LENGTH(text) >= ?"
    if (threadId !== undefined) {
      if (threadId === null) {
        sql += ' AND thread_id IS NULL'
      } else {
        sql += ' AND thread_id = ?'
        params.push(threadId)
      }
    }
    sql += ' LIMIT 1'
    const row = requireDb()
      .prepare(sql)
      .get(...(params as [unknown, ...unknown[]])) as Record<string, unknown> | undefined
    return row != null
  } catch {
    return false
  }
}

/**
 * DURABLE text-identity delivery oracle for crash-survival redelivery.
 *
 * Returns true iff a substantive outbound (`role='assistant'`) row whose text
 * matches `text` has been delivered to `chatId` (and optionally `threadId`).
 * Unlike `hasOutboundDeliveredSince`, this keys on the ANSWER TEXT itself, not
 * a chat+time window — so an interim `progress_update` ("on it…") or a streamed
 * partial chunk sent earlier in the same turn does NOT false-positive as "the
 * final answer was delivered" (the exact MISS bug that would otherwise suppress
 * a genuinely-undelivered final answer and re-open the permanent-silence hole).
 *
 * Matching is on the NORMALIZED first chunk (see `normalizeDeliveryText`): a
 * multi-chunk answer's chunk-1 is compared against delivered rows so a crash
 * after chunk-1 is detected as delivered (avoids double-sending chunk-1). Both
 * sides are normalized identically. Empty/whitespace text never matches.
 *
 * Durable (reads committed SQLite), survives restart — unlike the in-memory
 * `outboundDedup` ring, whose window is destroyed by the crash.
 *
 * SCOPING (crash-redelivery diff-review defect #1). Two guards keep a match from
 * being over-broad and suppressing a genuine redelivery (a MISS = permanent
 * silence):
 *   1. `sinceMs` — when provided (the interrupted turn's `started_at`), only
 *      rows delivered AT/AFTER that instant are considered, so an UNRELATED
 *      earlier turn's message can never satisfy the match. This is the primary
 *      scope: a redelivery candidate only cares whether THIS turn's own answer
 *      already went out.
 *   2. Short-text exactness — the bidirectional-prefix rule (which lets a
 *      delivered multi-chunk chunk-1 satisfy a longer projected answer) is only
 *      applied when the shorter side is at least `MIN_PREFIX_MATCH_CHARS`. For a
 *      SHORT final answer (e.g. "Done.") a prefix match against a longer row
 *      ("Done, deploying now.") would false-positive; short texts therefore
 *      require full normalized EQUALITY. Real answer chunks are far longer than
 *      the floor, so multi-chunk detection is unaffected.
 *
 * Falls back to false (safe: never suppresses a needed redelivery) if history
 * is not initialised or the query fails — the `answer_redelivered_at` marker is
 * the second guard against a double-send in that degraded case.
 */
export function hasOutboundWithText(
  chatId: string,
  text: string,
  threadId?: number | null,
  sinceMs?: number,
): boolean {
  const needle = normalizeDeliveryText(text)
  if (needle.length === 0) return false
  try {
    // Compare on the normalized prefix so trailing-whitespace / spacer
    // differences between the rendered outbound and the re-projected answer do
    // not defeat the match. We fetch candidate assistant rows and normalize in
    // JS (SQLite lacks the same normalize) — bounded by chat/thread scope.
    const params: unknown[] = [chatId]
    let sql = "SELECT text FROM messages WHERE chat_id = ? AND role = 'assistant'"
    if (threadId !== undefined) {
      if (threadId === null) {
        sql += ' AND thread_id IS NULL'
      } else {
        sql += ' AND thread_id = ?'
        params.push(threadId)
      }
    }
    if (sinceMs != null && Number.isFinite(sinceMs)) {
      // history `ts` is unix SECONDS (recordOutbound); started_at is wall-clock
      // ms. Scope out any prior turn's rows so an unrelated earlier message can
      // never satisfy the match.
      sql += ' AND ts >= ?'
      params.push(Math.floor(sinceMs / 1000))
    }
    // Newest first: a redelivery candidate's match is almost always recent.
    sql += ' ORDER BY ts DESC LIMIT 500'
    const rows = requireDb()
      .prepare(sql)
      .all(...(params as [unknown, ...unknown[]])) as { text: string | null }[]
    for (const r of rows) {
      const hay = normalizeDeliveryText(r.text ?? '')
      if (hay.length === 0) continue
      if (deliveryTextMatch(hay, needle)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Normalize outbound text for durable text-identity delivery matching. Collapses
 * all whitespace runs to single spaces and trims — so paragraph-spacer / render
 * differences between a stored outbound and a re-projected transcript answer do
 * not defeat an otherwise-identical match. Pure; shared by the redelivery path.
 */
export function normalizeDeliveryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Minimum length (of the SHORTER side) at which the bidirectional-prefix rule is
 * allowed. Below this, a delivery match requires full normalized equality — so a
 * short final answer can't be falsely suppressed by an unrelated longer row that
 * merely shares a prefix. Real answer chunks (chunk-1 of a multi-chunk send) are
 * far longer than this floor, so multi-chunk detection is unaffected.
 */
export const MIN_PREFIX_MATCH_CHARS = 40

/**
 * Text-identity match for the delivery oracle. Exact normalized equality always
 * matches. The bidirectional-prefix relaxation (which lets a delivered chunk-1
 * satisfy a longer projected answer, and vice-versa) applies ONLY when the
 * shorter side is at least `MIN_PREFIX_MATCH_CHARS` — otherwise a short answer
 * would false-positive against any longer row sharing its prefix. Pure.
 */
export function deliveryTextMatch(hay: string, needle: string): boolean {
  if (hay === needle) return true
  const shorter = Math.min(hay.length, needle.length)
  if (shorter < MIN_PREFIX_MATCH_CHARS) return false
  return hay.startsWith(needle) || needle.startsWith(hay)
}

export function query(opts: QueryOptions): RecordedMessage[] {
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT))
  const params: unknown[] = [opts.chat_id]
  let sql = 'SELECT * FROM messages WHERE chat_id = ?'
  // #4571 — card rows are resolvable, not listable. See QueryOptions.include_system.
  if (opts.include_system !== true) sql += " AND role <> 'system'"
  if (opts.thread_id !== undefined) {
    if (opts.thread_id === null) {
      sql += ' AND thread_id IS NULL'
    } else {
      sql += ' AND thread_id = ?'
      params.push(opts.thread_id)
    }
  }
  if (opts.before_message_id != null) {
    sql += ' AND message_id < ?'
    params.push(opts.before_message_id)
  }
  sql += ' ORDER BY ts DESC, message_id DESC LIMIT ?'
  params.push(limit)
  const rows = requireDb().prepare(sql).all(...params as any[]) as RecordedMessage[]
  // SELECT was DESC; flip to oldest-first for the caller.
  rows.reverse()
  return rows
}
