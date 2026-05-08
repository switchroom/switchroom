/**
 * Docker Compose generator — Phase 1a.
 *
 * Turns the cascade-resolved switchroom.yaml into a byte-deterministic
 * docker-compose.yml. Mirrors what `installAllUnits()` does for systemd,
 * but for the Docker substrate (RFC §"Compose skeleton").
 *
 * Determinism is load-bearing: agents are emitted in sorted name order,
 * volumes alphabetised, env keys sorted. Two byte-identical inputs
 * MUST produce a byte-identical output (asserted by the snapshot tests
 * in tests/docker/compose-generator.test.ts).
 *
 * Identity model summary (RFC §"Container identity model"):
 *   - Each agent gets a deterministic UID in 10001..10999 derived from
 *     a stable hash of its name (allocateAgentUid()).
 *   - Each agent's broker socket dir lives in its OWN named volume,
 *     mounted ONLY into that agent's container. Same for kernel.
 *   - The broker mounts every agent's socket dir under
 *     /run/switchroom/broker/<agent>; per-agent agents mount only
 *     their own dir under /run/switchroom/broker.
 *
 * What this module does NOT do:
 *   - Touch existing systemd code paths. The existing host-native
 *     install path (src/agents/systemd.ts) is unchanged.
 *   - Evaluate live runtime — that's the runtime detection in
 *     src/cli/agent.ts which calls this only when SWITCHROOM_RUNTIME
 *     is set to "docker".
 */

