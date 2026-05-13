/**
 * agent-config MCP shim.
 *
 * Tiny stdio MCP server that exposes four read-only tools backed by
 * the corresponding `switchroom <cmd>` CLI subcommands. The shim
 * re-exec's the CLI on every tool call so the audit-log row is
 * written from the same process tree as a direct CLI invocation and
 * the peer-cred-by-construction story holds — both run as the
 * agent's container uid with `$SWITCHROOM_AGENT_NAME` pinned by the
 * scaffold-written .mcp.json env.
 *
 * Tools:
 *   config_get  → `switchroom config get [--agent <n>]`
 *   cron_list   → `switchroom cron list  [--agent <n>]`
 *   skill_list  → `switchroom skill list [--agent <n>]`
 *   audit_tail  → `switchroom audit tail [--agent <n>] [--limit N]`
 *
 * Each tool exec's the CLI, captures stdout, parses JSON (or JSONL
 * for audit_tail), and returns it as the tool result.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";

const CLI_BIN = process.env.SWITCHROOM_CLI ?? "switchroom";

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function execCli(args: string[]): ExecResult {
  const r = spawnSync(CLI_BIN, args, {
    encoding: "utf-8",
    env: process.env,
    timeout: 15000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

function jsonText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorText(msg: string) {
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true,
  };
}

interface ToolArgs {
  agent?: string;
  limit?: number;
}

function buildArgs(base: string[], a: ToolArgs): string[] {
  const out = [...base];
  if (a.agent) out.push("--agent", a.agent);
  if (typeof a.limit === "number") out.push("--limit", String(a.limit));
  return out;
}

export const TOOLS = [
  {
    name: "config_get",
    description:
      "Return the agent's merged switchroom config slice as JSON. " +
      "Read-only. Cross-agent reads are denied: if --agent doesn't match " +
      "$SWITCHROOM_AGENT_NAME (the agent's pinned identity), the call fails.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description:
            "Target agent name. Optional — defaults to the env-pinned agent identity.",
        },
      },
    },
  },
  {
    name: "cron_list",
    description:
      "List the agent's scheduled cron entries (schedule array) as JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" },
      },
    },
  },
  {
    name: "skill_list",
    description:
      "List the agent's skills and bundled-skill opt-outs as JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" },
      },
    },
  },
  {
    name: "audit_tail",
    description:
      "Tail the most recent rows of the agent-config audit log " +
      "(filtered to this agent). Default 20 rows, max 100.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" },
        limit: {
          type: "number",
          description: "Max rows to return. Default 20, max 100.",
        },
      },
    },
  },
];

export function dispatchTool(
  name: string,
  args: ToolArgs,
): { content: { type: "text"; text: string }[]; isError?: boolean } {
  let cliArgs: string[];
  let parseMode: "json" | "jsonl";
  switch (name) {
    case "config_get":
      cliArgs = buildArgs(["config", "get"], args);
      parseMode = "json";
      break;
    case "cron_list":
      cliArgs = buildArgs(["cron", "list"], args);
      parseMode = "json";
      break;
    case "skill_list":
      cliArgs = buildArgs(["skill", "list"], args);
      parseMode = "json";
      break;
    case "audit_tail":
      cliArgs = buildArgs(["audit", "tail"], args);
      parseMode = "jsonl";
      break;
    default:
      return errorText(`unknown tool: ${name}`);
  }

  const r = execCli(cliArgs);
  if (r.status !== 0) {
    return errorText(
      `CLI exit ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  try {
    if (parseMode === "json") {
      const data = JSON.parse(r.stdout.trim() || "null");
      return jsonText(data);
    }
    // jsonl
    const rows = r.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    return jsonText(rows);
  } catch (err) {
    return errorText(`failed to parse CLI output: ${(err as Error).message}`);
  }
}

export async function runAgentConfigMcpServer(): Promise<void> {
  const server = new Server(
    { name: "agent-config", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchTool(name, (args ?? {}) as ToolArgs);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
