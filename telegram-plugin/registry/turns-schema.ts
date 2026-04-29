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
 *     turn_key              TEXT PK           -- e.g. "8248703757:11"
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
 *   On every gateway boot, call `markOrphanedAsRestarted(db)` immediately
 *   after opening the DB. Any turn with `ended_at IS NULL` was killed
 *   mid-flight (SIGKILL, OOM, power loss) — it never got a chance to write
 *   a clean-shutdown marker. Stage 3 of simplify-restart will wire this up
 *   from the gateway entry point.
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

function applySchema(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA_SQL)
  // Run migrations for Phase 1 columns. SQLite doesn't support
  // "ADD COLUMN IF NOT EXISTS", so we swallow the "duplicate column" error.
  for (const sql of PHASE1_MIGRATIONS) {
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
    chmodSync(path, 0o600)
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
 * swept by `markOrphanedAsRestarted` on a prior boot).
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
 * Boot-time reaper. Sweeps ALL turns (across all chats) that have
 * `ended_at IS NULL` and stamps them with `ended_via = 'restart'` and
 * `ended_at = now()`.
 *
 * Call this once, immediately after `openTurnsDb`, before any new turns
 * are recorded for the current boot. That way the current boot's turns
 * are cleanly separable from orphans inherited from the prior process.
 *
 * Returns the number of rows updated.
 */
export function markOrphanedAsRestarted(db: SqliteDatabase): number {
  const now = Date.now()
  const result = db.prepare(`
    UPDATE turns
    SET ended_at   = ?,
        ended_via  = 'restart',
        updated_at = ?
    WHERE ended_at IS NULL
  `).run(now, now) as { changes: number }
  return result.changes
}

/**
 * Find the single most-recently-started turn that ended via an interrupt
 * (`'restart'` | `'sigterm'` | `'timeout'`) OR is still open
 * (`ended_at IS NULL`). Used by Stage 4 to surface "you had pending work"
 * to the agent on cold start.
 *
 * Returns null if no such turn exists (clean boot — last turn ended 'stop').
 *
 * Note on ordering: we use `started_at DESC` (not `updated_at`) so the
 * boot-time reaper (which mass-stamps orphans with the SAME `ended_at` /
 * `updated_at`) doesn't reorder them; the temporal "last turn" is what
 * the user remembers, and that's `started_at`.
 */
export function findMostRecentInterruptedTurn(db: SqliteDatabase): Turn | null {
  const row = db.prepare(`
    SELECT * FROM turns
    WHERE ended_at IS NULL
       OR ended_via IN ('restart', 'sigterm', 'timeout')
    ORDER BY started_at DESC
    LIMIT 1
  `).get() as RawTurnRow | undefined
  return row ? mapRow(row) : null
}
