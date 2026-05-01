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

// #235: getSwitchroomMcpSettingsEntry removed. The switchroom-mcp server's
// 4 tools (switchroom_memory_*, workspace_memory_*) had zero production
// callers and were subsumed by Hindsight's MCP (`mcp__hindsight__*`) +
// Claude Code's built-in Read/Grep. Reconcile in scaffold.ts now actively
// retracts any stale `settings.mcpServers.switchroom` entry from
// pre-existing agents.
