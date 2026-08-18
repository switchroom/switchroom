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
// #1122 PR3: inlined from the deleted progress-card.ts. Kill switch
// for the sub-agent transcript watcher (PROGRESS_CARD_MULTI_AGENT=0
// disables it). Name retained for back-compat with operator configs.
function isMultiAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROGRESS_CARD_MULTI_AGENT !== '0'
}
import { classifyClaudeError, type OperatorEventKind } from './operator-events.js'
import { isLitellmProxyLocal429, isTransientUpstreamSignal } from './model-unavailable.js'
import { isConnectionDropText } from './connection-drop.js'
import { createToolLabelSidecar, type ToolLabelSidecar, type SidecarOptions } from './tool-label-sidecar.js'
import { isModelSentinel } from './model-label.js'

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
  | { kind: 'enqueue'; chatId: string | null; messageId: string | null; threadId: string | null; rawContent: string; isSync?: boolean }
  | { kind: 'dequeue' }
  // #3927 — `queue-operation` op `remove`: the queued item was folded into the
  // ALREADY-RUNNING turn as a `queued_command` attachment rather than drained
  // into a new turn. It is the OTHER terminal of an `enqueue` (the CLI writes
  // exactly one of `dequeue` / `remove` per enqueue), and unlike `dequeue` it
  // REPLAYS the enqueue's `content` byte-for-byte — which is what lets the
  // gateway discard the right parked turn-start by identity.
  | { kind: 'queue_remove'; rawContent: string }
  | { kind: 'thinking' }
  // Live model in use for the MAIN session, extracted from `message.model` on
  // each `type:"assistant"` transcript line (the exact model that served that
  // API call). Emitted FIRST among a line's events so a card rendered on the
  // same batch already reflects the current model. Sentinels (`<synthetic>` on
  // compaction lines, fixture junk) are filtered at projection — see
  // isModelSentinel — so this only ever carries a real resolved model id.
  // `replayed: true` marks a model observation delivered by the FIRST-ATTACH
  // replay of a prior session's in-flight turn (computeFirstAttachCursor) —
  // it reflects the PRE-restart session's model, not the live one. Consumers
  // that verify the live model (#3427 divergence tripwire, H2) must skip
  // replayed observations; freshness consumers may still record them.
  | { kind: 'model'; model: string; replayed?: boolean }
  | { kind: 'tool_use'; toolName: string; toolUseId?: string | null; input?: Record<string, unknown>; precomputedLabel?: string }
  // Real-time tool label from the PreToolUse-hook sidecar — fires when the
  // hook writes the label (synchronous at tool-call time), independent of
  // the lazily-flushed transcript. The draft-mirror drives off THIS, not
  // the flush-gated `tool_use`, so activity streams deterministically.
  | { kind: 'tool_label'; toolUseId: string; label: string; toolName: string }
  // `blockIndex` = index of this text block in the assistant message's
  // content[] — load-bearing: it keys the returned Map so callers emit
  // events in source order. `lastInMessage` = true iff no tool_use block
  // follows it in the SAME message. NOTE: `lastInMessage` is a PROJECTION
  // ARTIFACT only — the current reducer-side narrative-dedup gate
  // (narrative-dedup.ts) decides draft-then-send vs working-narration by
  // LOOKAHEAD (the next tool_use / turn_end), NOT by reading this flag. It
  // is retained as a stable projection output (pinned by the kernel test)
  // and reserved for a future staging-skip optimization; do not assume the
  // gate keys on it.
  | { kind: 'text'; text: string; blockIndex: number; lastInMessage: boolean }
  // Per-assistant-message token usage for the MAIN agent, extracted from
  // `message.usage` on each `type:"assistant"` transcript line. `totalTokens`
  // is the NEW-work delta for THIS message (input + output + cache_creation,
  // via sumUsageTokens; cache_read is deliberately excluded — replayed cached
  // context, not new work). `messageId` is `message.id` —
  // REQUIRED for dedup: Claude Code persists one logical assistant message as
  // MULTIPLE JSONL lines sharing one `message.id`, each stamped with the SAME
  // `usage` block, so the accumulator must count a given `messageId` only once
  // (naive summing across lines over-counts). Null messageId → un-dedupable,
  // counted as-is. Mirrors `sub_agent_usage` but for the parent's OWN tokens.
  | { kind: 'usage'; messageId: string | null; totalTokens: number }
  | { kind: 'tool_result'; toolUseId: string; toolName: string | null; isError?: boolean; errorText?: string
      /**
       * #3519 sharpen: the claude-CLI background-task id when THIS tool_result
       * is the launch acknowledgement of a shell moved to the background (a
       * foreground Bash that exceeded the CLI foreground window, or an explicit
       * run_in_background:true). Sourced PRIMARILY from the structured
       * top-level `toolUseResult.backgroundTaskId` field (version-robust), with
       * a regex on the `content` string as a secondary. Absent on ordinary
       * (completed-in-foreground) tool_results. Marks the shell ALIVE. */
      backgroundTaskId?: string }
  /**
   * #3519 sharpen: a claude-CLI `<task-notification>` — the proactive
   * completion signal the CLI enqueues when a backgrounded shell finishes
   * (`<status>completed</status>`) or errors. Marks the shell DEAD, restoring
   * ~300s wedge recovery once the launching bash is no longer running.
   */
  | { kind: 'task_notification'; taskId: string; status: string }
  // #4058 — system compact_boundary: the CLI finished compacting the session
  // mid-turn (the record is written at compaction END — it embeds the
  // compaction's own durationMs). Consumed by silence-poke wiring to clear
  // the PreCompact "compaction in flight" marker and count the boundary as
  // production so the resumed turn gets a fresh silence window.
  | { kind: 'compact_boundary'; trigger: string | null; compactDurationMs: number | null }
  // `reason` is set ONLY by an internal gateway-synthesized turn_end (never by
  // the JSONL projection). `answer-ready-quiescence` (PR A) marks the positive
  // deterministic quiescence-flush signal, which — unlike the orphaned-reply
  // backstop's bare `durationMs:-1` — deliberately bypasses the recently-
  // streaming suppression guard (quiescence IS the "streaming settled" signal).
  | { kind: 'turn_end'; durationMs: number; reason?: 'answer-ready-quiescence' }
  // Multi-agent: sub-agent-scoped events. agentId is the sub-agent JSONL
  // filename stem (e.g. "aac6f1…"). Routed through the same ingest path
  // as parent events; the reducer fans them out to per-sub-agent state.
  | { kind: 'sub_agent_started'; agentId: string; firstPromptText: string; subagentType?: string }
  // Live model in use for a SUB-AGENT, extracted from `message.model` on each
  // of its `type:"assistant"` transcript lines. Same contract as the main
  // `model` kind (sentinel-filtered, emitted first) but agent-scoped so the
  // watcher can track it per WorkerEntry and thread it onto the worker card.
  | { kind: 'sub_agent_model'; agentId: string; model: string }
  // Per-assistant-message token usage for a SUB-AGENT, extracted from
  // `message.usage` on each `type:"assistant"` transcript line. `totalTokens`
  // is the NEW-work delta for THIS message (input + output + cache_creation;
  // cache_read is deliberately excluded — replayed cached context, not new
  // work). `messageId` is `message.id` — REQUIRED for dedup: Claude
  // Code ≥2.1.x persists one logical assistant message as MULTIPLE JSONL lines
  // sharing one `message.id`, each stamped with the SAME `usage` block, so the
  // watcher must count a given `messageId` only once (naive summing across
  // lines 2-3x over-counts; verified against live worker jsonl — 131 usage
  // lines / 59 unique ids). Null messageId → un-dedupable, counted as-is.
  | { kind: 'sub_agent_usage'; agentId: string; messageId: string | null; totalTokens: number }
  | { kind: 'sub_agent_tool_use'; agentId: string; toolUseId: string | null; toolName: string; input?: Record<string, unknown>; precomputedLabel?: string }
  // Same shared contract as the main-agent `text` kind — see its doc above
  // (including the `lastInMessage` projection-artifact note). The wire-kind
  // stays distinct (the gateway/watcher split is load-bearing) but the
  // payload + `lastInMessage` derivation are identical so ONE shared dedup
  // gate handles both tiers.
  | { kind: 'sub_agent_text'; agentId: string; text: string; blockIndex: number; lastInMessage: boolean }
  | { kind: 'sub_agent_tool_result'; agentId: string; toolUseId: string; isError?: boolean; errorText?: string }
  | { kind: 'sub_agent_turn_end'; agentId: string }
  | {
      kind: 'sub_agent_nested_spawn'
      agentId: string
      /** tool_use id of the nested Agent/Task dispatch — the `subagents`
       *  registry PK the child's meta.json `toolUseId` links against. Lets
       *  the watcher record/repair the nested worker's registry row
       *  (recordNestedSubagentDispatch — the depth-2+ keying fix). */
      toolUseId?: string | null
      /** The dispatch tool_input (description / subagent_type /
       *  run_in_background) — registry metadata only, never rendered
       *  (design §5.5's "no recursion in rendering" rule is unchanged). */
      input?: Record<string, unknown>
    }
  /**
   * Emitted when a sub-agent JSONL has >= CAP_TOOL_USE_THRESHOLD tool_use
   * records but no terminal record (no `type:result`, `subtype:end`, or
   * `type:final`). This indicates the sub-agent was killed mid-flight
   * (parent restart, watchdog SIGTERM, etc.) before writing its completion.
   * The progress-card driver transitions the fleet member to `capped` state
   * so the card surface shows a terminal "capped" row instead of hanging
   * "running" forever.
   */
  | { kind: 'sub_agent_capped'; agentId: string; toolUseCount: number }

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
  // Look for `chat_id="..."` etc in the channel XML tag. LEFT-ANCHOR on an
  // attribute boundary (start-of-string or a whitespace/quote before the name)
  // so `message_id` matches ONLY the real attribute — never a same-suffix
  // sibling like `target_message_id`, `reply_to_message_id`, or
  // `original_message_id`. Without the boundary, grab('message_id') would
  // match the FIRST `*_message_id` substring, mis-attributing the enqueue's id.
  const grab = (key: string): string | null => {
    const m = content.match(new RegExp(`(?:^|[\\s"'])${key}="([^"]+)"`))
    return m ? m[1] : null
  }
  return {
    chatId: grab('chat_id'),
    messageId: grab('message_id'),
    threadId: grab('message_thread_id'),
  }
}

