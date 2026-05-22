/**
 * Background sub-agent visibility — registry + directory watcher.
 *
 * Watches the subagents/ directory under each active session dir for new
 * agent-<id>.jsonl files. For each discovered sub-agent it:
 *   1. Registers it in an in-memory registry.
 *   2. Tails the JSONL to count tool calls and detect turn_end.
 *   3. Emits inline notifications for stall / completion state transitions.
 *
 * Phase 3 of #333: when a sub-agent JSONL's size advances (mtime equivalent),
 * the watcher writes `last_activity_at = <timestamp>` to the matching
 * `subagents` row in the registry DB via `bumpSubagentActivity`. If the row
 * does not yet exist (Phase 2 Pre hook hasn't fired), the update is a no-op
 * and the event is logged — no INSERT here, identity belongs to Phase 2.
 *
 * Sub-agent state is surfaced to the user via the progress card's
 * [Sub-agents · N running] block (progress-card.ts), not a separate pinned
 * card. See issue #142.
 *
 * Architecture notes:
 *   - Option B from the spec: filesystem-driven, no IPC contract.
 *   - The registry is independent of the progress-card driver — it watches
 *     the subagents/ directories directly, not the parent session JSONL.
 *   - Privacy: tool counts + descriptions only — no tool args or file content.
 *
 * Integration: call `startSubagentWatcher(config)` once at gateway startup
 * (after the bot is ready). Call `.stop()` on shutdown.
 */

import {
  existsSync,
  openSync,
  readSync,
  statSync,
  closeSync,
  watch,
  readdirSync,
  readFileSync,
  type FSWatcher,
} from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { projectSubagentLine, sanitizeCwdToProjectName } from './session-tail.js'
import { sanitiseToolArg } from './fleet-state.js'
import { escapeHtml, truncate } from './card-format.js'
import { bumpSubagentActivity, recordSubagentStall, recordSubagentResume, recordSubagentEnd, reapStuckRunningRows } from './registry/subagents-schema.js'
import { touchTurnActiveMarker } from './gateway/turn-active-marker.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal DB interface needed by the watcher for Phase 3 liveness writes.
 * Structurally compatible with the wider `SqliteDatabase` shape used by
 * `registry/subagents-schema.ts` so call sites can pass either without
 * casting. Tests can implement just the subset they need (TypeScript's
 * structural typing handles the rest).
 */
export interface SubagentLivenessDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown
  close(): void
}

export type WorkerState = 'running' | 'done' | 'failed'

export interface WorkerEntry {
  /** Sub-agent JSONL file stem, e.g. "a75d4757a81e7b1f8". */
  readonly agentId: string
  /** File path of the JSONL. */
  readonly filePath: string
  /** Short description — from the sub-agent's first text/narrative line. */
  description: string
  /** Current lifecycle state. */
  state: WorkerState
  readonly dispatchedAt: number
  lastActivityAt: number
  /** Number of tool calls seen so far. */
  toolCount: number
  /** True once a stall notification has been sent (suppresses repeat). */
  stallNotified: boolean
  /**
   * Wall-clock ms when `stallNotified` flipped true. Null until then.
   * Used by the post-stall terminal-synthesis path (RFC §Bug 6) to
   * measure the post-stall window: when `now - stalledAt >=
   * silentStallTerminalMs` the watcher synthesises a terminal
   * transition for the entry. Workers whose JSONL never writes an
   * explicit `sub_agent_turn_end` (e.g. background `Agent` dispatches
   * in some Claude Code versions) would otherwise sit forever in
   * `running` despite their real worker process having exited.
   */
  stalledAt: number | null
  /** True once a completion notification has been sent. */
  completionNotified: boolean
  /**
   * True once the post-stall terminal synthesis has fired so we don't
   * re-synthesise on every poll tick after the silentStallTerminalMs
   * window elapses. Paired with `stalledAt` — when synthesis runs it
   * sets both `state='done'` and this flag.
   */
  stallTerminalSynthesised: boolean
  /** Short summary from last completed tool / narrative, for completion message. */
  lastSummaryLine: string
  /**
   * Full text (capped at SUBAGENT_RESULT_TEXT_MAX) of the most recent
   * `sub_agent_text` emission. For a worker the final such line before
   * `turn_end` is its result summary. Carried to the gateway via
   * `onFinish` so a background sub-agent's result can be handed back to
   * the user (conversational-pacing beat 4). Empty until the first
   * narrative line.
   */
  lastResultText: string
  /**
   * Most recent tool call observed on this sub-agent's JSONL tail —
   * tool name + sanitised arg for fleet-row display (P0 of #662). Null
   * before any `sub_agent_tool_use` event has been seen. Replace-on-write;
   * the renderer only ever shows the latest.
   */
  lastTool: { name: string; sanitisedArg: string } | null
  /**
   * True if the underlying JSONL file existed before the watcher started.
   * Historical entries are tracked for late state transitions but are
   * excluded from the active-workers card — the sub-agent process is long
   * dead, the file is just left over from a prior session.
   */
  historical: boolean
}

