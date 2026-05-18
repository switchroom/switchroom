/**
 * `switchroom config|cron|skill|audit` subcommands — the read-only
 * "agent-config-broker" CLI surface that backs the per-agent MCP shim
 * (see `src/mcp/agent-config/server.ts`).
 *
 * Design (env-pinned identity inside containers; explicit operator flag
 * on the host):
 *   The agent's own container process runs `switchroom <cmd>` and its
 *   identity is taken from `$SWITCHROOM_AGENT_NAME` (scaffold sets this
 *   per agent). All commands here refuse to read across agents — if
 *   `--agent` is passed and doesn't match the env, exit 7. Inside a
 *   container, a MISSING env var is also a denial — an env var alone is
 *   not a security boundary, so we will not fall through to "operator
 *   may read any agent" when there's no proof we're on the host. The
 *   operator context is gated on running OUTSIDE the container (no
 *   `/.dockerenv`, no `SWITCHROOM_CONTAINER=1`).
 *
 *   Every invocation appends one JSON line to
 *   `~/.switchroom/audit/agent-config.jsonl` so we can trace which agent
 *   asked for what, when. Append-only, no rotation yet (TODO).
 */

import type { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { withConfigError, getConfig } from "./helpers.js";
import type { SwitchroomConfig } from "../config/schema.js";

// Per-agent audit path. We deliberately do NOT share one log file across
// all agents — that would let any agent read every other agent's audit
// trail when the dir is bind-mounted into containers. Each agent gets
// its own dir at ~/.switchroom/audit/<agent>/, and scaffold mounts only
// the agent's own dir into its container (not the parent).
const AUDIT_ROOT = join(homedir(), ".switchroom", "audit");
export function auditPathFor(agent: string): string {
  return join(AUDIT_ROOT, agent, "agent-config.jsonl");
}

export interface AuditRow {
  ts: string;
  agent: string;
  cmd: string;
  args: Record<string, unknown>;
  exit: number;
  peer_uid: number;
}

/**
 * Append one audit row. Uses O_APPEND (Node's `appendFileSync` default)
 * so concurrent writers don't tear lines. No rotation yet — the file
 * will grow unbounded until we add it. TODO: rotate at 10 MB.
 */
export function appendAudit(
  agent: string,
  cmd: string,
  args: Record<string, unknown>,
  exit: number,
  opts: { auditPath?: string } = {},
): void {
  const row: AuditRow = {
    ts: new Date().toISOString(),
    agent,
    cmd,
    args,
    exit,
    peer_uid: typeof process.getuid === "function" ? process.getuid() : -1,
  };
  const path = opts.auditPath ?? auditPathFor(agent);
  const dir = path.slice(0, path.lastIndexOf("/"));
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(path, JSON.stringify(row) + "\n", { flag: "a" });
  } catch {
    // Audit must never block a read. A full / unwritable
    // ~/.switchroom/audit is an operator problem, not the agent's.
  }
}

/**
 * Detect whether we're running inside an agent container. Used to deny
 * "operator-context" fallthrough when the identity env var is missing —
 * an in-container process could unset SWITCHROOM_AGENT_NAME, so we
 * cannot trust its absence as proof of operator context.
 */
export function isContainerContext(
  env: NodeJS.ProcessEnv = process.env,
  opts: { dockerEnvPath?: string } = {},
): boolean {
  if (env.SWITCHROOM_CONTAINER === "1") return true;
  const probe = opts.dockerEnvPath ?? "/.dockerenv";
  try {
    if (existsSync(probe)) return true;
  } catch {
    // ignore — treat probe failure as not-in-container
  }
  return false;
}

/**
 * Determine the target agent for a request and reject cross-agent
 * reads. Returns the resolved agent name, or throws on a denial that
 * the caller should surface as exit 7.
 *
 * Inside a container, a missing env var is a denial — not a fall-
 * through to operator context. On the host, the operator must pass
 * `--agent` explicitly.
 */
export function resolveTargetAgent(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: { dockerEnvPath?: string } = {},
): string {
  const fromEnv = env.SWITCHROOM_AGENT_NAME;
  const inContainer = isContainerContext(env, opts);

  if (!fromEnv) {
    if (inContainer) {
      // Container context with no env-pinned identity. The scaffold-
      // wired MCP shim always sets SWITCHROOM_AGENT_NAME; a process
      // that reaches us without it is either misconfigured or
      // probing. Deny.
      throw new Error(
        "agent identity missing in container context: refuse to serve",
      );
    }
    // Host / operator context — must pass --agent explicitly.
    if (!requested) {
      throw new Error(
        "agent name required (pass --agent, or set SWITCHROOM_AGENT_NAME)",
      );
    }
    return requested;
  }
  // Agent context — env-pinned identity. --agent must match or be
  // absent; cross-agent reads are denied.
  if (requested && requested !== fromEnv) {
    throw new Error(
      `cross-agent read denied: env agent "${fromEnv}" cannot read config for "${requested}"`,
    );
  }
  return fromEnv;
}

