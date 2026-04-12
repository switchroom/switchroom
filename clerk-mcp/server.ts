#!/usr/bin/env bun
/**
 * Clerk Management MCP Server
 *
 * Thin MCP wrapper around the `clerk` CLI. Exposes memory operations as MCP
 * tools so that Claude Code agents can search and inspect agent memories
 * without needing direct Bash access.
 *
 * Runs as a child process of each agent via stdio transport.
 * Configuration is passed via the CLERK_CONFIG environment variable
 * (path to clerk.yaml).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";

const CONFIG_PATH = process.env.CLERK_CONFIG ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clerk(args: string[]): string {
  const fullArgs = [...args];
  if (CONFIG_PATH) {
    fullArgs.push("--config", CONFIG_PATH);
  }
  try {
    return execFileSync("clerk", fullArgs, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? (err as any).stderr ?? err.message : String(err);
    return `Error: ${message}`;
  }
}

function textResult(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "clerk-management", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---- Tool definitions -----------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "clerk_memory_search",
      description:
        "Search agent memories via Hindsight. Returns the CLI command to execute.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          agent: {
            type: "string",
            description: "Optional: search a specific agent's collection",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "clerk_memory_stats",
      description: "Show per-agent memory collection info and stats.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

// ---- Tool handlers --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "clerk_memory_search": {
      const { query, agent } = args as { query: string; agent?: string };
      const searchArgs = ["memory", "search", query];
      if (agent) {
        searchArgs.push("--agent", agent);
      }
      const output = clerk(searchArgs);
      return textResult(output);
    }

    case "clerk_memory_stats": {
      const output = clerk(["memory", "stats"]);
      return textResult(output);
    }

    default:
      return textResult(`Unknown tool: ${name}`);
  }
});

// ---- Start ----------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("clerk-mcp: server started\n");
}

main().catch((err) => {
  process.stderr.write(`clerk-mcp: fatal error: ${err}\n`);
  process.exit(1);
});
