/**
 * Turn-tracking schema for the per-agent registry.
 *
 * Phase 0 of #250 (the SQLite event registry). This module ships only what
 * subsequent stages of the simplify-restart plan need to detect "this turn
 * was orphaned by a restart" — a minimal, strictly-subset design so later
 * registry work can extend without breaking changes.
 *
 * The DB file lives at `<agentDir>/telegram/registry.db`. Storage is
 * `bun:sqlite` (Bun's bundled SQLite, no extra dep), same as history.ts.
 *
 * Schema (one table):
 *
 *   turns
 *     turn_key              TEXT PK           -- e.g. "12345:11"
 *     chat_id               TEXT NOT NULL
 *     thread_id             TEXT              -- nullable: forum topics only
 *     started_at            INTEGER NOT NULL  -- unix ms
 *     ended_at              INTEGER           -- nullable until turn ends
 *     ended_via             TEXT              -- 'stop' | 'sigterm' | 'restart' | 'timeout' | 'unknown'
 *     last_assistant_msg_id TEXT              -- last outbound message_id in this turn
 *     last_assistant_done   INTEGER           -- 0|1; 1 = stream_reply done=true sent
 *     last_user_msg_id      TEXT              -- inbound message_id that started the turn
 *     user_prompt_preview   TEXT              -- first ~200 chars of user message (Phase 1)
 *     assistant_reply_preview TEXT            -- first ~200 chars of bot's terminal message (Phase 1)
 *     tool_call_count       INTEGER           -- count of tool_use events in the turn (Phase 1)
 *     created_at            INTEGER NOT NULL
 *     updated_at            INTEGER NOT NULL
 *
 * Boot-time usage:
 *   On every gateway boot, call `markOrphanedWithTimeoutClassification(db, …)`
 *   immediately after opening the DB. Any turn with `ended_at IS NULL` was
 *   killed mid-flight (SIGKILL, OOM, power loss, operator restart) — it never
 *   got a chance to write a clean-shutdown marker. The classifier stamps the
 *   in-flight turn `'timeout'` when its hang-marker is stale and `'restart'`
 *   otherwise; the gateway then resumes or reports accordingly.
 */

import { chmodSync, mkdirSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// bun:sqlite lazy-loader (same pattern as history.ts)
// ---------------------------------------------------------------------------

/**
 * `bun:sqlite` is a Bun built-in — Vite/Node loaders can't resolve it
 * statically, which would crash any vitest test that transitively imports
 * this module. Hide the require behind `import.meta.require` so static
 * analysis passes; runtime resolution is per-Bun and works fine.
 */
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown
  close(): void
}
type SqliteDatabaseConstructor = new (path: string, opts?: { create?: boolean }) => SqliteDatabase

