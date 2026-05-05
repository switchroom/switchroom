/**
 * Resolve a Claude Code permission allow-rule from a permission_request
 * payload — the value we'd add to `tools.allow` in switchroom.yaml so
 * future invocations of the same operation never pop another approval
 * dialog.
 *
 * Used by the Telegram permission popup's "🔁 Always allow" button
 * (issue follow-up to #186). Per-skill granularity for `Skill` so
 * tapping "Always" on a `Skill (mail)` prompt only whitelists `mail`,
 * not all skills. Other tools fall back to the bare tool name —
 * promoting `Bash` from per-call confirm to always-allow is a more
 * meaningful blast-radius decision and shouldn't be hidden behind a
 * one-tap button on an arbitrary command, but the bare-name behaviour
 * is consistent with how the existing `tools.allow: [Bash]` works.
 *
 * Returns:
 *   - `{ rule, label }` when we can compute a rule for the agent's yaml
 *   - `null` when the tool is something we don't know how to allow at
 *     a meaningful granularity (caller should disable the Always button
 *     to avoid writing a useless or dangerously-broad rule)
 *
 * The `label` is what we surface to the operator in the confirmation
 * — "🔁 Always allow Skill(mail) for clerk". The rule is what lands in
 * yaml: matches Claude Code's settings.json permission-rule grammar
 * (`Tool` or `Tool(arg)` for granular).
 */

import { basename } from "node:path";

export interface AlwaysAllowRule {
  /** The exact string to add to `tools.allow` in switchroom.yaml. */
  readonly rule: string;
  /** Human-readable label for the confirmation message. */
  readonly label: string;
}

/**
 * @param toolName    Claude Code's tool_name from the permission_request
 * @param inputPreview JSON string with the tool's input. May be undefined
 *                     or non-JSON; the function is conservative.
 */
export function resolveAlwaysAllowRule(
  toolName: string,
  inputPreview: string | undefined,
): AlwaysAllowRule | null {
  if (!toolName) return null;
  const input = parseInput(inputPreview);

  switch (toolName) {
    case "Skill": {
      // Per-skill granularity: `Skill(mail)`. Mirror permission-title's
      // defensive field-fallback so the rule resolves whenever the
      // popup managed to render the skill name in brackets.
      if (!input) return null;
      const skill =
        readString(input, "skill") ??
        readString(input, "skill_name") ??
        readString(input, "skillName") ??
        readString(input, "name") ??
        skillBasenameFromPath(input);
      if (!skill) return null;
      // Claude Code's permission-rule grammar quotes the arg with
      // parentheses, no inner quoting needed for typical skill names
      // (alphanumeric + dash/underscore/dot). Refuse rules with
      // characters that could break the parser or expand to unintended
      // matches.
      if (!/^[A-Za-z0-9._\-+]+$/.test(skill)) return null;
      return {
        rule: `Skill(${skill})`,
        label: `Skill(${skill})`,
      };
    }
    case "Bash":
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Glob":
    case "Grep":
    case "WebFetch":
    case "WebSearch":
    case "Task":
    case "Agent":
    case "TodoWrite":
    case "ExitPlanMode": {
      // Bare tool name — same shape as `tools.allow: [Bash]`. We
      // don't pattern-match the args here: that's the operator's job
      // when they want fine control. The Telegram button is for the
      // common "I trust this skill / this tool category" case, not
      // for synthesizing precise Bash glob rules.
      return { rule: toolName, label: toolName };
    }
    default: {
      // MCP tools (mcp__server__tool) come through with their full
      // namespaced name. Pre-approve the exact tool — same pattern
      // the scaffold already uses for SWITCHROOM_TELEGRAM_MCP_TOOLS.
      if (/^mcp__[A-Za-z0-9_\-]+(__[A-Za-z0-9_\-]+)?$/.test(toolName)) {
        return { rule: toolName, label: toolName };
      }
      // Unknown tool — refuse rather than write a rule we can't
      // explain. Leaves the operator to add it via the CLI.
      return null;
    }
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

function skillBasenameFromPath(input: Record<string, unknown>): string | null {
  const path = readString(input, "path") ?? readString(input, "skill_path");
  if (!path) return null;
  const trimmed = path.replace(/\/SKILL\.md$/i, "").replace(/\/$/, "");
  return basename(trimmed) || null;
}
