/**
 * Tails Claude Code's per-session JSONL file in real time and emits
 * structured turn-lifecycle events.
 *
 * Why this exists: Claude Code's `--channels` daemon mode does NOT support
 * `--output-format stream-json`, so we can't get streaming events from
 * stdout. But Claude Code DOES write a transcript file to disk under
 * `$CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/<sessionId>.jsonl`, flushed
 * every 100ms (verified from cli.js source). Each line is one event:
 *
 *   - { type: "queue-operation", operation: "enqueue" | "dequeue", content }
 *   - { type: "user", message: { content: [{ type: "tool_result", tool_use_id }] }}
 *   - { type: "assistant", message: { content: [{ type: "tool_use", name, ... }, { type: "thinking" }, { type: "text", text }] }}
 *   - { type: "system", subtype: "turn_duration", durationMs }
 *
 * Per-token text deltas are NOT in this file — assistant messages are
 * written whole, after the SDK call completes. So we get richer reaction
 * states (thinking → tool_use → reply → done) but not character streaming.
 *
 * The cwd encoding mirrors Claude Code's `VX()` helper: every non-alphanumeric
 * char in the original cwd becomes a `-`. We replicate that here so we can
 * locate the projects dir without parsing TUI output or shelling out.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { isMultiAgentEnabled } from './progress-card.js'

/** Match Claude Code's cli.js VX() function. */
export function sanitizeCwdToProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Resolve the projects directory for a given cwd. */
export function getProjectsDirForCwd(
  cwd: string = process.cwd(),
  claudeHome: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
): string {
  return join(claudeHome, 'projects', sanitizeCwdToProjectName(cwd))
}

/**
 * Find the session file Claude Code is currently writing to. Returns the
 * most recently modified .jsonl in the projects dir, or null if none yet
 * exists. Re-call this periodically — Claude Code may rotate to a new
 * session id mid-process (compaction, /clear).
 */
export function findActiveSessionFile(projectsDir: string): string | null {
  if (!existsSync(projectsDir)) return null
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return null
  }
  let bestPath: string | null = null
  let bestMtime = 0
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue
    const p = join(projectsDir, e)
    try {
      const s = statSync(p)
      if (s.mtimeMs > bestMtime) {
        bestMtime = s.mtimeMs
        bestPath = p
      }
    } catch { /* ignore */ }
  }
  return bestPath
}

// ─── Event types we project up to consumers ─────────────────────────────────

export type SessionEvent =
  | { kind: 'enqueue'; chatId: string | null; messageId: string | null; threadId: string | null; rawContent: string }
  | { kind: 'dequeue' }
  | { kind: 'thinking' }
  | { kind: 'tool_use'; toolName: string; toolUseId?: string | null; input?: Record<string, unknown> }
  | { kind: 'text'; text: string }
  | { kind: 'tool_result'; toolUseId: string; toolName: string | null; isError?: boolean }
  | { kind: 'turn_end'; durationMs: number }
  // Multi-agent: sub-agent-scoped events. agentId is the sub-agent JSONL
  // filename stem (e.g. "aac6f1…"). Routed through the same ingest path
  // as parent events; the reducer fans them out to per-sub-agent state.
  | { kind: 'sub_agent_started'; agentId: string; firstPromptText: string; subagentType?: string }
  | { kind: 'sub_agent_tool_use'; agentId: string; toolUseId: string | null; toolName: string; input?: Record<string, unknown> }
  | { kind: 'sub_agent_tool_result'; agentId: string; toolUseId: string; isError?: boolean }
  | { kind: 'sub_agent_turn_end'; agentId: string }
  | { kind: 'sub_agent_nested_spawn'; agentId: string }

/**
 * Parse the inbound channel XML wrapper to pull out chat_id, message_id,
 * and message_thread_id. The MCP plugin produces this XML on every
 * inbound notification, so it's reliably present in queue-operation enqueue.
 */
function parseChannelMeta(content: string): {
  chatId: string | null
  messageId: string | null
  threadId: string | null
} {
  // Look for `chat_id="..."` etc in the channel XML tag
  const grab = (key: string): string | null => {
    const m = content.match(new RegExp(`${key}="([^"]+)"`))
    return m ? m[1] : null
  }
  return {
    chatId: grab('chat_id'),
    messageId: grab('message_id'),
    threadId: grab('message_thread_id'),
  }
}

