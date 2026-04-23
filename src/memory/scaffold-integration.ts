import { resolve } from "node:path";
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
 * Return the MCP server entry for the Switchroom management server.
 *
 * The switchroom-mcp server is a thin wrapper around the `switchroom` CLI,
 * allowing agents to list/start/stop other agents, check auth status,
 * search memory, etc. without needing Bash tool access.
 *
 * @param configPath - Absolute path to the switchroom.yaml config file.
 *   If not provided, the switchroom CLI uses its default search behavior.
 */
export function getSwitchroomMcpSettingsEntry(
  configPath?: string,
): { key: string; value: McpServerConfig } {
  // Resolve the path to switchroom-mcp/server.ts relative to this module.
  // At dev time this file lives at src/memory/scaffold-integration.ts; after
  // bundling it lives at dist/cli/switchroom.js. In both cases the project
  // root is two levels up from `import.meta.dirname`, and switchroom-mcp/
  // sits alongside src/ and dist/ at the project root.
  //
  // NOTE: we deliberately avoid `__filename` here — Bun's bundler replaces it
  // with the absolute source path at build time, which both leaks developer
  // home-dir paths into shipped artifacts and points at a file that does not
  // exist inside the npm tarball.
  const serverPath = resolve(
    import.meta.dirname,
    "..",
    "..",
    "switchroom-mcp",
    "server.ts",
  );

  const env: Record<string, string> = {};
  if (configPath) {
    env.SWITCHROOM_CONFIG = configPath;
  }

  return {
    key: "switchroom",
    value: {
      command: "bun",
      args: ["run", serverPath],
      env,
    },
  };
}
