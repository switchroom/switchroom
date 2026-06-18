/**
 * User-declared MCP-server connection health — the "is it actually
 * authed?" doctor probe.
 *
 * Connection model (2026-06): an integration's MCP server is loaded when
 * it is CONFIGURED for an agent; auth is ASSUMED at load time. A
 * configured-but-UNAUTHED connection is not a load decision — it is a
 * health failure surfaced here (and, later, at agent start). This probe
 * never gates loading; it reports the gap with the exact fix command.
 *
 * Framework integrations (gdrive / ms-365 / notion / webkite) already
 * have their own doctor modules that verify auth. The blind spot this
 * fills is USER-DECLARED MCP servers (perplexity, postiz, brevo, meta,
 * google_ads, …): operators declare each server's vault dependencies
 * inline as `mcp_servers.<name>.secrets[]`, and the vault-broker ACL
 * grants those keys (src/vault/broker/acl.ts:374) — but nothing verified
 * that the keys actually EXIST and that the agent is on their ACL. So an
 * MCP with an expired / never-set token (e.g. marko's invalidated meta
 * token) loaded silently and failed only at runtime.
 *
 * The effective `mcp_servers` cascade (defaults → extends-profile →
 * per-agent, per-key shallow merge) mirrors `src/vault/broker/acl.ts`
 * lines 409-423 exactly, so this probe sees the same servers+secrets the
 * broker authorizes against.
 *
 * Mirrors doctor-notion.ts: same CheckResult shape, same `vaultAclReader`
 * injection, same `vault set … --allow` fix re-statement.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** Vault-ACL read result, matching doctor-notion's reader contract. */
export type VaultAclResult =
  | { kind: "ok"; allow: string[] }
  | { kind: "unreachable"; msg: string }
  | { kind: "not_found" };

export interface McpSecretProbeDeps {
  /**
   * Reads the vault-broker ACL for a key. Returns the agents allowed to
   * read it, "not_found" if the key is absent, or "unreachable" when the
   * broker can't be queried. Injected in tests; wired to
   * getViaBrokerStructured in doctor.ts.
   */
  vaultAclReader?: (key: string) => Promise<VaultAclResult>;
}

/** One user-declared MCP server's vault-key requirement, per agent. */
export interface McpSecretRequirement {
  agent: string;
  server: string;
  keys: string[];
}

/**
 * Enumerate every (agent, user-declared MCP server, required vault keys)
 * triple from the effective config — the per-agent "connections that
 * need auth" registry. Reused by the agent-start health surface (P3).
 *
 * Cascade order matches src/vault/broker/acl.ts:409-423:
 *   1. defaults.mcp_servers
 *   2. profiles.<agent.extends>.mcp_servers   (if extends is set)
 *   3. agents.<name>.mcp_servers
 * Per-key shallow merge — a later layer fully replaces an earlier entry
 * at that key. `false` opt-outs and scalar values are skipped.
 */
export function computeMcpSecretRequirements(
  config: SwitchroomConfig,
): McpSecretRequirement[] {
  const cfg = config as {
    defaults?: { mcp_servers?: Record<string, unknown> };
    profiles?: Record<string, { mcp_servers?: Record<string, unknown> } | undefined>;
    agents?: Record<
      string,
      { extends?: string; mcp_servers?: Record<string, unknown> } | undefined
    >;
  };

  const reqs: McpSecretRequirement[] = [];
  for (const [agent, agentConfig] of Object.entries(cfg.agents ?? {})) {
    if (!agentConfig) continue;
    const profileName = agentConfig.extends;
    const profileMcp =
      profileName != null && profileName.length > 0
        ? (cfg.profiles?.[profileName]?.mcp_servers ?? {})
        : {};
    const effectiveMcp: Record<string, unknown> = {
      ...(cfg.defaults?.mcp_servers ?? {}),
      ...profileMcp,
      ...(agentConfig.mcp_servers ?? {}),
    };

    for (const [server, entry] of Object.entries(effectiveMcp)) {
      if (!entry || typeof entry !== "object") continue; // false opt-out / scalar
      const declared = (entry as { secrets?: unknown }).secrets;
      if (!Array.isArray(declared)) continue;
      const keys = declared.filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      );
      if (keys.length === 0) continue;
      reqs.push({ agent, server, keys });
    }
  }
  return reqs;
}

/**
 * Probe the auth state of every user-declared MCP connection. Each
 * (agent, server, key) yields one CheckResult:
 *   - fail  — key missing, or agent not on its ACL (runtime auth failure)
 *   - warn  — vault-broker unreachable (can't verify; fail-safe, never fail)
 *   - ok    — key present and agent on the ACL
 */
export async function runMcpSecretChecks(
  config: SwitchroomConfig,
  deps: McpSecretProbeDeps = {},
): Promise<CheckResult[]> {
  const reqs = computeMcpSecretRequirements(config);
  if (reqs.length === 0) return [];

  const read =
    deps.vaultAclReader ??
    (async (): Promise<VaultAclResult> => ({
      kind: "unreachable",
      msg: "no vault reader wired",
    }));

  // Read each key once; many agents/servers can share a key.
  const aclCache = new Map<string, VaultAclResult>();
  const readKey = async (key: string): Promise<VaultAclResult> => {
    const cached = aclCache.get(key);
    if (cached) return cached;
    const r = await read(key);
    aclCache.set(key, r);
    return r;
  };

  // Which agents need each key — drives the `vault set --allow` fix list.
  const agentsNeedingKey = new Map<string, Set<string>>();
  for (const r of reqs) {
    for (const key of r.keys) {
      let set = agentsNeedingKey.get(key);
      if (!set) {
        set = new Set<string>();
        agentsNeedingKey.set(key, set);
      }
      set.add(r.agent);
    }
  }

  const results: CheckResult[] = [];
  for (const r of reqs) {
    for (const key of r.keys) {
      const acl = await readKey(key);
      const name = `mcp-conn:${r.agent}:${r.server}:${key}`;
      const want = [...(agentsNeedingKey.get(key) ?? new Set())].sort();

      if (acl.kind === "unreachable") {
        results.push({
          name,
          status: "warn",
          detail: `vault-broker unreachable, can't verify '${key}' for MCP '${r.server}': ${acl.msg}`,
          fix: "Ensure the vault-broker is running and the operator socket is reachable, then re-run doctor.",
        });
        continue;
      }
      if (acl.kind === "not_found") {
        results.push({
          name,
          status: "fail",
          detail: `agent '${r.agent}' loads MCP '${r.server}' which needs vault key '${key}', but the key is missing — '${r.server}' is configured but NOT authed and will fail at runtime`,
          fix: `switchroom vault set ${key} --allow ${want.join(",")} (then provide the value), or remove '${r.server}' from this agent's mcp_servers.`,
        });
        continue;
      }
      if (!acl.allow.includes(r.agent)) {
        const updated = [...new Set([...acl.allow, r.agent])].sort().join(",");
        results.push({
          name,
          status: "fail",
          detail: `agent '${r.agent}' loads MCP '${r.server}' but is NOT on the vault ACL for '${key}' — the broker will deny it at runtime`,
          fix: `switchroom vault set ${key} --allow ${updated} (vault set overwrites the scope — re-state the full list including '${r.agent}').`,
        });
        continue;
      }
      results.push({
        name,
        status: "ok",
        detail: `MCP '${r.server}' → '${key}' present + ACL-allowed`,
      });
    }
  }
  return results;
}
