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
import { projectSubagentLine } from './session-tail.js'
import { escapeHtml, truncate } from './card-format.js'
import { bumpSubagentActivity, recordSubagentStall, recordSubagentEnd } from './registry/subagents-schema.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal DB interface needed by the watcher for Phase 3 liveness writes.
 * Typed as a structural duck-type so tests can pass an in-memory stub
 * without importing bun:sqlite directly.
 */
export interface SubagentLivenessDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
  }
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
  /** True once a completion notification has been sent. */
  completionNotified: boolean
  /** Short summary from last completed tool / narrative, for completion message. */
  lastSummaryLine: string
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
   * Send a fresh (non-edit) Telegram message. For stall / completion
   * state-transition notifications.
   */
  sendNotification: (text: string) => void
  /**
   * How often to re-scan for new subagent dirs (ms). Default 1000.
   */
  rescanMs?: number
  /**
   * How long without JSONL activity before a worker is considered stalled (ms).
   * Default 60_000.
   */
  stallThresholdMs?: number
  /**
   * Optional registry DB for Phase 3 liveness writes. When provided, the
   * watcher calls `bumpSubagentActivity` each time a sub-agent JSONL grows
   * (i.e. mtime advances). If the matching row does not yet exist (Phase 2
   * Pre hook hasn't fired), the UPDATE is a no-op and the event is logged.
   * Passing `null` or omitting this field disables DB writes entirely.
   */
  db?: SubagentLivenessDb | null
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
    if (db != null) {
      try {
        const existing = db
          .prepare('SELECT id FROM subagents WHERE jsonl_agent_id = ?')
          .get(entry.agentId) as { id: string } | null
        if (existing == null) {
          log?.(`subagent-watcher: liveness skip ${entry.agentId} — row not in DB yet (Phase 2 Pre hook pending)`)
        } else {
          bumpSubagentActivity(db, { id: existing.id, ts: now })
        }
      } catch (dbErr) {
        log?.(`subagent-watcher: liveness write error ${entry.agentId}: ${(dbErr as Error).message}`)
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
        entry.lastActivityAt = now
        if (ev.kind === 'sub_agent_tool_use') {
          entry.toolCount++
        } else if (ev.kind === 'sub_agent_text') {
          // Do NOT overwrite description with narrative text — description is
          // set at dispatch time (from the parent Agent/Task tool_use input)
          // and must remain stable. Overwriting it with the sub-agent's first
          // narrative line caused a race-condition-dependent display (issue #352).
          entry.lastSummaryLine = ev.text.split('\n')[0].trim().slice(0, 120)
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
  const stallThresholdMs = config.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
  const rescanMs = config.rescanMs ?? DEFAULT_RESCAN_MS
  const log = config.log
  const db = config.db ?? null
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
      completionNotified: false,
      lastSummaryLine: '',
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
    }, fs, log, db)

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
        }, fs, log, db)
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
      scheduleTerminalCleanup(agentId)
    }
    // Defensive: if state ever flips to 'failed' (currently no caller
    // sets this, but the type allows it), still clean up the FSWatcher.
    if (entry.state === 'failed') {
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
    log?.(`subagent-watcher: cleaned up terminal agent ${agentId}`)
  }

  // ─── Stall detection ────────────────────────────────────────────────────

  function checkStalls(): void {
    const n = nowFn()
    for (const entry of registry.values()) {
      if (entry.state !== 'running') continue
      if (entry.historical) continue
      if (entry.stallNotified) continue
      const idleMs = n - entry.lastActivityAt
      if (idleMs >= stallThresholdMs) {
        entry.stallNotified = true
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
      knownFiles.add(filePath)
      // During the initial boot scan, mark every discovered file as
      // historical so stall-detection and completion notifications are
      // suppressed for pre-existing JSONLs (months of session history
      // would otherwise flood the chat on every restart).
      if (bootScanInProgress) {
        historicalFiles.add(filePath)
      }
      const agentId = e.slice('agent-'.length, -'.jsonl'.length)
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
      }, fs, log, db)
      maybySendStateTransition(agentId)
    }

    // Stall detection
    checkStalls()
  }

  // Initial boot scan: discover pre-existing files and mark them historical
  // so we don't replay stalls or past completions for past sessions.
  rescanSubagentDirs()
  bootScanInProgress = false

  const pollHandle = setI(poll, rescanMs)

  return {
    stop(): void {
      stopped = true
      clearI(pollHandle)
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
    },

    getRegistry(): ReadonlyMap<string, WorkerEntry> {
      return registry
    },
  }
}
