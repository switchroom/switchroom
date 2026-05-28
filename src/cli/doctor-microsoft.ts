/**
 * Microsoft 365 integration doctor checks — RFC #1873 §9 PR 5.
 *
 * Mirrors `doctor-drive.ts` shape (RFC G probes) but smaller in scope —
 * MS-365 integration is v1 with weak attestation, no upstream MCP
 * tier-knob, no per-doc anchor resolution. Probes:
 *
 *   1. **config matrix** — per-agent `microsoft_workspace.account` and
 *      top-level `microsoft_accounts.<account>.enabled_for[]` MUST
 *      agree. Same failure class Google had ("works for 1 of 9 agents,
 *      no warning"): broker selects account from per-agent config, then
 *      enforces ACL; mismatch fails ACCOUNT_NOT_FOUND or ACCESS_DENIED
 *      silently until agent first calls a MS tool. Catch upfront.
 *   2. **OAuth client configured** — `microsoft_workspace.microsoft_client_id`
 *      must be set when any agent has the matrix aligned. Client secret
 *      is OPTIONAL (public-client apps don't need one); we only warn if
 *      it's absent AND any agent uses a vault: ref that resolves to it.
 *   3. **launcher heartbeat alive** — for each MS-enabled agent, check
 *      that `~/.switchroom/agents/<name>/m365-launcher.heartbeat.json`
 *      exists and `nextRefreshMs` is in the future. Stale heartbeat
 *      indicates the launcher's refresh loop has died.
 *   4. **personal-MSA Graph smoke (manual)** — surfaced as INFO note for
 *      personal-MSA accounts; some Graph endpoints silently no-op on
 *      consumer tokens. Cannot probe automatically without a live
 *      access token; surfaced in detail so operators know to UAT-verify.
 *
 * Filesystem access is dependency-injected for unit-test branch
 * coverage (mirrors `doctor-drive.ts` shape).
 */

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
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

export interface MicrosoftProbeDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf-8" | "utf8") => string;
  homeDir?: () => string;
  /** Override clock for tests (default Date.now). */
  now?: () => number;
}

interface ResolvedDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8" | "utf8") => string;
  agentsDir: string;
  now: () => number;
}

function resolveDeps(deps: MicrosoftProbeDeps): ResolvedDeps {
  const home = deps.homeDir?.() ?? homedir();
  return {
    existsSync: deps.existsSync ?? realExistsSync,
    readFileSync: deps.readFileSync ?? realReadFileSync,
    agentsDir: join(home, ".switchroom", "agents"),
    now: deps.now ?? Date.now,
  };
}

/**
 * Pull per-agent Microsoft account from config. Handles missing
 * `microsoft_workspace` block + missing account field gracefully.
 */
function agentMicrosoftAccount(
  config: SwitchroomConfig,
  agentName: string,
): string | undefined {
  const agent = config.agents?.[agentName];
  if (!agent) return undefined;
  return agent.microsoft_workspace?.account;
}

