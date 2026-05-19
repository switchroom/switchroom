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
import { homedir } from "node:os";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { vaultRefKey } from "../config/google-workspace-acl.js";

import type { CheckStatus } from "./doctor-status.js";
import { defaultPreflight, type PreflightOutcome } from "./doctor-secret-access.js";

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
  /**
   * Operator-socket preflight RPC, used only by
   * `runDriveBrokerReachabilityChecks`. Defaults to the shared
   * `defaultPreflight` over `~/.switchroom/broker-operator/sock` (same
   * client `runSecretAccessChecks` uses). Injectable for tests.
   */
  preflight?: (agent: string, keys: string[]) => Promise<PreflightOutcome>;
  /** Override the broker operator socket path (tests). */
  brokerOperatorSocket?: string;
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

    // Read both scaffold artifacts. In the canonical docker topology
    // these are mode-0600 files owned by the per-agent UID, while
    // `doctor` runs as the host operator — so the host genuinely
    // cannot read them (EACCES). That is NOT a scaffold failure: the
    // agent process reads them fine. Mirror the doctor-auth-broker
    // "unverifiable from host" contract — one honest warn per agent —
    // rather than crying a false `fail`. Only a file we COULD read but
    // that is corrupt / mis-wired is a real `fail`.
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");

    const mcpRead = readJson(d, mcpPath);
    const trustRead = readJson(d, claudeJsonPath);

    if (mcpRead.kind === "unreadable" || trustRead.kind === "unreadable") {
      results.push({
        name: `drive: ${name} scaffold`,
        status: "skip",
        detail:
          "scaffold files are agent-UID-owned (mode 0600) — unverifiable from the host operator; the agent process reads them fine. Verify in-container if needed: `docker exec switchroom-" +
          name +
          " sh -lc 'python3 -m json.tool /state/agent/.mcp.json >/dev/null && echo ok'`",
      });
      continue;
    }

    // .mcp.json must carry gdrive WITH a non-empty env block.
    let mcpOk = false;
    let mcpDetail = "no .mcp.json";
    if (mcpRead.kind === "ok") {
      const g = mcpRead.data?.mcpServers?.gdrive;
      if (!g) {
        mcpDetail = ".mcp.json has no gdrive server";
      } else if (!g.env || Object.keys(g.env).length === 0) {
        mcpDetail =
          "gdrive entry has no env block — Claude spawns MCP with a sanitized env; the launcher can't reach switchroom.yaml/the broker (bug-8 class)";
      } else {
        mcpOk = true;
      }
    } else if (mcpRead.kind === "corrupt") {
      mcpDetail = ".mcp.json exists but is not valid JSON (corrupt)";
    }

    // .claude.json must TRUST gdrive under the agent's project key.
    let trustOk = false;
    let trustDetail = "no .claude/.claude.json";
    if (trustRead.kind === "ok") {
      const proj = trustRead.data?.projects?.[resolve(agentDir)];
      const enabled: unknown = proj?.enabledMcpjsonServers;
      if (Array.isArray(enabled) && enabled.includes("gdrive")) {
        trustOk = true;
      } else {
        trustDetail =
          "gdrive not in projects[].enabledMcpjsonServers — Claude silently ignores the un-allowlisted server (bug-9 / scaffold-ordering class)";
      }
    } else if (trustRead.kind === "corrupt") {
      trustDetail = ".claude.json exists but is not valid JSON (corrupt)";
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

type ReadJsonResult =
  | { kind: "ok"; data: any }
  | { kind: "absent" }
  | { kind: "unreadable" } // exists but host can't read it (EACCES/EPERM)
  | { kind: "corrupt" }; // read OK but not valid JSON

/**
 * Read + parse a JSON file, classifying the failure mode. The
 * EACCES/EPERM split is load-bearing: in docker the scaffold artifacts
 * are agent-UID-owned 0600 and the host operator running `doctor`
 * cannot read them — that must NOT read as corruption/failure.
 */
function readJson(d: ResolvedDeps, path: string): ReadJsonResult {
  if (!d.existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = d.readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") return { kind: "unreadable" };
    // Any other read error (e.g. the file vanished mid-check) — treat
    // as absent rather than corrupt; we have no parsed content to judge.
    return { kind: "absent" };
  }
  try {
    return { kind: "ok", data: JSON.parse(raw) };
  } catch {
    return { kind: "corrupt" };
  }
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

  const driveAgents = computeDriveAgents(config);

  results.push(...checkOAuthClient(config, driveAgents.length > 0));
  results.push(...checkScaffoldWiring(config, driveAgents, d));

  return results;
}

/**
 * The "Drive-enabled" set: agents where BOTH sides of the matrix agree
 * (per-agent `google_workspace.account` set AND that account lists the
 * agent in `google_accounts.<acct>.enabled_for[]`). Exactly the set the
 * launcher succeeds for — and the set the broker now grants the OAuth
 * client credential (RFC G §4.4, v0.12.14). Shared by the sync
 * config/scaffold checks and the async broker-reachability check so the
 * two can never disagree about which agents to probe.
 */
function computeDriveAgents(config: SwitchroomConfig): string[] {
  const accounts = config.google_accounts;
  return Object.keys(config.agents ?? {}).filter((name) => {
    const acct = agentAccount(config, name);
    return (
      !!acct &&
      !!accounts?.[acct] &&
      (accounts[acct].enabled_for ?? []).includes(name)
    );
  });
}

/**
 * Check 4 — does the broker actually SERVE the OAuth client credential?
 *
 * `checkOAuthClient` only proves the value is *present in config*. When
 * it's a `vault:` ref (the documented `switchroom auth google connect`
 * shape) the launcher resolves it through the vault-broker — and before
 * v0.12.14 the broker denied it fleet-wide (the client cred was the one
 * piece of the Drive auth flow outside both `schedule.secrets` and the
 * RFC G §4.4 account-slot grant), so the `gdrive` MCP silently never
 * spawned while every config/scaffold/trust check stayed green. THIS is
 * the blind spot that let that ship. We ask the broker the same
 * question it answers at runtime (`preflight_access` → full
 * `checkAclByAgent`, which includes the v0.12.14 client-cred clause),
 * using the SAME key-extraction (`vaultRefKey`) the broker authorizes
 * against, so the verdict matches enforcement exactly.
 *
 * Literal (non-`vault:`) creds need no broker — reported ok. Broker
 * locked / unreachable → `skip` (never a false fail; a static miss does
 * not prove the agent lacks access — mirrors runSecretAccessChecks).
 *
 * Async + separate from `runDriveChecks` (which stays sync) so the
 * broker RPC doesn't change that function's signature or its tests;
 * `doctor.ts` composes both into the one "Google Drive" section, the
 * same shape it already uses for the async `runSecretAccessChecks`.
 */
export async function runDriveBrokerReachabilityChecks(
  config: SwitchroomConfig,
  deps: DriveProbeDeps = {},
): Promise<CheckResult[]> {
  const driveAgents = computeDriveAgents(config);
  if (driveAgents.length === 0) return [];

  const gw = config.google_workspace;
  const idKey = vaultRefKey(gw?.google_client_id);
  const secretKey = vaultRefKey(gw?.google_client_secret);
  const vaultKeys = [idKey, secretKey].filter((k): k is string => k !== null);

  if (vaultKeys.length === 0) {
    // Both creds are literals (or unset — checkOAuthClient fails that
    // case separately). A literal is read straight from config by the
    // launcher; the broker is never consulted, so nothing to verify.
    return [
      {
        name: "drive: OAuth client broker-reachable",
        status: "ok",
        detail:
          "client credential is a literal (not a vault: ref) — the launcher reads it from config; no broker grant needed",
      },
    ];
  }

  const sock =
    deps.brokerOperatorSocket ??
    join(homedir(), ".switchroom", "broker-operator", "sock");
  const preflight =
    deps.preflight ?? ((a: string, k: string[]) => defaultPreflight(sock, a, k));

  const results: CheckResult[] = [];
  for (const agent of driveAgents) {
    const outcome = await preflight(agent, vaultKeys);
    if (outcome.kind === "locked") {
      results.push({
        name: `drive: ${agent} client-cred broker-reachable`,
        status: "skip",
        detail:
          "vault-broker is locked — cannot verify; the fleet's launchers/crons are dead while locked anyway (not a Drive-specific fault)",
      });
      continue;
    }
    if (outcome.kind === "unreachable") {
      results.push({
        name: `drive: ${agent} client-cred broker-reachable`,
        status: "skip",
        detail: `broker operator socket unreachable (${outcome.msg}) — cannot verify; not a false fail`,
      });
      continue;
    }
    const denied = outcome.results.filter((r) => !r.acl_ok);
    if (denied.length === 0) {
      results.push({
        name: `drive: ${agent} client-cred broker-reachable`,
        status: "ok",
        detail: `vault-broker will serve the OAuth client credential (${vaultKeys.join(", ")}) to '${agent}'`,
      });
      continue;
    }
    const d0 = denied[0];
    results.push({
      name: `drive: ${agent} client-cred broker-reachable`,
      status: "fail",
      detail: `vault-broker DENIES '${agent}' the OAuth client key '${d0.key}' (${d0.acl_reason ?? "no ACL grant"}) — the gdrive MCP launcher exits before spawning and Drive silently never works for this agent`,
      fix: `confirm '${agent}' is in google_accounts[<account>].enabled_for[] and has agents.${agent}.google_workspace.account set (v0.12.14+ broker grants the client credential off that gate automatically); then ensure the broker is running the v0.12.14+ image`,
    });
  }
  return results;
}