/**
 * Recursively walk a config slice and drop any `secrets` values
 * (keeping the keys but blanking values) so we never leak vault refs
 * through the MCP shim. Current schema makes `secrets` a list of key
 * names (no values), so this is mostly defensive: if a future schema
 * surfaces a `secrets:` map with values, we still won't leak it.
 */
export function stripSecretValues<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecretValues(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "secrets") {
        // List of key names → keep as-is (the schema already disallows
        // values). Object with values → mask to null.
        if (Array.isArray(v)) {
          out[k] = v;
        } else if (v && typeof v === "object") {
          const masked: Record<string, unknown> = {};
          for (const sk of Object.keys(v as Record<string, unknown>)) {
            masked[sk] = null;
          }
          out[k] = masked;
        } else {
          out[k] = v;
        }
      } else {
        out[k] = stripSecretValues(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Human-readable readback appended to every overlay write that lands
 * on disk but is NOT live in the running agent. claude-code reads
 * skills, `.mcp.json` and (post cron-fold-in) the in-container
 * scheduler's entries at PROCESS START — see
 * `lifecycle.ts:classifyChangeKind` ("settings"/"skill" are
 * restart-required; skill hot-reload is unbuilt Phase C). Without this
 * line a self-service `skill_install` / `schedule add` returns
 * `{ok:true}` and the change silently does nothing until the next
 * bounce. Same wording across skill + schedule by design (consistency
 * principle).
 */
export function restartRequiredNote(agent: string): string {
  return (
    `Not live yet — claude loads skills, MCP servers and scheduled ` +
    `tasks at process start. Run \`switchroom agent restart ${agent}\` ` +
    `for this to take effect.`
  );
}

function getAgentSlice(config: SwitchroomConfig, agent: string): unknown {
  const slice = config.agents?.[agent];
  if (!slice) {
    throw new Error(`agent "${agent}" not defined in switchroom.yaml`);
  }
  return slice;
}

/** Read & filter the audit log for one agent. */
export function readAuditTail(
  agent: string,
  limit: number,
  opts: { auditPath?: string } = {},
): AuditRow[] {
  const path = opts.auditPath ?? auditPathFor(agent);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const rows: AuditRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditRow;
      if (parsed.agent === agent) rows.push(parsed);
    } catch {
      // Skip malformed lines — audit log is best-effort.
    }
  }
  const cap = Math.max(1, Math.min(100, limit));
  return rows.slice(-cap);
}