function clientValuePresent(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

// ────────────────────────────────────────────────────────────────────────
// Check: config matrix alignment
// ────────────────────────────────────────────────────────────────────────

function checkConfigMatrix(config: SwitchroomConfig): CheckResult[] {
  const results: CheckResult[] = [];
  const accounts = config.microsoft_accounts ?? {};

  // Forward direction: per-agent account → must exist in microsoft_accounts
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    const acct = agent.microsoft_workspace?.account;
    if (!acct) continue;
    const entry = accounts[acct];
    if (!entry) {
      results.push({
        name: `microsoft:matrix:${name}`,
        status: "fail",
        detail: `agent '${name}' has microsoft_workspace.account=${acct} but no microsoft_accounts.${acct} block`,
        fix: `Run 'switchroom auth microsoft account add ${acct}' to register, then 'switchroom auth microsoft enable ${acct} ${name}'.`,
      });
      continue;
    }
    if (!(entry.enabled_for ?? []).includes(name)) {
      results.push({
        name: `microsoft:matrix:${name}`,
        status: "fail",
        detail: `agent '${name}' is selected to use microsoft account ${acct}, but not listed in microsoft_accounts.${acct}.enabled_for[]`,
        fix: `Run 'switchroom auth microsoft enable ${acct} ${name}' to grant access.`,
      });
      continue;
    }
    results.push({
      name: `microsoft:matrix:${name}`,
      status: "ok",
      detail: `agent '${name}' aligned with account ${acct}`,
    });
  }

  // Reverse direction: enabled_for[] members → must each have the per-agent account set
  for (const [acct, entry] of Object.entries(accounts)) {
    for (const name of entry.enabled_for ?? []) {
      const agentAcct = agentMicrosoftAccount(config, name);
      if (agentAcct !== acct) {
        const got = agentAcct ?? "(unset)";
        results.push({
          name: `microsoft:matrix:reverse:${name}:${acct}`,
          status: "fail",
          detail: `microsoft_accounts.${acct}.enabled_for[] includes '${name}', but agent's microsoft_workspace.account is '${got}' — broker will return ACCOUNT_NOT_FOUND for this agent`,
          fix: `Either set agents.${name}.microsoft_workspace.account=${acct}, or remove '${name}' from microsoft_accounts.${acct}.enabled_for[] via 'switchroom auth microsoft disable ${acct} ${name}'.`,
        });
      }
    }
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────
// Check: OAuth client configured
// ────────────────────────────────────────────────────────────────────────

function checkOAuthClient(
  config: SwitchroomConfig,
  anyAgentEnabled: boolean,
): CheckResult[] {
  if (!anyAgentEnabled) return [];

  const mw = config.microsoft_workspace;
  if (!mw) {
    return [
      {
        name: "microsoft:oauth-client-configured",
        status: "fail",
        detail:
          "agents have microsoft_workspace.account set but the top-level microsoft_workspace: block is missing",
        fix: "Add a microsoft_workspace block with microsoft_client_id (and optionally microsoft_client_secret) to switchroom.yaml. See `switchroom auth microsoft account add` error output for the full walkthrough.",
      },
    ];
  }
  if (!clientValuePresent(mw.microsoft_client_id)) {
    return [
      {
        name: "microsoft:oauth-client-configured",
        status: "fail",
        detail:
          "microsoft_workspace block present but microsoft_client_id is empty",
        fix: "Register an Entra app at https://entra.microsoft.com → App registrations → New. Copy the Application (client) ID and vault it: `switchroom vault set microsoft-oauth-client-id`.",
      },
    ];
  }
  return [
    {
      name: "microsoft:oauth-client-configured",
      status: "ok",
      detail: clientValuePresent(mw.microsoft_client_secret)
        ? "microsoft_client_id + microsoft_client_secret present (confidential client)"
        : "microsoft_client_id present (public-client app, no secret)",
    },
  ];
}

// ────────────────────────────────────────────────────────────────────────
// Check: launcher heartbeat
// ────────────────────────────────────────────────────────────────────────

interface LauncherHeartbeat {
  lastRefreshMs: number;
  nextRefreshMs: number;
  expiresAtMs: number;
}

function readHeartbeat(
  d: ResolvedDeps,
  agentName: string,
): LauncherHeartbeat | { error: string } {
  const path = join(d.agentsDir, agentName, "m365-launcher.heartbeat.json");
  if (!d.existsSync(path)) {
    return { error: "heartbeat file missing — launcher has not yet started" };
  }
  try {
    const raw = d.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LauncherHeartbeat>;
    if (
      typeof parsed.lastRefreshMs !== "number" ||
      typeof parsed.nextRefreshMs !== "number" ||
      typeof parsed.expiresAtMs !== "number"
    ) {
      return { error: "heartbeat file malformed (missing required numeric fields)" };
    }
    return parsed as LauncherHeartbeat;
  } catch (err) {
    return { error: `heartbeat parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkLauncherHeartbeat(
  msEnabledAgents: string[],
  d: ResolvedDeps,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const name of msEnabledAgents) {
    const hb = readHeartbeat(d, name);
    if ("error" in hb) {
      results.push({
        name: `microsoft:launcher-heartbeat:${name}`,
        status: "warn",
        detail: `${hb.error} (path: ~/.switchroom/agents/${name}/m365-launcher.heartbeat.json)`,
        fix: `Launcher writes the heartbeat on its first refresh tick. If agent has been running for >5min and the file is still missing, check the launcher log via 'docker logs switchroom-${name}'.`,
      });
      continue;
    }
    const now = d.now();
    const ageSinceLastRefresh = now - hb.lastRefreshMs;
    const untilNextRefresh = hb.nextRefreshMs - now;
    // A "stale" heartbeat: last refresh > 90min ago (60min token + 30min slack),
    // OR nextRefreshMs in the past (refresh tick didn't fire when scheduled).
    if (ageSinceLastRefresh > 90 * 60 * 1000) {
      results.push({
        name: `microsoft:launcher-heartbeat:${name}`,
        status: "fail",
        detail: `last refresh was ${Math.round(ageSinceLastRefresh / 60000)}min ago (>90min) — launcher refresh loop appears dead`,
        fix: `Restart the agent: 'switchroom agent restart ${name}'. If problem recurs, check launcher logs for broker/network failures.`,
      });
    } else if (untilNextRefresh < -5 * 60 * 1000) {
      results.push({
        name: `microsoft:launcher-heartbeat:${name}`,
        status: "warn",
        detail: `nextRefreshMs was ${Math.round(-untilNextRefresh / 60000)}min ago — refresh tick missed its scheduled time`,
        fix: `Tick is overdue but not yet stale. Monitor; if it doesn't update within a few minutes, restart the agent.`,
      });
    } else {
      results.push({
        name: `microsoft:launcher-heartbeat:${name}`,
        status: "ok",
        detail: `last refresh ${Math.round(ageSinceLastRefresh / 60000)}min ago, next in ${Math.round(untilNextRefresh / 60000)}min`,
      });
    }
  }
  return results;
}