/**
 * Project a single transcript line into a SessionEvent (or null if it's
 * uninteresting noise). Caller is responsible for the JSON parse — if a
 * line is not valid JSON we skip it.
 */
export function projectTranscriptLine(line: string): SessionEvent[] {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line)
  } catch {
    return []
  }
  const type = obj.type as string | undefined
  if (!type) return []

  // queue-operation: inbound message lifecycle
  if (type === 'queue-operation') {
    const op = obj.operation as string | undefined
    if (op === 'enqueue') {
      const content = (obj.content as string | undefined) ?? ''
      const { chatId, messageId, threadId } = parseChannelMeta(content)
      return [{ kind: 'enqueue', chatId, messageId, threadId, rawContent: content }]
    }
    if (op === 'dequeue') {
      return [{ kind: 'dequeue' }]
    }
    return []
  }

  // assistant: turn output (thinking, text, tool_use)
  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) return []
    const events: SessionEvent[] = []
    for (const c of content) {
      const ct = c.type as string | undefined
      if (ct === 'thinking') {
        events.push({ kind: 'thinking' })
      } else if (ct === 'tool_use') {
        const input = c.input as Record<string, unknown> | undefined
        events.push({
          kind: 'tool_use',
          toolName: (c.name as string | undefined) ?? '',
          // Claude Code content blocks carry a stable `id` for each
          // tool_use (e.g. "toolu_01ABC..."). Surfacing it here lets
          // the progress-card reducer pair tool_result events by id
          // instead of by running-item order, which is the only
          // correct pairing when the model emits parallel tool_use
          // calls within a single assistant message.
          toolUseId: (c.id as string | undefined) ?? null,
          input: input && typeof input === 'object' ? input : undefined,
        })
      } else if (ct === 'text') {
        const text = (c.text as string | undefined) ?? ''
        events.push({ kind: 'text', text })
      }
    }
    return events
  }

  // user: contains tool_results
  if (type === 'user') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) return []
    const events: SessionEvent[] = []
    for (const c of content) {
      if (c.type === 'tool_result') {
        events.push({
          kind: 'tool_result',
          toolUseId: (c.tool_use_id as string | undefined) ?? '',
          toolName: null,
          isError: c.is_error === true ? true : undefined,
        })
      }
    }
    return events
  }

  // system turn_duration: marks the end of a turn (after the model has
  // produced its final response — useful as a backstop for "done")
  if (type === 'system' && obj.subtype === 'turn_duration') {
    return [
      { kind: 'turn_end', durationMs: (obj.durationMs as number | undefined) ?? 0 },
    ]
  }

  return []
}

/**
 * Project a single line from a sub-agent JSONL into SessionEvent(s).
 *
 * Sub-agent JSONLs (under `<sessionId>/subagents/agent-<agentId>.jsonl`)
 * use the same line shapes as the parent transcript but with `isSidechain: true`
 * and an `agentId` field on every line. The first `type=user` message in
 * the file holds the full prompt text the parent passed in via the
 * `Agent` tool — that's our correlation key.
 *
 * Caller passes the `agentId` extracted from the filename and a stateful
 * `hasEmittedStart` flag (one per file) so the very first user message
 * fires `sub_agent_started` exactly once. Subsequent user messages carry
 * tool_results.
 *
 * Sub-agents that themselves spawn more Agent/Task calls fire a
 * `sub_agent_nested_spawn` event so the parent sub-agent line can render
 * `(spawned N)`. We do NOT expose nested sub-agent activity as top-level
 * rows — the design doc explicitly punts on recursion (§5.5).
 */
