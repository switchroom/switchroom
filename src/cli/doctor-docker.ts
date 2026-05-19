/**
 * Docker-mode doctor checks (Phase 1a).
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
 */

import { readFileSync } from "node:fs";
import { allocateAgentUid, describeAgents } from "../agents/compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";

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
    fix: "Re-run `switchroom reconcile` to regenerate the compose from cascade. Hand-edits violating per-agent socket isolation are the load-bearing security invariant.",
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
 * Aggregate runner — call from doctor.ts. Always returns an array so
 * the section renders consistently.
 */
export function runDockerChecks(args: {
  config: SwitchroomConfig;
  composeYaml?: string;
  dockerfileAgent?: string;
  active: boolean;
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
    if (args.dockerfileAgent) {
      out.push(checkDockerfileUserAlignment(args.composeYaml, args.dockerfileAgent));
    }
  } else {
    out.push({
      name: "compose file present",
      status: "warn",
      detail: "Docker mode active but no docker-compose.yml found at ~/.switchroom/compose/docker-compose.yml",
      fix: "Run `switchroom reconcile` to generate it.",
    });
  }
  return out;
}
