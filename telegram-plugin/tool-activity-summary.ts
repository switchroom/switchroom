/**
 * Tool-activity summary — Claude Code-style natural-language progress
 * line that batches tool_use events for a turn into a single Telegram
 * message that updates in place.
 *
 * Replaces the per-tool intent surface (#1924). The screenshot from
 * Claude Code's own UI shows lines like:
 *
 *   "Ran 5 commands, read a file"
 *   "Edited a file, read a file, ran a command"
 *
 * Past tense, comma-joined, singular/plural-aware. One message per
 * "phase" (turn start → first reply), progressively edited as tools
 * accumulate. NOT raw tool calls — descriptions of what the agent has
 * been doing.
 *
 * Why this beats per-tool labels:
 *   - One Telegram message per phase (low signal-to-noise vs N
 *     messages on a heavy turn)
 *   - The user sees ACCUMULATED work in a glanceable form, not a flood
 *   - Plays nicely with the existing answer-lane stream that handles
 *     the actual reply text
 *
 * Tracking shape: per-turn counters keyed by `verb` (the action class
 * derived from tool name). One counter per verb so the summary line
 * collapses neatly regardless of which specific Read/Bash/WebSearch
 * the model chose. `register()` increments the counter; `formatSummary()`
 * renders the current state.
 */

const READ_VERBS = new Set(["read"]);
const WRITE_VERBS = new Set(["wrote", "created", "edited"]);

export type ActivityVerb =
  | "read"
  | "edited"
  | "created"
  | "ran"
  | "searched"
  | "fetched"
  | "dispatched"
  | "noted"
  | "saved" // memory-retain class (hindsight, etc.) — distinct from "noted" (TodoWrite)
  | "used"; // generic fallback

/** Object form so `register()` can mutate; pure functions inside the
 *  module work against this shape (easier to unit-test than a Map). */
export interface ActivityState {
  counts: Partial<Record<ActivityVerb, number>>;
  /** Order verbs were first observed this turn. The summary renders in
   *  this order so the line reads as a chronological natural-language
   *  account: "edited a file, read a file, ran a command" matches the
   *  agent's actual sequence of actions. Stable — once a verb is added
   *  to this list, it never moves. */
  order: ActivityVerb[];
  /** First non-trivial tool name observed this turn (for telemetry / future
   *  "what kicked this off" forensic). Not used in the rendered summary. */
  firstToolName: string | null;
}

export function makeEmptyActivityState(): ActivityState {
  return { counts: {}, order: [], firstToolName: null };
}

/** Map a tool name → verb. Mirrors the existing `tool-intent-surface.ts`
 *  verb table but in past tense. Tools that don't map (or surface tools
 *  like reply/stream_reply) return null — the caller skips them. */
export function verbForTool(toolName: string): ActivityVerb | null {
  if (!toolName) return null;
  // Lazy match on the server segment so names containing underscores
  // (e.g. `mcp__claude_ai_Gmail__search`) parse as
  //   server="claude_ai_Gmail", tool="search"
  // instead of the prior `[^_]+` which stopped at the first inner `_`.
  const mcpMatch = /^mcp__(.+?)__(.+)$/.exec(toolName);
  // Skip user-facing Telegram-plugin tools entirely — those ARE the
  // surface, never to be summarised.
  if (mcpMatch && mcpMatch[1] === "switchroom-telegram") return null;

  // MCP allowlist — map common MCP tools to specific verbs so the summary
  // reads as "Searched memory" or "Read 2 files" instead of the generic
  // fallback "Used 2 tools". Tools NOT on this list fall through to the
  // generic "used" verb, which is still better than nothing for one-offs
  // but hurts on heavy MCP turns. Mirrors the label table in
  // `telegram-plugin/hooks/tool-label-pretool.mjs` — keep them in sync.
  if (mcpMatch) {
    // Case-insensitive match — claude.ai prefixes use mixed-case
    // server names ("claude_ai_Gmail", "claude_ai_Google_Drive") so we
    // lowercase both sides before comparing.
    const server = mcpMatch[1].toLowerCase();
    const mcpTool = mcpMatch[2].toLowerCase();
    if (server === "hindsight") {
      if (mcpTool === "recall" || mcpTool === "reflect") return "searched";
      if (mcpTool === "retain" || mcpTool === "update_memory" || mcpTool === "sync_retain") return "saved";
    }
    if (server === "google-workspace" || server === "claude_ai_google_drive" || server === "claude_ai_gmail" || server === "claude_ai_google_calendar") {
      if (/^(search|list|query|read|get|fetch|download)/i.test(mcpTool)) return "searched";
      if (/^(create|update|write|send|move|copy|duplicate)/i.test(mcpTool)) return "edited";
    }
    if (server === "notion" || server === "claude_ai_notion") {
      // claude.ai Notion exposes tools as `notion-search`, `notion-update-page`,
      // etc. Strip the redundant `notion-` prefix before matching the verb.
      const action = mcpTool.replace(/^notion-/, "");
      if (/^(search|fetch|query|get|read)/i.test(action)) return "searched";
      if (/^(create|update|move|duplicate|comment)/i.test(action)) return "edited";
    }
  }

  const suffix = (mcpMatch ? mcpMatch[2] : toolName).toLowerCase();
  switch (suffix) {
    case "read":
      return "read";
    case "write":
      return "created";
    case "edit":
    case "multiedit":
    case "notebookedit":
      return "edited";
    case "bash":
    case "bashoutput":
    case "killshell":
      return "ran";
    case "websearch":
    case "grep":
    case "glob":
      return "searched";
    case "webfetch":
      return "fetched";
    case "task":
    case "agent":
      return "dispatched";
    case "todowrite":
    case "todoread":
      return "noted";
    default:
      return "used";
  }
}

