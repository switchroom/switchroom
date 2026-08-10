#!/usr/bin/env node
/**
 * PreToolUse hook — records subagent dispatches in the registry DB.
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, tool_use_id, ... }
 *   Output: exit 0 + empty stdout → allow (we never block here).
 *
 * Gates to tool_name === 'Agent'; exits 0 immediately for everything else.
 * DB writes are fire-and-forget: failures are logged to stderr but never
 * block the tool call.
 *
 * DB location: <agentDir>/telegram/registry.db
 *   agentDir lookup (first hit wins):
 *     1. SWITCHROOM_AGENT_DIR env var (explicit override, mainly used in tests)
 *     2. TELEGRAM_STATE_DIR with `/telegram` suffix stripped — the canonical
 *        env var start.sh exports for every switchroom agent (and the same
 *        path the gateway + watcher resolve their DB through). Without this
 *        the hook used to fall through to process.cwd() in production,
 *        writing to a registry.db nobody read, leaving every bg sub-agent
 *        invisible to the watcher. Surfaced by
 *        bg-sub-agent-dispatch-dm.test.ts; see RFC Phase 2 §Bug 2 in
 *        reference/rfcs/sub-agent-visibility.md.
 *     3. process.cwd() (legacy fallback for ad-hoc invocations).
 *
 * Performance: the actual DB write is deferred via setImmediate (Node 22+
 * node:sqlite path) or a non-blocking spawn (CLI fallback) so the hook
 * returns to Claude Code as fast as possible. The process still exits only
 * after the write completes, so observers that wait for process exit (e.g.
 * spawnSync in tests) see a consistent DB state.
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Schema SQL (mirrors subagents-schema.ts)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
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
  CREATE INDEX IF NOT EXISTS subagents_jsonl_id  ON subagents(jsonl_agent_id);
`

// Idempotent column migration for older DBs that pre-date jsonl_agent_id.
// Mirrors applySubagentsSchema's migration in subagents-schema.ts.
const MIGRATE_JSONL_COL_SQL = `
  SELECT name FROM pragma_table_info('subagents') WHERE name = 'jsonl_agent_id'
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Escape a value for inline SQLite SQL (used only in CLI fallback).
 */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  return "'" + String(v).replace(/'/g, "''") + "'"
}

function fillPlaceholders(sql, params) {
  let i = 0
  return sql.replace(/\?/g, () => sqlLiteral(params[i++]))
}

/**
 * Resolve a synchronous SQLite binding compatible with the
 * `DatabaseSync(path)` API (`db.exec(sql)`, `db.prepare(sql).run(...)`,
 * `db.prepare(sql).get(...)`, `db.close()`).
 *
 * Production hooks are spawned via the `#!/usr/bin/env node` shebang, so
 * Node 22+'s `node:sqlite` is the primary path. When the hook is invoked
 * under bun (e.g. `bun test` calling spawnSync(process.execPath, ...) on
 * CI), `node:sqlite` isn't available — fall back to `bun:sqlite` wrapped
 * in a tiny adapter so the call-site code below stays identical.
 *
 * Returns null if neither is available; callers then drop to the
 * `sqlite3` CLI fallback further down.
 */
function resolveSyncSqlite() {
  const [major] = process.versions.node.split('.').map(Number)
  if (major >= 22) {
    try {
      const { DatabaseSync } = require('node:sqlite')
      if (DatabaseSync) return DatabaseSync
    } catch { /* fall through to bun:sqlite */ }
  }
  if (typeof globalThis.Bun !== 'undefined') {
    try {
      const { Database } = require('bun:sqlite')
      // Adapt bun:sqlite to the node:sqlite DatabaseSync surface used
      // below. bun's Database.prepare/run/get/all and exec are
      // sufficient — we only need the call-site shape.
      return function BunDatabaseSyncAdapter(p, opts) {
        // Translate node:sqlite's `readOnly` to bun:sqlite's `readonly` so a
        // read-only call site is read-only on BOTH bindings. See the
        // `readBackgroundFlagSync` comment for why that matters.
        // allow-rw-db-open: shared adapter — the writer call sites open RW through it
        const d = new Database(p, opts?.readOnly ? { readonly: true } : undefined)
        return {
          exec: (sql) => d.exec(sql),
          prepare: (sql) => d.prepare(sql),
          close: () => d.close(),
        }
      }
    } catch { /* fall through to CLI */ }
  }
  return null
}

