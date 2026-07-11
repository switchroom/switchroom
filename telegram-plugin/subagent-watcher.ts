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
 * Sub-agent state is surfaced to the user in the conversation itself — a
 * background worker via its in-chat `🛠 Worker` message (worker-activity-feed.ts),
 * a foreground sub-agent nested in the parent turn's activity message. The
 * pinned progress card was retired in #1122; the `🛠 Worker` message is now
 * silently pinned while the worker runs (status-pin.ts), not a bespoke card.
 * See issue #142.
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
import { bumpSubagentActivity, recordSubagentStall, recordSubagentResume, recordSubagentEnd, reapStuckRunningRows, countRunningBackgroundSubagents, recordNestedSubagentDispatch, recordSubagentModel } from './registry/subagents-schema.js'
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
   * Tool-use ids for tool calls this worker has STARTED but not yet
   * finished — a `sub_agent_tool_use` was observed with no matching
   * `sub_agent_tool_result` yet. A non-empty set means the worker is
   * currently *inside* a tool call (e.g. a long-running `Bash` frame-
   * capture loop that can legally run 10+ minutes with zero JSONL
   * growth). The silent-stall terminal synthesis (checkStalls Pass 2)
   * MUST NOT fire while this is non-empty: a frozen `lastActivityAt`
   * during an in-flight tool call is expected, not a dead worker.
   * Cleared on the matching `sub_agent_tool_result` and on
   * `sub_agent_turn_end` (belt-and-braces). Tool-use lines with a null
   * `toolUseId` can't be paired, so they don't participate — Bash and
   * every real long-runner always carries a `toolu_…` id.
   */
  inflightToolUseIds: Set<string>
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
  /**
   * Wall-clock ms of the most recent RETRY of `backfillJsonlAgentId` from the
   * liveness path (readSubTail's "row not in DB yet" branch). The one-shot
   * backfill at registration loses the race for a NESTED worker: its row is
   * written by recordNestedSubagentDispatch only when the watcher reads the
   * PARENT worker's dispatch line, which can land after the child's own
   * registration. Retrying (throttled) closes the "liveness skip … Phase 2
   * Pre hook pending" window that froze nested cards on "starting…".
   */
  lastBackfillAttemptAt?: number
  /**
   * Fix #5: set on a boot-scan `running` file whose mtime passed the
   * `inflightPromoteMaxAgeMs` freshness gate but has NOT yet shown any
   * post-boot JSONL growth. mtime freshness alone can't distinguish a
   * worker killed moments before the restart (indistinguishable file state)
   * from a genuinely still-running one — so promotion is deferred until
   * `checkBootPromotionGrowth` observes the file's size actually advance
   * past its boot-time snapshot (real proof of life), or `deadlineAt`
   * passes with no growth (treated as historical/orphan — never promoted).
   * `undefined` once resolved either way.
   */
  bootPromotionPending?: { deadlineAt: number }
  /**
   * Fix #1(+#2): the `run_in_background` flag as last observed from the
   * registry `subagents` row, carried on the entry itself rather than
   * re-derived only at `onFinish` time. The registry row is the sole
   * source of truth for this flag (the watcher never sees the dispatching
   * tool_input directly), but the row is looked up by `jsonl_agent_id` —
   * exactly the linkage that can be permanently missing (meta.json
   * unreadable, or the fuzzy backfill found no unambiguous candidate).
   * Once we DO observe the row (at registration or on any later liveness
   * tick — the backfill retry can link it after the fact), we cache the
   * flag here so a subsequent `onFinish` can fall back to it even if
   * `getSubagentByJsonlId` fails again at finish time. `undefined` until
   * the row has been observed at least once.
   */
  background?: boolean
  /**
   * Live model this worker is running, as a raw resolved model id (e.g.
   * `claude-opus-4-8`). Set from the worker's OWN transcript `message.model`
   * (`sub_agent_model` event) — the authoritative live source — and persisted to
   * the registry row on change (recordSubagentModel) so boot-replay / handback
   * cards can render it without a live entry. Threaded onto the onProgress
   * payload so the worker card's metrics line shows the model. Undefined until
   * the worker's first assistant line lands; before that the card falls back to
   * the dispatch-time `tool_input.model` persisted on the registry row.
   */
  currentModel?: string
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
   * Additional cwds (beyond `agentCwd`) whose Claude-Code project-dir slug
   * should also be watched. Gap 2 of `deterministic-turn-liveness.md`: a
   * sub-agent dispatched with worktree isolation (`switchroom worktree
   * claim`) runs with a *different* cwd than the parent agent, so its
   * `agent-*.jsonl` lands under a different `.claude/projects/<slug>/`
   * tree than `expectedProjectSlug` — the #1116 foreign-slug filter then
   * silently skips it forever (no activity stamp, no `🛠 Worker` feed).
   *
   * Called fresh on every rescan tick (cheap — reads a handful of small
   * JSON records from the worktree registry) so a worktree claimed or
   * released mid-run is picked up/dropped without a watcher restart.
   * Deterministic guarantee this preserves: only cwds this agent's own
   * sub-agents can legitimately run in are ever added — a worktree record
   * not owned by this agent is never included, so this does not widen the
   * #1116 foreign-project protection into a wildcard watch.
   */
  extraWatchCwdsProvider?: () => string[]
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
   * Upper bound (ms of total JSONL idle) on the in-flight tool-call
   * deferral of terminal synthesis. While a tool call is in flight
   * (tool_use seen, matching tool_result not yet), synthesis is deferred —
   * a long `Bash` legitimately freezes the JSONL for 10+ min (incident
   * 2026-07-10). But a worker that DIES mid-tool (process killed; JSONL
   * stops growing but is never deleted) would otherwise defer forever, and
   * the reaper's isLive cross-check would shield it from the DB net too —
   * wedged for the life of the gateway. Past this cap the deferral ends
   * and synthesis proceeds. Default 45 min
   * (DEFAULT_INFLIGHT_TERMINAL_CAP_MS) — above any legitimate single tool
   * call, below the 1h reaper TTL. Env override
   * `SWITCHROOM_SUBAGENT_INFLIGHT_TERMINAL_CAP_MS`.
   */
  inflightTerminalCapMs?: number
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
   * Fix #9a: override for `TERMINATED_AGENT_IDS_CAP` — the bound on the
   * `terminatedAgentIds` re-discovery dedup guard. Exposed mainly so tests
   * can exercise eviction without inserting thousands of entries. Defaults
   * to `TERMINATED_AGENT_IDS_CAP` (a few thousand) in production.
   */
  terminatedAgentIdsCap?: number
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
   * The `stallNotified` flag prevents duplicate calls for the same sub-agent
   * across subsequent poll ticks.
   *
   * NOTE: this used to be wired in gateway.ts to `progressDriver.onSubAgentStall`
   * so the pinned progress card could render a ⚠️ stall badge. That card was
   * retired (#1122/#1126) and the gateway wiring was removed (the dead no-op
   * falsely implied a stall renders a visual badge). The callback is retained
   * as an unwired hook — PR 2 will re-wire it to repaint the live `🛠 Worker`
   * activity feed on stall. Currently no gateway consumer is attached.
   */
  onStall?: (agentId: string, idleMs: number, description: string) => void
  /**
   * Symmetric to `onStall`: fires when a previously-stalled sub-agent's
   * JSONL grows again (text emission, tool use, turn_end — anything that
   * moves last_activity_at).
   *
   * Each stall→resume cycle fires exactly once: the watcher resets
   * `entry.stallNotified` on resume, so a sub-agent that stalls again
   * later in the same lifetime is detected (and reported) again.
   *
   * NOTE: formerly wired to `progressDriver.onSubAgentUnstall` (retired card,
   * #1122/#1126) — the gateway wiring was removed with `onStall`. Retained as
   * an unwired hook for PR 2's live-feed repaint.
   */
  onUnstall?: (agentId: string, description: string) => void
  /**
   * RFC §Bug 6: fires when the watcher synthesises a terminal transition
   * for a stalled sub-agent (no explicit `sub_agent_turn_end` line in
   * the JSONL after `silentStallTerminalMs` past the stall notification).
   *
   * Idempotent: each sub-agent triggers this at most once per lifetime
   * (guarded by `entry.stallTerminalSynthesised`).
   *
   * NOTE: formerly wired in gateway.ts to push a synthetic
   * `{kind:'sub_agent_turn_end', agentId}` into the progress driver so the
   * pinned card could release its deferred-completion gate. The card is retired
   * (#1122/#1126) and that dead wiring was removed. The completion path does
   * NOT depend on this callback: the silent-stall synthesis loop in
   * `checkStalls()` writes the terminal registry-DB row itself
   * (`recordSubagentEnd`) and fires `maybySendStateTransition` → `onFinish`
   * (the handback) regardless. Retained as an unwired hook.
   */
  onStallTerminal?: (agentId: string, description: string) => void
  /**
   * Issue #3023 (card resurrection). Fires when a worker whose card was
   * FALSELY finalised — its terminal state came from silent-stall synthesis
   * (`onStallTerminal` above), NOT a real `sub_agent_turn_end` — resumes
   * writing to its JSONL after the synthesis. The synthesis was wrong: the
   * worker is still alive, so the operator invariant ("active work must
   * always be visible") requires its progress surface to come back. The
   * watcher re-registers the worker as a LIVE, non-historical entry (so
   * `onProgress` / stall-detection / the real handback resume), and fires
   * this so the gateway can revive the worker's activity card (clear the
   * feed's finalized gate → repaint on the next progress tick).
   *
   * GUARD (at-most-once per false finish + bounded chain): a given false
   * finish is resurrected at most once. A worker that is resurrected and
   * then falsely finalised AGAIN is NOT resurrected a second time — it is
   * named-as-lost via `onWorkerLost` instead, so a pathological worker
   * can't loop finish→resurrect forever.
   */
  onResurrect?: (agentId: string, description: string) => void
  /**
   * Issue #3023 (bounded resurrection chain). Fires when a worker that was
   * already resurrected once is falsely finalised a second time and its
   * JSONL resumes yet again. Rather than resurrect it forever, the watcher
   * declares it LOST (a single log line names it) and stops resurrecting.
   * The gateway may surface this however it likes; the invariant is only
   * that the chain is bounded, not that a lost worker gets a fresh card.
   */
  onWorkerLost?: (agentId: string, description: string) => void
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
    /**
     * Fix #1(+#2): the entry's own cached `background` flag (see
     * `WorkerEntry.background`), threaded through so the gateway can fall
     * back to it when its own registry lookup at finish time also comes up
     * empty (unlinked `jsonl_agent_id`). `undefined` when the row was never
     * observed by the watcher either — the gateway degrades further from
     * there (see the onFinish handler's non-empty-resultText fallback).
     */
    background: boolean | undefined
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
    /** Live model this worker is running (raw resolved id, e.g.
     *  `claude-opus-4-8`), from `WorkerEntry.currentModel`. Threaded onto the
     *  worker/nested card's metrics line. Undefined before the worker's first
     *  assistant line — the gateway then falls back to the registry's
     *  dispatch-time model. */
    model?: string
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
// Upper bound on the in-flight tool-call deferral of terminal synthesis.
// 45 min: comfortably above any legitimate single tool call (Bash caps at
// 10 min per call; the incident loop ran ~10 min) but below the 1h DB
// reaper TTL, so the watcher — not the reaper — still owns the terminal
// transition for a worker that died mid-tool.
const DEFAULT_INFLIGHT_TERMINAL_CAP_MS = 45 * 60_000