// ────────────────────────────────────────────────────────────────────────
// Public — runMicrosoftChecks
// ────────────────────────────────────────────────────────────────────────

/**
 * The set of agents that have both per-agent `microsoft_workspace.account`
 * AND are listed in `microsoft_accounts.<account>.enabled_for[]`. Exactly
 * the set the launcher succeeds for + the broker grants creds to. Shared
 * by config + heartbeat checks.
 */
export function computeMicrosoftEnabledAgents(
  config: SwitchroomConfig,
): string[] {
  // Implicit normalization invariant: both `microsoft_workspace.account`
  // (per-agent) and the `microsoft_accounts` map keys are transformed
  // via `.trim().toLowerCase()` at schema parse time (src/config/schema.ts
  // AgentMicrosoftWorkspaceConfigSchema + microsoft_accounts record
  // key validator). So a raw === comparison here is safe — both sides
  // are already canonicalized when the config reaches us. If that schema
  // invariant ever weakens, route through `shouldEmitMs365Mcp` from
  // `src/config/microsoft-workspace-acl.ts` (which re-normalizes
  // defensively) to keep this in sync with the scaffold gate.
  const accounts = config.microsoft_accounts ?? {};
  return Object.keys(config.agents ?? {}).filter((name) => {
    const acct = agentMicrosoftAccount(config, name);
    return (
      !!acct &&
      !!accounts[acct] &&
      (accounts[acct].enabled_for ?? []).includes(name)
    );
  });
}

export function runMicrosoftChecks(
  config: SwitchroomConfig,
  deps: MicrosoftProbeDeps = {},
): CheckResult[] {
  const accounts = config.microsoft_accounts;
  const anyAgentAccount = Object.keys(config.agents ?? {}).some(
    (n) => agentMicrosoftAccount(config, n) !== undefined,
  );
  const accountsConfigured =
    !!accounts && Object.keys(accounts).length > 0;
  if (!accountsConfigured && !anyAgentAccount && !config.microsoft_workspace) {
    // MS-365 integration not configured — skip silently.
    return [];
  }

  const d = resolveDeps(deps);
  const results: CheckResult[] = [];

  results.push(...checkConfigMatrix(config));

  const msAgents = computeMicrosoftEnabledAgents(config);
  results.push(...checkOAuthClient(config, msAgents.length > 0));
  results.push(...checkLauncherHeartbeat(msAgents, d));
  results.push(
    ...checkIntegrationScaffoldWiring({
      label: "microsoft",
      mcpKey: "ms-365",
      agents: msAgents,
      agentsDir: d.agentsDir,
      deps: {
        existsSync: d.existsSync,
        readFileSync: (path: string) => d.readFileSync(path, "utf-8"),
      },
    }),
  );

  return results;
}