export function projectSubagentLine(
  line: string,
  agentId: string,
  state: { hasEmittedStart: boolean },
): SessionEvent[] {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line)
  } catch {
    return []
  }
  const type = obj.type as string | undefined
  if (!type) return []

  if (type === 'user') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = message?.content
    // First user message: the prompt body. Claude Code writes it as a
    // string for the kickoff message, then as content arrays of
    // tool_results for subsequent user messages.
    if (!state.hasEmittedStart) {
      state.hasEmittedStart = true
      let promptText = ''
      if (typeof content === 'string') {
        promptText = content
      } else if (Array.isArray(content)) {
        // Some shapes wrap the prompt in a [{type: 'text', text: '…'}]
        // block. Handle defensively.
        for (const c of content) {
          if (typeof c === 'object' && c != null && (c as Record<string, unknown>).type === 'text') {
            promptText = String((c as Record<string, unknown>).text ?? '')
            break
          }
        }
      }
      return [{ kind: 'sub_agent_started', agentId, firstPromptText: promptText }]
    }
    // Subsequent user messages = tool_results
    if (!Array.isArray(content)) return []
    const events: SessionEvent[] = []
    for (const c of content) {
      if (typeof c !== 'object' || c == null) continue
      const cc = c as Record<string, unknown>
      if (cc.type === 'tool_result') {
        events.push({
          kind: 'sub_agent_tool_result',
          agentId,
          toolUseId: (cc.tool_use_id as string | undefined) ?? '',
          isError: cc.is_error === true ? true : undefined,
        })
      }
    }
    return events
  }

  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) return []
    const events: SessionEvent[] = []
    for (const c of content) {
      const ct = c.type as string | undefined
      if (ct === 'tool_use') {
        const name = (c.name as string | undefined) ?? ''
        // Nested Agent/Task call inside a sub-agent: track ONLY as a
        // nested_spawn count (renders as "(spawned N)" suffix on the
        // parent sub-agent line). Per design §5.5 we do NOT expose
        // sub-sub-agent activity as the parent sub-agent's currentTool —
        // that would surface the sub-sub-agent's description and break
        // the "no recursion in rendering" rule.
        if (name === 'Agent' || name === 'Task') {
          events.push({ kind: 'sub_agent_nested_spawn', agentId })
        } else {
          events.push({
            kind: 'sub_agent_tool_use',
            agentId,
            toolUseId: (c.id as string | undefined) ?? null,
            toolName: name,
            input: (c.input as Record<string, unknown> | undefined) ?? undefined,
          })
        }
      }
    }
    return events
  }

  if (type === 'system' && obj.subtype === 'turn_duration') {
    return [{ kind: 'sub_agent_turn_end', agentId }]
  }

  return []
}

// ─── The tail watcher ─────────────────────────────────────────────────────

export interface SessionTailConfig {
  /** Working directory of the Claude Code process. Defaults to process.cwd(). */
  cwd?: string
  /** CLAUDE_CONFIG_DIR override. Defaults to env or ~/.claude. */
  claudeHome?: string
  /** How often to re-scan for a new active session file (ms). Default 500. */
  rescanIntervalMs?: number
  /** Optional logger. */
  log?: (msg: string) => void
  /** Called for each parsed event. */
  onEvent: (event: SessionEvent) => void
}

export interface SessionTailHandle {
  stop(): void
  /** Returns the current active file path, or null if none. */
  getActiveFile(): string | null
}

/**
 * Start tailing the active Claude Code session file. The tailer:
 *  1. Polls the projects dir for the most recent .jsonl
 *  2. Opens it, seeks to current end (only NEW events are reported), and
 *     watches for size changes via fs.watch() — falling back to a 100ms
 *     poll on systems where fs.watch is unreliable (network mounts, WSL).
 *  3. On each size change, reads the appended bytes, splits on newlines,
 *     parses each line, projects to SessionEvents, fires onEvent.
 *  4. If a NEWER session file appears, re-targets it (catches /clear and
 *     compaction-driven rotations).
 */
