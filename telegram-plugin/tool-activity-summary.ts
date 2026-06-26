/**
 * Tool-activity feed — a Claude-Code-style live list of what the agent
 * is doing this turn, rendered into ONE Telegram message that edits in
 * place and clears the moment the model's real reply lands.
 *
 * Each non-surface tool gets a human-friendly, present-tense line
 * ("Reading CLAUDE.md", "Searching memory", "Running a command"); the
 * feed renders them chronologically (oldest first, newest = the
 * in-progress step), consecutive duplicates collapsed, windowed to the
 * most recent STATUS_ROLLING_LINES with a "+N earlier…" overflow header.
 *
 * Two append entrypoints feed the same `lines: string[]` accumulator:
 *   - `appendActivityLabel` — for a pre-computed label from the
 *     real-time PreToolUse sidecar (`tool_label` event). This is the
 *     gateway's live driver: it fires at tool-call time regardless of
 *     when claude flushes the transcript, so it stays deterministic on
 *     fast/clustered-tool turns.
 *   - `appendActivityLine` — derives the label from a tool_use's name +
 *     input via `describeToolUse` (used where the raw tool_use is the
 *     only signal available).
 */

// ─── Friendly per-tool rendering ────────────────────────────────────────────
//
// Claude Code's own UI reads human-friendly because the model AUTHORS the
// descriptive text inside each tool_use.input — verified against a real
// session JSONL (1360 Bash calls etc.):
//   Bash         → input.description   ("Get CLAUDE.md size and recent history")
//   Read         → input.file_path     (basename → "Reading CLAUDE.md")
//   Edit/Write   → input.file_path     (basename)
//   Grep/Glob    → input.pattern
//   Task/Agent   → input.description   (the sub-agent's task)
//   WebFetch     → input.url           (hostname → "Reading example.com")
//   hindsight    → friendly label      ("Searching memory")
// There is never a raw `grep`/`jq`/`ls` to surface — only the model's own
// plain-English description or a domain label. This is the signal the
// draft-mirror renders (option A: uniform across code + non-code agents).

/** Strip a path to its basename for display. */
function baseName(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0) return null;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/** Extract a bare hostname from a URL for display (no scheme/path). */
function hostName(u: unknown): string | null {
  if (typeof u !== "string" || u.length === 0) return null;
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u.replace(/^https?:\/\//, "").split("/")[0] || null;
  }
}

function clip(s: unknown, n: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length === 0) return null;
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * Render a single tool_use into a human-friendly, present-tense activity
 * line for the live draft preview — or null when the tool should NOT be
 * surfaced (the Telegram-plugin surface tools, which ARE the conversation).
 *
 * Leads with the model-authored descriptive field per the map above; falls
 * back to a domain label, then to a humanized tool name. Never emits raw
 * shell/query syntax.
 */
export function describeToolUse(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!toolName) return null;
  const inp = input ?? {};

  const mcpMatch = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcpMatch) {
    const server = mcpMatch[1].toLowerCase();
    const tool = mcpMatch[2].toLowerCase();
    // Surface tools ARE the conversation — never mirror them.
    // Use isTelegramSurfaceTool (regex-based, key-agnostic) so forks/renames work.
    if (isTelegramSurfaceTool(toolName)) return null;
    if (server === "hindsight") {
      if (tool === "recall" || tool === "reflect") return "Searching memory";
      if (tool === "retain" || tool === "update_memory" || tool === "sync_retain")
        return "Saving to memory";
      return "Working with memory";
    }
    if (
      server === "google-workspace" ||
      server === "claude_ai_google_calendar"
    ) {
      return "Checking your calendar";
    }
    if (server === "claude_ai_gmail") return "Checking your email";
    if (server === "claude_ai_google_drive") return "Looking through your files";
    if (server === "notion" || server === "claude_ai_notion") {
      return "Checking your notes";
    }
    // Unknown MCP tool: prefer a model-authored field, else a humanized name.
    const desc = clip(inp.description, 60) ?? clip(inp.query, 50) ?? clip(inp.title, 50);
    if (desc) return desc;
    return "Using " + tool.replace(/[-_]+/g, " ");
  }

  switch (toolName) {
    case "Bash": {
      // The model writes a plain-English description for every command.
      return clip(inp.description, 70) ?? "Running a command";
    }
    case "BashOutput":
    case "KillShell":
      return "Managing a background command";
    case "Read": {
      const f = baseName(inp.file_path);
      return f ? `Reading ${f}` : "Reading a file";
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const f = baseName(inp.file_path) ?? baseName(inp.notebook_path);
      return f ? `Editing ${f}` : "Editing a file";
    }
    case "Write": {
      const f = baseName(inp.file_path);
      return f ? `Writing ${f}` : "Writing a file";
    }
    case "Grep":
    case "Glob": {
      const p = clip(inp.pattern, 40);
      return p ? `Searching for ${p}` : "Searching files";
    }
    case "WebFetch": {
      const h = hostName(inp.url);
      return h ? `Reading ${h}` : "Reading a web page";
    }
    case "WebSearch": {
      const q = clip(inp.query, 50);
      return q ? `Searching the web for ${q}` : "Searching the web";
    }
    case "Task":
    case "Agent": {
      const d = clip(inp.description, 60);
      return d ? `Delegating: ${d}` : "Delegating to a sub-agent";
    }
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return "Updating the plan";
    case "ToolSearch":
      return "Finding the right tool";
    default:
      return "Working…";
  }
}

