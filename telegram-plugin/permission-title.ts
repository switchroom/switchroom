/**
 * Human-readable text for the Telegram permission approval card.
 *
 * The operator is (often) non-technical. A card must read as a plain
 * sentence — "Gymbro wants to edit: supplement-log.md" — never a raw
 * tool identifier (`mcp__perplexity__search`, `Edit:`). Two surfaces:
 *
 *   `formatPermissionCardBody` — the card itself: a one-line natural
 *   title plus the agent's stated reason. No tool ids, no scope chrome
 *   (scope only appears once the operator taps "🔁 Always…").
 *
 *   `describeGrant` — the confirmation after a grant lands: "Gymbro can
 *   now edit any file without asking" — phrased from the *scope the
 *   operator chose*, so the breadth of an always-allow is legible after
 *   the fact, not just before.
 *
 * See #186 (title), #1790 (reason line), and the scoped-card work.
 */

import { basename } from "node:path";
import { prettyMcpServer, type ScopeOption } from "./permission-rule.js";
import { redact } from "./secret-detect/redact.js";

const COMMAND_TITLE_MAX = 48;
const DESCRIPTION_LINE_MAX = 240;

/** HTTP methods the generic REST-wrapper MCP tools (brevo/meta/postiz/… via
 *  rest-server.mjs) expose as verbs — uppercased on the card so the operator
 *  reads "POST /smtp/email" as an API write, not "post". */
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head"]);
/** Keys that, on a REST-style MCP input, name the resource/endpoint. */
const RESOURCE_KEYS = ["path", "endpoint", "url", "resource", "route"];
const ARG_SUMMARY_MAX_KEYS = 4; // how many payload keys to surface on the card
const ARG_VALUE_MAX = 40; // per-value truncation in the arg-summary line
const ARG_SUMMARY_LINE_MAX = 180; // total cap for the arg-summary line

/**
 * Human verb-phrases for switchroom-managed MCP tools. The raw
 * `mcp__<server>__<tool>` name is operator-hostile. Phrases are written
 * to slot in after "wants to" / "can now" — e.g. "read its own merged
 * config". Internal-server tools (agent-config / hostd / hindsight /
 * telegram) read fine alone; external integrations get a "(Server)" tag
 * appended so the operator knows which third party is involved.
 */
const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  // agent-config — every agent's self-service surface (#1163, #1215)
  "mcp__agent-config__config_get": "Read its own merged config",
  "mcp__agent-config__cron_list": "List its own scheduled tasks",
  "mcp__agent-config__skill_list": "List its own installed skills",
  "mcp__agent-config__audit_tail": "Read its own recent tool-call audit log",
  "mcp__agent-config__peers_list": "List the other agents on this instance",
  "mcp__agent-config__schedule_add": "Add a scheduled task to its own cron",
  "mcp__agent-config__schedule_remove": "Remove one of its own scheduled tasks",
  "mcp__agent-config__skill_install": "Install a bundled skill onto itself",
  "mcp__agent-config__skill_remove": "Remove one of its own installed skills",
  // hostd — admin-flagged agents' fleet-management surface (#1175, #1215)
  "mcp__hostd__agent_restart": "Restart an agent in the fleet",
  "mcp__hostd__agent_start": "Start a stopped agent in the fleet",
  "mcp__hostd__agent_stop": "Stop a running agent in the fleet",
  "mcp__hostd__agent_logs": "Read another agent's container logs",
  "mcp__hostd__agent_exec": "Run a read-only inspection inside another agent",
  "mcp__hostd__update_check": "Check what a fleet-wide update would do",
  "mcp__hostd__update_apply": "Apply a fleet-wide update (pull + recreate)",
  // hindsight — memory
  "mcp__hindsight__recall": "Recall relevant memories",
  "mcp__hindsight__retain": "Retain a memory",
  "mcp__hindsight__reflect": "Reflect across its memory bank",
  // external integrations — common verbs (get a "(Server)" tag)
  "mcp__perplexity__search": "Search the web",
  "mcp__perplexity__ask": "Ask the web",
};

const INTERNAL_MCP_SERVERS = new Set([
  "agent-config",
  "hostd",
  "hindsight",
  "switchroom-telegram",
]);

