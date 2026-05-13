/**
 * hostd MCP shim — gives admin agents (e.g. klanker) tool-call access
 * to the host-control daemon's fleet-management verbs.
 *
 * Tools (1:1 with hostd protocol verbs):
 *   agent_restart  → restart any agent (self OR admin; cross-agent admin-only)
 *   agent_start    → start an agent  (self OR admin)
 *   agent_stop     → stop an agent   (self OR admin)
 *   update_check   → dry-run update plan (read-only, no gate)
 *   update_apply   → execute fleet update (admin-only at the wire layer)
 *
 * The hostd daemon enforces the admin-vs-self gates wire-side
 * (src/host-control/server.ts checkGate). This MCP server does NOT
 * duplicate those checks — it just translates tool calls to
 * `hostdRequest()` and surfaces the response. The wire-side gate is
 * the security boundary; this layer is plumbing.
 *
 * Surface decision: tools are exposed unconditionally even on
 * non-admin agents. The daemon-side gate already returns `denied` for
 * unauthorized cross-agent calls, so non-admin agents can still
 * self-restart via `agent_restart{name: "<self>"}`. Tool visibility
 * is not the security boundary.
 *
 * Wired by the agent scaffold into .mcp.json for every agent (PR δ).
 * Socket lookup is path-as-identity: the agent's `SWITCHROOM_AGENT_NAME`
 * pins which `/run/switchroom/hostd/<name>/sock` to talk to.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostdRequest } from "../../host-control/client.js";
import type {
  HostdRequest,
  HostdResponse,
} from "../../host-control/protocol.js";

const SELF_AGENT = process.env.SWITCHROOM_AGENT_NAME ?? "";

function selfSocketPath(): string {
  return `/run/switchroom/hostd/${SELF_AGENT}/sock`;
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

interface ToolArgs {
  name?: string;
  reason?: string;
  force?: boolean;
  skip_images?: boolean;
  rebuild?: boolean;
  // agent_logs / agent_exec
  tail?: number;
  argv?: string[];
}

export const TOOLS = [
  {
    name: "agent_restart",
    description:
      "Restart an agent via the host-control daemon. Self-targeting " +
      "is allowed for every caller; cross-agent (`name` ≠ the caller's " +
      "$SWITCHROOM_AGENT_NAME) requires the caller to be admin-flagged " +
      "in switchroom.yaml. Returns `started` on dispatch; the daemon " +
      "spawns `switchroom agent restart` on the host (the agent " +
      "container has no docker access so this is the only path that " +
      "actually works in docker-mode).",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
          description: "Target agent name (kebab-case ASCII).",
        },
        reason: {
          type: "string",
          maxLength: 512,
          description:
            "Optional audit-log reason. Stamped into the agent's " +
            "post-restart greeting card.",
        },
        force: {
          type: "boolean",
          description:
            "Skip the clean-shutdown drain wait. Default false.",
        },
      },
    },
  },
  {
    name: "agent_start",
    description:
      "Start a stopped agent. Self-targeting allowed; cross-agent " +
      "requires admin. Equivalent to `switchroom agent start <name>`.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
        },
      },
    },
  },
  {
    name: "agent_stop",
    description:
      "Stop a running agent. Self-targeting allowed; cross-agent " +
      "requires admin. Equivalent to `switchroom agent stop <name>`.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
        },
      },
    },
  },
  {
    name: "update_check",
    description:
      "Dry-run plan for `switchroom update`: report what would be " +
      "pulled, recreated, and rebuilt without making changes. " +
      "Read-only; no admin gate. Useful before calling update_apply.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "agent_logs",
    description:
      "Read recent docker logs of any peer agent. Self-target is " +
      "always allowed; cross-agent requires admin: true on the caller. " +
      "Returns the trailing `tail` lines (default 100, max 2000) as " +
      "`stdout_tail` / `stderr_tail` (each capped at 4 KiB). Use this " +
      "for triage when a user reports a peer agent is misbehaving.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
          description: "Target agent name (kebab-case ASCII).",
        },
        tail: {
          type: "number",
          description: "Trailing lines to return. Default 100, max 2000.",
        },
      },
    },
  },
  {
    name: "agent_exec",
    description:
      "Run a read-only inspection command inside a peer agent's " +
      "container via `docker exec`. Self-target allowed; cross-agent " +
      "requires admin: true. argv[0] must be on the daemon's read-only " +
      "allowlist (cat, df, du, free, grep, head, hostname, id, " +
      "ls, ps, pwd, stat, tail, uname, uptime, wc, whoami). Anything " +
      "outside the allowlist returns `denied` with a pointer to the " +
      "deferred host_os.exec approval-kernel scope. Returns stdout/" +
      "stderr tails capped at 4 KiB each.",
    inputSchema: {
      type: "object" as const,
      required: ["name", "argv"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
        },
        argv: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { type: "string", minLength: 1 },
          description:
            "Command + args, e.g. [\"ls\", \"-la\", \"/state\"]. " +
            "argv[0] is the program; argv[1..] are its arguments.",
        },
      },
    },
  },
  {
    name: "update_apply",
    description:
      "Execute a fleet-wide update: pull images, regenerate " +
      "scaffolds, recreate containers. Admin-only at the wire layer. " +
      "Returns `started` once dispatched — the actual work runs " +
      "async on the host and the caller's own agent container will " +
      "be recreated as part of the cycle.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skip_images: {
          type: "boolean",
          description:
            "Skip the `docker compose pull` step. Useful when local " +
            "images are already at the desired tag.",
        },
        rebuild: {
          type: "boolean",
          description:
            "Source-checkout users: also run `git pull && npm run " +
            "build` before the compose recreate.",
        },
      },
    },
  },
];

/**
 * Translate a tool call into a HostdRequest and dispatch it.
 *
 * Caller (the MCP transport) catches thrown errors and converts them
 * to `isError: true` responses, so this can throw synchronously for
 * argument-validation failures.
 */
