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

/**
 * Run a SELECT via the sqlite3 CLI (non-blocking) and return trimmed stdout.
 * Calls cb(error | null, stdout | null).
 */
function spawnSqlRead(dbPath, sql, cb) {
  // `-readonly`: this hook is a FOREIGN process against a DB the gateway holds
  // open. The sqlite3 CLI defaults to read-write, and a read-write handle that
  // closes as the LAST connection checkpoints and UNLINKS the `-wal`/`-shm`
  // sidecars, orphaning the gateway's mapped fds (#4595). This path only SELECTs.
  const child = spawn('sqlite3', ['-readonly', dbPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] })
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

/**
 * Bare-string dispatch failure. When the Agent/Task dispatch never produced a
 * worker at all, Claude Code hands the hook a BARE STRING and there is no
 * `is_error` flag to read — the whole tool_response IS the message. Every
 * bare-string result observed across the fleet (54 of 2692 Agent/Task
 * dispatches scanned in every agent's claude-code transcript dir) is one of:
 *
 *   52x  "Error: Cannot create agent worktree: not in a git repository…"
 *    1x  "Error: Agent type 'code-reviewer' not found. Available agents: …"
 *    1x  "InputValidationError: [\n  { \"expected\": \"string\", … } ]"
 *
 * so the probe must match a `<Prefix>Error` head, not just a literal `Error:`
 * — the plain-`Error:` form the pre-review patch used recorded that
 * InputValidationError dispatch as a SUCCESSFUL sub-agent completion, with the
 * validation error stored as its result_summary. Nothing else terminalizes
 * those rows (no worker exists, so the watcher never sees one), so getting the
 * status right here is the only chance.
 */
const BARE_DISPATCH_ERROR_RE = /^\s*[A-Za-z]*Error\b/

/**
 * Terminal status for a response already classified as KIND_COMPLETION.
 *
 * Signals, in precedence order:
 *   1. `is_error` / `error` — the structured failure flags.
 *   2. `status` on a structured Agent envelope (see structuredTerminalStatus).
 *      Machine-readable: `completed` is a success, anything else in the
 *      terminal set is a failure.
 *   3. A bare-string dispatch failure (BARE_DISPATCH_ERROR_RE).
 *
 * The bare-string probe is deliberately scoped to `typeof toolResponse ===
 * 'string'` rather than run over toolResponseText(): a worker's own report
 * (a `content` array) that merely OPENS with "Error: I could not reproduce…"
 * is a report ABOUT an error, not a failed dispatch, and must stay
 * `completed`. The pre-review patch ran the probe over the flattened text and
 * mislabelled exactly that case.
 */
function detectStatus(toolResponse) {
  if (!toolResponse) return 'completed'
  if (toolResponse.is_error === true) return 'failed'
  if (toolResponse.error != null) return 'failed'
  const structured = structuredTerminalStatus(toolResponse)
  if (structured != null) return structured === 'completed' ? 'completed' : 'failed'
  if (typeof toolResponse === 'string' && BARE_DISPATCH_ERROR_RE.test(toolResponse)) return 'failed'
  return 'completed'
}

