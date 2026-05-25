/**
 * Build the inline-keyboard permission approval message — title + body.
 *
 * Two related concerns:
 *
 *   `summarizeToolForTitle` (one line, no escaping) is the bare summary
 *   used in the always-allow rule label and as the body-builder's
 *   internal building block. Pre-#186 the title was always `🔐
 *   Permission: ${toolName}` — for a `Skill` or `Bash` call the user
 *   couldn't tell which skill / command was being approved without
 *   tapping "See more".
 *
 *   `formatPermissionCardBody` (multi-line, HTML-escaped for
 *   parse_mode=HTML) is the body of the card itself. Pre-#1790 the
 *   collapsed card was a single line — operators had to tap "See more"
 *   to see the agent's stated reason or input preview. This mirrors
 *   the vault `vault_request_access` card's three-line layout (the
 *   gold standard) so every approval surface answers "what" + "why"
 *   without an expand tap.
 *
 * See #186 (title) and #1790 (body).
 */

import { basename } from "node:path";

const COMMAND_TITLE_MAX = 40;
const PATH_TITLE_MAX = 40;
const DESCRIPTION_LINE_MAX = 240;
const INPUT_VALUE_MAX = 60;

/**
 * Human-friendly descriptions for switchroom-managed MCP tools. The
 * raw `mcp__<server>__<tool>` name is operator-unfriendly — they shouldn't
 * have to decode the namespace to understand what the agent is asking
 * to do. Use this map to turn the code-level identifier into a verb
 * phrase ("Read its own merged config" instead of
 * "mcp__agent-config__config_get") for the approval card.
 *
 * Note: post-#1215 these tools are pre-allowed in scaffolded
 * settings.permissions.allow, so the card should fire rarely.
 * This map is for the fallback path — agents the operator
 * narrowed the allowlist on, or tools added in future PRs that
 * haven't shipped the allowlist bump yet.
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
};

/**
 * Build a title fragment for a permission prompt. Returns the toolName
 * for any tool we don't recognise — the helper is intentionally
 * conservative: better to keep the bare name than render gibberish from
 * a malformed input_preview.
 */
export function summarizeToolForTitle(
  toolName: string,
  inputPreview: string | undefined,
): string {
  // MCP tools: `mcp__<server>__<verb>`. Prefer a curated human
  // description (so the card reads "Read its own merged config"
  // instead of "mcp__agent-config__config_get"). Fall through to a
  // generic `<server>: <verb-with-spaces>` shape for unknown MCP
  // tools and finally to the raw name when even that fails. When
  // we have an input preview, append the first arg-value pair so
  // the operator sees what's being requested without expanding —
  // e.g. `Read its own merged config (key: coolify/api-token)`
  // rather than just `Read its own merged config`. (#1790)
  if (toolName.startsWith("mcp__")) {
    const curated = MCP_TOOL_DESCRIPTIONS[toolName];
    const base = curated
      ? curated
      : (() => {
          const parts = toolName.split("__");
          if (parts.length >= 3) {
            const server = parts[1]!;
            const verb = parts.slice(2).join("__").replace(/_/g, " ");
            return `${server}: ${verb}`;
          }
          return toolName;
        })();
    const argHint = firstScalarArgHint(parseInput(inputPreview));
    return argHint ? `${base} (${argHint})` : base;
  }

  const input = parseInput(inputPreview);
  if (!input) return toolName;

  switch (toolName) {
    case "Skill": {
      // Claude Code's Skill tool input shape has shifted across versions
      // and skill flavours. Read defensively from every known field
      // before falling back. The skill name is the most identifying
      // field of the prompt; never drop it silently.
      //
      // (#1790) Final fallback added: when no skill-name key matches,
      // try `command` (some Skill variants pass the invocation under
      // that key), then the first scalar arg-value pair. Pre-fix the
      // default returned a bare `Skill` with zero context — operators
      // saw "🔐 Permission: Skill" with no way to tell what was being
      // asked without tapping See more.
      const skill =
        readString(input, "skill") ??
        readString(input, "skill_name") ??
        readString(input, "skillName") ??
        readString(input, "name") ??
        skillBasenameFromPath(input);
      if (skill) return `${toolName} (${skill})`;
      const command = readString(input, "command");
      if (command) return `${toolName}: ${truncate(command, COMMAND_TITLE_MAX)}`;
      const argHint = firstScalarArgHint(input);
      return argHint ? `${toolName} (${argHint})` : toolName;
    }
    case "Bash": {
      const command = readString(input, "command");
      return command ? `${toolName}: ${truncate(command, COMMAND_TITLE_MAX)}` : toolName;
    }
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const filePath = readString(input, "file_path") ?? readString(input, "notebook_path");
      return filePath ? `${toolName}: ${truncate(basename(filePath), PATH_TITLE_MAX)}` : toolName;
    }
    case "Glob":
    case "Grep": {
      const pattern = readString(input, "pattern");
      return pattern ? `${toolName}: ${truncate(pattern, COMMAND_TITLE_MAX)}` : toolName;
    }
    case "WebFetch":
    case "WebSearch": {
      const query = readString(input, "url") ?? readString(input, "query");
      return query ? `${toolName}: ${truncate(query, COMMAND_TITLE_MAX)}` : toolName;
    }
    default:
      return toolName;
  }
}

