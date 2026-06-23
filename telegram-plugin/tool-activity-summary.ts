/**
 * Tool-activity feed — a Claude-Code-style live list of what the agent
 * is doing this turn, rendered into ONE Telegram message that edits in
 * place and clears the moment the model's real reply lands.
 *
 * Each non-surface tool gets a human-friendly, present-tense line
 * ("Reading CLAUDE.md", "Searching memory", "Running a command"); the
 * feed renders them chronologically (oldest first, newest = the
 * in-progress step), consecutive duplicates collapsed, capped to the
 * most recent MIRROR_MAX_LINES with a "+N earlier" header.
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
// exact-duplicates collapsed, capped to the most recent MIRROR_MAX_LINES
// with a "+N earlier" header so a heavy turn stays readable.
//
// When SWITCHROOM_STATUS_NO_TRUNCATE is not '0' (the default), per-line "…"
// clips and overflow headers are dropped; only the last STATUS_ROLLING_LINES
// steps are shown in full, bounded by the 4096-char limit (STATUS_CARD_CHAR_BUDGET).

import { statusNoTruncate, STATUS_CARD_CHAR_BUDGET, STATUS_ROLLING_LINES } from './status-no-truncate.js'
import { isTelegramSurfaceTool } from './tool-names.js'

export const MIRROR_MAX_LINES = 6;

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
 * Clip a raw narrative text block down to a single transient liveness line:
 * first line only, trimmed, sliced to 120 chars. Shared by the main-agent
 * gateway path and the sub-agent watcher so both render narrative identically
 * (mirrors the watcher's historical `lastSummaryLine` clip). Returns the raw
 * (unescaped) clipped string — callers escape via the renderStepFeed path,
 * exactly like a tool label.
 */
export function clipNarrative(s: string): string {
  return (s ?? "").split("\n")[0].trim().slice(0, 120);
}

/** Minimal HTML escape for Telegram parse_mode=HTML (matches the gateway's). */
export function escapeFeedHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
 * `state`       — 'running' | 'done' (controls the status line wording)
 *
 * Returns a two-element array of ready Telegram HTML lines (no trailing newline).
 */
export function renderActivityHeader(
  emoji: string,
  label: string,
  description: string,
  elapsedMs: number,
  toolCount: number,
  state: 'running' | 'done',
): [string, string] {
  const toolWord = toolCount === 1 ? 'tool' : 'tools'
  const elapsed = formatFeedElapsed(elapsedMs)
  const descPart = description.length > 0 ? ` · <i>${escapeFeedHtml(description)}</i>` : ''
  const line1 = `${emoji} <b>${escapeFeedHtml(label)}</b>${descPart}`
  const line2 = state === 'done'
    ? `<i>done · ${toolCount} ${toolWord} · ${elapsed}</i>`
    : `<i>${elapsed} · ${toolCount} ${toolWord}</i>`
  return [line1, line2]
}