export interface SubagentWatcherConfig {
  /**
   * Agent home directory (e.g. `/home/user/.switchroom/agents/klanker`).
   * Used to derive `.claude/projects/<cwd>/` dirs to watch.
   */
  agentDir: string
  /**
   * Agent's working directory — used to compute the project-dir slug the
   * watcher should restrict its enumeration to (Claude Code keys project
   * dirs off the cwd at first launch via `sanitizeCwdToProjectName`).
   * When omitted, the watcher walks every subdir of
   * `<agentDir>/.claude/projects/` (legacy behaviour; see issue #1116
   * for why this is unsafe — a foreign agent's stale project dir under
   * an agent's home pollutes the watcher with phantom registrations).
   */
  agentCwd?: string
  /**
   * Send a fresh (non-edit) Telegram message. For stall / completion
   * state-transition notifications.
   */
  sendNotification: (text: string) => void
  /**
   * How often to re-scan for new subagent dirs (ms). Default 1000.
   */
  rescanMs?: number
  /**
   * How long without JSONL activity before a worker is considered stalled
   * **once at least one tool has been used**. Default 60_000ms. Tool-call
   * loops emit JSONL events frequently, so 60s of silence in that phase
   * is a strong signal the sub-agent is stuck on a single tool.
   */
  stallThresholdMs?: number
  /**
   * Stall threshold (ms) used **before any tool has been used** —
   * "silent synthesis" mode where the model is composing a response without
   * emitting events yet. Long-running plan / synthesis sub-agents commonly
   * spend 2-5 minutes in this state legitimately, so the active-loop
   * threshold (60s) misfires. Default 300_000 (5 min).
   *
   * The watcher selects between this and `stallThresholdMs` per-entry
   * based on `entry.toolCount`: 0 ⇒ silent synthesis, ≥1 ⇒ active loop.
   * Both can be overridden for tests.
   */
  silentSynthesisStallThresholdMs?: number
  /**
   * RFC §Bug 6: how long after `stallNotified` fires the watcher waits
   * before synthesising a terminal `sub_agent_turn_end` for the entry
   * (ms). Default 300_000 (5 min) — sympathetic to legitimately-paused
   * workers but tight enough that the progress card releases its
   * deferred-completion gate well before the 30-min `maxIdleMs`
   * ceiling. Set to a very large number (e.g. `Infinity`) to disable
   * synthesis; tests use a tiny value to exercise the path.
   */
  silentStallTerminalMs?: number
  /**
   * Reaper TTL (ms): background rows in `status='running'` whose
   * `last_activity_at` (or `started_at` if liveness never wrote) is older
   * than this are transitioned to `status='stalled'` with a result_summary
   * explaining the reap. Default 1h. The reaper exists because the normal
   * stall + completion paths both look up rows by `jsonl_agent_id`; if
   * backfill never linked the JSONL to the row, neither path can update
   * it and it sits in `running` forever (issue #522).
   */
  reaperTtlMs?: number
  /**
   * How often to run the reaper (ms). Default 15 minutes. Also runs once
   * synchronously at watcher startup to catch rows left over from a
   * previous gateway process.
   */
  reaperIntervalMs?: number
  /**
   * Optional registry DB for Phase 3 liveness writes. When provided, the
   * watcher calls `bumpSubagentActivity` each time a sub-agent JSONL grows
   * (i.e. mtime advances). If the matching row does not yet exist (Phase 2
   * Pre hook hasn't fired), the UPDATE is a no-op and the event is logged.
   * Passing `null` or omitting this field disables DB writes entirely.
   */
  db?: SubagentLivenessDb | null
  /**
   * Parent agent's state directory — the directory containing the parent's
   * `turn-active.json` marker (issue #412). When provided, every time a
   * **foreground** sub-agent's JSONL grows, the watcher touches the parent
   * marker's mtime so the watchdog (`bin/bridge-watchdog.sh`) doesn't read
   * the parent as wedged just because all the in-turn activity is happening
   * inside a sub-agent that hasn't emitted a JSONL line for a while
   * (issue #501). Background sub-agents are EXCLUDED — they have their own
   * lifecycle decoupled from the parent's turn boundary, and refreshing the
   * parent's marker on background activity would mask real parent-side hangs.
   * If unset, the touch is skipped (preserves pre-#501 behaviour).
   */
  parentStateDir?: string | null
  /** Optional logger for debug output. */
  log?: (msg: string) => void
  /**
   * Option C: callback fired when a stall is detected for a running sub-agent.
   * Called with the sub-agent's agentId, idle ms, and description string.
   * Wired to `progressDriver.onSubAgentStall` in gateway.ts so the progress
   * card re-renders with a visible ⚠️ stall indicator even when the bridge
   * has disconnected. The `stallNotified` flag prevents duplicate calls for
   * the same sub-agent across subsequent poll ticks.
   */
  onStall?: (agentId: string, idleMs: number, description: string) => void
  /**
   * Symmetric to `onStall`: fires when a previously-stalled sub-agent's
   * JSONL grows again (text emission, tool use, turn_end — anything that
   * moves last_activity_at). Wired to `progressDriver.onSubAgentUnstall`
   * in gateway.ts so the pinned card clears the ⚠ Stalled badge as soon
   * as activity resumes, instead of waiting on the next render tick.
   *
   * Each stall→resume cycle fires exactly once: the watcher resets
   * `entry.stallNotified` on resume, so a sub-agent that stalls again
   * later in the same lifetime is detected (and reported) again.
   */
  onUnstall?: (agentId: string, description: string) => void
  /**
   * RFC §Bug 6: fires when the watcher synthesises a terminal transition
   * for a stalled sub-agent (no explicit `sub_agent_turn_end` line in
   * the JSONL after `silentStallTerminalMs` past the stall notification).
   * Wired in gateway.ts to push a synthetic
   * `{kind:'sub_agent_turn_end', agentId}` event into the progress
   * driver so the pinned card can release its deferred-completion gate
   * for the background dispatch.
   *
   * Idempotent: each sub-agent triggers this at most once per lifetime
   * (guarded by `entry.stallTerminalSynthesised`). Fires *before* the
   * existing `onFinish` callback so the driver-side state mutation
   * lands first; the audit-log surface then sees a consistent fleet.
   */
  onStallTerminal?: (agentId: string, description: string) => void
  /**
   * Called exactly once per sub-agent when its watcher observes a terminal
   * transition (`done` or `failed`). Mirrors the existing `sub_agent_started`
   * surface (emitted from session-tail) so the audit trail is symmetric.
   *
   * `outcome`:
   *   - 'completed' — the JSONL contained a `turn_duration` line.
   *   - 'failed'    — reserved (no caller flips state to 'failed' today).
   *   - 'orphan'    — the entry was historical at boot and its terminal
   *                   transition fires after watcher startup. (Pre-existing
   *                   `done` files at boot do NOT fire — see registerAgent.)
   * Background-vs-foreground classification is the gateway's call (it owns
   * the registry DB); the watcher just reports the lifecycle.
   */
  onFinish?: (args: {
    agentId: string
    state: WorkerState
    outcome: 'completed' | 'failed' | 'orphan'
    toolCount: number
    durationMs: number
    /** Dispatch-time task description, for the handback envelope. */
    description: string
    /** The worker's final narrative emission (capped). May be empty if
     *  no `sub_agent_text` line was ever observed. Feeds the
     *  `subagent_handback` inbound. */
    resultText: string
  }) => void
  /** `Date.now` override for tests. */
  now?: () => number
  /** `setInterval` override for tests. */
  setInterval?: (fn: () => void, ms: number) => { ref: unknown }
  clearInterval?: (ref: unknown) => void
  /** `setTimeout` override for tests. */
  setTimeout?: (fn: () => void, ms: number) => { ref: unknown }
  clearTimeout?: (ref: unknown) => void
  /**
   * `fs` overrides for tests. ESM namespace exports are not configurable so
   * `vi.spyOn(fs, ...)` doesn't work — tests inject a mock object here
   * instead. Defaults to the real `node:fs` functions.
   */
  fs?: {
    existsSync: typeof existsSync
    readdirSync: typeof readdirSync
    statSync: typeof statSync
    openSync: typeof openSync
    closeSync: typeof closeSync
    readSync: typeof readSync
    watch: typeof watch
  }
}

