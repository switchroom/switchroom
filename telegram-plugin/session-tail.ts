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
import { join } from 'path'

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

  function readNew(): void {
    if (stopped || !currentFile) return
    try {
      const stat = statSync(currentFile)
      if (stat.size < cursor) {
        // File was truncated/replaced — reset cursor
        cursor = 0
        pendingPartial = ''
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
    if (watcher) {
      try { watcher.close() } catch { /* ignore */ }
      watcher = null
    }
    currentFile = file
    pendingPartial = ''
    // Seek to the current end so we only see new events, not history
    try {
      cursor = statSync(file).size
    } catch {
      cursor = 0
    }
    log?.(`session-tail: attached to ${file} (cursor=${cursor})`)
    try {
      watcher = watch(file, () => readNew())
    } catch (err) {
      log?.(`session-tail: fs.watch failed (${(err as Error).message}), polling instead`)
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