/** Mutates `state` to record one tool_use of `toolName`. Returns true
 *  iff the activity state changed (so the caller knows to refresh the
 *  rendered summary). */
export function register(state: ActivityState, toolName: string): boolean {
  const verb = verbForTool(toolName);
  if (!verb) return false;
  if (state.firstToolName == null) state.firstToolName = toolName;
  const prior = state.counts[verb] ?? 0;
  if (prior === 0) state.order.push(verb);
  state.counts[verb] = prior + 1;
  return true;
}

interface VerbPhrase {
  singular: string;
  plural: string;
}

const VERB_PHRASE: Record<ActivityVerb, VerbPhrase> = {
  read: { singular: "read a file", plural: "read $N files" },
  edited: { singular: "edited a file", plural: "edited $N files" },
  created: { singular: "created a file", plural: "created $N files" },
  ran: { singular: "ran a command", plural: "ran $N commands" },
  searched: { singular: "ran a search", plural: "ran $N searches" },
  fetched: { singular: "fetched a URL", plural: "fetched $N URLs" },
  dispatched: { singular: "dispatched a sub-agent", plural: "dispatched $N sub-agents" },
  noted: { singular: "updated the todo list", plural: "updated the todo list ($N edits)" },
  saved: { singular: "saved a memory", plural: "saved $N memories" },
  used: { singular: "used a tool", plural: "used $N tools" },
};

/** Render the activity state as a single natural-language line.
 *  Verbs are rendered in `state.order` — first-occurrence order — so
 *  the line reads chronologically ("edited a file, read a file, ran
 *  a command" mirrors the agent's actual action sequence). Returns
 *  null when the state is empty (nothing to show yet). */
export function formatSummary(state: ActivityState): string | null {
  const phrases: string[] = [];
  for (const verb of state.order) {
    const n = state.counts[verb] ?? 0;
    if (n <= 0) continue;
    const p = VERB_PHRASE[verb];
    phrases.push(n === 1 ? p.singular : p.plural.replace("$N", String(n)));
  }
  if (phrases.length === 0) return null;
  // Capitalize first letter so the sentence reads as a statement.
  const sentence = phrases.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Convenience: ergonomic full pipeline for callers that just want
 *  "given the new tool name and prior state, give me the updated rendered
 *  text or null if nothing changed". Returns null when the tool is a
 *  surface tool / no-op (so the caller can skip the Telegram edit). */
export function registerAndRender(
  state: ActivityState,
  toolName: string,
): string | null {
  const changed = register(state, toolName);
  if (!changed) return null;
  return formatSummary(state);
}

// ─── Friendly per-tool rendering (draft-mirror, RFC draft-mirror-preview) ───
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
    if (server === "switchroom-telegram") return null;
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
// Phase 1 showed only the latest action; this accumulates the turn's actions
// into a running feed — like Claude Code's own UI — streamed into the
// ephemeral draft and cleared on reply. Chronological (oldest first, newest
// last), consecutive exact-duplicates collapsed, capped to the most recent
// MIRROR_MAX_LINES with a "+N earlier" header so a heavy turn stays readable
// inside Telegram's compose-area draft.

export const MIRROR_MAX_LINES = 6;

/**
 * Append a tool_use's friendly line to the running feed (mutates `lines`)
 * and return the rendered draft body — or null when the tool is a surface
 * tool / produced no line (caller skips the draft update).
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
 * Render the accumulated feed as a plain-text block (one action per line).
 * The caller HTML-escapes + wraps it for Telegram. Returns null when empty.
 *
 * Newest-last chronological order; capped to the last MIRROR_MAX_LINES with a
 * dim "+N earlier" header when the turn ran longer.
 */
export function renderActivityFeed(lines: string[]): string | null {
  if (lines.length === 0) return null;
  const shown = lines.slice(-MIRROR_MAX_LINES);
  const hidden = lines.length - shown.length;
  const body = shown.map((l) => `· ${l}`).join("\n");
  return hidden > 0 ? `· +${hidden} earlier…\n${body}` : body;
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
