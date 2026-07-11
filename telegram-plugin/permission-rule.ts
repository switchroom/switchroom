/**
 * Resolve Claude Code permission allow-rules from a permission_request
 * payload — the value(s) we'd add to `tools.allow` in switchroom.yaml so
 * future invocations of the same operation never pop another approval
 * dialog.
 *
 * Used by the Telegram permission card's "🔁 Always…" button. The button
 * no longer commits a single fixed-breadth rule: it opens a scope choice
 * so the operator decides whether "always" means *this exact thing* (e.g.
 * this one file, this one MCP action) or *the whole category* (any file,
 * every tool on the server). The scope of the grant — especially for
 * "always" — must be legible before the operator taps it (vision pillar
 * #2: you hold the leash).
 *
 * `resolveScopedAllowChoices` returns up to two options:
 *   - `specific` — the narrow grant (this file / this command / this
 *     MCP action). Omitted when the tool has no meaningful sub-scope.
 *   - `broad` — the category grant (any file / any command / every tool
 *     on the server). Always present when choices resolve at all; the
 *     gateway flags it with a ⚠️ and places it last.
 *
 * Returns `null` when the tool is something we can't allow at a
 * meaningful granularity — the caller hides the Always button rather
 * than write a useless or dangerously-broad rule.
 *
 * The rule strings match Claude Code's settings.json permission-rule
 * grammar (`Tool`, `Tool(arg)`, `mcp__server__tool`, `mcp__server__*`).
 */

import { basename } from "node:path";

/** One scope option offered behind the "🔁 Always…" button. */
export interface ScopeOption {
  /** Exact string to add to `tools.allow` in switchroom.yaml. */
  readonly rule: string;
  /** Short button label, e.g. "This file" / "Any file" / "All Perplexity". */
  readonly buttonLabel: string;
  /** True for the broadest option — gateway rides a ⚠️ on it and shows it last. */
  readonly broad: boolean;
}

export interface ScopedAllowChoices {
  /** Narrow grant (this file / this command / this action). May be absent. */
  readonly specific?: ScopeOption;
  /** Broadest grant (any file / any command / every server tool). */
  readonly broad: ScopeOption;
}

const FILE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Read",
]);

// Tools with no meaningful sub-scope — only a broad, whole-tool grant.
const BROAD_ONLY_TOOLS = new Set([
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Workflow",
  "TodoWrite",
  "ExitPlanMode",
]);

/**
 * @param toolName     Claude Code's tool_name from the permission_request
 * @param inputPreview JSON string with the tool's input. May be undefined
 *                     or non-JSON; the function is conservative.
 */
export function resolveScopedAllowChoices(
  toolName: string,
  inputPreview: string | undefined,
): ScopedAllowChoices | null {
  if (!toolName) return null;
  const input = parseInput(inputPreview);

  // ── Skill: per-skill is the narrow grant; all skills is the broad one.
  if (toolName === "Skill") {
    const skill = input ? resolveSkillName(input) : null;
    if (!skill) return null; // can't name it → don't offer an always rule
    if (!/^[A-Za-z0-9._\-+]+$/.test(skill)) return null;
    return {
      specific: { rule: `Skill(${skill})`, buttonLabel: "This skill", broad: false },
      broad: { rule: "Skill", buttonLabel: "Any skill", broad: true },
    };
  }

  // ── File tools: this exact path vs any file.
  if (FILE_TOOLS.has(toolName)) {
    const path = filePathFrom(input, inputPreview);
    const broad: ScopeOption = { rule: toolName, buttonLabel: "Any file", broad: true };
    if (path) {
      return {
        specific: { rule: `${toolName}(${path})`, buttonLabel: "This file", broad: false },
        broad,
      };
    }
    return { broad };
  }

  // ── Bash: this command family (`npm:*`) vs any command.
  if (toolName === "Bash") {
    const broad: ScopeOption = { rule: "Bash", buttonLabel: "Any command", broad: true };
    const cmd = input ? readString(input, "command") : null;
    const tok = cmd ? bashFirstToken(cmd) : null;
    if (tok) {
      return {
        specific: { rule: `Bash(${tok}:*)`, buttonLabel: `${tok} commands`, broad: false },
        broad,
      };
    }
    return { broad };
  }

  if (BROAD_ONLY_TOOLS.has(toolName)) {
    return { broad: { rule: toolName, buttonLabel: "Always allow", broad: true } };
  }

  // ── MCP tools: `mcp__<server>__<tool>`. This exact action vs every
  // tool on the server (`mcp__<server>__*`).
  const mcp = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(toolName);
  if (mcp) {
    const server = mcp[1]!;
    return {
      specific: { rule: toolName, buttonLabel: "This action", broad: false },
      broad: { rule: `mcp__${server}__*`, buttonLabel: `All ${prettyMcpServer(server)}`, broad: true },
    };
  }
  // Server-only namespace (`mcp__hindsight`) — broad grant only.
  if (/^mcp__[A-Za-z0-9_-]+$/.test(toolName)) {
    return { broad: { rule: toolName, buttonLabel: "Always allow", broad: true } };
  }

  // Unknown tool — refuse rather than write a rule we can't explain.
  return null;
}

