/**
 * Build a human-readable title for the inline-keyboard permission
 * approval message. Pre-fix the title was always `🔐 Permission:
 * ${toolName}` — for a `Skill` or `Bash` call the user couldn't tell
 * which skill / command was being approved without tapping "See more".
 *
 * The detail surfaces (the expanded view at server.ts/gateway.ts) still
 * render the full description + input_preview block; this helper just
 * lifts the most identifying field into the title so the user can
 * approve at a glance.
 *
 * See #186.
 */

import { basename } from "node:path";

const COMMAND_TITLE_MAX = 40;
const PATH_TITLE_MAX = 40;

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
  // tools and finally to the raw name when even that fails.
  if (toolName.startsWith("mcp__")) {
    const curated = MCP_TOOL_DESCRIPTIONS[toolName];
    if (curated) return curated;
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      const server = parts[1]!;
      const verb = parts.slice(2).join("__").replace(/_/g, " ");
      return `${server}: ${verb}`;
    }
    return toolName;
  }

  const input = parseInput(inputPreview);
  if (!input) return toolName;

  switch (toolName) {
    case "Skill": {
      // Claude Code's Skill tool input shape has shifted across versions
      // and skill flavours. Read defensively from every known field
      // before falling back to the bare tool name — the user reported
      // a popup that rendered as `🔐 Permission: Skill` (no brackets)
      // because we'd only checked `skill`. The skill name is the most
      // identifying field of the prompt; never drop it silently.
      const skill =
        readString(input, "skill") ??
        readString(input, "skill_name") ??
        readString(input, "skillName") ??
        readString(input, "name") ??
        skillBasenameFromPath(input);
      return skill ? `${toolName} (${skill})` : toolName;
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
