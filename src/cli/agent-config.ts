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
import { resolveAgentConfig } from "../config/merge.js";
import { checkAclByAgent } from "../vault/broker/acl.js";

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

/**
 * Schedule-specific liveness note. Since #2293 the in-agent scheduler
 * HOT-RELOADS the schedule.d overlay (default on; `SWITCHROOM_SCHEDULER_HOT_RELOAD=0`
 * freezes it), so a schedule add/remove takes effect within ~30s with NO
 * restart — unlike skills/MCP, which still load at boot. Kept distinct
 * from {@link restartRequiredNote} so the agent gets accurate guidance and
 * doesn't pointlessly bounce itself. The env read mirrors `isHotReloadEnabled`
 * in src/agent-scheduler/index.ts (kept inline to avoid pulling node-cron
 * into the CLI bundle).
 */
export function scheduleRestartRequired(): boolean {
  // Hot-reload on (default) ⇒ no restart. Only `=0` (frozen-at-boot) requires one.
  return (process.env.SWITCHROOM_SCHEDULER_HOT_RELOAD ?? "") === "0";
}

export function scheduleLiveNote(agent: string): string {
  const hotReload = (process.env.SWITCHROOM_SCHEDULER_HOT_RELOAD ?? "") !== "0";
  return hotReload
    ? `Live within ~30s — the in-agent scheduler hot-reloads the overlay; no restart needed.`
    : `Not live yet — hot-reload is disabled (SWITCHROOM_SCHEDULER_HOT_RELOAD=0). ` +
        `Run \`switchroom agent restart ${agent}\` for this to take effect.`;
}

/**
 * The legible "what am I allowed to do" view for one agent — the answer to
 * the access-model's "an agent should be able to see its own sandbox" so it
 * stops guessing and overreaching (reference/access-model.md, "Dead-ends
 * breed workarounds").
 *
 * DRIFT-FREE BY CONSTRUCTION: every field is computed from the SAME
 * operator-owned config + the SAME enforcement functions that actually gate
 * each action — `resolveAgentConfig` (the resolved cascade the scaffold
 * itself uses, NOT the raw `config.agents[x]` slice `config get` returns)
 * and `checkAclByAgent` (the vault ACL enforcer). It never maintains a
 * parallel hand-list that could drift into a comforting lie.
 *
 * Secret VALUES never appear — vault is reported as key NAMES + a readable
 * boolean only.
 */
export interface WhoamiView {
  name: string;
  persona: string | null;
  model: string | null;
  tier: "root" | "admin" | "standard";
  tools: { allow: string[]; deny: string[] };
  mcpServers: string[];
  skills: string[];
  /** Vault keys this agent's config references, each with the ACL verdict. */
  vault: { key: string; readable: boolean }[];
  powers: {
    admin: boolean;
    root: boolean;
    /** Whether agent-proposed config edits are enabled (hostd.config_edit_enabled). */
    configEdit: boolean;
    /** True when cross-agent host verbs (restart/logs/exec/doctor/update) are reachable. */
    crossAgentHostVerbs: boolean;
  };
  scheduleCount: number;
  memoryBackend: string | null;
}

/** Recursively collect `vault:<key>` references from a resolved config slice. */
function collectVaultKeys(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("vault:")) out.add(value.slice("vault:".length));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectVaultKeys(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // `secrets: [names]` is a declared-key list (names, never values).
      if (k === "secrets" && Array.isArray(v)) {
        for (const s of v) if (typeof s === "string") out.add(s);
      } else {
        collectVaultKeys(v, out);
      }
    }
  }
}

/**
 * Build the resolved {@link WhoamiView} for `agentName`. Pure over `config`
 * — no broker round-trip, no disk read beyond the already-loaded config —
 * so it works unchanged in-container (config is bind-mounted read-only) and
 * unit-tests without fixtures. Throws if the agent isn't defined.
 */
export function buildWhoami(
  config: SwitchroomConfig,
  agentName: string,
): WhoamiView {
  const slice = config.agents?.[agentName];
  if (!slice) throw new Error(`agent "${agentName}" not defined in switchroom.yaml`);
  const resolved = resolveAgentConfig(config.defaults, config.profiles, slice) as Record<
    string,
    unknown
  >;

  const admin = resolved.admin === true || resolved.root === true;
  const root = resolved.root === true;

  const toolsBlock = (resolved.tools ?? {}) as { allow?: string[]; deny?: string[] };
  const allow = [
    ...(toolsBlock.allow ?? []),
    ...((resolved.allowed_tools as string[] | undefined) ?? []),
  ];
  const deny = [
    ...(toolsBlock.deny ?? []),
    ...((resolved.disallowed_tools as string[] | undefined) ?? []),
  ];

  const mcpServers = Object.keys(
    (resolved.mcp_servers as Record<string, unknown> | undefined) ?? {},
  );
  const skills = ((resolved.skills as string[] | undefined) ?? []).slice();

  const vaultKeys = new Set<string>();
  collectVaultKeys(resolved, vaultKeys);
  const vault = [...vaultKeys]
    .sort()
    .map((key) => ({ key, readable: checkAclByAgent(config, agentName, key).allow }));

  const configEdit = config.hostd?.config_edit_enabled === true;

  const schedule = (resolved.schedule as unknown[] | undefined) ?? [];

  return {
    name: agentName,
    persona: (resolved.description as string | undefined) ?? (resolved.persona as string | undefined) ?? null,
    model: (resolved.model as string | undefined) ?? null,
    tier: root ? "root" : admin ? "admin" : "standard",
    tools: { allow, deny },
    mcpServers,
    skills,
    vault,
    powers: { admin, root, configEdit, crossAgentHostVerbs: admin },
    scheduleCount: schedule.length,
    memoryBackend:
      ((config.memory as { backend?: string } | undefined)?.backend) ?? null,
  };
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

  // switchroom config whoami — the agent's own legible sandbox
  config
    .command("whoami")
    .description("Emit what this agent is allowed to do (tools, MCP, vault key-names, powers) as JSON — its own sandbox, computed from live enforcement")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(
      withConfigError(async (opts: { agent?: string }) => {
        let agent: string;
        try {
          agent = resolveTargetAgent(opts.agent);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(opts.agent ?? "<unknown>", "config.whoami", { ...opts }, 7);
          process.exit(7);
        }
        const cfg = getConfig(program);
        try {
          // buildWhoami emits key NAMES + booleans only — no secret values —
          // so no stripSecretValues pass is needed.
          const view = buildWhoami(cfg, agent);
          process.stdout.write(JSON.stringify(view) + "\n");
          appendAudit(agent, "config.whoami", { ...opts }, 0);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          appendAudit(agent, "config.whoami", { ...opts }, 1);
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

  // switchroom skill list — find-or-create because the `skill` parent
  // is shared across several files (skill.ts, skill-personal.ts,
  // skill-search.ts, agent-config-skill-write.ts).
  const skill =
    program.commands.find((c) => c.name() === "skill") ??
    program
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
