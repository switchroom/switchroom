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
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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

function execSql(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql], { timeout: 5000 })
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
 */
function updateRow(dbPath, { id, status, resultSummary, now }) {
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

  const [major] = process.versions.node.split('.').map(Number)
  if (major >= 22) {
    try {
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(dbPath)
      const row = db.prepare(SELECT_SQL).get(id)
      const isBackground = row != null && row.background === 1
      if (isBackground) {
        db.prepare(BACKGROUND_SQL).run(resultSummary, now, id)
      } else {
        db.prepare(FOREGROUND_SQL).run(now, status, resultSummary, now, id)
      }
      db.close()
      return
    } catch {
      // Fall through to sqlite3 CLI
    }
  }

  // sqlite3 CLI fallback — two statements issued sequentially.
  const bgResult = execFileSync('sqlite3', [dbPath, fillPlaceholders(SELECT_SQL, [id])], { timeout: 5000 }).toString().trim()
  // sqlite3 outputs "0" or "1" (or empty if row not found).
  const isBackground = bgResult === '1'
  if (isBackground) {
    execSql(dbPath, fillPlaceholders(BACKGROUND_SQL.trim(), [resultSummary, now, id]))
  } else {
    execSql(dbPath, fillPlaceholders(FOREGROUND_SQL.trim(), [now, status, resultSummary, now, id]))
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

  // Only care about Agent tool calls
  if (event.tool_name !== 'Agent') process.exit(0)

  const id = event.tool_use_id ?? null
  if (!id) process.exit(0)

  const agentDir = process.env.SWITCHROOM_AGENT_DIR ?? process.cwd()
  const dbPath = join(agentDir, 'telegram', 'registry.db')

  // If DB doesn't exist yet, nothing to update
  if (!existsSync(dbPath)) process.exit(0)

  try {
    const toolResponse = event.tool_response ?? null
    updateRow(dbPath, {
      id,
      status: detectStatus(toolResponse),
      resultSummary: extractResultSummary(toolResponse),
      now: Date.now(),
    })
  } catch (err) {
    process.stderr.write(`[subagent-tracker-posttool] DB error: ${err?.message ?? err}\n`)
  }

  process.exit(0)
}

main()