/**
 * Tools that legitimately run for minutes with ZERO intervening JSONL
 * writes: the worker emits ONE `sub_agent_tool_use` line when the command
 * starts, then nothing until it returns. `Bash` (a build, `npm test`, a long
 * curl, a git clone) is the canonical case. A worker whose last observed tool
 * is one of these is NOT stalled just because the JSONL went quiet — the
 * 60s active-loop threshold misfires on exactly this population, producing the
 * false "stall detected (idle 60s)" the operator hit while a background worker
 * was mid-`Bash`. Pass-1 stall detection widens the idle threshold for these
 * to the same silent-synthesis window used for not-yet-started workers, so a
 * long command is given room before it counts as stalled. The pass-2 terminal
 * synthesis is unchanged — it still releases the deferred-completion gate the
 * fixed window after a stall IS eventually flagged.
 */
const LONG_RUNNING_TOOLS: ReadonlySet<string> = new Set(['Bash'])

/**
 * Issue #3023 (bounded resurrection chain). Maximum number of times a single
 * worker may have its falsely-finalised card resurrected. Once a worker has
 * been resurrected this many times and is falsely finalised AGAIN, the next
 * post-terminal JSONL resumption names it LOST rather than resurrecting it —
 * so a pathological finish→resurrect→finish loop is bounded, not infinite.
 * One resurrection is enough to recover the real 2026-07-10 incident (a
 * single false finish from one over-long tool call); a second false finish on
 * the same worker is a signal the heuristics can't track it, so we stop.
 */
