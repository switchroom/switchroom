/**
 * Docker-mode doctor checks (Phase 1a + runtime container-state).
 *
 * Runs in BOTH modes — the checks are gated on whether Docker is the
 * active runtime (env SWITCHROOM_RUNTIME === "docker") or whether a
 * generated compose file exists at ~/.switchroom/compose/docker-compose.yml.
 * In host-only fleets every check no-ops with a status:"ok" + neutral
 * detail so the doctor section never goes silent.
 *
 * Checks (per RFC §"Container identity model" — these enforce the
 * security invariants that the per-agent socket model relies on):
 *
 *   1. checkAgentUidUniqueness — no two agents share an allocated UID
 *      (collision under allocateAgentUid's hash-mod scheme).
 *   2. checkAgentSocketMounts — no agent's compose service mounts
 *      another agent's broker/kernel socket directory volume.
 *   3. checkAgentCaps — no agent service has cap_add extras (we strip
 *      them at generation; this catches operator hand-edits).
 *   4. checkDockerfileUserAlignment — warn if the per-agent compose
 *      `user:` UID differs from the Dockerfile.agent baseline (the
 *      Dockerfile is identity-neutral, so this should always pass —
 *      check exists as a sanity rail against future Dockerfile drift).
 *   5. checkContainerRuntimeHealth — RUNTIME check for the 2026-06-23
 *      incident class: vault-broker / auth-broker / approval-kernel stuck
 *      in "Restarting" or "Created", and agent containers stuck in "Created"
 *      or "Restarting". Catches compose bind-source auto-dir'd as root-owned
 *      dirs within minutes of deploy.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { allocateAgentUid, describeAgents } from "../agents/compose.js";
import {
  detectSingletonDrift,
  type SingletonReconcileDeps,
} from "../agents/singleton-reconcile.js";
import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";

/** Extract the `:tag` from an image ref for compact drift messages. */
function imageTagOf(ref: string | null): string {
  if (!ref) return "<absent>";
  const at = ref.lastIndexOf("@"); // strip digest if present
  const base = at >= 0 ? ref.slice(0, at) : ref;
  const colon = base.lastIndexOf(":");
  const slash = base.lastIndexOf("/");
  return colon > slash ? base.slice(colon + 1) : ref;
}

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/**
 * Runtime detection — Docker mode is "active" if either the env flag is
 * set or a generated compose file exists.
 *
 * INTENTIONAL ASYMMETRY between read and write paths:
 *   - Write paths (`agent add`, `reconcile`, anything that mutates state)
 *     MUST gate on `process.env.SWITCHROOM_RUNTIME === "docker"` directly
 *     — the env flag is authoritative. We never infer "the user wants
 *     Docker" from a stray compose file lying around.
 *   - Read-only paths (`doctor`, `logs`, status commands) accept the
 *     compose-file presence as a fallback signal so the operator can run
 *     `switchroom doctor` from outside a unit/cron context (no env flag
 *     in their interactive shell) and still see Docker-relevant checks.
 *
 * Future readers: if you find yourself tempted to use this helper from a
 * write path, don't. Read the env var directly.
 */
export function isDockerMode(opts?: { composePath?: string }): boolean {
  if (process.env.SWITCHROOM_RUNTIME === "docker") return true;
  if (opts?.composePath) {
    try {
      readFileSync(opts.composePath, "utf8");
      return true;
    } catch { /* not present */ }
  }
  return false;
}

export function checkAgentUidUniqueness(
  config: SwitchroomConfig,
): CheckResult {
  const seen = new Map<number, string[]>();
  for (const name of Object.keys(config.agents)) {
    const uid = allocateAgentUid(name);
    const arr = seen.get(uid) ?? [];
    arr.push(name);
    seen.set(uid, arr);
  }
  const collisions: string[] = [];
  for (const [uid, names] of seen) {
    if (names.length > 1) {
      collisions.push(`uid ${uid} → ${names.sort().join(", ")}`);
    }
  }
  if (collisions.length === 0) {
    return {
      name: "agent UID uniqueness",
      status: "ok",
      detail: `${seen.size} agent(s), no collisions`,
    };
  }
  return {
    name: "agent UID uniqueness",
    status: "fail",
    detail: `Allocated UID collisions: ${collisions.join("; ")}`,
    fix: "Rename one of the colliding agents — UIDs are derived from a hash of the name. `switchroom agent rename <old> <new>`.",
  };
}

/**
 * Inspect a generated compose file for cross-mounted socket dirs.
 *
 * Pure function over the compose source — does NOT shell out to docker.
 * The check parses the volumes lines under each `agent-<name>:` block
 * and asserts that the only `broker-*-sock` / `kernel-*-sock` volumes
 * mounted are the agent's own.
 */