/**
 * Hard cap on a single JSONL line before we parse it. Transcript entries
 * can embed large tool outputs; a pathological 100 MB line would OOM the
 * plugin on parse. 2 MB is comfortably above any realistic Claude output
 * chunk and keeps memory predictable under a corrupted or malicious file.
 */
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024

/** Max chars we capture from a tool error for pattern matching. */
const MAX_ERROR_TEXT_CHARS = 500

/**
 * Extract a plain-text representation of tool_result `content` for error
 * classification.  The field can be:
 *   - a string (simple text)
 *   - an array of Anthropic content blocks (e.g. [{type:'text', text:'…'}])
 * Returns the first MAX_ERROR_TEXT_CHARS characters — enough for pattern
 * matching while keeping SessionEvent objects lean.
 */
function extractToolResultErrorText(content: unknown): string {
  if (typeof content === 'string') {
    return content.slice(0, MAX_ERROR_TEXT_CHARS)
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'object' && block != null) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        }
      }
    }
    return parts.join('\n').slice(0, MAX_ERROR_TEXT_CHARS)
  }
  return ''
}

/**
 * #3519 sharpen — ALIVE marker (primary): read the claude-CLI background-task
 * id off the structured, sibling top-level `toolUseResult.backgroundTaskId`
 * field of a `type:"user"` transcript line. This is the version-robust source
 * (a named JSON field, not prose). Real shape (carrie session
 * a6d2d33a-…, v2.1.197, line 109):
 *   "toolUseResult":{…,"backgroundTaskId":"bxa4sv3dq"}
 * Returns the id, or null when the line carries no backgrounded shell.
 */
