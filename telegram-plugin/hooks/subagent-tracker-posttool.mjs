#!/usr/bin/env node
/**
 * PostToolUse hook — marks subagent rows completed or failed in the registry DB.
 *
 * Claude Code PostToolUse protocol (v1):
 *   Input:  JSON on stdin — { tool_name, tool_use_id, tool_response, ... }
 *   Output: exit 0 (we never block here).
 *
 * Gates to tool_name === 'Agent'; exits 0 immediately for everything else.
 * DB writes are fire-and-forget: failures are logged to stderr but never
 * block the tool response.
 *
 * DB location: <agentDir>/telegram/registry.db
 *   agentDir = SWITCHROOM_AGENT_DIR env var, falling back to process.cwd()
 *
 * Performance: the actual DB write is deferred via setImmediate (Node 22+
 * node:sqlite path) or non-blocking spawn (CLI fallback) so the hook returns
 * to Claude Code as fast as possible. The process still exits only after the
 * write completes, so observers that wait for process exit (e.g. spawnSync in
 * tests) see a consistent DB state.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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
 * `DatabaseSync(path)` API. See subagent-tracker-pretool.mjs for the
 * full doc — kept in lockstep across both hook scripts.
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

/**
 * Run a SELECT via the sqlite3 CLI (non-blocking) and return trimmed stdout.
 * Calls cb(error | null, stdout | null).
 */
function spawnSqlRead(dbPath, sql, cb) {
  const child = spawn('sqlite3', [dbPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('close', (code) => {
    if (code !== 0) {
      cb(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`), null)
    } else {
      cb(null, stdout.trim())
    }
  })
  child.on('error', (err) => cb(err, null))
}

// ---------------------------------------------------------------------------
// Status detection
// ---------------------------------------------------------------------------

function detectStatus(toolResponse) {
  if (!toolResponse) return 'completed'
  if (toolResponse.is_error === true) return 'failed'
  if (toolResponse.error != null) return 'failed'
  // Claude Code wraps sub-agent output in { type: 'text', text: '...' } arrays;
  // a top-level "error" key or is_error flag means the tool itself failed.
  return 'completed'
}

function extractResultSummary(toolResponse) {
  if (!toolResponse) return null
  // Claude Code's Agent tool wraps text in `content: [{ type: 'text', text }]`.
  // Try that first since it's the actual production shape.
  if (Array.isArray(toolResponse.content)) {
    const textPart = toolResponse.content.find(
      (c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string',
    )
    if (textPart) return textPart.text.slice(0, 200) || null
  }
  // Older / alternate shapes.
  const raw =
    toolResponse.result ??
    toolResponse.output ??
    (typeof toolResponse === 'string' ? toolResponse : null)
  if (raw == null) return null
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return str.slice(0, 200) || null
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

/**
 * Apply posttool DB updates for a subagent.
 *
 * Foreground agents (background = 0): set status, ended_at, result_summary,
 * and last_activity_at — PostToolUse fires on actual completion.
 *
 * Background agents (background = 1): PostToolUse fires on the launch ACK
 * (~10 s), NOT on actual completion. Only bump last_activity_at and capture
 * result_summary; leave status/ended_at alone so the watcher's
 * recordSubagentEnd (driven by the JSONL turn_end event) remains the
 * authoritative end-of-life signal.
 *
 * The done(err | null) callback is invoked after all DB operations complete.
 */
function updateRow(dbPath, { id, status, resultSummary, now }, done) {
  // SQL to read the background flag so we can choose the right update path.
  const SELECT_SQL = `SELECT background FROM subagents WHERE id = ?`

  // Foreground update: set terminal status + ended_at.
  const FOREGROUND_SQL = `
    UPDATE subagents
    SET ended_at = ?, status = ?, result_summary = COALESCE(?, result_summary), last_activity_at = ?
    WHERE id = ?
      AND status NOT IN ('completed', 'failed')
  `

  // Background update: bump activity only; do NOT touch status or ended_at.
  const BACKGROUND_SQL = `
    UPDATE subagents
    SET result_summary = COALESCE(?, result_summary), last_activity_at = ?
    WHERE id = ?
      AND status NOT IN ('completed', 'failed')
  `

  // Snapshot all values used inside closures before setImmediate fires.
  const snapDbPath = dbPath
  const snapId = id
  const snapStatus = status
  const snapResultSummary = resultSummary
  const snapNow = now

  // Resolve a synchronous SQLite binding (node:sqlite under Node 22+,
  // bun:sqlite under bun, else null → CLI fallback). See helper docs.
  const DatabaseSync = resolveSyncSqlite()

  if (DatabaseSync != null) {
    // Sync SQLite binding available — defer the write to the next tick
    // so the hook returns to Claude Code as fast as possible.
    const SnapDatabaseSync = DatabaseSync
    setImmediate(() => {
      try {
        const db = new SnapDatabaseSync(snapDbPath)
        const row = db.prepare(SELECT_SQL).get(snapId)
        const isBackground = row != null && row.background === 1
        if (isBackground) {
          db.prepare(BACKGROUND_SQL).run(snapResultSummary, snapNow, snapId)
        } else {
          db.prepare(FOREGROUND_SQL).run(snapNow, snapStatus, snapResultSummary, snapNow, snapId)
        }
        db.close()
        done(null)
      } catch (err) {
        done(err)
      }
    })
    return
  }

  // sqlite3 CLI fallback — SELECT then conditional UPDATE, both non-blocking.
  spawnSqlRead(snapDbPath, fillPlaceholders(SELECT_SQL, [snapId]), (err, bgResult) => {
    if (err) { done(err); return }
    // sqlite3 outputs "0" or "1" (or empty if row not found).
    const isBackground = bgResult === '1'
    if (isBackground) {
      spawnSql(
        snapDbPath,
        fillPlaceholders(BACKGROUND_SQL.trim(), [snapResultSummary, snapNow, snapId]),
        done,
      )
    } else {
      spawnSql(
        snapDbPath,
        fillPlaceholders(FOREGROUND_SQL.trim(), [snapNow, snapStatus, snapResultSummary, snapNow, snapId]),
        done,
      )
    }
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
  // depending on version. The matching session-tail / progress-card /
  // tool-label code paths already recognize both. See pretool hook for
  // detail.
  if (event.tool_name !== 'Agent' && event.tool_name !== 'Task') process.exit(0)

  const id = event.tool_use_id ?? null
  if (!id) process.exit(0)

  const agentDir = process.env.SWITCHROOM_AGENT_DIR ?? process.cwd()
  const dbPath = join(agentDir, 'telegram', 'registry.db')

  // If DB doesn't exist yet, nothing to update
  if (!existsSync(dbPath)) process.exit(0)

  const toolResponse = event.tool_response ?? null
  updateRow(
    dbPath,
    {
      id,
      status: detectStatus(toolResponse),
      resultSummary: extractResultSummary(toolResponse),
      now: Date.now(),
    },
    (err) => {
      if (err) {
        process.stderr.write(`[subagent-tracker-posttool] DB error: ${err?.message ?? err}\n`)
        process.exit(1)
      }
      process.exit(0)
    },
  )
}

main()
