/**
 * Host-side connection-health computation + on-disk snapshot.
 *
 * The agent-start surface (boot card) for connection auth can't query the
 * vault-broker itself — the in-container boot probe is contractually
 * forbidden from doing vault/grant work (telegram-plugin/gateway/
 * boot-probes.ts). So we compute connection health HOST-SIDE during
 * `apply` (where the broker, config, and ACLs are all reachable) and drop
 * a small JSON snapshot into the agent dir. The boot card's
 * `probeConnections` just reads that file.
 *
 * Connection model (2026-06): an integration's MCP loads when CONFIGURED;
 * auth is assumed. A configured-but-unauthed connection is reported here
 * (and surfaced at boot), never silently broken. Reuses the same
 * `computeMcpSecretRequirements` registry the `switchroom doctor` "MCP
 * Connections (auth)" check uses, so doctor and the boot card never
 * disagree.
 *
 * Fail-safe: if the broker is unreachable we cannot verify auth, so we
 * emit ZERO issues (auth assumed) rather than false-flagging an agent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";
import {
  computeMcpSecretRequirements,
  entryScopeDenies,
  type VaultAclResult,
} from "../cli/doctor-mcp-secrets.js";

/** Filename written under `<agentDir>/.claude/`. Shared contract with the
 *  boot-card probe (telegram-plugin reads the same JSON shape). */
export const CONNECTION_HEALTH_FILENAME = "connection-health.json";

export interface ConnectionIssue {
  /** The MCP server that is configured but not authed. */
  server: string;
  /** The vault key it needs. */
  key: string;
  /**
   * "missing" = the declared vault key has no value; "acl" = the key exists
   * but the vault entry scope (allow/deny) denies this agent. Both are real
   * runtime auth failures. (An EMPTY scope.allow is NOT a denial — that was
   * the v0.15.38 false-positive.)
   */
  kind: "missing" | "acl";
  /** One-line human description. */
  detail: string;
  /** Exact remediation command. */
  fix: string;
}

export interface ConnectionHealth {
  /** epoch ms when this snapshot was computed (host clock). */
  computedAt: number;
  /** Definitive auth problems. Empty = healthy (or unverifiable → assumed healthy). */
  issues: ConnectionIssue[];
}

export interface ConnectionHealthDeps {
  /** Reads the vault-broker ACL for a key. Injected in tests; wired to
   *  getViaBrokerStructured by callers. */
  vaultAclReader: (key: string) => Promise<VaultAclResult>;
  /** Clock override for tests. */
  now?: () => number;
  /** fs overrides for tests. */
  mkdir?: (path: string, opts: { recursive: true }) => void;
  writeFile?: (path: string, data: string) => void;
}

/**
 * Compute the definitive auth issues for ONE agent's user-declared MCP
 * connections. Missing key or ACL-drift → issue; ok or broker-unreachable
 * → no issue (fail-safe: never false-flag when we can't verify).
 */
export async function computeAgentConnectionIssues(
  config: SwitchroomConfig,
  agentName: string,
  vaultAclReader: (key: string) => Promise<VaultAclResult>,
): Promise<ConnectionIssue[]> {
  const reqs = computeMcpSecretRequirements(config).filter(
    (r) => r.agent === agentName,
  );
  if (reqs.length === 0) return [];

  // Which agents need each key — drives the `vault set --allow` fix list,
  // matching the doctor check's re-statement semantics.
  const agentsNeedingKey = new Map<string, Set<string>>();
  for (const r of computeMcpSecretRequirements(config)) {
    for (const key of r.keys) {
      let set = agentsNeedingKey.get(key);
      if (!set) {
        set = new Set<string>();
        agentsNeedingKey.set(key, set);
      }
      set.add(r.agent);
    }
  }

  const aclCache = new Map<string, VaultAclResult>();
  const readKey = async (key: string): Promise<VaultAclResult> => {
    const cached = aclCache.get(key);
    if (cached) return cached;
    const r = await vaultAclReader(key);
    aclCache.set(key, r);
    return r;
  };

  const issues: ConnectionIssue[] = [];
  for (const r of reqs) {
    for (const key of r.keys) {
      const acl = await readKey(key);
      const want = [...(agentsNeedingKey.get(key) ?? new Set())].sort();
      if (acl.kind === "unreachable") continue; // fail-safe: assume authed
      if (acl.kind === "not_found") {
        issues.push({
          server: r.server,
          key,
          kind: "missing",
          detail: `MCP '${r.server}' needs vault key '${key}', but it is missing — configured but not authed`,
          fix: `switchroom vault set ${key} --allow ${want.join(",")} (then provide the value)`,
        });
        continue;
      }
      // kind === "ok": key exists and the agent passes the secrets[] ACL
      // grant by construction — but the broker ALSO applies the entry scope
      // (checkEntryScope). Only flag when the scope actually denies; an empty
      // scope.allow imposes no restriction (the v0.15.38 false-positive was
      // treating empty-allow as "deny everyone").
      if (entryScopeDenies(agentName, acl.allow, acl.deny)) {
        const updated = [...new Set([...acl.allow, agentName])].sort().join(",");
        issues.push({
          server: r.server,
          key,
          kind: "acl",
          detail: `MCP '${r.server}' — vault entry scope for '${key}' denies this agent — broker will deny at runtime`,
          fix: `switchroom vault set ${key} --allow ${updated} (re-state the full list; drop from --deny if present)`,
        });
      }
    }
  }
  return issues;
}

/**
 * Write `<agentDir>/.claude/connection-health.json`. Best-effort — callers
 * wrap in try/catch; a write failure must never break `apply`.
 */
export function writeConnectionHealthFile(
  agentDir: string,
  health: ConnectionHealth,
  deps?: Pick<ConnectionHealthDeps, "mkdir" | "writeFile">,
): void {
  const dir = join(agentDir, ".claude");
  const path = join(dir, CONNECTION_HEALTH_FILENAME);
  (deps?.mkdir ?? ((p, o) => mkdirSync(p, o)))(dir, { recursive: true });
  (deps?.writeFile ?? ((p, d) => writeFileSync(p, d)))(
    path,
    JSON.stringify(health, null, 2) + "\n",
  );
}

/**
 * Compute + write connection-health for one agent. Returns the snapshot
 * (also for callers that want to log it). Best-effort: never throws.
 */
export async function refreshAgentConnectionHealth(
  config: SwitchroomConfig,
  agentName: string,
  agentDir: string,
  deps: ConnectionHealthDeps,
): Promise<ConnectionHealth> {
  const now = deps.now ?? Date.now;
  let issues: ConnectionIssue[] = [];
  try {
    issues = await computeAgentConnectionIssues(
      config,
      agentName,
      deps.vaultAclReader,
    );
  } catch {
    issues = []; // fail-safe — never block apply on a probe error
  }
  const health: ConnectionHealth = { computedAt: now(), issues };
  try {
    writeConnectionHealthFile(agentDir, health, deps);
  } catch {
    // best-effort; swallow.
  }
  return health;
}