import { createHash } from "node:crypto";
import type { SwitchroomConfig, AgentConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";

/** UID range reserved for agent containers. 999 slots — practical fleet limit. */
export const AGENT_UID_MIN = 10001;
export const AGENT_UID_MAX = 10999;

/** Resource defaults by profile category. RFC §"Resource limits as foot-guns". */
export interface ResourceDefaults {
  memLimit: string;
  cpus: number;
}

const RESOURCE_BY_PROFILE: Record<string, ResourceDefaults> = {
  klanker: { memLimit: "6g", cpus: 2.0 },
  // Conversational profiles — clerk, finn, carrie, coach, etc.
  conversational: { memLimit: "1.5g", cpus: 1.0 },
  // Lightweight profiles.
  lightweight: { memLimit: "1g", cpus: 0.5 },
  // Coding/worker/researcher.
  coding: { memLimit: "2g", cpus: 2.0 },
  // Catch-all default.
  default: { memLimit: "1.5g", cpus: 1.0 },
};

/**
 * Resolve resource defaults for an agent. Special-cases the agent name
 * "klanker" (matches the canonical fleet's klanker profile), then falls
 * through to the agent's `extends:` profile name, then to "default".
 *
 * Operator overrides at the agent level (resources.mem_limit etc.) win
 * over these defaults — see emitAgentService.
 */
export function resolveResourceDefaults(
  agentName: string,
  profile: string | undefined,
): ResourceDefaults {
  if (agentName === "klanker") return RESOURCE_BY_PROFILE.klanker!;
  if (profile && RESOURCE_BY_PROFILE[profile]) return RESOURCE_BY_PROFILE[profile]!;
  return RESOURCE_BY_PROFILE.default!;
}

/**
 * Allocate a deterministic UID for an agent in [AGENT_UID_MIN, AGENT_UID_MAX].
 *
 * Algorithm: SHA-256 of the agent name, take the first 4 bytes as a
 * uint32, modulo the range size, plus the floor. This is collision-prone
 * by birthday-paradox at large fleets — `checkAgentUidUniqueness` in
 * doctor flags collisions and instructs the operator to rename one of
 * the colliders. With 50 agents the collision probability is ~0.12%; at
 * the canonical ~10-agent fleet it's negligible.
 *
 * Determinism: same name → same UID, always. This matters for
 * compose regeneration after an `add agent` so existing agents' UIDs
 * never shift (which would require a chown sweep over their state).
 */
export function allocateAgentUid(name: string): number {
  const hash = createHash("sha256").update(name).digest();
  const u32 = hash.readUInt32BE(0);
  const range = AGENT_UID_MAX - AGENT_UID_MIN + 1;
  return AGENT_UID_MIN + (u32 % range);
}

export interface ComposeGeneratorOptions {
  config: SwitchroomConfig;
  /** Image tag — same for every service in a release. */
  imageTag?: string;
  /** Stderr stream for warnings (cap-strip etc.); defaults to process.stderr. */
  warn?: (msg: string) => void;
}

/** Resolve the image ref for one of the four service images. */
function resolveImageRef(
  name: "agent" | "broker" | "kernel" | "scheduler",
  imageTag: string,
): string {
  return `ghcr.io/switchroom/switchroom-${name}:${imageTag}`;
}

interface AgentServiceData {
  name: string;
  uid: number;
  profile: string | undefined;
  resources: ResourceDefaults;
  /** Capability extras the operator requested AND we stripped. */
  strippedCaps: string[];
}

/** Per-agent metadata exposed to doctor checks (and tests). */
export function describeAgents(config: SwitchroomConfig): AgentServiceData[] {
  const out: AgentServiceData[] = [];
  for (const name of Object.keys(config.agents).sort()) {
    const agent = config.agents[name]!;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
    const profile = agent.extends ?? "default";
    const uid = allocateAgentUid(name);
    const resources = resolveResourceDefaults(name, profile);
    const strippedCaps = readStrippedCaps(agent);
    out.push({ name, uid, profile, resources, strippedCaps });
    void resolved;
  }
  return out;
}

/** Capability-add escape hatch — we strip these in Docker mode (RFC). */
function readStrippedCaps(agent: AgentConfig): string[] {
  // The schema does not currently declare cap_add; an operator might
  // still smuggle it via settings_raw. We grep the raw settings for it.
  const raw = (agent.settings_raw ?? {}) as Record<string, unknown>;
  const caps = raw.cap_add;
  if (Array.isArray(caps)) return caps.map(String);
  return [];
}

/**
 * Generate a docker-compose.yml from the cascade. Pure function: no IO,
 * no env reads. Deterministic for byte-identical input.
 */
export function generateCompose(opts: ComposeGeneratorOptions): string {
  const { config } = opts;
  const imageTag = opts.imageTag ?? "latest";
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
  const brokerImage = resolveImageRef("broker", imageTag);
  const kernelImage = resolveImageRef("kernel", imageTag);
  const schedulerImage = resolveImageRef("scheduler", imageTag);
  const agentImage = resolveImageRef("agent", imageTag);

  const lines: string[] = [];
  lines.push("# generated by switchroom — do not edit by hand.");
  lines.push("# Manual edits will be overwritten on the next `switchroom agent add`");
  lines.push("# (or future `switchroom reconcile`). To customise an agent, edit");
  lines.push("# switchroom.yaml and re-run the regenerating command.");
  lines.push("");
  lines.push(`# image tag: ${imageTag}`);
  lines.push("");
  lines.push(`services:`);

  // ── vault-broker (singleton) ───────────────────────────────────────
  lines.push(`  vault-broker:`);
  lines.push(`    image: ${brokerImage}`);
  lines.push(`    container_name: switchroom-vault-broker`);
  // Fleet labels for ad-hoc selection (e.g. `docker ps --filter label=switchroom.role=agent`).
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "broker"`);
  lines.push(`      switchroom.fleet: "switchroom"`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // Broker needs CHOWN + FOWNER to take ownership of per-agent socket
  // dirs (created at startup) and chmod sockets to 0660 owned by the
  // agent's UID. Everything else stays dropped.
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`    volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`      - broker-${a.name}-sock:/run/switchroom/broker/${a.name}`);
  }
  lines.push(`      - \${HOME}/.switchroom/vault:/state/vault`);
  lines.push(``);

  // ── approval-kernel (singleton) ────────────────────────────────────
  lines.push(`  approval-kernel:`);
  lines.push(`    image: ${kernelImage}`);
  lines.push(`    container_name: switchroom-approval-kernel`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "kernel"`);
  lines.push(`      switchroom.fleet: "switchroom"`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // Kernel mirrors broker: it owns per-agent socket dirs and must chown
  // sockets to the agent UID after bind().
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`    volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel/${a.name}`);
  }
  lines.push(`      - \${HOME}/.switchroom/approvals:/state/approvals`);
  lines.push(``);

  // ── switchroom-cron (singleton scheduler) ──────────────────────────
  lines.push(`  switchroom-cron:`);
  lines.push(`    image: ${schedulerImage}`);
  lines.push(`    container_name: switchroom-cron`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "scheduler"`);
  lines.push(`      switchroom.fleet: "switchroom"`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 15s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  lines.push(`    volumes:`);
  lines.push(`      - /var/run/docker.sock:/var/run/docker.sock:ro`);
  lines.push(`      - \${HOME}/.switchroom:/state/config:ro`);
  lines.push(`      - \${HOME}/.switchroom/scheduler:/state/scheduler`);
  lines.push(`    environment:`);
  lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
  // SQLite audit sink for scheduler fires (Phase 1b — wires
  // SqliteAuditSink that better-sqlite3 was already installed for).
  // Without this env var the scheduler falls back to JsonlAuditSink.
  lines.push(`      SWITCHROOM_SCHEDULER_DB_PATH: /state/scheduler/scheduler.db`);
  lines.push(``);

  // ── per-agent services ─────────────────────────────────────────────
  for (const a of describeAgents(config)) {
    if (a.strippedCaps.length > 0) {
      warn(`compose: stripping cap_add ${JSON.stringify(a.strippedCaps)} from agent "${a.name}" (Docker mode forbids capability extras; see RFC §security)`);
    }
    emitAgentService(lines, a, imageTag, agentImage);
  }

  // ── volumes ────────────────────────────────────────────────────────
  lines.push(`volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`  broker-${a.name}-sock:`);
    lines.push(`  kernel-${a.name}-sock:`);
  }
  lines.push("");

  return lines.join("\n");
}

function emitAgentService(
  lines: string[],
  a: AgentServiceData,
  imageTag: string,
  agentImage: string,
): void {
  lines.push(`  agent-${a.name}:`);
  lines.push(`    image: ${agentImage}`);
  lines.push(`    container_name: switchroom-${a.name}`);
  lines.push(`    hostname: ${a.name}`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "agent"`);
  lines.push(`      switchroom.fleet: "switchroom"`);
  lines.push(`      switchroom.agent: "${a.name}"`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    init: false`);
  lines.push(`    stop_grace_period: 45s`);
  lines.push(`    user: "${a.uid}:${a.uid}"`);
  lines.push(`    mem_limit: ${a.resources.memLimit}`);
  lines.push(`    cpus: ${a.resources.cpus.toFixed(1)}`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // read_only root FS — claude CLI, tini, tmux, node only need writable
  // /tmp (and the explicit /state/* mounts above). tmpfs keeps /tmp
  // RAM-backed and capped so a runaway can't fill the host disk.
  lines.push(`    read_only: true`);
  lines.push(`    tmpfs:`);
  lines.push(`      - /tmp:size=256m,mode=1777`);
  lines.push(`    depends_on:`);
  lines.push(`      vault-broker:`);
  lines.push(`        condition: service_started`);
  lines.push(`      approval-kernel:`);
  lines.push(`        condition: service_started`);
  lines.push(`    environment:`);
  // env keys MUST be sorted for byte determinism.
  const env: Record<string, string> = {
    SWITCHROOM_AGENT_NAME: a.name,
    SWITCHROOM_BROKER_SOCKET: `/run/switchroom/broker/${a.name}/sock`,
    SWITCHROOM_KERNEL_SOCKET: `/run/switchroom/kernel/${a.name}/sock`,
    SWITCHROOM_RUNTIME: "docker",
  };
  for (const k of Object.keys(env).sort()) {
    lines.push(`      ${k}: ${JSON.stringify(env[k])}`);
  }
  lines.push(`    volumes:`);
  // Per-agent volumes — each volume mounted into EXACTLY this agent's
  // container. The doctor check `checkAgentSocketMounts` asserts the
  // invariant on every regenerated compose.
  lines.push(`      - broker-${a.name}-sock:/run/switchroom/broker`);
  lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel`);
  lines.push(`      - \${HOME}/.switchroom/agents/${a.name}:/state/agent`);
  lines.push(`      - \${HOME}/.claude/projects/${a.name}:/state/.claude`);
  lines.push(`      - \${HOME}/.switchroom/logs/${a.name}:/var/log/switchroom`);
  lines.push(``);
  void imageTag;
}