export interface SubagentWatcherHandle {
  stop(): void
  /** Snapshot of current registry for tests/inspection. */
  getRegistry(): ReadonlyMap<string, WorkerEntry>
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RESCAN_MS = 1000
const DEFAULT_STALL_THRESHOLD_MS = 60_000
/** Silent-synthesis threshold (no tools used yet). 5min covers plan /
 *  research sub-agents that legitimately think for several minutes
 *  before emitting their first event — the 60s active-loop threshold
 *  misfires on those and freezes the card at ⚠. */
const DEFAULT_SILENT_SYNTHESIS_STALL_THRESHOLD_MS = 300_000
/**
 * RFC §Bug 6 — post-stall terminal-synthesis window. 5min past the
 * stall notification before the watcher synthesises a
 * `sub_agent_turn_end` for the entry. Generous enough that a worker
 * paused on an external dependency (operator unblocking, slow API)
 * isn't reported done prematurely; tight enough that the pinned card's
 * deferred-completion gate releases well before the 30-min `maxIdleMs`
 * ceiling that closed-out cards used to wait on.
 */
const DEFAULT_SILENT_STALL_TERMINAL_MS = 300_000

/**
 * Cap on the result text retained per sub-agent (`entry.lastResultText`)
 * and carried to the gateway via `onFinish`. The gateway feeds this into
 * the `subagent_handback` inbound; the model synthesises a fresh
 * user-facing summary from it, so the full transcript is never needed
 * and an unbounded retain would bloat the parent's context.
 */
const SUBAGENT_RESULT_TEXT_MAX = 3000

/**
 * Resolve a threshold-knob env var (e.g.
 * `SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS`) to a positive integer ms
 * value. Returns null when unset, empty, or unparseable so the caller
 * falls through to the compile-time default. Negative/zero/NaN values
 * are treated as "invalid" rather than "disable" — a real "disable"
 * needs an explicit config-arg, not an env override (don't let a
 * stray `=0` silently kill the watcher's stall-detection in prod).
 */
function parseEnvMs(varName: string): number | null {
  const raw = process.env[varName]
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}
const DEFAULT_REAPER_TTL_MS = 60 * 60_000          // 1 hour
const DEFAULT_REAPER_INTERVAL_MS = 15 * 60_000     // 15 minutes
/**
 * Grace period between a sub-agent transitioning to terminal state
 * (`done` / `failed`) and the watcher closing its FSWatcher + dropping
 * its Map entries. The grace lets late writes (a final `turn_end`
 * marker landing in the same poll tick as the completion event, the
 * registry-DB UPDATE finishing, a downstream consumer reading the
 * tail one more time) flush without losing data.
 *
 * Pre-fix the per-subagent FSWatcher lived for the entire process
 * lifetime, so a long-running gateway with sustained sub-agent load
 * accumulated FDs until it hit `ulimit -n` (default 1024 on Linux)
 * and the process started failing every fs.watch call. See MEM1 in
 * the overnight forensic audit on #472.
 */
const TERMINAL_CLEANUP_GRACE_MS = 30_000

// ─── JSONL tail per sub-agent ─────────────────────────────────────────────

interface SubTail {
  cursor: number
  pendingPartial: string
  hasEmittedStart: boolean
  watcher: FSWatcher | null
}

interface FsLike {
  existsSync: typeof existsSync
  readdirSync: typeof readdirSync
  statSync: typeof statSync
  openSync: typeof openSync
  closeSync: typeof closeSync
  readSync: typeof readSync
  watch: typeof watch
}

/**
 * Backfill `jsonl_agent_id` for a sub-agent row that was inserted by the
 * PreToolUse hook (keyed on tool_use_id) but didn't yet know the JSONL stem.
 *
 * Strategy: read the `agent-<id>.meta.json` sibling Claude Code writes next
 * to each sub-agent JSONL. It carries the same `{ agentType, description }`
 * pair the parent passed to the Agent() tool. We match that pair to the
 * most-recent row in `subagents` where `jsonl_agent_id IS NULL` and link them.
 *
 * Edge cases:
 *   - meta.json missing or unreadable: no-op (the row stays unlinked; liveness
 *     writes from this agent's JSONL won't land, but the system stays correct).
 *   - Multiple in-flight rows with identical (agent_type, description): the
 *     most recently started one wins (FIFO matches dispatch order in practice).
 *   - Row already linked to a different agentId: SQL `WHERE jsonl_agent_id IS
 *     NULL` skips it. Re-runs are safe.
 */
function backfillJsonlAgentId(
  db: SubagentLivenessDb,
  jsonlPath: string,
  agentId: string,
  log?: (msg: string) => void,
): void {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  let meta: { agentType?: string; description?: string }
  try {
    const raw = readFileSync(metaPath, 'utf8')
    meta = JSON.parse(raw)
  } catch {
    log?.(`subagent-watcher: backfill skip ${agentId} — meta.json not readable at ${metaPath}`)
    return
  }
  if (!meta.agentType && !meta.description) {
    log?.(`subagent-watcher: backfill skip ${agentId} — meta.json has no agentType/description`)
    return
  }

  // Already linked? Nothing to do.
  const already = db
    .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ? LIMIT 1')
    .get(agentId)
  if (already != null) return

  // Find the most-recent matching unmatched row.
  const candidate = db
    .prepare(`
      SELECT id FROM subagents
      WHERE jsonl_agent_id IS NULL
        AND agent_type IS ?
        AND description IS ?
      ORDER BY started_at DESC
      LIMIT 1
    `)
    .get(meta.agentType ?? null, meta.description ?? null) as { id: string } | null

  if (candidate == null) {
    log?.(`subagent-watcher: backfill no candidate for ${agentId} (type=${meta.agentType} desc=${meta.description})`)
    return
  }

  db
    .prepare('UPDATE subagents SET jsonl_agent_id = ? WHERE id = ?')
    .run(agentId, candidate.id)
  log?.(`subagent-watcher: backfill linked ${agentId} → ${candidate.id}`)
}

function readSubTail(
  entry: WorkerEntry,
  tail: SubTail,
  now: number,
  onDescriptionUpdate: (desc: string) => void,
  fs: FsLike,
  log?: (msg: string) => void,
  db?: SubagentLivenessDb | null,
  parentStateDir?: string | null,
  /** Fires when the watcher observes JSONL activity returning for a
   *  previously-stalled entry. Closes the resume edge the schema doc
   *  has always promised. */
  onUnstall?: (agentId: string, description: string) => void,
): void {
  try {
    const stat = fs.statSync(entry.filePath)
    if (stat.size < tail.cursor) {
      tail.cursor = 0
      tail.pendingPartial = ''
    }
    if (stat.size === tail.cursor) return

    const buf = Buffer.alloc(stat.size - tail.cursor)
    const fd = fs.openSync(entry.filePath, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, tail.cursor)
    } finally {
      fs.closeSync(fd)
    }
    tail.cursor = stat.size

    // Phase 3 (#333): JSONL grew → write liveness update to the registry DB.
    // Bug fix (#1): DB rows are keyed on tool_use_id (e.g. "toolu_…") but the
    // watcher only knows the JSONL filename stem (e.g. "a37ad763…"). We look up
    // the row by jsonl_agent_id and bump using the actual tool_use_id PK.
    // If the row doesn't exist yet (Phase 2 Pre hook hasn't fired), the UPDATE
    // is a no-op — log and continue, don't INSERT here.
    //
    // Issue #501: also use the row to decide whether the sub-agent is
    // foreground; if so, refresh the PARENT's `turn-active.json` mtime so the
    // watchdog doesn't kill the parent during a long-running foreground
    // sub-agent that the parent is awaiting. Background sub-agents are
    // excluded — they have their own lifecycle and shouldn't mask
    // parent-side hangs.
    let isForeground = false
    if (db != null) {
      try {
        const existing = db
          .prepare('SELECT id, background FROM subagents WHERE jsonl_agent_id = ?')
          .get(entry.agentId) as { id: string; background: number } | null
        if (existing == null) {
          log?.(`subagent-watcher: liveness skip ${entry.agentId} — row not in DB yet (Phase 2 Pre hook pending)`)
        } else {
          bumpSubagentActivity(db, { id: existing.id, ts: now })
          isForeground = existing.background === 0
        }
      } catch (dbErr) {
        log?.(`subagent-watcher: liveness write error ${entry.agentId}: ${(dbErr as Error).message}`)
      }
    }

    // Issue #501 fix: foreground sub-agent activity refreshes the parent's
    // turn-active marker. Without this, a foreground sub-agent doing pure
    // computation or waiting on a slow API for >300s would let the marker
    // age past TURN_HANG_SECS, and the watchdog would kill the parent even
    // though real work is happening. The watchdog's multi-signal progress
    // gate (PR #557) already protects most cases via JSONL liveness, but a
    // sub-agent that goes silent for the threshold window is the one
    // remaining gap this fix closes.
    if (isForeground && parentStateDir) {
      try {
        touchTurnActiveMarker(parentStateDir)
      } catch (touchErr) {
        log?.(`subagent-watcher: parent marker touch error ${entry.agentId}: ${(touchErr as Error).message}`)
      }
    }

    const text = tail.pendingPartial + buf.toString('utf-8')
    const lines = text.split('\n')
    tail.pendingPartial = lines.pop() ?? ''

    const startState = { hasEmittedStart: tail.hasEmittedStart }
    for (const line of lines) {
      if (!line) continue
      const events = projectSubagentLine(line, entry.agentId, startState)
      for (const ev of events) {
        const idleSecBeforeBump = Math.round((now - entry.lastActivityAt) / 1000)
        entry.lastActivityAt = now
        // Un-stall transition (#previously-missing). The schema doc
        // promised "stalled → running (may resume)" but neither the
        // in-memory `stallNotified` flag nor the DB `status` column was
        // ever flipped back. That left the pinned card stuck at ⚠ until
        // terminal completion, by which point the user had often
        // already interrupted or redispatched. Reset both halves on the
        // first activity tick after a stall + fire onUnstall for the
        // driver to clear its render-time badge.
        if (entry.stallNotified) {
          entry.stallNotified = false
          // Clear the stall timestamp so a subsequent re-stall starts
          // the post-stall terminal-synthesis clock from scratch
          // (RFC §Bug 6). Without this, a stall→resume→stall sequence
          // could prematurely synthesise terminal on the second stall.
          entry.stalledAt = null
          if (db != null) {
            try {
              const rowRef = db
                .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
                .get(entry.agentId) as { id: string } | null
              if (rowRef != null) {
                recordSubagentResume(db, { id: rowRef.id, resumedAt: now })
              }
            } catch (dbErr) {
              log?.(`subagent-watcher: resume DB write error ${entry.agentId}: ${(dbErr as Error).message}`)
            }
          }
          if (onUnstall != null) {
            try {
              onUnstall(entry.agentId, entry.description)
            } catch (cbErr) {
              log?.(`subagent-watcher: onUnstall callback error ${entry.agentId}: ${(cbErr as Error).message}`)
            }
          }
          log?.(`subagent-watcher: stall cleared for ${entry.agentId} (activity resumed after ${idleSecBeforeBump}s — re-arming detection)`)
        }
        if (ev.kind === 'sub_agent_tool_use') {
          entry.toolCount++
          // P0 of #662: surface the most recent tool name + sanitised
          // arg so the driver's fleet-state shadow can render the
          // last-tool column on the v2 status card. Sanitiser lives in
          // fleet-state.ts to keep the watcher dependency surface small.
          entry.lastTool = {
            name: ev.toolName,
            sanitisedArg: sanitiseToolArg(ev.toolName, ev.input ?? {}),
          }
        } else if (ev.kind === 'sub_agent_text') {
          // Do NOT overwrite description with narrative text — description is
          // set at dispatch time (from the parent Agent/Task tool_use input)
          // and must remain stable. Overwriting it with the sub-agent's first
          // narrative line caused a race-condition-dependent display (issue #352).
          entry.lastSummaryLine = ev.text.split('\n')[0].trim().slice(0, 120)
          // Retain the full text of the most recent narrative emission —
          // for a worker the final such line before turn_end IS its
          // result summary (the worker prompt asks it to "return a
          // concise summary"). Carried to the gateway via onFinish so a
          // *background* sub-agent's result can be handed back to the
          // user (conversational-pacing beat 4). Replace-on-write +
          // capped: this is the worker's intended output, never tool
          // args or file content — consistent with the watcher's
          // "descriptions only" privacy posture.
          entry.lastResultText = ev.text.trim().slice(0, SUBAGENT_RESULT_TEXT_MAX)
        } else if (ev.kind === 'sub_agent_turn_end') {
          if (entry.state === 'running') {
            entry.state = 'done'
            // Bug 2 fix (#333): mark the DB row completed via watcher's turn_end
            // observation. This is the authoritative completion signal for
            // background agents (whose PostToolUse fires on "launched" not "done").
            // For foreground agents PostToolUse may have already marked the row —
            // recordSubagentEnd is idempotent so the second write is a safe no-op.
            if (db != null) {
              try {
                const rowRef = db
                  .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
                  .get(entry.agentId) as { id: string } | null
                if (rowRef != null) {
                  recordSubagentEnd(db, {
                    id: rowRef.id,
                    endedAt: now,
                    status: 'completed',
                  })
                }
              } catch (dbErr) {
                log?.(`subagent-watcher: turn_end DB write error ${entry.agentId}: ${(dbErr as Error).message}`)
              }
            }
          }
        }
      }
    }
    tail.hasEmittedStart = startState.hasEmittedStart
  } catch (err) {
    log?.(`subagent-watcher: read error ${entry.agentId}: ${(err as Error).message}`)
  }
}

