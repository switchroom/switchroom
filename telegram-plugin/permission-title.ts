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
import { escapeMarkdown } from "./card-format.js";
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
  "mcp__agent-config__cron_doctor": "Health-check its own cron schedule",
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
  "mcp__hostd__rollout": "Roll the fleet to a pinned version",
  "mcp__hostd__config_propose_edit": "Propose an edit to switchroom.yaml",
  "mcp__hostd__get_status": "Read the last fleet-update status",
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
 * hostd fleet verbs that take a target agent `name` as a required arg. The
 * approval card MUST name WHICH agent is targeted (#2469) — "restart an
 * agent" with no name leaves the operator blind. We interpolate the target
 * into the curated phrase: "restart an agent in the fleet" → "restart agent
 * `carrie` in the fleet". Stays generic when `name` is absent (never crash).
 */
const HOSTD_AGENT_TARGET_VERBS = new Set([
  "mcp__hostd__agent_restart",
  "mcp__hostd__agent_start",
  "mcp__hostd__agent_stop",
  "mcp__hostd__agent_logs",
  "mcp__hostd__agent_exec",
]);

/**
 * Build the multi-line card body for an approval prompt.
 *
 *   🔐 **Gymbro** wants to edit: supplement-log.md
 *   why: _logging today's lifts_
 *
 * Output is GFM markdown for the rich-message path (#2669). The agent name is
 * capitalized for the sentence; dropped (with "wants to") when null —
 * the bridge client can be anonymous during early-boot edge cases.
 *
 * The `why:` line is the CALLER's stated rationale — the `reason`/`why`
 * argument on the tool input, NOT the tool's static JSONSchema
 * `description`. The schema description is documentation (it can contain
 * literal tokens like `$SWITCHROOM_AGENT_NAME`), so surfacing it as the
 * "why" reads like an un-interpolated variable and discards the agent's
 * actual reason (#2469). We only fall back to "not provided" — never to
 * the schema description.
 */
export function formatPermissionCardBody(opts: {
  toolName: string;
  inputPreview: string | undefined;
  /**
   * The tool's static JSONSchema description. Retained for the signature
   * (callers still pass it) but deliberately NOT used as the `why:` line —
   * see #2469. The caller's rationale comes from the input args instead.
   */
  description: string | undefined;
  agentName: string | null;
}): string {
  const action = naturalAction(opts.toolName, opts.inputPreview);
  const lines: string[] = [];

  if (opts.agentName && opts.agentName.length > 0) {
    lines.push(
      `🔐 **${escapeTgHtml(capFirst(opts.agentName))}** wants to ${escapeActionMarkdown(action)}`,
    );
  } else {
    lines.push(`🔐 ${escapeActionMarkdown(capFirst(action))}`);
  }

  // why: the caller-supplied rationale (`reason`/`why` arg), never the
  // static schema description (#2469).
  const callerReason = callerSuppliedReason(opts.inputPreview);
  const rawWhy = (callerReason ?? "").replace(/\s+/g, " ").trim();
  const truncatedWhy =
    rawWhy.length > DESCRIPTION_LINE_MAX
      ? rawWhy.slice(0, DESCRIPTION_LINE_MAX - 1) + "…"
      : rawWhy;
  lines.push(
    truncatedWhy.length > 0
      ? `why: _${escapeTgHtml(truncatedWhy)}_`
      : `why: _not provided_`,
  );

  // Third line (REST-wrapper MCP writes only): a redaction-safe summary of
  // the payload so the operator can see WHAT is being sent, not just the
  // endpoint — e.g. "↳ to: lisa@…, subject: Priority access…".
  const argSummary = mcpArgSummary(opts.toolName, opts.inputPreview);
  if (argSummary) {
    lines.push(`↳ _${escapeTgHtml(argSummary)}_`);
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
      const f = fileBase(input, inputPreview);
      return f ? `edit: ${f}` : "edit files";
    }
    case "Write": {
      const f = fileBase(input, inputPreview);
      return f ? `write: ${f}` : "write files";
    }
    case "Read": {
      const f = fileBase(input, inputPreview);
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
    // hostd config-edit verb (#2605) — not mcp__-prefixed (it's a direct
    // wire call from the agent-config MCP server), so it falls through to
    // the switch rather than naturalMcpAction. Give it a readable title.
    case "config_propose_edit":
      return "edit switchroom config";
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
    const phrase = hostdAgentPhrase(toolName, input) ?? lowerFirst(curated);
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
 * For the hostd `agent_*` fleet verbs, build an action phrase that NAMES the
 * target agent (#2469) — "restart agent `carrie` in the fleet". The verb is
 * derived from the tool name (`agent_restart` → "restart"); `agent_logs` /
 * `agent_exec` get bespoke phrasing. Returns null when the tool isn't a
 * name-targeted hostd verb or no `name` arg is present, so the caller falls
 * back to the generic curated phrase (never crashes on a missing name).
 */
function hostdAgentPhrase(
  toolName: string,
  input: Record<string, unknown> | null,
): string | null {
  if (!HOSTD_AGENT_TARGET_VERBS.has(toolName)) return null;
  const name = input ? readString(input, "name") : null;
  if (!name) return null;
  switch (toolName) {
    case "mcp__hostd__agent_restart":
      return `restart agent \`${name}\` in the fleet`;
    case "mcp__hostd__agent_start":
      return `start agent \`${name}\` in the fleet`;
    case "mcp__hostd__agent_stop":
      return `stop agent \`${name}\` in the fleet`;
    case "mcp__hostd__agent_logs":
      return `read agent \`${name}\`'s container logs`;
    case "mcp__hostd__agent_exec":
      return `run a read-only inspection inside agent \`${name}\``;
    default:
      return null;
  }
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
 * Mirrors `formatPermissionCardBody`'s style ("🔐 **Gymbro** wants to
 * edit: log.md" → "▶️ **Gymbro** — got it, continuing: edit: log.md").
 * `action` is a phrase from {@link naturalAction} (already operator-facing,
 * no tool ids). Output is GFM markdown for the rich-message path (#2669).
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
      ? `**${escapeTgHtml(capFirst(opts.agentName))}**`
      : `**Agent**`;
  const act = (opts.action ?? "").trim();
  const hasAction = act.length > 0;

  if (opts.behavior === "allow") {
    return hasAction
      ? `▶️ ${who} — got it, continuing: _${escapeActionMarkdown(act)}_`
      : `▶️ ${who} — got it, back to work.`;
  }

  // deny
  if (opts.timeoutMinutes != null) {
    return hasAction
      ? `🚫 ${who} — no answer in ${opts.timeoutMinutes}m, continuing without it (_${escapeActionMarkdown(act)}_).`
      : `🚫 ${who} — no answer in ${opts.timeoutMinutes}m, continuing without it.`;
  }
  return hasAction
    ? `🚫 ${who} — noted, I won't ${escapeActionMarkdown(lowerFirst(act))}. Continuing without it.`
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

function fileBase(
  input: Record<string, unknown> | null,
  rawPreview?: string,
): string | null {
  if (input) {
    const p = readString(input, "file_path") ?? readString(input, "notebook_path");
    if (p) return basename(p);
  }
  // Claude Code truncates inputPreview to 200 chars, making the surrounding
  // JSON invalid (Edit/Write always exceed 200 chars once old_string/new_string
  // are included). "file_path" is the first key, so its value is intact in the
  // truncated prefix — extract it with a lenient regex on the raw string.
  if (rawPreview) {
    const p = extractFilePathFromRaw(rawPreview);
    if (p) return basename(p);
  }
  return null;
}

/**
 * Regex-based fallback to extract "file_path" or "notebook_path" from a raw
 * (possibly truncated / invalid-JSON) inputPreview string. JSON-unescapes the
 * captured value so paths with backslashes or unicode escapes are returned
 * correctly. Returns null when neither key is present or the captured value is
 * empty.
 */
function extractFilePathFromRaw(raw: string): string | null {
  // Match the first occurrence of "file_path" or "notebook_path".
  const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return null;
  try {
    // JSON.parse the quoted string literal so escape sequences are resolved.
    const value = JSON.parse(`"${m[1]}"`) as string;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function capFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Markdown escape for the rich-message path (#2669). */
function escapeTgHtml(text: string): string {
  return escapeMarkdown(text);
}

/**
 * Escape a phrase that may itself contain DELIBERATE `` `code spans` ``
 * (e.g. the hostd fleet-verb phrases name the target agent in a code span:
 * "restart agent `carrie` in the fleet"). The structural backticks must NOT
 * be escaped — that would render literal `` \`carrie\` `` to the operator
 * (#2669 regression). Everything OUTSIDE a backtick span is still escaped so
 * a hostile Bash command / filename can't inject emphasis. Content INSIDE a
 * span is left verbatim — code spans render literally, so there is no
 * injection risk there.
 */
function escapeActionMarkdown(text: string): string {
  // Split on balanced single-backtick spans, keeping the delimiters.
  return text
    .split(/(`[^`]*`)/g)
    .map((seg) => (seg.startsWith("`") && seg.endsWith("`") && seg.length >= 2 ? seg : escapeMarkdown(seg)))
    .join("");
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

/**
 * The caller's stated rationale for a tool call — the `reason` (or `why`)
 * argument it passed. This is the agent's actual justification, which is
 * what belongs on the `why:` line of the approval card. Returns null when
 * no reason was supplied (caller renders "not provided") — we never fall
 * back to the tool's static schema description (#2469).
 */
function callerSuppliedReason(inputPreview: string | undefined): string | null {
  const input = parseInput(inputPreview);
  if (input) {
    const fromJson = readString(input, "reason") ?? readString(input, "why");
    if (fromJson) return fromJson;
  }
  // Truncation fallback (#2580 follow-up): upstream Claude Code truncates
  // `inputPreview` to ~200 chars. For a tool whose first/largest key is a
  // big blob (e.g. config_propose_edit's `unified_diff`), the truncated JSON
  // is unparseable and the schema-required `reason` is lost — the card then
  // renders "why: not provided" even though a reason WAS supplied. Mirror the
  // `extractFilePathFromRaw` lenient-regex fallback so a `reason`/`why` value
  // surviving in the truncated prefix is still recovered. (Reordering the
  // schema so `reason` precedes the blob keeps it inside the 200-char prefix;
  // this regex is what then reads it back out.)
  if (inputPreview) {
    const r = extractReasonFromRaw(inputPreview);
    if (r) return r;
  }
  return null;
}

/**
 * Regex-based fallback to extract a `reason` or `why` value from a raw
 * (possibly truncated / invalid-JSON) inputPreview string. Mirrors
 * `extractFilePathFromRaw`: JSON-unescapes the captured value so a reason
 * with quotes/backslashes/unicode escapes is returned correctly. Returns
 * null when neither key is present or the captured value is empty/whitespace.
 */
export function extractReasonFromRaw(raw: string): string | null {
  // Match the first occurrence of "reason" or "why".
  const m = /"(?:reason|why)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return null;
  try {
    const value = JSON.parse(`"${m[1]}"`) as string;
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
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
