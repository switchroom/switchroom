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
 * Surface decision: within an agent that HAS this server, every tool is
 * exposed unconditionally — the daemon-side gate returns `denied` for
 * unauthorized cross-agent calls, so tool visibility is not the security
 * boundary. (The scaffold only wires this server into admin/root agents'
 * .mcp.json — see scaffold.ts — so non-admin agents don't carry it at all.)
 *
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
import { existsSync, readFileSync } from "node:fs";
import { hostdRequest } from "../../host-control/client.js";
import {
  defaultAuditLogPath,
  parseAuditLine,
  type AuditEntry,
} from "../../host-control/audit-reader.js";
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

// Wire timeouts are PER-OP. Almost every hostd op returns promptly
// (`started`/`completed` within a tick), so a snappy 10s wire keeps the
// agent responsive. `config_propose_edit` is the exception: the daemon
// BLOCKS server-side awaiting the operator's approval tap (up to
// CONFIG_APPROVAL_TIMEOUT_MS = 10 min in host-control/server.ts) before
// it applies and returns. A 10s wire on that op times out by
// construction — a human cannot tap in 10s — and the agent misreads the
// timeout as a wire failure, then re-fires, stacking phantom approval
// cards (the 2026-06-15 klanker debacle: re-fires double-wrote a config
// entry). The wire MUST outlast the approval window; this mirrors the
// web dashboard's PROPOSE_TIMEOUT_MS (src/web/hostd-config-propose.ts).
const DEFAULT_WIRE_TIMEOUT_MS = 10_000;
const WIRE_TIMEOUT_MS_BY_OP: Partial<Record<HostdRequest["op"], number>> = {
  config_propose_edit: 11 * 60 * 1000,
};

export function wireTimeoutForOp(op: HostdRequest["op"]): number {
  return WIRE_TIMEOUT_MS_BY_OP[op] ?? DEFAULT_WIRE_TIMEOUT_MS;
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
  // update_apply release-override (PR B)
  channel?: "dev" | "rc" | "latest";
  pin?: string;
  // rollout (#2487)
  agents?: string[];
  skip_web?: boolean;
  // config_propose_edit args
  unified_diff?: string;
  target_path?: string;
}

/** Semver-only pin matcher for the rollout verb (#2487). Rejects `sha-…`
 *  pins at the wire — a sha is a valid release.pin but is NOT
 *  version-assertable, so it would stop the staggered roll on agent #1. */
const ROLLOUT_SEMVER_PIN_RE = /^v\d+\.\d+\.\d+$/;

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
        channel: {
          type: "string",
          enum: ["dev", "rc", "latest"],
          description:
            "One-shot release-channel override. Mirrors `switchroom " +
            "update --channel`. Mutually exclusive with `pin`.",
        },
        pin: {
          type: "string",
          pattern: "^(sha-[0-9a-f]{7,40}|v\\d+\\.\\d+\\.\\d+)$",
          description:
            "One-shot release-pin override (sha-<7-40 hex> or " +
            "v<semver>). Mirrors `switchroom update --pin`. Mutually " +
            "exclusive with `channel`.",
        },
      },
    },
  },
  {
    name: "rollout",
    description:
      "SAFELY roll the fleet to a pinned SEMVER version, staggered and " +
      "canary-gated (#2487). Unlike update_apply (a blunt all-at-once " +
      "recreate), this restarts agents one at a time canary-first, asserts " +
      "each agent's in-container `switchroom --version` matches the target, " +
      "and STOPS on the first mismatch — so a bad build fails on the canary " +
      "before touching the rest of the fleet. The durable release.pin is " +
      "persisted only AFTER the canary confirms (a failed canary never " +
      "strands a bad pin). `pin` MUST be a tagged semver (vX.Y.Z) — sha " +
      "pins are rejected because the version assert needs a semver to " +
      "compare against. The hostd/web self-refresh is DEFERRED on this path " +
      "(an agent-invoked rollout cannot recreate its own hostd container " +
      "without killing itself); run that host-side. Downgrade pins are " +
      "rejected (rollback is an operator-tapped verb, not an agent " +
      "rollout). Admin-only at the wire layer AND deliberately NOT pre-" +
      "approved — every call surfaces a Telegram approval card for the " +
      "operator to tap. Returns `started`; poll get_status for the " +
      "structured outcome (which agents rolled / where it stopped).",
    inputSchema: {
      type: "object" as const,
      required: ["pin"],
      properties: {
        pin: {
          type: "string",
          pattern: "^v\\d+\\.\\d+\\.\\d+$",
          description:
            "Target semver to roll to, e.g. v0.15.18. SHA pins are " +
            "rejected — the staggered roll asserts the in-container " +
            "semver version.",
        },
        agents: {
          type: "array",
          items: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" },
          minItems: 1,
          description:
            "Explicit subset of agents to roll (default: all configured). " +
            "Canary-first ordering still applies.",
        },
        skip_web: {
          type: "boolean",
          description:
            "Skip the web + hostd refresh step. NB: on this (hostd) path " +
            "the hostd/web refresh is deferred regardless; this flag is " +
            "forwarded for parity.",
        },
      },
    },
  },
  {
    name: "config_propose_edit",
    description:
      "Propose a unified-diff patch against /state/config/switchroom.yaml. " +
      "The host validates the patch (applies cleanly + post-patch yaml parses " +
      "against the config schema + no secret leak), raises a Telegram approval " +
      "card in the OPERATOR's primary chat (NOT yours — the requesting agent's " +
      "chat is not the approval surface), and on Allow applies it in place and " +
      "reconciles (rolling back if reconcile fails); returns " +
      "result:\"completed\" on success. Use this — behind the operator's tap — " +
      "to amend config instead of asking the operator to hand-edit the yaml. " +
      "Admin agents may propose ANY field; non-admin agents are confined to " +
      "their own agents.<self>.tools.allow. Requires " +
      "hostd.config_edit_enabled=true (operator opt-in; default off) — returns " +
      "E_CONFIG_EDIT_DISABLED otherwise. An applied edit is not live in the " +
      "running agent until it restarts (the approval card names which agents " +
      "to bounce). This call BLOCKS until the operator taps Allow/Deny (or the " +
      "~10-min approval window expires) — that is expected, NOT a hang. Issue " +
      "it ONCE and wait for the single result; do NOT re-fire while waiting " +
      "(a duplicate identical proposal is collapsed onto the pending one, but " +
      "re-firing only adds confusion). On a genuine failure you get a " +
      "structured error (E_*); surface that honestly rather than falling back " +
      "to asking the operator to hand-edit the yaml.",
    inputSchema: {
      type: "object" as const,
      required: ["unified_diff", "reason", "target_path"],
      properties: {
        unified_diff: {
          type: "string",
          minLength: 1,
          description:
            "Unified diff against switchroom.yaml. Any context level (a " +
            "zero-context diff is fine); single-file, no path-traversal. " +
            "LF-only, ≤1 MB.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Human-readable rationale shown to the operator on the " +
            "approval card. Capped at 500 chars (RFC §3.3).",
        },
        target_path: {
          type: "string",
          enum: ["/state/config/switchroom.yaml"],
          description:
            "Must be the literal string '/state/config/switchroom.yaml'. " +
            "Future-proofs against multi-file diffs and gives the validator " +
            "a single canonical path to anchor on.",
        },
      },
    },
  },
  {
    name: "get_status",
    description:
      "Read the most recent terminal `update_apply` audit row " +
      "(channel, pin, resolved_sha, install_context, result, " +
      "exit_code, stderr_tail). Use this after issuing an " +
      "`update_apply` to confirm what actually rolled out, or to " +
      "report the last update on demand. Returns the parsed audit " +
      "entry as JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
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
  // `get_status` reads the audit log directly — no hostd RPC, so it
  // doesn't need SWITCHROOM_AGENT_NAME or the socket. Handle it
  // before the wire-checks below.
  if (name === "get_status") {
    return getLastUpdateApplyStatus();
  }

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
      // Mutual exclusion mirrored from the hostd dispatcher so the
      // MCP layer fails fast with a friendly message instead of
      // round-tripping a `denied`.
      if (args.channel && args.pin) {
        return errorText(
          "update_apply: `channel` and `pin` are mutually exclusive — pass at most one.",
        );
      }
      if (args.pin && !/^(sha-[0-9a-f]{7,40}|v\d+\.\d+\.\d+)$/.test(args.pin)) {
        return errorText(
          `update_apply: pin "${args.pin}" is invalid. Expected sha-<7-40 hex> or v<semver>.`,
        );
      }
      req = {
        v: 1,
        op: "update_apply",
        request_id: makeRequestId("mcp-update-apply"),
        args: {
          ...(args.skip_images ? { skip_images: true } : {}),
          ...(args.rebuild ? { rebuild: true } : {}),
          ...(args.channel ? { channel: args.channel } : {}),
          ...(args.pin ? { pin: args.pin } : {}),
        },
      };
      break;
    }
    case "rollout": {
      // Semver-only pin, rejected at the MCP boundary (fail fast with a
      // friendly message rather than round-tripping a wire-decode error).
      // A sha pin is NOT version-assertable and would stop the roll on
      // agent #1 — so it's rejected here, not just at the daemon.
      if (!args.pin || typeof args.pin !== "string") {
        return errorText("rollout: pin is required (a semver like v0.15.18).");
      }
      if (!ROLLOUT_SEMVER_PIN_RE.test(args.pin)) {
        return errorText(
          `rollout: pin "${args.pin}" is invalid. Must be a tagged semver ` +
            `(vX.Y.Z). SHA pins are rejected — the staggered roll asserts ` +
            `the in-container semver version.`,
        );
      }
      if (
        args.agents !== undefined &&
        (!Array.isArray(args.agents) || args.agents.length === 0)
      ) {
        return errorText(
          "rollout: agents, when provided, must be a non-empty array of " +
            "agent names.",
        );
      }
      req = {
        v: 1,
        op: "rollout",
        request_id: makeRequestId("mcp-rollout"),
        args: {
          pin: args.pin,
          ...(args.agents ? { agents: args.agents } : {}),
          ...(args.skip_web ? { skip_web: true } : {}),
        },
      };
      break;
    }
    case "config_propose_edit": {
      // Argument shape validated here before hitting the wire so the
      // disabled-path response is clearly the daemon's, not a
      // wire-decode rejection.
      if (!args.unified_diff || typeof args.unified_diff !== "string") {
        return errorText(
          "config_propose_edit: unified_diff is required (non-empty string).",
        );
      }
      if (!args.reason || typeof args.reason !== "string") {
        return errorText(
          "config_propose_edit: reason is required (non-empty string, ≤500 chars).",
        );
      }
      if (args.reason.length > 500) {
        return errorText(
          "config_propose_edit: reason is capped at 500 chars (RFC §3.3).",
        );
      }
      if (args.target_path !== "/state/config/switchroom.yaml") {
        return errorText(
          "config_propose_edit: target_path must be '/state/config/switchroom.yaml'.",
        );
      }
      req = {
        v: 1,
        op: "config_propose_edit",
        request_id: makeRequestId("mcp-config-propose-edit"),
        args: {
          unified_diff: args.unified_diff,
          reason: args.reason,
          target_path: "/state/config/switchroom.yaml",
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
      { socketPath: sockPath, timeoutMs: wireTimeoutForOp(req.op) },
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
  const content: { type: "text"; text: string }[] = [
    { type: "text", text: JSON.stringify(resp) },
  ];
  // #1758 Phase 1: when a structured error envelope is present, surface
  // it as a second content item with a leading discriminator hint so
  // the agent can branch on `fix.kind` without re-parsing the legacy
  // `error` string.
  if (resp.error_envelope) {
    const env = resp.error_envelope;
    content.push({
      type: "text",
      text:
        `Structured error — fix.kind=${env.fix?.kind ?? "none"}\n` +
        JSON.stringify(env, null, 2),
    });
  }
  return { content, isError: true };
}

/**
 * Audit-log path resolver for the get_status tool. Honors
 * `HOSTD_AUDIT_LOG_PATH` for test injection; otherwise falls back to
 * the bind-mounted host home (`/host-home/.switchroom/host-control-audit.log`)
 * when present, else the daemon's default-path resolver.
 *
 * Exported so the unit test in src/mcp/hostd/server.test.ts can stub
 * via the same code path.
 */
export function resolveAuditLogPath(): string {
  if (process.env.HOSTD_AUDIT_LOG_PATH) return process.env.HOSTD_AUDIT_LOG_PATH;
  // Admin agents see the host audit log at /host-home/.switchroom/...
  // via the RFC C bind mount (#1337); fall back to defaultAuditLogPath
  // (operator-HOME-relative) when not bind-mounted.
  const bindMounted = "/host-home/.switchroom/host-control-audit.log";
  if (existsSync(bindMounted)) return bindMounted;
  return defaultAuditLogPath();
}

/**
 * Dispatch handler for the `get_status` MCP tool. Reads the audit log
 * and returns the most recent terminal `update_apply` row as JSON. No
 * hostd RPC needed — the audit log is the durable record.
 *
 * Exported for the dispatch-test seam.
 */
export function getLastUpdateApplyStatus(): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const path = resolveAuditLogPath();
  if (!existsSync(path)) {
    return errorText(
      `get_status: audit log not found at ${path}. No update_apply has run yet?`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return errorText(
      `get_status: failed to read audit log at ${path}: ${(err as Error).message}`,
    );
  }
  const lines = raw.split("\n");
  let last: AuditEntry | null = null;
  // Walk backwards — most recent terminal update_apply wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parseAuditLine(lines[i]!);
    if (e && e.op === "update_apply" && e.phase === "terminal") {
      last = e;
      break;
    }
  }
  if (!last) {
    return errorText(
      "get_status: no terminal update_apply rows found in audit log.",
    );
  }
  return jsonText(last);
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
