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
 *   peers_list  → `switchroom peers list [--agent <n>]`  (live-sourced)
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

/** PR A: like `execCli` but pipes `stdin` text in for skill create/edit
 *  bodies that are too large for argv.
 *
 *  Timeout: 30s (vs. execCli's 15s). The stdin path handles up to 2 MiB
 *  skill bundles, and on a loaded box the JSON.parse + per-file
 *  validation + atomic temp-dir + per-component lstat walk + fsync on
 *  rename can chew through more than 15s before the CLI exits cleanly.
 *  We'd rather wait than spuriously kill a legitimate skill_create. */
export function spawnSyncWithStdin(args: string[], stdin: string): ExecResult {
  const r = spawnSync(CLI_BIN, args, {
    encoding: "utf-8",
    env: process.env,
    timeout: 30000,
    input: stdin,
    maxBuffer: 8 * 1024 * 1024,
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
  cron_expr?: string;
  prompt?: string;
  secrets?: string[];
  name?: string;
  cron_hash?: string;
  // skill_install (#1163 Phase 2)
  source?: string;
  // peers_list
  include_self?: boolean;
  // skill_create / skill_edit / skill_read / skill_delete (PR A)
  files?: Record<string, string>;
  file?: string;
  content?: string;
  version?: string;
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
    name: "schedule_add",
    description:
      "Append a cron schedule entry to the agent's overlay dir. " +
      "Overlay-sourced entries with non-empty `secrets:` are REJECTED " +
      "(E_OVERLAY_SECRETS_REQUIRES_APPROVAL); operator-authored entries " +
      "in switchroom.yaml are unaffected.",
    inputSchema: {
      type: "object" as const,
      required: ["cron_expr", "prompt"],
      properties: {
        cron_expr: { type: "string" },
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        secrets: { type: "array", items: { type: "string" } },
        name: { type: "string", pattern: "^[a-z0-9-]{1,40}$" },
      },
    },
  },
  {
    name: "schedule_remove",
    description:
      "Remove an overlay-managed schedule entry by `name` or 12-hex `cron_hash`. " +
      "Exactly one of `name` or `cron_hash` is required (enforced at runtime in scheduleRemove()).",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        cron_hash: { type: "string", pattern: "^[a-f0-9]{12}$" },
      },
    },
  },
  {
    name: "peers_list",
    description:
      "List every OTHER switchroom agent on this instance as JSON: " +
      "[{name, purpose, admin}]. Live-sourced from switchroom.yaml at " +
      "every call — never cache or memorize the fleet. `purpose` " +
      "falls back to the agent's `topic_name` if no explicit purpose " +
      "is set. `admin: true` means that peer can run fleet-management " +
      "operations (read other agents' logs, exec into containers, " +
      "restart/update). Use this whenever a user asks 'who else is " +
      "here', 'is there an agent that does X', 'which bot handles Y', " +
      "or 'which agent can do <admin op>'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        include_self: {
          type: "boolean",
          description: "Include the caller in the result. Default: false.",
        },
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
  // #1163 Phase 2 — skill self-service.
  {
    name: "skill_install",
    description:
      "Install a skill into the agent's overlay (#1163 Phase 2). " +
      "v1 source allow-list: `bundled:<name>` only — the named skill " +
      "must already exist in the bundled-skills pool on the host. " +
      "git+https://...@<pinned-sha> sources are designed but deferred " +
      "to a follow-up; `file://` / `local-path:` are rejected. After " +
      "successful install, the agent's `.claude/skills/<name>` symlink " +
      "is created automatically via reconcile, no agent restart " +
      "required. Skill quota: 20 per agent.",
    inputSchema: {
      type: "object" as const,
      required: ["source"],
      properties: {
        source: {
          type: "string",
          description:
            "Source descriptor. v1: `bundled:<skill-name>` (the bundled " +
            "skill must exist in the host's skills pool).",
        },
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
          description:
            "Optional override slug (defaults to the skill name from source).",
        },
      },
    },
  },
  {
    name: "skill_remove",
    description:
      "Remove an overlay-installed skill by slug. The agent's " +
      "`.claude/skills/<name>` symlink is removed on next reconcile. " +
      "Does NOT affect operator-installed skills listed directly in " +
      "switchroom.yaml — those are removed by the operator only.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
          description: "Slug passed at install time.",
        },
      },
    },
  },
  // ── PR A: agent-scope skill authoring ──────────────────────────────
  {
    name: "skill_create",
    description:
      "Create an agent-scope skill (scope=agent) at " +
      "`~/.switchroom/agents/<agent>/.claude/skills/<slug>/`. Atomic " +
      "temp-dir → rename — refuses if the target slug dir already " +
      "exists. The `files` arg is a map of skill-relative path → " +
      "string content; MUST include `SKILL.md` with valid YAML " +
      "frontmatter (`name:` matching the slug, `description:` 1..1024 " +
      "chars). Path allowlist: SKILL.md, README.md, scripts/*.{sh,py}, " +
      "assets/*, reference/*.md (max depth 3). Limits: 256 KiB per file, " +
      "2 MiB per skill, 50 files per skill. Refused from cron-fired " +
      "turns (E_SKILL_AUTHOR_REQUIRES_INTERACTIVE). Error codes: " +
      "E_SKILL_INVALID_NAME, E_SKILL_INVALID_PATH, " +
      "E_SKILL_INVALID_FRONTMATTER, E_SKILL_FILE_TOO_LARGE, " +
      "E_SKILL_BUNDLE_TOO_LARGE, E_SKILL_ALREADY_EXISTS, " +
      "E_SKILL_AUTHOR_REQUIRES_INTERACTIVE, E_SKILL_SCOPE_DENIED.",
    inputSchema: {
      type: "object" as const,
      required: ["name", "files"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Map of skill-relative path → file content. Must include SKILL.md.",
        },
        agent: { type: "string" },
      },
    },
  },
  {
    name: "skill_edit",
    description:
      "Edit a single file within an existing agent-scope skill " +
      "(scope=agent). Atomic single-file write. Requires `version` (an " +
      "opaque token returned by `skill_read`) for optimistic " +
      "concurrency — mismatch returns E_SKILL_VERSION_STALE. Token is " +
      "per-skill, not per-file — any change anywhere in the skill bumps " +
      "it. Re-read (via `skill_read`) before retrying on " +
      "E_SKILL_VERSION_STALE. If " +
      "editing SKILL.md, frontmatter is re-validated. Path allowlist " +
      "and 256 KiB / 2 MiB / 50-file limits enforced. Refused from " +
      "cron-fired turns. Error codes: E_SKILL_NOT_FOUND, " +
      "E_SKILL_INVALID_PATH, E_SKILL_INVALID_NAME, " +
      "E_SKILL_INVALID_FRONTMATTER, E_SKILL_VERSION_STALE, " +
      "E_SKILL_FILE_TOO_LARGE, E_SKILL_BUNDLE_TOO_LARGE, " +
      "E_SKILL_AUTHOR_REQUIRES_INTERACTIVE, E_SKILL_SCOPE_DENIED.",
    inputSchema: {
      type: "object" as const,
      required: ["name", "file", "content", "version"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" },
        file: { type: "string" },
        content: { type: "string" },
        version: { type: "string" },
        agent: { type: "string" },
      },
    },
  },
  {
    name: "skill_read",
    description:
      "Read a file from an agent-scope skill, OR (when `file` is " +
      "omitted) return the skill's file tree plus its SKILL.md " +
      "frontmatter. Always returns a `version` token suitable for a " +
      "subsequent `skill_edit` call. Symlinks are refused for safety. " +
      "Error codes: E_SKILL_NOT_FOUND, E_SKILL_INVALID_PATH, " +
      "E_SKILL_INVALID_NAME, E_SKILL_SCOPE_DENIED.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" },
        file: { type: "string" },
        agent: { type: "string" },
      },
    },
  },
  {
    name: "skill_delete",
    description:
      "Delete an agent-scope skill dir (scope=agent). Refuses if the " +
      "path is a symlink (that's a bundled-skill install — use " +
      "`skill_remove` instead). Refused from cron-fired turns. Error " +
      "codes: E_SKILL_NOT_FOUND, E_SKILL_INVALID_PATH, " +
      "E_SKILL_INVALID_NAME, E_SKILL_AUTHOR_REQUIRES_INTERACTIVE, " +
      "E_SKILL_SCOPE_DENIED.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" },
        agent: { type: "string" },
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
    case "peers_list": {
      const base = ["peers", "list"];
      if (args.include_self) base.push("--include-self");
      cliArgs = base;
      parseMode = "json";
      break;
    }
    case "schedule_add": {
      const a = args as ToolArgs;
      if (!a.cron_expr || !a.prompt) {
        return errorText("schedule_add: cron_expr and prompt are required");
      }
      // MCP path: stage instead of hard-reject when a security gate
      // trips. The operator approves from the host CLI (`switchroom
      // schedule pending commit <stage_id>`) or — once #1163 Phase 2
      // lands the card — from Telegram.
      const base = [
        "schedule",
        "add",
        "--cron",
        a.cron_expr,
        "--prompt",
        a.prompt,
        "--stage-on-reject",
      ];
      if (a.agent) base.push("--agent", a.agent);
      if (a.name) base.push("--name", a.name);
      if (a.secrets && a.secrets.length > 0) base.push("--secrets", a.secrets.join(","));
      cliArgs = base;
      parseMode = "json";
      break;
    }
    case "schedule_remove": {
      const a = args as ToolArgs;
      const base = ["schedule", "remove"];
      if (a.agent) base.push("--agent", a.agent);
      if (a.name) base.push("--name", a.name);
      if (a.cron_hash) base.push("--cron-hash", a.cron_hash);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    case "skill_install": {
      const a = args as ToolArgs;
      if (!a.source) {
        return errorText("skill_install: source is required");
      }
      const base = ["skill", "install", "--source", a.source as string];
      if (a.agent) base.push("--agent", a.agent);
      if (a.name) base.push("--name", a.name);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    case "skill_remove": {
      const a = args as ToolArgs;
      if (!a.name) {
        return errorText("skill_remove: name is required");
      }
      const base = ["skill", "remove", "--name", a.name as string];
      if (a.agent) base.push("--agent", a.agent);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    // ── PR A: skill authoring ─────────────────────────────────────────
    case "skill_create": {
      const a = args as ToolArgs;
      if (!a.name) return errorText("skill_create: name is required");
      if (!a.files || typeof a.files !== "object") {
        return errorText("skill_create: files map is required");
      }
      const base = ["skill", "create", "--name", a.name, "--from-stdin"];
      if (a.agent) base.push("--agent", a.agent);
      const r = spawnSyncWithStdin(base, JSON.stringify(a.files));
      if (r.status !== 0) {
        return errorText(
          `CLI exit ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      try {
        return jsonText(JSON.parse(r.stdout.trim() || "null"));
      } catch (err) {
        return errorText(`failed to parse CLI output: ${(err as Error).message}`);
      }
    }
    case "skill_edit": {
      const a = args as ToolArgs;
      if (!a.name || !a.file || a.content == null || !a.version) {
        return errorText(
          "skill_edit: name, file, content, and version are required",
        );
      }
      const base = [
        "skill", "edit",
        "--name", a.name,
        "--file", a.file,
        "--version", a.version,
        "--from-stdin",
      ];
      if (a.agent) base.push("--agent", a.agent);
      const r = spawnSyncWithStdin(base, a.content);
      if (r.status !== 0) {
        return errorText(
          `CLI exit ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      try {
        return jsonText(JSON.parse(r.stdout.trim() || "null"));
      } catch (err) {
        return errorText(`failed to parse CLI output: ${(err as Error).message}`);
      }
    }
    case "skill_read": {
      const a = args as ToolArgs;
      if (!a.name) return errorText("skill_read: name is required");
      const base = ["skill", "read", "--name", a.name];
      if (a.file) base.push("--file", a.file);
      if (a.agent) base.push("--agent", a.agent);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    case "skill_delete": {
      const a = args as ToolArgs;
      if (!a.name) return errorText("skill_delete: name is required");
      const base = ["skill", "delete", "--name", a.name];
      if (a.agent) base.push("--agent", a.agent);
      cliArgs = base;
      parseMode = "json";
      break;
    }
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