/**
 * Run SQL against the DB via the sqlite3 CLI (non-blocking).
 * Calls cb(error | null) when the process exits.
 */
function spawnSql(dbPath, sql, cb) {
  // allow-rw-db-open: this is the tracker's WRITE path (INSERT/UPDATE) — it
  // must be read-write. The SELECT path is `spawnSqlRead`, which is -readonly.
  const child = spawn('sqlite3', [dbPath, sql], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  child.on('close', (code) => {
    if (code !== 0) {
      cb(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`))
    } else {
      cb(null)
    }
  })
  child.on('error', cb)
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

function writeRow(dbPath, { id, parentSessionId, parentTurnKey, agentType, description, background, model, now }, done) {
  const INSERT_SQL = `
    INSERT OR IGNORE INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `
  const params = [id, parentSessionId, parentTurnKey, agentType, description, background, now, now, model ?? null]

  // Resolve a synchronous SQLite binding. Try in order:
  //   1. node:sqlite (Node 22+, production path) — exposes DatabaseSync
  //   2. bun:sqlite (when invoked under bun, e.g. from `bun test`) — wrapped
  //      in a tiny adapter so call sites stay unchanged
  // Falls back to the sqlite3 CLI block below if neither is available.
  const DatabaseSync = resolveSyncSqlite()

  if (DatabaseSync != null) {
    // Snapshot all values used inside the closure now, before setImmediate fires.
    const SnapDatabaseSync = DatabaseSync
    const snapDbPath = dbPath
    const snapInsertSql = INSERT_SQL
    const snapParams = params.slice()
    const snapSchemaSql = SCHEMA_SQL
    const snapMigrateSql = MIGRATE_JSONL_COL_SQL

    setImmediate(() => {
      try {
        const db = new SnapDatabaseSync(snapDbPath)
        // Concurrency: this hook writes registry.db from a separate process
        // that contends with the gateway's subagent-watcher + the PostToolUse
        // hook. Without a busy_timeout, the contending write fails IMMEDIATELY
        // with SQLITE_BUSY ("database is locked") when several sub-agents
        // dispatch at once, dropping the row → NULL jsonl_agent_id/parent_turn_key.
        // Per-connection PRAGMA, set on the real open so BOTH the node:sqlite
        // (production) and bun:sqlite branches are armed.
        try { db.exec('PRAGMA busy_timeout = 5000') } catch { /* best-effort */ }
        db.exec(snapSchemaSql)
        // Migrate older DBs that pre-date jsonl_agent_id.
        const hasJsonlCol = db.prepare(snapMigrateSql).get()
        if (hasJsonlCol == null) {
          db.exec('ALTER TABLE subagents ADD COLUMN jsonl_agent_id TEXT')
          db.exec('CREATE INDEX IF NOT EXISTS subagents_jsonl_id ON subagents(jsonl_agent_id)')
        }
        // Migrate older DBs that pre-date parent_agent_id (nested-worker keying).
        const hasParentAgentCol = db
          .prepare("SELECT name FROM pragma_table_info('subagents') WHERE name = 'parent_agent_id'")
          .get()
        if (hasParentAgentCol == null) {
          db.exec('ALTER TABLE subagents ADD COLUMN parent_agent_id TEXT')
        }
        // Migrate older DBs that pre-date the live-model column.
        const hasModelCol = db
          .prepare("SELECT name FROM pragma_table_info('subagents') WHERE name = 'model'")
          .get()
        if (hasModelCol == null) {
          db.exec('ALTER TABLE subagents ADD COLUMN model TEXT')
        }
        // Verify the marker-derived parent_turn_key (snapParams[2]) actually has
        // a row in the turns table before trusting it. The gateway writes the
        // turn-active marker even when recordTurnStart's INSERT failed (the two
        // writes have independent failure surfaces), so a marker can name a
        // turn_key with no turns row. Stamping that phantom key would route the
        // worker card to the operator DM AND block the watcher's NULL-guarded
        // window backfill from recovering it. Downgrade to NULL so the backfill
        // stays eligible — this also defends against a stale/corrupted marker.
        if (snapParams[2] != null) {
          let turnRow = null
          try {
            turnRow = db.prepare('SELECT 1 FROM turns WHERE turn_key = ? LIMIT 1').get(snapParams[2])
          } catch {
            // turns table may not exist yet on a brand-new agent — treat as no row.
            turnRow = null
          }
          if (turnRow == null) snapParams[2] = null
        }
        db.prepare(snapInsertSql).run(...snapParams)
        db.close()
        done(null)
      } catch (err) {
        done(err)
      }
    })
    return
  }

  // sqlite3 CLI fallback — non-blocking spawns sequenced via callbacks.
  // This legacy path (neither node:sqlite nor bun:sqlite available) can't
  // cheaply verify the marker's turn_key against the turns table, so drop
  // parent_turn_key and let the gateway's window backfill attribute it.
  // Production agents use node:sqlite; bun test uses bun:sqlite — both take
  // the verified path above.
  params[2] = null
  spawnSql(dbPath, SCHEMA_SQL.replace(/\n\s+/g, ' '), (err) => {
    if (err) { done(err); return }
    // Best-effort model-column migration for a legacy DB: the INSERT below
    // references the model column, which a pre-model table lacks (CREATE TABLE
    // IF NOT EXISTS is a no-op there, so the schema exec doesn't add it). The
    // ALTER fails with "duplicate column name" when the column already exists —
    // that error is EXPECTED and deliberately ignored; on any failure we still
    // proceed to the INSERT, which surfaces a real problem via `done`.
    spawnSql(dbPath, 'ALTER TABLE subagents ADD COLUMN model TEXT', () => {
      spawnSql(dbPath, fillPlaceholders(INSERT_SQL.trim(), params), done)
    })
  })
}

// ---------------------------------------------------------------------------
// Active-turn resolution (the parent_turn_key the row belongs to)
// ---------------------------------------------------------------------------

/**
 * Read the gateway's turn-active marker to learn the turn_key of the turn that
 * is active *right now* — the turn whose tool call is dispatching this
 * sub-agent. The gateway writes `<TELEGRAM_STATE_DIR>/turn-active.json`
 * synchronously at turn-start (gateway/turn-active-marker.ts), keyed
 * `{turnKey, chatId, threadId, startedAt}`, and removes it at turn-complete.
 * `telegramDir` here resolves to that same `TELEGRAM_STATE_DIR` in production
 * (verified: identical inode to the registry.db dir), so the marker is a
 * sibling of registry.db.
 *
 * Stamping parent_turn_key from this marker at INSERT time — instead of
 * leaving it NULL for the gateway to reconstruct from a started_at time-window
 * at jsonl-link time — fixes two bugs:
 *   - #2081: the time-window backfill mis-attributes when turn windows overlap
 *     (supergroup forum topics multiplex many concurrent turns under one
 *     chat_id; `ended_at` is unreliable/batch-swept). The live marker is the
 *     ground truth for "which turn dispatched this", so there is nothing to
 *     reconstruct and no overlap to disambiguate.
 *   - #2083: the backfill only runs when a sub-agent's JSONL links; ~8% never
 *     link and were never attributed. Stamping at INSERT is independent of
 *     linking.
 *
 * `turnKey` equals `turns.turn_key` (both minted by chatKeyWithSuffix at
 * turn-start), so resolveSubagentOriginChat()'s getTurnByKey() finds the exact
 * (chat_id, thread_id) and routes the worker card to the originating topic.
 *
 * Best-effort: if no turn is active (no marker — e.g. a sub-agent dispatched
 * outside a turn) or the marker is unreadable/malformed, return null and let
 * the gateway's started_at backfill remain the fallback (today's behaviour).
 * Never throws; never blocks the tool call.
 */
function readActiveTurnKey(telegramDir) {
  try {
    // Mirrors TURN_ACTIVE_MARKER_FILE in gateway/turn-active-marker.ts.
    const raw = readFileSync(join(telegramDir, 'turn-active.json'), 'utf8')
    const marker = JSON.parse(raw)
    const turnKey = marker?.turnKey
    return typeof turnKey === 'string' && turnKey.length > 0 ? turnKey : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const raw = readStdin().trim()
  if (!raw) process.exit(0)

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  // Only care about sub-agent dispatches. Claude Code emits the dispatch
  // tool under either the legacy name 'Agent' or the newer 'Task'
  // depending on version. Other call sites in this codebase (session-tail.ts,
  // progress-card.ts, pty-tail.ts, tool-labels.ts) already recognize both —
  // these tracker hooks were the lone gate accepting only 'Agent', which
  // would silently drop every dispatch on any Claude Code version emitting
  // 'Task' (rows never inserted → progress card heuristic + watcher both
  // misroute).
  if (event.tool_name !== 'Agent' && event.tool_name !== 'Task') process.exit(0)

  // Resolve agent dir: explicit env override → derive from TELEGRAM_STATE_DIR
  // (start.sh exports this on every agent) → cwd fallback. The middle case
  // is the production path; without it the hook silently wrote to a
  // registry.db nobody read (#709 / #776 / #782 / #788 Bug 2).
  const stateDir = process.env.TELEGRAM_STATE_DIR
  const derivedFromStateDir = stateDir && stateDir.endsWith('/telegram')
    ? stateDir.slice(0, -'/telegram'.length)
    : null
  const agentDir = process.env.SWITCHROOM_AGENT_DIR
    ?? derivedFromStateDir
    ?? process.cwd()
  const telegramDir = join(agentDir, 'telegram')
  const dbPath = join(telegramDir, 'registry.db')

  if (!existsSync(telegramDir)) {
    try {
      mkdirSync(telegramDir, { recursive: true })
    } catch (err) {
      process.stderr.write(`[subagent-tracker-pretool] mkdir error: ${err?.message ?? err}\n`)
      process.exit(1)
    }
  }

  const input = event.tool_input ?? {}
  // F3 (progress-card fork model): a FORK dispatch (`subagent_type === 'fork'`)
  // inherits the PARENT session's model and IGNORES any `tool_input.model`
  // override. Seeding the row's first-paint model from that ignored override
  // makes the worker card show a WRONG model (e.g. "sonnet" while the fork
  // actually runs Opus) until the watcher overwrites it from the fork's own
  // transcript. Suppress the dispatch-time seed for forks — leave model NULL so
  // the card omits the model rather than showing a value the fork won't honor;
  // the transcript-sourced model then paints as soon as the first assistant
  // line lands (transcript wins, exactly as for non-fork workers). Fixing it at
  // the seed source (not downstream in worker-feed-dispatch) keeps the
  // transcript-confirmed model flowing to the terminal card unchanged.
  const isFork = input.subagent_type === 'fork'
  const dispatchModel =
    !isFork && typeof input.model === 'string' && input.model.length > 0
      ? input.model
      : null
  // Resolve parent_turn_key from the live turn-active marker (the turn whose
  // tool call is dispatching this sub-agent). Claude Code's PreToolUse payload
  // carries only its own session id, never the gateway-minted Telegram turn_key
  // — but the gateway writes that turn_key to <telegramDir>/turn-active.json
  // for the duration of the turn, so we read it directly here. Stamping it at
  // INSERT (vs leaving NULL for the gateway's started_at time-window backfill)
  // fixes overlapping-window mis-attribution (#2081) and attributes sub-agents
  // whose JSONL never links (#2083). NULL when no turn is active → the gateway
  // backfill remains the fallback. See readActiveTurnKey().
  const parentTurnKey = readActiveTurnKey(telegramDir)
  writeRow(
    dbPath,
    {
      id: event.tool_use_id ?? null,
      parentSessionId: event.session_id ?? null,
      parentTurnKey,
      agentType: input.subagent_type ?? null,
      description: input.description ?? null,
      background: input.run_in_background === true ? 1 : 0,
      // First-paint model for the worker card: the Agent tool payload carries
      // the model the sub-agent will run under (`tool_input.model`), available
      // BEFORE the sub-agent writes its first assistant line. Persisted so the
      // card can render the model from dispatch; the watcher later overwrites it
      // from the worker's own transcript (transcript wins). Only a non-empty
      // string is stored — never guess from config. NULL for a fork dispatch,
      // which ignores the model override (see dispatchModel above, F3).
      model: dispatchModel,
      now: Date.now(),
    },
    (err) => {
      if (err) {
        process.stderr.write(`[subagent-tracker-pretool] DB error: ${err?.message ?? err}\n`)
        process.exit(1)
      }
      process.exit(0)
    },
  )
}

main()
