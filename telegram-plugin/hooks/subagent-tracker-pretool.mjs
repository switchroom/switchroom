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
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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

function execSql(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql], { timeout: 5000 })
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

function writeRow(dbPath, { id, parentSessionId, parentTurnKey, agentType, description, background, now }) {
  const INSERT_SQL = `
    INSERT OR IGNORE INTO subagents
      (id, parent_session_id, parent_turn_key, agent_type, description,
       background, started_at, last_activity_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
  `
  const params = [id, parentSessionId, parentTurnKey, agentType, description, background, now, now]

  // Try Node 22+ built-in sqlite first (synchronous API)
  const [major] = process.versions.node.split('.').map(Number)
  if (major >= 22) {
    try {
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(dbPath)
      db.exec(SCHEMA_SQL)
      // Migrate older DBs that pre-date jsonl_agent_id.
      const hasJsonlCol = db.prepare(MIGRATE_JSONL_COL_SQL).get()
      if (hasJsonlCol == null) {
        db.exec('ALTER TABLE subagents ADD COLUMN jsonl_agent_id TEXT')
        db.exec('CREATE INDEX IF NOT EXISTS subagents_jsonl_id ON subagents(jsonl_agent_id)')
      }
      db.prepare(INSERT_SQL).run(...params)
      db.close()
      return
    } catch {
      // Fall through to sqlite3 CLI
    }
  }

  // sqlite3 CLI fallback
  execSql(dbPath, SCHEMA_SQL.replace(/\n\s+/g, ' '))
  execSql(dbPath, fillPlaceholders(INSERT_SQL.trim(), params))
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

  // Only care about Agent tool calls
  if (event.tool_name !== 'Agent') process.exit(0)

  const agentDir = process.env.SWITCHROOM_AGENT_DIR ?? process.cwd()
  const telegramDir = join(agentDir, 'telegram')
  const dbPath = join(telegramDir, 'registry.db')

  try {
    if (!existsSync(telegramDir)) {
      mkdirSync(telegramDir, { recursive: true })
    }

    const input = event.tool_input ?? {}
    writeRow(dbPath, {
      id: event.tool_use_id ?? null,
      parentSessionId: event.session_id ?? null,
      parentTurnKey: event.turn_id ?? null,
      agentType: input.subagent_type ?? null,
      description: input.description ?? null,
      background: input.run_in_background === true ? 1 : 0,
      now: Date.now(),
    })
  } catch (err) {
    process.stderr.write(`[subagent-tracker-pretool] DB error: ${err?.message ?? err}\n`)
  }

  process.exit(0)
}

main()
