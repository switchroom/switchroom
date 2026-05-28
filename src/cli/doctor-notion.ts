/**
 * Notion integration doctor checks —
 * RFC docs/rfcs/notion-integration.md §9 PR 4.
 *
 * Mirrors `doctor-microsoft.ts` and `doctor-drive.ts` shape but with
 * the Notion-specific probes:
 *
 *   1. **integration-token-present** — `notion/integration-token` (or
 *      operator-overridden vault_key) exists in the vault when any
 *      agent has `notion_workspace:` configured.
 *   2. **db-references-resolvable** — every per-agent
 *      `notion_workspace.databases: [name]` resolves to a UUID in
 *      top-level `notion_workspace.databases`. (Belt + suspenders —
 *      `loader.ts` already cross-validates at config-load, so this
 *      is a "did the config-load step actually run?" guard.)
 *   3. **vault-acl-aligned** — for every agent with `notion_workspace:`,
 *      verify the agent is in the broker ACL (read via
 *      `getViaBrokerStructured` → `entry.scope.allow`). Fail with the
 *      precise `vault set ... --allow` re-statement command if not. **Highest-leverage probe** — without this
 *      check the launcher fails 503 at runtime instead of at
 *      config-edit time.
 *   4. **launcher-heartbeat** — `/state/agent/<agent>/notion-launcher.heartbeat.json`
 *      fresh within last 60s (per-agent, in-container).
 *   5. **upstream-reachable** (only with `--deep`) — fires `GET
 *      /v1/users/me` against `api.notion.com` to verify the token
 *      and network. Costs a rate-limit token, so default-off.
 *
 * Rate-bucket-saturation probe (§9 #5) is deliberately omitted from
 * v1 — the bucket primitive shipped in PR 2 but the hook in PR 3
 * does not consume it yet (RFC §7's launcher-wrapping deferral), so
 * there are no events to report on. A follow-up PR will wire the
 * bucket through the hook AND add the saturation probe alongside.
 *
 * Filesystem access dependency-injected for branch coverage; mirrors
 * `doctor-microsoft.ts`.
 */

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  statSync as realStatSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";
import { checkIntegrationScaffoldWiring } from "./doctor-scaffold-wiring.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface NotionProbeDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf-8" | "utf8") => string;
  statSync?: (path: string) => { mtimeMs: number };
  homeDir?: () => string;
  /** Override clock for tests (default Date.now). */
  now?: () => number;
  /** Inject vault ACL reader for tests. Returns agents allowed to read the key, or null on broker unreachable. */
  vaultAclReader?: (
    key: string,
  ) => Promise<{ kind: "ok"; allow: string[] } | { kind: "unreachable"; msg: string } | { kind: "not_found" }>;
}

interface ResolvedDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8" | "utf8") => string;
  statSync: (path: string) => { mtimeMs: number };
  agentsDir: string;
  now: () => number;
  vaultAclReader: NonNullable<NotionProbeDeps["vaultAclReader"]>;
}

const HEARTBEAT_STALE_MS = 60 * 1000;

function resolveDeps(deps: NotionProbeDeps): ResolvedDeps {
  const home = deps.homeDir?.() ?? homedir();
  return {
    existsSync: deps.existsSync ?? realExistsSync,
    readFileSync: deps.readFileSync ?? realReadFileSync,
    statSync: deps.statSync ?? realStatSync,
    agentsDir: join(home, ".switchroom", "agents"),
    now: deps.now ?? Date.now,
    vaultAclReader:
      deps.vaultAclReader ??
      (async () => ({ kind: "unreachable", msg: "no default reader wired" })),
  };
}

/**
 * Agents that have `notion_workspace:` configured (any shape — empty
 * object or with databases filter). These are the agents the
 * launcher scaffolds for and the broker should grant the token to.
 */
export function computeNotionEnabledAgents(config: SwitchroomConfig): string[] {
  return Object.entries(config.agents ?? {})
    .filter(([, a]) => a && a.notion_workspace !== undefined)
    .map(([name]) => name);
}

// ────────────────────────────────────────────────────────────────────────
// Probe 1 + 2: config matrix (cheap, runs first)
// ────────────────────────────────────────────────────────────────────────

