#!/usr/bin/env bun
/**
 * Switchroom Management MCP Server
 *
 * Thin MCP wrapper around the `switchroom` CLI. Exposes memory operations as MCP
 * tools so that Claude Code agents can search and inspect agent memories
 * without needing direct Bash access.
 *
 * Runs as a child process of each agent via stdio transport.
 * Configuration is passed via the SWITCHROOM_CONFIG environment variable
 * (path to switchroom.yaml).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";

const CONFIG_PATH = process.env.SWITCHROOM_CONFIG ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function switchroom(args: string[]): string {
  const fullArgs = [...args];
  if (CONFIG_PATH) {
    fullArgs.push("--config", CONFIG_PATH);
  }
  try {
    return execFileSync("switchroom", fullArgs, {
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
  { name: "switchroom-management", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---- Tool definitions -----------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "switchroom_memory_search",
      description:
        "Search agent memories via Hindsight (semantic / embedding-based). " +
        "Returns the CLI command to execute.",
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
      name: "switchroom_memory_stats",
      description: "Show per-agent memory collection info and stats.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "workspace_memory_search",
      description:
        "Fast file-system search (BM25-lite) over the current agent's workspace " +
        "markdown files: MEMORY.md, memory/YYYY-MM-DD.md, AGENTS.md, USER.md, " +
        "IDENTITY.md, TOOLS.md, HEARTBEAT.md. Use this for factual recall, " +
        "preferences, decisions, people, and recent notes. Distinct from the " +
        "Hindsight semantic tool above. Results are re-read every call so " +
        "workspace edits are reflected immediately.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Free-text search query" },
          max_results: {
            type: "number",
            description: "Max hits to return (default 6)",
          },
          agent: {
            type: "string",
            description:
              "Optional agent name. Defaults to the current agent from SWITCHROOM_AGENT_NAME.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "workspace_memory_get",
      description:
        "Read a single workspace markdown file by its workspace-relative path " +
        "(e.g. 'MEMORY.md' or 'memory/2026-04-19.md'). Refuses path traversal " +
        "outside the workspace dir.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path of the file to read",
          },
          agent: {
            type: "string",
            description:
              "Optional agent name. Defaults to the current agent from SWITCHROOM_AGENT_NAME.",
          },
        },
        required: ["path"],
      },
    },
  ],
}));

// ---- Tool handlers --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "switchroom_memory_search": {
      const { query, agent } = args as { query: string; agent?: string };
      const searchArgs = ["memory", "search", query];
      if (agent) {
        searchArgs.push("--agent", agent);
      }
      const output = switchroom(searchArgs);
      return textResult(output);
    }

    case "switchroom_memory_stats": {
      const output = switchroom(["memory", "stats"]);
      return textResult(output);
    }

    case "workspace_memory_search": {
      const {
        query,
        max_results,
        agent,
      } = args as { query: string; max_results?: number; agent?: string };
      const effectiveAgent = agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "";
      if (!effectiveAgent) {
        return textResult(
          "Error: no agent specified and SWITCHROOM_AGENT_NAME env var is not set.",
        );
      }
      const searchArgs = [
        "workspace",
        "search",
        effectiveAgent,
        query,
        "--json",
      ];
      if (typeof max_results === "number" && Number.isFinite(max_results) && max_results > 0) {
        searchArgs.push("--max-results", String(Math.floor(max_results)));
      }
      const output = switchroom(searchArgs);
      return textResult(output);
    }

    case "workspace_memory_get": {
      const { path: filePath, agent } = args as { path: string; agent?: string };
      const effectiveAgent = agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "";
      if (!effectiveAgent) {
        return textResult(
          "Error: no agent specified and SWITCHROOM_AGENT_NAME env var is not set.",
        );
      }
      const output = switchroom(["workspace", "show", effectiveAgent, filePath]);
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
  process.stderr.write("switchroom-mcp: server started\n");
}

main().catch((err) => {
  process.stderr.write(`switchroom-mcp: fatal error: ${err}\n`);
  process.exit(1);
});
