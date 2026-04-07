import { resolve, dirname } from "node:path";
import type { ClerkConfig } from "../config/schema.js";
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
  config: ClerkConfig,
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
 * Return the MCP server entry for the Clerk management server.
 *
 * The clerk-mcp server is a thin wrapper around the `clerk` CLI,
 * allowing agents to list/start/stop other agents, check auth status,
 * search memory, etc. without needing Bash tool access.
 *
 * @param configPath - Absolute path to the clerk.yaml config file.
 *   If not provided, the clerk CLI uses its default search behavior.
 */
export function getClerkMcpSettingsEntry(
  configPath?: string,
): { key: string; value: McpServerConfig } {
  // Resolve the path to clerk-mcp/server.ts relative to this source file.
  // At runtime this file lives at src/memory/scaffold-integration.ts (or .js),
  // and clerk-mcp/ is at the project root alongside src/.
  const serverPath = resolve(
    dirname(dirname(dirname(import.meta.path ?? __filename))),
    "clerk-mcp",
    "server.ts",
  );

  const env: Record<string, string> = {};
  if (configPath) {
    env.CLERK_CONFIG = configPath;
  }

  return {
    key: "clerk",
    value: {
      command: "bun",
      args: ["run", serverPath],
      env,
    },
  };
}