const MAX_RESURRECTIONS = 1
/** Cap on the false-finish tracker so it can't grow unbounded over a
 *  long-lived gateway; oldest record is evicted FIFO past this. */
const FALSE_FINISH_TRACKER_CAP = 512

/** True when the tool named legitimately runs quiet for minutes (see
 *  LONG_RUNNING_TOOLS). Null/undefined tool name → false. */
function isLongRunningTool(name: string | null | undefined): boolean {
  return name != null && LONG_RUNNING_TOOLS.has(name)
}

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

/**
 * Throttle for the liveness-path retry of `backfillJsonlAgentId` (see
 * WorkerEntry.lastBackfillAttemptAt). Cheap (one meta.json read + two
 * indexed lookups) but no reason to run it on every 1s poll tick.
 */
const BACKFILL_RETRY_INTERVAL_MS = 3000

/**
 * Fix #9a: cap on `terminatedAgentIds` (the re-discovery dedup guard in
 * `cleanupTerminalAgent` / `scanSubagentsDir`). Pre-fix the Set only grew
 * (added on every terminal cleanup, only ever cleared wholesale in
 * `stop()`), so a long-lived gateway with sustained sub-agent throughput
 * accumulated ids without bound. A `Set` preserves insertion order, so once
 * the cap is hit the OLDEST id is evicted on each new insert (simple ring
 * buffer semantics) — recently-terminated ids (the ones actually at risk of
 * a re-discovery race) always stay covered.
 */
