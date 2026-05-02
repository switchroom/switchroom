import type { SwitchroomConfig } from "../config/schema.js";
import {
  generateHindsightMcpConfig,
  getCollectionForAgent,
  type McpServerConfig,
} from "./hindsight.js";

/**
 * Return the MCP server entry for Hindsight to merge into an agent's
 * settings.json during scaffolding.
 *
 * Returns null if the memory backend is not hindsight.
 */
export function getHindsightSettingsEntry(
  agentName: string,
  config: SwitchroomConfig,
): { key: string; value: McpServerConfig } | null {
  const memoryConfig = config.memory;
  if (!memoryConfig || memoryConfig.backend !== "hindsight") {
    return null;
  }

  const collection = getCollectionForAgent(agentName, config);
  const mcpConfig = generateHindsightMcpConfig(collection, memoryConfig);

  return { key: "hindsight", value: mcpConfig };
}

/**
 * Return the MCP server entry for the Playwright browser automation server.
 *
 * The @playwright/mcp server is Microsoft's official browser automation MCP,
 * launched on demand via npx. It exposes browser_navigate, browser_snapshot
 * (accessibility-tree mode — token-cheap), browser_click, browser_type, and
 * related tools. Included as a built-in default so agents and skills can drive
 * web UIs without installing Playwright locally.
 *
 * Agents that don't need browser access can opt out by setting
 * `mcp_servers: { playwright: false }` in their switchroom.yaml config.
 */
export function getPlaywrightMcpSettingsEntry(): { key: string; value: McpServerConfig } {
  return {
    key: "playwright",
    value: {
      command: "npx",
      // Pinned: Microsoft ships breaking changes without major-version bumps.
      // Bump deliberately when validating against a newer release.
      args: ["-y", "@playwright/mcp@0.0.71", "--snapshot"],
    },
  };
}

/**
 * Describes a single built-in default MCP entry.
 *
 * - `key`: the mcpServers key in settings.json (e.g. "playwright")
 * - `value`: the MCP server config object to write
 * - `optOutKey`: the key in `mcp_servers` that an agent uses to opt out
 *   (currently always the same as `key`, but kept explicit so the type is
 *   self-documenting and future entries can differ)
 */
export interface BuiltinMcpEntry {
  key: string;
  value: McpServerConfig;
  /** The key an agent sets to `false` in `mcp_servers` to suppress this default. */
  optOutKey: string;
}

/**
 * Return the complete list of built-in default MCP entries that every agent
 * should receive unless explicitly opted out.
 *
 * This is the single source of truth consumed by both:
 *   - `scaffoldAgent` / `reconcileAgent` (scaffold.ts) — at agent creation and
 *     on every `switchroom agent reconcile` run
 *   - `reconcileDefaultMcps` (update.ts) — at `switchroom update` time, so
 *     agents created before a default was introduced pick it up automatically
 *
 * To add a new built-in default: add an entry here. Both scaffold and update
 * paths will pick it up automatically.
 *
 * Agents can opt out of any entry by setting
 * `mcp_servers: { <optOutKey>: false }` in their switchroom.yaml config.
 */
export function getBuiltinDefaultMcpEntries(): BuiltinMcpEntry[] {
  const playwright = getPlaywrightMcpSettingsEntry();
  return [
    { key: playwright.key, value: playwright.value, optOutKey: playwright.key },
  ];
}

/**
 * Describes a single built-in default skill entry.
 *
 * - `key`: directory name in the bundled `skills/` pool (also the name
 *   used inside `<agentDir>/.claude/skills/`).
 * - `optOutKey`: key in `defaults.bundled_skills` (or per-agent
 *   `bundled_skills`) that the operator sets to `false` to suppress
 *   this default. Currently always equal to `key`, kept explicit so the
 *   type self-documents and a future rename can stay backward-compatible.
 * - `source`: where the skill was sourced from. "anthropic" entries are
 *   vendored from anthropics/skills (see each skill's VENDORED.md);
 *   "switchroom" entries are first-party operator skills bundled in this
 *   repo under skills/switchroom-*.
 */
export interface BuiltinSkillEntry {
  key: string;
  optOutKey: string;
  source: "anthropic" | "switchroom";
}

/**
 * Built-in default skills that ship enabled on every Switchroom agent
 * regardless of role, unless explicitly opted out via
 * `defaults.bundled_skills: { <key>: false }` (or per-agent
 * `bundled_skills`).
 *
 * Two source pools:
 *
 *   - **Anthropic vendored** (`source: "anthropic"`): MIT-licensed skills
 *     from https://github.com/anthropics/skills, vendored under
 *     `skills/<name>/` with a `VENDORED.md` recording the pin commit.
 *   - **Switchroom core** (`source: "switchroom"`): the slim operator
 *     surface every agent benefits from — log tailing, status checks,
 *     "something is broken" diagnostics. The fuller operator set
 *     (switchroom-install / switchroom-manage / switchroom-architecture)
 *     stays foreman-only and is still gated inside `installSwitchroomSkills`.
 *
 * To add a new universal default: add an entry here. Both the scaffold
 * path and the `switchroom update` reconcile path pick it up automatically.
 */
export function getBuiltinDefaultSkillEntries(): BuiltinSkillEntry[] {
  const anthropic = [
    "skill-creator",
    "mcp-builder",
    "webapp-testing",
    "pdf",
    "docx",
    "xlsx",
    "pptx",
  ] as const;
  const switchroomCore = [
    "switchroom-cli",
    "switchroom-status",
    "switchroom-health",
  ] as const;
  return [
    ...anthropic.map((key) => ({ key, optOutKey: key, source: "anthropic" as const })),
    ...switchroomCore.map((key) => ({ key, optOutKey: key, source: "switchroom" as const })),
  ];
}

// #235: getSwitchroomMcpSettingsEntry removed. The switchroom-mcp server's
// 4 tools (switchroom_memory_*, workspace_memory_*) had zero production
// callers and were subsumed by Hindsight's MCP (`mcp__hindsight__*`) +
// Claude Code's built-in Read/Grep. Reconcile in scaffold.ts now actively
// retracts any stale `settings.mcpServers.switchroom` entry from
// pre-existing agents.