export function checkAgentSocketMounts(composeYaml: string): CheckResult {
  const violations: string[] = [];
  const lines = composeYaml.split("\n");
  let currentAgent: string | null = null;
  for (const line of lines) {
    const m = /^  agent-([a-z0-9_-]+):\s*$/.exec(line);
    if (m) { currentAgent = m[1]!; continue; }
    // Service block ends on a non-indented line OR another top-level service.
    if (currentAgent && /^[^ ]/.test(line)) { currentAgent = null; }
    if (!currentAgent) continue;
    const v = /-\s+(broker|kernel)-([a-z0-9_-]+)-sock:/.exec(line);
    if (v) {
      const kind = v[1]!;
      const ownerAgent = v[2]!;
      if (ownerAgent !== currentAgent) {
        violations.push(`agent-${currentAgent} mounts ${kind}-${ownerAgent}-sock`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      name: "agent socket-volume isolation",
      status: "ok",
      detail: "every agent mounts only its own broker/kernel socket dir",
    };
  }
  return {
    name: "agent socket-volume isolation",
    status: "fail",
    detail: `Cross-mounted socket volumes: ${violations.join("; ")}`,
    fix: "Re-run `switchroom apply` to regenerate the compose from cascade. Hand-edits violating per-agent socket isolation are the load-bearing security invariant.",
  };
}

export function checkAgentCaps(config: SwitchroomConfig): CheckResult {
  const offenders: string[] = [];
  for (const a of describeAgents(config)) {
    if (a.strippedCaps.length > 0) {
      offenders.push(`${a.name}: ${a.strippedCaps.join(",")}`);
    }
  }
  if (offenders.length === 0) {
    return {
      name: "agent capability extras",
      status: "ok",
      detail: "no agent declares cap_add",
    };
  }
  return {
    name: "agent capability extras",
    status: "fail",
    detail: `cap_add extras (stripped at compose-gen, but present in config): ${offenders.join("; ")}`,
    fix: "Remove cap_add from the agent's settings_raw. Docker mode forbids capability extras — agents run with default cap-drop.",
  };
}

/**
 * Compare the per-agent UID encoded in the compose `user:` directive
 * against the Dockerfile.agent baseline. Dockerfile.agent is identity-
 * neutral by design, so the only failure mode is a future Dockerfile
 * change pinning a USER directive that conflicts with compose.
 */
export function checkDockerfileUserAlignment(
  composeYaml: string,
  dockerfileAgent: string,
): CheckResult {
  const userDirective = /^USER\s+([0-9]+)(?::[0-9]+)?\s*$/m.exec(dockerfileAgent);
  if (!userDirective) {
    return {
      name: "Dockerfile USER alignment",
      status: "ok",
      detail: "Dockerfile.agent declares no USER directive — compose `user:` is authoritative",
    };
  }
  const dockerfileUid = parseInt(userDirective[1]!, 10);
  // USER 0 is a privilege-escalation hazard, not a drift warning — fail
  // hard. Compose `user:` overrides this at runtime, but a Dockerfile
  // baked with USER 0 is a footgun for anyone running the image without
  // the generator's compose (e.g. ad-hoc `docker run`).
  if (dockerfileUid === 0) {
    return {
      name: "Dockerfile USER alignment",
      status: "fail",
      detail: "Dockerfile.agent declares USER 0 (root) — privesc risk if image is run without compose `user:` override",
      fix: "Drop the USER directive from Dockerfile.agent (the image is identity-neutral by design — compose pins per-agent UIDs).",
    };
  }
  // Find any agent service whose user: differs.
  const mismatches: string[] = [];
  const re = /^  agent-([a-z0-9_-]+):[\s\S]*?\n    user:\s+"(\d+):/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(composeYaml)) !== null) {
    const name = m[1]!;
    const uid = parseInt(m[2]!, 10);
    if (uid !== dockerfileUid) mismatches.push(`${name}=${uid}`);
  }
  if (mismatches.length === 0) {
    return {
      name: "Dockerfile USER alignment",
      status: "ok",
      detail: `Dockerfile USER ${dockerfileUid} matches every agent service`,
    };
  }
  return {
    name: "Dockerfile USER alignment",
    status: "warn",
    detail: `Dockerfile.agent pins USER ${dockerfileUid} but compose user: differs: ${mismatches.join(", ")}`,
    fix: "Drop the USER directive from Dockerfile.agent (preferred — the image is identity-neutral) or align per-agent UIDs by renaming.",
  };
}

/**
 * Detect singletons (vault-broker / approval-kernel /
 * switchroom-auth-broker) running an image older than the
 * compose-pinned one. This is the check that would have caught the
 * 2026-06-05 incident (auth-broker 42 versions stale → /connect
 * microsoft failed) before a feature broke. Reads running images via
 * `docker inspect`; degrades to "ok" if docker is unreachable (running
 * resolves to null → not flagged). The `inspectImage` dep is injectable
 * for tests.
 */
export function checkSingletonImageDrift(
  composeYaml: string,
  deps?: Pick<SingletonReconcileDeps, "inspectImage">,
): CheckResult {
  const drift = detectSingletonDrift({
    composeFile: "(in-memory)",
    readCompose: () => composeYaml,
    inspectImage: deps?.inspectImage,
  });
  // Only flag singletons that are RUNNING a stale image; an absent
  // container is "down", which the per-singleton health checks own.
  const stale = drift.filter((d) => d.needsRecreate && d.running !== null);
  if (stale.length === 0) {
    return {
      name: "singleton image drift",
      status: "ok",
      detail: "vault-broker / approval-kernel / auth-broker match the pinned image",
    };
  }
  return {
    name: "singleton image drift",
    status: "warn",
    detail:
      "singleton(s) running an image older than the pin: " +
      stale
        .map((d) => `${d.service} ${imageTagOf(d.running)}≠${imageTagOf(d.pinned)}`)
        .join(", "),
    fix: "Recreate them — `switchroom agent restart <any-agent>` now self-heals stale singletons, or `switchroom update` (whole-project recreate).",
  };
}

/**
 * A parsed row from `docker ps -a --format {{.Names}}\t{{.Status}}`.
 * @internal exported for testing
 */
export interface ContainerRow {
  name: string;
  status: string;
}

/**
 * Classify a container's status string into a coarse health bucket.
 *
 * Docker status strings look like:
 *   "Up 3 hours (healthy)"      → running/healthy
 *   "Up 2 minutes"               → running (no healthcheck)
 *   "Restarting (1) 30 seconds"  → crash-looping
 *   "Created"                    → stuck before first start
 *   "Exited (1) 5 minutes ago"   → stopped
 *
 * @internal exported for testing
 */
export type ContainerHealth =
  | "running-healthy"
  | "running-no-healthcheck"
  | "restarting"
  | "created"
  | "exited"
  | "other";

export function classifyContainerStatus(status: string): ContainerHealth {
  const s = status.toLowerCase().trim();
  if (s.startsWith("up ") && s.includes("(healthy)")) return "running-healthy";
  if (s.startsWith("up ")) return "running-no-healthcheck";
  if (s.startsWith("restarting")) return "restarting";
  if (s === "created") return "created";
  if (s.startsWith("exited")) return "exited";
  return "other";
}

/**
 * Injectable dep type for container-runtime checks so tests never shell out.
 * @internal exported for testing
 */
export type DockerPsDeps = {
  /**
   * Returns rows from `docker ps -a --filter name=switchroom- --format {{.Names}}\t{{.Status}}`.
   * Returns null if docker is unavailable / errored.
   */
  listContainers: () => ContainerRow[] | null;
};

/**
 * Default (real) implementation — calls docker ps.
 *
 * Exported so other surfaces that need the SAME container-state snapshot
 * (the setup wizard's verification step, `src/setup/verify.ts`) reuse this
 * probe instead of shelling out to docker with slightly different flags.
 */
export function listSwitchroomContainers(): ContainerRow[] | null {
  const r = spawnSync(
    "docker",
    [
      "ps", "-a",
      "--filter", "name=switchroom-",
      "--format", "{{.Names}}\t{{.Status}}",
    ],
    { stdio: "pipe", timeout: 8000 },
  );
  if (r.error || r.status === null || r.status !== 0) return null;
  const lines = r.stdout.toString().split("\n").filter(Boolean);
  return lines.map((line) => {
    const tab = line.indexOf("\t");
    if (tab === -1) return { name: line.trim(), status: "" };
    return { name: line.slice(0, tab).trim(), status: line.slice(tab + 1).trim() };
  });
}

const DEFAULT_DOCKER_PS_DEPS: DockerPsDeps = { listContainers: listSwitchroomContainers };

/**
 * Check runtime container health for the 2026-06-23 incident class.
 *
 * Incident: a container-context deploy auto-dir'd bind-source paths as
 * root-owned dirs → vault-broker SQLite "unable to open database file" +
 * auth-broker EISDIR → stuck in Restarting/Created → agents never reached
 * "running" → fleet deaf 5h.
 *
 * This check surfaces the symptom (not the root cause) within seconds of
 * deploy: singletons crash-looping or stuck-Created, and/or agent containers
 * stuck in Created.
 *
 * FALSE-POSITIVE GUARD: an empty fleet (no agents at all, no agent containers)
 * should NOT flag. Only flag when singletons are actually unhealthy OR agents
 * are stuck. We do NOT require the singletons to be in a healthy state on a
 * legitimately-empty fleet (the broker bind-presence healthcheck correctly
 * reads "unhealthy" when there are no per-agent socket dirs mounted, which
 * is normal when no agents exist).
 *
 * @internal exported for testing
 */
export function checkContainerRuntimeHealth(
  config: SwitchroomConfig,
  deps: DockerPsDeps = DEFAULT_DOCKER_PS_DEPS,
): CheckResult[] {
  const rows = deps.listContainers();
  if (rows === null) {
    // Docker unavailable — skip without false-alarming.
    return [{
      name: "container runtime health",
      status: "skip",
      detail: "docker ps unavailable — cannot check container runtime health",
    }];
  }

  // Singletons we always check regardless of agent count.
  const SINGLETON_NAMES = [
    "switchroom-vault-broker",
    "switchroom-auth-broker",
    "switchroom-approval-kernel",
  ] as const;

  // Build a name→status map from the actual docker ps output.
  const containerMap = new Map<string, ContainerHealth>();
  for (const row of rows) {
    containerMap.set(row.name, classifyContainerStatus(row.status));
  }

  const configuredAgents = Object.keys(config.agents ?? {});
  const hasAgents = configuredAgents.length > 0;

  // ---- Singleton health ----
  const singletonProblems: string[] = [];
  for (const name of SINGLETON_NAMES) {
    const health = containerMap.get(name);
    if (health === undefined) continue; // container not present at all — skip
    if (health === "restarting" || health === "created") {
      singletonProblems.push(`${name} (${health})`);
    }
  }

  // ---- Agent stuck in Created/Restarting ----
  // Only flag agent containers that are in the config AND stuck.
  // An empty-fleet host (no agents configured) produces zero agent rows.
  const agentProblems: string[] = [];
  if (hasAgents) {
    for (const agentName of configuredAgents) {
      const containerName = `switchroom-${agentName}`;
      const health = containerMap.get(containerName);
      if (health === undefined) continue; // not yet started — skip
      if (health === "created" || health === "restarting") {
        agentProblems.push(`${containerName} (${health})`);
      }
    }
  }

  const allProblems = [...singletonProblems, ...agentProblems];

  if (allProblems.length === 0) {
    return [{
      name: "container runtime health",
      status: "ok",
      detail: rows.length === 0
        ? "no switchroom containers present"
        : `${rows.length} container(s) checked — no stuck/crash-looping singletons or agents`,
    }];
  }

  return [{
    name: "container runtime health",
    status: "fail",
    detail:
      `${allProblems.length} container(s) stuck/crash-looping (2026-06-23 incident signature): ` +
      allProblems.join(", "),
    fix:
      "Root cause: docker auto-created missing bind-source paths as root-owned directories " +
      "(/state/agent/home, ~/.docker/cli-plugins/docker-compose, etc.). " +
      "Run `switchroom doctor` deploy-mounts section for specific paths. " +
      "Fix bind sources first, then: `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d`",
  }];
}

/**
 * Aggregate runner — call from doctor.ts. Always returns an array so
 * the section renders consistently.
 */
export function runDockerChecks(args: {
  config: SwitchroomConfig;
  composeYaml?: string;
  dockerfileAgent?: string;
  active: boolean;
  dockerPsDeps?: DockerPsDeps;
}): CheckResult[] {
  if (!args.active) {
    return [{
      name: "Docker runtime",
      status: "ok",
      detail: "Docker mode not active (host-native runtime); skipping Docker-specific checks",
    }];
  }
  const out: CheckResult[] = [];
  out.push(checkAgentUidUniqueness(args.config));
  out.push(checkAgentCaps(args.config));
  if (args.composeYaml) {
    out.push(checkAgentSocketMounts(args.composeYaml));
    out.push(checkSingletonImageDrift(args.composeYaml));
    if (args.dockerfileAgent) {
      out.push(checkDockerfileUserAlignment(args.composeYaml, args.dockerfileAgent));
    }
  } else {
    out.push({
      name: "compose file present",
      status: "warn",
      detail: "Docker mode active but no docker-compose.yml found at ~/.switchroom/compose/docker-compose.yml",
      fix: "Run `switchroom apply` to generate it.",
    });
  }
  // Runtime container health (2026-06-23 incident class) — always runs in
  // docker mode regardless of whether we have a compose file to parse.
  out.push(...checkContainerRuntimeHealth(args.config, args.dockerPsDeps));
  return out;
}