const TERMINATED_AGENT_IDS_CAP = 5000

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
  //
  // Fix #3: with N unlinked rows sharing (agent_type, description), a bare
  // `ORDER BY started_at DESC LIMIT 1` assigns by start-order, not true
  // correspondence — a benign FIFO for interchangeable rows, but a genuine
  // mislink for a cross-topic identical dispatch. Read up to 2 candidates
  // (not just 1): if more than one row shares the key, the match is
  // ambiguous — refuse to link (leave jsonl_agent_id NULL) and let the
  // marker/window path attribute it instead, rather than guessing.
  if (candidateId == null && (meta.agentType || meta.description)) {
    const fuzzyCandidates = db
      .prepare(`
        SELECT id FROM subagents
        WHERE jsonl_agent_id IS NULL
          AND agent_type IS ?
          AND description IS ?
        ORDER BY started_at DESC
        LIMIT 2
      `)
      .all(meta.agentType ?? null, meta.description ?? null) as { id: string }[]
    if (fuzzyCandidates.length === 1) {
      candidateId = fuzzyCandidates[0]!.id
      log?.(`subagent-watcher: backfill fuzzy match ${agentId} → ${candidateId} (type=${meta.agentType} desc=${meta.description})`)
    } else if (fuzzyCandidates.length > 1) {
      log?.(`subagent-watcher: backfill fuzzy match refused for ${agentId} — ${fuzzyCandidates.length} ambiguous candidates share (type=${meta.agentType} desc=${meta.description}); leaving unlinked`)
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
      .prepare('SELECT started_at, parent_turn_key, parent_agent_id FROM subagents WHERE id = ?')
      .get(candidateId) as { started_at: number; parent_turn_key: string | null; parent_agent_id?: string | null } | null
    if (linkedRow != null && linkedRow.parent_turn_key == null) {
      // Nested-parent inheritance FIRST: a depth-2+ worker's dispatching
      // context is another sub-agent, not a gateway turn — its origin is its
      // ancestor chain's turn key (stamped on the depth-1 row while the main
      // turn was still active). The time-window match below can never be
      // right for it (the turn had typically ended before the nested dispatch
      // happened, and overlapping windows mis-attribute).
      let resolvedKey: string | null = null
      if (linkedRow.parent_agent_id != null && linkedRow.parent_agent_id.length > 0) {
        const seen = new Set<string>([agentId])
        let cursor: string | null = linkedRow.parent_agent_id
        for (let hop = 0; hop < 5 && cursor != null && !seen.has(cursor); hop++) {
          seen.add(cursor)
          const parentRow = db
            .prepare('SELECT parent_turn_key, parent_agent_id FROM subagents WHERE jsonl_agent_id = ? LIMIT 1')
            .get(cursor) as { parent_turn_key: string | null; parent_agent_id?: string | null } | null
          if (parentRow == null) break
          if (parentRow.parent_turn_key != null && parentRow.parent_turn_key.length > 0) {
            resolvedKey = parentRow.parent_turn_key
            break
          }
          cursor = parentRow.parent_agent_id ?? null
        }
        if (resolvedKey != null) {
          log?.(`subagent-watcher: backfill parent_turn_key ${candidateId} → ${resolvedKey} (inherited via nested-parent chain)`)
        }
      }
      if (resolvedKey == null) {
        const turn = db
          .prepare(
            `SELECT turn_key FROM turns
             WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(linkedRow.started_at, linkedRow.started_at) as { turn_key: string } | null
        if (turn?.turn_key != null) {
          resolvedKey = turn.turn_key
          log?.(`subagent-watcher: backfill parent_turn_key ${candidateId} → ${resolvedKey}`)
        }
      }
      if (resolvedKey != null) {
        db
          .prepare('UPDATE subagents SET parent_turn_key = ? WHERE id = ?')
          .run(resolvedKey, candidateId)
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
    /** Live model this worker is running (see SubagentWatcherConfig.onProgress). */
    model?: string
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
          // Retry the jsonl link (throttled). Registration's one-shot backfill
          // loses the race for a NESTED worker whose row is only written when
          // the watcher reads the PARENT's dispatch line — without this retry
          // the row never links, the worker is misclassified foreground, and
          // its card freezes on "starting…" forever (the depth-2+ freeze).
          if (
            entry.lastBackfillAttemptAt == null ||
            now - entry.lastBackfillAttemptAt >= BACKFILL_RETRY_INTERVAL_MS
          ) {
            entry.lastBackfillAttemptAt = now
            try {
              backfillJsonlAgentId(db, entry.filePath, entry.agentId, log)
            } catch (bfErr) {
              log?.(`subagent-watcher: backfill retry error ${entry.agentId}: ${(bfErr as Error).message}`)
            }
          }
        } else {
          bumpSubagentActivity(db, { id: existing.id, ts: now })
          isForeground = existing.background === 0
          // Fix #1(+#2): keep the entry's cached background flag fresh —
          // this is also how a NESTED worker (whose row links only via the
          // throttled backfill retry above, after the one-shot attempt at
          // registration lost the race) picks up its background flag before
          // its own `onFinish` fires.
          entry.background = existing.background === 1
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
      const fireNarrativeProgress = (): boolean => {
        if (onProgress == null || entry.state !== 'running' || entry.historical) return false
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
            model: entry.currentModel,
          })
          return true
        } catch (cbErr) {
          log?.(`subagent-watcher: onProgress callback error ${entry.agentId}: ${(cbErr as Error).message}`)
          return false
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
      // Returns true iff a narrative onProgress cue actually fired this
      // call — callers use this to skip a redundant/clobbering tool-label
      // onProgress cue for the SAME tick (see #1042 below: without this,
      // the tool-description onProgress unconditionally fires right after
      // and its replace-on-write onProgress always wins, so the narration
      // shown here is never actually visible on the pinned card).
      const resolvePendingSubNarrative = (
        toolName: string | null,
        toolInput: Record<string, unknown> | undefined,
      ): boolean => {
        if (entry.pendingNarrative == null) return false
        const pending = entry.pendingNarrative
        entry.pendingNarrative = null
        if (toolName != null && REPLY_TOOLS.has(toolName)) {
          const replyText = typeof toolInput?.text === 'string' ? (toolInput.text as string) : ''
          if (isDraftOfReply(pending.text, replyText)) return false // draft of the reply → SUPPRESS
        } else if (toolName == null && entry.lastReplyText != null && entry.lastReplyText.length > 0) {
          // turn_end path: suppress a trailing draft of the delivered answer.
          if (isDraftOfReply(pending.text, entry.lastReplyText)) return false
        }
        return fireNarrativeProgress()
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
        if (ev.kind === 'sub_agent_model') {
          // Live model capture for this worker. The projection already filtered
          // sentinels, so `ev.model` is a real resolved id. Record it on the
          // entry (transcript wins over the dispatch-time tool_input.model) and
          // persist to the registry row on CHANGE — update-on-change like
          // last_activity_at — so a boot-replay / handback card can render the
          // model without a live entry. No card render here: the model rides the
          // next onProgress tick's payload (below).
          if (entry.currentModel !== ev.model) {
            entry.currentModel = ev.model
            if (db != null) {
              try {
                const rowRef = db
                  .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
                  .get(entry.agentId) as { id: string } | null
                if (rowRef != null) {
                  recordSubagentModel(db, { id: rowRef.id, model: ev.model })
                }
              } catch (dbErr) {
                log?.(`subagent-watcher: model DB write error ${entry.agentId}: ${(dbErr as Error).message}`)
              }
            }
          }
          continue
        }
        if (ev.kind === 'sub_agent_tool_use') {
          // Narrative-dedup gate step 2: a sub_agent_text block was pending;
          // this tool is the lookahead that decides it (SHOW unless it drafts
          // a reply tool's text). Runs before the tool's own progress cue so
          // a working preamble surfaces just ahead of its tool step.
          const narrativeJustFired = resolvePendingSubNarrative(ev.toolName, ev.input)
          // NIT 3: capture a foreground sub-agent's actual reply text so the
          // turn_end path can suppress a trailing draft of it (see
          // resolvePendingSubNarrative). Only REPLY_TOOLS carry the answer.
          if (REPLY_TOOLS.has(ev.toolName) && typeof ev.input?.text === 'string') {
            entry.lastReplyText = ev.input.text as string
          }
          entry.toolCount++
          // Track this as an IN-FLIGHT tool call so the silent-stall
          // terminal synthesis (checkStalls Pass 2) doesn't misread the
          // frozen JSONL of a long-running tool (a 10-min `Bash` loop) as
          // a dead worker. Only pairable (non-null id) tool_uses count —
          // Bash + every real long-runner always carries a `toolu_…` id.
          if (ev.toolUseId != null && ev.toolUseId !== '') {
            entry.inflightToolUseIds.add(ev.toolUseId)
          }
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
          //
          // Clobber guard: if a pending narrative just fired an onProgress
          // cue THIS SAME tick (above), skip this one — replace-on-write
          // rendering means whichever onProgress call fires last wins, so
          // firing both back-to-back always threw away the narration in
          // favour of the generic tool label. Narration already told the
          // user what's happening for this tick; the label is redundant
          // here. When nothing preceded this tool call (no pending
          // narrative), this still fires — that's the named foreground
          // blindspot fix, unchanged.
          if (onProgress != null && entry.state === 'running' && !entry.historical && !narrativeJustFired) {
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
                  model: entry.currentModel,
                })
              } catch (cbErr) {
                log?.(`subagent-watcher: onProgress (tool) callback error ${entry.agentId}: ${(cbErr as Error).message}`)
              }
            }
          }
        } else if (ev.kind === 'sub_agent_nested_spawn') {
          // A nested Agent/Task dispatch is the same frozen-JSONL shape as
          // a long tool call: a FOREGROUND nested child blocks this worker
          // until it returns, with the matching tool_result only landing
          // then — so gate terminal synthesis on it too. The existing
          // `sub_agent_tool_result` handler clears the id (a background
          // nested dispatch's "launched" result lands almost immediately,
          // so it barely defers). Same cap applies.
          if (ev.toolUseId != null && ev.toolUseId.length > 0) {
            entry.inflightToolUseIds.add(ev.toolUseId)
          }
          // Nested (depth-2+) dispatch keying: this worker just dispatched a
          // sub-agent of its own. The PreToolUse hook can't attribute it (the
          // main turn's turn-active.json marker is long gone for a background
          // worker, and under concurrent nested dispatch the hook's write can
          // be lost entirely) — but WE are reading the authoritative dispatch
          // line right now. Record/repair the child's registry row: ensure it
          // exists (keyed on the dispatch tool_use_id, which the child's
          // meta.json `toolUseId` links against), stamp `parent_agent_id` =
          // this worker's jsonl stem, and inherit `parent_turn_key`
          // transitively so origin-chat routing works at any depth. Rendering
          // is unchanged (design §5.5 "no recursion in rendering") — this is
          // registry keying only. Fire-and-forget: a DB hiccup must never
          // break the tail loop.
          if (db != null && ev.toolUseId != null && ev.toolUseId.length > 0) {
            try {
              const nestedInput = (ev.input ?? {}) as Record<string, unknown>
              recordNestedSubagentDispatch(db, {
                toolUseId: ev.toolUseId,
                parentJsonlAgentId: entry.agentId,
                agentType: typeof nestedInput.subagent_type === 'string' ? nestedInput.subagent_type : null,
                description: typeof nestedInput.description === 'string' ? nestedInput.description : null,
                background: nestedInput.run_in_background === true,
                now,
              })
              log?.(`subagent-watcher: nested dispatch recorded parent=${entry.agentId} toolUseId=${ev.toolUseId}`)
            } catch (dbErr) {
              log?.(`subagent-watcher: nested dispatch record error ${entry.agentId}: ${(dbErr as Error).message}`)
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
        } else if (ev.kind === 'sub_agent_tool_result') {
          // The tool call completed — clear it from the in-flight set so
          // the terminal-synthesis gate re-opens. Idempotent: a result
          // whose tool_use we never tracked (null id, parallel spill) is
          // a harmless no-op delete.
          if (ev.toolUseId != null && ev.toolUseId !== '') {
            entry.inflightToolUseIds.delete(ev.toolUseId)
          }
        } else if (ev.kind === 'sub_agent_turn_end') {
          // Belt-and-braces: a turn boundary means nothing is in flight.
          entry.inflightToolUseIds.clear()
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
  const extraWatchCwdsProvider = config.extraWatchCwdsProvider ?? null
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
  const inflightTerminalCapMs =
    config.inflightTerminalCapMs
    ?? parseEnvMs('SWITCHROOM_SUBAGENT_INFLIGHT_TERMINAL_CAP_MS')
    ?? DEFAULT_INFLIGHT_TERMINAL_CAP_MS
  const inflightPromoteMaxAgeMs =
    config.inflightPromoteMaxAgeMs
    ?? parseEnvMs('SWITCHROOM_SUBAGENT_INFLIGHT_MAX_AGE_MS')
    ?? DEFAULT_INFLIGHT_PROMOTE_MAX_AGE_MS
  const terminatedAgentIdsCap = config.terminatedAgentIdsCap ?? TERMINATED_AGENT_IDS_CAP
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
   * Issue #3023 (card resurrection). Per-worker record of a FALSE terminal
   * finish — a terminal state produced by silent-stall synthesis (NOT a real
   * `sub_agent_turn_end`). Keyed by agentId; SURVIVES `cleanupTerminalAgent`
   * (which drops the registry entry) precisely so a post-terminal JSONL
   * resumption can be detected after the entry is gone.
   *
   * A genuine completion (`turn_end`) or a genuine boot-time historical
   * rediscovery NEVER writes here — only synthesis does — so those paths can
   * never be resurrected. This map IS the discriminator between "old
   * completed worker rediscovered at boot" (no record → stays suppressed)
   * and "worker I finalised moments ago whose JSONL just grew again"
   * (record present → resurrect).
   *
   *   - `synthesisedAt`  — wall-clock ms the false finish fired.
   *   - `sizeAtSynthesis`— JSONL byte size at that moment; post-terminal
   *                        growth past this proves the worker resumed.
   *   - `resurrectionCount` — times this worker has been resurrected. Bounds
   *                        the chain: once it reaches MAX, the next false
   *                        finish is named-as-lost, not resurrected.
   *   - `resurrectedForThisFinish` — at-most-once guard for the CURRENT false
   *                        finish; reset when a new synthesis records over it.
   *   - `lost` — the chain bound was hit; no further resurrection.
   */
  interface FalseFinishRecord {
    filePath: string
    synthesisedAt: number
    sizeAtSynthesis: number
    resurrectionCount: number
    resurrectedForThisFinish: boolean
    lost: boolean
  }
  const falseFinishTracker = new Map<string, FalseFinishRecord>()
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
      inflightToolUseIds: new Set<string>(),
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
      // Fix #1(+#2): if the backfill above (or an already-linked row from a
      // prior registration attempt) resolved jsonl_agent_id, cache the
      // row's `background` flag on the entry NOW — the earliest point it
      // can ever be known — so it survives even if a later `onFinish`
      // can't re-resolve the row (see `WorkerEntry.background` doc).
      try {
        const row = db
          .prepare('SELECT background FROM subagents WHERE jsonl_agent_id = ?')
          .get(agentId) as { background: number } | null
        if (row != null) entry.background = row.background === 1
      } catch { /* best-effort — entry.background stays undefined */ }
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
        // Fix #5: a fresh mtime alone does NOT confirm liveness — a worker
        // killed seconds before this restart looks byte-for-byte identical
        // to a genuinely still-running one. Defer promotion until
        // `checkBootPromotionGrowth` observes the file actually grow AFTER
        // this boot (real proof of life), bounded by the same
        // `inflightPromoteMaxAgeMs` window as an outer timeout. Until then
        // the entry stays `historical` (no stall detection, no completion
        // synthesis) — see checkBootPromotionGrowth / promoteBootEntry.
        entry.bootPromotionPending = { deadlineAt: n + inflightPromoteMaxAgeMs }
        log?.(`subagent-watcher: ${agentId} running at boot (last write ${Math.round(fileAgeMs / 1000)}s ago) — awaiting post-boot JSONL growth before promoting to live (mtime freshness alone can't rule out a just-killed worker)`)
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
        checkBootPromotionGrowth(entry, t, nowFn())
        readSubTail(entry, t, nowFn(), (desc) => {
          log?.(`subagent-watcher: description updated for ${agentId}: ${desc}`)
        }, fs, log, db, parentStateDir, config.onUnstall, cleanupTerminalAgent, config.onProgress)
        maybySendStateTransition(agentId)
      })
    } catch (err) {
      log?.(`subagent-watcher: fs.watch failed for ${agentId}: ${(err as Error).message}`)
    }
  }

  /**
   * Fix #5: the growth-confirmation half of boot promotion. Called on every
   * tick (poll + fs.watch) for an entry that's still awaiting confirmation
   * (`entry.bootPromotionPending` set — see the freshness-gate branch in
   * `registerAgent`). Promotes to live the moment the file's size advances
   * past `tail.cursor` (the boot-time snapshot — the initial full read in
   * `registerAgent` already parked the cursor at EOF-at-boot, so ANY further
   * growth is unambiguously post-boot). If the bounded window elapses with
   * no growth, gives up permanently — the entry stays `historical`, so it
   * can never synthesise a stale `completed` handback from pre-restart bytes
   * (checkStalls / onFinish both gate on `!entry.historical`).
   */
  function checkBootPromotionGrowth(entry: WorkerEntry, tail: SubTail, n: number): void {
    const pending = entry.bootPromotionPending
    if (!pending) return
    let size: number | null = null
    try {
      size = fs.statSync(entry.filePath).size
    } catch {
      /* unreadable — fall through to the deadline check below */
    }
    if (size != null && size > tail.cursor) {
      entry.bootPromotionPending = undefined
      entry.historical = false
      log?.(`subagent-watcher: ${entry.agentId} confirmed live — observed post-boot JSONL growth (${tail.cursor} → ${size} bytes); promoting`)
      // The prior gateway life's registration normally linked
      // jsonl_agent_id already, but re-run the backfill idempotently in
      // case that life crashed before the link persisted — the handback's
      // isBackground lookup is keyed on jsonl_agent_id, and an unlinked row
      // would mis-resolve the worker as foreground and drop the handback.
      if (db != null) {
        try {
          backfillJsonlAgentId(db, entry.filePath, entry.agentId, log)
        } catch (err) {
          log?.(`subagent-watcher: backfill error for ${entry.agentId}: ${(err as Error).message}`)
        }
      }
      // Historical/onProgress gate-ordering fix (carried over from the old
      // synchronous promotion path): the initial read in registerAgent ran
      // while `entry.historical` was still TRUE, so any onProgress cue it
      // would have fired was suppressed, and the cursor is at EOF-at-boot —
      // for a quiet worker no later tick would ever re-fire them. Re-read
      // from the start now that the entry is live: the replayed events
      // rebuild toolCount/lastTool/narrative AND fire onProgress so the
      // worker's card reaches real activity instead of a frozen stub.
      entry.toolCount = 0
      entry.lastTool = null
      entry.pendingNarrative = null
      tail.cursor = 0
      tail.pendingPartial = ''
      tail.hasEmittedStart = false
      readSubTail(entry, tail, n, (desc) => {
        log?.(`subagent-watcher: description updated for ${entry.agentId}: ${desc}`)
      }, fs, log, db, parentStateDir, config.onUnstall, undefined, config.onProgress)
      return
    }
    if (n >= pending.deadlineAt) {
      entry.bootPromotionPending = undefined
      log?.(`subagent-watcher: ${entry.agentId} never observed post-boot JSONL growth within the window — leaving historical/orphan (not promoting; avoids synthesising a stale 'completed' handback from a worker killed before this restart)`)
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
            background: entry.background,
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
            background: entry.background,
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
    //
    // Fix #9a: bound the Set so it can't grow unboundedly over a long-lived
    // gateway — evict the oldest id once the cap is hit (Set iteration
    // order is insertion order, so `.values().next().value` is the oldest).
    if (!terminatedAgentIds.has(agentId) && terminatedAgentIds.size >= terminatedAgentIdsCap) {
      const oldest = terminatedAgentIds.values().next().value
      if (oldest != null) terminatedAgentIds.delete(oldest)
    }
    terminatedAgentIds.add(agentId)
    log?.(`subagent-watcher: cleaned up terminal agent ${agentId}`)
  }

  // ─── Card resurrection (issue #3023) ─────────────────────────────────────

  /**
   * Record a FALSE terminal finish (silent-stall synthesis). Preserves any
   * carried-over `resurrectionCount` from a prior false finish on the same
   * worker (bounded-chain guard) while re-arming the per-finish at-most-once
   * guard. Best-effort file-size snapshot: an unreadable stat records 0, so
   * ANY later readable growth still counts as a resumption.
   */
  function recordFalseFinish(agentId: string, filePath: string, n: number): void {
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch { /* unreadable → 0, any later growth still trips resumption */ }
    const prior = falseFinishTracker.get(agentId)
    if (prior == null && falseFinishTracker.size >= FALSE_FINISH_TRACKER_CAP) {
      const oldest = falseFinishTracker.keys().next().value
      if (oldest != null) falseFinishTracker.delete(oldest)
    }
    falseFinishTracker.set(agentId, {
      filePath,
      synthesisedAt: n,
      sizeAtSynthesis: size,
      resurrectionCount: prior?.resurrectionCount ?? 0,
      resurrectedForThisFinish: false,
      // `lost` is sticky: once a worker is named-lost it stays lost.
      lost: prior?.lost ?? false,
    })
  }

  /**
   * Bring a falsely-finalised worker back to LIVE. Cancels any pending
   * terminal cleanup and clears the terminated/historical suppression, then
   * revives via one of two branches so `onProgress`, stall-detection and a
   * genuine future handback all resume:
   *
   *   1. IN-PLACE REVIVE (registry entry still present — cleanup grace hadn't
   *      elapsed): flip the existing entry back to `running` and reset its
   *      stall/completion flags. The entry KEEPS its existing tail cursor and
   *      FSWatcher, so the card repaints INCREMENTALLY from where it left off —
   *      it does NOT re-read from cursor 0.
   *   2. SWEPT RE-REGISTER (entry already dropped by cleanupTerminalAgent):
   *      `registerAgent` re-registers the JSONL as a fresh non-historical
   *      entry, re-reading from cursor 0 to rebuild the worker's activity so
   *      the revived card catches up instead of showing a frozen stub.
   */
  function resurrectAgent(agentId: string, filePath: string): void {
    const pc = pendingCloses.get(agentId)
    if (pc != null) {
      clearT(pc)
      pendingCloses.delete(agentId)
    }
    terminatedAgentIds.delete(agentId)
    historicalFiles.delete(filePath)

    const existing = registry.get(agentId)
    if (existing != null) {
      // Cleanup grace hadn't elapsed — revive the live entry in place so the
      // existing tail/FSWatcher keeps feeding it.
      existing.state = 'running'
      existing.historical = false
      existing.stallNotified = false
      existing.stalledAt = null
      existing.stallTerminalSynthesised = false
      // Re-arm the completion notification INTENTIONALLY (issue #3023). The
      // false synthesized finish already fired `onFinish` once, delivering a
      // (possibly wrong / incomplete) synthesized handback to the parent.
      // Clearing this lets a genuine future `sub_agent_turn_end` fire `onFinish`
      // a SECOND time — and that is the desired behaviour: the corrected REAL
      // result must reach the parent, superseding the false one. This does NOT
      // double-deliver harmfully: the gateway's handback spool dedups only
      // CONCURRENTLY-LIVE envelopes for the same worker (inbound-spool.ts:
      // `s:handback:<agentId>` — `live.has(id)` guard, no permanent tombstone),
      // so the first (synthesized) handback drains + acks as a normal turn, is
      // removed from the live set, and the later real handback is then
      // delivered as a fresh turn rather than being suppressed. See the
      // "resurrected worker's real turn_end re-fires onFinish" test.
      existing.completionNotified = false
      existing.errored = false
      existing.errorDetail = undefined
      // The worker just proved it is alive (its JSONL grew), so restart the
      // stall clock from now — otherwise the pre-synthesis idle would carry
      // over and a fresh stall/synthesis could fire almost immediately.
      existing.lastActivityAt = nowFn()
      knownFiles.add(filePath)
      // KNOWN LIMITATION (issue #3023): we revive the IN-MEMORY registry entry
      // to `running`, but the subagents DB row stays `completed`/`failed` (the
      // stall-synthesis path wrote a terminal row via recordSubagentEnd). We do
      // NOT flip it back: `recordSubagentResume` only reverses `stalled→running`
      // by design ("terminal beats both stalled and running" — see its doc),
      // and there is no terminal→running edge because the stuck-row reaper and
      // audit consistency both lean on terminal being final. Consequence:
      // `countRunningBackgroundSubagents` (WHERE status='running') UNDERCOUNTS a
      // resurrected worker until its genuine `turn_end` re-terminates the entry.
      // Impact is bounded and benign — that count only gates the deferred-👍
      // reaction promotion (reaction-defer.ts), so at worst a 👍 promotes one
      // resurrection-window early; it is never a delivery/correctness path. Left
      // as a known limitation rather than punching a terminal→running hole in
      // the schema invariant.
      return
    }
    // Entry was already swept — re-register from scratch as a live worker.
    knownFiles.add(filePath)
    registerAgent(filePath, agentId)
  }

  /**
   * Detect post-terminal JSONL resumption for falsely-finalised workers and
   * either resurrect the card (once per false finish) or name the worker lost
   * (bounded chain). Called on every poll tick.
   */
  function checkResurrections(): void {
    const n = nowFn()
    for (const [agentId, rec] of falseFinishTracker) {
      if (rec.lost) continue
      if (rec.resurrectedForThisFinish) continue
      let size: number
      try {
        size = fs.statSync(rec.filePath).size
      } catch {
        continue // file vanished / unreadable — nothing to resurrect
      }
      // Growth past the synthesis snapshot is the proof the worker resumed.
      // (The tracker itself already excludes genuine completions and boot-time
      // historical rediscoveries — they never record here — so size growth is
      // a sufficient signal; no mtime dependence needed.)
      //
      // BOUNDED FALSE-POSITIVE (issue #3023, accepted): ANY byte growth past
      // the snapshot trips resurrection, including a late buffered `turn_end`
      // flush from a genuinely-done worker. If the silent-stall synthesis fired
      // moments before Claude Code finally flushed the worker's real
      // `sub_agent_turn_end` line, that trailing write grows the JSONL and we
      // resurrect a worker that is actually finished — a benign
      // resurrect→immediate-refinish flicker that burns ONE unit of the
      // resurrection budget (MAX_RESURRECTIONS). We accept this because (a) the
      // flicker is self-healing: the very next poll sees the terminal line,
      // fires a real `turn_end`, and re-finalises the card; (b) the corrected
      // real handback still reaches the parent (see the completionNotified
      // reset in resurrectAgent); and (c) the alternative — parsing the tail to
      // distinguish a real turn_end flush from live resumption — is far more
      // fragile than a bounded, harmless re-finish. The chain bound guarantees
      // this can never loop. Covered by the "late turn_end after synthesis"
      // resurrection test.
      if (size <= rec.sizeAtSynthesis) continue

      const entry = registry.get(agentId)
      const description = entry?.description ?? 'sub-agent'

      if (rec.resurrectionCount >= MAX_RESURRECTIONS) {
        // Bounded-chain guard: this worker was already resurrected once and
        // has now falsely finished again. Do NOT resurrect forever — name it
        // lost and stop. One log line names the worker for the operator.
        rec.lost = true
        log?.(`subagent-watcher: worker ${agentId} FALSELY finalised again after a prior resurrection (resurrectionCount=${rec.resurrectionCount} >= ${MAX_RESURRECTIONS}) — NAMED AS LOST, not resurrecting again (bounded resurrection chain, issue #3023)`)
        if (config.onWorkerLost != null) {
          try {
            config.onWorkerLost(agentId, description)
          } catch (cbErr) {
            log?.(`subagent-watcher: onWorkerLost callback error ${agentId}: ${(cbErr as Error).message}`)
          }
        }
        continue
      }

      // Resurrect: at-most-once for THIS false finish.
      rec.resurrectionCount++
      rec.resurrectedForThisFinish = true
      log?.(`subagent-watcher: RESURRECTING worker ${agentId} — JSONL resumed growing (${rec.sizeAtSynthesis} → ${size} bytes) after a false terminal synthesis; the worker is still alive, reviving its card (resurrection #${rec.resurrectionCount}, issue #3023)`)
      // Fire onResurrect FIRST so the gateway clears the feed's finalized
      // gate before the re-registration below replays onProgress ticks —
      // otherwise those first ticks would be swallowed by the finalized gate.
      if (config.onResurrect != null) {
        try {
          config.onResurrect(agentId, description)
        } catch (cbErr) {
          log?.(`subagent-watcher: onResurrect callback error ${agentId}: ${(cbErr as Error).message}`)
        }
      }
      resurrectAgent(agentId, rec.filePath)
    }
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
      // A worker that hasn't fired any tools yet is mid-silent-synthesis; a
      // worker whose LAST tool is a known long-runner (e.g. `Bash`) is mid-
      // command — both legitimately go quiet in the JSONL for minutes, so both
      // use the wider silent-synthesis window instead of the tight 60s active-
      // loop threshold. Without the long-runner arm a background worker running
      // a long `Bash`/`npm test` was falsely flagged "stall detected (idle
      // 60s)" while genuinely alive. Pass-2 terminal synthesis (below) is
      // unaffected: it still fires the fixed window after a stall IS flagged.
      const threshold =
        entry.toolCount === 0 || isLongRunningTool(entry.lastTool?.name)
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
      // In-flight tool-call gate (incident 2026-07-10): a worker whose
      // transcript ends in a `tool_use` with no matching `tool_result`
      // yet is NOT silent — it's *inside* a long tool call (a `Bash`
      // frame-capture loop legally runs 10+ minutes with zero JSONL
      // growth). Synthesising `sub_agent_turn_end` here finalises a live
      // worker's card while it keeps running (real incident: card 16201
      // reaped at t+13min, worker resumed 92ms later with no card).
      //
      // The deferral is CAPPED, not unconditional (design reconciliation
      // with #2777/#2782, whose contract is "a bg worker JSONL that
      // legitimately lacks turn_end must still release the completion
      // gate"): a worker that DIES mid-tool (process killed; JSONL frozen
      // but never deleted) would otherwise defer forever, and the reaper's
      // isLive cross-check would shield it from the DB net too. So: while
      // a tool call is in flight, defer synthesis up to
      // `inflightTerminalCapMs` of total JSONL idle (default 45 min — far
      // above any legitimate single tool call, below the 1h reaper TTL);
      // past the cap, synthesis proceeds. A tool_result landing at any
      // point drains the set and re-arms normal detection via the
      // un-stall path.
      if (entry.inflightToolUseIds.size > 0) {
        const totalIdleMs = n - entry.lastActivityAt
        if (totalIdleMs < inflightTerminalCapMs) {
          log?.(`subagent-watcher: silent-stall terminal synthesis deferred for ${entry.agentId} — ${entry.inflightToolUseIds.size} tool call(s) still in flight, ${Math.floor(totalIdleMs / 1000)}s idle < ${Math.floor(inflightTerminalCapMs / 1000)}s cap (long-running tool, not a dead worker)`)
          continue
        }
        log?.(`subagent-watcher: in-flight deferral cap reached for ${entry.agentId} (${Math.floor(totalIdleMs / 1000)}s idle >= ${Math.floor(inflightTerminalCapMs / 1000)}s cap with ${entry.inflightToolUseIds.size} tool call(s) still unresolved) — treating as died-mid-tool, proceeding with terminal synthesis`)
      }
      // TODO(#3023/PR #3029): the cap-reached path above is a SECOND source of
      // possibly-false terminal synthesis (a worker mid-very-long-tool that is
      // NOT dead gets finalised here). PR #3029 adds `recordFalseFinish(...)`
      // to this synthesis block so a later JSONL resumption can resurrect the
      // card. When #3029 lands, make sure the merge resolution keeps
      // `recordFalseFinish(entry.agentId, entry.filePath, n)` covering BOTH
      // the plain silent-stall path and this cap-reached fall-through (they
      // share this block, so a clean merge does — verify at conflict time).
      // Intentionally NOT wired here to keep this PR standalone (no
      // cross-PR dependency; recordFalseFinish does not exist on this branch).
      entry.stallTerminalSynthesised = true
      entry.state = 'done'
      const postStallSec = Math.floor((n - entry.stalledAt) / 1000)
      const totalIdleSec = Math.floor((n - entry.lastActivityAt) / 1000)
      log?.(`subagent-watcher: silent-stall terminal synthesis for ${entry.agentId} (stalled ${postStallSec}s post-notify, ${totalIdleSec}s total idle) — bg worker JSONL lacks turn_end; synthesising sub_agent_turn_end so deferred-completion gate releases`)
      // Issue #3023: this terminal state is SYNTHESISED, not a real
      // `turn_end` — it may be wrong (the worker could still be alive). Record
      // a false-finish so a later JSONL resumption can resurrect the card. The
      // record survives cleanupTerminalAgent (keyed by agentId, in its own
      // map). A carried-over resurrectionCount from a PRIOR false finish is
      // preserved so the chain stays bounded; resurrectedForThisFinish resets
      // to arm the at-most-once guard for THIS finish.
      recordFalseFinish(entry.agentId, entry.filePath, n)
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

    // Gap 2 (deterministic-turn-liveness.md): re-derive the set of
    // worktree-isolated slugs this agent's own sub-agents may legitimately
    // run in, fresh on every tick. Best-effort — a registry read hiccup
    // (e.g. the worktree dir not existing on an agent that never uses
    // worktrees) must never break the tail loop, so it just yields no
    // extra slugs for this tick.
    let allowedSlugs: Set<string> | null = null
    // Did the extra-cwd provider run cleanly this tick? A transient failure
    // (registry read hiccup) must NOT permanently mislabel an owned worktree
    // slug as "foreign": we still skip it this tick (it isn't provably ours
    // right now), but we do NOT latch the one-shot warning, so the next clean
    // tick re-includes and re-derives it instead of staying silently excluded.
    let providerOk = true
    if (expectedProjectSlug != null) {
      allowedSlugs = new Set([expectedProjectSlug])
      if (extraWatchCwdsProvider != null) {
        try {
          for (const cwd of extraWatchCwdsProvider()) {
            allowedSlugs.add(sanitizeCwdToProjectName(cwd))
          }
        } catch (err) {
          providerOk = false
          log?.(`subagent-watcher: extraWatchCwdsProvider error: ${(err as Error).message}`)
        }
      }
    }

    for (const pDir of projectDirs) {
      // Issue #1116: filter to the agent's own slug (plus, per Gap 2, any
      // worktree-isolated slugs this agent's own sub-agents may run in).
      // Skip foreign project dirs so their stale subagent JSONLs (which
      // Claude Code reaps mid-session) don't pollute the watcher's registry.
      if (allowedSlugs != null && !allowedSlugs.has(pDir)) {
        // A slug that is now allowed must clear any stale "foreign" latch, so a
        // slug that was transiently excluded (or later genuinely goes foreign)
        // re-warns rather than staying mislabeled forever.
        if (providerOk && !warnedForeignSlugs.has(pDir)) {
          warnedForeignSlugs.add(pDir)
          const allowed = [...allowedSlugs].join(', ')
          log?.(`subagent-watcher: skipping foreign project dir ${pDir} (allowed: ${allowed})`)
        }
        continue
      }
      // Owned/allowed this tick — drop any prior foreign latch so a future
      // genuine foreign appearance of the same slug re-warns.
      warnedForeignSlugs.delete(pDir)
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
      // Fix #5: defensive poll-loop fallback for the same growth check the
      // fs.watch callback runs — covers the case where fs.watch missed the
      // event that would otherwise have confirmed liveness.
      checkBootPromotionGrowth(entry, tail, n)
      readSubTail(entry, tail, n, (desc) => {
        log?.(`subagent-watcher: description updated for ${agentId}: ${desc}`)
      }, fs, log, db, parentStateDir, config.onUnstall, cleanupTerminalAgent, config.onProgress)
      maybySendStateTransition(agentId)
    }

    // Stall detection
    checkStalls()

    // Issue #3023: revive any worker whose falsely-finalised card's JSONL has
    // resumed growing (or name it lost if the resurrection chain is spent).
    checkResurrections()
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
      const result = reapStuckRunningRows(db, {
        ttlMs: reaperTtlMs,
        now: nowFn(),
        // Liveness cross-check: never reap a row whose worker the watcher
        // is actively tailing. A live entry is `running`, non-historical,
        // and still in the in-memory registry (cleanupTerminalAgent drops
        // it on real termination). The DB `last_activity_at` freezes during
        // a long in-flight tool call and is NULL when linkage failed — both
        // would otherwise false-positive a live worker as terminal.
        isLive: (jsonlAgentId) => {
          if (jsonlAgentId == null) return false
          const entry = registry.get(jsonlAgentId)
          return entry != null && entry.state === 'running' && !entry.historical
        },
      })
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