/** Format elapsed milliseconds for display in the activity header (e.g. "12s", "2m05s"). */
export function formatFeedElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${(s % 60).toString().padStart(2, '0')}s`
}

/**
 * Shared step-feed renderer used by both the main-session card and the worker
 * card. Appends `✓`/`→` bullet lines to `out` for the given pre-escaped
 * step strings.
 *
 * `steps`     — pre-HTML-escaped step strings (raw text NOT expected here;
 *               callers must escape before passing)
 * `allDone`   — when true ALL steps render done (✓ italic); when false the
 *               newest renders in-progress (→ bold)
 * `noTruncate`— when true: rolling STATUS_ROLLING_LINES window, no overflow
 *               header; when false: cap to MIRROR_MAX_LINES with overflow
 *               header (legacy mode)
 * `maxLines`  — cap in non-noTruncate mode (default MIRROR_MAX_LINES)
 *
 * Mutates `out` in place; returns nothing.
 */
export function renderStepFeed(
  out: string[],
  steps: string[],
  allDone: boolean,
  noTruncate: boolean,
  maxLines = MIRROR_MAX_LINES,
  liveSuffix = '',
): void {
  if (steps.length === 0) return
  let shown: string[]
  if (noTruncate) {
    shown = steps.slice(-STATUS_ROLLING_LINES)
    // No overflow header in no-truncate mode — strictly the rolling window.
  } else {
    shown = steps.slice(-maxLines)
    const hidden = steps.length - shown.length
    if (hidden > 0) out.push(`<i>✓ +${hidden} earlier…</i>`)
  }
  const lastIdx = shown.length - 1
  shown.forEach((s, i) => {
    out.push(!allDone && i === lastIdx ? `<b>→ ${s}${liveSuffix}</b>` : `<i>✓ ${s}</i>`)
  })
}

/**
 * Render the accumulated feed as ready Telegram HTML — one action per line,
 * newest last. The current (newest) step is bold with a `→`; finished steps
 * are italic with a `✓`. Capped to the last MIRROR_MAX_LINES with a dim
 * `✓ +N earlier…` header when the turn ran longer. Returns null when empty.
 * Callers send the result verbatim — do NOT re-escape or re-wrap it.
 *
 * When SWITCHROOM_STATUS_NO_TRUNCATE is on (default), shows only the last
 * STATUS_ROLLING_LINES lines in full (no per-line "…"), with NO overflow
 * header. The only remaining ceiling is STATUS_CARD_CHAR_BUDGET (wire-limit
 * backstop via `_fitToCharBudget`).
 *
 * `stepCount` (optional): when `final=true` and `stepCount > 0`, appends a
 * `✓ N steps` footer line so the persisted feed record shows an accurate
 * total of surfaced (non-surface-tool) steps for the turn.
 *
 * `header` (optional): when provided, prepends a two-line activity header
 * (matching the worker card's style) so the main-session card shows
 * elapsed time + tool count alongside the step feed. The gateway threads
 * `turn.startedAt` + `turn.labeledToolCount` into this.
 */
export function renderActivityFeed(
  lines: string[],
  final = false,
  liveSuffix = "",
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  if (lines.length === 0 && header == null) return null;
  const noTruncate = statusNoTruncate();
  const out: string[] = [];

  // Optional header block — mirrors the worker card's two-line header.
  if (header != null) {
    const [h1, h2] = renderActivityHeader(
      '🤖',
      header.label,
      '',
      header.elapsedMs,
      header.toolCount,
      header.state,
    )
    out.push(h1)
    out.push(h2)
  }

  if (lines.length === 0) {
    // Header-only (no steps yet) — only reachable when a header was supplied.
    const result = out.join('\n')
    return result.length > 0 ? result : null
  }

  // Escape all lines before passing to renderStepFeed.
  const escaped = lines.map(escapeFeedHtml)

  // No-truncate ON: rolling STATUS_ROLLING_LINES window, no overflow header.
  // No-truncate OFF: cap to MIRROR_MAX_LINES with overflow header.
  if (noTruncate) {
    const shown = escaped.slice(-STATUS_ROLLING_LINES)
    const lastIdx = shown.length - 1
    shown.forEach((esc, i) => {
      out.push(i === lastIdx && !final ? `<b>→ ${esc}${liveSuffix}</b>` : `<i>✓ ${esc}</i>`)
    })
  } else {
    const shown = escaped.slice(-MIRROR_MAX_LINES)
    const hidden = escaped.length - shown.length
    if (hidden > 0) out.push(`<i>✓ +${hidden} earlier…</i>`)
    const lastIdx = shown.length - 1
    // Newest line = in-progress step (bold, →); earlier = done (italic, ✓).
    // `final` (turn complete, feed left as a record): ALL lines render done (✓)
    // so the persisted message doesn't freeze on a misleading "→ in-progress".
    // `liveSuffix` (heartbeat): appended INSIDE the newest in-progress line only
    // (e.g. " · 18s") so the feed visibly advances during a long single step that
    // emits no new tool label — the feed is otherwise pull-only and freezes.
    // Caller passes framework-generated, HTML-safe text; never final + suffix.
    // Returns ready Telegram HTML — callers must NOT re-escape or re-wrap it.
    shown.forEach((esc, i) => {
      out.push(i === lastIdx && !final ? `<b>→ ${esc}${liveSuffix}</b>` : `<i>✓ ${esc}</i>`)
    })
  }

  // Final total: append a `✓ N steps` footer when the turn has a non-zero
  // surfaced step count. Only shown on the persisted terminal render
  // (`final=true`) so the live in-progress feed stays clean.
  if (final && stepCount != null && stepCount > 0) {
    out.push(`<i>✓ ${stepCount} steps</i>`);
  }
  const result = out.join("\n");
  // No-truncate mode: enforce the Telegram char budget as the only ceiling.
  // With STATUS_ROLLING_LINES=5 full lines (~750 chars) this effectively never
  // fires, but keep it as the wire-limit safety net.
  if (noTruncate && result.length > STATUS_CARD_CHAR_BUDGET) {
    return _fitToCharBudget(lines, final, liveSuffix, stepCount, header);
  }
  return result;
}

/**
 * Internal helper: called only in no-truncate mode when the full render
 * exceeds STATUS_CARD_CHAR_BUDGET. Drops oldest lines one at a time until
 * the rendered output fits, prepending a "+N earlier…" header to surface
 * the clip. The caller is responsible for not re-calling this recursively
 * (the budget is wide enough that a "+N" header itself never causes overflow).
 */
function _fitToCharBudget(
  lines: string[],
  final: boolean,
  liveSuffix: string,
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  // Pre-render the header block (if any) so we can measure its cost.
  const headerLines: string[] = []
  if (header != null) {
    const [h1, h2] = renderActivityHeader('🤖', header.label, '', header.elapsedMs, header.toolCount, header.state)
    headerLines.push(h1, h2)
  }
  const headerPrefix = headerLines.length > 0 ? headerLines.join('\n') + '\n' : ''
  const headerCost = headerPrefix.length

  for (let drop = 1; drop < lines.length; drop++) {
    const shown = lines.slice(drop);
    const out: string[] = [...headerLines, `<i>✓ +${drop} earlier…</i>`];
    const lastIdx = shown.length - 1;
    shown.forEach((l, i) => {
      const esc = escapeFeedHtml(l);
      out.push(i === lastIdx && !final ? `<b>→ ${esc}${liveSuffix}</b>` : `<i>✓ ${esc}</i>`);
    });
    if (final && stepCount != null && stepCount > 0) {
      out.push(`<i>✓ ${stepCount} steps</i>`);
    }
    const candidate = out.join("\n");
    if (candidate.length <= STATUS_CARD_CHAR_BUDGET) return candidate;
  }
  // Rare but reachable with long Bash labels containing special chars (e.g. &&).
  // Never slice already-escaped HTML — that breaks entities (&amp; → &amp) and
  // leaves dangling tags. Instead truncate the RAW content first, then escape
  // and wrap, re-checking post-escape because escaping can expand (&→&amp;).
  const wrapperOverhead = final
    ? "<i>✓ </i>".length
    : ("<b>→ </b>".length + liveSuffix.length);
  const maxRaw = Math.max(0, STATUS_CARD_CHAR_BUDGET - wrapperOverhead - headerCost);
  let raw = lines[lines.length - 1].slice(0, maxRaw);
  let newest = escapeFeedHtml(raw);
  while (raw.length > 0 && wrapperOverhead + headerCost + newest.length > STATUS_CARD_CHAR_BUDGET) {
    const excess = wrapperOverhead + headerCost + newest.length - STATUS_CARD_CHAR_BUDGET;
    raw = raw.slice(0, Math.max(0, raw.length - excess - 1));
    newest = escapeFeedHtml(raw);
  }
  const newestLine = final ? `<i>✓ ${newest}</i>` : `<b>→ ${newest}${liveSuffix}</b>`
  return headerPrefix.length > 0 ? `${headerPrefix}${newestLine}` : newestLine
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
/** Hard cap on a single nested narrative line. */
const NESTED_LINE_MAX = 90;
/** Indent marker for a nested sub-agent step. */
const NESTED_PREFIX = "   ↳ ";

/**
 * Render the parent activity feed with an active foreground sub-agent's steps
 * nested beneath it. When `childLines` is empty this is identical to
 * `renderActivityFeed(lines)`. Otherwise the parent's own lines are all
 * done-styled (`✓` italic) — the live `→` step lives in the nested block —
 * and the child block is indented, newest = bold `→`, earlier = italic, with
 * a `↳ +N earlier…` header when it overflows. Returns ready Telegram HTML
 * (callers must NOT re-escape) or null when there is nothing to show.
 *
 * `stepCount` (optional): forwarded to `renderActivityFeed` for the `✓ N steps`
 * footer on the persisted terminal render (`final=true`).
 *
 * `header` (optional): when provided, prepends a two-line activity header
 * (elapsed + tool count) matching the worker card's style. Forwarded to
 * `renderActivityFeed` when there are no child lines.
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

  const noTruncate = statusNoTruncate();
  const out: string[] = [];

  // Optional header block — same two-line style as the worker card.
  if (header != null) {
    const [h1, h2] = renderActivityHeader('🤖', header.label, '', header.elapsedMs, header.toolCount, header.state)
    out.push(h1)
    out.push(h2)
  }

  // Parent lines:
  //   no-truncate ON  → rolling STATUS_ROLLING_LINES window, no overflow header.
  //   no-truncate OFF → cap to MIRROR_MAX_LINES with overflow header.
  const shownParent = noTruncate ? lines.slice(-STATUS_ROLLING_LINES) : lines.slice(-MIRROR_MAX_LINES);
  if (!noTruncate) {
    const hiddenParent = lines.length - shownParent.length;
    if (hiddenParent > 0) out.push(`<i>✓ +${hiddenParent} earlier…</i>`);
  }
  for (const l of shownParent) out.push(`<i>✓ ${escapeFeedHtml(l)}</i>`);

  // Child lines:
  //   no-truncate ON  → rolling STATUS_ROLLING_LINES window, no overflow header,
  //                     each line in FULL (no NESTED_LINE_MAX "…").
  //   no-truncate OFF → cap to NESTED_MAX_LINES with overflow header + NESTED_LINE_MAX clip.
  const shownChild = noTruncate ? children.slice(-STATUS_ROLLING_LINES) : children.slice(-NESTED_MAX_LINES);
  if (!noTruncate) {
    const hiddenChild = children.length - shownChild.length;
    if (hiddenChild > 0) out.push(`${NESTED_PREFIX}<i>+${hiddenChild} earlier…</i>`);
  }
  const lastChildIdx = shownChild.length - 1;
  // `final`: the nested newest step also renders done (✓) so the left-behind
  // feed reads as completed, not stuck on a "→ in-progress" child step.
  // `liveSuffix` (heartbeat): appended to the nested newest in-progress step.
  // NESTED_LINE_MAX per-line cap: only applied when no-truncate is OFF.
  shownChild.forEach((l, i) => {
    const t = (!noTruncate && l.length > NESTED_LINE_MAX) ? l.slice(0, NESTED_LINE_MAX - 1) + "…" : l;
    const esc = escapeFeedHtml(t);
    out.push(
      i === lastChildIdx && !final
        ? `${NESTED_PREFIX}<b>→ ${esc}${liveSuffix}</b>`
        : `${NESTED_PREFIX}<i>${esc}</i>`,
    );
  });
  // Final total: same `✓ N steps` footer as the flat render.
  if (final && stepCount != null && stepCount > 0) {
    out.push(`<i>✓ ${stepCount} steps</i>`);
  }
  // out.length > 0 is guaranteed if children.length > 0 (at least one child line).
  // The `header != null` path above also ensures content, but an empty result
  // with no header AND no parent AND no child lines can't happen (children filtered).
  if (out.length === 0) return null;
  const result = out.join("\n");
  // No-truncate mode: enforce the Telegram char budget as the only ceiling.
  // With STATUS_ROLLING_LINES=5 full lines (~750 chars) this effectively never
  // fires, but keep it as the wire-limit safety net.
  if (noTruncate && result.length > STATUS_CARD_CHAR_BUDGET) {
    return _fitNestedToCharBudget(lines, children, final, liveSuffix, stepCount, header);
  }
  return result;
}

/**
 * Internal helper: called only in no-truncate mode when the full nested render
 * exceeds STATUS_CARD_CHAR_BUDGET. Trims oldest parent lines first, then
 * oldest child lines, until the output fits, surfacing a "+N earlier…" header
 * for each dropped group.
 */
function _fitNestedToCharBudget(
  lines: string[],
  children: string[],
  final: boolean,
  liveSuffix: string,
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  // Pre-render the header block (if any) so we can include it as fixed lines.
  const headerLines: string[] = []
  if (header != null) {
    const [h1, h2] = renderActivityHeader('🤖', header.label, '', header.elapsedMs, header.toolCount, header.state)
    headerLines.push(h1, h2)
  }

  // Try dropping parent lines first (oldest first), keeping all children.
  for (let pDrop = 1; pDrop <= lines.length; pDrop++) {
    const shownP = lines.slice(pDrop);
    const out: string[] = [...headerLines];
    if (pDrop > 0) out.push(`<i>✓ +${pDrop} earlier…</i>`);
    for (const l of shownP) out.push(`<i>✓ ${escapeFeedHtml(l)}</i>`);
    const lastChildIdx = children.length - 1;
    children.forEach((l, i) => {
      const esc = escapeFeedHtml(l);
      out.push(
        i === lastChildIdx && !final
          ? `${NESTED_PREFIX}<b>→ ${esc}${liveSuffix}</b>`
          : `${NESTED_PREFIX}<i>${esc}</i>`,
      );
    });
    if (final && stepCount != null && stepCount > 0) out.push(`<i>✓ ${stepCount} steps</i>`);
    const candidate = out.join("\n");
    if (candidate.length <= STATUS_CARD_CHAR_BUDGET) return candidate;
  }
  // Parent fully dropped; now also drop child lines oldest first.
  for (let cDrop = 1; cDrop < children.length; cDrop++) {
    const shownC = children.slice(cDrop);
    const out: string[] = [
      ...headerLines,
      `<i>✓ +${lines.length} earlier…</i>`,
      `${NESTED_PREFIX}<i>+${cDrop} earlier…</i>`,
    ];
    const lastChildIdx = shownC.length - 1;
    shownC.forEach((l, i) => {
      const esc = escapeFeedHtml(l);
      out.push(
        i === lastChildIdx && !final
          ? `${NESTED_PREFIX}<b>→ ${esc}${liveSuffix}</b>`
          : `${NESTED_PREFIX}<i>${esc}</i>`,
      );
    });
    if (final && stepCount != null && stepCount > 0) out.push(`<i>✓ ${stepCount} steps</i>`);
    const candidate = out.join("\n");
    if (candidate.length <= STATUS_CARD_CHAR_BUDGET) return candidate;
  }
  // Rare but reachable with long Bash labels containing special chars (e.g. &&).
  // Never slice already-escaped HTML — that breaks entities and leaves dangling tags.
  // Truncate RAW content first, then escape and wrap, re-checking post-escape.
  const headerCost = headerLines.length > 0 ? headerLines.join('\n').length + 1 : 0
  const wrapperOverhead = final
    ? (NESTED_PREFIX + "<i></i>").length
    : (NESTED_PREFIX + "<b>→ </b>").length + liveSuffix.length;
  const maxRaw = Math.max(0, STATUS_CARD_CHAR_BUDGET - wrapperOverhead - headerCost);
  let raw = children[children.length - 1].slice(0, maxRaw);
  let newest = escapeFeedHtml(raw);
  while (raw.length > 0 && wrapperOverhead + headerCost + newest.length > STATUS_CARD_CHAR_BUDGET) {
    const excess = wrapperOverhead + headerCost + newest.length - STATUS_CARD_CHAR_BUDGET;
    raw = raw.slice(0, Math.max(0, raw.length - excess - 1));
    newest = escapeFeedHtml(raw);
  }
  const newestLine = final
    ? `${NESTED_PREFIX}<i>${newest}</i>`
    : `${NESTED_PREFIX}<b>→ ${newest}${liveSuffix}</b>`
  return headerLines.length > 0
    ? [...headerLines, newestLine].join('\n')
    : newestLine
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
