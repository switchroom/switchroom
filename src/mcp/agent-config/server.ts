/**
 * agent-config MCP shim.
 *
 * Tiny stdio MCP server that exposes read-only + self-service config tools
 * backed by the corresponding `switchroom <cmd>` CLI subcommands. The shim
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

/**
 * Subprocess timeout for the re-exec'd CLI.
 *
 * The write verbs (`schedule add|remove`, skill writes) run the full
 * cron-only reconcile inside the CLI — including the #3333 ownership
 * sweep (measured 8.4s over a 1.1M-inode agent tree) and Hindsight
 * mental-model provisioning — and were measured at 15–19s wall inside a
 * live agent container. The old hardcoded 15s timeout SIGTERM'd the
 * child mid-reconcile: the overlay write had already landed but the CLI
 * died before printing its JSON result (and before its rollback/audit
 * paths could run), so the tool reported `CLI exit 1:` with an empty
 * body for an operation that succeeded on disk (switchroom #4181).
 * Default is deliberately generous; the env knob exists for tests and
 * unusual hosts.
 */
export const CLI_TIMEOUT_MS = (() => {
  const raw = process.env.SWITCHROOM_AGENT_CONFIG_CLI_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
  /** Signal that terminated the child (e.g. SIGTERM on spawnSync
   *  timeout), if any. Upstream `status` is null in that case; we keep
   *  the mapped `1` for backward compat, but callers MUST check
   *  `signal` to distinguish "CLI rejected the op" from "we killed it
   *  mid-flight (the write may have landed)". */
  signal: NodeJS.Signals | null;
  /** Spawn-level failure (ENOENT, EACCES, …), if any. */
  spawnError?: Error;
}

export function execCli(args: string[], stdin?: string): ExecResult {
  const r = spawnSync(CLI_BIN, args, {
    encoding: "utf-8",
    env: process.env,
    timeout: CLI_TIMEOUT_MS,
    ...(stdin !== undefined ? { input: stdin } : {}),
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
    signal: r.signal ?? null,
    spawnError: r.error,
  };
}

/**
 * Format a CLI failure so the message is NEVER empty (#4181 — the old
 * `CLI exit 1: ` with a blank body left callers unable to tell a failed
 * write from a killed-after-success one). Three shapes:
 *   - spawn failure (binary missing etc.) → the spawn error message;
 *   - killed by signal (timeout) → names the signal + timeout budget and
 *     warns that the write may have been applied without confirmation;
 *   - genuine non-zero exit → legacy `CLI exit N: <stderr|stdout>`,
 *     with an explicit placeholder when the child printed nothing.
 */
export function formatCliFailure(cliArgs: string[], r: ExecResult): string {
  const verb = [CLI_BIN, ...cliArgs.slice(0, 2)].join(" ");
  const detail = r.stderr.trim() || r.stdout.trim() || "(no output captured)";
  if (r.spawnError) {
    return `failed to exec \`${verb}\`: ${r.spawnError.message}`;
  }
  if (r.signal) {
    return (
      `\`${verb}\` was killed by ${r.signal} after exceeding the ${CLI_TIMEOUT_MS}ms ` +
      `subprocess timeout — it did not confirm the operation, but the underlying ` +
      `write may still have been applied on disk. Verify current state with the ` +
      `matching read tool (e.g. cron_list / skill_list) before retrying. ` +
      `Output before the kill: ${detail}`
    );
  }
  return `CLI exit ${r.status}: ${detail}`;
}

/**
 * Extract the JSON payload from CLI stdout, tolerating human-oriented
 * progress noise around it. The write verbs' reconcile path prints
 * status lines to stdout both BEFORE the JSON result (the #3333
 * `[ownership-sweep] …` line) and AFTER it (Hindsight `✓ Mental model
 * …` provisioning lines), so a strict whole-buffer JSON.parse fails on
 * a fully successful write (#4181). Strategy: try the whole trimmed
 * buffer first (fast path, preserves multi-line JSON documents), then
 * scan individual lines from the END for the last one that parses —
 * the CLI's own result line is always emitted as a single line.
 */
export function parseJsonPayload(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to line scan */
  }
  const lines = t.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep scanning */
    }
  }
  throw new Error("no JSON payload found in CLI stdout");
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
  // schedule_add cheap-cron tier hints
  model?: string;
  context?: string;
  // skill_install (#1163 Phase 2)
  source?: string;
  // peers_list
  include_self?: boolean;
  // skill_{init,edit}_personal (#1819 PR-3) — file map for the bundle
  files?: Record<string, string>;
  // skill_search (#1819 Phase 3)
  query?: string;
  tier?: string;
  // (`source?: string` for skill_install + skill_clone_to_personal is
  // declared above.)
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
    name: "whoami",
    description:
      "See your own sandbox: the tools, MCP servers, vault key-NAMES (never " +
      "values), skills, schedule and privileges (admin/root/config-edit) you " +
      "actually have, as JSON — computed from live enforcement. Call this " +
      "FIRST when you hit a permission wall, instead of guessing or asking. " +
      "Read-only; defaults to your own identity.",
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
      "List the agent's scheduled cron entries (schedule array) as JSON. " +
      "Each entry is self-describing: `source` (base-config vs overlay), " +
      "`file` (switchroom.yaml or the schedule.d path), resolved " +
      "`tier`/`context`, and a `duplicate_of` back-reference when another " +
      "entry shares the same cron expression. Original entry fields are " +
      "preserved.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string" },
      },
    },
  },
  {
    name: "cron_doctor",
    description:
      "Read-only cron health report: duplicate cron expressions (the " +
      "double-fire hazard), base-config-vs-overlay name conflicts, and " +
      "entries missing a resolved tier/context. Returns " +
      "{agent, entry_count, healthy, findings[]}. Call this BEFORE adding " +
      "a cron, or when a schedule misbehaves (firing twice, removing the " +
      "wrong entry).",
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
      "Append a cron schedule entry to your overlay. Takes effect within ~30s — " +
      "the scheduler hot-reloads, no restart needed. Overlay entries with " +
      "non-empty `secrets:` are REJECTED (E_OVERLAY_SECRETS_REQUIRES_APPROVAL). " +
      "COST: a FREQUENT cron (every <=60min) is already auto-routed to a cheap, " +
      "minimal-context cron session (Tier 1) by default; a DAILY/WEEKLY cron runs " +
      "as a full turn in your live session (Tier 2). Set `model: \"sonnet\"` / " +
      "`context: \"fresh\"` to force the cheap session for a self-contained " +
      "daily/weekly job, or `context: \"agent\"` to keep a fire on your full " +
      "session when it needs your accumulated context. CHEAPER STILL (request " +
      "from the operator — you can't self-author these): a `kind: action` runs a " +
      "FIXED post/webhook MODEL-FREE (zero tokens, no session) for a set " +
      "reminder/ping; a `kind: poll` or reaction-dispatch handles 'only act when " +
      "X changes' without a wasted turn each tick.",
    inputSchema: {
      type: "object" as const,
      required: ["cron_expr", "prompt"],
      properties: {
        cron_expr: { type: "string" },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "The inbound turn YOU receive when this cron fires — not a message " +
            "sent to the user. Phrase it from your future-self's perspective " +
            "(\"Time for the daily digest — pull yesterday's GitHub activity and " +
            "DM the summary to chat 12345\"), not as a request to you (\"please " +
            "send the digest\"). Include any ids/context that future turn will " +
            "need, since a Tier-1 fire has no conversation context.",
        },
        secrets: { type: "array", items: { type: "string" } },
        name: { type: "string", pattern: "^[a-z0-9-]{1,40}$" },
        model: {
          type: "string",
          description:
            "Optional cheap-cron tier hint. A known-cheap model ('sonnet'/'haiku') " +
            "routes this fire to a fresh, minimal-context cron session (Tier 1) " +
            "instead of your full live session (Tier 2) — cheaper per fire. Omit " +
            "for context-heavy work that needs your accumulated conversation " +
            "context (a frequent cron is already Tier-1 by default; this is mainly " +
            "to make a daily/weekly self-contained job cheap too).",
        },
        context: {
          type: "string",
          enum: ["fresh", "agent"],
          description:
            "Tier hint: 'fresh' = minimal-context cheap session (Tier 1); 'agent' " +
            "= your full live session (Tier 2). Usually inferred from `model`.",
        },
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
  // #1819 Phase 3 — read-only enumeration across all tiers.
  {
    name: "skill_search",
    description:
      "Enumerate skills the calling agent can see, across three tiers: " +
      "`personal` (own .claude/skills/personal-* workspace), `shared` " +
      "(operator-curated pool at ~/.switchroom/skills/), `bundled` " +
      "(shipped with switchroom). Read-only — no approval, no write, no " +
      "fleet exposure. Returns SKILL.md frontmatter + path + size + " +
      "mtime per match, with stable sort (personal → shared → bundled, " +
      "then name). Use this BEFORE authoring a new skill — odds are it " +
      "exists already, possibly in bundled.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Case-insensitive substring match against name, description, jtbd.",
        },
        tier: {
          type: "string",
          enum: ["personal", "shared", "bundled", "any"],
          description: "Filter to one tier; default `any`.",
        },
        limit: {
          type: "number",
          description: "Cap result count (default 50, max 500).",
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
  // PR-3 (#1819) — personal-skill authoring ops. Each agent has a
  // writable workspace at `<agentDir>/.claude/skills/personal-<name>/`;
  // no operator approval required (agent's own files).
  {
    name: "skill_init_personal",
    description:
      "Create a personal skill in this agent's writable workspace " +
      "(`<agentDir>/.claude/skills/personal-<name>/`). Multi-file " +
      "payload via `files: {path: content}`. Validates against the " +
      "same gates an operator-driven `switchroom skill apply` would " +
      "— name regex, path allowlist, SKILL.md frontmatter, bundle " +
      "size, banned-headless-phrase content scan, bash -n / py_compile. " +
      "No operator approval — agent owns its workspace.",
    inputSchema: {
      type: "object" as const,
      required: ["name", "files"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
          description: "Skill slug (becomes the dir name `personal-<slug>`).",
        },
        files: {
          type: "object",
          description:
            "Multi-file payload — keys are relative paths under the skill " +
            "dir (must match the SKILL.md allowlist: SKILL.md, README.md, " +
            "scripts/*.{sh,py}, assets/..., reference/*.md). Values are " +
            "the file contents (strings).",
        },
      },
    },
  },
  {
    name: "skill_edit_personal",
    description:
      "Overwrite an existing personal skill. Same gates as " +
      "skill_init_personal. Fails if the skill doesn't already exist " +
      "(use skill_init_personal first).",
    inputSchema: {
      type: "object" as const,
      required: ["name", "files"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
          description: "Skill slug to overwrite.",
        },
        files: {
          type: "object",
          description: "Multi-file payload (see skill_init_personal).",
        },
      },
    },
  },
  {
    name: "skill_remove_personal",
    description:
      "Soft-remove a personal skill. The dir moves to " +
      "`<agentDir>/.claude/skills-trash/<name>-<unix-ts>/` for 24h " +
      "recovery. Lazy sweep on next personal-skill op deletes " +
      "entries older than 24h.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
          description: "Skill slug to remove.",
        },
      },
    },
  },
  {
    name: "skill_list_personal",
    description:
      "List personal skills owned by this agent. Returns name, on-disk " +
      "path, file count, and total bytes per skill. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "skill_clone_to_personal",
    description:
      "Fork a shared or bundled skill into this agent's writable workspace. " +
      "Use when you find a defect or gap in a skill you depend on and want " +
      "to fix it yourself — the upstream source is untouched, your fork is " +
      "yours to edit via `skill_edit_personal`. Source format: " +
      "`shared:<name>` or `bundled:<name>`. Same validation gates as " +
      "init/edit. Pre-existing personal-<name> is refused (use edit or " +
      "remove first). No operator approval.",
    inputSchema: {
      type: "object" as const,
      required: ["source"],
      properties: {
        source: {
          type: "string",
          pattern: "^(shared|bundled):[a-z0-9][a-z0-9_-]{0,62}$",
          description:
            "Source skill: `shared:<name>` (operator pool) or `bundled:<name>` (shipped).",
        },
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
          description:
            "Optional destination slug (defaults to the source slug).",
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
  let stdinJson: string | undefined; // PR-3: piped to skill_*_personal ops
  switch (name) {
    case "config_get":
      cliArgs = buildArgs(["config", "get"], args);
      parseMode = "json";
      break;
    case "whoami":
      cliArgs = buildArgs(["config", "whoami"], args);
      parseMode = "json";
      break;
    case "cron_list":
      cliArgs = buildArgs(["cron", "list"], args);
      parseMode = "json";
      break;
    case "cron_doctor":
      cliArgs = buildArgs(["cron", "doctor"], args);
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
      if (a.model) base.push("--model", a.model);
      if (a.context) base.push("--context", a.context);
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
    // PR-3 (#1819) — personal-skill ops. Each routes to the CLI verb
    // which writes to the agent's writable workspace; no operator
    // approval surface. The `files` JSON map is passed via stdin (the
    // execCli wrapper passes the calling context's stdin through).
    case "skill_init_personal":
    case "skill_edit_personal": {
      const a = args as ToolArgs;
      if (!a.name || typeof a.name !== "string") {
        return errorText(`${name}: name is required`);
      }
      if (!a.files || typeof a.files !== "object" || Array.isArray(a.files)) {
        return errorText(`${name}: files object is required`);
      }
      const verb = name === "skill_init_personal" ? "init-personal" : "edit-personal";
      const base = ["skill", verb, a.name as string];
      if (a.agent) base.push("--agent", a.agent as string);
      cliArgs = base;
      parseMode = "json";
      // Stash the files JSON for execCli to pipe to stdin.
      stdinJson = JSON.stringify(a.files);
      break;
    }
    case "skill_remove_personal": {
      const a = args as ToolArgs;
      if (!a.name) {
        return errorText("skill_remove_personal: name is required");
      }
      const base = ["skill", "remove-personal", a.name as string];
      if (a.agent) base.push("--agent", a.agent as string);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    case "skill_list_personal": {
      const a = args as ToolArgs;
      const base = ["skill", "list-personal"];
      if (a.agent) base.push("--agent", a.agent as string);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    // PR-4 (#1819 Phase 3) — read-only enumeration across all tiers.
    case "skill_search": {
      const a = args as ToolArgs;
      const base = ["skill", "search"];
      if (a.agent) base.push("--agent", a.agent);
      if (a.query) base.push("--query", a.query);
      if (a.tier) base.push("--tier", a.tier);
      if (typeof a.limit === "number") base.push("--limit", String(a.limit));
      cliArgs = base;
      parseMode = "json";
      break;
    }
    // Clone a shared or bundled skill into the agent's personal tier.
    case "skill_clone_to_personal": {
      const a = args as ToolArgs;
      if (!a.source || typeof a.source !== "string") {
        return errorText("skill_clone_to_personal: source is required");
      }
      const base = ["skill", "clone-to-personal", a.source];
      if (a.agent) base.push("--agent", a.agent);
      if (a.name) base.push("--name", a.name);
      cliArgs = base;
      parseMode = "json";
      break;
    }
    default:
      return errorText(`unknown tool: ${name}`);
  }

  const r = execCli(cliArgs, stdinJson);
  if (r.status !== 0 || r.signal || r.spawnError) {
    return errorText(formatCliFailure(cliArgs, r));
  }
  try {
    if (parseMode === "json") {
      const data = parseJsonPayload(r.stdout);
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
