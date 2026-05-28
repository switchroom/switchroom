/**
 * Sidecar reader for $TELEGRAM_STATE_DIR/tool-labels-${session_id}.jsonl —
 * the per-tool-call human labels emitted by the PreToolUse hook
 * `tool-label-pretool.mjs` (#783).
 *
 * Two surfaces:
 *
 *   getLabel(toolUseId): string | undefined
 *     Returns the label if the sidecar has already produced one for this
 *     tool_use. Synchronous, in-memory.
 *
 *   onLabel(cb): unsubscribe
 *     Subscribes to "label arrived for this tool_use_id" notifications,
 *     used by the renderer to re-emit a checklist row when a label
 *     arrives AFTER the matching JSONL `tool_use` has been processed.
 *
 * Design notes:
 *   - Plain stat()-poll watcher (every 250ms) — simpler than fs.watch and
 *     robust to all the platform quirks. The hot path is two-digit ms.
 *   - Append-only: we track a per-file byte offset and only read the new
 *     suffix on each tick, so re-reading is cheap.
 *   - One reader per session_id. The driver instantiates a reader when a
 *     session JSONL is first observed; old readers are stopped when the
 *     session is evicted from the chat-state TTL map.
 *
 * Pure module — no globals. Tests inject a custom directory and clock.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ToolLabelRow {
  ts: number
  tool_use_id: string
  agent_id: string | null
  label: string
  tool_name: string
}

export interface ToolLabelSidecar {
  /** Synchronous label lookup. */
  getLabel(toolUseId: string): string | undefined
  /** Subscribe to "label arrived" notifications. Fires once per new
   *  sidecar line, in real time (~pollMs after the hook's appendFileSync),
   *  independent of when the claude transcript flushes. `toolName` lets
   *  subscribers filter surface tools (reply/react) from a live feed. */
  onLabel(cb: (toolUseId: string, label: string, toolName: string) => void): () => void
  /** Force a re-poll (tests). */
  poll(): void
  /** Stop polling and release resources. */
  stop(): void
}

export interface SidecarOptions {
  stateDir: string
  sessionId: string
  /** Polling interval in ms. Default 250. */
  pollMs?: number
  /** Inject for tests; defaults to setInterval. */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

export function createToolLabelSidecar(opts: SidecarOptions): ToolLabelSidecar {
  const path = join(opts.stateDir, `tool-labels-${opts.sessionId}.jsonl`)
  const labels = new Map<string, string>()
  const subscribers = new Set<(toolUseId: string, label: string, toolName: string) => void>()
  let offset = 0
  let stopped = false

  const sched = opts.scheduler ?? {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }

  function ingestSuffix(text: string): void {
    if (!text) return
    const lines = text.split('\n')
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      let row: ToolLabelRow | null = null
      try {
        row = JSON.parse(line) as ToolLabelRow
      } catch {
        continue
      }
      if (
        !row ||
        typeof row.tool_use_id !== 'string' ||
        typeof row.label !== 'string' ||
        typeof row.tool_name !== 'string'
      ) continue
      // First write wins — sidecar lines are append-only and we don't
      // expect duplicates, but if one lands we keep the earliest.
      if (labels.has(row.tool_use_id)) continue
      labels.set(row.tool_use_id, row.label)
      for (const cb of subscribers) {
        try { cb(row.tool_use_id, row.label, row.tool_name) } catch { /* ignore */ }
      }
    }
  }

  function poll(): void {
    if (stopped) return
    if (!existsSync(path)) return
    let size = 0
    try { size = statSync(path).size } catch { return }
    if (size <= offset) {
      // Truncation safety: if the file shrank (rotation / manual delete),
      // reset offset so we re-read from the start.
      if (size < offset) offset = 0
      else return
    }
    let text = ''
    try {
      const buf = readFileSync(path)
      text = buf.subarray(offset).toString('utf8')
      offset = buf.length
    } catch {
      return
    }
    ingestSuffix(text)
  }

  // Initial drain, in case the file already exists when we start.
  poll()
  const handle = sched.setInterval(poll, opts.pollMs ?? 250) as unknown

  return {
    getLabel(toolUseId) {
      return labels.get(toolUseId)
    },
    onLabel(cb) {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    poll,
    stop() {
      if (stopped) return
      stopped = true
      try { sched.clearInterval(handle) } catch { /* ignore */ }
      subscribers.clear()
    },
  }
}
