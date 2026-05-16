/**
 * Google Drive integration doctor checks (RFC G / RFC D / RFC E).
 *
 * The Drive integration shipped through ~10 production bugs, every one
 * of which was a SILENT or DEFERRED failure: the misconfiguration
 * produced no error at the layer that was wrong; it surfaced much later
 * as an opaque "agent has no Drive tools" / "Drive's blocked" symptom,
 * invisible to the operator until an agent was actually asked to use
 * Drive. `doctor` had ZERO Drive coverage, so none of it was catchable
 * up front.
 *
 * These probes convert that whole failure class into one upfront,
 * operator-visible section. Each check maps directly to a bug class
 * that escaped:
 *
 *   1. config matrix      — `google_accounts.<acct>.enabled_for[]` and
 *      per-agent `google_workspace.account` MUST agree, bidirectionally.
 *      Being in `enabled_for[]` is necessary-but-NOT-sufficient: the
 *      broker selects the account from the per-agent field and only
 *      then enforces the ACL, so an agent in `enabled_for[]` without
 *      the matching per-agent account fails `ACCOUNT_NOT_FOUND` and an
 *      agent with the account but not in `enabled_for[]` fails
 *      `ACCESS_DENIED`. This was the "works for 1 of 9 agents, no
 *      warning" finding.
 *   2. OAuth client       — a correctly-matrixed agent still can't
 *      start the MCP if `google_workspace.google_client_id/_secret`
 *      is unset (the launcher exits 1 — historically opaque).
 *   3. scaffold wiring     — for each Drive-enabled agent that HAS been
 *      scaffolded: the written `.mcp.json` must carry a `gdrive` entry
 *      WITH its sanitized env block (bug: Claude spawns MCP servers
 *      with a stripped env; without the block the launcher can't reach
 *      switchroom.yaml/the broker), and `.claude.json` must TRUST
 *      `gdrive` (bug: Claude silently ignores un-allowlisted .mcp.json
 *      servers — the C1 scaffold-ordering defect lived here).
 *
 * Filesystem access is dependency-injected so the unit tests drive
 * every branch without a real scaffold tree (mirrors
 * `doctor-auth-broker.ts`).
 */

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** FS injection seam. Tests pass fakes; production uses real syscalls. */
export interface DriveProbeDeps {
  /** Defaults to `resolveAgentsDir(config)`, resolved lazily + guarded. */
  agentsDir?: string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
}

interface ResolvedDeps {
  /** undefined when the agents dir can't be resolved (no switchroom block). */
  agentsDir: string | undefined;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
}

function resolveDeps(
  config: SwitchroomConfig,
  deps: DriveProbeDeps,
): ResolvedDeps {
  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    // Lazy + guarded: resolveAgentsDir reads config.switchroom.agents_dir
    // and throws if the block is absent. Doctor must never throw — a
    // missing agents dir downgrades the scaffold check to a warn.
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }
  return {
    agentsDir,
    existsSync: deps.existsSync ?? ((p) => realExistsSync(p)),
    readFileSync:
      deps.readFileSync ?? ((p) => realReadFileSync(p, "utf-8")),
  };
}

/** Per-agent google_workspace.account, normalized the way the schema does. */
function agentAccount(
  config: SwitchroomConfig,
  name: string,
): string | undefined {
  const raw = config.agents?.[name]?.google_workspace?.account;
  return typeof raw === "string" && raw.length > 0
    ? raw.trim().toLowerCase()
    : undefined;
}