export function startSessionTail(config: SessionTailConfig): SessionTailHandle {
  const cwd = config.cwd ?? process.cwd()
  const claudeHome = config.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const projectsDir = getProjectsDirForCwd(cwd, claudeHome)
  const rescanMs = config.rescanIntervalMs ?? 500
  const log = config.log
  const onEvent = config.onEvent

  log?.(`session-tail: projectsDir=${projectsDir}`)

  let currentFile: string | null = null
  let cursor = 0 // byte offset of next read
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let pendingPartial = '' // last read may end mid-line; stash for next read

  // Per-file cursor + partial bookkeeping. This is the Bug 1 fix: when
  // Claude Code's Agent/Task tool spawns a sub-agent, that sub-agent
  // writes its OWN session JSONL which briefly becomes newest-mtime in
  // the projects dir. Without per-file tracking, `findActiveSessionFile`
  // flips to the sub-agent JSONL, `attachToFile` seeks to its end, and
  // when the parent JSONL reclaims newest-mtime we'd seek to ITS end
  // too — missing every event written while we were attached elsewhere
  // (critical ones like tool_result and turn_end). Tracking cursors per
  // file by absolute path lets us pick up exactly where we left off on
  // re-attach.
  const fileCursors = new Map<string, { cursor: number; pendingPartial: string }>()

  function readNew(): void {
    if (stopped || !currentFile) return
    try {
      const stat = statSync(currentFile)
      if (stat.size < cursor) {
        // File was truncated/replaced — reset cursor and clear any
        // stored per-file state for this path.
        cursor = 0
        pendingPartial = ''
        if (currentFile != null) fileCursors.delete(currentFile)
      }
      if (stat.size === cursor) return
      const buf = Buffer.alloc(stat.size - cursor)
      const fd = openSync(currentFile, 'r')
      try {
        readSync(fd, buf, 0, buf.length, cursor)
      } finally {
        closeSync(fd)
      }
      cursor = stat.size
      const text = pendingPartial + buf.toString('utf-8')
      // Last segment may be a partial line if the writer flushed mid-line
      const lines = text.split('\n')
      pendingPartial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        const events = projectTranscriptLine(line)
        for (const ev of events) {
          try {
            onEvent(ev)
          } catch (err) {
            log?.(`session-tail: onEvent threw: ${(err as Error).message}`)
          }
        }
      }
    } catch (err) {
      log?.(`session-tail: read failed: ${(err as Error).message}`)
    }
  }

  function attachToFile(file: string): void {
    if (currentFile === file) return
    // Save state for the file we're switching AWAY from, so that if we
    // later re-attach (e.g. a sub-agent briefly led on mtime, now the
    // parent leads again) we resume from exactly where we stopped.
    if (currentFile != null) {
      fileCursors.set(currentFile, { cursor, pendingPartial })
    }
    if (watcher) {
      try { watcher.close() } catch { /* ignore */ }
      watcher = null
    }
    currentFile = file
    const prior = fileCursors.get(file)
    if (prior != null) {
      // Re-attach: pick up exactly where we left off so we don't skip
      // events written while we were watching a different file.
      cursor = prior.cursor
      pendingPartial = prior.pendingPartial
      log?.(`session-tail: re-attached to ${file} (cursor=${cursor}, restored)`)
    } else {
      // First attach to this file — seek to current end so we only see
      // new events, not history.
      pendingPartial = ''
      try {
        cursor = statSync(file).size
      } catch {
        cursor = 0
      }
      log?.(`session-tail: attached to ${file} (cursor=${cursor})`)
    }
    try {
      watcher = watch(file, () => readNew())
    } catch (err) {
      log?.(`session-tail: fs.watch failed (${(err as Error).message}), polling instead`)
    }
  }

  // ─── Sub-agent JSONL tailing (multi-agent path, gated by feature flag) ──
  //
  // Each sub-agent gets its own per-file tailer keyed by absolute path.
  // We poll the `<sessionId>/subagents/` directory on every rescan (cheap,
  // a few stat calls) so newly-created sub-agent JSONLs are picked up
  // even when fs.watch on the parent dir is unreliable. Once attached,
  // a per-file watch + cursor handles incremental reads exactly the way
  // the parent tail does — and exactly the same per-file cursor map
  // pattern from PR #25 protects against re-attach truncation.
  const multiAgent = isMultiAgentEnabled()

  interface SubTail {
    agentId: string
    file: string
    cursor: number
    pendingPartial: string
    hasEmittedStart: boolean
    watcher: FSWatcher | null
  }
  const subTails = new Map<string, SubTail>() // keyed by absolute file path

  function readSub(t: SubTail): void {
    if (stopped) return
    try {
      const stat = statSync(t.file)
      if (stat.size < t.cursor) {
        t.cursor = 0
        t.pendingPartial = ''
      }
      if (stat.size === t.cursor) return
      const buf = Buffer.alloc(stat.size - t.cursor)
      const fd = openSync(t.file, 'r')
      try {
        readSync(fd, buf, 0, buf.length, t.cursor)
      } finally {
        closeSync(fd)
      }
      t.cursor = stat.size
      const text = t.pendingPartial + buf.toString('utf-8')
      const lines = text.split('\n')
      t.pendingPartial = lines.pop() ?? ''
      const startState = { hasEmittedStart: t.hasEmittedStart }
      for (const line of lines) {
        if (!line) continue
        const events = projectSubagentLine(line, t.agentId, startState)
        for (const ev of events) {
          try {
            onEvent(ev)
          } catch (err) {
            log?.(`session-tail: sub onEvent threw: ${(err as Error).message}`)
          }
        }
      }
      t.hasEmittedStart = startState.hasEmittedStart
    } catch (err) {
      log?.(`session-tail: sub read failed: ${(err as Error).message}`)
    }
  }

  function attachSub(file: string, agentId: string): void {
    if (subTails.has(file)) return
    let cursor = 0
    try {
      cursor = statSync(file).size
    } catch { /* ignore */ }
    // Sub-agent JSONLs are typically created and immediately written; we
    // start at byte 0 so we DON'T miss the first user-message line that
    // carries the prompt text needed for correlation. This differs from
    // the parent tail which seeks to end (parent has long history).
    const t: SubTail = {
      agentId,
      file,
      cursor: 0, // intentionally 0: read from start to capture prompt
      pendingPartial: '',
      hasEmittedStart: false,
      watcher: null,
    }
    void cursor
    try {
      t.watcher = watch(file, () => readSub(t))
    } catch (err) {
      log?.(`session-tail: sub fs.watch failed (${(err as Error).message})`)
    }
    subTails.set(file, t)
    log?.(`session-tail: attached sub ${agentId} (${file})`)
    readSub(t)
  }

  /**
   * Sub-agent dir lives next to the parent JSONL: if the parent file is
   * `<projectsDir>/<sessionId>.jsonl`, sub-agents live under
   * `<projectsDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
   *
   * Claude Code 2.1.x has been observed to use this layout. If a future
   * release renames `agent-*.jsonl`, the glob check below is the only
   * place to update.
   */
  function rescanSubagents(): void {
    if (!multiAgent) return
    if (!currentFile) return
    const sessionId = basename(currentFile, '.jsonl')
    const subDir = join(projectsDir, sessionId, 'subagents')
    if (!existsSync(subDir)) return
    let entries: string[]
    try {
      entries = readdirSync(subDir)
    } catch { return }
    for (const e of entries) {
      if (!e.startsWith('agent-') || !e.endsWith('.jsonl')) continue
      const agentId = e.slice('agent-'.length, -'.jsonl'.length)
      const file = join(subDir, e)
      if (!subTails.has(file)) {
        attachSub(file, agentId)
      } else {
        // Already attached — defensive read in case fs.watch missed.
        readSub(subTails.get(file)!)
      }
    }
  }

  function rescan(): void {
    if (stopped) return
    const file = findActiveSessionFile(projectsDir)
    if (!file) return
    if (file !== currentFile) {
      attachToFile(file)
    }
    // Always read in case fs.watch missed an event (common on WSL/network mounts)
    readNew()
    rescanSubagents()
  }

  // Initial pass
  rescan()
  pollTimer = setInterval(rescan, rescanMs)

  return {
    stop(): void {
      stopped = true
      if (watcher) {
        try { watcher.close() } catch { /* ignore */ }
        watcher = null
      }
      for (const t of subTails.values()) {
        if (t.watcher) {
          try { t.watcher.close() } catch { /* ignore */ }
          t.watcher = null
        }
      }
      subTails.clear()
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    },
    getActiveFile(): string | null {
      return currentFile
    },
  }
}