// ─── Accumulating activity feed (draft-mirror Phase 2) ──────────────────────
//
// Accumulates the turn's actions into a running feed — like Claude Code's
// own UI — rendered into one Telegram message that edits in place and is
// cleared on reply. Chronological (oldest first, newest last), consecutive
// exact-duplicates collapsed.
//
// Both this surface (agent) and the worker feed render through the single
// `renderStatusCard` primitive below: a rolling window of the last
// STATUS_ROLLING_LINES steps, each capped at STATUS_LINE_MAX chars, with a
// `+N earlier…` header when the feed overflows, bounded by the 4000-char
// wire-limit backstop (STATUS_CARD_CHAR_BUDGET).

import {
  STATUS_CARD_CHAR_BUDGET,
  STATUS_ROLLING_LINES,
  STATUS_LINE_MAX,
  NESTED_PREFIX,
} from './status-no-truncate.js'
import { escapeHtml, stripMarkdown, truncate } from './card-format.js'
import { isTelegramSurfaceTool } from './tool-names.js'

/**
 * Optional header for the main-session activity card, matching the worker
 * card's two-line header style so both cards render consistently.
 *
 * `label`    — first header line text (e.g. "Agent")
 * `elapsedMs`— wall-clock since the turn started (for the elapsed field)
 * `toolCount`— labeled (non-surface) tool calls so far
 * `state`    — 'running' | 'done' (controls finished vs. in-progress status wording)
 */
export interface SessionActivityHeader {
  label: string
  elapsedMs: number
  toolCount: number
  state: 'running' | 'done'
}

/**
 * Append a tool_use's friendly line to the running feed (mutates `lines`)
 * and return the rendered feed (ready Telegram HTML) — or null when the
 * tool is a surface tool / produced no line (caller skips the update).
 *
 * Dedups only consecutive identical lines (e.g. a burst of parallel Reads of
 * the same file) so distinct actions are all preserved.
 */
export function appendActivityLine(
  lines: string[],
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  const line = describeToolUse(toolName, input);
  if (line == null) return null;
  if (lines.length === 0 || lines[lines.length - 1] !== line) {
    lines.push(line);
  }
  return renderActivityFeed(lines);
}

/**
 * Clip a raw narrative text block down to a single durable feed line:
 * first line only, trimmed, sliced to STATUS_LINE_MAX (200) chars.
 *
 * 200 chars matches the tool-label cap used by `escapeStepLine` / `renderStepFeed`
 * so a narrative line is legible at the same length as a tool step — "Analysing
 * the 12 changed files in /src/auth to understand the scope of…" rather than a
 * hard-truncated 120-char fragment that drops context mid-sentence.
 *
 * Shared by the main-agent gateway path and the sub-agent watcher so both render
 * narrative identically. Returns the raw (unescaped) clipped string — callers
 * escape via the renderStepFeed path, exactly like a tool label.
 */