/**
 * Build the multi-line card body for an approval prompt.
 *
 *   🔐 <b>Gymbro</b> wants to edit: supplement-log.md
 *   why: <i>logging today's lifts</i>
 *
 * Output is HTML-escaped for `parse_mode: 'HTML'`. The agent name is
 * capitalized for the sentence; dropped (with "wants to") when null —
 * the bridge client can be anonymous during early-boot edge cases.
 */
export function formatPermissionCardBody(opts: {
  toolName: string;
  inputPreview: string | undefined;
  description: string | undefined;
  agentName: string | null;
}): string {
  const action = naturalAction(opts.toolName, opts.inputPreview);
  const lines: string[] = [];

  if (opts.agentName && opts.agentName.length > 0) {
    lines.push(
      `🔐 <b>${escapeTgHtml(capFirst(opts.agentName))}</b> wants to ${escapeTgHtml(action)}`,
    );
  } else {
    lines.push(`🔐 ${escapeTgHtml(capFirst(action))}`);
  }

  const rawWhy = (opts.description ?? "").replace(/\s+/g, " ").trim();
  const truncatedWhy =
    rawWhy.length > DESCRIPTION_LINE_MAX
      ? rawWhy.slice(0, DESCRIPTION_LINE_MAX - 1) + "…"
      : rawWhy;
  lines.push(
    truncatedWhy.length > 0
      ? `why: <i>${escapeTgHtml(truncatedWhy)}</i>`
      : `why: <i>not provided</i>`,
  );

  // Third line (REST-wrapper MCP writes only): a redaction-safe summary of
  // the payload so the operator can see WHAT is being sent, not just the
  // endpoint — e.g. "↳ to: lisa@…, subject: Priority access…".
  const argSummary = mcpArgSummary(opts.toolName, opts.inputPreview);
  if (argSummary) {
    lines.push(`↳ <i>${escapeTgHtml(argSummary)}</i>`);
  }

  return lines.join("\n");
}

/**
 * The natural-language action for a tool call — the part that reads
 * after "wants to". No tool identifiers, no scope.
 */
export function naturalAction(
  toolName: string,
  inputPreview: string | undefined,
): string {
  const input = parseInput(inputPreview);

  if (toolName.startsWith("mcp__")) return naturalMcpAction(toolName, input);

  switch (toolName) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const f = fileBase(input);
      return f ? `edit: ${f}` : "edit files";
    }
    case "Write": {
      const f = fileBase(input);
      return f ? `write: ${f}` : "write files";
    }
    case "Read": {
      const f = fileBase(input);
      return f ? `read: ${f}` : "read files";
    }
    case "Bash": {
      const c = input ? readString(input, "command") : null;
      return c ? `run: ${truncate(c, COMMAND_TITLE_MAX)}` : "run shell commands";
    }
    case "Skill": {
      const s = input ? resolveSkillName(input) : null;
      return s ? `use the ${s} skill` : "use a skill";
    }
    case "Glob":
    case "Grep": {
      const p = input ? readString(input, "pattern") : null;
      return p ? `search files for: ${truncate(p, COMMAND_TITLE_MAX)}` : "search files";
    }
    case "WebSearch": {
      const q = input ? readString(input, "query") : null;
      return q ? `search the web for: ${truncate(q, COMMAND_TITLE_MAX)}` : "search the web";
    }
    case "WebFetch": {
      const u = input ? readString(input, "url") : null;
      return u ? `fetch a web page: ${truncate(u, COMMAND_TITLE_MAX)}` : "fetch a web page";
    }
    case "Task":
    case "Agent":
      return "dispatch a sub-agent";
    case "TodoWrite":
      return "update its task list";
    case "ExitPlanMode":
      return "exit plan mode";
    default:
      return `use ${toolName}`;
  }
}