export function registerAgentConfigCommands(program: Command): void {
  // switchroom config get
  const config = program
    .command("config")
    .description("Read-only access to an agent's merged config slice");
  config
    .command("get")
    .description("Emit the agent's merged config slice as JSON")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(
      withConfigError(async (opts: { agent?: string }) => {
        let agent: string;
        try {
          agent = resolveTargetAgent(opts.agent);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(opts.agent ?? "<unknown>", "config.get", { ...opts }, 7);
          process.exit(7);
        }
        const cfg = getConfig(program);
        try {
          const slice = stripSecretValues(getAgentSlice(cfg, agent));
          process.stdout.write(JSON.stringify(slice) + "\n");
          appendAudit(agent, "config.get", { ...opts }, 0);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(agent, "config.get", { ...opts }, 1);
          process.exit(1);
        }
      }),
    );

  // switchroom cron list
  const cron = program
    .command("cron")
    .description("Read-only access to an agent's cron schedule");
  cron
    .command("list")
    .description("List the agent's scheduled cron entries as JSON")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(
      withConfigError(async (opts: { agent?: string }) => {
        let agent: string;
        try {
          agent = resolveTargetAgent(opts.agent);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(opts.agent ?? "<unknown>", "cron.list", { ...opts }, 7);
          process.exit(7);
        }
        const cfg = getConfig(program);
        try {
          const slice = getAgentSlice(cfg, agent) as { schedule?: unknown[] };
          const tasks = stripSecretValues(slice.schedule ?? []);
          process.stdout.write(JSON.stringify(tasks) + "\n");
          appendAudit(agent, "cron.list", { ...opts }, 0);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(agent, "cron.list", { ...opts }, 1);
          process.exit(1);
        }
      }),
    );

  // switchroom skill list
  const skill = program
    .command("skill")
    .description("Read-only access to an agent's skill list");
  skill
    .command("list")
    .description("List the agent's configured skills as JSON")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(
      withConfigError(async (opts: { agent?: string }) => {
        let agent: string;
        try {
          agent = resolveTargetAgent(opts.agent);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(opts.agent ?? "<unknown>", "skill.list", { ...opts }, 7);
          process.exit(7);
        }
        const cfg = getConfig(program);
        try {
          const slice = getAgentSlice(cfg, agent) as {
            skills?: string[];
            bundled_skills?: Record<string, boolean>;
          };
          const out = {
            skills: slice.skills ?? [],
            bundled_skills: slice.bundled_skills ?? {},
            // PR A of agent-skill-authoring: agents can author into their
            // own .claude/skills/<slug>/. Global scope (operator-owned
            // bundled pool) comes in PR B.
            editable_scopes: ["agent"] as string[],
          };
          process.stdout.write(JSON.stringify(out) + "\n");
          appendAudit(agent, "skill.list", { ...opts }, 0);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(agent, "skill.list", { ...opts }, 1);
          process.exit(1);
        }
      }),
    );

  // switchroom peers list
  const peers = program
    .command("peers")
    .description(
      "Read-only listing of peer agents on this switchroom instance. " +
      "Live-sourced from switchroom.yaml — never cached. The agent's " +
      "own name is excluded when called from a container context.",
    );
  peers
    .command("list")
    .description(
      "Emit every other agent on this instance as JSON: " +
      "[{name, purpose}]. `purpose` falls back to `topic_name` when " +
      "the agent has no explicit `purpose:` set. Caller (env-pinned " +
      "agent) is excluded from results so an agent never lists itself.",
    )
    .option("--agent <name>", "Caller identity (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--include-self", "Include the calling agent in the result (default: exclude)")
    .action(
      withConfigError(async (opts: { agent?: string; includeSelf?: boolean }) => {
        let self: string | null;
        try {
          // Three contexts:
          //   1. Container with $SWITCHROOM_AGENT_NAME set — env-pinned
          //      identity; resolveTargetAgent enforces "no --agent
          //      cross-read".
          //   2. Container with NO env set — denied. We must not fall
          //      through to "operator: list all" here because a
          //      misconfigured / probing in-container caller would
          //      bypass the cross-agent gate that protects every
          //      other agent-config verb. The container probe
          //      (/.dockerenv OR SWITCHROOM_CONTAINER=1) detects this.
          //   3. Host with no env (operator running the CLI directly).
          //      switchroom.yaml is already on disk and operator-
          //      readable, so listing every agent is not a new leak —
          //      we just pass through with self = null.
          if (!opts.agent && !process.env.SWITCHROOM_AGENT_NAME) {
            if (isContainerContext()) {
              throw new Error(
                "agent identity missing in container context: refuse to serve",
              );
            }
            self = null;
          } else {
            self = resolveTargetAgent(opts.agent);
          }
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(opts.agent ?? "<unknown>", "peers.list", { ...opts }, 7);
          process.exit(7);
        }
        const cfg = getConfig(program);
        const agentsMap = (cfg.agents ?? {}) as Record<
          string,
          { purpose?: string; topic_name?: string; admin?: boolean }
        >;
        const out: { name: string; purpose: string; admin: boolean }[] = [];
        for (const [name, slice] of Object.entries(agentsMap)) {
          if (self && name === self && !opts.includeSelf) continue;
          const purpose = (slice.purpose ?? slice.topic_name ?? "").toString();
          out.push({ name, purpose, admin: slice.admin === true });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        process.stdout.write(JSON.stringify(out) + "\n");
        appendAudit(self ?? "<operator>", "peers.list", { ...opts }, 0);
      }),
    );

  // switchroom audit tail
  const audit = program
    .command("audit")
    .description("Read-only access to the agent-config audit log");
  audit
    .command("tail")
    .description("Tail recent agent-config audit-log entries as JSONL")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--limit <n>", "Max rows (default 20, max 100)", "20")
    .action(
      async (opts: { agent?: string; limit: string }) => {
        let agent: string;
        try {
          agent = resolveTargetAgent(opts.agent);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(opts.agent ?? "<unknown>", "audit.tail", { ...opts }, 7);
          process.exit(7);
        }
        const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
        const rows = readAuditTail(agent, limit);
        for (const r of rows) {
          process.stdout.write(JSON.stringify(r) + "\n");
        }
        appendAudit(agent, "audit.tail", { limit }, 0);
      },
    );
}