export function clipNarrative(s: string): string {
  // `s` is a non-nullable string at every call site (showNarrativeStep passes
  // ev.text; the foreground-sub path passes `progressLine ?? latestSummary`,
  // both typed string), so no null guard is needed.
  return s.split('\n')[0].trim().slice(0, STATUS_LINE_MAX);
}

/**
 * Render a two-line header for the activity card, matching the worker card's
 * style. Used by both the main-session card and the worker card.
 *
 * Line 1: `<emoji> <b>Label</b> · <i>description</i>`  (description optional)
 * Line 2: status + elapsed + tool count
 *
 * `emoji`       — leading emoji (e.g. "🤖", "🛠")
 * `label`       — bold name (e.g. "Agent", "Worker")
 * `description` — italicised task description (optional)
 * `elapsedMs`   — wall-clock elapsed, rendered via `formatFeedElapsed`
 * `toolCount`   — labeled tool calls this turn
 * `state`       — 'running' | 'done' | 'failed' (controls the status line wording;
 *                 'failed' renders `failed · …` so a failed worker never reads as done)
 *
 * Returns a two-element array of ready Telegram HTML lines (no trailing newline).
 */
export function renderActivityHeader(
  emoji: string,
  label: string,
  description: string,
  elapsedMs: number,
  toolCount: number,
  state: 'running' | 'done' | 'failed',
): [string, string] {
  const toolWord = toolCount === 1 ? 'tool' : 'tools'
  const elapsed = formatFeedElapsed(elapsedMs)
  const descPart = description.length > 0 ? ` · <i>${escapeHtml(description)}</i>` : ''
  const line1 = `${emoji} <b>${escapeHtml(label)}</b>${descPart}`
  const line2 = state === 'running'
    ? `<i>${elapsed} · ${toolCount} ${toolWord}</i>`
    : `<i>${state} · ${toolCount} ${toolWord} · ${elapsed}</i>`
  return [line1, line2]
}

