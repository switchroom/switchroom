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
 *     jsonl_agent_id      TEXT             -- nullable; JSONL filename stem for watcher ID linkage
 *
 * Status transitions:
 *   running → stalled     (via recordSubagentStall — no ended_at, may resume)
 *   stalled → running     (via recordSubagentResume — JSONL activity returned
 *                          before terminal; closes the resume edge the watcher
 *                          documented but never wired)
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
  /** JSONL filename stem (e.g. "a37ad7639ae61476c") for watcher ID linkage. */
  jsonl_agent_id: string | null
  /**
   * JSONL stem of the DISPATCHING sub-agent, for a NESTED (depth-2+) worker
   * — one spawned by another sub-agent rather than by the main session.
   * NULL for a main-session dispatch. Written by the watcher when it
   * observes an Agent/Task tool_use inside a worker's own JSONL
   * (recordNestedSubagentDispatch). Enables transitive origin-chat
   * resolution: a nested worker whose parent_turn_key can never be stamped
   * (its dispatching context is a background worker that outlives the main
   * turn, so turn-active.json is gone) inherits routing from its ancestor
   * chain instead.
   */
  parent_agent_id: string | null
  /**
   * Live model the sub-agent is running, as a raw resolved model id (e.g.
   * `claude-opus-4-8`, `sr-glm-5`). Seeded at dispatch from the Agent tool's
   * `tool_input.model` (first-paint fallback, written by the pretool hook), then
   * updated on change by the watcher from the worker's own transcript
   * `message.model` (transcript wins). Persisted so boot-replay / handback cards
   * can render the model even with no live watcher entry. NULL when never
   * observed — the card omits the model rather than guessing from config.
   */
  model: string | null
}

export interface RecordSubagentStartArgs {
  id: string
  parentSessionId?: string | null
  parentTurnKey?: string | null
  agentType?: string | null
  description?: string | null
  background: boolean
  startedAt: number
  /** JSONL filename stem for watcher liveness linkage. */
  jsonlAgentId?: string | null
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
  /**
   * Optional human-readable reason written to `result_summary`. Used by the
   * reaper to record WHY a row was stalled out (e.g. "reaped: stuck in
   * running for 47h with no jsonl linkage"). Omitted for the watcher's
   * normal stall-detection path so existing callers are unchanged.
   */
  reason?: string
}

export interface BumpSubagentActivityArgs {
  id: string
  ts: number
}

export interface RecordSubagentResumeArgs {
  id: string
  /** Wall-clock when the resume was observed. Not stored — last_activity_at
   *  is updated separately by bumpSubagentActivity. Available for callers
   *  that want to log it. */
  resumedAt: number
}

export interface ReapStuckRunningArgs {
  /**
   * Maximum age (ms since `last_activity_at`, or since `started_at` for rows
   * that never had liveness writes) before a `running` background row is
   * considered orphaned. Default 1h is enough that a real long-running
   * sub-agent isn't false-positived but a watcher-missed row is caught
   * within a window the operator notices.
   */
  ttlMs: number
  /** Current time (DI for tests). */
  now: number
  /**
   * Optional liveness cross-check against the in-memory file-discovery
   * registry. Called with a candidate row's `jsonl_agent_id` (null when
   * linkage never happened); return `true` if the watcher is actively
   * tailing a live worker for that id. When it returns true the row is
   * NOT reaped — the DB's `last_activity_at` is a *stale* liveness signal
   * (it's only bumped when the JSONL is linked, and it freezes during a
   * long in-flight tool call), so a row the watcher knows is alive must
   * not be independently classified as dead here. The watcher owns that
   * worker's terminal transition. Incident 2026-07-10: a live, actively-
   * card-editing worker was reaped as terminal because this cross-check
   * didn't exist. Omit to preserve the pre-fix unconditional behaviour.
   */
  isLive?: (jsonlAgentId: string | null) => boolean
}