/**
 * Prettify an MCP server slug for display: `perplexity` → `Perplexity`,
 * `google-workspace` → `Google Workspace`. Exported so the card title
 * layer (permission-title.ts) renders the same server name as the
 * scope button.
 */
export function prettyMcpServer(server: string): string {
  return server
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

function filePathFrom(
  input: Record<string, unknown> | null,
  rawPreview?: string,
): string | null {
  if (input) {
    const p = readString(input, "file_path") ?? readString(input, "notebook_path");
    if (p) return p;
  }
  // Claude Code truncates inputPreview to 200 chars, making the surrounding
  // JSON invalid for Edit/Write (old_string/new_string push it past 200).
  // "file_path" is the first key, so its value is intact in the truncated
  // prefix — extract it with a lenient regex on the raw string.
  if (rawPreview) return extractFilePathFromRaw(rawPreview);
  return null;
}

/**
 * Regex-based fallback to extract "file_path" or "notebook_path" from a raw
 * (possibly truncated / invalid-JSON) inputPreview string. JSON-unescapes the
 * captured value. Returns null when neither key is present or value is empty.
 */
function extractFilePathFromRaw(raw: string): string | null {
  const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return null;
  try {
    const value = JSON.parse(`"${m[1]}"`) as string;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * First token of a Bash command, used to synthesize a `Bash(<tok>:*)`
 * prefix rule. Returns null for anything that isn't a clean command
 * word (paths, shell metacharacters, traversal) — better to fall back
 * to the explicit "any command" grant than emit a rule that doesn't
 * match what the operator saw.
 */
function bashFirstToken(command: string): string | null {
  const m = /^\s*([^\s|&;<>()`$]+)/.exec(command);
  if (!m) return null;
  const tok = m[1]!;
  if (tok.includes("..")) return null;
  // Allow a leading path (e.g. /usr/bin/ls) but keep it a single safe word.
  return /^[A-Za-z0-9._\-\/]+$/.test(tok) ? tok : null;
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

/**
 * Verify that a grant actually landed in the resolved `tools.allow` list.
 * Called by the always-allow handler after the persistence round-trip to
 * guard against silently-failed or misdirected yaml writes.
 */
export function isRulePersisted(
  resolvedAllow: readonly string[],
  ruleRule: string,
): boolean {
  return resolvedAllow.includes(ruleRule);
}

/**
 * Inverse of the rule resolver — does a stored allow-rule cover a fresh
 * `permission_request`? Used by the bridge's session-scoped always-allow
 * cache (#1138) to short-circuit prompts when the operator has already
 * tapped an equivalent grant earlier in the same session.
 *
 * Matching rules (mirror what `resolveScopedAllowChoices` produces):
 *
 *   - Bare tool name (`Edit`, `Bash`, …) ⇒ any invocation of that tool.
 *   - `Edit(<path>)` / `Read(<path>)` / … ⇒ that tool, that exact file.
 *   - `Bash(<tok>:*)` ⇒ Bash whose first command token equals `<tok>`.
 *   - `Skill(<name>)` ⇒ Skill whose resolved name equals `<name>`.
 *   - `mcp__<server>__<tool>` ⇒ that exact namespaced MCP tool.
 *   - `mcp__<server>__*` ⇒ any tool on that MCP server.
 *
 * Returns `false` for any malformed rule rather than throwing — the
 * caller (bridge) is on the hot permission path.
 */
export function matchesAllowRule(
  rule: string,
  toolName: string,
  inputPreview: string | undefined,
): boolean {
  if (!rule || !toolName) return false;

  // MCP wildcard: `mcp__server__*` covers every tool on that server.
  if (rule.endsWith("__*") && rule.startsWith("mcp__")) {
    const prefix = rule.slice(0, -1); // drop the trailing "*" → "mcp__server__"
    return toolName.startsWith(prefix);
  }

  // `Tool(arg)` — scoped grants for Skill / file tools / Bash.
  const scoped = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
  if (scoped) {
    const ruleTool = scoped[1]!;
    const arg = scoped[2]!;
    if (ruleTool !== toolName) return false;
    const input = parseInput(inputPreview);

    if (ruleTool === "Skill") {
      if (!input) return false;
      return resolveSkillName(input) === arg;
    }
    if (ruleTool === "Bash") {
      const cmd = input ? readString(input, "command") : null;
      if (!cmd) return false;
      const m = /^([^:]+):\*$/.exec(arg); // "<tok>:*"
      if (!m) return false;
      return bashFirstToken(cmd) === m[1];
    }
    if (FILE_TOOLS.has(ruleTool)) {
      return filePathFrom(input, inputPreview) === arg;
    }
    return false;
  }

  // Bare tool name or exact namespaced MCP tool — exact string compare.
  return rule === toolName;
}
