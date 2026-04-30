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
 * Build a title fragment for a permission prompt. Returns the toolName
 * for any tool we don't recognise — the helper is intentionally
 * conservative: better to keep the bare name than render gibberish from
 * a malformed input_preview.
 */
export function summarizeToolForTitle(
  toolName: string,
  inputPreview: string | undefined,
): string {
  const input = parseInput(inputPreview);
  if (!input) return toolName;

  switch (toolName) {
    case "Skill": {
      const skill = readString(input, "skill");
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

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}