function extractResultSummary(toolResponse) {
  if (!toolResponse) return null
  // Claude Code's Agent tool wraps text in `content: [{ type: 'text', text }]`,
  // and some versions hand the hook that content array unwrapped.
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : (Array.isArray(toolResponse.content) ? toolResponse.content : null)
  if (blocks != null) {
    const textPart = blocks.find(
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
  if (typeof toolResponse === 'string') return toolResponse
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : (Array.isArray(toolResponse.content) ? toolResponse.content : null)
  if (blocks != null) {
    return blocks
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  if (typeof toolResponse.result === 'string') return toolResponse.result
  if (typeof toolResponse.output === 'string') return toolResponse.output
  return ''
}

/**
 * DETERMINISTIC async-launch signal (#3667).
 *
 * Claude Code's Agent/Task tool hands PostToolUse a STRUCTURED result object
 * for an async dispatch — verified verbatim against claude-code 2.1.219 by
 * reading `toolUseResult` out of a live parent transcript:
 *
 *   { isAsync: true, status: 'async_launched', agentId: '<stem>',
 *     description: '…', resolvedModel: '…', prompt: '…',
 *     outputFile: '…', canReadOutputFile: true }
 *
 * There is NO `content` array and NO `result`/`output` string on it, so the
 * prose tiers in isAsyncLaunchAck() below saw an EMPTY string and returned
 * false for every real dispatch — which is exactly how ~95% of registry rows
 * came to be terminalized ~0.2s after launch by the foreground path (#3667).
 * Prose matching was never reached in production; these two machine-readable
 * fields are the real signal, so they are checked FIRST and the prose tiers
 * are demoted to a backstop.
 */
function isStructuredAsyncLaunch(toolResponse) {
  if (toolResponse == null || typeof toolResponse !== 'object') return false
  if (Array.isArray(toolResponse)) return false
  if (toolResponse.status === 'async_launched') return true
  // `isAsync` alone says "this dispatch is asynchronous", not "it is still
  // running". If a future claude-code reuses the same envelope to report an
  // async agent's OUTCOME, an explicitly terminal `status` wins — the row is
  // then classified KIND_COMPLETION by structuredTerminalStatus below, so the
  // hook can still terminalize it. A non-terminal / absent status (queued,
  // running, in_progress, none at all) means "still in flight" → launch.
  if (toolResponse.isAsync === true) return structuredTerminalStatus(toolResponse) == null
  return false
}

/**
 * The terminal statuses claude-code's Agent envelope uses for an end-of-life
 * result. Single source of truth: read by isStructuredAsyncLaunch (to refuse
 * calling a finished dispatch a launch), classifyAgentResponse (to call it a
 * completion) and detectStatus (to pick completed vs failed). Keeping one set
 * is what stops those three from drifting into disagreement.
 */
const TERMINAL_AGENT_STATUSES = new Set([
  'completed', 'failed', 'error', 'cancelled', 'canceled',
])

/**
 * DETERMINISTIC completion signal — the mirror of isStructuredAsyncLaunch.
 *
 * The synchronous-completion envelope is machine-readable too. Captured from
 * production transcripts (agent `marko`, three real sync dispatches of 164s /
 * 387s / 490s):
 *
 *   { status: 'completed', agentId, agentType, resolvedModel, prompt,
 *     content: [{ type: 'text', text: '…' }], totalDurationMs, totalTokens,
 *     totalToolUseCount, usage, toolStats }
 *
 * Reading `status` STRUCTURALLY, ahead of the prose ACK backstop, matters for
 * the same reason the launch side does: isAsyncLaunchAck() pattern-matches the
 * flattened response TEXT, and on a real completion that text is the worker's
 * own report. A worker whose report happens to quote the ACK ("Async agent
 * launched successfully"), or to print `agentId: <id>` on its own line near
 * the word "background" — i.e. any worker reporting on sub-agent dispatch,
 * including one reviewing this hook — was classified KIND_ASYNC_LAUNCH,
 * promoted to background, and never terminalized by the hook. The structured
 * status settles it before prose ever gets a vote.
 *
 * Returns the lowercased terminal status, or null when the response carries no
 * machine-readable terminal status (which includes `async_launched`).
 */
function structuredTerminalStatus(toolResponse) {
  if (toolResponse == null || typeof toolResponse !== 'object') return null
  if (Array.isArray(toolResponse)) return null
  if (typeof toolResponse.status !== 'string') return null
  const s = toolResponse.status.toLowerCase()
  return TERMINAL_AGENT_STATUSES.has(s) ? s : null
}

/**
 * Detect Claude Code's async-launch ACK PROSE in a PostToolUse tool_response.
 *
 * Backstop only — see isStructuredAsyncLaunch() for the primary, structural
 * signal. Retained because a claude-code version that drops the structured
 * fields but still returns the ACK text must not regress to terminalizing.
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
 * If all three miss, classifyAgentResponse falls through to the completion /
 * unknown split — and an unrecognised shape is NOT terminalized, so a total
 * prose miss can no longer produce the #3667 "completed 0.2s after launch"
 * row. The exact ACK contract is pinned by drift-variant tests in
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
// Response classification (#3667)
// ---------------------------------------------------------------------------

/** The dispatch was ACKed, not finished — the worker is still running. */
const KIND_ASYNC_LAUNCH = 'async_launch'
/** A real, recognisable end-of-life result — safe to terminalize the row. */
const KIND_COMPLETION = 'completion'
/** Shape we do not recognise — we know NOTHING about liveness. */
const KIND_UNKNOWN = 'unknown'

/**
 * Does this tool_response carry a recognisable COMPLETED sub-agent result?
 *
 * Deliberately an allowlist of known-real shapes, never a fallthrough. The
 * bug this replaces (#3667) came from the opposite posture: anything the hook
 * failed to recognise was treated as a completion (`detectStatus` returned
 * 'completed' for a null / unknown response), so one unrecognised payload
 * shape silently poisoned `status` + `ended_at` on nearly every row.
 */
function hasCompletionShape(toolResponse) {
  if (toolResponse == null) return false
  if (typeof toolResponse === 'string') return toolResponse.length > 0
  if (typeof toolResponse !== 'object') return false
  if (toolResponse.is_error === true || toolResponse.error != null) return true
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : (Array.isArray(toolResponse.content) ? toolResponse.content : null)
  if (blocks != null) {
    return blocks.some(
      (c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string',
    )
  }
  if (typeof toolResponse.result === 'string') return true
  if (typeof toolResponse.output === 'string') return true
  return false
}

/**
 * Classify a PostToolUse tool_response for an Agent/Task dispatch.
 *
 * The whole point of the three-way split is that only KIND_COMPLETION is
 * allowed to write a terminal row. KIND_ASYNC_LAUNCH and KIND_UNKNOWN both
 * promote to background and bump activity only, leaving the watcher's
 * JSONL-driven `recordSubagentEnd` (turn_end / stall synthesis) as the
 * authoritative end-of-life signal, with `reapStuckRunningRows` behind it.
 * Failing to terminalize here is recoverable; terminalizing a live worker is
 * not — it makes the `wk:<agentId>` reaper unpin a running worker's card and
 * turns every duration in the registry into fiction.
 *
 * Order matters. Both STRUCTURAL signals are read before the prose backstop,
 * because the prose tiers match the flattened response TEXT and on a real
 * completion that text is the worker's own report — see
 * structuredTerminalStatus() for the self-referential failure that causes.
 *
 * KIND_UNKNOWN takes the same DB path as a launch (background = 1, no terminal
 * write) rather than staying background = 0. That is NOT a guess about
 * liveness — it is what keeps the row inside the safety net. `background = 0`
 * is a contract, not a free-form flag: `reapStuckRunningRows` deliberately
 * excludes foreground rows *because* "their lifecycle goes through PostToolUse
 * which writes `completed` directly" (subagents-schema.ts). A row this hook
 * declines to terminalize while leaving background = 0 satisfies neither
 * owner — PostToolUse won't end it and the reaper won't sweep it — so under a
 * claude-code shape drift EVERY row would sit `running` forever, unbounded and
 * silent. Routed through the promote path instead, the worst case is bounded:
 * the watcher ends it if the JSONL links, and the 1h reaper otherwise moves it
 * to `stalled` with a reason recorded in result_summary.
 */
function classifyAgentResponse(toolResponse) {
  if (isStructuredAsyncLaunch(toolResponse)) return KIND_ASYNC_LAUNCH
  if (structuredTerminalStatus(toolResponse) != null) return KIND_COMPLETION
  if (isAsyncLaunchAck(toolResponse)) return KIND_ASYNC_LAUNCH
  if (hasCompletionShape(toolResponse)) return KIND_COMPLETION
  return KIND_UNKNOWN
}

/**
 * Choose the UPDATE to apply for a (background-flag, kind) pair.
 *
 * SINGLE source of truth, shared by the node:sqlite and sqlite3-CLI branches
 * of updateRow(). Those two used to carry hand-duplicated conditionals that
 * disagreed on their default arm: the sync branch fell through to the
 * non-terminal update while the CLI branch fell through to the TERMINAL one,
 * so any `kind` neither branch enumerated (a future fourth kind, or a caller
 * that omitted the field) would silently terminalize a live row on exactly one
 * of the two paths — the same class of failure as #3667, reachable only on the
 * fallback runtime where nobody would look.
 *
 * Returns 'foreground' (terminal write), 'promote' (set background = 1,
 * activity bump only) or 'background' (activity bump only). Anything not
 * explicitly recognised as a completion fails SAFE — non-terminal.
 */
function chooseUpdate(isBackground, kind) {
  if (isBackground) return 'background'
  if (kind === KIND_COMPLETION) return 'foreground'
  return 'promote'
}

/**
 * One-line description of an unrecognised tool_response, for the stderr
 * warning. Emits only the SHAPE (typeof + top-level key names) — never
 * values, because the async payload embeds the full dispatch prompt and this
 * line lands in journald.
 */
function describeShape(toolResponse) {
  if (toolResponse == null) return 'null'
  if (Array.isArray(toolResponse)) return `array(${toolResponse.length})`
  if (typeof toolResponse !== 'object') return typeof toolResponse
  return `object{${Object.keys(toolResponse).slice(0, 12).join(',')}}`
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
 * (measured 78-880 ms in production), NOT on actual completion. Only bump
 * last_activity_at and capture result_summary; leave status/ended_at alone
 * so the watcher's
 * recordSubagentEnd (driven by the JSONL turn_end event) remains the
 * authoritative end-of-life signal.
 *
 * Mis-recorded background (DB background = 0 but `kind` is KIND_ASYNC_LAUNCH):
 * Claude Code returned the async-launch ACK even though run_in_background was
 * absent from the tool_input the pretool saw — which on claude-code 2.1.219 is
 * EVERY dispatch, since the runtime auto-backgrounds Agent calls and never
 * echoes the flag. PROMOTE the row to background = 1 and take the background
 * path — do NOT terminalize, because the worker is still running (the ACK is a
 * launch, not a completion). This is the authoritative correction that makes
 * the gateway's worker-feed card fire (onProgress re-reads `background` per
 * tick) AND prevents the premature `completed` the foreground path would write.
 *
 * Unrecognised shape (KIND_UNKNOWN): same path as a launch — promote to
 * background = 1, bump activity, write no terminal status. We cannot tell a
 * launch from a completion, so we decline to guess about the OUTCOME, but we
 * must still hand the row to an owner: background = 0 means "PostToolUse ends
 * this row", which is precisely what we are declining to do, and it is the
 * flag `reapStuckRunningRows` filters on. See classifyAgentResponse (#3667).
 *
 * Both runtime branches below route through chooseUpdate() so they cannot
 * disagree.
 *
 * The done(err | null) callback is invoked after all DB operations complete.
 */
function updateRow(dbPath, { id, status, resultSummary, now, kind }, done) {
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
  const snapKind = kind

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
        // Concurrency: per-connection busy_timeout so this hook's writes
        // wait-and-retry instead of failing with SQLITE_BUSY under concurrent
        // sub-agent dispatch. Set on the real open so BOTH the node:sqlite
        // (production) and bun:sqlite branches are armed (#2535 review).
        try { db.exec('PRAGMA busy_timeout = 5000') } catch { /* best-effort */ }
        const row = db.prepare(SELECT_SQL).get(snapId)
        const isBackground = row != null && row.background === 1
        const choice = chooseUpdate(isBackground, snapKind)
        if (choice === 'foreground') {
          db.prepare(FOREGROUND_SQL).run(snapNow, snapStatus, snapResultSummary, snapNow, snapId)
        } else if (choice === 'promote') {
          db.prepare(PROMOTE_BACKGROUND_SQL).run(snapResultSummary, snapNow, snapId)
        } else {
          db.prepare(BACKGROUND_SQL).run(snapResultSummary, snapNow, snapId)
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
    const choice = chooseUpdate(isBackground, snapKind)
    if (choice === 'foreground') {
      spawnSql(
        snapDbPath,
        fillPlaceholders(FOREGROUND_SQL.trim(), [snapNow, snapStatus, snapResultSummary, snapNow, snapId]),
        done,
      )
    } else if (choice === 'promote') {
      spawnSql(
        snapDbPath,
        fillPlaceholders(PROMOTE_BACKGROUND_SQL.trim(), [snapResultSummary, snapNow, snapId]),
        done,
      )
    } else {
      spawnSql(
        snapDbPath,
        fillPlaceholders(BACKGROUND_SQL.trim(), [snapResultSummary, snapNow, snapId]),
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
 * nudge: a background sub-agent's PostToolUse fires on the sub-second launch
 * ACK, not on completion, so it must NOT be nudged here (the gateway's
 * subagent-watcher handles the background handback via inject_inbound).
 */
function readBackgroundFlagSync(dbPath, id) {
  const DatabaseSync = resolveSyncSqlite()
  if (DatabaseSync == null) return null
  try {
    // READ-ONLY: this hook is a FOREIGN process against a DB the gateway holds
    // open. A read-write handle that closes as the LAST connection checkpoints
    // and UNLINKS the `-wal`/`-shm` sidecars, orphaning the gateway's mapped
    // fds — after which its writes silently land in deleted inodes (#4595).
    // This function only ever SELECTs.
    const db = new DatabaseSync(dbPath, { readOnly: true })
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

  // A well-formed JSON body that is not an object still has to be rejected
  // BEFORE any property read. `JSON.parse('null')` succeeds and returns null,
  // and `null.tool_name` is an uncaught TypeError — which in production means
  // a non-zero hook exit, which means bin/run-hook.sh files a red issue card
  // for a payload the hook was always going to ignore. (Pre-existing on main;
  // not reachable from claude-code's own protocol, but this hook runs on every
  // PostToolUse across the fleet, so it must not be one bad byte from
  // throwing.)
  if (event == null || typeof event !== 'object') process.exit(0)

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

  // Authoritative classification of what this PostToolUse actually means:
  // an async LAUNCH (worker still running), a real COMPLETION, or an
  // unrecognised shape. Trusted over the pretool's input-derived background
  // flag, which is missing whenever the runtime omits run_in_background from
  // tool_input (claude-code 2.1.219: always). Gates both the nudge below and
  // the update path in updateRow. See classifyAgentResponse (#3667).
  const kind = classifyAgentResponse(toolResponse)
  if (kind === KIND_UNKNOWN) {
    // Best-effort drift breadcrumb, NOT the safety mechanism. In production
    // this hook runs under bin/run-hook.sh, which records an issue only on a
    // NON-ZERO exit and auto-resolves on exit 0 — and claude-code discards a
    // 0-exit hook's stderr — so this line reaches a human only under
    // RUN_HOOK_DEBUG / journald. Exiting non-zero instead would card an error
    // on every dispatch under drift, which is worse. What actually bounds the
    // damage is the classification: an unrecognised shape is never
    // terminalized and is routed to background = 1, so the watcher's
    // recordSubagentEnd or the 1h reaper owns the row's end of life.
    process.stderr.write(
      `[subagent-tracker-posttool] unrecognised Agent tool_response shape `
      + `(${describeShape(toolResponse)}) — leaving row non-terminal; `
      + `watcher owns completion\n`,
    )
  }

  // conversational-pacing beat 4 (foreground half). A foreground
  // sub-agent's PostToolUse fires at real completion, mid-parent-turn,
  // with its result in tool_response — nudge the parent to synthesise a
  // user-facing handback. Background sub-agents are gated OUT: their
  // PostToolUse fires on the launch ACK (BACKGROUND_SQL leaves status
  // untouched for that reason), and their handback is driven by the
  // gateway's subagent-watcher onFinish path instead. A launch ACK — and any
  // unrecognised shape — is gated out via `kind === KIND_COMPLETION`: at this
  // point the DB flag may still read 0 (updateRow promotes it on the next
  // tick), so the classification is the reliable tell, and nudging "synthesise
  // the handback" when nothing has been handed back is exactly the #3667
  // symptom the parent saw. Fail-silent: an unknown background flag (null)
  // skips the nudge.
  if (
    process.env.SWITCHROOM_SUBAGENT_HANDBACK !== '0'
    && kind === KIND_COMPLETION
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
      kind,
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