let DatabaseClass: SqliteDatabaseConstructor | null = null
function loadDatabaseClass(): SqliteDatabaseConstructor {
  if (DatabaseClass != null) return DatabaseClass
  try {
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
      `turns-schema.ts requires Bun runtime (bun:sqlite). Caller: ${(err as Error).message}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnEndedVia = 'stop' | 'sigterm' | 'restart' | 'timeout' | 'unknown'

export interface Turn {
  turn_key: string
  chat_id: string
  thread_id: string | null
  started_at: number
  ended_at: number | null
  ended_via: TurnEndedVia | null
  last_assistant_msg_id: string | null
  last_assistant_done: boolean | null
  last_user_msg_id: string | null
  user_prompt_preview: string | null
  assistant_reply_preview: string | null
  tool_call_count: number | null
  /**
   * Forensic snapshot persisted by the boot-time classifier when a turn is
   * stamped `ended_via='timeout'` (the hang-watchdog window elapsed with no
   * tool progress). Carries the idle duration so a *later* boot can rebuild
   * the watchdog-report inbound after the on-disk turn-active marker — the
   * only live source of the idle age — has already been swept. Null for
   * cleanly-restarted (`'restart'`) orphans.
   */
  interrupt_reason: string | null
  created_at: number
  updated_at: number
}

export interface RecordTurnStartArgs {
  turnKey: string
  chatId: string
  threadId?: string | null
  lastUserMsgId?: string | null
  userPromptPreview?: string | null
}

export interface RecordTurnEndArgs {
  turnKey: string
  endedVia: TurnEndedVia
  lastAssistantMsgId?: string | null
  lastAssistantDone?: boolean
  assistantReplyPreview?: string | null
  toolCallCount?: number
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS turns (
    turn_key                TEXT    PRIMARY KEY,
    chat_id                 TEXT    NOT NULL,
    thread_id               TEXT,
    started_at              INTEGER NOT NULL,
    ended_at                INTEGER,
    ended_via               TEXT,
    last_assistant_msg_id   TEXT,
    last_assistant_done     INTEGER,
    last_user_msg_id        TEXT,
    user_prompt_preview     TEXT,
    assistant_reply_preview TEXT,
    tool_call_count         INTEGER,
    interrupt_reason        TEXT,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turns_chat_ended ON turns(chat_id, ended_at);
`

// Columns added in Phase 1 of #332. Applied via ALTER TABLE so existing
// registry.db files on disk are migrated non-destructively on first open.
const PHASE1_MIGRATIONS = [
  `ALTER TABLE turns ADD COLUMN user_prompt_preview TEXT`,
  `ALTER TABLE turns ADD COLUMN assistant_reply_preview TEXT`,
  `ALTER TABLE turns ADD COLUMN tool_call_count INTEGER`,
]

// Column added for honest-restart-resume. Persists the idle snapshot the
// boot classifier captures when stamping a turn 'timeout' (see
// `markOrphanedWithTimeoutClassification`).
const PHASE2_MIGRATIONS = [
  `ALTER TABLE turns ADD COLUMN interrupt_reason TEXT`,
]

function applySchema(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // Concurrency: multiple writers contend on this registry (the PreToolUse
  // subagent-tracker hook, the gateway's subagent-watcher backfill, the turns
  // writer) — especially when several sub-agents dispatch at once. Without a
  // busy_timeout, bun:sqlite/better-sqlite3 default to 0ms and the second
  // contending write fails IMMEDIATELY with SQLITE_BUSY ("database is locked"),
  // which the watcher swallows → jsonl_agent_id / parent_turn_key left NULL →
  // worker card mis-routes to the operator DM + false silent-stall synthesis.
  // 5s of wait-and-retry serializes the contenders instead of dropping writes.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  // Run migrations. SQLite doesn't support "ADD COLUMN IF NOT EXISTS", so
  // we swallow the "duplicate column" error to stay idempotent on
  // pre-existing registry.db files.
  for (const sql of [...PHASE1_MIGRATIONS, ...PHASE2_MIGRATIONS]) {
    try {
      db.exec(sql)
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (!msg.includes('duplicate column')) throw err
    }
  }
}

// ---------------------------------------------------------------------------
// openTurnsDb
// ---------------------------------------------------------------------------

/**
 * Open (or create) the per-agent registry DB at
 * `<agentDir>/telegram/registry.db`.
 *
 * Returns the raw Database instance — callers hold it and pass it to the
 * helpers below. This is intentionally NOT a singleton so tests can use
 * in-memory or temp-file DBs without global state pollution.
 *
 * Callers that need a singleton can wrap this themselves. The gateway will
 * hold one instance for the lifetime of the process (Stage 3).
 */
export function openTurnsDb(agentDir: string): SqliteDatabase {
  const Database = loadDatabaseClass()
  const dir = join(agentDir, 'telegram')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'registry.db')
  const db = new Database(path, { create: true })
  applySchema(db)
  try {
    // 0o644 on all three SQLite files so the switchroom-web container
    // (different UID, same host bind-mount) can read turn history.
    // WAL mode requires read access to registry.db-shm and registry.db-wal
    // in addition to the main file — all three must be world-readable.
    chmodSync(path, 0o644)
    for (const suffix of ['-shm', '-wal']) {
      try { chmodSync(path + suffix, 0o644) } catch { /* doesn't exist yet */ }
    }
  } catch {
    /* ignore — chmod not supported on some FUSE mounts */
  }
  return db
}

/**
 * Open an in-memory DB with the turns schema applied.
 * Useful for tests without touching the filesystem.
 */
export function openTurnsDbInMemory(): SqliteDatabase {
  const Database = loadDatabaseClass()
  const db = new Database(':memory:')
  applySchema(db)
  return db
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

interface RawTurnRow {
  turn_key: string
  chat_id: string
  thread_id: string | null
  started_at: number
  ended_at: number | null
  ended_via: string | null
  last_assistant_msg_id: string | null
  last_assistant_done: number | null
  last_user_msg_id: string | null
  user_prompt_preview: string | null
  assistant_reply_preview: string | null
  tool_call_count: number | null
  interrupt_reason: string | null
  created_at: number
  updated_at: number
}

function mapRow(row: RawTurnRow): Turn {
  return {
    turn_key: row.turn_key,
    chat_id: row.chat_id,
    thread_id: row.thread_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    ended_via: (row.ended_via as TurnEndedVia | null) ?? null,
    last_assistant_msg_id: row.last_assistant_msg_id,
    last_assistant_done:
      row.last_assistant_done === null ? null : row.last_assistant_done !== 0,
    last_user_msg_id: row.last_user_msg_id,
    user_prompt_preview: row.user_prompt_preview,
    assistant_reply_preview: row.assistant_reply_preview,
    tool_call_count: row.tool_call_count,
    interrupt_reason: row.interrupt_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Record that a new turn has started. Inserts a row with `ended_at = NULL`.
 * If a row with the same `turnKey` already exists it is left unchanged
 * (INSERT OR IGNORE) — callers should generate unique keys.
 */
export function recordTurnStart(db: SqliteDatabase, args: RecordTurnStartArgs): void {
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO turns
      (turn_key, chat_id, thread_id, started_at, last_user_msg_id,
       user_prompt_preview, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.turnKey,
    args.chatId,
    args.threadId ?? null,
    now,
    args.lastUserMsgId ?? null,
    args.userPromptPreview ?? null,
    now,
    now,
  )
}

/**
 * Record that a turn has ended cleanly. Updates `ended_at`, `ended_via`,
 * and optionally the last outbound message fields, reply preview, and
 * tool-call count.
 *
 * No-ops gracefully if `turnKey` is not found (turn may have already been
 * swept by `markOrphanedWithTimeoutClassification` on a prior boot).
 */
export function recordTurnEnd(db: SqliteDatabase, args: RecordTurnEndArgs): void {
  const now = Date.now()
  db.prepare(`
    UPDATE turns
    SET
      ended_at                = ?,
      ended_via               = ?,
      last_assistant_msg_id   = COALESCE(?, last_assistant_msg_id),
      last_assistant_done     = COALESCE(?, last_assistant_done),
      assistant_reply_preview = COALESCE(?, assistant_reply_preview),
      tool_call_count         = COALESCE(?, tool_call_count),
      updated_at              = ?
    WHERE turn_key = ?
  `).run(
    now,
    args.endedVia,
    args.lastAssistantMsgId ?? null,
    args.lastAssistantDone !== undefined ? (args.lastAssistantDone ? 1 : 0) : null,
    args.assistantReplyPreview ?? null,
    args.toolCallCount !== undefined ? args.toolCallCount : null,
    now,
    args.turnKey,
  )
}

/**
 * Return all turns for `chatId` where `ended_at IS NULL` — these are
 * candidates for "killed mid-turn" (the gateway crashed before the turn
 * completed and wrote its end record).
 *
 * Results are ordered by `started_at ASC` so callers can process
 * oldest-first if they need to replay or report them.
 */
export function findOrphanedTurns(db: SqliteDatabase, chatId: string): Turn[] {
  const rows = db.prepare(`
    SELECT * FROM turns
    WHERE chat_id = ? AND ended_at IS NULL
    ORDER BY started_at ASC
  `).all(chatId) as RawTurnRow[]
  return rows.map(mapRow)
}

/**
 * Fetch a single turn by its primary key, or null if absent.
 *
 * Used to recover the chat/thread a background sub-agent was dispatched
 * from: `subagents.parent_turn_key` is an FK-by-convention to
 * `turns.turn_key`, so this resolves the originating conversation
 * (chat_id + thread_id) for a worker card / handback. Without it the
 * worker feed falls back to the operator DM (the pinned-card fleet that
 * used to carry the chat was removed in #1122), so a Task dispatched from
 * a group/topic posted its progress to the agent's DM instead.
 */
export function getTurnByKey(db: SqliteDatabase, turnKey: string): Turn | null {
  const row = db
    .prepare(`SELECT * FROM turns WHERE turn_key = ?`)
    .get(turnKey) as RawTurnRow | undefined
  return row ? mapRow(row) : null
}

export interface OrphanClassifyOpts {
  /**
   * `turnKey` from the on-disk `turn-active.json` marker — the single
   * in-flight turn the hang-watchdog tracks. Null when no marker is
   * present at boot (the previous process exited cleanly between turns).
   */
  markerTurnKey?: string | null
  /**
   * Age in ms of the `turn-active.json` marker's mtime at boot, or null
   * when no marker is present. The marker's mtime is bumped on every
   * tool_use, so this is "ms since the last observable progress" of the
   * in-flight turn.
   */
  markerAgeMs?: number | null
  /**
   * Hang-watchdog threshold in ms (`TURN_HANG_SECS * 1000`, default
   * 300_000). A marker older than this means the in-flight turn made no
   * tool progress for at least the watchdog window — i.e. it was (or,
   * under Docker where the watchdog is disabled, *would have been*)
   * killed as a hang rather than cleanly restarted. That distinction is
   * the whole point: a hung turn is reported, a live one is resumed.
   */
  hangThresholdMs: number
  /**
   * Opaque snapshot persisted to `interrupt_reason` for the
   * timeout-classified turn so a later boot can rebuild the watchdog
   * report after the marker has been swept.
   */
  reasonSnapshot?: string | null
  /** Injectable clock for tests. */
  now?: number
}

export interface OrphanClassifyResult {
  /** Total rows stamped (timeout + restart). */
  reaped: number
  /** turn_key stamped 'timeout', or null if none qualified as a hang. */
  timeoutTurnKey: string | null
}

/**
 * Boot-time reaper + classifier. Sweeps ALL turns with `ended_at IS NULL`
 * (killed mid-flight: SIGKILL / OOM / hard reboot / operator restart) and
 * stamps an `ended_via`:
 *
 *   - the in-flight turn (matched by `markerTurnKey`) is stamped
 *     `'timeout'` IFF its marker is older than `hangThresholdMs` — it
 *     stalled with no tool progress for the full watchdog window, so it's
 *     reported-not-resumed; its `interrupt_reason` carries `reasonSnapshot`.
 *   - every other open turn (and the in-flight one when it was making
 *     progress) is stamped `'restart'` — a clean interrupt, eligible for
 *     blanket resume.
 *
 * Call this once immediately after `openTurnsDb`, BEFORE any new turns are
 * recorded for the current boot, and BEFORE the turn-active marker is
 * swept (the classifier needs the marker's mtime).
 */
export function markOrphanedWithTimeoutClassification(
  db: SqliteDatabase,
  opts: OrphanClassifyOpts,
): OrphanClassifyResult {
  const now = opts.now ?? Date.now()
  const isHang =
    opts.markerAgeMs != null &&
    opts.markerAgeMs >= opts.hangThresholdMs &&
    opts.markerTurnKey != null &&
    opts.markerTurnKey.length > 0

  let timeoutTurnKey: string | null = null
  if (isHang) {
    const r = db.prepare(`
      UPDATE turns
      SET ended_at         = ?,
          ended_via        = 'timeout',
          interrupt_reason = ?,
          updated_at       = ?
      WHERE turn_key = ? AND ended_at IS NULL
    `).run(now, opts.reasonSnapshot ?? null, now, opts.markerTurnKey) as { changes: number }
    if (r.changes > 0) timeoutTurnKey = opts.markerTurnKey ?? null
  }

  const rest = db.prepare(`
    UPDATE turns
    SET ended_at   = ?,
        ended_via  = 'restart',
        updated_at = ?
    WHERE ended_at IS NULL
  `).run(now, now) as { changes: number }

  return { reaped: (timeoutTurnKey ? 1 : 0) + rest.changes, timeoutTurnKey }
}

/**
 * Return the most recent N turns for `chatId` (any state — running or ended),
 * ordered by started_at DESC. Used by the idle-footer renderer to decide
 * whether to render "working since" vs "idle · last reply".
 *
 * `limit` defaults to 1 because the renderer only inspects the top row, but
 * callers can pass more if they need backfill.
 */
export function findRecentTurnsForChat(
  db: SqliteDatabase,
  chatId: string,
  limit = 1,
): Turn[] {
  const rows = db.prepare(`
    SELECT * FROM turns
    WHERE chat_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(chatId, limit) as RawTurnRow[]
  return rows.map(mapRow)
}

/**
 * Return the most recent N turns across all chats for an agent, ordered by
 * started_at DESC. Intended for the REST API endpoint
 * `GET /api/agents/:name/turns?limit=20`.
 *
 * `limit` defaults to 20, max 200.
 */
/**
 * Return distinct thread_ids (null = general topic) for a given chat_id.
 * Used by the Hermes adapter to enumerate forum topics as separate sessions.
 */
export function listDistinctThreadIds(
  db: SqliteDatabase,
  chatId: string,
): (string | null)[] {
  const rows = db.prepare(`
    SELECT DISTINCT thread_id FROM turns
    WHERE chat_id = ?
    ORDER BY thread_id ASC
  `).all(chatId) as { thread_id: string | null }[]
  return rows.map((r) => r.thread_id)
}

export function listTurnsForAgent(
  db: SqliteDatabase,
  opts: { limit?: number; chatId?: string; threadId?: string | null } = {},
): Turn[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 200)
  if (opts.chatId && 'threadId' in opts) {
    // threadId may be a string ID or null (general topic)
    const rows = db.prepare(`
      SELECT * FROM turns
      WHERE chat_id = ? AND thread_id IS ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(opts.chatId, opts.threadId ?? null, limit) as RawTurnRow[]
    return rows.map(mapRow)
  }
  if (opts.chatId) {
    const rows = db.prepare(`
      SELECT * FROM turns
      WHERE chat_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(opts.chatId, limit) as RawTurnRow[]
    return rows.map(mapRow)
  }
  const rows = db.prepare(`
    SELECT * FROM turns
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as RawTurnRow[]
  return rows.map(mapRow)
}

/** ended_via values that mean "this turn did not finish on its own". */
const INTERRUPTED_VIA: ReadonlySet<TurnEndedVia> = new Set<TurnEndedVia>([
  'restart',
  'sigterm',
  'timeout',
  'unknown',
])

/**
 * Return the single most-recently-started turn IFF it was interrupted
 * (`ended_at IS NULL`, or `ended_via` in {restart, sigterm, timeout,
 * unknown}). Returns null when the latest turn ended cleanly (`'stop'`)
 * or there are no turns at all.
 *
 * This is the resume gate. Keying on the *latest* turn (not "latest
 * interrupted turn anywhere in history") is deliberate: once the agent
 * resumes and that follow-up turn ends `'stop'`, the latest turn is clean
 * and this returns null — so a completed resume is never re-fired on the
 * next restart. The older `findMostRecentInterruptedTurn` had the inverse
 * bug: a clean latest turn didn't shadow a stale interrupted one, so it
 * would resurface already-handled work indefinitely.
 *
 * Ordering uses `started_at DESC` (not `updated_at`) so the boot reaper,
 * which mass-stamps orphans with identical timestamps, can't reorder the
 * temporal "last turn" the user actually remembers.
 */
export function findLatestTurnIfInterrupted(db: SqliteDatabase): Turn | null {
  const row = db.prepare(`
    SELECT * FROM turns
    ORDER BY started_at DESC
    LIMIT 1
  `).get() as RawTurnRow | undefined
  if (!row) return null
  const turn = mapRow(row)
  if (turn.ended_at == null) return turn
  if (turn.ended_via != null && INTERRUPTED_VIA.has(turn.ended_via)) return turn
  return null
}