export interface ReapStuckRunningResult {
  /** How many rows were transitioned. */
  reaped: number
  /** Tool-use ids of rows that were reaped — for logging / tests. */
  ids: string[]
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Base table + indexes that don't depend on the jsonl_agent_id column.
// The jsonl_agent_id column is added (if missing) by the migration block in
// applySubagentsSchema, and its index is created there too — putting the
// index in this base SQL would fail on pre-existing tables that don't yet
// have the column ("no such column: jsonl_agent_id"), because
// `CREATE TABLE IF NOT EXISTS` is a no-op on those tables and the column
// only appears after the ALTER below.
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
    result_summary    TEXT,
    jsonl_agent_id    TEXT,
    parent_agent_id   TEXT,
    model             TEXT
  );
  CREATE INDEX IF NOT EXISTS subagents_turn      ON subagents(parent_turn_key);
  CREATE INDEX IF NOT EXISTS subagents_status    ON subagents(status);
`

/**
 * Apply the subagents schema to an existing DB. Safe to call on a DB that
 * already has the turns table — uses CREATE IF NOT EXISTS throughout.
 *
 * Also runs an ALTER TABLE migration to add `jsonl_agent_id` to pre-existing
 * tables that were created before this column was introduced. The migration
 * runs BEFORE the jsonl_agent_id index is created — putting that index in
 * the base SQL would throw "no such column: jsonl_agent_id" on pre-existing
 * tables, because `CREATE TABLE IF NOT EXISTS` is a no-op there and the
 * column only appears after the ALTER below.
 */
export function applySubagentsSchema(db: SqliteDatabase): void {
  db.exec(SUBAGENTS_SCHEMA_SQL)
  // Idempotent column migration for DBs created before jsonl_agent_id existed.
  // SQLite's ALTER TABLE ADD COLUMN fails if the column already exists, so we
  // check pragma_table_info first.
  const cols = db.prepare("SELECT name FROM pragma_table_info('subagents')").all() as { name: string }[]
  const hasJsonlId = cols.some((c) => c.name === 'jsonl_agent_id')
  if (!hasJsonlId) {
    db.exec('ALTER TABLE subagents ADD COLUMN jsonl_agent_id TEXT')
  }
  // Idempotent migration for DBs created before parent_agent_id existed
  // (nested-worker keying — see the Subagent.parent_agent_id doc).
  const hasParentAgentId = cols.some((c) => c.name === 'parent_agent_id')
  if (!hasParentAgentId) {
    db.exec('ALTER TABLE subagents ADD COLUMN parent_agent_id TEXT')
  }
  // Idempotent migration for DBs created before the live-model column existed
  // (progress-card live model — see the Subagent.model doc).
  const hasModel = cols.some((c) => c.name === 'model')
  if (!hasModel) {
    db.exec('ALTER TABLE subagents ADD COLUMN model TEXT')
  }
  // Always (re-)apply the index. `IF NOT EXISTS` makes this a no-op when it
  // already exists. Splitting it from SUBAGENTS_SCHEMA_SQL is what fixes the
  // pre-existing-table failure mode — by the time we reach this line, the
  // column is guaranteed to exist (either created with the table or added by
  // the migration above).
  db.exec('CREATE INDEX IF NOT EXISTS subagents_jsonl_id ON subagents(jsonl_agent_id)')
  // Same deferred-index rationale as jsonl_agent_id above: parent_agent_id is
  // added by the ALTER migration for pre-existing tables, so its index must be
  // created here (after the column is guaranteed to exist), not in the base SQL.
  // Backs the per-poll child-existence probe in subagent-watcher.ts
  // (`SELECT 1 FROM subagents WHERE parent_agent_id = ? LIMIT 1`).
  db.exec('CREATE INDEX IF NOT EXISTS subagents_parent_agent ON subagents(parent_agent_id)')
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
  jsonl_agent_id: string | null
  parent_agent_id?: string | null
  model?: string | null
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
    jsonl_agent_id: row.jsonl_agent_id,
    parent_agent_id: row.parent_agent_id ?? null,
    model: row.model ?? null,
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
       background, started_at, last_activity_at, status, jsonl_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(
    args.id,
    args.parentSessionId ?? null,
    args.parentTurnKey ?? null,
    args.agentType ?? null,
    args.description ?? null,
    args.background ? 1 : 0,
    args.startedAt,
    args.startedAt,
    args.jsonlAgentId ?? null,
  )
}

/**
 * Look up a subagent row by its JSONL filename stem (jsonl_agent_id).
 * Returns the full row so the watcher can get the tool_use_id PK to pass
 * to bumpSubagentActivity.
 *
 * Returns null if not found.
 */
export function getSubagentByJsonlId(db: SqliteDatabase, jsonlAgentId: string): Subagent | null {
  const row = db
    .prepare('SELECT * FROM subagents WHERE jsonl_agent_id = ?')
    .get(jsonlAgentId) as RawSubagentRow | undefined
  return row ? mapSubagentRow(row) : null
}

/**
 * Count background subagents that have not yet reached a terminal state.
 *
 * This is the dispatch-time source of truth for "is a background worker still
 * running" — the row is INSERTed with `status='running'` by `recordSubagentStart`
 * the moment the parent's `Agent` tool_use fires (keyed on the `toolu_…` id),
 * which is BEFORE the parent's turn ends. The deferred-done-reaction gate reads
 * this so it holds the 👍 the instant a worker is dispatched, rather than
 * snapshotting the file-discovery registry (which lags dispatch by a poll/fswatch
 * tick and so missed just-dispatched workers — the premature-👍 race).
 *
 * Counts `running` ONLY — `stalled` is deliberately excluded. `stalled` is NOT
 * a terminal status: the reaper (`reapStuckRunningRows`) transitions a row to
 * `stalled`, never to `completed`/`failed`. A genuinely-orphaned background row
 * — one INSERTed at dispatch whose JSONL was never linked, so no activity ever
 * bumped it and the in-memory silent-stall synthesis never terminalised it —
 * sits in `stalled` indefinitely (the 1h reaper TTL is the only thing that
 * moves it off `running`). Counting `stalled` would wedge the deferred 👍 above
 * zero forever for that row (`reaction-defer.ts` `promote()` bails while the
 * count is > 0). A live-but-quiet worker, by contrast, is driven to `completed`
 * by the watcher's terminal paths (end_turn signal OR silent-stall synthesis,
 * both call `recordSubagentEnd`) long before the 1h reaper, and a stalled row
 * that genuinely resumes is flipped back to `running` by `recordSubagentResume`
 * — so excluding `stalled` never releases the 👍 on a worker that's merely
 * paused rather than dead.
 */
export function countRunningBackgroundSubagents(db: SqliteDatabase): number {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM subagents WHERE background = 1 AND status = 'running'",
    )
    .get() as { n: number } | undefined
  return row?.n ?? 0
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
  // When `reason` is supplied, write it to result_summary so a later
  // operator (or `switchroom debug` output) can see why the row was
  // stalled — distinguishes "JSONL idle past stall threshold" from
  // "reaped because no jsonl linkage was ever established."
  // result_summary is preserved (COALESCE) for callers without a reason.
  if (args.reason !== undefined) {
    db.prepare(`
      UPDATE subagents
      SET status         = 'stalled',
          result_summary = ?
      WHERE id = ?
        AND status NOT IN ('completed', 'failed')
    `).run(args.reason, args.id)
    return
  }
  db.prepare(`
    UPDATE subagents
    SET status = 'stalled'
    WHERE id = ?
      AND status NOT IN ('completed', 'failed')
  `).run(args.id)
}

/**
 * Reap any background subagent row that's been stuck in `status='running'`
 * past `ttlMs` of inactivity. Transitions to `status='stalled'` with a
 * result_summary recording the reason — same terminal-ish state as a normal
 * stall (resumable if activity returns, but the row no longer counts as
 * an in-flight worker for fleet-status purposes).
 *
 * Rationale: the watcher's `sub_agent_turn_end` handler and `checkStalls`
 * both update rows by `jsonl_agent_id`. Rows whose JSONL was never linked
 * (backfill failed — meta.json missing, descriptor mismatch, etc.) are
 * invisible to both paths and stay in `running` indefinitely. The reaper
 * is the unconditional safety net.
 *
 * Activity test:
 *   - prefer `last_activity_at` (set by Phase 3 liveness writes)
 *   - fall back to `started_at` (the row was inserted but no JSONL ever
 *     bumped activity — strong signal the linkage never happened)
 *
 * Foreground rows are excluded — their lifecycle goes through PostToolUse
 * which writes `completed` directly; if those are stuck it's a different
 * bug than the JSONL-linkage gap this reaper addresses.
 */
export function reapStuckRunningRows(
  db: SqliteDatabase,
  args: ReapStuckRunningArgs,
): ReapStuckRunningResult {
  const cutoff = args.now - args.ttlMs
  const rows = db
    .prepare(`
      SELECT id, jsonl_agent_id FROM subagents
      WHERE status = 'running'
        AND background = 1
        AND COALESCE(last_activity_at, started_at) < ?
    `)
    .all(cutoff) as Array<{ id: string; jsonl_agent_id: string | null }>

  // Cross-check each stale-by-DB candidate against the live in-memory
  // registry. A worker the watcher is actively tailing is NOT dead just
  // because its DB `last_activity_at` is stale/NULL — the watcher owns
  // its terminal transition. Skipping these prevents the incident where a
  // live, actively-card-editing worker was reaped as terminal.
  const candidates = args.isLive
    ? rows.filter((r) => !args.isLive!(r.jsonl_agent_id))
    : rows

  for (const row of candidates) {
    recordSubagentStall(db, {
      id: row.id,
      stalledAt: args.now,
      reason: `reaped: stuck in running past ${Math.round(args.ttlMs / 60_000)}min ttl (jsonl linkage likely missing)`,
    })
  }

  return { reaped: candidates.length, ids: candidates.map((r) => r.id) }
}

/**
 * Reverse the stalled→running edge when JSONL activity returns. Mirror of
 * `recordSubagentStall` for the resume direction the schema doc has always
 * promised but the watcher never implemented (the cause of "card freezes
 * at ⚠ Stalled even after sub-agent resumes / completes" — see
 * subagent-watcher.ts checkStalls + bumpSubagentActivity).
 *
 * Idempotent + safe:
 *   - Only flips rows where status is currently 'stalled'. A row that's
 *     already 'running' is untouched (no-op UPDATE). A terminal row
 *     ('completed' / 'failed') stays terminal — terminal beats both
 *     stalled and running.
 *   - No-ops gracefully if `id` is not found.
 *   - last_activity_at is NOT touched here — callers separately call
 *     bumpSubagentActivity for the activity bump on the same tick.
 */
export function recordSubagentResume(db: SqliteDatabase, args: RecordSubagentResumeArgs): void {
  void args.resumedAt // available for log lines; not persisted (started_at + last_activity_at carry the timing)
  db.prepare(`
    UPDATE subagents
    SET status = 'running'
    WHERE id = ?
      AND status = 'stalled'
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