export function parseBackgroundTaskId(obj: Record<string, unknown>): string | null {
  const tur = obj.toolUseResult
  if (typeof tur === 'object' && tur != null) {
    const id = (tur as Record<string, unknown>).backgroundTaskId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

/**
 * #3519 sharpen — ALIVE marker (secondary): match the launch STRING in the
 * tool_result `content` when the structured field is absent (older CLI, or a
 * shape change that keeps the human string). Real bytes (same line 109):
 *   "Command running in background with ID: bxa4sv3dq. Output is being written…"
 * DELIBERATELY the fallback, not the primary — if BOTH miss (CLI changed the
 * string too) the caller degrades to the 900s-bounded sawBash guard. Accepts
 * the same string|content-block shapes as extractToolResultErrorText.
 */
export function parseBackgroundLaunchString(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : extractToolResultErrorText(content)
  const m = text.match(/Command running in background with ID: (\w+)/)
  return m != null ? m[1] : null
}

/**
 * #3519 sharpen — DEAD marker: parse a claude-CLI `<task-notification>` block.
 * The CLI enqueues this proactively when a backgrounded shell finishes. Real
 * bytes (carrie session a6d2d33a-…, v2.1.197, line 175 queue-operation enqueue
 * content, and mirrored line 180 attachment):
 *   "<task-notification>\n<task-id>bxa4sv3dq</task-id>\n…\n<status>completed</status>\n…"
 * Returns {taskId,status} when both tags are present, else null (so an
 * ordinary inbound enqueue falls through to the normal user-turn path).
 */
export function parseTaskNotification(
  content: string,
): { taskId: string; status: string } | null {
  if (!content.includes('<task-notification>')) return null
  const idM = content.match(/<task-id>([^<]+)<\/task-id>/)
  const stM = content.match(/<status>([^<]+)<\/status>/)
  if (idM == null || stM == null) return null
  return { taskId: idM[1].trim(), status: stM[1].trim() }
}

/**
 * THE single text→narrative projection primitive. Both projectTranscriptLine
 * and projectSubagentLine derive their text events through this helper so
 * main-agent, sub-agent, worker, and every other execution shape inherit
 * identical text-block semantics from ONE place: empty/whitespace blocks are
 * dropped, and each surviving block carries its `blockIndex` plus the
 * `lastInMessage` signal (no tool_use follows it in this message). NOTE:
 * `lastInMessage` is a projection artifact — the reducer-side dedup gate
 * decides SHOW/SUPPRESS by lookahead, not by reading this flag (see the
 * SessionEvent `text` doc); it is reserved for a future staging-skip
 * optimization.
 *
 * `make` adapts the shared payload into the tier-specific wire kind
 * (`text` vs `sub_agent_text`); the contract — what counts as a text block,
 * how `lastInMessage` is computed — lives here, not in the callers.
 *
 * Returns a `Map<blockIndex, SessionEvent>` keyed by the text block's source
 * index, NOT a flat list. This is the load-bearing design choice: the callers
 * must emit thinking / tool_use / text events in SOURCE ORDER (the reducer
 * pairs a preamble to the immediately-next tool_use), so they iterate
 * `content` once and, at each text position, emit the precomputed event from
 * this map. The kernel owns the contract; the caller owns only the ordering.
 */
export function projectAssistantTextBlocks(
  content: Array<Record<string, unknown>>,
  make: (text: string, blockIndex: number, lastInMessage: boolean) => SessionEvent,
): Map<number, SessionEvent> {
  const out = new Map<number, SessionEvent>()
  // Precompute the index of the last tool_use so each text block knows
  // whether a tool_use follows it in THIS message (the draft-then-send signal).
  let lastToolUseIdx = -1
  content.forEach((c, i) => {
    if (c.type === 'tool_use') lastToolUseIdx = i
  })
  content.forEach((c, i) => {
    if (c.type !== 'text') return
    const text = (c.text as string | undefined) ?? ''
    if (text.trim().length === 0) return // drop empty/whitespace-only blocks
    out.set(i, make(text, i, i > lastToolUseIdx))
  })
  return out
}

/**
 * True iff this assistant message's `content` carries the "answer surface"
 * — a `text` block, or a real (non-`Agent`/`Task`) `tool_use`. Used to gate
 * the `stop_reason === 'end_turn'` sub-agent terminal so it never fires on a
 * split-off thinking-only line (see the terminal comment in
 * projectSubagentLine). A thinking-only or empty line returns false; the real
 * terminal rides the following content line, which also carries `end_turn`.
 */
/**
 * Sum the NEW token work carried by a single assistant message's `usage`
 * object: `input_tokens + output_tokens + cache_creation_input_tokens`. Every
 * field is guarded with `?? 0` — Claude Code omits fields that are zero/absent
 * on some messages. A non-object (or missing) usage returns 0 so the caller
 * can skip a no-usage line.
 *
 * `cache_read_input_tokens` is DELIBERATELY EXCLUDED. On a prompt-cached turn
 * it is replayed context (billed at ~10% and doing no new work), and it
 * dominates the raw total — including it made the displayed number 2-5x bigger
 * than the actual work done this turn and misread as a cost/effort figure. The
 * three fields kept here represent new tokens processed this turn: fresh input,
 * generated output, and newly-written cache. The nested `iterations` /
 * `cache_creation` breakdowns are subsets already reflected in the top-level
 * fields — never add them, that double-counts. Verified against live worker
 * jsonl.
 */
export function sumUsageTokens(usage: unknown): number {
  if (usage == null || typeof usage !== 'object') return 0
  const u = usage as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return (
    n(u.input_tokens) +
    n(u.output_tokens) +
    n(u.cache_creation_input_tokens)
  )
}

export function assistantLineCarriesAnswerSurface(
  content: Array<Record<string, unknown>> | undefined,
): boolean {
  if (!Array.isArray(content)) return false
  for (const c of content) {
    const ct = (c?.type as string | undefined) ?? ''
    if (ct === 'text') {
      // A non-empty text block is the answer surface.
      const t = c.text as string | undefined
      if (typeof t === 'string' && t.trim().length > 0) return true
    } else if (ct === 'tool_use') {
      // A real tool_use is content too. (An end_turn message rarely contains a
      // tool_use, but if it does it is content-final, not a bare thinking split.)
      const name = (c.name as string | undefined) ?? ''
      if (name !== 'Agent' && name !== 'Task') return true
    }
  }
  return false
}

export interface TrailingAnswer {
  /** Concatenated trailing assistant text of the last turn (after the last
   *  tool_use / turn boundary). Empty when there is none to redeliver. */
  text: string
  /** True iff the last content-bearing event of the transcript was text — i.e.
   *  the turn ended on an answer, not a dangling tool_use (mid-stream). Bounds
   *  the preamble-vs-final ambiguity for crash-survival redelivery. */
  trailingIsText: boolean
}

/**
 * Re-project the TRAILING assistant answer of the last turn from a claude
 * session transcript's full text. Pure — reuses the same `projectTranscriptLine`
 * kernel the live tail uses, so it inherits the `isApiErrorMessage` suppression
 * (a usage-limit error line is NEVER resurfaced as an answer) and the empty-block
 * drop. Used by crash-survival redelivery to recover the finished-but-never-sent
 * answer from disk after a pre-flush crash.
 *
 * Semantics: walk the event stream in order; the "answer buffer" accumulates
 * `text` events and is RESET by any `tool_use` (the answer-so-far was a preamble
 * to a tool call) or by a turn boundary. What remains at end-of-file is the
 * trailing answer of the last turn. `trailingIsText` is true only when the final
 * content-bearing event was that text (not a tool_use), so a turn killed mid-tool
 * never redelivers a stale preamble as an answer.
 *
 * TURN BOUNDARY (diff-review defect #2). A boundary is BOTH an `enqueue`
 * queue-operation AND a real `type:"user"` message line. The kernel
 * (`projectTranscriptLine`) emits nothing for a plain user text line — it only
 * projects `tool_result` blocks out of `type:"user"` — so relying on `enqueue`
 * alone would let two turns separated by a plain user line (no intervening
 * tool_use) CONCATENATE. `isRealUserTurnBoundary` detects that separator
 * directly so only the LAST turn's trailing text is projected.
 */
export function projectTrailingAnswerFromTranscript(transcriptText: string): TrailingAnswer {
  const buf: string[] = []
  let lastMeaningful: 'text' | 'tool_use' | null = null
  for (const rawLine of transcriptText.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (isRealUserTurnBoundary(line)) {
      // A real user message opens a new turn — discard any prior turn's tail.
      buf.length = 0
      lastMeaningful = null
      continue
    }
    for (const ev of projectTranscriptLine(line)) {
      if (ev.kind === 'enqueue') {
        // New inbound turn — any prior turn's trailing text is not this turn's.
        buf.length = 0
        lastMeaningful = null
      } else if (ev.kind === 'tool_use') {
        buf.length = 0
        lastMeaningful = 'tool_use'
      } else if (ev.kind === 'text') {
        const t = (ev as { text?: string }).text ?? ''
        if (t.trim().length > 0) {
          buf.push(t)
          lastMeaningful = 'text'
        }
      }
      // thinking / model / dequeue / tool_result etc. do not affect the answer.
    }
  }
  const text = buf.join('').trim()
  return { text, trailingIsText: lastMeaningful === 'text' && text.length > 0 }
}

/**
 * Detect a real inbound-user turn separator in a claude session JSONL.
 *
 * A `type:"user"` line is EITHER a genuine user message (its `message.content`
 * is a string, or an array carrying a `{type:"text"}` block) OR a tool_result
 * carrier (`message.content` is an array of `{type:"tool_result"}` blocks only).
 * Only the former opens a new turn. The main projection kernel emits NO event
 * for a genuine user text line (it projects tool_result blocks only), so the
 * trailing-answer projector needs this to break turns that are separated by a
 * plain user line rather than an interleaved `enqueue` queue-operation. Pure.
 */
export function isRealUserTurnBoundary(line: string): boolean {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line)
  } catch {
    return false
  }
  if (obj.type !== 'user') return false
  const message = obj.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    // A genuine user message carries a text block; a tool_result carrier does
    // not. Presence of any text block ⇒ real user turn.
    for (const c of content) {
      if (typeof c === 'object' && c != null && (c as Record<string, unknown>).type === 'text') {
        const t = String((c as Record<string, unknown>).text ?? '')
        if (t.trim().length > 0) return true
      }
    }
  }
  return false
}

/**
 * Project a single transcript line into a SessionEvent (or null if it's
 * uninteresting noise). Caller is responsible for the JSON parse — if a
 * line is not valid JSON we skip it.
 */
