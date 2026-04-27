/**
 * Background sub-agent visibility — registry + directory watcher.
 *
 * Watches the subagents/ directory under each active session dir for new
 * agent-<id>.jsonl files. For each discovered sub-agent it:
 *   1. Registers it in an in-memory registry.
 *   2. Tails the JSONL to count tool calls and detect turn_end.
 *   3. Emits inline notifications for dispatch / stall / completion events.
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
  type FSWatcher,
} from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { projectSubagentLine } from './session-tail.js'
import { escapeHtml, truncate } from './card-format.js'

// ─── Types ───────────────────────────────────────────────────────────────────

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
   * Send a fresh (non-edit) Telegram message. For dispatch / completion / stall
   * notifications.
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
  /** Optional logger for debug output. */
  log?: (msg: string) => void
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

function readSubTail(
  entry: WorkerEntry,
  tail: SubTail,
  now: number,
  onDescriptionUpdate: (desc: string) => void,
  fs: FsLike,
  log?: (msg: string) => void,
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
          // Use first narrative text as description if we haven't set one yet.
          if (!entry.description || entry.description === 'sub-agent') {
            const line1 = ev.text.split('\n')[0].trim()
            if (line1) {
              entry.description = line1.length > 80 ? line1.slice(0, 79) + '…' : line1
              onDescriptionUpdate(entry.description)
            }
          }
          entry.lastSummaryLine = ev.text.split('\n')[0].trim().slice(0, 120)
        } else if (ev.kind === 'sub_agent_turn_end') {
          if (entry.state === 'running') {
            entry.state = 'done'
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
  const nowFn = config.now ?? (() => Date.now())

  const setI = config.setInterval ?? ((fn, ms) => {
    const h = setInterval(fn, ms)
    return { ref: h }
  })
  const clearI = config.clearInterval ?? ((ref) => {
    clearInterval((ref as { ref: ReturnType<typeof setInterval> }).ref)
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
  /**
   * Files that existed before the watcher started (boot-time snapshot).
   * Agents discovered from these files are tracked for state transitions
   * but do NOT fire a "Worker dispatched" notification — they are historical.
   */
  const historicalFiles = new Set<string>()
  /**
   * True while the initial boot scan is running. During this window every
   * newly discovered file is added to historicalFiles so we can suppress
   * dispatch notifications for them.
   */
  let bootScanInProgress = true

  let stopped = false

  // ─── Per-agent registration ─────────────────────────────────────────────

  function registerAgent(filePath: string, agentId: string): void {
    if (registry.has(agentId)) return
    const n = nowFn()
    const isHistorical = historicalFiles.has(filePath)
    log?.(`subagent-watcher: registering agent ${agentId}${isHistorical ? ' (historical — no dispatch notification)' : ''}`)

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
    }, fs, log)

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
      // don't fire a spurious completion notification later.
      entry.completionNotified = true
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
        }, fs, log)
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
    }
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
        try {
          config.sendNotification(`⚠ Worker idle: ${desc} (no activity for ${idleSec}s)`)
        } catch (err) {
          log?.(`subagent-watcher: stall notification error: ${(err as Error).message}`)
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
      // historical so registerAgent suppresses the dispatch notification.
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
      }, fs, log)
      maybySendStateTransition(agentId)
    }

    // Stall detection
    checkStalls()
  }

  // Initial boot scan: discover pre-existing files and mark them historical
  // so their registration does not emit spurious dispatch notifications.
  rescanSubagentDirs()
  bootScanInProgress = false

  const pollHandle = setI(poll, rescanMs)

  return {
    stop(): void {
      stopped = true
      clearI(pollHandle)
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
