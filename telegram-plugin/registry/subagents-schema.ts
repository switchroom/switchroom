/**
 * Subagent-tracking schema for the per-agent registry.
 *
 * Phase 1 of #333. Adds a `subagents` table to the registry DB that was
 * established by #325 (turns-schema.ts). This module follows the same
 * patterns as turns-schema.ts: bun:sqlite lazy-load, CREATE IF NOT EXISTS
 * idempotent migration, typed helper functions.
 *
 * Schema (second table, co-located in the same registry.db):
 *
 *   subagents
 *     id                  TEXT PK          -- tool_use_id from Agent() call
 *     parent_session_id   TEXT             -- nullable
 *     parent_turn_key     TEXT             -- nullable; FK-by-convention to turns.turn_key
 *     agent_type          TEXT             -- nullable; e.g. 'worker' | 'researcher'
 *     description         TEXT             -- nullable; human-readable task description
 *     background          INTEGER NOT NULL -- 0|1; 1 = run_in_background dispatch
 *     started_at          INTEGER NOT NULL -- unix ms
 *     last_activity_at    INTEGER          -- nullable; updated by watcher (Phase 3)
 *     ended_at            INTEGER          -- nullable until terminal
 *     status              TEXT NOT NULL    -- running | stalled | completed | failed
 *     result_summary      TEXT             -- nullable; set on completion
 *
 * Status transitions:
 *   running → stalled     (via recordSubagentStall — no ended_at, may resume)
 *   running → completed   (via recordSubagentEnd)
 *   running → failed      (via recordSubagentEnd)
 *   stalled → completed   (via recordSubagentEnd — terminal beats stalled)
 *   stalled → failed      (via recordSubagentEnd)
 *
 * Idempotency guarantees:
 *   - recordSubagentStart: INSERT OR IGNORE — duplicate id is a no-op
 *   - recordSubagentEnd:   no-ops if row is already in a terminal status
 *   - recordSubagentStall: no-ops if row is already in a terminal status
 *   - bumpSubagentActivity: unconditional UPDATE on last_activity_at (safe to
 *     call repeatedly)
 *
 * No consumers are wired in Phase 1. Hooks (Phase 2) and watcher (Phase 3)
 * ship separately.
 */

// ---------------------------------------------------------------------------
// bun:sqlite lazy-loader (mirrors turns-schema.ts)
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
      `subagents-schema.ts requires Bun runtime (bun:sqlite). Caller: ${(err as Error).message}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentStatus = 'running' | 'stalled' | 'completed' | 'failed'

export interface Subagent {
  id: string
  parent_session_id: string | null
  parent_turn_key: string | null
  agent_type: string | null
  description: string | null
  background: boolean
  started_at: number
  last_activity_at: number | null
  ended_at: number | null
  status: SubagentStatus
  result_summary: string | null
}

export interface RecordSubagentStartArgs {
  id: string
  parentSessionId?: string | null
  parentTurnKey?: string | null
  agentType?: string | null
  description?: string | null
  background: boolean
  startedAt: number
}

export interface RecordSubagentEndArgs {
  id: string
  endedAt: number
  status: 'completed' | 'failed'
  resultSummary?: string | null
}

export interface RecordSubagentStallArgs {
  id: string
  stalledAt: number
}

export interface BumpSubagentActivityArgs {
  id: string
  ts: number
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SUBAGENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS subagents (
    id                TEXT    PRIMARY KEY,
    parent_session_id TEXT,
    parent_turn_key   TEXT,
    agent_type        TEXT,
    description       TEXT,
    background        INTEGER NOT NULL,
    started_at        INTEGER NOT NULL,
    last_activity_at  INTEGER,
    ended_at          INTEGER,
    status            TEXT    NOT NULL,
    result_summary    TEXT
  );
  CREATE INDEX IF NOT EXISTS subagents_turn   ON subagents(parent_turn_key);
  CREATE INDEX IF NOT EXISTS subagents_status ON subagents(status);
`

/**
 * Apply the subagents schema to an existing DB. Safe to call on a DB that
 * already has the turns table — uses CREATE IF NOT EXISTS throughout.
 */
export function applySubagentsSchema(db: SqliteDatabase): void {
  db.exec(SUBAGENTS_SCHEMA_SQL)
}

// ---------------------------------------------------------------------------
// openSubagentsDbInMemory
// ---------------------------------------------------------------------------

/**
 * Open an in-memory DB with BOTH the turns schema (for #325-shaped DB tests)
 * AND the subagents schema applied.
 *
 * Useful for tests without touching the filesystem.
 */