export interface RecordSubagentModelArgs {
  id: string
  /** Raw resolved model id (e.g. `claude-opus-4-8`). Callers pass only
   *  non-sentinel, non-empty values — the watcher filters at the projection. */
  model: string
}

/**
 * Persist the live model on a subagent row (update-on-change, like
 * last_activity_at). Written by the watcher whenever it observes a NEW model on
 * the worker's transcript, so a later boot-replay / handback card renders the
 * model even with no live in-memory entry. Unconditional UPDATE by `id`; no-ops
 * gracefully if the row is not found. Idempotent — the caller only calls it on
 * an actual change, but a repeat write is harmless.
 */
export function recordSubagentModel(db: SqliteDatabase, args: RecordSubagentModelArgs): void {
  db.prepare(`
    UPDATE subagents
    SET model = ?
    WHERE id = ?
  `).run(args.model, args.id)
}

/**
 * Return all subagents, optionally filtered by status, ordered by
 * started_at DESC. Intended for the REST API endpoint
 * `GET /api/agents/:name/subagents?status=running`.
 */
export function listSubagents(
  db: SqliteDatabase,
  opts: { status?: string } = {},
): Subagent[] {
  if (opts.status !== undefined) {
    const rows = db.prepare(`
      SELECT * FROM subagents
      WHERE status = ?
      ORDER BY started_at DESC
    `).all(opts.status) as RawSubagentRow[]
    return rows.map(mapSubagentRow)
  }
  const rows = db.prepare(`
    SELECT * FROM subagents
    ORDER BY started_at DESC
  `).all() as RawSubagentRow[]
  return rows.map(mapSubagentRow)
}