/**
 * Build the multi-line collapsed body of an approval card (#1790).
 *
 * Pre-fix the card was a single line — `🔐 Permission: <title>` —
 * and the agent's stated `description` plus the input preview only
 * surfaced when the operator tapped "See more". For skill / generic
 * tool prompts the title alone (e.g. `Skill (mail)`) is rarely
 * enough to approve at a glance; the operator needs to see *why*
 * before they tap Allow / Deny.
 *
 * Layout mirrors the `vault_request_access` card (the gold standard):
 *
 *   🔐 <agent> · <tool summary>
 *   why: <description-or-"not provided">
 *
 * The agent line is dropped when `agentName` is null (the
 * gateway's bridge client may be anonymous during early-boot edge
 * cases — better to render the title than a misleading blank).
 *
 * Output is HTML-escaped and intended for `parse_mode: 'HTML'`
 * via Telegram's Bot API.
 */
export function formatPermissionCardBody(opts: {
  toolName: string;
  inputPreview: string | undefined;
  description: string | undefined;
  agentName: string | null;
}): string {
  const summary = summarizeToolForTitle(opts.toolName, opts.inputPreview);
  const lines: string[] = [];

  const agentBit = opts.agentName && opts.agentName.length > 0
    ? `<b>${escapeTgHtml(opts.agentName)}</b> · `
    : "";
  lines.push(`🔐 ${agentBit}${escapeTgHtml(summary)}`);

  // The agent's stated reason. Always render the line — when the
  // agent omitted a `description`, render an explicit
  // `why: <i>not provided</i>` rather than skip silently, so the
  // missing-rationale is visible as an agent-side failure (matches
  // the vault card's #1790 treatment of an omitted `reason`).
  const rawWhy = (opts.description ?? "").replace(/\s+/g, " ").trim();
  const truncatedWhy =
    rawWhy.length > DESCRIPTION_LINE_MAX
      ? rawWhy.slice(0, DESCRIPTION_LINE_MAX - 1) + "…"
      : rawWhy;
  if (truncatedWhy.length > 0) {
    lines.push(`why: <i>${escapeTgHtml(truncatedWhy)}</i>`);
  } else {
    lines.push(`why: <i>not provided</i>`);
  }

  return lines.join("\n");
}

/**
 * Minimal HTML escape for Telegram `parse_mode=HTML`. Mirrors
 * `escapeHtmlForTg` in gateway.ts; duplicated here to keep
 * permission-title.ts free of a gateway import (the file is
 * referenced by both server.ts and gateway.ts).
 */
function escapeTgHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Return a `key: value` hint for the first scalar (string / number /
 * boolean) arg in the input preview. Used as a last-ditch context
 * line on uncurated MCP tools and Skill calls whose canonical
 * skill-name fields are all missing.
 *
 * Skips obviously-routing keys (`chat_id`, `message_thread_id`,
 * `request_id`) that aren't useful to a human operator deciding
 * whether to approve. Returns `null` when nothing scalar remains.
 */
function firstScalarArgHint(
  input: Record<string, unknown> | null,
): string | null {
  if (!input) return null;
  const SKIP = new Set([
    "chat_id",
    "chatId",
    "message_thread_id",
    "messageThreadId",
    "request_id",
    "requestId",
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (SKIP.has(key)) continue;
    if (typeof value === "string" && value.length > 0) {
      return `${key}: ${truncate(value, INPUT_VALUE_MAX)}`;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return `${key}: ${String(value)}`;
    }
  }
  return null;
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
 * Some Skill tool variants pass the skill as a directory path (e.g.
 * `skills/mail/SKILL.md` or `~/.switchroom/skills/mail`). Lift the
 * skill name out of the path so the popup still says `Skill (mail)`
 * instead of dumping the full path or bare `Skill`.
 */
function skillBasenameFromPath(input: Record<string, unknown>): string | null {
  const path = readString(input, "path") ?? readString(input, "skill_path");
  if (!path) return null;
  // Strip a trailing /SKILL.md or filename so we land on the directory
  // basename — that's the canonical skill name in switchroom's layout.
  const trimmed = path.replace(/\/SKILL\.md$/i, "").replace(/\/$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return basename.length > 0 ? basename : null;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}