// ─── Main watcher factory ─────────────────────────────────────────────────

export function startSubagentWatcher(config: SubagentWatcherConfig): SubagentWatcherHandle {
  const agentDir = config.agentDir
  // Issue #1116: when agentCwd is supplied, restrict project-dir
  // enumeration to the slug Claude Code would mint for that cwd.
  // Foreign-slug shadow dirs (a sibling agent's stale project tree
  // left over from a wayward CLAUDE_PROJECT_DIR or a past boot) are
  // skipped — pre-#1116 they caused ENOENT log spam and false stalls.
  // When agentCwd is null/undefined, fall back to the legacy walk-
  // every-subdir behaviour (preserves tests that don't care about
  // multi-slug isolation).
  const expectedProjectSlug = config.agentCwd != null
    ? sanitizeCwdToProjectName(config.agentCwd)
    : null
  // One-shot logging: warn the first time a foreign slug is observed
  // so silent regressions are visible without re-running with debug.
  const warnedForeignSlugs = new Set<string>()
  // Threshold knobs resolve in this order: explicit config arg →
  // env-var override → compile-time default. Env-vars exist so the
  // UAT scenario (which times out at 120s) can compress the watcher's
  // 60s-stall + 300s-synth window down to a few seconds without
  // having to plumb config through every spinUp() caller. Production
  // gateways don't set these — the defaults are tuned for live use.
  const stallThresholdMs =
    config.stallThresholdMs ?? parseEnvMs('SWITCHROOM_SUBAGENT_STALL_MS') ?? DEFAULT_STALL_THRESHOLD_MS
  const silentSynthesisStallThresholdMs =
    config.silentSynthesisStallThresholdMs
    ?? parseEnvMs('SWITCHROOM_SUBAGENT_SILENT_SYNTH_STALL_MS')
    ?? DEFAULT_SILENT_SYNTHESIS_STALL_THRESHOLD_MS
  const silentStallTerminalMs =
    config.silentStallTerminalMs
    ?? parseEnvMs('SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS')
    ?? DEFAULT_SILENT_STALL_TERMINAL_MS
  const reaperTtlMs = config.reaperTtlMs ?? DEFAULT_REAPER_TTL_MS
  const reaperIntervalMs = config.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS
  const rescanMs = config.rescanMs ?? DEFAULT_RESCAN_MS
  const log = config.log
  const db = config.db ?? null
  const parentStateDir = config.parentStateDir ?? null
  const nowFn = config.now ?? (() => Date.now())

  const setI = config.setInterval ?? ((fn, ms) => {
    const h = setInterval(fn, ms)
    return { ref: h }
  })
  const clearI = config.clearInterval ?? ((ref) => {
    clearInterval((ref as { ref: ReturnType<typeof setInterval> }).ref)
  })
  const setT = config.setTimeout ?? ((fn, ms) => {
    const h = setTimeout(fn, ms)
    return { ref: h }
  })
  const clearT = config.clearTimeout ?? ((ref) => {
    clearTimeout((ref as { ref: ReturnType<typeof setTimeout> }).ref)
  })

  // fs DI: tests pass a mock; production uses the real node:fs functions.
  const fs = config.fs ?? {
    existsSync,
    readdirSync,
    statSync,
    openSync,
    closeSync,
    readSync,
    watch,
  }

  // Registry: agentId → WorkerEntry
  const registry = new Map<string, WorkerEntry>()
  // Per-agent tail state
  const tails = new Map<string, SubTail>()
  // Dir-level FSWatcher for the subagents/ directory
  const dirWatchers = new Map<string, FSWatcher>()
  // Known subagent files: filePath → true
  const knownFiles = new Set<string>()
  // Pending deferred-cleanups for terminal-state sub-agents. Keyed by
  // agentId so a re-transition (shouldn't happen, but defensively) or
  // a stop() call can cancel pending timers cleanly. See MEM1 fix.
  const pendingCloses = new Map<string, { ref: unknown }>()
  /**
   * Files that existed before the watcher started (boot-time snapshot).
   * The `historical` flag on each entry suppresses two notification paths:
   *   - Stall detection (see `checkStalls` — historical entries can't stall
   *     because they predate the watcher session).
   *   - Past-completion replay: if a historical file was already `done` at
   *     boot, `completionNotified` is set immediately so the eventual
   *     state-transition pass doesn't fire "Worker done" for work that
   *     finished before we started watching.
   * Historical files that are still in-flight at boot DO fire completion
   * when they eventually report done — that transition is meaningful.
   */
  const historicalFiles = new Set<string>()
  /**
   * AgentIds that have transitioned to a terminal state and been swept
   * out of `registry` by `cleanupTerminalAgent`. Issue #1116 (Bug B):
   * the JSONL file outlives the registry entry — Claude Code leaves
   * the file on disk after the sub-agent finishes. Without this guard,
   * the next `rescanSubagentDirs` poll re-discovered the file, called
   * `registerAgent`, the fresh entry read the terminal `turn_duration`
   * line, and `maybySendStateTransition` fired a duplicate "Worker done"
   * notification — looping forever every grace-window.
   *
   * `scanSubagentsDir` consults this set and treats re-discovered
   * terminal JSONLs as a no-op.
   */
  const terminatedAgentIds = new Set<string>()
  /**
   * True while the initial boot scan is running. During this window every
   * newly discovered file is added to historicalFiles.
   */
  let bootScanInProgress = true

  let stopped = false

  // ─── Per-agent registration ─────────────────────────────────────────────

  function registerAgent(filePath: string, agentId: string): void {
    if (registry.has(agentId)) return
    const n = nowFn()
    const isHistorical = historicalFiles.has(filePath)
    log?.(`subagent-watcher: registering agent ${agentId}${isHistorical ? ' (historical — pre-existing at boot)' : ''}`)

    const entry: WorkerEntry = {
      agentId,
      filePath,
      description: 'sub-agent',
      state: 'running',
      dispatchedAt: n,
      lastActivityAt: n,
      toolCount: 0,
      stallNotified: false,
      stalledAt: null,
      completionNotified: false,
      stallTerminalSynthesised: false,
      lastSummaryLine: '',
      lastResultText: '',
      lastTool: null,
      historical: isHistorical,
    }
    registry.set(agentId, entry)

    // Backfill jsonl_agent_id linkage. The PreToolUse hook inserts the row
    // keyed on tool_use_id and doesn't know the JSONL stem yet (the JSONL
    // doesn't exist when PreToolUse fires). We bridge that gap here: read
    // the meta.json sibling Claude Code writes alongside the JSONL, match
    // the (agentType, description) pair against the most-recent unmatched
    // row in the registry, and link them by setting jsonl_agent_id.
    if (db != null && !isHistorical) {
      try {
        backfillJsonlAgentId(db, filePath, agentId, log)
      } catch (err) {
        log?.(`subagent-watcher: backfill error for ${agentId}: ${(err as Error).message}`)
      }
    }

    const tail: SubTail = {
      cursor: 0, // read from start to capture description
      pendingPartial: '',
      hasEmittedStart: false,
      watcher: null,
    }
    tails.set(agentId, tail)

    // Initial read
    readSubTail(entry, tail, n, (desc) => {
      log?.(`subagent-watcher: description updated for ${agentId}: ${desc}`)
    }, fs, log, db, parentStateDir, config.onUnstall)

    // If the JSONL already contained a turn_end at registration time
    // (file written-then-watched), fire the state-transition + completion
    // notification now. Otherwise the FSWatcher callback handles it on
    // subsequent writes.
    //
    // Historical files that are already done at startup do NOT get a
    // completion notification either — they finished before this session.
    // Only transitions that happen AFTER startup (e.g. a pre-existing
    // in-flight agent that finishes while we're watching) fire.
    if (isHistorical && entry.state === 'done') {
      // Already finished before we started — mark as notified so we
      // don't fire a spurious completion notification later, and
      // schedule cleanup so the FSWatcher we just opened doesn't leak
      // forever. See MEM1 fix.
      entry.completionNotified = true
      scheduleTerminalCleanup(agentId)
    } else {
      maybySendStateTransition(agentId)
    }

    // Set up FSWatcher
    try {
      tail.watcher = fs.watch(filePath, () => {
        if (stopped) return
        const entry = registry.get(agentId)
        const t = tails.get(agentId)
        if (!entry || !t) return
        readSubTail(entry, t, nowFn(), (desc) => {
          log?.(`subagent-watcher: description updated for ${agentId}: ${desc}`)
        }, fs, log, db, parentStateDir, config.onUnstall)
        maybySendStateTransition(agentId)
      })
    } catch (err) {
      log?.(`subagent-watcher: fs.watch failed for ${agentId}: ${(err as Error).message}`)
    }
  }

  // ─── State-transition notifications ─────────────────────────────────────

  function maybySendStateTransition(agentId: string): void {
    const entry = registry.get(agentId)
    if (!entry) return

    if (entry.state === 'done' && !entry.completionNotified) {
      entry.completionNotified = true
      const desc = escapeHtml(truncate(entry.description, 80))
      const summary = entry.lastSummaryLine
        ? ` — ${escapeHtml(truncate(entry.lastSummaryLine, 120))}`
        : ''
      const tools = entry.toolCount > 0 ? ` (${entry.toolCount} tools)` : ''
      try {
        config.sendNotification(`✓ Worker done: ${desc}${tools}${summary}`)
      } catch (err) {
        log?.(`subagent-watcher: completion notification error: ${(err as Error).message}`)
      }
      // Symmetric `sub_agent_finished` surface (#card-audit-log). Emit
      // before the deferred cleanup runs so the callback always sees a
      // live registry entry. Historical entries that already-completed at
      // boot get their `completionNotified=true` shortcut in registerAgent
      // and skip this path entirely — only post-boot transitions fire.
      if (config.onFinish) {
        try {
          config.onFinish({
            agentId,
            state: entry.state,
            outcome: entry.historical ? 'orphan' : 'completed',
            toolCount: entry.toolCount,
            durationMs: nowFn() - entry.dispatchedAt,
            description: entry.description,
            resultText: entry.lastResultText,
          })
        } catch (cbErr) {
          log?.(`subagent-watcher: onFinish callback error ${agentId}: ${(cbErr as Error).message}`)
        }
      }
      scheduleTerminalCleanup(agentId)
    }
    // Defensive: if state ever flips to 'failed' (currently no caller
    // sets this, but the type allows it), still clean up the FSWatcher.
    if (entry.state === 'failed') {
      if (config.onFinish && !entry.completionNotified) {
        entry.completionNotified = true
        try {
          config.onFinish({
            agentId,
            state: entry.state,
            outcome: 'failed',
            toolCount: entry.toolCount,
            durationMs: nowFn() - entry.dispatchedAt,
            description: entry.description,
            resultText: entry.lastResultText,
          })
        } catch (cbErr) {
          log?.(`subagent-watcher: onFinish callback error ${agentId}: ${(cbErr as Error).message}`)
        }
      }
      scheduleTerminalCleanup(agentId)
    }
  }

  // ─── Per-agent cleanup ──────────────────────────────────────────────────

  /**
   * Schedule a deferred close of the per-subagent FSWatcher + Map
   * entries `TERMINAL_CLEANUP_GRACE_MS` after the sub-agent transitions
   * to terminal state. Idempotent — repeated calls for the same agent
   * cancel the previous timer and reset the grace window.
   */
  function scheduleTerminalCleanup(agentId: string): void {
    if (stopped) return
    const existing = pendingCloses.get(agentId)
    if (existing) {
      clearT(existing)
    }
    const handle = setT(() => {
      pendingCloses.delete(agentId)
      cleanupTerminalAgent(agentId)
    }, TERMINAL_CLEANUP_GRACE_MS)
    pendingCloses.set(agentId, handle)
  }

  /**
   * Close the FSWatcher and drop Map entries for a terminal sub-agent.
   * Safe to call multiple times: each Map operation is a no-op for an
   * already-deleted key.
   */
  function cleanupTerminalAgent(agentId: string): void {
    const tail = tails.get(agentId)
    if (tail?.watcher) {
      try { tail.watcher.close() } catch { /* ignore */ }
      tail.watcher = null
    }
    tails.delete(agentId)
    const entry = registry.get(agentId)
    if (entry?.filePath) {
      knownFiles.delete(entry.filePath)
    }
    registry.delete(agentId)
    // Issue #1116 (Bug B): record that this agent has been fully
    // processed so a rescan that rediscovers the still-present JSONL
    // doesn't re-register and re-notify.
    terminatedAgentIds.add(agentId)
    log?.(`subagent-watcher: cleaned up terminal agent ${agentId}`)
  }

  // ─── Stall detection ────────────────────────────────────────────────────

  function checkStalls(): void {
    const n = nowFn()
    // Pass 1: stall detection (existing behaviour). A running sub-agent
    // with no JSONL growth for `threshold` ms transitions to "stalled"
    // and notifies subscribers (badge on card, DB row update).
    for (const entry of registry.values()) {
      if (entry.state !== 'running') continue
      if (entry.historical) continue
      if (entry.stallNotified) continue
      const idleMs = n - entry.lastActivityAt
      // Adaptive: a sub-agent that hasn't fired any tools yet is in
      // "silent synthesis" mode (model thinking before its first emit).
      // 60s is way too aggressive for plan / research sub-agents that
      // legitimately spend 2-5 minutes composing before their first
      // tool_use. Once tools have started, switch to the tighter loop
      // threshold — frequent JSONL writes mean 60s of silence is a
      // strong signal the sub-agent is genuinely stuck.
      const threshold = entry.toolCount === 0
        ? silentSynthesisStallThresholdMs
        : stallThresholdMs
      if (idleMs >= threshold) {
        entry.stallNotified = true
        entry.stalledAt = n
        const desc = escapeHtml(truncate(entry.description, 80))
        const idleSec = Math.floor(idleMs / 1000)
        log?.(`subagent-watcher: stall detected for ${entry.agentId} (idle ${idleSec}s): ${desc}`)
        // Bug 3 fix (#333): persist the stall into the registry DB.
        // Look up the row by jsonl_agent_id to get the tool_use_id PK.
        if (db != null) {
          try {
            const rowRef = db
              .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
              .get(entry.agentId) as { id: string } | null
            if (rowRef != null) {
              recordSubagentStall(db, { id: rowRef.id, stalledAt: n })
            }
          } catch (dbErr) {
            log?.(`subagent-watcher: stall DB write error ${entry.agentId}: ${(dbErr as Error).message}`)
          }
        }
        // Option C (#393): push the stall into the progress-card driver so
        // the pinned card re-renders with a ⚠️ stall indicator. This fires
        // even when the bridge has disconnected (dispose preserved the chat
        // state for pendingCompletion chats).
        if (config.onStall != null) {
          try {
            config.onStall(entry.agentId, idleMs, entry.description)
          } catch (cbErr) {
            log?.(`subagent-watcher: onStall callback error ${entry.agentId}: ${(cbErr as Error).message}`)
          }
        }
      }
    }

    // Pass 2 (RFC §Bug 6): post-stall terminal synthesis. Background
    // `Agent` dispatches in some Claude Code versions write a JSONL
    // that ends with the worker's last `sub_agent_tool_result` and
    // never emits an explicit `system + turn_duration` line — so the
    // canonical `sub_agent_turn_end` event never fires. Without
    // synthesis the entry stays `running` until the 30-min
    // `maxIdleMs` ceiling, and the pinned card's deferred-completion
    // gate never releases.
    //
    // Wait `silentStallTerminalMs` past the stall notification before
    // synthesising: a genuinely-paused worker (e.g. waiting on an
    // external API the operator has to unblock) shouldn't be reported
    // done immediately at the stall threshold.
    for (const entry of registry.values()) {
      if (entry.state !== 'running') continue
      if (!entry.stallNotified) continue
      if (entry.stallTerminalSynthesised) continue
      if (entry.stalledAt == null) continue
      if (n - entry.stalledAt < silentStallTerminalMs) continue
      entry.stallTerminalSynthesised = true
      entry.state = 'done'
      const postStallSec = Math.floor((n - entry.stalledAt) / 1000)
      const totalIdleSec = Math.floor((n - entry.lastActivityAt) / 1000)
      log?.(`subagent-watcher: silent-stall terminal synthesis for ${entry.agentId} (stalled ${postStallSec}s post-notify, ${totalIdleSec}s total idle) — bg worker JSONL lacks turn_end; synthesising sub_agent_turn_end so deferred-completion gate releases`)
      // Persist completion to the registry DB so reaper / audit paths
      // see the same terminal state as the JSONL-driven path.
      if (db != null) {
        try {
          const rowRef = db
            .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
            .get(entry.agentId) as { id: string } | null
          if (rowRef != null) {
            recordSubagentEnd(db, {
              id: rowRef.id,
              endedAt: n,
              status: 'completed',
            })
          }
        } catch (dbErr) {
          log?.(`subagent-watcher: stall-synth DB write error ${entry.agentId}: ${(dbErr as Error).message}`)
        }
      }
      // Push a synthetic sub_agent_turn_end into the progress driver
      // BEFORE the audit-log surface so the card mutation lands first.
      if (config.onStallTerminal != null) {
        try {
          config.onStallTerminal(entry.agentId, entry.description)
        } catch (cbErr) {
          log?.(`subagent-watcher: onStallTerminal callback error ${entry.agentId}: ${(cbErr as Error).message}`)
        }
      }
      // Fire the existing terminal-transition path (onFinish +
      // deferred cleanup). state==='done' was set above so
      // maybySendStateTransition flows through its happy path.
      maybySendStateTransition(entry.agentId)
    }
  }

  // ─── Subagents dir scanner ───────────────────────────────────────────────

  /**
   * The subagents directory for a given session lives at:
   *   <agentDir>/.claude/projects/<sanitized-cwd>/<sessionId>/subagents/
   *
   * We walk: <agentDir>/.claude/projects/ → each project dir → each session dir
   * → subagents/ → agent-*.jsonl
   */
  function rescanSubagentDirs(): void {
    if (stopped) return
    const claudeHome = join(agentDir, '.claude')
    const projectsRoot = join(claudeHome, 'projects')
    if (!fs.existsSync(projectsRoot)) return

    let projectDirs: string[]
    try {
      projectDirs = fs.readdirSync(projectsRoot) as string[]
    } catch { return }

    for (const pDir of projectDirs) {
      // Issue #1116: filter to the agent's own slug. Skip foreign
      // project dirs so their stale subagent JSONLs (which Claude
      // Code reaps mid-session) don't pollute the watcher's registry.
      if (expectedProjectSlug != null && pDir !== expectedProjectSlug) {
        if (!warnedForeignSlugs.has(pDir)) {
          warnedForeignSlugs.add(pDir)
          log?.(`subagent-watcher: skipping foreign project dir ${pDir} (expected ${expectedProjectSlug})`)
        }
        continue
      }
      const projectPath = join(projectsRoot, pDir)
      let sessionDirs: string[]
      try {
        sessionDirs = fs.readdirSync(projectPath) as string[]
      } catch { continue }

      for (const sDir of sessionDirs) {
        // Session dirs are UUID-like; skip known non-session entries
        if (sDir.endsWith('.jsonl')) continue
        const subagentsPath = join(projectPath, sDir, 'subagents')
        if (!fs.existsSync(subagentsPath)) continue

        // Watch the subagents dir for new files if not already watching
        if (!dirWatchers.has(subagentsPath)) {
          try {
            const w = fs.watch(subagentsPath, (_event, filename) => {
              if (!filename || !filename.toString().startsWith('agent-') || !filename.toString().endsWith('.jsonl')) return
              const filePath = join(subagentsPath, filename.toString())
              if (!knownFiles.has(filePath)) {
                scanSubagentsDir(subagentsPath)
              }
            })
            dirWatchers.set(subagentsPath, w)
            log?.(`subagent-watcher: watching dir ${subagentsPath}`)
          } catch (err) {
            log?.(`subagent-watcher: dir watch failed ${subagentsPath}: ${(err as Error).message}`)
          }
        }

        // Scan existing files
        scanSubagentsDir(subagentsPath)
      }
    }
  }

  function scanSubagentsDir(subagentsPath: string): void {
    let entries: string[]
    try {
      entries = fs.readdirSync(subagentsPath) as string[]
    } catch { return }

    for (const e of entries) {
      if (!e.startsWith('agent-') || !e.endsWith('.jsonl')) continue
      const filePath = join(subagentsPath, e)
      if (knownFiles.has(filePath)) continue
      const agentId = e.slice('agent-'.length, -'.jsonl'.length)
      // Issue #1116 (Bug B): skip JSONLs whose agent already completed
      // and was swept by cleanupTerminalAgent. Re-adding to knownFiles
      // here would let a subsequent rescan re-register, fire a duplicate
      // "Worker done", and loop forever every grace-window.
      if (terminatedAgentIds.has(agentId)) continue
      knownFiles.add(filePath)
      // During the initial boot scan, mark every discovered file as
      // historical so stall-detection and completion notifications are
      // suppressed for pre-existing JSONLs (months of session history
      // would otherwise flood the chat on every restart).
      if (bootScanInProgress) {
        historicalFiles.add(filePath)
      }
      registerAgent(filePath, agentId)
    }
  }

  // ─── Main poll loop ──────────────────────────────────────────────────────

  function poll(): void {
    if (stopped) return

    // Rescan for new sub-agent dirs
    rescanSubagentDirs()

    // Defensive read for any running agents (in case fs.watch missed events)
    const n = nowFn()
    for (const [agentId, entry] of registry) {
      if (entry.state !== 'running') continue
      const tail = tails.get(agentId)
      if (!tail) continue
      readSubTail(entry, tail, n, (desc) => {
        log?.(`subagent-watcher: description updated for ${agentId}: ${desc}`)
      }, fs, log, db, parentStateDir, config.onUnstall)
      maybySendStateTransition(agentId)
    }

    // Stall detection
    checkStalls()
  }

  // Initial boot scan: discover pre-existing files and mark them historical
  // so we don't replay stalls or past completions for past sessions.
  rescanSubagentDirs()
  bootScanInProgress = false

  // ─── Reaper for stuck-running rows (issue #522) ─────────────────────────
  // Background subagents whose JSONL was never linked to their registry row
  // (backfill failed) are invisible to the normal stall + completion paths,
  // both of which look up rows by `jsonl_agent_id`. Without this reaper they
  // sit in `status='running'` forever. Run once at startup to clean up rows
  // left by a previous gateway, then on a periodic timer.
  function runReaper(): void {
    if (db == null) return
    try {
      const result = reapStuckRunningRows(db, { ttlMs: reaperTtlMs, now: nowFn() })
      if (result.reaped > 0) {
        log?.(`subagent-watcher: reaper transitioned ${result.reaped} stuck-running row(s) to stalled (ttl=${Math.round(reaperTtlMs / 60_000)}min)`)
      }
    } catch (err) {
      log?.(`subagent-watcher: reaper error: ${(err as Error).message}`)
    }
  }
  runReaper()

  // Register the poll interval BEFORE the reaper interval. Existing tests'
  // harness `poll()` helper grabs `intervals[0]` and fires it, treating the
  // first-registered interval as the poll loop. Keep the reaper second to
  // preserve that contract.
  const pollHandle = setI(poll, rescanMs)
  const reaperHandle = setI(runReaper, reaperIntervalMs)

  return {
    stop(): void {
      stopped = true
      clearI(pollHandle)
      clearI(reaperHandle)
      // Cancel any pending deferred-cleanup timers — the unconditional
      // close loop below covers their work and we don't want straggler
      // setTimeout callbacks firing after the watcher is supposedly stopped.
      for (const handle of pendingCloses.values()) {
        clearT(handle)
      }
      pendingCloses.clear()
      for (const w of dirWatchers.values()) {
        try { w.close() } catch { /* ignore */ }
      }
      dirWatchers.clear()
      for (const tail of tails.values()) {
        if (tail.watcher) {
          try { tail.watcher.close() } catch { /* ignore */ }
          tail.watcher = null
        }
      }
      tails.clear()
      registry.clear()
      knownFiles.clear()
      terminatedAgentIds.clear()
    },

    getRegistry(): ReadonlyMap<string, WorkerEntry> {
      return registry
    },
  }
}