function checkConfigMatrix(config: SwitchroomConfig): CheckResult[] {
  const results: CheckResult[] = [];
  const agents = computeNotionEnabledAgents(config);

  if (agents.length === 0) {
    // No agent wants Notion — skip everything.
    return [];
  }

  if (!config.notion_workspace) {
    results.push({
      name: "notion:top-level-block-present",
      status: "fail",
      detail: `${agents.length} agent(s) have notion_workspace: set but the top-level notion_workspace: block is missing`,
      fix: "Add `notion_workspace:` to switchroom.yaml with at least `databases:` populated. Run `switchroom notion list-dbs` to print a template after putting the integration token in the vault.",
    });
    return results;
  }
  results.push({
    name: "notion:top-level-block-present",
    status: "ok",
  });

  // Per-agent DB references resolve in the friendly-name map.
  const known = new Set(
    Object.keys(config.notion_workspace.databases ?? {}),
  );
  let any = false;
  for (const name of agents) {
    const filter = config.agents?.[name]?.notion_workspace?.databases;
    if (!filter) continue;
    any = true;
    const missing = filter.filter((n) => !known.has(n));
    if (missing.length > 0) {
      results.push({
        name: `notion:db-references-resolvable:${name}`,
        status: "fail",
        detail: `agent '${name}' references unknown databases: ${missing.join(", ")}`,
        fix: `Add the database(s) to notion_workspace.databases in switchroom.yaml, or remove the references from agents.${name}.notion_workspace.databases. Run \`switchroom notion list-dbs\` to see UUIDs.`,
      });
    } else {
      results.push({
        name: `notion:db-references-resolvable:${name}`,
        status: "ok",
        detail: `${filter.length} db(s) all resolved`,
      });
    }
  }
  if (!any) {
    results.push({
      name: "notion:db-references-resolvable",
      status: "ok",
      detail: "no per-agent databases filter set; all admin-shaped",
    });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────
// Probe 3: vault-ACL drift
// ────────────────────────────────────────────────────────────────────────

async function checkVaultAclAligned(
  config: SwitchroomConfig,
  notionAgents: string[],
  d: ResolvedDeps,
): Promise<CheckResult[]> {
  if (notionAgents.length === 0) return [];
  const key =
    config.notion_workspace?.vault_key ?? "notion/integration-token";
  const acl = await d.vaultAclReader(key);
  if (acl.kind === "unreachable") {
    return [
      {
        name: "notion:vault-acl-aligned",
        status: "warn",
        detail: `vault-broker unreachable: ${acl.msg}`,
        fix: "Ensure the vault-broker is running and the operator socket is reachable, then re-run doctor.",
      },
    ];
  }
  if (acl.kind === "not_found") {
    return [
      {
        name: "notion:integration-token-present",
        status: "fail",
        detail: `vault key '${key}' is missing but ${notionAgents.length} agent(s) want Notion`,
        fix: `Create the Notion integration in Notion settings, then \`switchroom vault set ${key} --allow ${notionAgents.join(",")}\` on the host.`,
      },
    ];
  }
  const allowedSet = new Set(acl.allow);
  const results: CheckResult[] = [];
  results.push({
    name: "notion:integration-token-present",
    status: "ok",
    detail: `vault key '${key}' exists; ${acl.allow.length} agent(s) on ACL`,
  });
  for (const name of notionAgents) {
    if (!allowedSet.has(name)) {
      const updated = [...acl.allow, name].join(",");
      results.push({
        name: `notion:vault-acl-aligned:${name}`,
        status: "fail",
        detail: `agent '${name}' has notion_workspace: set but is NOT in the vault ACL for ${key} — launcher will 503 at runtime`,
        fix: `Re-run \`switchroom vault set ${key} --allow ${updated}\` on the host (vault set overwrites the scope, so re-state the full list including '${name}').`,
      });
    } else {
      results.push({
        name: `notion:vault-acl-aligned:${name}`,
        status: "ok",
      });
    }
  }
  // Inverse direction: an agent on the ACL that isn't in any per-
  // agent block. Benign waste; warn so the operator can clean up.
  for (const a of acl.allow) {
    if (!notionAgents.includes(a)) {
      const trimmed = acl.allow.filter((x) => x !== a).join(",");
      results.push({
        name: `notion:vault-acl-aligned:${a}`,
        status: "warn",
        detail: `agent '${a}' is on the vault ACL for ${key} but has no notion_workspace: block — never reads the token`,
        fix: trimmed.length > 0
          ? `Re-run \`switchroom vault set ${key} --allow ${trimmed}\` to drop '${a}' from the allowlist, or add a notion_workspace: block to agent '${a}' in switchroom.yaml.`
          : `Re-run \`switchroom vault set ${key} --allow ''\` to clear the allowlist (no other agent uses this key), or add a notion_workspace: block to agent '${a}' in switchroom.yaml.`,
      });
    }
  }
  return results;
}

// ────────────────────────────────────────────────────────────────────────
// Probe 4: launcher heartbeat
// ────────────────────────────────────────────────────────────────────────

function checkLauncherHeartbeat(
  notionAgents: string[],
  d: ResolvedDeps,
): CheckResult[] {
  if (notionAgents.length === 0) return [];
  const results: CheckResult[] = [];
  for (const name of notionAgents) {
    // Operator-side path mirrors agent-side: ~/.switchroom/agents/<name>/notion-launcher.heartbeat.json
    const heartbeatPath = join(
      d.agentsDir,
      name,
      "notion-launcher.heartbeat.json",
    );
    if (!d.existsSync(heartbeatPath)) {
      results.push({
        name: `notion:launcher-heartbeat:${name}`,
        status: "warn",
        detail: `heartbeat file missing at ${heartbeatPath}`,
        fix: `Verify the launcher started — \`switchroom agent restart ${name} --wait\` and check the agent's logs for "notion-mcp-launcher" stderr.`,
      });
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = d.statSync(heartbeatPath).mtimeMs;
    } catch (err) {
      results.push({
        name: `notion:launcher-heartbeat:${name}`,
        status: "warn",
        detail: `cannot stat heartbeat: ${(err as Error).message}`,
      });
      continue;
    }
    const age = d.now() - mtimeMs;
    if (age > HEARTBEAT_STALE_MS) {
      results.push({
        name: `notion:launcher-heartbeat:${name}`,
        status: "warn",
        detail: `heartbeat is ${Math.round(age / 1000)}s old (stale: >${HEARTBEAT_STALE_MS / 1000}s)`,
        fix: `Restart the agent: \`switchroom agent restart ${name} --wait\`.`,
      });
    } else {
      results.push({
        name: `notion:launcher-heartbeat:${name}`,
        status: "ok",
        detail: `heartbeat ${Math.round(age / 1000)}s old`,
      });
    }
  }
  return results;
}

// ────────────────────────────────────────────────────────────────────────
// Public — runNotionChecks
// ────────────────────────────────────────────────────────────────────────

export async function runNotionChecks(
  config: SwitchroomConfig,
  deps: NotionProbeDeps = {},
): Promise<CheckResult[]> {
  const notionAgents = computeNotionEnabledAgents(config);
  if (notionAgents.length === 0 && !config.notion_workspace) {
    // Notion integration not configured — skip silently.
    return [];
  }

  const d = resolveDeps(deps);
  const results: CheckResult[] = [];

  results.push(...checkConfigMatrix(config));

  // Only check vault ACL + heartbeat if config matrix passed enough to
  // know there's anything worth probing.
  if (notionAgents.length > 0 && config.notion_workspace) {
    results.push(...(await checkVaultAclAligned(config, notionAgents, d)));
    results.push(...checkLauncherHeartbeat(notionAgents, d));
    results.push(
      ...checkIntegrationScaffoldWiring({
        label: "notion",
        mcpKey: "notion",
        agents: notionAgents,
        agentsDir: d.agentsDir,
        deps: {
          existsSync: d.existsSync,
          readFileSync: (path: string) => d.readFileSync(path, "utf-8"),
        },
      }),
    );
  }

  return results;
}