export function projectTranscriptLine(line: string): SessionEvent[] {
  if (line.length > MAX_JSONL_LINE_BYTES) return []
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
      // #3519 sharpen: a `<task-notification>` is NOT a real inbound user
      // turn — it is the claude CLI's proactive background-shell completion
      // signal, enqueued as a synthetic command. Project it as the DEAD
      // marker so the liveness registry can drop the shell (restoring ~300s
      // wedge recovery) rather than mis-reading it as a user message.
      const notif = parseTaskNotification(content)
      if (notif != null) {
        return [{ kind: 'task_notification', taskId: notif.taskId, status: notif.status }]
      }
      const { chatId, messageId, threadId } = parseChannelMeta(content)
      return [{ kind: 'enqueue', chatId, messageId, threadId, rawContent: content }]
    }
    if (op === 'dequeue') {
      return [{ kind: 'dequeue' }]
    }
    // #3927 — the enqueue's OTHER terminal. Previously dropped, which left the
    // gateway unable to tell "queued message folded into the running turn"
    // (`remove`) from "queue drained into a new turn" (`dequeue`).
    if (op === 'remove') {
      return [{ kind: 'queue_remove', rawContent: (obj.content as string | undefined) ?? '' }]
    }
    return []
  }

  // assistant: turn output (thinking, text, tool_use)
  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) return []
    // #llm-error-surfacing — DETERMINISTIC TERMINAL SOURCE. Claude Code writes a
    // usage-limit / API error as a SYNTHETIC ASSISTANT MESSAGE
    // (`isApiErrorMessage: true`) whose `content[].text` is the raw error string
    // ("You've hit your limit · resets … b'{\"type\":\"error\"…}'"). That text
    // used to fan out to the reply/answer passthrough AND the turn-end "done"
    // card as if it were the model's answer. It is NOT an answer — it is an
    // error the operator-event pipeline (detectErrorInTranscriptLine →
    // humanized card) owns. Suppress the text/thinking events here at the ONE
    // authoritative source so neither downstream surface can relay the raw
    // bytes; the humanized card is rendered independently from the same line.
    if (obj.isApiErrorMessage === true) {
      const mainModel = message?.model
      return typeof mainModel === 'string' && !isModelSentinel(mainModel)
        ? [{ kind: 'model', model: mainModel }]
        : []
    }
    const events: SessionEvent[] = []
    // Live model capture: `message.model` is the exact resolved model that
    // served THIS assistant API call. Emit it FIRST (before the content events)
    // so a card rendered on the same read batch already carries the current
    // model. Sentinels (`<synthetic>` on compaction lines, fixture junk) are
    // skipped — the reducer keeps the last real value.
    const mainModel = message?.model
    if (typeof mainModel === 'string' && !isModelSentinel(mainModel)) {
      events.push({ kind: 'model', model: mainModel })
    }
    // Per-message token usage (MAIN tier): surface the summed delta so the
    // gateway can accumulate the parent's OWN running total for the turn card's
    // metrics line. `messageId` (message.id) rides along so the accumulator
    // dedups the multi-line split-message shape (one logical message → many
    // JSONL lines, one shared `usage`). Emitted only when a usage object with a
    // non-zero total exists — a no-usage line contributes nothing and is
    // skipped. Mirrors the sub-agent emit below; this counts the parent alone
    // (sub-agents report their own tokens on their worker-feed rows).
    const mainUsageTotal = sumUsageTokens(message?.usage)
    if (mainUsageTotal > 0) {
      const mainMsgId = message?.id
      events.push({
        kind: 'usage',
        messageId: typeof mainMsgId === 'string' ? mainMsgId : null,
        totalTokens: mainUsageTotal,
      })
    }
    // Text→narrative projection comes from the ONE shared kernel
    // (projectAssistantTextBlocks): it owns the empty-drop + blockIndex +
    // lastInMessage contract. We emit its events at their source positions
    // so thinking / tool_use / text stay in source order (the reducer pairs
    // a preamble to the immediately-next tool_use).
    const textEvents = projectAssistantTextBlocks(
      content,
      (text, blockIndex, lastInMessage): SessionEvent => ({ kind: 'text', text, blockIndex, lastInMessage }),
    )
    content.forEach((c, i) => {
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
        const ev = textEvents.get(i)
        if (ev != null) events.push(ev)
      }
    })
    return events
  }

  // user: contains tool_results
  if (type === 'user') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) return []
    // #3519 sharpen: the background-launch id is a per-LINE fact carried on
    // the sibling top-level `toolUseResult.backgroundTaskId` (version-robust
    // structured field), with the launch STRING as a secondary. Parsed once
    // and attached to this line's tool_result event to mark the shell ALIVE.
    const backgroundTaskId = parseBackgroundTaskId(obj)
    const events: SessionEvent[] = []
    for (const c of content) {
      if (c.type === 'tool_result') {
        const isError = c.is_error === true ? true : undefined
        events.push({
          kind: 'tool_result',
          toolUseId: (c.tool_use_id as string | undefined) ?? '',
          toolName: null,
          isError,
          errorText: isError ? extractToolResultErrorText(c.content) : undefined,
          backgroundTaskId: backgroundTaskId
            ?? parseBackgroundLaunchString(c.content)
            ?? undefined,
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

  // #4058 — system compact_boundary: written when a mid-turn (auto or manual)
  // compaction FINISHES. Real shape observed in live transcripts:
  //   { type:"system", subtype:"compact_boundary", content:"Conversation
  //     compacted", compactMetadata:{ trigger:"auto", preTokens, postTokens,
  //     durationMs, ... } }
  if (type === 'system' && obj.subtype === 'compact_boundary') {
    const meta = obj.compactMetadata as { trigger?: unknown; durationMs?: unknown } | undefined
    return [{
      kind: 'compact_boundary',
      trigger: typeof meta?.trigger === 'string' ? meta.trigger : null,
      compactDurationMs: typeof meta?.durationMs === 'number' ? meta.durationMs : null,
    }]
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
        const isError = cc.is_error === true ? true : undefined
        events.push({
          kind: 'sub_agent_tool_result',
          agentId,
          toolUseId: (cc.tool_use_id as string | undefined) ?? '',
          isError,
          errorText: isError ? extractToolResultErrorText(cc.content) : undefined,
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
    // Live model capture (sub-agent tier): same contract as the main-agent
    // branch — emit the sub-agent's resolved model first, sentinel-filtered.
    const subModel = message?.model
    if (typeof subModel === 'string' && !isModelSentinel(subModel)) {
      events.push({ kind: 'sub_agent_model', agentId, model: subModel })
    }
    // Per-message token usage: surface the summed delta so the watcher can
    // accumulate a running total for the worker-activity card's metrics line.
    // `messageId` (message.id) rides along so the watcher dedups the multi-line
    // split-message shape (one logical message → many JSONL lines, one shared
    // `usage`). Emitted only when a usage object with a non-zero total exists —
    // a no-usage line contributes nothing and is skipped here.
    const subUsageTotal = sumUsageTokens(message?.usage)
    if (subUsageTotal > 0) {
      const subMsgId = message?.id
      events.push({
        kind: 'sub_agent_usage',
        agentId,
        messageId: typeof subMsgId === 'string' ? subMsgId : null,
        totalTokens: subUsageTotal,
      })
    }
    // Text→narrative projection comes from the SAME shared kernel as the
    // main agent (projectAssistantTextBlocks): one source for the empty-drop
    // + blockIndex + lastInMessage contract. The `make` adapter only changes
    // the wire kind to `sub_agent_text`. A nested Agent/Task tool_use still
    // counts as a tool_use that follows a preceding text block — handled by
    // the kernel — so a sub-agent preamble before a nested spawn is correctly
    // NOT `lastInMessage`. We emit at source positions so text + tool_use
    // stay in source order (the reducer pairs preamble → next tool_use).
    const textEvents = projectAssistantTextBlocks(
      content,
      (text, blockIndex, lastInMessage): SessionEvent => ({
        kind: 'sub_agent_text',
        agentId,
        text,
        blockIndex,
        lastInMessage,
      }),
    )
    content.forEach((c, i) => {
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
          events.push({
            kind: 'sub_agent_nested_spawn',
            agentId,
            toolUseId: (c.id as string | undefined) ?? null,
            input: (c.input as Record<string, unknown> | undefined) ?? undefined,
          })
        } else {
          events.push({
            kind: 'sub_agent_tool_use',
            agentId,
            toolUseId: (c.id as string | undefined) ?? null,
            toolName: name,
            input: (c.input as Record<string, unknown> | undefined) ?? undefined,
          })
        }
      } else if (ct === 'text') {
        // Surface the sub-agent's natural preamble text so the
        // progress-card reducer can pair it with the next
        // sub_agent_tool_use — same UX as the parent's preamble→tool_use
        // pairing (see 3ad8436). Order matters: text and tool_use blocks
        // in the SAME assistant message must be emitted in source order
        // so the reducer consumes the preamble on the immediately-next
        // tool_use and sibling tool_uses fall back to filename/pattern.
        // The event itself comes from the shared kernel (textEvents above).
        const ev = textEvents.get(i)
        if (ev != null) events.push(ev)
      }
    })
    // Authoritative early terminal: a background `Agent` worker's JSONL on
    // claude ≥2.1.156 never writes the `system/turn_duration` line below, so
    // the watcher used to only learn the worker finished via the ~5-min
    // silent-stall synthesis net — leaving the card stuck "running" and the
    // deferred 👍 held for minutes after the work was actually done. The
    // worker DOES write a final assistant message with
    // `stop_reason: 'end_turn'` (a tool-using turn is `'tool_use'` and keeps
    // going), so treat that as the terminal signal. Emitted AFTER the content
    // events so the final text/preamble still renders; the watcher's turn_end
    // handler is guarded on `state === 'running'`, so a later real
    // turn_duration line is a no-op.
    //
    // UPSTREAM-SHAPE HARDENING (Claude Code ≥2.1.x): one logical assistant
    // message is now persisted as MULTIPLE JSONL lines sharing one
    // `message.id`, one content-block per line, and the terminal `stop_reason`
    // (`end_turn`) is stamped on EVERY split line — including the leading
    // `[thinking]` line that precedes the `[text: final answer]` line. Firing
    // the terminal on the thinking-only line marks the sub-agent `done` and
    // hands back stale/empty text BEFORE the real handback `[text]` line is
    // projected (the watcher's onProgress is `state==='running'`-gated, so the
    // late text is dropped). Guard: only treat `end_turn` as terminal on a line
    // that actually carries the message's answer surface (a `text` block, or a
    // non-`Agent`/`Task` tool_use). A thinking-only `end_turn` line is a split
    // preamble; its terminal + handback ride the following content line, which
    // still carries `end_turn` and fires correctly AFTER the text event. The
    // old single-line `[thinking, text](end_turn)` shape has a `text` block, so
    // it fires exactly as before — graceful degradation on both shapes. A
    // genuine thinking-only end with no answer still terminates via the
    // `turn_duration` / capped-reaper / watcher stall nets.
    const stopReason = message?.stop_reason as string | undefined
    if (stopReason === 'end_turn' && assistantLineCarriesAnswerSurface(content)) {
      events.push({ kind: 'sub_agent_turn_end', agentId })
    }
    return events
  }

  if (type === 'system' && obj.subtype === 'turn_duration') {
    return [{ kind: 'sub_agent_turn_end', agentId }]
  }

  return []
}

// ─── Error detection for operator events ──────────────────────────────────

/**
 * Inspect a raw JSONL line for Anthropic API error shapes and return the
 * classified kind + the raw error object if one is found.
 *
 * Claude Code can write several error-bearing line shapes:
 *   - { type: "api_error", error: { type: "...", message: "..." } }
 *   - { type: "error", error: { type: "...", message: "..." } }
 *   - Any line where obj.error is a non-null object with a recognized type
 *
 * Returns null when no actionable error is detected (routine lines).
 * Never throws — delegates to classifyClaudeError's own safety guarantee.
 */
/**
 * Extract Claude Code's retry-state annotations from a transcript line.
 * Claude Code writes top-level `retryAttempt` / `maxRetries` on a
 * retried API error (e.g. a 529 it is internally retrying). Used to
 * tell an in-flight retry from an exhausted (terminal) one. Both
 * optional — non-retried errors and older Claude Code versions omit
 * them.
 */
function extractRetryState(obj: Record<string, unknown>): {
  retryAttempt: number | null
  maxRetries: number | null
} {
  return {
    retryAttempt: typeof obj.retryAttempt === 'number' ? obj.retryAttempt : null,
    maxRetries: typeof obj.maxRetries === 'number' ? obj.maxRetries : null,
  }
}

/**
 * The OperatorEventKinds on which a connection-drop wording may be flagged as a
 * genuine transport drop. INCLUSION (not exclusion) by design: a positively
 * classified auth/quota/credit/rate-limit/overload wall is NEVER in this set,
 * so a wrapped terminal error whose outer text coincidentally carries a drop
 * wording is never mislabelled a drop. `transport-transient` is the natural
 * mid-stream-abort kind; `unknown-4xx`/`unknown-5xx` is where a drop-worded
 * line lands when `classifyClaudeError` does not recognise its wording (the
 * exact Path-B bug this closes). Mirrors Path A's `transient`/`unknown` gate in
 * `parseLlmError`, keeping the two classifiers in agreement.
 */
const CONNECTION_DROP_ELIGIBLE_KINDS: ReadonlySet<OperatorEventKind> =
  new Set<OperatorEventKind>(['transport-transient', 'unknown-5xx', 'unknown-4xx'])

/** True when `kind` may carry the connection-drop flag AND the text is a drop wording. */
function isConnectionDrop(kind: OperatorEventKind, scanText: string): boolean {
  return CONNECTION_DROP_ELIGIBLE_KINDS.has(kind) && isConnectionDropText(scanText)
}

export function detectErrorInTranscriptLine(
  line: string,
): {
  kind: OperatorEventKind
  raw: unknown
  detail: string
  /** True for the rate-limit / transient-overload family. */
  transient: boolean
  /** True when the error is final — NOT an in-flight retry. A transient
   *  error mid-retry is `transient:true, terminal:false`; the caller
   *  suppresses it (no operator card until the failure is terminal). */
  terminal: boolean
  /**
   * True when this line is a mid-stream connection / SSE drop (a transport
   * connection loss), per the canonical `isConnectionDropText` matcher, gated
   * to the transport/unknown kinds. Set consistently with `parseLlmError`'s
   * `ParsedLlmError.connectionDrop` so a later PR can gate auto-resume on ONE
   * reliable discriminator across both classification paths. Classification
   * only in this PR; no caller acts on it yet.
   */
  connectionDrop: boolean
} | null {
  if (!line || line.length > 2 * 1024 * 1024) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj == null) return null

  const type = obj.type as string | undefined

  // Claude Code (v2.1.x) records a usage-limit / API error as a
  // SYNTHETIC ASSISTANT MESSAGE, not an api_error / error line:
  //   { type: "assistant",
  //     message: { role: "assistant",
  //       content: [{ type: "text", text: "You've hit your limit · resets …" }] },
  //     error: "rate_limit", isApiErrorMessage: true, apiErrorStatus: 429 }
  // It has no `api_error`/`error` top-type and no nested error OBJECT
  // (`error` is a bare string), so the structured checks below miss it
  // entirely. That silent miss is what kept fleet auto-fallback from
  // ever firing on a quota hit — the exhaustion signal never reached
  // the operator-event path. Detect this shape explicitly.
  if (obj.isApiErrorMessage === true) {
    const status =
      typeof obj.apiErrorStatus === 'number' ? obj.apiErrorStatus : null
    const errStr = typeof obj.error === 'string' ? obj.error : ''
    const text = extractAssistantText(obj)
    // A 429 in this shape is USUALLY a subscription usage-limit wall (it
    // carries a reset time) — classify it quota-exhausted so the operator
    // event resolves to an auto-fallback-eligible kind that always shows the
    // "model unavailable" card. BUT Anthropic also emits a 429 for a TRANSIENT
    // per-account burst / RPM throttle whose wording explicitly negates the
    // account-quota reading ("This request would exceed your account's rate
    // limit … not your usage limit"). That is a self-healing few-second throttle
    // Claude Code retries internally — blanket-labeling it quota-exhausted fired
    // a false scary card on the fleet (carrie incident, 2026-07-12). So a 429 is
    // only quota-exhausted when it LACKS an explicit transient-burst marker;
    // with one, classify it rate-limited so it takes the calm path (no card, no
    // failover). Keyed on the explicit transient NEGATION (canonical list in
    // model-unavailable.ts) — an ambiguous 429 that merely says "limit" stays
    // quota-exhausted, biasing toward surfacing a real wall. Other statuses fall
    // through to the shared classifier.
    //
    // A 429 carrying LiteLLM-proxy-LOCAL limiter wording ("Deployment over
    // user-defined ratelimit", "Rate limit exceeded for api_key: …" — the
    // canonical `litellmProxyLocal429Signals` list) is the proxy's own
    // `tpm_limit`/`rpm_limit` cap tripping BEFORE the request reached
    // Anthropic. Nothing about the account is exhausted — blanket-labeling it
    // quota-exhausted would fire the model-unavailable card + mark-exhausted +
    // fleet failover for a purely proxy-local condition. It is rate-limited
    // (calm path). Precedence when BOTH wordings appear is owned by
    // `classify429Detail` gateway-side; here both branches yield the same
    // 'rate-limited' kind, so order is immaterial.
    const kind: OperatorEventKind =
      status === 429
        ? isTransientUpstreamSignal(`${text}\n${errStr}`) ||
          isLitellmProxyLocal429(`${text}\n${errStr}`)
          ? 'rate-limited'
          : 'quota-exhausted'
        : classifyClaudeError({ type: errStr, status, message: text })
    // An `isApiErrorMessage` line is Claude surfacing the failure to the
    // user — terminal by construction (Claude writes this shape only
    // after its own internal retries are exhausted).
    return {
      kind,
      raw: obj,
      detail: text || errStr || 'api error',
      transient: kind === 'rate-limited',
      terminal: true,
      connectionDrop: isConnectionDrop(kind, `${text}\n${errStr}`),
    }
  }

  // Explicit error line types from Claude Code JSONL
  const isErrorLine = type === 'api_error' || type === 'error'

  // Also detect lines where obj.error is a non-null object (embedded error)
  const embeddedError =
    typeof obj.error === 'object' && obj.error != null ? obj.error : null

  if (!isErrorLine && !embeddedError) return null

  const raw = embeddedError ?? obj

  // For api_error/error wrapper lines, the nested error object carries the
  // real error type (e.g. rate_limit_error). Classify the nested error when
  // present; fall back to the full object for status-code-based fallback.
  const kind = classifyClaudeError(embeddedError ?? obj)

  // Detail: prefer message from nested error or top-level
  const detail =
    extractDetailMessage(embeddedError as Record<string, unknown> | null) ??
    extractDetailMessage(obj) ??
    String(type ?? '')

  // Transient = the rate-limit / overload family. For a transient,
  // decide `terminal` from Claude Code's retry annotations: below the
  // cap → still retrying (in-flight); at/above → exhausted. With no
  // retry state, an explicit `type:"api_error"`/`"error"` LINE means
  // Claude surfaced the failure (terminal); an embedded-error object
  // with no retry state is ambiguous → treat as in-flight and suppress
  // (the silence-poke covers a genuinely stuck turn; a false card is
  // the bug we are fixing, a missed ambiguous card costs nothing).
  // `transport-transient` joins the transient family so Claude's retry
  // annotations gate `terminal`: a mid-response abort Claude is still retrying
  // (retryAttempt < maxRetries) is in-flight, not terminal, and must NOT count
  // toward the operator escalation counter (which is bounded to ≥3 TERMINAL
  // events). The primary bug shape (`isApiErrorMessage`) returns earlier with
  // terminal:true by construction, so it is unaffected by this.
  const transient = kind === 'rate-limited' || kind === 'transport-transient'
  const retry = extractRetryState(obj)
  const terminal = !transient
    ? true
    : retry.retryAttempt != null && retry.maxRetries != null
      ? retry.retryAttempt >= retry.maxRetries
      : isErrorLine

  return {
    kind,
    raw,
    detail,
    transient,
    terminal,
    connectionDrop: isConnectionDrop(kind, `${detail}\n${String(type ?? '')}`),
  }
}

function extractDetailMessage(obj: Record<string, unknown> | null): string | null {
  if (!obj) return null
  const msg = obj.message
  return typeof msg === 'string' && msg.length > 0 ? msg : null
}

/**
 * Pull the human-readable text out of a synthetic assistant message
 * (`message.content[].text`, joined). Used for the v2.1.x
 * `isApiErrorMessage` shape, where the user-facing error string lives
 * inside the assistant message rather than in an `error` object.
 * Returns '' for any non-conforming shape — never throws.
 */
function extractAssistantText(obj: Record<string, unknown>): string {
  const message = obj.message
  if (typeof message !== 'object' || message == null) return ''
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (
      typeof block === 'object'
      && block != null
      && (block as Record<string, unknown>).type === 'text'
    ) {
      const t = (block as Record<string, unknown>).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join(' ').trim()
}

// ─── The tail watcher ─────────────────────────────────────────────────────

/** Emitted to onOperatorEvent when the tail detects a Claude API error. */
export interface TailOperatorEvent {
  kind: OperatorEventKind
  detail: string
  raw: unknown
  /** True for the rate-limit / transient-overload family. */
  transient: boolean
  /** True when the failure is final, not an in-flight retry. */
  terminal: boolean
}

export interface SessionTailConfig {
  /** Working directory of the Claude Code process. Defaults to process.cwd(). */
  cwd?: string
  /** CLAUDE_CONFIG_DIR override. Defaults to env or ~/.claude. */
  claudeHome?: string
  /** How often to re-scan for a new active session file (ms). Default 500. */
  rescanIntervalMs?: number
  /**
   * Idle window before an inactive sub-agent FSWatcher (and its PreToolUse
   * sidecar) is reaped, in ms. Defaults to 5 minutes — well past the 99th-
   * percentile sub-agent completion time. Exposed only so tests can drive the
   * reap deterministically without a 5-minute wall-clock wait.
   */
  subTailIdleReapMs?: number
  /** Optional logger. */
  log?: (msg: string) => void
  /** Called for each parsed event. */
  onEvent: (event: SessionEvent) => void
  /**
   * Called when an Anthropic API error is detected in the JSONL transcript.
   * Phase 4a: session-tail emits; the gateway subscription is wired in Phase 4b.
   * TODO(Phase 4b): wire this to the gateway's emitOperatorEvent pipeline.
   */
  onOperatorEvent?: (event: TailOperatorEvent) => void
  /**
   * PreToolUse sidecar factory. Defaults to the real `createToolLabelSidecar`;
   * production never sets this. It exists as a dependency-injection seam so the
   * M1 FD-leak reap test can drive a fake sidecar per session WITHOUT
   * `vi.mock`-ing the shared `tool-label-sidecar` module: bun's `vi.mock` is
   * process-global (not file-scoped like vitest), and the CI bun-test shard
   * runs the whole `tests/` dir in ONE process, so a module-mock here would
   * leak into the real `tool-label-sidecar.test.ts` suite and break it. This
   * mirrors the repo's bun-safe injection precedent (`vault-write-posture`'s
   * optional `deps` param).
   */
  createSidecar?: (opts: SidecarOptions) => ToolLabelSidecar
}

export interface SessionTailHandle {
  stop(): void
  /** Returns the current active file path, or null if none. */
  getActiveFile(): string | null
}

/**
 * Byte offset to seek to on the FIRST attach to a session transcript.
 *
 * Normally EOF — we only want NEW events, not replayed history. But if the
 * agent restarted MID-TURN (the bridge's session-tail starts only after
 * claude has already written this turn's `queue-operation enqueue` line),
 * a plain seek-to-EOF skips that enqueue. `enqueue` is the ONLY event that
 * carries the chatId and that sets the gateway's `currentTurn`, so missing
 * it leaves the first post-restart turn with no currentTurn — killing the
 * progress card, draft-mirror, and silence-poke for that turn.
 *
 * Fix: in a bounded tail scan, find the last `enqueue` that has NO
 * `turn_duration` (turn_end) after it — an in-flight turn — and return its
 * line offset so it (and the turn's subsequent events) replay. A completed
 * turn (a `turn_duration` follows the enqueue) returns EOF: no replay.
 */
export function computeFirstAttachCursor(file: string, size: number): number {
  const SCAN_CAP = 1024 * 1024 // bound the tail read at 1 MiB
  const scanStart = Math.max(0, size - SCAN_CAP)
  let buf: Buffer
  try {
    const fd = openSync(file, 'r')
    try {
      buf = Buffer.allocUnsafe(size - scanStart)
      readSync(fd, buf, 0, buf.length, scanStart)
    } finally {
      closeSync(fd)
    }
  } catch {
    return size
  }
  let lastEnqueueOffset = -1
  let turnEndedAfterEnqueue = false
  let lineStart = 0
  // If the scan didn't start at byte 0, the first line is a partial — skip it.
  let skipPartial = scanStart > 0
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== 0x0a) continue
    if (skipPartial) {
      skipPartial = false
    } else if (i > lineStart) {
      const line = buf.toString('utf8', lineStart, i)
      if (
        line.includes('"type":"queue-operation"') &&
        line.includes('"operation":"enqueue"')
      ) {
        lastEnqueueOffset = scanStart + lineStart
        turnEndedAfterEnqueue = false
      } else if (lastEnqueueOffset >= 0 && line.includes('"subtype":"turn_duration"')) {
        turnEndedAfterEnqueue = true
      }
    }
    lineStart = i + 1
  }
  if (lastEnqueueOffset >= 0 && !turnEndedAfterEnqueue) {
    return lastEnqueueOffset
  }
  return size
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
  const rawOnEvent = config.onEvent
  const onOperatorEvent = config.onOperatorEvent

  log?.(`session-tail: projectsDir=${projectsDir}`)

  // PreToolUse sidecar readers (#783) keyed by sessionId. Created lazily
  // the first time we observe a tool_use / sub_agent_tool_use whose
  // toolUseId could be looked up. The hook writes to
  // $TELEGRAM_STATE_DIR/tool-labels-<session_id>.jsonl. Each sub-agent
  // has its OWN sessionId (its jsonl filename stem), so we key by that.
  const sidecars = new Map<string, ToolLabelSidecar>()
  const createSidecar = config.createSidecar ?? createToolLabelSidecar
  const stateDirForSidecar = process.env.TELEGRAM_STATE_DIR ?? null
  function sessionIdForFile(file: string | null): string | null {
    if (!file) return null
    const b = file.endsWith('.jsonl') ? basename(file, '.jsonl') : null
    return b && b.length > 0 ? b : null
  }
  function ensureSidecar(sessionId: string): ToolLabelSidecar | null {
    if (!stateDirForSidecar) return null
    const existing = sidecars.get(sessionId)
    if (existing) return existing
    try {
      const s = createSidecar({ stateDir: stateDirForSidecar, sessionId })
      sidecars.set(sessionId, s)
      // Real-time draft-mirror source: emit a `tool_label` event the moment
      // the hook writes a label (flush-independent), so the gateway can
      // stream the activity feed without waiting on the transcript flush.
      // Subscribed once per sidecar (this is the only creation site).
      s.onLabel((toolUseId, label, toolName) => {
        rawOnEvent({ kind: 'tool_label', toolUseId, label, toolName })
      })
      return s
    } catch (err) {
      log?.(`session-tail: sidecar create failed: ${(err as Error).message}`)
      return null
    }
  }
  /**
   * M1 FD-leak fix: stop and forget the PreToolUse sidecar for a session that
   * has ended (a rotated-away parent session, or a reaped sub-agent). Each
   * sidecar holds its own stat-poll timer (and, on real fs, a file handle);
   * pre-fix they were only reaped in `stop()`, so every session rotation
   * (`/clear`, compaction → new sessionId) and every finished sub-agent leaked
   * one for the gateway's life. Idempotent — a no-op when the key is absent.
   */
  function stopSidecar(sessionId: string | null): void {
    if (!sessionId) return
    const s = sidecars.get(sessionId)
    if (!s) return
    try { s.stop() } catch { /* ignore */ }
    sidecars.delete(sessionId)
  }

  function decorate(ev: SessionEvent, sessionId: string | null): SessionEvent {
    if (!sessionId) return ev
    if (ev.kind !== 'tool_use' && ev.kind !== 'sub_agent_tool_use') return ev
    if (!ev.toolUseId) return ev
    const s = ensureSidecar(sessionId)
    if (!s) return ev
    // One quick poll attempt before lookup — the hook is synchronous from
    // Claude Code's perspective and the sidecar line is typically on disk
    // before the JSONL row is appended, but the file watcher is on a
    // 250ms tick. Forcing a poll closes the race for the common case.
    s.poll()
    const label = s.getLabel(ev.toolUseId)
    if (!label) return ev
    return { ...ev, precomputedLabel: label }
  }
  const onEvent = (ev: SessionEvent): void => rawOnEvent(ev)

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

  // First-attach REPLAY window per file (#3427 H2): when attachToFile replays
  // a prior session's in-flight turn (computeFirstAttachCursor returned an
  // offset below the size-at-attach), every byte below that size is HISTORY
  // written by the pre-restart session. Model observations projected from it
  // must be marked `replayed` so the divergence tripwire ignores them.
  // Granularity is the read CHUNK (a batch whose read started inside the
  // window is marked wholesale) — deliberately conservative: over-marking a
  // boundary batch can only delay verification to the next live line, never
  // false-accuse.
  const replayUntilByFile = new Map<string, number>()

  function readNew(): void {
    if (stopped || !currentFile) return
    try {
      const stat = statSync(currentFile)
      if (stat.size < cursor) {
        // File was truncated/replaced — reset cursor and clear any
        // stored per-file state for this path.
        cursor = 0
        pendingPartial = ''
        if (currentFile != null) {
          fileCursors.delete(currentFile)
          replayUntilByFile.delete(currentFile)
        }
      }
      if (stat.size === cursor) return
      const chunkStart = cursor
      const isReplayChunk = chunkStart < (replayUntilByFile.get(currentFile) ?? 0)
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
        const sid = sessionIdForFile(currentFile)
        for (const ev of events) {
          try {
            onEvent(decorate(isReplayChunk && ev.kind === 'model' ? { ...ev, replayed: true } : ev, sid))
          } catch (err) {
            log?.(`session-tail: onEvent threw: ${(err as Error).message}`)
          }
        }
        // Operator-event detection: check for API error shapes in the line.
        // This runs even when projectTranscriptLine returns [] (unknown types).
        if (onOperatorEvent) {
          try {
            const errEvent = detectErrorInTranscriptLine(line)
            if (errEvent) {
              // Honest escalation: a transient overload Claude is still
              // retrying (transient && !terminal) posts NO operator
              // card — it almost always resolves on the next retry.
              // Escalate only terminal failures + non-transient errors.
              if (errEvent.terminal || !errEvent.transient) {
                onOperatorEvent(errEvent)
              } else {
                log?.(
                  `session-tail: transient overload suppressed (in-flight retry) kind=${errEvent.kind}`,
                )
              }
            }
          } catch (err) {
            log?.(`session-tail: onOperatorEvent threw: ${(err as Error).message}`)
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
    // M1 FD-leak fix: we are rotating the PARENT tail off `currentFile`; its
    // PreToolUse sidecar is no longer needed (its watcher just closed). Reap it
    // so `/clear`- and compaction-driven session rotations don't accumulate one
    // idle sidecar poll-timer per rotation. Parent session ids are the JSONL
    // stem (`<uuid>`); sub-agent sidecars are keyed by `agent-<id>` stems and
    // owned by their sub-tail (reaped in `reapIdleSubTails`), so this never
    // stops a sidecar a live sub-tail still depends on. A later re-attach to
    // this same file transparently recreates the sidecar via `ensureSidecar`.
    const rotatedAwaySid = sessionIdForFile(currentFile)
    const nextSid = sessionIdForFile(file)
    if (rotatedAwaySid != null && rotatedAwaySid !== nextSid) {
      stopSidecar(rotatedAwaySid)
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
      // new events, EXCEPT replay from an in-flight turn's enqueue if the
      // agent restarted mid-turn (see firstAttachCursor).
      pendingPartial = ''
      try {
        const size = statSync(file).size
        cursor = computeFirstAttachCursor(file, size)
        if (cursor < size) {
          // #3427 H2: everything below size-at-attach is pre-restart history;
          // model events projected from it are marked `replayed` in readNew.
          replayUntilByFile.set(file, size)
          log?.(`session-tail: attached to ${file} (cursor=${cursor}, replaying in-flight turn from offset; size=${size})`)
        } else {
          log?.(`session-tail: attached to ${file} (cursor=${cursor})`)
        }
      } catch {
        cursor = 0
      }
    }
    // Eagerly create + subscribe the PreToolUse sidecar for this session
    // NOW (on attach), not lazily on the first JSONL tool_use — otherwise
    // the real-time `tool_label` source wouldn't exist until a flush-gated
    // tool_use arrived, re-introducing the very lag the sidecar avoids.
    const attachSid = sessionIdForFile(file)
    if (attachSid) ensureSidecar(attachSid)
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

  /**
   * Minimum tool_use count that — combined with a missing terminal record —
   * classifies a sub-agent transcript as truncated/capped rather than merely
   * in-flight. The triage report (#650) observed truncation at 31–294 tool
   * uses; 30 is chosen as the lower bound to avoid false-positives on short
   * sub-agents that are still legitimately running when first reaped.
   */
  const CAP_TOOL_USE_THRESHOLD = 30

  interface SubTail {
    agentId: string
    file: string
    cursor: number
    pendingPartial: string
    hasEmittedStart: boolean
    watcher: FSWatcher | null
    /**
     * Last wall-clock time the file's byte count actually advanced.
     * Used for idle-based FSWatcher cleanup — sub-agents that haven't
     * written in IDLE_FSWATCH_TTL_MS get their watcher closed and the
     * SubTail entry dropped. The rescan loop re-attaches if the file
     * grows again. See MEM2 in the overnight forensic audit on #472.
     */
    lastActivityAt: number
    /** Running count of tool_use records observed in this sub-agent's JSONL. */
    toolUseCount: number
    /** True once a terminal record (type:result / subtype:end / type:final) is seen. */
    hasSeenTerminal: boolean
    /** True once we have emitted sub_agent_capped for this sub-agent. */
    cappedEmitted: boolean
  }
  const subTails = new Map<string, SubTail>() // keyed by absolute file path

  /**
   * Idle window before a sub-agent FSWatcher is considered safe to
   * close. Sub-agents finish in seconds-to-minutes; 5 min is well
   * past the 99th-percentile completion time and cheap on the rare
   * very-long task (rescanSubagents picks the file back up on the
   * next tick if it grows).
   */
  // Floor-clamp the reap window: a 0 / negative override would make
  // `reapIdleSubTails` treat every live sub-tail as instantly idle
  // (cutoff = Date.now() - 0 ≥ lastActivityAt), reaping every live
  // sidecar on the first tick. Only tests set this today, but the clamp
  // makes the footgun unreachable — the smallest sane window is 1s.
  const IDLE_FSWATCH_TTL_MS = Math.max(1000, config.subTailIdleReapMs ?? 5 * 60 * 1000)

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
      t.lastActivityAt = Date.now()
      const text = t.pendingPartial + buf.toString('utf-8')
      const lines = text.split('\n')
      t.pendingPartial = lines.pop() ?? ''
      const startState = { hasEmittedStart: t.hasEmittedStart }
      for (const line of lines) {
        if (!line) continue
        // Track terminal record presence: a sub-agent JSONL terminal line
        // has type=result, subtype=end, or type=final. These indicate the
        // harness wrote a proper completion record, so the sub-agent is NOT
        // capped even if tool_use count is high.
        if (!t.hasSeenTerminal) {
          try {
            const raw = JSON.parse(line) as Record<string, unknown>
            if (
              raw.type === 'result' ||
              raw.type === 'final' ||
              raw.type === 'error' ||
              raw.type === 'cancel' ||
              (raw.type === 'system' && raw.subtype === 'end') ||
              raw.subtype === 'end'
            ) {
              t.hasSeenTerminal = true
            }
          } catch { /* ignore parse errors — projectSubagentLine will handle */ }
        }
        const events = projectSubagentLine(line, t.agentId, startState)
        for (const ev of events) {
          // Count tool_use events for capped-detection heuristic.
          if (ev.kind === 'sub_agent_tool_use') {
            t.toolUseCount++
          }
          // sub_agent_turn_end is a synthetic terminal — the parent saw a
          // system:turn_duration line, meaning the harness completed normally.
          if (ev.kind === 'sub_agent_turn_end') {
            t.hasSeenTerminal = true
          }
          try {
            // Sub-agent JSONLs have their own sessionId (the file's stem
            // — sub-agent files are typically named agent-<id>.jsonl).
            // Hook fires inside the sub-agent process with that
            // session_id, so we look up the sidecar by it.
            const subSid = sessionIdForFile(t.file)
            onEvent(decorate(ev, subSid))
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
      lastActivityAt: Date.now(),
      toolUseCount: 0,
      hasSeenTerminal: false,
      cappedEmitted: false,
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
   * Drop sub-tails whose underlying file hasn't grown in
   * IDLE_FSWATCH_TTL_MS. Closes the FSWatcher (releasing the FD) and
   * removes the entry from `subTails`. If the file later grows again
   * — unusual but possible if a sub-agent resumes — `rescanSubagents`
   * will re-attach on its next tick.
   *
   * Pre-MEM2 fix the per-file FSWatcher lived for the entire process
   * lifetime. With the subagent-watcher (MEM1) ALSO holding a watcher
   * on the same file, the FD bleed was doubled.
   */
  function reapIdleSubTails(): void {
    if (subTails.size === 0) return
    const cutoff = Date.now() - IDLE_FSWATCH_TTL_MS
    for (const [file, t] of subTails) {
      if (t.lastActivityAt < cutoff) {
        // Before reaping: check whether this looks like a capped transcript.
        // A sub-agent with >= CAP_TOOL_USE_THRESHOLD tool_uses and no terminal
        // record was most likely killed mid-flight. Emit sub_agent_capped once
        // so the progress-card driver can transition the fleet member to a
        // terminal "capped" state rather than leaving it stuck at "running".
        if (!t.hasSeenTerminal && !t.cappedEmitted && t.toolUseCount >= CAP_TOOL_USE_THRESHOLD) {
          t.cappedEmitted = true
          try {
            onEvent({ kind: 'sub_agent_capped', agentId: t.agentId, toolUseCount: t.toolUseCount })
          } catch (err) {
            log?.(`session-tail: sub_agent_capped onEvent threw: ${(err as Error).message}`)
          }
          log?.(`session-tail: sub ${t.agentId} capped (${t.toolUseCount} tool_uses, no terminal record)`)
        }
        if (t.watcher) {
          try { t.watcher.close() } catch { /* ignore */ }
          t.watcher = null
        }
        // M1 FD-leak fix: reap the sub-agent's PreToolUse sidecar alongside its
        // file watcher. Sub-agent sidecars are keyed by the sub file's stem
        // (`agent-<id>`), created lazily by `decorate` while reading the sub
        // JSONL. Pre-fix `reapIdleSubTails` closed the sub-tail watcher but left
        // the sidecar (and its poll timer) alive until `stop()`, so a long-lived
        // agent leaked one sidecar per finished sub-agent.
        stopSidecar(sessionIdForFile(t.file))
        subTails.delete(file)
        log?.(`session-tail: reaped idle sub ${t.agentId} (${file})`)
      }
    }
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
    // MEM2: reap subtails whose underlying JSONL has been idle for a
    // while. The reap is guarded by IDLE_FSWATCH_TTL_MS (5 min by
    // default) so steady-state workloads don't thrash.
    reapIdleSubTails()
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
      for (const s of sidecars.values()) {
        try { s.stop() } catch { /* ignore */ }
      }
      sidecars.clear()
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