/**
 * List the sub-agents of a given parent turn that had NOT reached a terminal
 * state (`completed` / `failed`) — i.e. `running` or `stalled`. Ordered by
 * `started_at ASC` (dispatch order) so the resume inbound lists them the way
 * they were spawned.
 *
 * This is the boot-resume accessor: when a turn is interrupted mid-flight, its
 * in-flight workers were killed with it, so the resumed session needs to know
 * which ones didn't finish to re-dispatch them. Deliberately includes
 * `stalled` alongside `running` — a row the reaper flipped to `stalled` (1h
 * TTL, JSONL linkage missing) still never completed, so it belongs in the
 * "these died, re-dispatch if still needed" list. Only genuine terminals are
 * excluded. This also makes the read robust to boot ordering: even if the
 * watcher's reaper transitions a row to `stalled` before this runs, the row is
 * still surfaced rather than dropped.
 *
 * Known gap: rows with NULL parent_turn_key are silently omitted — the
 * INSERT-time stamp can be missing (no turn-active marker at dispatch, e.g.
 * nested workers) and the watcher's async backfill may not have run before the
 * killing restart. Those workers won't appear in the resume inbound; the
 * wake-audit orphan-check (switchroom-runtime skill) is the backstop.
 */
export function listNonTerminalSubagentsForTurn(
  db: SqliteDatabase,
  parentTurnKey: string,
): Subagent[] {
  const rows = db
    .prepare(`
      SELECT * FROM subagents
      WHERE parent_turn_key = ?
        AND status NOT IN ('completed', 'failed')
      ORDER BY started_at ASC
    `)
    .all(parentTurnKey) as RawSubagentRow[]
  return rows.map(mapSubagentRow)
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

// ---------------------------------------------------------------------------
// Nested (depth-2+) worker keying — the unified progress-card fix
// ---------------------------------------------------------------------------

export interface RecordNestedSubagentDispatchArgs {
  /** tool_use id of the nested Agent/Task dispatch — the subagents PK the
   *  child's meta.json `toolUseId` will later link against. */
  toolUseId: string
  /** JSONL stem of the DISPATCHING worker (the parent sub-agent). */
  parentJsonlAgentId: string
  agentType?: string | null
  description?: string | null
  /** `run_in_background` from the nested dispatch's tool_input. */
  background: boolean
  now: number
}

/**
 * Record a NESTED sub-agent dispatch observed by the watcher in a worker's
 * own JSONL (a `sub_agent_tool_use` whose tool is Agent/Task).
 *
 * Why this exists: the PreToolUse tracker hook derives `parent_turn_key`
 * from the gateway's `turn-active.json` marker, which only exists during
 * the MAIN turn. A nested worker is dispatched by a background depth-1
 * worker that outlives that turn, so the marker is gone → the hook stamps
 * NULL (or, under concurrent dispatch, the hook's write can be lost
 * entirely). The row is then missing/unattributed: origin-chat resolution
 * returns null (card misroutes to the owner DM), `resolveWorkerFeedDispatch`
 * defaults the worker to foreground, and the card freezes on "starting…"
 * forever. The watcher, however, tails the parent worker's JSONL and SEES
 * the nested dispatch — so it is the reliable recorder for depth-2+.
 *
 * Behaviour (idempotent, safe to call on every observation):
 *   - INSERT OR IGNORE a row keyed on the dispatch tool_use_id (harmless
 *     no-op when the pretool hook's row already landed).
 *   - Stamp `parent_agent_id` (the dispatching worker's JSONL stem) when
 *     not already set.
 *   - Inherit `parent_turn_key` transitively from the parent worker's row
 *     when NULL — the parent's row was stamped at ITS dispatch (main turn
 *     still active), so the chain bottoms out at a real turn key.
 */
export function recordNestedSubagentDispatch(
  db: SqliteDatabase,
  args: RecordNestedSubagentDispatchArgs,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status, jsonl_agent_id,
       parent_agent_id)
    VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, 'running', NULL, ?)
  `).run(
    args.toolUseId,
    args.agentType ?? null,
    args.description ?? null,
    args.background ? 1 : 0,
    args.now,
    args.now,
    args.parentJsonlAgentId,
  )
  // Repair path for a hook-inserted row: stamp nested parentage and inherit
  // the origin turn key from the parent worker's row when missing. COALESCE
  // keeps any value already present (hook-stamped or previously inherited).
  db.prepare(`
    UPDATE subagents
    SET parent_agent_id = COALESCE(parent_agent_id, ?),
        parent_turn_key = COALESCE(
          parent_turn_key,
          (SELECT p.parent_turn_key FROM subagents p
           WHERE p.jsonl_agent_id = ? LIMIT 1)
        )
    WHERE id = ?
  `).run(args.parentJsonlAgentId, args.parentJsonlAgentId, args.toolUseId)
}

export interface StampSubagentDispatchTurnArgs {
  /** tool_use id of the Agent/Task dispatch — the subagents PK the pretool
   *  hook inserts (or will insert) the row under. */
  toolUseId: string
  /** The live turn's registry key (`turns.turn_key`) at dispatch time. */
  parentTurnKey: string
  agentType?: string | null
  description?: string | null
  /** `run_in_background` from the dispatch's tool_input. */
  background: boolean
  now: number
}

/**
 * Stamp `parent_turn_key` on a depth-1 sub-agent row at DISPATCH time, from
 * the gateway's own live turn context (the `tool_use` session event for an
 * Agent/Task dispatch observed while a turn atom is open).
 *
 * Why this exists (Telegram msg 6897 misroute, 2026-08-04): the pretool
 * hook's dispatch-time stamp (#2085) sources the turn key from the
 * `turn-active.json` marker file, and the watcher's backfill
 * (subagent-watcher.ts) sources it from a `turns` row whose
 * [started_at, ended_at] window contains the dispatch. Both sources can be
 * missing at once — a synthesized turn that never registered its surface, a
 * swept/corrupted marker, a hook write lost to SQLITE_BUSY — leaving
 * `parent_turn_key` NULL and the worker's card + handback falling back to
 * the owner DM with the thread stripped. The gateway, however, KNOWS the
 * live turn key when it observes the dispatch: this helper writes it
 * directly, marker-free and window-free.
 *
 * Behaviour (idempotent, mirrors recordNestedSubagentDispatch):
 *   - INSERT OR IGNORE a row keyed on the dispatch tool_use_id (harmless
 *     no-op when the pretool hook's row already landed — the common case).
 *   - UPDATE `parent_turn_key` only when NULL (COALESCE), so a value the
 *     hook already stamped from the live marker is never overwritten.
 */
export function stampSubagentDispatchTurn(
  db: SqliteDatabase,
  args: StampSubagentDispatchTurnArgs,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    args.toolUseId,
    args.parentTurnKey,
    args.agentType ?? null,
    args.description ?? null,
    args.background ? 1 : 0,
    args.now,
    args.now,
  )
  db.prepare(`
    UPDATE subagents
    SET parent_turn_key = COALESCE(parent_turn_key, ?)
    WHERE id = ?
  `).run(args.parentTurnKey, args.toolUseId)
}

/**
 * Resolve the ORIGIN turn key for a worker, walking the nested-parent chain.
 *
 * Depth-1: the row's own `parent_turn_key`. Depth-2+: when NULL, follow
 * `parent_agent_id` (the dispatching worker's JSONL stem) up the chain until
 * a row with a non-NULL `parent_turn_key` is found. Bounded (default 5 hops)
 * and cycle-safe. Returns null when nothing in the chain is attributed —
 * callers keep their existing DM fallback.
 */
export function resolveSubagentOriginTurnKey(
  db: SqliteDatabase,
  jsonlAgentId: string,
  maxHops = 5,
): string | null {
  const seen = new Set<string>()
  let currentJsonlId: string | null = jsonlAgentId
  for (let hop = 0; hop <= maxHops && currentJsonlId != null; hop++) {
    if (seen.has(currentJsonlId)) return null
    seen.add(currentJsonlId)
    const row = db
      .prepare('SELECT parent_turn_key, parent_agent_id FROM subagents WHERE jsonl_agent_id = ? LIMIT 1')
      .get(currentJsonlId) as { parent_turn_key: string | null; parent_agent_id: string | null } | undefined
    if (row == null) return null
    if (row.parent_turn_key != null && row.parent_turn_key.length > 0) return row.parent_turn_key
    currentJsonlId = row.parent_agent_id ?? null
  }
  return null
}
