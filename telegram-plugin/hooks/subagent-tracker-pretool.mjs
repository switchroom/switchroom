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
 *   agentDir = SWITCHROOM_AGENT_DIR env var, falling back to process.cwd()
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
    jsonl_agent_id    TEXT
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
      return function BunDatabaseSyncAdapter(p) {
        const d = new Database(p)
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

function writeRow(dbPath, { id, parentSessionId, parentTurnKey, agentType, description, background, now }, done) {
  const INSERT_SQL = `
    INSERT OR IGNORE INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
  `
  const params = [id, parentSessionId, parentTurnKey, agentType, description, background, now, now]

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
        db.exec(snapSchemaSql)
        // Migrate older DBs that pre-date jsonl_agent_id.
        const hasJsonlCol = db.prepare(snapMigrateSql).get()
        if (hasJsonlCol == null) {
          db.exec('ALTER TABLE subagents ADD COLUMN jsonl_agent_id TEXT')
          db.exec('CREATE INDEX IF NOT EXISTS subagents_jsonl_id ON subagents(jsonl_agent_id)')
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

  // sqlite3 CLI fallback — two non-blocking spawns sequenced via callbacks.
  spawnSql(dbPath, SCHEMA_SQL.replace(/\n\s+/g, ' '), (err) => {
    if (err) { done(err); return }
    spawnSql(dbPath, fillPlaceholders(INSERT_SQL.trim(), params), done)
  })
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

  const agentDir = process.env.SWITCHROOM_AGENT_DIR ?? process.cwd()
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
  writeRow(
    dbPath,
    {
      id: event.tool_use_id ?? null,
      parentSessionId: event.session_id ?? null,
      parentTurnKey: event.turn_id ?? null,
      agentType: input.subagent_type ?? null,
      description: input.description ?? null,
      background: input.run_in_background === true ? 1 : 0,
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