/** Format elapsed milliseconds for display in the activity header (e.g. "12s", "2m05s"). */
export function formatFeedElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${(s % 60).toString().padStart(2, '0')}s`
}

// ─── Truncation pipeline (the single correctness-critical primitive) ────────
//
// Per RAW line, in this EXACT order:
//   1. stripMarkdown(raw)
//   2. .replace(/\s+/g, ' ').trim()
//   3. truncate(_, STATUS_LINE_MAX)
//   4. escapeHtml(_)   ← escape is ALWAYS the last per-line op.
// Escaping last is load-bearing: clipping an already-escaped string can split
// an HTML entity (&amp; → &amp), which Telegram's HTML parser rejects.

/** Clean + clip + escape a single raw step line. Returns ready-to-wrap HTML. */
function escapeStepLine(raw: string): string {
  const cleaned = stripMarkdown(raw).replace(/\s+/g, ' ').trim()
  return escapeHtml(truncate(cleaned, STATUS_LINE_MAX))
}

/**
 * Shared step-feed emitter. Appends `✓`/`→` bullet lines to `out` for the
 * given ALREADY-ESCAPED step strings, windowing to STATUS_ROLLING_LINES and
 * prepending a `+N earlier…` header when the feed overflows the window (on
 * BOTH surfaces now). The worker feed imports this directly.
 *
 * `out`        — accumulator mutated in place
 * `steps`      — pre-cleaned + pre-escaped HTML step strings
 * `allDone`    — when true ALL steps render done (✓ italic); when false the
 *                newest renders in-progress (→ bold)
 * `liveSuffix` — appended INSIDE the newest in-progress line (heartbeat tick)
 */
export function renderStepFeed(
  out: string[],
  steps: string[],
  allDone: boolean,
  liveSuffix = '',
): void {
  if (steps.length === 0) return
  const shown = steps.slice(-STATUS_ROLLING_LINES)
  const hidden = steps.length - shown.length
  if (hidden > 0) out.push(`<i>✓ +${hidden} earlier…</i>`)
  const lastIdx = shown.length - 1
  shown.forEach((s, i) => {
    out.push(!allDone && i === lastIdx ? `<b>→ ${s}${liveSuffix}</b>` : `<i>✓ ${s}</i>`)
  })
}

// ─── Unified status-card primitive ──────────────────────────────────────────
//
// Both status surfaces (🤖 agent + 🛠 worker) render through `renderStatusCard`.
// It is the single place that runs the per-line truncation pipeline, windows
// the rolling feed, prepends `+N earlier…`, wraps bullets, indents child
// steps, and applies the total-budget backstop.

/** Header block for a status card. Emoji 🤖 (agent) / 🛠 (worker). */
export interface StatusCardHeader {
  emoji: string
  label: string
  description?: string
  elapsedMs: number
  toolCount: number
  state: 'running' | 'done' | 'failed'
}

/** Inputs to the unified status-card renderer. */
export interface StatusCardOpts {
  /** Optional two-line header. When omitted, the card is steps-only. */
  header?: StatusCardHeader
  /** RAW parent step strings (unstripped, unescaped). */
  steps: string[]
  /** RAW nested child step strings (foreground sub-agent), unstripped/unescaped. */
  childSteps?: string[]
  /** Terminal record render — newest line renders done (✓) and `liveSuffix` is ignored. */
  final?: boolean
  /** Heartbeat suffix appended INSIDE the newest in-progress line (live only). */
  liveSuffix?: string
  /** When `final` and > 0, appends a `✓ N steps` footer. */
  stepCount?: number
  /** Optional terminal result block (worker recap), already-cleaned text + emoji. */
  result?: { emoji: string; text: string }
}

/**
 * Render the unified status card as ready Telegram HTML, or null when there is
 * no content to show (no header content, no steps, no children, no result).
 *
 * Pipeline: header → escape+clip every raw step/child → rolling-window each
 * group with `+N earlier…` → wrap (parent done-styled when children present;
 * newest-in-progress `→` bold else `✓` italic; NESTED_PREFIX for children) →
 * optional `✓ N steps` footer → optional result block → fitCardToBudget.
 */
export function renderStatusCard(opts: StatusCardOpts): string | null {
  const { header, final = false, liveSuffix = '', stepCount, result } = opts
  const rawSteps = opts.steps.filter((s) => s != null)
  const rawChildren = (opts.childSteps ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  const hasChildren = rawChildren.length > 0

  // Escape every line through the per-line pipeline (escape last).
  const steps = rawSteps.map(escapeStepLine)
  const children = rawChildren.map(escapeStepLine)

  const headerLines = header != null
    ? renderActivityHeader(
        header.emoji,
        header.label,
        header.description ?? '',
        header.elapsedMs,
        header.toolCount,
        // Thread the terminal state straight through so a failed worker reads
        // `failed · …` on line 2 — never byte-identical to a done worker even
        // when the result block is empty. The agent surface never passes
        // 'failed', so only the worker card is affected.
        header.state,
      )
    : []

  const out: string[] = [...headerLines]

  if (hasChildren) {
    // Parent lines all render done — the live → step lives in the nested block.
    const shownParent = steps.slice(-STATUS_ROLLING_LINES)
    const hiddenParent = steps.length - shownParent.length
    if (hiddenParent > 0) out.push(`<i>✓ +${hiddenParent} earlier…</i>`)
    for (const s of shownParent) out.push(`<i>✓ ${s}</i>`)
    // Child block.
    const shownChild = children.slice(-STATUS_ROLLING_LINES)
    const hiddenChild = children.length - shownChild.length
    if (hiddenChild > 0) out.push(`${NESTED_PREFIX}<i>+${hiddenChild} earlier…</i>`)
    const lastChildIdx = shownChild.length - 1
    shownChild.forEach((s, i) => {
      out.push(
        i === lastChildIdx && !final
          ? `${NESTED_PREFIX}<b>→ ${s}${liveSuffix}</b>`
          : `${NESTED_PREFIX}<i>${s}</i>`,
      )
    })
  } else {
    renderStepFeed(out, steps, final, liveSuffix)
  }

  if (final && stepCount != null && stepCount > 0) {
    out.push(`<i>✓ ${stepCount} steps</i>`)
  }

  if (result != null && result.text.length > 0) {
    out.push(WORKER_RESULT_RULE)
    out.push(`${result.emoji} <i>${escapeHtml(truncate(result.text, WORKER_RESULT_MAX))}</i>`)
  }

  // out always carries the two header lines, so it is never empty — but guard
  // against a degenerate header-less future caller.
  if (out.length === 0) return null
  const joined = out.join('\n')
  if (joined.length <= STATUS_CARD_CHAR_BUDGET) return joined
  return fitCardToBudget(opts, headerLines)
}

/** Subtle horizontal rule between the running feed and the finished result. */
const WORKER_RESULT_RULE = '─────'
/** Hard cap on the terminal result paragraph. */
const WORKER_RESULT_MAX = 320

/**
 * Char-budget backstop. Keeps the header / footer / result block fixed and
 * drops the oldest body bullets one at a time, re-inserting a `+N earlier…`
 * marker, until the card fits STATUS_CARD_CHAR_BUDGET. In the extreme case
 * (a single newest bullet that is itself oversized) it truncates the RAW
 * newest text, THEN escapes, THEN wraps — never slicing already-escaped HTML.
 */
function fitCardToBudget(opts: StatusCardOpts, headerLines: string[]): string {
  const { final = false, liveSuffix = '', stepCount, result } = opts
  const rawSteps = opts.steps.filter((s) => s != null)
  const rawChildren = (opts.childSteps ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  const hasChildren = rawChildren.length > 0

  // Fixed footer/result lines (always kept).
  const footerLines: string[] = []
  if (final && stepCount != null && stepCount > 0) footerLines.push(`<i>✓ ${stepCount} steps</i>`)
  if (result != null && result.text.length > 0) {
    footerLines.push(WORKER_RESULT_RULE)
    footerLines.push(`${result.emoji} <i>${escapeHtml(truncate(result.text, WORKER_RESULT_MAX))}</i>`)
  }
  const fixedCost = [...headerLines, ...footerLines].join('\n').length

  // The active "body" group whose oldest bullets we drop: children when
  // present (parent collapses to a single "+N" marker), else parent steps.
  const body = hasChildren ? rawChildren : rawSteps
  const escapedBody = body.map(escapeStepLine)
  const prefix = hasChildren ? NESTED_PREFIX : ''

  const buildBullet = (esc: string, isLast: boolean): string =>
    !final && isLast ? `${prefix}<b>→ ${esc}${liveSuffix}</b>` : `${prefix}<i>${esc}</i>`

  // Parent-collapsed marker line when we are dropping children but parent steps exist.
  const parentMarker =
    hasChildren && rawSteps.length > 0 ? `<i>✓ +${rawSteps.length} earlier…</i>` : null

  for (let drop = 1; drop < escapedBody.length; drop++) {
    const shown = escapedBody.slice(drop)
    const lines: string[] = [...headerLines]
    if (parentMarker != null) lines.push(parentMarker)
    lines.push(hasChildren ? `${NESTED_PREFIX}<i>+${drop} earlier…</i>` : `<i>✓ +${drop} earlier…</i>`)
    const lastIdx = shown.length - 1
    shown.forEach((esc, i) => lines.push(buildBullet(esc, i === lastIdx)))
    lines.push(...footerLines)
    const candidate = lines.join('\n')
    if (candidate.length <= STATUS_CARD_CHAR_BUDGET) return candidate
  }

  // Extreme: the single newest bullet is itself oversized. Truncate the RAW
  // newest text, then escape, then wrap — re-checking post-escape because
  // escaping can expand the string (& → &amp;).
  const rawNewest = body.length > 0 ? stripMarkdown(body[body.length - 1]).replace(/\s+/g, ' ').trim() : ''
  const wrapperOverhead = final
    ? (prefix + '<i>✓ </i>').length
    : (prefix + '<b>→ </b>').length + liveSuffix.length
  const headerFooterCost =
    fixedCost + (fixedCost > 0 ? 1 : 0) + (parentMarker != null ? parentMarker.length + 1 : 0)
  const budget = STATUS_CARD_CHAR_BUDGET - headerFooterCost - wrapperOverhead
  let raw = rawNewest.slice(0, Math.max(0, budget))
  let newest = escapeHtml(raw)
  while (raw.length > 0 && wrapperOverhead + headerFooterCost + newest.length > STATUS_CARD_CHAR_BUDGET) {
    const excess = wrapperOverhead + headerFooterCost + newest.length - STATUS_CARD_CHAR_BUDGET
    raw = raw.slice(0, Math.max(0, raw.length - excess - 1))
    newest = escapeHtml(raw)
  }
  const newestLine = final ? `${prefix}<i>✓ ${newest}</i>` : `${prefix}<b>→ ${newest}${liveSuffix}</b>`
  const lines: string[] = [...headerLines]
  if (parentMarker != null) lines.push(parentMarker)
  lines.push(newestLine)
  lines.push(...footerLines)
  return lines.join('\n')
}

/**
 * Render the accumulated feed as ready Telegram HTML — one action per line,
 * newest last. The current (newest) step is bold with a `→`; finished steps
 * are italic with a `✓`. Capped to the last STATUS_ROLLING_LINES with a dim
 * `✓ +N earlier…` header when the turn ran longer. Returns null when empty.
 * Callers send the result verbatim — do NOT re-escape or re-wrap it.
 *
 * Thin adapter over `renderStatusCard` (emoji 🤖, label 'Agent').
 *
 * `stepCount` (optional): when `final=true` and `stepCount > 0`, appends a
 * `✓ N steps` footer line.
 *
 * `header` (optional): when provided, the two-line activity header carries
 * elapsed + tool count.
 */
export function renderActivityFeed(
  lines: string[],
  final = false,
  liveSuffix = "",
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  if (lines.length === 0 && header == null) return null;
  return renderStatusCard({
    header: header != null
      ? {
          emoji: '🤖',
          label: header.label,
          elapsedMs: header.elapsedMs,
          toolCount: header.toolCount,
          state: header.state,
        }
      : undefined,
    steps: lines,
    final,
    liveSuffix,
    stepCount,
  })
}

// ─── Foreground sub-agent nesting (Model A) ─────────────────────────────────
//
// A foreground sub-agent (Task/Agent with no `run_in_background`) runs INSIDE
// the parent's turn — the parent is blocked at the Task tool until it returns.
// Rather than a separate message, its live steps nest under the parent's own
// activity feed: the gold-standard main-turn visibility applied one level
// down. The parent's lines render as done (the parent handed off; it isn't
// the active worker), and the sub-agent's recent narrative lines render as an
// indented `↳` block with the newest as the in-progress `→` step.

/** Trailing nested child lines kept visible (Telegram length + readability). */
export const NESTED_MAX_LINES = 4;

/**
 * Render the parent activity feed with an active foreground sub-agent's steps
 * nested beneath it. When `childLines` is empty this is identical to
 * `renderActivityFeed(lines)`. Otherwise the parent's own lines are all
 * done-styled (`✓` italic) — the live `→` step lives in the nested block —
 * and the child block is indented, newest = bold `→`, earlier = italic, with
 * a `↳ +N earlier…` header when it overflows. Returns ready Telegram HTML
 * (callers must NOT re-escape) or null when there is nothing to show.
 *
 * Thin adapter over `renderStatusCard` (emoji 🤖, label 'Agent', childSteps).
 */
export function renderActivityFeedWithNested(
  lines: string[],
  childLines: string[],
  final = false,
  liveSuffix = "",
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  const children = childLines.map((s) => s.trim()).filter((s) => s.length > 0);
  if (children.length === 0) return renderActivityFeed(lines, final, liveSuffix, stepCount, header);
  return renderStatusCard({
    header: header != null
      ? {
          emoji: '🤖',
          label: header.label,
          elapsedMs: header.elapsedMs,
          toolCount: header.toolCount,
          state: header.state,
        }
      : undefined,
    steps: lines,
    childSteps: children,
    final,
    liveSuffix,
    stepCount,
  })
}

/**
 * Like appendActivityLine, but for a pre-computed label (from the
 * real-time PreToolUse sidecar / `tool_label` event) — the hook already
 * rendered the friendly text, so we skip describeToolUse. Returns the
 * rendered feed, or null when the label is empty.
 */
export function appendActivityLabel(
  lines: string[],
  label: string | undefined,
): string | null {
  const l = (label ?? "").trim();
  if (l.length === 0) return null;
  if (lines.length === 0 || lines[lines.length - 1] !== l) {
    lines.push(l);
  }
  return renderActivityFeed(lines);
}