function naturalMcpAction(
  toolName: string,
  input: Record<string, unknown> | null,
): string {
  const parts = toolName.split("__");
  const server = parts.length >= 2 ? parts[1]! : "";
  const curated = MCP_TOOL_DESCRIPTIONS[toolName];
  if (curated) {
    const phrase = lowerFirst(curated);
    return INTERNAL_MCP_SERVERS.has(server)
      ? phrase
      : `${phrase} (${prettyMcpServer(server)})`;
  }
  if (parts.length >= 3) {
    const verb = parts.slice(2).join("__").replace(/_/g, " ");
    // External REST-wrapper tools (brevo/meta/postiz/…) take a `path`. Name
    // the endpoint so "post (Brevo)" becomes "POST /smtp/email (Brevo)" —
    // the operator can see WHICH resource is being written, not just that
    // *something* is. Internal servers + tools without a resource key keep
    // the plain verb phrasing.
    if (!INTERNAL_MCP_SERVERS.has(server)) {
      const resourcePhrase = restResourcePhrase(server, verb, input);
      if (resourcePhrase) return resourcePhrase;
    }
    return INTERNAL_MCP_SERVERS.has(server)
      ? verb
      : `${verb} (${prettyMcpServer(server)})`;
  }
  return `use ${toolName}`;
}

/**
 * For a REST-wrapper MCP call ({ path, body?, query? }), build the action
 * phrase "<VERB> <path> (<Server>)" — e.g. "POST /smtp/email (Brevo)". The
 * path is redaction-passed + length-capped before display. Returns null
 * when the input carries no recognizable resource key (caller falls back to
 * the plain verb phrasing).
 */
function restResourcePhrase(
  server: string,
  verb: string,
  input: Record<string, unknown> | null,
): string | null {
  if (!input) return null;
  let path: string | null = null;
  for (const key of RESOURCE_KEYS) {
    path = readString(input, key);
    if (path) break;
  }
  if (!path) return null;
  const v = HTTP_VERBS.has(verb.toLowerCase()) ? verb.toUpperCase() : verb;
  const shownPath = truncate(redact(path), COMMAND_TITLE_MAX);
  return `${v} ${shownPath} (${prettyMcpServer(server)})`;
}

/**
 * A compact, redaction-safe one-line summary of a REST-wrapper MCP call's
 * payload ({ body } for writes, { query } for reads) — the third card line.
 * Shows up to {@link ARG_SUMMARY_MAX_KEYS} payload keys with short, masked
 * scalar values ("to: lisa@…, subject: Priority access…"); nested
 * objects/arrays surface as the bare key name (no value dump — avoids
 * leaking PII/secrets and oversized blobs). Every value passes through
 * `redact()` so an API key in the payload is masked, never surfaced.
 * Returns null when there's nothing meaningful to show.
 */
function mcpArgSummary(
  toolName: string,
  inputPreview: string | undefined,
): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  // Internal servers (agent-config / hostd / hindsight / telegram) use flat
  // input schemas, not the REST `body`/`query` convention — and we don't
  // endpoint-enrich their title line either, so keep the summary line off
  // them too (redact() still runs, so this is intent-match, not a leak fix).
  const server = toolName.split("__")[1] ?? "";
  if (INTERNAL_MCP_SERVERS.has(server)) return null;
  const input = parseInput(inputPreview);
  if (!input) return null;
  const payload = input.body ?? input.query;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (parts.length >= ARG_SUMMARY_MAX_KEYS) {
      parts.push("…");
      break;
    }
    if (value == null) continue;
    if (typeof value === "object") {
      parts.push(key); // nested object/array → key name only, never dumped
      continue;
    }
    const shown = truncate(redact(String(value)), ARG_VALUE_MAX);
    parts.push(`${key}: ${shown}`);
  }
  if (parts.length === 0) return null;
  const joined = parts.join(", ");
  return joined.length > ARG_SUMMARY_LINE_MAX
    ? joined.slice(0, ARG_SUMMARY_LINE_MAX - 1) + "…"
    : joined;
}

/**
 * Confirmation phrase describing a grant that just landed, derived from
 * the *scope option the operator chose* — so an always-allow's breadth
 * is legible after the fact. Slots in after "<Agent> can now …":
 *
 *   "edit any file" / "edit supplement-log.md" / "run npm commands" /
 *   "use the mail skill" / "use any Perplexity tool"
 */