export function openSubagentsDbInMemory(): SqliteDatabase {
  const Database = loadDatabaseClass()
  const db = new Database(':memory:')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // Apply turns table first (mirrors what openTurnsDb does) so we can test
  // the migration-on-top-of-existing-turns-table scenario.
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      turn_key               TEXT    PRIMARY KEY,
      chat_id                TEXT    NOT NULL,
      thread_id              TEXT,
      started_at             INTEGER NOT NULL,
      ended_at               INTEGER,
      ended_via              TEXT,
      last_assistant_msg_id  TEXT,
      last_assistant_done    INTEGER,
      last_user_msg_id       TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_chat_ended ON turns(chat_id, ended_at);
  `)
  applySubagentsSchema(db)
  return db
}

/**
 * Open an in-memory DB with ONLY the subagents schema (no turns table).
 * Used for fresh-DB migration tests.
 */
export function openFreshSubagentsDbInMemory(): SqliteDatabase {
  const Database = loadDatabaseClass()
  const db = new Database(':memory:')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  applySubagentsSchema(db)
  return db
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

interface RawSubagentRow {
  id: string
  parent_session_id: string | null
  parent_turn_key: string | null
  agent_type: string | null
  description: string | null
  background: number
  started_at: number
  last_activity_at: number | null
  ended_at: number | null
  status: string
  result_summary: string | null
}

function mapSubagentRow(row: RawSubagentRow): Subagent {
  return {
    id: row.id,
    parent_session_id: row.parent_session_id,
    parent_turn_key: row.parent_turn_key,
    agent_type: row.agent_type,
    description: row.description,
    background: row.background !== 0,
    started_at: row.started_at,
    last_activity_at: row.last_activity_at,
    ended_at: row.ended_at,
    status: row.status as SubagentStatus,
    result_summary: row.result_summary,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Record that a subagent has started. Inserts a row with `status='running'`
 * and `last_activity_at = startedAt`.
 *
 * Idempotent: if a row with the same `id` already exists, this is a no-op
 * (INSERT OR IGNORE). The caller is responsible for generating unique IDs
 * (typically the `tool_use_id` from the Agent() tool call).
 */
export function recordSubagentStart(db: SqliteDatabase, args: RecordSubagentStartArgs): void {
  db.prepare(`
    INSERT OR IGNORE INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    args.id,
    args.parentSessionId ?? null,
    args.parentTurnKey ?? null,
    args.agentType ?? null,
    args.description ?? null,
    args.background ? 1 : 0,
    args.startedAt,
    args.startedAt,
  )
}

/**
 * Record that a subagent has reached a terminal state (completed or failed).
 * Sets `ended_at`, `status`, and optionally `result_summary`.
 *
 * Idempotent: if the row is already in a terminal status (`completed` or
 * `failed`), this is a no-op. A stalled subagent CAN be ended — stalled is
 * not terminal.
 *
 * Also no-ops gracefully if `id` is not found.
 */
export function recordSubagentEnd(db: SqliteDatabase, args: RecordSubagentEndArgs): void {
  db.prepare(`
    UPDATE subagents
    SET
      ended_at       = ?,
      status         = ?,
      result_summary = COALESCE(?, result_summary)
    WHERE id = ?
      AND status NOT IN ('completed', 'failed')
  `).run(
    args.endedAt,
    args.status,
    args.resultSummary ?? null,
    args.id,
  )
}

/**
 * Mark a subagent as stalled. Sets `status='stalled'` without setting
 * `ended_at` — stalled subagents may resume (e.g. when the JSONL file's
 * mtime advances again in Phase 3).
 *
 * Idempotent: no-ops if the row is already in a terminal status (`completed`
 * or `failed`). Safe to call multiple times on the same row.
 *
 * Also no-ops gracefully if `id` is not found.
 */
export function recordSubagentStall(db: SqliteDatabase, args: RecordSubagentStallArgs): void {
  void args.stalledAt // available for callers that want to log it; not stored (no ended_at)
  db.prepare(`
    UPDATE subagents
    SET status = 'stalled'
    WHERE id = ?
      AND status NOT IN ('completed', 'failed')
  `).run(args.id)
}

/**
 * Bump `last_activity_at` for a subagent. Used by the watcher (Phase 3) each
 * time the subagent's JSONL file mtime advances.
 *
 * No idempotency constraint here — unconditional UPDATE, safe to call any
 * number of times. No-ops gracefully if `id` is not found.
 */
export function bumpSubagentActivity(db: SqliteDatabase, args: BumpSubagentActivityArgs): void {
  db.prepare(`
    UPDATE subagents
    SET last_activity_at = ?
    WHERE id = ?
  `).run(args.ts, args.id)
}

/**
 * Retrieve a single subagent row by id. Returns null if not found.
 * Useful in tests and for callers that need to inspect current state.
 */
export function getSubagent(db: SqliteDatabase, id: string): Subagent | null {
  const row = db.prepare('SELECT * FROM subagents WHERE id = ?').get(id) as
    | RawSubagentRow
    | undefined
  return row ? mapSubagentRow(row) : null
}
