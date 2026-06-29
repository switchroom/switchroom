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
import { projectSubagentLine, sanitizeCwdToProjectName, detectErrorInTranscriptLine } from './session-tail.js'
import { sanitiseToolArg } from './fleet-state.js'
import { clipNarrative, describeToolUse } from './tool-activity-summary.js'
import { REPLY_TOOLS, isDraftOfReply } from './narrative-dedup.js'
import { truncate } from './card-format.js'
import { bumpSubagentActivity, recordSubagentStall, recordSubagentResume, recordSubagentEnd, reapStuckRunningRows, countRunningBackgroundSubagents } from './registry/subagents-schema.js'
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
  /**
   * Generic 'sub-agent' placeholder — the watcher deliberately does NOT
   * reassign this from the worker jsonl (see the init at construction and
   * the "Do NOT overwrite" note in the line-handler). The real dispatch-time
   * task description lives in the registry `subagents` row; the gateway reads
   * it there via resolveWorkerFeedDispatch for the worker-feed header.
   */
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
   * Last bucket index for which an `onProgress` callback was fired for
   * this sub-agent (#1720). Null until the first envelope. The gateway
   * owns the actual decision via `decideSubagentProgress`; this field
   * persists the cursor across `sub_agent_text` events on the same
   * entry so the watcher doesn't re-fire within the same bucket window.
   */
  lastProgressBucketIdx: number | null
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
  /**
   * True once a TERMINAL error line — a model API failure / quota
   * exhaustion / crash, NOT an in-flight retry or a routine tool-level
   * `is_error` result — has been observed in this worker's own
   * transcript. Drives the `failed` terminal outcome so the handback
   * tells the user the delegated work did NOT complete, instead of
   * dressing a dead worker up as `completed`. Classified by
   * `detectErrorInTranscriptLine` (the same gate the operator-event
   * path uses), so transient mid-retry errors are excluded.
   */
  errored?: boolean
  /** Human-readable detail from the terminal error line, surfaced in the
   *  failed handback's "what it reported before failing" slot when the
   *  worker left no narrative result of its own. */
  errorDetail?: string
  /**
   * Narrative-dedup gate state (JSONL-text-narrative primitive). A
   * `sub_agent_text` block is held here for ONE lookahead step so the next
   * `sub_agent_tool_use` / `sub_agent_turn_end` can decide draft-then-send
   * (SUPPRESS — it duplicates the worker's reply) vs working-narration (SHOW
   * — fire `onProgress({latestSummary})`). Null when nothing is pending. The
   * pure decision lives in narrative-dedup.ts; this slot is the per-entry
   * cursor. Mirrors the gateway's `turn.pendingNarrative`.
   */
  pendingNarrative?: { text: string } | null
  /**
   * NIT 3 (sub-agent turn_end symmetry). Most-recently-seen
   * reply/stream_reply `input.text` for this sub-agent — the actual answer a
   * FOREGROUND sub-agent delivered. `sub_agent_turn_end` resolves a trailing
   * `sub_agent_text` block against THIS so a draft of the just-delivered
   * answer is suppressed the same way main-agent step 3 does (conservative
   * dedup). Undefined for background workers that never call a reply tool —
   * their trailing narration still SHOWs, unchanged. Mirrors the gateway's
   * `turn.lastReplyText`.
   */
  lastReplyText?: string
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
   * Freshness window (ms) for promoting a running-at-boot worker file to
   * live. A file whose last write (mtime) is older than this is treated as
   * a dead prior-session worker and stays historical/suppressed, NOT
   * promoted. Default 15 min (DEFAULT_INFLIGHT_PROMOTE_MAX_AGE_MS); env
   * override `SWITCHROOM_SUBAGENT_INFLIGHT_MAX_AGE_MS`. Guards the v0.14.23
   * stale-handback replay regression.
   */
  inflightPromoteMaxAgeMs?: number
  /**
   * Kill-switch for the boot-scan promotion path. When false, a
   * running-at-boot worker is never promoted — the watcher reverts to the
   * pre-v0.14.23 behaviour of leaving every boot-scan file historical
   * (suppressed). Default true; env `SWITCHROOM_SUBAGENT_BOOT_PROMOTE=0`
   * disables it fleet-wide without a code change (emergency lever).
   */
  bootPromoteEnabled?: boolean
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
  /**
   * #1720: fires on every `sub_agent_text` event for a running
   * sub-agent. The gateway decides whether to materialise a
   * `subagent_progress` envelope via `decideSubagentProgress` (pure,
   * bucket-deterministic); the watcher just surfaces the cue.
   * `setBucketIdx` writes back the per-entry cursor so a same-bucket
   * re-fire is suppressed. Foreground vs background classification is
   * the gateway's call.
   */
  onProgress?: (args: {
    agentId: string
    description: string
    latestSummary: string
    elapsedMs: number
    prevBucketIdx: number | null
    setBucketIdx: (b: number) => void
    /** Most recent tool the worker invoked, or null if none yet. Feeds
     *  the live worker-activity feed (#PR2); the bucket relay ignores it. */
    lastTool: { name: string; sanitisedArg: string } | null
    /** Tool-use count observed so far. */
    toolCount: number
    /** Friendly display line for THIS tick. Set on `sub_agent_tool_use`
     *  events to a `describeToolUse` label ("Reading X", "Running a
     *  command") so a foreground sub-agent that runs tools without
     *  emitting prose still surfaces its steps in the parent's nested
     *  feed. Undefined on `sub_agent_text` ticks — the gateway falls back
     *  to `latestSummary` (the narrative line), preserving prior behavior. */
    progressLine?: string
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
  /**
   * Count background workers still in flight, read from the dispatch-time DB
   * (not the file-discovery registry). Returns null when no DB is wired so the
   * caller can fall back to the registry snapshot. Drives the deferred-done
   * reaction gate — see `countRunningBackgroundSubagents`.
   */
  countRunningBackgroundWorkers(): number | null
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
 * Freshness window for the boot-scan "in-flight at boot → promote to
 * live" path. A worker file still in `running` state at boot is only
 * promoted (un-suppressed) if its last write (file mtime) is within this
 * window of now. The signal cleanly separates the two populations:
 *
 *  - A worker genuinely in-flight across a restart / fleet rollout was
 *    writing right up until the container was recreated, so its mtime is
 *    seconds-to-minutes before the new gateway boots — well inside the
 *    window. The user is still awaiting it; promote it.
 *  - A worker that died in a PRIOR session without writing a terminal
 *    `turn_end` is also `running` in the file, but its mtime is hours-to-
 *    weeks old. These accumulate by the dozen-to-hundred in a long-lived
 *    agent's subagents dir. Promoting them replays stale handbacks
 *    (often `failed`, from old error lines) on every boot — the v0.14.23
 *    regression. Leave them historical/suppressed, exactly as before.
 *
 * 15 min is generous for any plausible restart gap (container recreate +
 * image pull) yet far below the staleness of a dead prior-session file.
 * Override with `SWITCHROOM_SUBAGENT_INFLIGHT_MAX_AGE_MS`.
 */
const DEFAULT_INFLIGHT_PROMOTE_MAX_AGE_MS = 15 * 60_000

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
 * Strategy: read the `agent-<id>.meta.json` sibling that the Claude Code
 * binary writes next to each sub-agent JSONL. It carries `{ agentType,
 * description, toolUseId }` where `toolUseId` is the primary key of the
 * `subagents` row — the same `event.tool_use_id` value the pretool hook
 * (`subagent-tracker-pretool.mjs`) uses when it inserts the DB row. We use
 * the direct `toolUseId` lookup first (exact PK match, race-safe); fall back
 * to the fuzzy `(agentType, description)` match only when `toolUseId` is
 * absent (older Claude Code versions that pre-date this field in the meta).
 *
 * Edge cases:
 *   - meta.json missing or unreadable: no-op (the row stays unlinked; liveness
 *     writes from this agent's JSONL won't land, but the system stays correct).
 *   - `toolUseId` present but no matching row (hook crashed / race): fall
 *     through to the fuzzy match so the link is still attempted.
 *   - Multiple in-flight rows with identical (agent_type, description): the
 *     most recently started one wins (FIFO matches dispatch order in practice).
 *   - Row already linked to a different agentId: SQL `WHERE jsonl_agent_id IS
 *     NULL` skips it. Re-runs are safe.
 */
// Exported for unit-testing the parent_turn_key backfill (telegram-plugin/
// tests/subagent-watcher-parent-turn-key.test.ts). Not intended for
// consumption by other modules.
export function backfillJsonlAgentId(
  db: SubagentLivenessDb,
  jsonlPath: string,
  agentId: string,
  log?: (msg: string) => void,
): void {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  let meta: { agentType?: string; description?: string; toolUseId?: string } | null
  try {
    const raw = readFileSync(metaPath, 'utf8')
    meta = JSON.parse(raw)
  } catch {
    log?.(`subagent-watcher: backfill skip ${agentId} — meta.json not readable at ${metaPath}`)
    return
  }
  if (!meta || (!meta.agentType && !meta.description && !meta.toolUseId)) {
    log?.(`subagent-watcher: backfill skip ${agentId} — meta.json has no agentType/description/toolUseId`)
    return
  }

  // Already linked? Nothing to do.
  const already = db
    .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ? LIMIT 1')
    .get(agentId)
  if (already != null) return

  // Primary path (Bug 1 fix): direct PK lookup via the toolUseId Claude Code
  // writes to meta.json. The pretool hook inserts the row with `id =
  // event.tool_use_id`, so this is an exact match with no ambiguity — no
  // race, no description-collision, no fuzzy-match false-negative.
  let candidateId: string | null = null
  if (meta.toolUseId) {
    const direct = db
      .prepare('SELECT id FROM subagents WHERE id = ? AND jsonl_agent_id IS NULL LIMIT 1')
      .get(meta.toolUseId) as { id: string } | null
    if (direct != null) {
      candidateId = direct.id
      log?.(`subagent-watcher: backfill direct-key match ${agentId} → ${candidateId} (toolUseId=${meta.toolUseId})`)
    } else {
      log?.(`subagent-watcher: backfill direct-key miss ${agentId} toolUseId=${meta.toolUseId} — falling back to fuzzy match`)
    }
  }

  // Fallback path: fuzzy (agentType, description) match for older Claude Code
  // versions whose meta.json predates the toolUseId field.
  if (candidateId == null && (meta.agentType || meta.description)) {
    const fuzzy = db
      .prepare(`
        SELECT id FROM subagents
        WHERE jsonl_agent_id IS NULL
          AND agent_type IS ?
          AND description IS ?
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get(meta.agentType ?? null, meta.description ?? null) as { id: string } | null
    if (fuzzy != null) {
      candidateId = fuzzy.id
      log?.(`subagent-watcher: backfill fuzzy match ${agentId} → ${candidateId} (type=${meta.agentType} desc=${meta.description})`)
    }
  }

  if (candidateId == null) {
    log?.(`subagent-watcher: backfill no candidate for ${agentId} (toolUseId=${meta.toolUseId} type=${meta.agentType} desc=${meta.description})`)
    return
  }

  db
    .prepare('UPDATE subagents SET jsonl_agent_id = ? WHERE id = ?')
    .run(agentId, candidateId)
  log?.(`subagent-watcher: backfill linked ${agentId} → ${candidateId}`)

  // Backfill parent_turn_key (gateway-side). The PreToolUse hook can't know
  // the gateway-minted Telegram turn_key (a chat+topic+turn key) — it only
  // sees Claude Code's session id — so the row was inserted with
  // parent_turn_key=NULL. Resolve
  // it now from the turn whose [started_at, ended_at] window contained the
  // sub-agent's dispatch (its started_at). Keying on the historical
  // started_at, NOT "the turn active now", is what makes this correct for a
  // background worker that outlives its parent turn: the turn may have already
  // ended by link time, but the containment match still finds it. Turns are
  // processed serially per agent, so at most one window contains a given
  // instant; the ORDER BY ... DESC LIMIT 1 is just a defensive tie-break.
  //
  // Without this, resolveSubagentOriginChat() returns null and the live
  // worker card + handback fall back to the operator DM instead of the
  // originating group/forum-topic, and resolveCallingSubagent()'s turn-scoped
  // heuristic (WHERE parent_turn_key = ?) can never see the row. Best-effort:
  // any failure leaves parent_turn_key NULL (today's behaviour) and never
  // throws out of the watcher poll loop.
  try {
    const linkedRow = db
      .prepare('SELECT started_at, parent_turn_key FROM subagents WHERE id = ?')
      .get(candidateId) as { started_at: number; parent_turn_key: string | null } | null
    if (linkedRow != null && linkedRow.parent_turn_key == null) {
      const turn = db
        .prepare(
          `SELECT turn_key FROM turns
           WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(linkedRow.started_at, linkedRow.started_at) as { turn_key: string } | null
      if (turn?.turn_key != null) {
        db
          .prepare('UPDATE subagents SET parent_turn_key = ? WHERE id = ?')
          .run(turn.turn_key, candidateId)
        log?.(`subagent-watcher: backfill parent_turn_key ${candidateId} → ${turn.turn_key}`)
      }
    }
  } catch (err) {
    log?.(`subagent-watcher: parent_turn_key backfill skipped for ${candidateId} — ${(err as Error).message}`)
  }
}

// Exported for unit-testing the ENOENT/EACCES deregister path
// (telegram-plugin/tests/subagent-watcher-enoent-deregister.test.ts).
// Not intended for consumption by other modules.
export function readSubTail(
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
  /** Fires when the JSONL file is no longer accessible (ENOENT — file
   *  reaped by Claude Code when the parent session ends; EACCES —
   *  permission change mid-poll). The caller deregisters the entry so
   *  the 1s poll loop stops re-statting a dead path. Without this
   *  callback, every poll re-emits the error log line — on 2026-05-23
   *  the clerk agent logged 540k ENOENT lines in 3 days (30/sec
   *  sustained) AND leaked one fs.watch FD per stranded entry. */
  onFileVanished?: (agentId: string, code: 'ENOENT' | 'EACCES') => void,
  /** Fires on every `sub_agent_text` event for a running sub-agent
   *  (#1720). The gateway decides whether to materialise a progress
   *  envelope via `decideSubagentProgress` — pure decision, watcher
   *  just surfaces the cue. `latestSummary` is the narrative text;
   *  `elapsedMs` is `now - entry.dispatchedAt`; `prevBucketIdx` is
   *  `entry.lastProgressBucketIdx` (gateway calls `setBucketIdx` on a
   *  successful deliver so a same-bucket re-fire is suppressed). */
  onProgress?: (args: {
    agentId: string
    description: string
    latestSummary: string
    elapsedMs: number
    prevBucketIdx: number | null
    setBucketIdx: (b: number) => void
    /** Most recent tool the worker invoked (name + sanitised arg), or
     *  null if no tool_use has been observed yet. For the live
     *  worker-activity feed (#PR2) — the legacy bucket relay ignores it. */
    lastTool: { name: string; sanitisedArg: string } | null
    /** Tool-use count observed so far. */
    toolCount: number
    /** Friendly display line for THIS tick (set on tool ticks; see the
     *  SubagentWatcherConfig.onProgress doc). */
    progressLine?: string
  }) => void,
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
      // Gap 2 (failure honesty): a terminal error line in the worker's
      // OWN transcript — a model API failure, quota exhaustion, or crash —
      // means the worker FAILED, not finished. Reuse the operator-event
      // classifier: `terminal:true` excludes in-flight retries (a 529 mid-
      // backoff is `terminal:false`), and tool-level `is_error` results
      // never reach here (they parse as `sub_agent_tool_result`, which is
      // routine mid-run noise, not a worker death). The flag persists on
      // the entry; the terminal transition (real turn_end OR stall
      // synthesis) reads it to emit `failed` instead of `completed`.
      const errInfo = detectErrorInTranscriptLine(line)
      if (errInfo?.terminal) {
        entry.errored = true
        if (errInfo.detail) entry.errorDetail = errInfo.detail.slice(0, SUBAGENT_RESULT_TEXT_MAX)
      }
      const events = projectSubagentLine(line, entry.agentId, startState)
      // Narrative-dedup gate (JSONL-text-narrative primitive) — fire the
      // narrative progress cue for a SHOWN sub_agent_text block. Identical
      // shape to the inline #1720 onProgress below; factored out so the gate
      // (stage-on-text, resolve-on-tool/turn_end) can replay a previously
      // pending block exactly once. `latestSummary` carries the worker's
      // narrative result (entry.lastResultText), never tool labels.
      const fireNarrativeProgress = (): void => {
        if (onProgress == null || entry.state !== 'running' || entry.historical) return
        try {
          onProgress({
            agentId: entry.agentId,
            description: entry.description,
            latestSummary: entry.lastResultText,
            elapsedMs: now - entry.dispatchedAt,
            prevBucketIdx: entry.lastProgressBucketIdx,
            setBucketIdx: (b: number) => {
              entry.lastProgressBucketIdx = b
            },
            lastTool: entry.lastTool,
            toolCount: entry.toolCount,
          })
        } catch (cbErr) {
          log?.(`subagent-watcher: onProgress callback error ${entry.agentId}: ${(cbErr as Error).message}`)
        }
      }
      // Resolve a pending sub-agent narrative against a lookahead event.
      // SUPPRESS only when the pending block drafts a reply/stream_reply
      // tool's text; otherwise SHOW (fire the cue). See narrative-dedup.ts §2b.
      //
      // Two lookahead shapes:
      //   - sub_agent_tool_use: `toolName`/`toolInput` are the tool — suppress
      //     a draft of THIS tool's reply text.
      //   - sub_agent_turn_end: `toolName` is null. NIT 3 (turn_end symmetry):
      //     a FOREGROUND sub-agent that called stream_reply/reply as its final
      //     tool then emitted a trailing text block would, under the old
      //     unconditional SHOW, surface a draft of the delivered answer. So at
      //     turn_end we apply the SAME conservative dedup as main-agent step 3:
      //     compare the trailing block against the worker's last reply text
      //     (`entry.lastReplyText`) and suppress a draft. Background workers
      //     never set lastReplyText, so their trailing narration still SHOWs.
      const resolvePendingSubNarrative = (
        toolName: string | null,
        toolInput: Record<string, unknown> | undefined,
      ): void => {
        if (entry.pendingNarrative == null) return
        const pending = entry.pendingNarrative
        entry.pendingNarrative = null
        if (toolName != null && REPLY_TOOLS.has(toolName)) {
          const replyText = typeof toolInput?.text === 'string' ? (toolInput.text as string) : ''
          if (isDraftOfReply(pending.text, replyText)) return // draft of the reply → SUPPRESS
        } else if (toolName == null && entry.lastReplyText != null && entry.lastReplyText.length > 0) {
          // turn_end path: suppress a trailing draft of the delivered answer.
          if (isDraftOfReply(pending.text, entry.lastReplyText)) return
        }
        fireNarrativeProgress()
      }
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
          // Narrative-dedup gate step 2: a sub_agent_text block was pending;
          // this tool is the lookahead that decides it (SHOW unless it drafts
          // a reply tool's text). Runs before the tool's own progress cue so
          // a working preamble surfaces just ahead of its tool step.
          resolvePendingSubNarrative(ev.toolName, ev.input)
          // NIT 3: capture a foreground sub-agent's actual reply text so the
          // turn_end path can suppress a trailing draft of it (see
          // resolvePendingSubNarrative). Only REPLY_TOOLS carry the answer.
          if (REPLY_TOOLS.has(ev.toolName) && typeof ev.input?.text === 'string') {
            entry.lastReplyText = ev.input.text as string
          }
          entry.toolCount++
          // P0 of #662: surface the most recent tool name + sanitised
          // arg so the driver's fleet-state shadow can render the
          // last-tool column on the v2 status card. Sanitiser lives in
          // fleet-state.ts to keep the watcher dependency surface small.
          entry.lastTool = {
            name: ev.toolName,
            sanitisedArg: sanitiseToolArg(ev.toolName, ev.input ?? {}),
          }
          // Surface a tool-step progress cue. A foreground sub-agent that
          // runs tools WITHOUT emitting prose (e.g. a researcher reading
          // files) previously produced no onProgress tick at all — only
          // `sub_agent_text` fired it — so its steps never nested under the
          // parent's activity feed (the named foreground blindspot). Fire
          // here too, carrying a friendly `describeToolUse` label as
          // `progressLine` so the gateway can render "Reading X" / "Running
          // a command" the same way the main-turn feed does. `latestSummary`
          // stays the worker's narrative result (never polluted with tool
          // labels — the handback payload depends on it). Pure jsonl-tail →
          // render, no model call.
          if (onProgress != null && entry.state === 'running' && !entry.historical) {
            const toolLine = describeToolUse(ev.toolName, ev.input ?? {})
            if (toolLine != null && toolLine.length > 0) {
              try {
                onProgress({
                  agentId: entry.agentId,
                  description: entry.description,
                  latestSummary: entry.lastResultText,
                  elapsedMs: now - entry.dispatchedAt,
                  prevBucketIdx: entry.lastProgressBucketIdx,
                  setBucketIdx: (b: number) => {
                    entry.lastProgressBucketIdx = b
                  },
                  lastTool: entry.lastTool,
                  toolCount: entry.toolCount,
                  progressLine: toolLine,
                })
              } catch (cbErr) {
                log?.(`subagent-watcher: onProgress (tool) callback error ${entry.agentId}: ${(cbErr as Error).message}`)
              }
            }
          }
        } else if (ev.kind === 'sub_agent_text') {
          // Do NOT overwrite description with narrative text — description is
          // set at dispatch time (from the parent Agent/Task tool_use input)
          // and must remain stable. Overwriting it with the sub-agent's first
          // narrative line caused a race-condition-dependent display (issue #352).
          entry.lastSummaryLine = clipNarrative(ev.text)
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
          // #1720 + JSONL-text-narrative gate step 1: stage this block for
          // one lookahead step instead of firing the progress cue
          // immediately. A previously-pending block had nothing reply-shaped
          // after it (pure narration) → flush it as SHOWN now; then stage
          // THIS block. Its eventual SHOW/SUPPRESS is decided by the next
          // sub_agent_tool_use / sub_agent_turn_end. `lastResultText` /
          // `lastSummaryLine` above already updated unconditionally — the
          // handback payload is independent of the progress-cue decision.
          if (entry.pendingNarrative != null) {
            fireNarrativeProgress() // prior pending was pure narration → SHOW
          }
          entry.pendingNarrative = { text: ev.text }
        } else if (ev.kind === 'sub_agent_turn_end') {
          // Narrative-dedup gate step 3: a trailing sub_agent_text block with
          // nothing after it. SUPPRESS only when it drafts the foreground
          // sub-agent's delivered reply (entry.lastReplyText, set above on a
          // REPLY_TOOL tool_use) — symmetric with main-agent step 3; otherwise
          // SHOW. Background workers never set lastReplyText, so their trailing
          // narration still SHOWs. The worker's result is carried separately
          // via lastResultText/onFinish, so a SHOWN trailing cue here is purely
          // the transient liveness beat.
          resolvePendingSubNarrative(null, undefined)
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
                    // Gap 2: keep the audit row honest — a worker that hit a
                    // terminal transcript error is `failed`, matching the
                    // handback outcome computed in maybySendStateTransition.
                    status: entry.errored ? 'failed' : 'completed',
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
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES') {
      // JSONL is gone (Claude Code reaped the parent session's
      // subagents/ dir) or permission flipped under us. Deregister the
      // entry so the periodic poll stops re-emitting this same line
      // forever. Logged ONCE per agent — operators can still audit
      // which entries got reaped without 30 lines/sec of noise.
      log?.(`subagent-watcher: JSONL vanished for ${entry.agentId} (${code}) — deregistering`)
      onFileVanished?.(entry.agentId, code)
      return
    }
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
  const inflightPromoteMaxAgeMs =
    config.inflightPromoteMaxAgeMs
    ?? parseEnvMs('SWITCHROOM_SUBAGENT_INFLIGHT_MAX_AGE_MS')
    ?? DEFAULT_INFLIGHT_PROMOTE_MAX_AGE_MS
  // Kill-switch: not parseEnvMs (which rejects `0`) — an explicit `=0`
  // here MUST disable promotion (revert to pre-v0.14.23 suppression).
  const bootPromoteEnabled =
    config.bootPromoteEnabled ?? (process.env.SWITCHROOM_SUBAGENT_BOOT_PROMOTE !== '0')
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
      // Generic placeholder only — never overwritten from the jsonl. The
      // gateway substitutes the real registry description for the worker
      // feed (resolveWorkerFeedDispatch). See the WorkerEntry.description doc.
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
      lastProgressBucketIdx: null,
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
    }, fs, log, db, parentStateDir, config.onUnstall, undefined, config.onProgress)

    // Gap 1 (restart survival): a file still RUNNING at boot is a LIVE
    // worker that predates this watcher — typically one dispatched in a
    // prior gateway life and still in-flight across a restart / fleet
    // rollout, NOT a stale already-finished file. `historical` must
    // suppress replay only for done-at-boot files; an in-flight-at-boot
    // worker the user is still waiting on must get full live treatment:
    // progress nudges, the stall-synthesis safety net (checkStalls skips
    // historical entries), and a real `completed`/`failed` handback rather
    // than a dropped `orphan`. Promote it to a live entry here. (A file
    // already `done` at boot stays historical and is short-circuited just
    // below — it finished before this session.)
    if (isHistorical && entry.state === 'running') {
      // Freshness gate (v0.14.24): only promote a file whose LAST WRITE is
      // recent. A genuinely in-flight-across-a-restart worker was writing
      // until the container was recreated (mtime seconds-to-minutes old); a
      // dead prior-session worker that never wrote a terminal turn_end is
      // also `running` but hours-to-weeks stale. Promoting the latter
      // replayed stale `failed` handbacks on every boot (the v0.14.23
      // fleet-wide regression). Unreadable mtime → treat as stale (suppress
      // rather than risk re-spamming). The kill-switch reverts to pre-fix
      // suppression entirely.
      let fileAgeMs = Infinity
      try {
        const st = fs.statSync(filePath)
        if (typeof st.mtimeMs === 'number') fileAgeMs = n - st.mtimeMs
      } catch {
        /* unreadable → Infinity → treated as stale below */
      }
      if (!bootPromoteEnabled) {
        log?.(`subagent-watcher: ${agentId} running at boot but promotion disabled (SWITCHROOM_SUBAGENT_BOOT_PROMOTE=0) — leaving historical`)
      } else if (fileAgeMs > inflightPromoteMaxAgeMs) {
        log?.(`subagent-watcher: ${agentId} running at boot but stale (last write ${Math.round(fileAgeMs / 1000)}s ago > ${Math.round(inflightPromoteMaxAgeMs / 1000)}s) — leaving historical (dead prior-session worker, not in-flight)`)
      } else {
        entry.historical = false
        log?.(`subagent-watcher: ${agentId} was in-flight at boot — promoting to live (last write ${Math.round(fileAgeMs / 1000)}s ago; user still awaiting handback)`)
        // The prior gateway life's registration normally linked
        // jsonl_agent_id already, but re-run the backfill idempotently in
        // case that life crashed before the link persisted — the handback's
        // isBackground lookup is keyed on jsonl_agent_id, and an unlinked row
        // would mis-resolve the worker as foreground and drop the handback.
        if (db != null) {
          try {
            backfillJsonlAgentId(db, filePath, agentId, log)
          } catch (err) {
            log?.(`subagent-watcher: backfill error for ${agentId}: ${(err as Error).message}`)
          }
        }
      }
    }

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
        }, fs, log, db, parentStateDir, config.onUnstall, cleanupTerminalAgent, config.onProgress)
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
      // Card retired (#1122): the watcher no longer sends a user-facing
      // "✓ Worker done" message. A framework-authored status line is a
      // conversational-pacing anti-pattern, and the heuristic that drove
      // it (silent-stall synthesis) fired on a worker mid-`Bash` as
      // readily as on a finished one. The user-facing handback is the
      // model's own beat-4 reply, woken by Claude Code's native
      // background-task notification. Completion is surfaced here only
      // via the structured `onFinish` callback — emitted before the
      // deferred cleanup runs so the callback always sees a live
      // registry entry. Historical entries that already-completed at
      // boot get their `completionNotified=true` shortcut in
      // registerAgent and skip this path — only post-boot transitions
      // fire.
      if (config.onFinish) {
        try {
          config.onFinish({
            agentId,
            state: entry.state,
            // Gap 2: a terminal error observed in the transcript wins over
            // the completed/orphan classification — a worker that crashed
            // is `failed`, even if it later wrote a turn_end or aged into
            // stall synthesis. `orphan` remains for genuinely stale
            // done-at-boot rows (which never reach this path; see
            // registerAgent's short-circuit + Gap 1 promotion).
            outcome: entry.errored ? 'failed' : entry.historical ? 'orphan' : 'completed',
            toolCount: entry.toolCount,
            durationMs: nowFn() - entry.dispatchedAt,
            description: entry.description,
            // For a failure, fall back to the error detail when the worker
            // left no narrative of its own — so the handback's "what it
            // reported before failing" slot is never empty on a crash.
            resultText: entry.errored
              ? entry.lastResultText || entry.errorDetail || ''
              : entry.lastResultText,
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
        const desc = truncate(entry.description, 80)
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
              // Gap 2: a worker that hit a terminal transcript error before
              // going silent is `failed`, not `completed` — keep the audit
              // row consistent with the handback outcome.
              status: entry.errored ? 'failed' : 'completed',
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

        // Watch a single flat subagents dir and scan its agent-*.jsonl files.
        // Reused for both the base subagents/ dir and each workflow sub-dir.
        const watchAndScan = (dirPath: string): void => {
          if (!dirWatchers.has(dirPath)) {
            try {
              const w = fs.watch(dirPath, (_event, filename) => {
                if (!filename || !filename.toString().startsWith('agent-') || !filename.toString().endsWith('.jsonl')) return
                const filePath = join(dirPath, filename.toString())
                if (!knownFiles.has(filePath)) {
                  scanSubagentsDir(dirPath)
                }
              })
              dirWatchers.set(dirPath, w)
              log?.(`subagent-watcher: watching dir ${dirPath}`)
            } catch (err) {
              log?.(`subagent-watcher: dir watch failed ${dirPath}: ${(err as Error).message}`)
            }
          }
          scanSubagentsDir(dirPath)
        }

        // Register the base subagents dir
        watchAndScan(subagentsPath)

        // Workflow sub-agents (spawned by the Workflow tool) write to:
        //   subagents/workflows/wf_<id>/agent-<id>.jsonl
        // The flat readdir above misses these because it only sees the
        // "workflows" directory entry (not matching agent-*.jsonl). Descend
        // one level so each wf_*/ dir gets the same watch+scan treatment.
        const workflowsPath = join(subagentsPath, 'workflows')
        if (fs.existsSync(workflowsPath)) {
          let wfDirs: string[]
          try {
            wfDirs = fs.readdirSync(workflowsPath) as string[]
          } catch { continue }
          for (const wfDir of wfDirs) {
            try {
              const wfPath = join(workflowsPath, wfDir)
              // Only descend into actual directories. statSync succeeds on
              // regular files too (e.g. a stray journal.jsonl or lock file
              // sitting directly in workflows/), so check isDirectory()
              // explicitly rather than relying on a throw that never comes.
              if (!fs.statSync(wfPath).isDirectory()) continue
              watchAndScan(wfPath)
            } catch { /* skip entries we can't stat or watch */ }
          }
        }
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
      }, fs, log, db, parentStateDir, config.onUnstall, cleanupTerminalAgent, config.onProgress)
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

    countRunningBackgroundWorkers(): number | null {
      if (db == null) return null
      try {
        return countRunningBackgroundSubagents(db)
      } catch {
        // A torn/locked DB read must not wedge the reaction gate — fall back
        // to the registry snapshot by returning null.
        return null
      }
    },
  }
}