export async function dispatchTool(
  name: string,
  args: ToolArgs,
): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  if (!SELF_AGENT) {
    return errorText(
      "hostd MCP: SWITCHROOM_AGENT_NAME env var is not set — cannot " +
        "determine which per-agent socket to talk to.",
    );
  }

  const sockPath = selfSocketPath();
  if (!existsSync(sockPath)) {
    return errorText(
      `hostd MCP: socket not bound at ${sockPath}. The host-control ` +
        `daemon is either not installed (run \`switchroom hostd install\`) ` +
        `or this agent isn't admin-flagged in switchroom.yaml. RFC C ` +
        `bind-mounts the per-agent socket only when host_control.enabled ` +
        `is true AND the agent has admin: true.`,
    );
  }

  let req: HostdRequest;
  switch (name) {
    case "agent_restart": {
      if (!args.name) return errorText("agent_restart: name is required");
      req = {
        v: 1,
        op: "agent_restart",
        request_id: makeRequestId("mcp-restart"),
        args: {
          name: args.name,
          ...(args.reason ? { reason: args.reason } : {}),
          ...(typeof args.force === "boolean" ? { force: args.force } : {}),
        },
      };
      break;
    }
    case "agent_start": {
      if (!args.name) return errorText("agent_start: name is required");
      req = {
        v: 1,
        op: "agent_start",
        request_id: makeRequestId("mcp-start"),
        args: { name: args.name },
      };
      break;
    }
    case "agent_stop": {
      if (!args.name) return errorText("agent_stop: name is required");
      req = {
        v: 1,
        op: "agent_stop",
        request_id: makeRequestId("mcp-stop"),
        args: { name: args.name },
      };
      break;
    }
    case "agent_logs": {
      if (!args.name) return errorText("agent_logs: name is required");
      req = {
        v: 1,
        op: "agent_logs",
        request_id: makeRequestId("mcp-logs"),
        args: {
          name: args.name,
          ...(typeof args.tail === "number" ? { tail: args.tail } : {}),
        },
      };
      break;
    }
    case "agent_exec": {
      if (!args.name) return errorText("agent_exec: name is required");
      if (!Array.isArray(args.argv) || args.argv.length === 0) {
        return errorText("agent_exec: argv is required and must be non-empty");
      }
      req = {
        v: 1,
        op: "agent_exec",
        request_id: makeRequestId("mcp-exec"),
        args: { name: args.name, argv: args.argv },
      };
      break;
    }
    case "update_check": {
      req = {
        v: 1,
        op: "update_check",
        request_id: makeRequestId("mcp-update-check"),
      };
      break;
    }
    case "update_apply": {
      req = {
        v: 1,
        op: "update_apply",
        request_id: makeRequestId("mcp-update-apply"),
        args: {
          ...(args.skip_images ? { skip_images: true } : {}),
          ...(args.rebuild ? { rebuild: true } : {}),
        },
      };
      break;
    }
    default:
      return errorText(`unknown tool: ${name}`);
  }

  let resp: HostdResponse;
  try {
    resp = await hostdRequest(
      { socketPath: sockPath, timeoutMs: 10_000 },
      req,
    );
  } catch (err) {
    return errorText(
      `hostd wire error (request_id=${req.request_id}): ` +
        `${(err as Error).message}`,
    );
  }

  // started/completed: success path. Surface the full response as
  // JSON so the model can correlate later via request_id.
  if (resp.result === "started" || resp.result === "completed") {
    return jsonText(resp);
  }

  // denied/error: tool-error so the model can see it failed but also
  // sees the full daemon response (including the daemon's error
  // message) without raising an exception.
  return {
    content: [{ type: "text" as const, text: JSON.stringify(resp) }],
    isError: true,
  };
}

function jsonText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorText(msg: string) {
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true,
  };
}

export async function runHostdMcpServer(): Promise<void> {
  const server = new Server(
    { name: "hostd", version: "0.1.0" },
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