/** True if a top-level OAuth client value is present (literal or vault: ref). */
function clientValuePresent(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Check 1 — bidirectional config-matrix consistency. The single
 * highest-value Drive probe: it is the difference between "config looks
 * like N agents are enabled" and "N agents actually work".
 */
function checkConfigMatrix(config: SwitchroomConfig): CheckResult[] {
  const accounts = config.google_accounts;
  if (!accounts || Object.keys(accounts).length === 0) {
    return [
      {
        name: "drive: google_accounts configured",
        status: "ok",
        detail: "no google_accounts block — Drive integration not in use",
      },
    ];
  }

  const results: CheckResult[] = [];

  // Forward: every agent listed in an account's enabled_for[] must point
  // its per-agent google_workspace.account back at that account.
  for (const [acct, entry] of Object.entries(accounts)) {
    const enabledFor = entry?.enabled_for ?? [];
    for (const name of enabledFor) {
      const have = agentAccount(config, name);
      if (have === acct) {
        results.push({
          name: `drive: ${name} ↔ ${acct}`,
          status: "ok",
          detail: "enabled_for[] and google_workspace.account agree",
        });
      } else {
        results.push({
          name: `drive: ${name} ↔ ${acct}`,
          status: "fail",
          detail:
            have === undefined
              ? `'${name}' is in google_accounts['${acct}'].enabled_for[] but has no agents.${name}.google_workspace.account — the broker rejects it (ACCOUNT_NOT_FOUND) and Drive silently never works for this agent`
              : `'${name}' is in enabled_for['${acct}'] but its google_workspace.account is '${have}' — mismatch; the broker will not return '${acct}' creds for it`,
          fix: `set agents.${name}.google_workspace.account: ${acct} in switchroom.yaml, then \`switchroom update\``,
        });
      }
    }
  }

  // Reverse: an agent that points at an account but isn't in its
  // enabled_for[] fails ACCESS_DENIED at the broker.
  for (const name of Object.keys(config.agents ?? {})) {
    const acct = agentAccount(config, name);
    if (!acct) continue;
    const entry = accounts[acct];
    if (!entry) {
      results.push({
        name: `drive: ${name} → ${acct}`,
        status: "fail",
        detail: `agents.${name}.google_workspace.account is '${acct}' but there is no google_accounts['${acct}'] block`,
        fix: `add a google_accounts['${acct}'] entry with enabled_for: [${name}], or remove the per-agent account`,
      });
    } else if (!(entry.enabled_for ?? []).includes(name)) {
      results.push({
        name: `drive: ${name} → ${acct}`,
        status: "fail",
        detail: `agents.${name}.google_workspace.account is '${acct}' but '${name}' is not in that account's enabled_for[] — the broker denies it (ACCESS_DENIED)`,
        fix: `add '${name}' to google_accounts['${acct}'].enabled_for[] in switchroom.yaml`,
      });
    }
  }

  return results;
}

/**
 * Check 2 — OAuth client presence. Only meaningful if at least one
 * agent is correctly matrixed (otherwise Drive isn't in use).
 */
function checkOAuthClient(
  config: SwitchroomConfig,
  anyDriveAgent: boolean,
): CheckResult[] {
  if (!anyDriveAgent) return [];
  const gw = config.google_workspace;
  const idOk = clientValuePresent(gw?.google_client_id);
  const secretOk = clientValuePresent(gw?.google_client_secret);
  if (idOk && secretOk) {
    return [
      {
        name: "drive: OAuth client configured",
        status: "ok",
        detail: "google_client_id + google_client_secret set",
      },
    ];
  }
  return [
    {
      name: "drive: OAuth client configured",
      status: "fail",
      detail: `google_workspace.${!idOk ? "google_client_id" : "google_client_secret"} is unset/empty — the launcher exits 1 before spawning the MCP`,
      fix: "set google_workspace.google_client_id and google_client_secret (literal or vault: ref) in switchroom.yaml",
    },
  ];
}

/**
 * Check 3 — deployed scaffold wiring for each correctly-matrixed agent
 * that has been scaffolded. Surfaces bug-8 (missing env block) and
 * bug-9 / the C1 ordering defect (gdrive not in enabledMcpjsonServers)
 * in the actual on-disk state, not just the config.
 */
function checkScaffoldWiring(
  config: SwitchroomConfig,
  driveAgents: string[],
  d: ResolvedDeps,
): CheckResult[] {
  const results: CheckResult[] = [];
  if (d.agentsDir === undefined) {
    return [
      {
        name: "drive: scaffold wiring",
        status: "warn",
        detail:
          "could not resolve the agents directory (no switchroom block) — skipped scaffold wiring check",
      },
    ];
  }
  for (const name of driveAgents) {
    const agentDir = resolve(d.agentsDir, name);
    if (!d.existsSync(agentDir)) {
      results.push({
        name: `drive: ${name} scaffold`,
        status: "warn",
        detail: `${agentDir} not scaffolded yet — run \`switchroom apply\``,
      });
      continue;
    }

    // .mcp.json must carry gdrive WITH a non-empty env block.
    const mcpPath = join(agentDir, ".mcp.json");
    let mcpOk = false;
    let mcpDetail = "no .mcp.json";
    if (d.existsSync(mcpPath)) {
      try {
        const mcp = JSON.parse(d.readFileSync(mcpPath));
        const g = mcp?.mcpServers?.gdrive;
        if (!g) {
          mcpDetail = ".mcp.json has no gdrive server";
        } else if (!g.env || Object.keys(g.env).length === 0) {
          mcpDetail =
            "gdrive entry has no env block — Claude spawns MCP with a sanitized env; the launcher can't reach switchroom.yaml/the broker (bug-8 class)";
        } else {
          mcpOk = true;
        }
      } catch {
        mcpDetail = ".mcp.json is unparseable";
      }
    }

    // .claude.json must TRUST gdrive under the agent's project key.
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    let trustOk = false;
    let trustDetail = "no .claude/.claude.json";
    if (d.existsSync(claudeJsonPath)) {
      try {
        const cj = JSON.parse(d.readFileSync(claudeJsonPath));
        const proj = cj?.projects?.[resolve(agentDir)];
        const enabled: unknown = proj?.enabledMcpjsonServers;
        if (Array.isArray(enabled) && enabled.includes("gdrive")) {
          trustOk = true;
        } else {
          trustDetail =
            "gdrive not in projects[].enabledMcpjsonServers — Claude silently ignores the un-allowlisted server (bug-9 / scaffold-ordering class)";
        }
      } catch {
        trustDetail = ".claude.json is unparseable";
      }
    }

    if (mcpOk && trustOk) {
      results.push({
        name: `drive: ${name} scaffold`,
        status: "ok",
        detail: "gdrive wired in .mcp.json (with env) and trusted in .claude.json",
      });
    } else {
      results.push({
        name: `drive: ${name} scaffold`,
        status: "fail",
        detail: !mcpOk ? mcpDetail : trustDetail,
        fix: "`switchroom agent restart " + name + "` (reconcile regenerates .mcp.json + re-trusts); if it persists, this is a scaffold bug — report it",
      });
    }
  }
  return results;
}

/**
 * Run all Drive checks. Returns [] when Drive is entirely unused (no
 * google_accounts AND no agent with google_workspace.account) so the
 * section stays silent on installs that don't use Drive.
 */
export function runDriveChecks(
  config: SwitchroomConfig,
  deps: DriveProbeDeps = {},
): CheckResult[] {
  const accounts = config.google_accounts;
  const anyAgentAccount = Object.keys(config.agents ?? {}).some(
    (n) => agentAccount(config, n) !== undefined,
  );
  const accountsConfigured =
    !!accounts && Object.keys(accounts).length > 0;
  if (!accountsConfigured && !anyAgentAccount) {
    return [];
  }

  const d = resolveDeps(config, deps);
  const results: CheckResult[] = [];

  const matrix = checkConfigMatrix(config);
  results.push(...matrix);

  // An agent is "Drive-enabled" only when BOTH sides of the matrix
  // agree — that's exactly the set the launcher will succeed for.
  const driveAgents = Object.keys(config.agents ?? {}).filter((name) => {
    const acct = agentAccount(config, name);
    return (
      !!acct &&
      !!accounts?.[acct] &&
      (accounts[acct].enabled_for ?? []).includes(name)
    );
  });

  results.push(...checkOAuthClient(config, driveAgents.length > 0));
  results.push(...checkScaffoldWiring(config, driveAgents, d));

  return results;
}
