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
 *   agentDir lookup (first hit wins):
 *     1. SWITCHROOM_AGENT_DIR env var (explicit override, mainly used in tests)
 *     2. TELEGRAM_STATE_DIR with `/telegram` suffix stripped — the canonical
 *        env var start.sh exports on every switchroom agent. See the
 *        sibling pretool hook docblock for why this lookup matters (without
 *        it the hook used to write to a registry.db nobody read).
 *     3. process.cwd() (legacy fallback for ad-hoc invocations).
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
        // Concurrency: this hook writes the registry from a separate process
        // that contends with the gateway's subagent-watcher. Without a
        // busy_timeout the write fails immediately with SQLITE_BUSY
        // ("database is locked") when several sub-agents dispatch at once.
        // Wait-and-retry instead (per-connection PRAGMA).
        try { d.exec('PRAGMA busy_timeout = 5000') } catch { /* best-effort */ }
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

/**
 * Extract the full text of a PostToolUse tool_response (untruncated).
 * Mirrors extractResultSummary's shape handling but returns the whole
 * string so callers can pattern-match on it.
 */
function toolResponseText(toolResponse) {
  if (!toolResponse) return ''
  if (Array.isArray(toolResponse.content)) {
    return toolResponse.content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  if (typeof toolResponse.result === 'string') return toolResponse.result
  if (typeof toolResponse.output === 'string') return toolResponse.output
  if (typeof toolResponse === 'string') return toolResponse
  return ''
}

/**
 * Detect Claude Code's async-launch ACK in a PostToolUse tool_response.
 *
 * A `run_in_background` Agent/Task returns IMMEDIATELY with an
 * acknowledgement ("Async agent launched successfully … The agent is working
 * in the background …"), NOT the sub-agent's final result. This ACK is the
 * authoritative, uniform signal that the dispatch was a background one — it is
 * present even when Claude Code omits `run_in_background` from the tool_input
 * the PREtool hook sees (observed on claude-code 2.1.159: a worker whose
 * tool_input lacked the flag still returned this ACK and ran ~3 min past the
 * parent turn, so the pretool recorded background=0 and the worker card never
 * fired). We therefore trust this ACK over the pretool's input-derived flag.
 *
 * Three tiers, widest-stable-signal last, so a Claude Code wording change has
 * to defeat ALL of them before promotion silently regresses (#2084):
 *
 *   1. The canonical ACK phrase "async agent launched" — the exact current
 *      claude-code wording. A foreground report is extremely unlikely to
 *      contain it.
 *   2. Structural backstop: the background-status phrase "working in the
 *      background" + an agentId token. Survives a reworded launch verb.
 *   3. Drift-tolerant STRUCTURAL match: `agentId: <stem>` as a bare identifier
 *      on its OWN LINE — the functional, most wording-stable core of the ACK
 *      (the parent references the worker by this id). claude-code emits it on
 *      its own line; a foreground report that merely names an agent id embeds
 *      it mid-sentence ("the agentId is X is managing …"), which the own-line
 *      anchor rejects. Paired with a launch/background/async/dispatch/notify
 *      context word so it can't trip on a foreground report that happens to
 *      print a bare id on its own line. This survives BOTH prose phrases
 *      (tiers 1 & 2) rewording in the same bump.
 *
 * If all three miss, promotion degrades to the pretool's input-derived flag —
 * still correct whenever the model DID pass run_in_background, never worse than
 * before. The exact ACK contract is pinned by drift-variant tests in
 * subagent-tracker-hooks.test.ts ("async-launch ACK contract"); when bumping
 * the pinned claude-code version, re-verify the live ACK against those.
 *
 * Known residual (accepted): an ACK reword that BOTH drops the own-line id
 * form AND removes every context word degrades to the pretool flag; a
 * foreground report that prints a bare `agentId: <id>` on its own line next to
 * a launch/background word would false-promote. Both are narrow; the own-line
 * + context-word conjunction is the balance point. Re-verify on a pin bump.
 *
 * ACK contract verified against claude-code 2.1.156 (the fleet pin):
 *   "Async agent launched successfully.\n
 *    agentId: <stem>\n
 *    The agent is working in the background. You will be notified
 *    automatically when it completes."
 */
function isAsyncLaunchAck(toolResponse) {
  const t = toolResponseText(toolResponse).toLowerCase()
  if (!t) return false
  if (t.includes('async agent launched')) return true
  if (t.includes('working in the background') && t.includes('agentid')) return true
  // Tier 3 — own-line `agentid: <bare-stem>` + a context word (leading \b so
  // reworded/derived forms like "launched"/"dispatching"/"notified" still
  // count). `m` flag anchors $ to line end so a mid-sentence id is rejected.
  if (/agentid:\s*[a-z0-9][\w-]*\s*$/m.test(t) && /\b(background|launch|dispatch|async|notif)/.test(t)) {
    return true
  }
  return false
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
 * Mis-recorded background (DB background = 0 but `asyncLaunch` is true):
 * Claude Code returned the async-launch ACK even though run_in_background was
 * absent from the tool_input the pretool saw, so the row was wrongly recorded
 * foreground. PROMOTE it to background = 1 and take the background path — do
 * NOT terminalize, because the worker is still running (the ACK is a launch,
 * not a completion). This is the authoritative correction that makes the
 * gateway's worker-feed card fire (onProgress re-reads `background` per tick)
 * AND prevents the premature `completed` the foreground path would write.
 *
 * The done(err | null) callback is invoked after all DB operations complete.
 */
function updateRow(dbPath, { id, status, resultSummary, now, asyncLaunch }, done) {
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

  // Promote a mis-recorded foreground row to background (sets background = 1),
  // bumping activity but NOT terminalizing — same shape as BACKGROUND_SQL.
  const PROMOTE_BACKGROUND_SQL = `
    UPDATE subagents
    SET background = 1, result_summary = COALESCE(?, result_summary), last_activity_at = ?
    WHERE id = ?
      AND status NOT IN ('completed', 'failed')
  `

  // Snapshot all values used inside closures before setImmediate fires.
  const snapDbPath = dbPath
  const snapId = id
  const snapStatus = status
  const snapResultSummary = resultSummary
  const snapNow = now
  const snapAsyncLaunch = asyncLaunch === true

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
        } else if (snapAsyncLaunch) {
          db.prepare(PROMOTE_BACKGROUND_SQL).run(snapResultSummary, snapNow, snapId)
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
    } else if (snapAsyncLaunch) {
      spawnSql(
        snapDbPath,
        fillPlaceholders(PROMOTE_BACKGROUND_SQL.trim(), [snapResultSummary, snapNow, snapId]),
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
// Foreground handback nudge (conversational-pacing beat 4)
// ---------------------------------------------------------------------------

/**
 * Synchronously read the `background` flag for a subagent row. Returns
 * 0 (foreground), 1 (background), or null (unknown — sync SQLite
 * unavailable, or row not found). Used to gate the foreground handback
 * nudge: a background sub-agent's PostToolUse fires on the ~10s launch
 * ACK, not on completion, so it must NOT be nudged here (the gateway's
 * subagent-watcher handles the background handback via inject_inbound).
 */
function readBackgroundFlagSync(dbPath, id) {
  const DatabaseSync = resolveSyncSqlite()
  if (DatabaseSync == null) return null
  try {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('SELECT background FROM subagents WHERE id = ?').get(id)
    db.close()
    if (row == null) return null
    return row.background === 1 ? 1 : 0
  } catch {
    return null
  }
}

/**
 * Emit a PostToolUse `additionalContext` nudge. For a foreground
 * sub-agent this fires at real completion, mid-parent-turn, with the
 * result already in the parent's context — the nudge steers the parent
 * to synthesise a user-facing handback (beat 4) instead of dumping the
 * raw report or moving on silently. Same channel `sandbox-hint-posttool`
 * uses; capped well under Claude Code's 10k hook-output limit.
 */
function emitForegroundHandbackNudge() {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        'A sub-agent you dispatched just returned. Beat 4 — the handback: '
        + 'before you move on, send the user a reply in your own voice that '
        + 'synthesises what the sub-agent found and your next step. Do not '
        + 'paste its raw report and do not go silent.',
    },
  }
  try {
    process.stdout.write(JSON.stringify(out) + '\n')
  } catch {
    /* stdout write failures never block the tool flow */
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
  // depending on version. The matching session-tail / progress-card /
  // tool-label code paths already recognize both. See pretool hook for
  // detail.
  if (event.tool_name !== 'Agent' && event.tool_name !== 'Task') process.exit(0)

  const id = event.tool_use_id ?? null
  if (!id) process.exit(0)

  // Same agent-dir resolution as the pretool hook (Bug 2 fix). Without
  // the TELEGRAM_STATE_DIR derivation the posttool would write the
  // `ended_at` row to a registry.db nobody reads, even though the row
  // was originally inserted by the pretool hook that DID write to the
  // correct DB (after this PR). Keep the two hooks in lock-step.
  const stateDir = process.env.TELEGRAM_STATE_DIR
  const derivedFromStateDir = stateDir && stateDir.endsWith('/telegram')
    ? stateDir.slice(0, -'/telegram'.length)
    : null
  const agentDir = process.env.SWITCHROOM_AGENT_DIR
    ?? derivedFromStateDir
    ?? process.cwd()
  const dbPath = join(agentDir, 'telegram', 'registry.db')

  // If DB doesn't exist yet, nothing to update
  if (!existsSync(dbPath)) process.exit(0)

  const toolResponse = event.tool_response ?? null

  // Authoritative background signal: Claude Code's async-launch ACK. Trusted
  // over the pretool's input-derived flag (which is missing whenever the
  // model/runtime omits run_in_background from tool_input — see
  // isAsyncLaunchAck). Gates both the nudge below and the promote path in
  // updateRow.
  const asyncLaunch = isAsyncLaunchAck(toolResponse)

  // conversational-pacing beat 4 (foreground half). A foreground
  // sub-agent's PostToolUse fires at real completion, mid-parent-turn,
  // with its result in tool_response — nudge the parent to synthesise a
  // user-facing handback. Background sub-agents are gated OUT: their
  // PostToolUse fires on the launch ACK (BACKGROUND_SQL leaves status
  // untouched for that reason), and their handback is driven by the
  // gateway's subagent-watcher onFinish path instead. A launch ACK is also
  // gated out via `!asyncLaunch` — at this point the DB flag may still read 0
  // (updateRow promotes it on the next tick), so the ACK is the reliable
  // tell. Fail-silent: an unknown background flag (null) skips the nudge.
  if (
    process.env.SWITCHROOM_SUBAGENT_HANDBACK !== '0'
    && !asyncLaunch
    && detectStatus(toolResponse) === 'completed'
    && readBackgroundFlagSync(dbPath, id) === 0
  ) {
    emitForegroundHandbackNudge()
  }

  updateRow(
    dbPath,
    {
      id,
      status: detectStatus(toolResponse),
      resultSummary: extractResultSummary(toolResponse),
      now: Date.now(),
      asyncLaunch,
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