export function describeGrant(
  toolName: string,
  inputPreview: string | undefined,
  option: ScopeOption,
): string {
  const rule = option.rule;

  // MCP wildcard → "use any <Server> tool".
  if (rule.endsWith("__*") && rule.startsWith("mcp__")) {
    const server = rule.split("__")[1] ?? "";
    return `use any ${prettyMcpServer(server)} tool`;
  }

  const scoped = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
  if (scoped) {
    const t = scoped[1]!;
    const arg = scoped[2]!;
    if (t === "Skill") return `use the ${arg} skill`;
    if (t === "Bash") {
      const m = /^([^:]+):\*$/.exec(arg);
      return m ? `run ${m[1]} commands` : "run that command";
    }
    if (t === "Edit" || t === "MultiEdit" || t === "NotebookEdit")
      return `edit ${basename(arg)}`;
    if (t === "Write") return `write ${basename(arg)}`;
    if (t === "Read") return `read ${basename(arg)}`;
    return naturalAction(toolName, inputPreview);
  }

  // Bare tool name — the broad, whole-category grants.
  switch (rule) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit any file";
    case "Write":
      return "write any file";
    case "Read":
      return "read any file";
    case "Bash":
      return "run any command";
    case "Skill":
      return "use any skill";
    default:
      // Exact MCP tool or a broad-only built-in — fall back to the
      // request's natural action.
      return naturalAction(toolName, inputPreview);
  }
}

/**
 * Agent-voiced "I got your verdict and I'm continuing" message, posted as
 * a *distinct* Telegram message the instant the operator answers a
 * permission card (allow / deny / always / slash / free-text). The card
 * edit + status reaction are easy to miss — a reaction lands on the turn's
 * triggering message far up the chat, and the card footnote is a one-liner
 * the operator scrolls past — so this is the legible signal that the tap
 * landed and names the work being (re)started.
 *
 * Mirrors `formatPermissionCardBody`'s style ("🔐 <b>Gymbro</b> wants to
 * edit: log.md" → "▶️ <b>Gymbro</b> — got it, continuing: edit: log.md").
 * `action` is a phrase from {@link naturalAction} (already operator-facing,
 * no tool ids). Output is HTML-escaped for `parse_mode: 'HTML'`.
 *
 * `timeoutMinutes` marks the TTL auto-deny variant (no operator tapped —
 * the request aged out) so the wording reflects "no answer" rather than a
 * deliberate denial.
 */
export function formatPermissionResumeMessage(opts: {
  agentName: string | null;
  behavior: "allow" | "deny";
  action: string;
  timeoutMinutes?: number;
}): string {
  const who =
    opts.agentName && opts.agentName.length > 0
      ? `<b>${escapeTgHtml(capFirst(opts.agentName))}</b>`
      : `<b>Agent</b>`;
  const act = (opts.action ?? "").trim();
  const hasAction = act.length > 0;

  if (opts.behavior === "allow") {
    return hasAction
      ? `▶️ ${who} — got it, continuing: <i>${escapeTgHtml(act)}</i>`
      : `▶️ ${who} — got it, back to work.`;
  }

  // deny
  if (opts.timeoutMinutes != null) {
    return hasAction
      ? `🚫 ${who} — no answer in ${opts.timeoutMinutes}m, continuing without it (<i>${escapeTgHtml(act)}</i>).`
      : `🚫 ${who} — no answer in ${opts.timeoutMinutes}m, continuing without it.`;
  }
  return hasAction
    ? `🚫 ${who} — noted, I won't ${escapeTgHtml(lowerFirst(act))}. Continuing without it.`
    : `🚫 ${who} — noted, continuing without it.`;
}

function resolveSkillName(input: Record<string, unknown>): string | null {
  return (
    readString(input, "skill") ??
    readString(input, "skill_name") ??
    readString(input, "skillName") ??
    readString(input, "name") ??
    skillBasenameFromPath(input)
  );
}

function fileBase(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const p = readString(input, "file_path") ?? readString(input, "notebook_path");
  return p ? basename(p) : null;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function capFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Minimal HTML escape for Telegram `parse_mode=HTML`. */
function escapeTgHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseInput(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function skillBasenameFromPath(input: Record<string, unknown>): string | null {
  const path = readString(input, "path") ?? readString(input, "skill_path");
  if (!path) return null;
  const trimmed = path.replace(/\/SKILL\.md$/i, "").replace(/\/$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const base = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return base.length > 0 ? base : null;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}
