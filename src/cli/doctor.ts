import type { Command } from "commander";
import chalk from "chalk";

import { type CheckStatus, statusGlyph } from "./doctor-status.js";
import { execSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPublicKey, createPrivateKey } from "node:crypto";
import { listSecrets, getStringSecret } from "../vault/vault.js";
import { resolveAgentsDir, resolvePath } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { assessThinkingEffortRisk } from "../config/thinking-effort-risk.js";
import { resolveStatePath, LEGACY_STATE_DIR } from "../config/paths.js";
import { getConfig, getConfigPath, withConfigError } from "./helpers.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { readQuarantineMarkerForAgent } from "../agents/quarantine.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getSlotInfos, type SlotInfo } from "../auth/accounts.js";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import { loadManifest, detectDrift, type DriftProbers } from "../manifest.js";
import { probeHindsight, isHindsightEnabled, fetchHindsightToolsList } from "../memory/hindsight.js";
import { inspectBankHealth, staleMentalModels, corruptedMentalModels, recentUnextracted, ageDays } from "../memory/bank-health.js";
import { checkHindsightContainerHealth, classifyToolContract } from "./doctor-memory.js";
import { isDockerMode, runDockerChecks } from "./doctor-docker.js";
import { runAuthBrokerChecks } from "./doctor-auth-broker.js";
import { runHostdChecks } from "./doctor-hostd.js";
import { runDriveChecks, runDriveBrokerReachabilityChecks } from "./doctor-drive.js";
import { runWebkiteChecks } from "./doctor-webkite.js";
import { runCronSessionChecks } from "./doctor-cron-session.js";
import { runMicrosoftChecks } from "./doctor-microsoft.js";
import { runNotionChecks } from "./doctor-notion.js";
import { runMcpSecretChecks } from "./doctor-mcp-secrets.js";
import { runContextChecks } from "./doctor-context.js";
import { runCredentialsMigrationChecks } from "./doctor-credentials-migration.js";
import { runSecretAccessChecks } from "./doctor-secret-access.js";
import { runInlinedSecretChecks } from "./doctor-inlined-secrets.js";
import { runAuditIntegrityChecks } from "./doctor-audit-integrity.js";
import { runAgentSmokeChecks } from "./doctor-agent-smoke.js";
import { runVaultBrokerDurabilityChecks } from "./doctor-vault-broker-durability.js";

/**
 * Result of a single doctor check.
 * `CheckStatus` + `statusGlyph` live in ./doctor-status.ts (imported
 * above) so the 9 doctor modules share one definition.
 */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/**
 * Search ~/.nvm/versions/node/*\/bin for a binary. Returns the path or null.
 *
 * Doctor runs in a non-login shell where nvm.sh has not been sourced, so
 * `command -v node` would otherwise miss nvm-installed Node and anything
 * installed globally via that Node (claude, npm, npx, etc.).
 */
function findInNvm(bin: string): string | null {
  const nvmRoot = join(process.env.HOME ?? "", ".nvm", "versions", "node");
  if (!existsSync(nvmRoot)) return null;
  try {
    const versions = readdirSync(nvmRoot).sort().reverse(); // newest first
    for (const v of versions) {
      const candidate = join(nvmRoot, v, "bin", bin);
      try {
        const s = statSync(candidate);
        if (s.isFile() || s.isSymbolicLink()) {
          return candidate;
        }
      } catch { /* not in this version */ }
    }
  } catch { /* unreadable */ }
  return null;
}

/**
 * Check whether a binary is on PATH. Returns the resolved path or null.
 *
 * Falls back to scanning ~/.nvm/versions/node/* for nvm-installed binaries
 * since doctor runs in a non-login shell.
 */
function which(bin: string): string | null {
  try {
    const out = execSync(`command -v ${bin}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out) return out;
  } catch { /* not on PATH */ }

  // Fallback: nvm
  return findInNvm(bin);
}

function checkBinary(
  name: string,
  bin: string,
  installHint: string,
): CheckResult {
  const path = which(bin);
  if (!path) {
    return {
      name,
      status: "fail",
      detail: `\`${bin}\` not on PATH`,
      fix: installHint,
    };
  }
  return { name, status: "ok", detail: path };
}

/**
 * Check that a TCP host:port is reachable. Returns ok/fail.
 */
function checkTcp(host: string, port: number): boolean {
  try {
    // Use bash /dev/tcp redirect — no extra deps
    execSync(
      `timeout 2 bash -c '</dev/tcp/${host}/${port}'`,
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}

function checkDependencies(): CheckResult[] {
  return [
    checkBinary(
      "claude CLI",
      "claude",
      "npm install -g @anthropic-ai/claude-code",
    ),
    checkBinary(
      "bun",
      "bun",
      'curl -fsSL https://bun.sh/install | bash',
    ),
    checkBinary("node", "node", "Install Node 22+ via nvm"),
    checkBinary("tmux", "tmux", "sudo apt install tmux"),
    checkBinary(
      "expect",
      "expect",
      "sudo apt install expect (only required for switchroom-telegram plugin agents)",
    ),
    checkBinary("docker", "docker", "Install Docker (required for Switchroom's runtime)"),
  ];
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse `Python X.Y.Z` output from `python3 --version`. Returns null if
 * the string does not look like a recognizable Python version banner.
 * @internal exported for testing
 */
export function parsePythonVersion(output: string): SemVer | null {
  const match = output.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
  };
}

/**
 * Parse `vX.Y.Z` output from `node --version`. Returns null if the string
 * does not look like a recognizable node version banner.
 * @internal exported for testing
 */
export function parseNodeVersion(output: string): SemVer | null {
  const match = output.trim().match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function semverAtLeast(v: SemVer, major: number, minor = 0): boolean {
  if (v.major > major) return true;
  if (v.major < major) return false;
  return v.minor >= minor;
}

/**
 * Runs `<bin> --version` and returns the parsed version and raw output.
 * Returns null when the binary is not on PATH or exits non-zero.
 */
function readVersion(
  bin: string,
  parser: (output: string) => SemVer | null,
): { semver: SemVer | null; raw: string; path: string } | null {
  const path = which(bin);
  if (!path) return null;
  try {
    const raw = execSync(`${path} --version 2>&1`, {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return { semver: parser(raw), raw, path };
  } catch {
    return null;
  }
}

function checkPythonVersion(): CheckResult {
  const result = readVersion("python3", parsePythonVersion);
  if (!result) {
    return {
      name: "Python 3.11+",
      status: "warn",
      detail: "python3 not found",
      fix: "sudo apt install python3 (required for Python-based skills)",
    };
  }
  if (!result.semver) {
    return {
      name: "Python 3.11+",
      status: "warn",
      detail: `unparseable version: ${result.raw}`,
    };
  }
  const { major, minor, patch } = result.semver;
  const label = `${major}.${minor}.${patch}`;
  if (!semverAtLeast(result.semver, 3, 11)) {
    return {
      name: "Python 3.11+",
      status: "warn",
      detail: `${label} (too old)`,
      fix: "Install Python 3.11 or newer for skill venv support",
    };
  }
  return { name: "Python 3.11+", status: "ok", detail: label };
}

function checkNodeVersion(): CheckResult {
  const result = readVersion("node", parseNodeVersion);
  if (!result) {
    return {
      name: "Node 18+",
      status: "fail",
      detail: "node not found",
      fix: "Install Node 18 or newer via nvm",
    };
  }
  if (!result.semver) {
    return {
      name: "Node 18+",
      status: "warn",
      detail: `unparseable version: ${result.raw}`,
    };
  }
  const { major, minor, patch } = result.semver;
  const label = `${major}.${minor}.${patch}`;
  if (!semverAtLeast(result.semver, 18)) {
    return {
      name: "Node 18+",
      status: "fail",
      detail: `${label} (too old)`,
      fix: "Upgrade to Node 18 or newer (nvm install --lts)",
    };
  }
  return { name: "Node 18+", status: "ok", detail: label };
}

/**
 * Look for a chromium binary on PATH, then fall back to the Playwright
 * browser cache. Returns the path to the first match, or null.
 *
 * Search order for the Playwright cache:
 *   1. $PLAYWRIGHT_BROWSERS_PATH (set in v0.7.13+ agent images at
 *      `/opt/playwright/browsers/`; placed in an image layer so the
 *      browser binary is shared across the fleet rather than
 *      per-agent in HOME).
 *   2. $HOME/.cache/ms-playwright (legacy on-demand cache from
 *      pre-v0.7.13 hosts where every agent ran `npx playwright`
 *      and downloaded chromium into its own home dir).
 *
 * @internal exported for testing
 */
export function findChromium(
  homeDir: string = process.env.HOME ?? "",
  envBrowsersPath: string | undefined = process.env.PLAYWRIGHT_BROWSERS_PATH,
): string | null {
  const candidates = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ];
  for (const bin of candidates) {
    const path = which(bin);
    if (path) return path;
  }

  // Search Playwright cache locations in priority order: env-set
  // location first (v0.7.13+ baked layout), then legacy ~/.cache/.
  const cacheLocations: string[] = [];
  if (envBrowsersPath && envBrowsersPath.length > 0) {
    cacheLocations.push(envBrowsersPath);
  }
  cacheLocations.push(join(homeDir, ".cache", "ms-playwright"));

  for (const cacheDir of cacheLocations) {
    if (!existsSync(cacheDir)) continue;
    try {
      const entries = readdirSync(cacheDir).filter((e) =>
        e.startsWith("chromium"),
      );
      for (const entry of entries) {
        // Try both the modern `chrome-linux64` (Playwright >=1.40
        // restructured) and legacy `chrome-linux` layouts. v0.7.13's
        // bake (Playwright 1.59) uses chrome-linux64; older caches
        // use chrome-linux.
        const candidates = [
          join(cacheDir, entry, "chrome-linux64", "chrome"),
          join(cacheDir, entry, "chrome-linux", "chrome"),
          // chromium_headless_shell-* uses the headless_shell binary.
          join(cacheDir, entry, "chrome-linux64", "headless_shell"),
          join(cacheDir, entry, "chrome-linux", "headless_shell"),
        ];
        for (const path of candidates) {
          if (existsSync(path)) return path;
        }
      }
    } catch {
      /* unreadable */
    }
  }
  return null;
}

function checkChromium(): CheckResult {
  const path = findChromium();
  if (path) {
    return { name: "Chromium", status: "ok", detail: path };
  }
  return {
    name: "Chromium",
    status: "warn",
    detail: "not found (only required for playwright-based skills)",
    fix:
      "bun x playwright install chromium (per-project) " +
      "or sudo apt install chromium",
  };
}

/**
 * Check that ~/.switchroom/deps/ exists (or can be created) and is
 * writable. This is the root for per-skill Python venvs and Node
 * module caches created by src/deps/python.ts and src/deps/node.ts.
 * @internal exported for testing
 */
export function checkDepsCacheWritable(
  depsRoot: string = resolvePath("~/.switchroom/deps"),
): CheckResult {
  try {
    mkdirSync(depsRoot, { recursive: true });
    accessSync(depsRoot, fsConstants.W_OK);
    return {
      name: "~/.switchroom/deps writable",
      status: "ok",
      detail: depsRoot,
    };
  } catch (err) {
    return {
      name: "~/.switchroom/deps writable",
      status: "fail",
      detail: (err as Error).message,
      fix: `Ensure ${depsRoot} is writable by your user`,
    };
  }
}

export function checkSkillsPrerequisites(): CheckResult[] {
  return [
    checkPythonVersion(),
    checkNodeVersion(),
    checkChromium(),
    checkDepsCacheWritable(),
  ];
}

export function checkConfig(config: SwitchroomConfig, configPath: string): CheckResult[] {
  const results: CheckResult[] = [];

  results.push({
    name: "switchroom.yaml loaded",
    status: "ok",
    detail: configPath,
  });

  const agentCount = Object.keys(config.agents).length;
  results.push({
    name: "agents defined",
    status: agentCount > 0 ? "ok" : "warn",
    detail: agentCount > 0 ? `${agentCount} agent(s)` : "no agents",
    fix: agentCount === 0
      ? "Add at least one agent under `agents:` in switchroom.yaml"
      : undefined,
  });

  const forumChatId = config.telegram.forum_chat_id;
  results.push({
    name: "telegram.forum_chat_id set",
    status: forumChatId ? "ok" : "fail",
    detail: forumChatId || "missing",
    fix: forumChatId
      ? undefined
      : "Add a Telegram forum group chat ID under telegram.forum_chat_id",
  });

  const knownSubagents = ["worker", "researcher", "reviewer"] as const;
  const foundSubagents = knownSubagents.filter(
    (k) => config.defaults?.subagents?.[k] !== undefined,
  );
  results.push({
    name: "default subagents configured",
    status: foundSubagents.length > 0 ? "ok" : "warn",
    detail:
      foundSubagents.length > 0
        ? foundSubagents.join(", ")
        : "no default subagents — main agent handles all work inline",
    fix:
      foundSubagents.length > 0
        ? undefined
        : "Add defaults.subagents to switchroom.yaml to enable Sonnet/Haiku delegation. See docs/sub-agents.md for the worker/researcher/reviewer pattern.",
  });

  // Adaptive-thinking effort guard (#1978). Opus 4.x + thinking_effort
  // above the `low` floor can 400 on thinking blocks when work runs
  // through concurrent sub-agents (an upstream claude CLI merge bug).
  // Resolve each agent's effective model + effort and flag the combo so
  // an operator sees it at `doctor`/`apply` time, not as silent 400s.
  const effortRisks: string[] = [];
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const resolved = resolveAgentConfig(
      config.defaults,
      config.profiles,
      agentConfig,
    );
    if (assessThinkingEffortRisk(resolved.model, resolved.thinking_effort).risky) {
      effortRisks.push(name);
    }
  }
  results.push({
    name: "thinking_effort × adaptive model",
    status: effortRisks.length > 0 ? "warn" : "ok",
    detail:
      effortRisks.length > 0
        ? `${effortRisks.length} agent(s) on Opus 4.x with thinking_effort > low: ${effortRisks.join(", ")}`
        : "no risky model/effort combos",
    fix:
      effortRisks.length > 0
        ? "Pin `thinking_effort: low` for Opus 4.x agents — medium+ can 400 on 'thinking blocks cannot be modified' with concurrent sub-agents (issue #1978). Removing the field is NOT a fix (Opus 4.8 defaults effort=high when unset)."
        : undefined,
  });

  return results;
}

/**
 * Cross-reference user-declared `mcp_servers` (cascade-merged from
 * `defaults.mcp_servers` + per-agent `agents.<name>.mcp_servers`)
 * against the keys actually present in the rendered `.mcp.json`. Warns
 * when an operator declared an MCP server in switchroom.yaml that
 * never made it into `.mcp.json` — the runtime regression class that
 * silently shipped from PR #875 (v0.7.6 docker cutover) until PR #1786
 * (scaffold writer fix).
 *
 * `false` opt-out sentinels in the declared map are intentional
 * suppressions, not missing entries — filtered out before the diff.
 *
 * Returns ONE CheckResult per agent (skip when no user-declared
 * entries; ok when all declared keys are present; warn with the
 * missing-keys list otherwise).
 */
export function checkUserDeclaredMcps(
  name: string,
  agentConfig: AgentConfig,
  config: SwitchroomConfig,
  renderedMcpServers: Record<string, unknown>,
): CheckResult {
  const resolved = resolveAgentConfig(
    config.defaults,
    config.profiles,
    agentConfig,
  );
  const declaredMcp = resolved.mcp_servers ?? {};
  const declaredKeys = Object.entries(declaredMcp)
    .filter(([, v]) => v !== false)
    .map(([k]) => k);
  const renderedKeys = Object.keys(renderedMcpServers);
  const missing = declaredKeys.filter((k) => !renderedKeys.includes(k));

  if (declaredKeys.length === 0) {
    return {
      name: `${name}: user-declared MCPs`,
      status: "skip",
      detail: "no user-declared mcp_servers in switchroom.yaml",
    };
  }
  if (missing.length === 0) {
    return {
      name: `${name}: user-declared MCPs`,
      status: "ok",
      detail:
        `${declaredKeys.length} declared, all in .mcp.json (${declaredKeys.join(", ")})`,
    };
  }
  return {
    name: `${name}: user-declared MCPs`,
    status: "warn",
    detail:
      `${missing.length}/${declaredKeys.length} declared but missing from .mcp.json: ${missing.join(", ")}`,
    fix: `Run \`switchroom agent reconcile ${name} --restart\`. If the entry still doesn't appear, check switchroom.yaml shape (defaults.mcp_servers.<key> or agents.${name}.mcp_servers.<key>).`,
  };
}

/**
 * Deprecation notice (announced v0.12.0 → shims removed v0.13.0): WARN when
 * legacy `~/.clerk` state or the v0.6 host-side broker socket is present, so
 * operators migrate before the back-compat shims (src/config/paths.ts dual-
 * read + the `clerk:` YAML alias + src/vault/broker/client.ts
 * LEGACY_SOCKET_PATH) are deleted. There is no automatic migration. `warn`
 * keeps exit 0, so this never breaks CI/automation.
 */
export function checkLegacyState(): CheckResult[] {
  const results: CheckResult[] = [];
  const h = process.env.HOME ?? "/root";

  const clerkDir = join(h, LEGACY_STATE_DIR);
  const clerkPresent = existsSync(clerkDir);
  results.push({
    name: "legacy ~/.clerk state",
    status: clerkPresent ? "warn" : "ok",
    detail: clerkPresent ? `${clerkDir} present` : "none",
    ...(clerkPresent
      ? {
          fix:
            "Legacy state detected. Run `mv ~/.clerk ~/.switchroom` and rename "
            + "any top-level `clerk:` key in switchroom.yaml to `switchroom:`. "
            + "This back-compat shim is REMOVED in v0.13.0 — no automatic "
            + "migration exists.",
        }
      : {}),
  });

  const legacySock = join(h, ".switchroom", "vault-broker.sock");
  let sockStat: ReturnType<typeof lstatSync> | null = null;
  try {
    sockStat = lstatSync(legacySock);
  } catch {
    /* absent — fine */
  }
  if (sockStat) {
    results.push({
      name: "legacy v0.6 broker socket",
      status: "warn",
      detail: sockStat.isSymbolicLink()
        ? `${legacySock} (symlink) present`
        : `${legacySock} present`,
      fix:
        "v0.6 host-side broker socket detected. v0.7+ docker installs use the "
        + "per-agent broker-operator socket; remove the legacy socket. The "
        + "LEGACY_SOCKET_PATH fallback is REMOVED in v0.13.0.",
    });
  }

  return results;
}

/**
 * Probe the vault-broker container for the per-agent socket *pair* —
 * both `<dir>/sock` (data) AND `<dir>/unlock`. Mirrors
 * `probeAuthBrokerSocket` for the sibling auth-broker.
 *
 * The unlock half historically went unbound by `bindAgentSocket()` —
 * the documented Telegram `/vault unlock` flow returned
 * `ENOENT /run/switchroom/broker/unlock` because the broker only paired
 * data + unlock for the *operator* listener, never for per-agent
 * peers. PR #1721 fixed `bindAgentSocket` itself; this probe is the
 * operational regression guard. Volume-mount config drift, an out-of-
 * date broker image, or an `apply` that didn't reconcile would all
 * surface as a missing unlock half without this probe.
 *
 * Return values per agent:
 *   - "ok"             — both sock + unlock are bound
 *   - "missing-unlock" — data present, unlock absent (the original bug)
 *   - "missing-data"   — data absent (agent never bound)
 *   - "missing-both"   — neither bound (compose mount missing)
 *   - "unreachable"    — broker container not running / docker unavailable
 *
 * @internal exported for testing
 */
export type PerAgentSocketPairState =
  | "ok"
  | "missing-unlock"
  | "missing-data"
  | "missing-both"
  | "unreachable";

export function probeVaultBrokerSocketPair(
  agentName: string,
): PerAgentSocketPairState {
  const dataPath = `/run/switchroom/broker/${agentName}/sock`;
  const unlockPath = `/run/switchroom/broker/${agentName}/unlock`;
  // Single `docker exec` that prints `D=<0|1> U=<0|1>` so we avoid the
  // 4× docker exec cost (~300ms each) per agent. `test -S` exits 0 when
  // the path is a socket, non-zero otherwise.
  const script =
    `D=0; U=0; ` +
    `test -S '${dataPath}' && D=1; ` +
    `test -S '${unlockPath}' && U=1; ` +
    `echo "D=$D U=$U"`;
  const r = spawnSync(
    "docker",
    ["exec", "switchroom-vault-broker", "sh", "-c", script],
    { stdio: "pipe", timeout: 3000 },
  );
  if (r.error || r.status === null) return "unreachable";
  if (r.status !== 0) {
    // Non-zero from `sh -c` itself (vs the inner `test`s) → docker
    // couldn't reach the container (no such container, daemon down, etc).
    if (r.status >= 125) return "unreachable";
    // Unknown shell failure — treat conservatively as unreachable so we
    // don't false-alarm the operator with a "missing" verdict.
    return "unreachable";
  }
  const out = r.stdout.toString();
  const dOk = /D=1/.test(out);
  const uOk = /U=1/.test(out);
  if (dOk && uOk) return "ok";
  if (dOk && !uOk) return "missing-unlock";
  if (!dOk && uOk) return "missing-data";
  return "missing-both";
}

/**
 * Aggregate per-agent socket-pair states into a single doctor row.
 *
 * Fleet-scale rationale: agents typically come in 5-15 per host. One
 * row per agent would clobber doctor output. Group the verdict and
 * point the operator at the specific agents that are off.
 *
 * @internal exported for testing
 */
export function checkVaultBrokerSocketPairs(
  config: SwitchroomConfig,
  opts?: { probe?: (agentName: string) => PerAgentSocketPairState },
): CheckResult {
  const agentNames = Object.keys(config.agents ?? {}).sort();
  if (agentNames.length === 0) {
    return {
      name: "vault-broker per-agent socket pairs",
      status: "ok",
      detail: "no agents configured",
    };
  }
  const probe = opts?.probe ?? probeVaultBrokerSocketPair;
  const states = new Map<string, PerAgentSocketPairState>();
  for (const name of agentNames) {
    states.set(name, probe(name));
  }
  // All unreachable → broker container not running. One honest skip row,
  // not N "missing" rows.
  const allUnreachable = [...states.values()].every((s) => s === "unreachable");
  if (allUnreachable) {
    return {
      name: "vault-broker per-agent socket pairs",
      status: "skip",
      detail:
        "vault-broker container unreachable — couldn't probe per-agent socket pairs",
      fix: "Check the vault-broker service health row above; `switchroom update` brings it back",
    };
  }
  const groups: Record<Exclude<PerAgentSocketPairState, "ok">, string[]> = {
    "missing-unlock": [],
    "missing-data": [],
    "missing-both": [],
    "unreachable": [],
  };
  let okCount = 0;
  for (const [name, state] of states) {
    if (state === "ok") {
      okCount++;
    } else {
      groups[state].push(name);
    }
  }
  if (okCount === agentNames.length) {
    return {
      name: "vault-broker per-agent socket pairs",
      status: "ok",
      detail: `${okCount}/${agentNames.length} agents: data + unlock sockets bound`,
    };
  }
  const parts: string[] = [];
  if (groups["missing-unlock"].length > 0) {
    parts.push(
      `unlock missing: ${groups["missing-unlock"].join(", ")} ` +
      `(the documented Telegram /vault unlock flow fails ENOENT for these)`,
    );
  }
  if (groups["missing-data"].length > 0) {
    parts.push(`data missing: ${groups["missing-data"].join(", ")}`);
  }
  if (groups["missing-both"].length > 0) {
    parts.push(`both missing: ${groups["missing-both"].join(", ")}`);
  }
  if (groups["unreachable"].length > 0) {
    parts.push(`unreachable: ${groups["unreachable"].join(", ")}`);
  }
  return {
    name: "vault-broker per-agent socket pairs",
    status: "fail",
    detail: `${okCount}/${agentNames.length} ok — ${parts.join("; ")}`,
    fix:
      "Run `switchroom update` (or `switchroom apply` then recreate the " +
      "vault-broker container). If only the unlock half is missing, the " +
      "broker image predates PR #1721 — pull the latest image.",
  };
}

function checkVault(config: SwitchroomConfig): CheckResult[] {
  const vaultPath = config.vault?.path
    ? config.vault.path.replace(/^~/, process.env.HOME ?? "")
    : resolveStatePath("vault.enc");

  // Approval-auth posture surface. Surfaces independently of vault file
  // existence so operators see the configured posture even when the
  // vault hasn't been created yet.
  const broker = config.vault?.broker;
  const approvalAuth = broker?.approvalAuth ?? "passphrase";
  const postureResult: CheckResult =
    approvalAuth === "telegram-id"
      ? broker?.autoUnlock === true
        ? {
            name: "vault approval-auth posture",
            status: "ok",
            detail: "Approval auth: telegram-id (single-factor, relies on Telegram account security)",
          }
        : {
            name: "vault approval-auth posture",
            status: "fail",
            detail:
              "approvalAuth: telegram-id configured but autoUnlock is not true — schema invariant violated",
            fix: "Set vault.broker.autoUnlock: true (and run `switchroom vault broker enable-auto-unlock`) or revert approvalAuth to `passphrase`.",
          }
      : {
          name: "vault approval-auth posture",
          status: "ok",
          detail: "Approval auth: passphrase (two-factor)",
        };

  const pairsResult = checkVaultBrokerSocketPairs(config);

  if (!existsSync(vaultPath)) {
    return [
      postureResult,
      {
        name: "vault file present",
        status: "warn",
        detail: `${vaultPath} not found`,
        fix: "Run `switchroom vault init` if you plan to store secrets in the vault",
      },
      pairsResult,
    ];
  }

  const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (!passphrase) {
    return [
      postureResult,
      {
        name: "vault file present",
        status: "ok",
        detail: vaultPath,
      },
      {
        name: "vault unlock",
        status: "skip",
        detail: "SWITCHROOM_VAULT_PASSPHRASE not set; cannot verify decrypt",
        fix: "Export SWITCHROOM_VAULT_PASSPHRASE to verify the vault unlocks",
      },
      pairsResult,
    ];
  }

  try {
    const keys = listSecrets(passphrase, vaultPath);
    return [
      postureResult,
      {
        name: "vault unlock",
        status: "ok",
        detail: `${keys.length} secret(s)`,
      },
      pairsResult,
    ];
  } catch (err) {
    return [
      postureResult,
      {
        name: "vault unlock",
        status: "fail",
        detail: (err as Error).message,
        fix: "SWITCHROOM_VAULT_PASSPHRASE is wrong, or the vault file is corrupted",
      },
      pairsResult,
    ];
  }
}

/**
 * Probe the hindsight ephemeral-consumer wiring (RFC H §4.8 / #1245).
 *
 * Two related checks, returned as a single combined row:
 *   1. `auth.consumers[]` in `switchroom.yaml` contains an entry named
 *      `hindsight`. The auth-broker only binds a per-consumer socket
 *      when this is set.
 *   2. The broker container has actually bound the socket at
 *      `/run/switchroom/auth-broker/hindsight/sock` (in-container path).
 *      We `docker exec ... test -S <path>` because the host-side docker
 *      volume mountpoint at `/var/lib/docker/volumes/.../_data/sock`
 *      lives under a root-only-traversable parent (`/var/lib/docker` is
 *      mode 0711 root:root on the common docker.io install), so an
 *      operator-uid `existsSync()` returns false even when the socket
 *      is present and healthy — false positive (#1281).
 *
 * Replaces the pre-#1245 `hindsight env leak` probe — that was
 * defending against an OpenAI-key shape that the broker-fed flow
 * doesn't use at all.
 *
 * @internal exported for testing
 */
export function checkHindsightConsumer(
  config: SwitchroomConfig,
  opts?: { socketProbe?: (consumerName: string) => "present" | "missing" | "unreachable" },
): CheckResult {
  const consumers = config.auth?.consumers ?? [];
  const entry = consumers.find((c) => c.name === "hindsight");
  if (!entry) {
    return {
      name: "hindsight consumer",
      status: "warn",
      detail: "no `auth.consumers[]` entry named `hindsight` in switchroom.yaml",
      fix:
        "Add an entry like:\n" +
        "  auth:\n" +
        "    consumers:\n" +
        "      - name: hindsight\n" +
        "        account: <your account label>\n" +
        "        uid: 11000\n" +
        "then run `switchroom apply` to bind the per-consumer socket.",
    };
  }

  // Ask the broker container — it owns the socket bind and runs as root
  // inside the container, so it can stat its own socket regardless of
  // host-side docker volume permissions.
  const probe = opts?.socketProbe ?? probeAuthBrokerSocket;
  const state = probe(entry.name);

  if (state === "unreachable") {
    // Broker container isn't around to ask. Don't speculate about the
    // socket — the auth-broker service-health probe covers that case
    // separately. Just surface what we know.
    return {
      name: "hindsight consumer",
      status: "warn",
      detail:
        `auth.consumers[hindsight] -> ${entry.account} (uid ${entry.uid ?? 0}); ` +
        `couldn't query auth-broker container (not running / docker unavailable)`,
      fix:
        "Check `auth-broker: service health` row above; if the broker is " +
        "down, `switchroom apply` will bring it back and bind the socket.",
    };
  }

  if (state === "missing") {
    return {
      name: "hindsight consumer",
      status: "warn",
      detail:
        `auth.consumers[hindsight] -> ${entry.account} (uid ${entry.uid ?? 0}); ` +
        `auth-broker is running but socket not bound at /run/switchroom/auth-broker/${entry.name}/sock`,
      fix:
        "Run `switchroom apply` to refresh compose and rebind per-consumer sockets.",
    };
  }

  return {
    name: "hindsight consumer",
    status: "ok",
    detail: `auth.consumers[hindsight] -> ${entry.account} (uid ${entry.uid ?? 0})`,
  };
}

/**
 * Ask the auth-broker container whether a consumer's UDS is bound.
 * `docker exec switchroom-auth-broker test -S <path>` exits 0 if the
 * path is a socket; non-zero otherwise. Distinguishes "container not
 * reachable" (e.g. docker isn't installed, broker isn't up) from
 * "broker says no socket" so the doctor row can route the operator to
 * the right fix.
 */
function probeAuthBrokerSocket(
  consumerName: string,
): "present" | "missing" | "unreachable" {
  const containerPath = `/run/switchroom/auth-broker/${consumerName}/sock`;
  const r = spawnSync(
    "docker",
    ["exec", "switchroom-auth-broker", "test", "-S", containerPath],
    { stdio: "pipe", timeout: 3000 },
  );
  if (r.error || r.status === null) return "unreachable";
  if (r.status === 0) return "present";
  // Distinguish "broker says no socket" (test exit 1) from "docker
  // couldn't reach the container at all" (exit 125+, the docker CLI
  // family of "no such container" / daemon errors).
  if (r.status >= 125) return "unreachable";
  return "missing";
}

/**
 * Per-agent bank ingest health. One CheckResult per agent bank:
 *
 * - fail: recent documents (≤30d) stored with ZERO extracted facts — the
 *   fingerprint of a silent extraction outage (quota wall / shm). The fix
 *   string carries the exact reprocess curl for the oldest gap.
 * - warn: stale mental models (>7d since refresh) or a stuck pending queue.
 * - ok:   facts flowing; surfaces doc/fact/model counts + newest activity.
 *
 * Banks for agents not in the config (shared/legacy) are not probed.
 * Exported for tests.
 */
export async function checkBankIngestHealth(
  config: SwitchroomConfig,
  url: string,
  opts?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const now = opts?.now ?? new Date();
  // Dedupe: several agents may share a bank (memory.collection).
  const banks = new Map<string, string[]>();
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const bankId = agentConfig.memory?.collection ?? agentName;
    banks.set(bankId, [...(banks.get(bankId) ?? []), agentName]);
  }

  // Inspect banks concurrently — sequential probes against a busy server
  // (e.g. mid-extraction) compound each bank's latency into a doctor stall.
  const inspected = await Promise.all(
    [...banks].map(async ([bankId, agents]) =>
      [bankId, agents, await inspectBankHealth(url, bankId, { fetchImpl: opts?.fetchImpl })] as const,
    ),
  );

  for (const [bankId, agents, h] of inspected) {
    const label = `bank ${bankId}` + (agents[0] !== bankId ? ` (${agents.join(", ")})` : "");
    if (!h.ok) {
      results.push({
        name: label,
        status: "warn",
        detail: `inspection failed: ${h.reason}`,
      });
      continue;
    }
    if (h.totalDocuments === 0) {
      results.push({
        name: label,
        status: "warn",
        detail: "bank is empty (no documents retained yet)",
      });
      continue;
    }

    const gaps = recentUnextracted(h.unextractedDocuments, 30, now);
    const stale = staleMentalModels(h.mentalModels, 7, now);
    const corrupted = corruptedMentalModels(h.mentalModels);
    const newestAge = ageDays(h.newestDocumentAt, now);
    const summary =
      `${h.totalDocuments} docs · ${h.totalFacts} facts · ` +
      `newest ${h.newestDocumentAt?.slice(0, 10) ?? "?"} · ` +
      `${h.mentalModels.length} mental models`;

    if (corrupted.length > 0) {
      results.push({
        name: label,
        status: "fail",
        detail: `${corrupted.length} mental model(s) hold a persisted LLM-failure message instead of real content (${corrupted.map((m) => m.name).join(", ")}) — that garbage is injected into every agent turn`,
        fix:
          "A refresh ran while the LLM was quota-walled and the error string was stored as content. " +
          "Once quota recovers: POST /v1/default/banks/<bank>/mental-models/<id>/refresh and verify the content regenerated.",
      });
      continue;
    }
    if (gaps.length > 0) {
      const oldest = gaps[0];
      results.push({
        name: label,
        status: "fail",
        detail: `${gaps.length} document(s) in the last 30d retained with ZERO extracted facts (oldest ${oldest.createdAt.slice(0, 10)}) — conversations from those turns are invisible to recall`,
        fix:
          "Extraction silently failed (check hindsight logs for quota/429/shm). Re-extract each: " +
          `curl -X POST '${hindsightDocReprocessUrl(url, bankId, oldest.id)}' (repeat per doc id)`,
      });
      continue;
    }
    if (h.pendingOperations > 0 && newestAge !== null && newestAge > 1) {
      results.push({
        name: label,
        status: "warn",
        detail: `${h.pendingOperations} pending operation(s) with no new documents for ${Math.round(newestAge)}d — pipeline may be stuck`,
      });
      continue;
    }
    if (stale.length > 0) {
      results.push({
        name: label,
        status: "warn",
        detail: `${summary} · ${stale.length} stale (>7d): ${stale.map((m) => m.name).join(", ")}`,
        fix: "POST /v1/default/banks/<bank>/mental-models/<id>/refresh to regenerate",
      });
      continue;
    }
    results.push({ name: label, status: "ok", detail: summary });
  }
  return results;
}

function hindsightDocReprocessUrl(mcpUrl: string, bankId: string, docId: string): string {
  const base = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  return `${base}/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(docId)}/reprocess`;
}

async function checkHindsight(config: SwitchroomConfig): Promise<CheckResult[]> {
  if (!isHindsightEnabled(config)) {
    return [];
  }

  const url = (config.memory?.config?.url as string | undefined)
    ?? "http://localhost:8888/mcp/";

  const results: CheckResult[] = [];

  // Parse host and port out of the URL
  const match = url.match(/^https?:\/\/([^:/]+):?(\d+)?/);
  if (!match) {
    return [
      {
        name: "hindsight URL",
        status: "fail",
        detail: `unparseable: ${url}`,
        fix: "Set memory.config.url to a valid http URL",
      },
    ];
  }
  const host = match[1];
  const port = match[2] ? parseInt(match[2], 10) : 80;

  if (!checkTcp(host, port)) {
    return [
      {
        name: "hindsight reachable",
        status: "fail",
        detail: `${host}:${port} not responding`,
        fix:
          `Confirm Hindsight is running and serving \`${url}\`. ` +
          "Run `switchroom memory --start` to start the bundled container, " +
          "or point `memory.config.url` at your existing Hindsight (any " +
          "container name / remote host is fine).",
      },
    ];
  }

  // TCP reachability is necessary but not sufficient — confirm the URL
  // is actually serving Hindsight's MCP protocol (vs. some other process
  // happening to bind the same port). Surfaces the server version too.
  const probe = await probeHindsight(url);
  if (!probe.ok) {
    results.push({
      name: "hindsight reachable",
      status: "fail",
      detail: `${host}:${port} not speaking MCP (${probe.reason})`,
      fix:
        `Confirm \`${url}\` is a Hindsight MCP endpoint. ` +
        "Some other service may be bound to that port.",
    });
    return results;
  }

  results.push({
    name: "hindsight reachable",
    status: "ok",
    detail: `${probe.serverName} ${probe.serverVersion} at ${host}:${port}`,
  });

  // Contract-drift check (2026-06-07): reachable + speaking MCP is STILL not
  // enough — over 2 days, 5 callsites silently broke because the server renamed/
  // removed a tool or arg while switchroom checked only HTTP status. Fetch the
  // live tools/list and diff it against the tools switchroom uses, so an upstream
  // contract change surfaces as a doctor `fail` within one maintenance cycle —
  // not when a user notices their agent went amnesiac. Best-effort: a failed
  // tools/list just skips this check (reachability already passed).
  const toolsList = await fetchHindsightToolsList(url);
  if (toolsList.ok) {
    results.push(...classifyToolContract(toolsList.tools));
  }

  // Consumer probe (#1245): broker-fed hindsight needs an
  // `auth.consumers[]` entry + a bound per-consumer socket. Replaces
  // the legacy env-leak probe (the OpenAI-key shape it watched for
  // is no longer in use).
  results.push(checkHindsightConsumer(config));

  // Backend health (#outage 2026-06-06): reachability over MCP is NOT enough —
  // the container can be up and serving MCP while every write silently fails
  // (shm exhaustion or OAuth quota 429). These surface both from the local
  // container's shm config + recent logs; no-ops on a remote/dockerless setup.
  results.push(...checkHindsightContainerHealth());

  // Per-agent bank ingest health (2026-06-10 incident class): a bank can be
  // reachable and growing while fact extraction silently yields ZERO memory
  // units per document (consumer quota wall / shm exhaustion) — the agent
  // keeps "remembering" nothing and no surface goes red. Inspect each bank's
  // REST surface for unextracted documents and stale mental models.
  results.push(...(await checkBankIngestHealth(config, url)));

  // Per-agent bank health checks
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const bankId = agentConfig.memory?.collection ?? agentName;

    // Check if missions are set
    const hasBankMission = !!agentConfig.memory?.bank_mission;
    const hasRetainMission = !!agentConfig.memory?.retain_mission;
    if (!hasBankMission || !hasRetainMission) {
      results.push({
        name: `${agentName} missions`,
        status: "warn",
        detail: `bank_mission: ${hasBankMission ? "set" : "unset"}, retain_mission: ${hasRetainMission ? "set" : "unset"}`,
        fix: `Add bank_mission and retain_mission to agents.${agentName}.memory in switchroom.yaml`,
      });
    } else {
      results.push({
        name: `${agentName} missions`,
        status: "ok",
        detail: "bank_mission and retain_mission configured",
      });
    }
  }

  // Pending-retains queue (#1071). When session_end's final retain
  // fails it stashes the payload in ~/.hindsight/pending-retains/ so
  // the next SessionStart can drain it. A non-empty queue is normal in
  // flight, but persistent backlog (or any .dead markers) means
  // operator attention.
  results.push(checkPendingRetainsQueue());

  return results;
}

/**
 * Probe ``~/.hindsight/pending-retains/`` and report:
 *   ok    — directory missing or empty
 *   warn  — entries present but none marked dead (will retry on next session)
 *   fail  — at least one ``.dead`` marker (gave up after MAX_ATTEMPTS) OR
 *           queue at/over the bounded cap (chronic backlog)
 *
 * Exported for unit testing.
 * @internal
 */
export function checkPendingRetainsQueue(
  dir?: string,
): CheckResult {
  // Same default as lib/pending.py: $HOME/.hindsight/pending-retains/.
  const home = process.env.HOME ?? "";
  const pendingDir =
    dir
    ?? process.env.HINDSIGHT_PENDING_DIR
    ?? join(home, ".hindsight", "pending-retains");

  if (!existsSync(pendingDir)) {
    return {
      name: "pending-retains queue",
      status: "ok",
      detail: "empty (no failed retains)",
    };
  }

  let names: string[];
  try {
    names = readdirSync(pendingDir);
  } catch (err) {
    return {
      name: "pending-retains queue",
      status: "warn",
      detail: `unreadable: ${(err as Error).message}`,
    };
  }

  const pending = names.filter((n) => n.endsWith(".json"));
  const dead = names.filter((n) => n.endsWith(".json.dead"));

  // Keep in sync with MAX_ENTRIES in lib/pending.py.
  const MAX_ENTRIES = 1000;

  if (dead.length > 0) {
    return {
      name: "pending-retains queue",
      status: "fail",
      detail:
        `${dead.length} dead entries (gave up after retries), ${pending.length} still queued`,
      fix:
        `Hindsight has been unreachable long enough that retries gave up. `
        + `Inspect ~/.hindsight/pending-retains/*.json.dead, fix the upstream, `
        + `then re-enqueue manually (rename .dead → .json) or discard.`,
    };
  }

  if (pending.length >= MAX_ENTRIES) {
    return {
      name: "pending-retains queue",
      status: "fail",
      detail: `${pending.length} entries (queue at cap of ${MAX_ENTRIES}, dropping new failures)`,
      fix:
        `Chronic retain failures. Bring Hindsight up, run `
        + `\`python3 ~/.claude/plugins/.../scripts/drain_pending.py\`, then re-check.`,
    };
  }

  if (pending.length > 0) {
    return {
      name: "pending-retains queue",
      status: "warn",
      detail: `${pending.length} queued (will retry on next SessionStart)`,
    };
  }

  return {
    name: "pending-retains queue",
    status: "ok",
    detail: "empty (no failed retains)",
  };
}

/**
 * Classify a filesystem read error so doctor checks can distinguish
 * "file genuinely missing" (ENOENT — usually a real config bug worth a
 * red row) from "file present but the doctor process can't read it"
 * (EACCES — the doctor is running as the host operator UID, but
 * per-agent state files are mode 0600 owned by the agent UID
 * (compose.ts:580ish, agentUid 10001-10999); the agent runtime reads
 * them just fine, the doctor just can't verify from the host). Pre-fix,
 * the EACCES path produced a false "missing" fail per agent on every
 * `switchroom doctor` run on a multi-agent host.
 * @internal exported for testing
 */
export type ReadErrorKind = "enoent" | "eacces" | "other";
export function classifyReadError(err: unknown): ReadErrorKind {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "enoent";
  if (code === "EACCES" || code === "EPERM") return "eacces";
  return "other";
}

/**
 * Result of a host-side read attempt against per-agent state files.
 * Callers branch on `kind` to render an honest doctor row.
 *
 *   ok       — got the content
 *   enoent   — file is missing (real failure most of the time)
 *   eacces   — file is there but unreadable from this UID
 *              (typical when doctor runs as host operator and the
 *              file is owned by a per-agent UID); agent state likely
 *              fine; render as `warn`, not `fail`
 *   other    — anything else (corrupted FS, etc.); rare
 */
export type FileReadResult =
  | { kind: "ok"; content: string }
  | { kind: "enoent" }
  | { kind: "eacces"; error: string }
  | { kind: "other"; error: string };

export function tryReadHostFile(path: string): FileReadResult {
  try {
    return { kind: "ok", content: readFileSync(path, "utf-8") };
  } catch (err: unknown) {
    const kind = classifyReadError(err);
    const error = (err as Error)?.message ?? String(err);
    if (kind === "enoent") return { kind: "enoent" };
    if (kind === "eacces") return { kind: "eacces", error };
    return { kind: "other", error };
  }
}

/**
 * Parse a simple KEY=VALUE env file. Quotes around values are stripped.
 * Lines starting with `#` and blank lines are ignored.
 *
 * Returns an empty object on ANY read error — callers that need to
 * distinguish ENOENT (real missing) from EACCES (host-perm) should use
 * `tryReadHostFile()` directly instead.
 * @internal exported for testing
 */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  return parseSimpleEnv(content);
}

/**
 * Parse pre-read env-file content (KEY=VALUE per line; quotes stripped;
 * `#`-comments and blanks ignored). Extracted from parseEnvFile so
 * callers that already have the content (because they read the file
 * via tryReadHostFile to distinguish EACCES from ENOENT) don't have
 * to re-read it.
 * @internal exported for testing
 */
export function parseSimpleEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Call Telegram Bot API getMe with a short timeout. Returns the bot username
 * on success, or an error message on failure.
 * @internal exported for testing
 */
export async function telegramGetMe(
  token: string,
  timeoutMs = 5000,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: ctrl.signal,
    });
    const body = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (!body.ok) {
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, username: body.result?.username ?? "(no username)" };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      error: e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkTelegram(config: SwitchroomConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const agentsDir = resolveAgentsDir(config);

  // Collect unique bot tokens across all agents that use the switchroom
  // telegram plugin. Multiple agents typically share one bot in the common
  // single-bot setup, so we dedupe before calling getMe.
  //
  // Plugin defaults to "switchroom" when unset, so treat undefined as "switchroom".
  const tokensByAgent: Array<{ agent: string; token: string; source: string }> = [];
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const plugin = agentConfig.channels?.telegram?.plugin ?? "switchroom";
    if (plugin !== "switchroom") continue;
    const envPath = join(agentsDir, name, "telegram", ".env");
    const read = tryReadHostFile(envPath);
    if (read.kind === "eacces") {
      // The .env file is mode 0600 owned by the per-agent UID; doctor
      // running as the host operator can't open(2) it. The agent
      // process itself reads it fine. Surface this as a warn with
      // honest detail rather than a false "TELEGRAM_BOT_TOKEN missing"
      // fail (the 2026-05-10 false-positive that polluted the post-
      // deploy doctor across all 8 agents).
      results.push({
        name: `${name}: bot token`,
        status: "skip",
        detail: `unreadable from host (${read.error}) — agent reads it fine; cannot verify TELEGRAM_BOT_TOKEN from operator UID`,
        fix: `Verify in-agent (PR2 hostd agent_smoke), or: docker exec switchroom-${name} sh -lc 'test -s "$TELEGRAM_BOT_TOKEN_FILE" || grep -q TELEGRAM_BOT_TOKEN /state/agent/telegram/.env && echo ok'`,
      });
      continue;
    }
    const env = read.kind === "ok" ? parseSimpleEnv(read.content) : {};
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      results.push({
        name: `${name}: bot token`,
        status: "fail",
        detail:
          read.kind === "enoent"
            ? `TELEGRAM_BOT_TOKEN missing from ${envPath} (file does not exist)`
            : `TELEGRAM_BOT_TOKEN missing from ${envPath}`,
        fix: `Run \`switchroom agent reconcile ${name}\` and ensure the vault contains telegram_bot_token`,
      });
      continue;
    }
    tokensByAgent.push({ agent: name, token, source: envPath });
  }

  // Dedupe by token — one getMe call per distinct bot.
  const seen = new Map<string, string[]>();
  for (const { agent, token } of tokensByAgent) {
    if (!seen.has(token)) seen.set(token, []);
    seen.get(token)!.push(agent);
  }

  for (const [token, agents] of seen) {
    const label =
      agents.length === 1
        ? `${agents[0]}: bot reachable`
        : `bot reachable (${agents.join(", ")})`;
    const result = await telegramGetMe(token);
    if (result.ok) {
      results.push({
        name: label,
        status: "ok",
        detail: `@${result.username}`,
      });
    } else {
      results.push({
        name: label,
        status: "fail",
        detail: result.error,
        fix:
          "Verify the token is valid (api.telegram.org/bot<TOKEN>/getMe) and that outbound HTTPS is allowed",
      });
    }
  }

  return results;
}

/**
 * Detect agents whose start.sh predates the Phase 4 cron-fold-in cutover
 * (#893) — they lack the agent-scheduler supervisor block, so cron does
 * not fire (#909, #911). Reads the host file directly; the bind mount
 * makes it the same content the container sees.
 *
 * @internal exported for testing
 */
export function checkStartShStale(
  agentName: string,
  startShPath: string,
): CheckResult {
  const label = `${agentName}: start.sh scheduler block`;
  if (!existsSync(startShPath)) {
    return {
      name: label,
      status: "warn",
      detail: `${startShPath} not found`,
      fix: `Run \`switchroom apply\` to scaffold start.sh.`,
    };
  }
  let content: string;
  try {
    content = readFileSync(startShPath, "utf-8");
  } catch (err) {
    // start.sh is mode 0700 owned by the per-agent UID; the host
    // operator can't read it. By-design unverifiable from here — not
    // a problem (the agent runs it fine). PR2 verifies in-agent.
    return {
      name: label,
      status: "skip",
      detail: `unreadable from host (${(err as Error).message}) — agent-UID-owned; the scheduler block can't be checked from the operator UID`,
      fix: `Verify in-agent (PR2 hostd agent_smoke), or: docker exec switchroom-${agentName} grep -q _switchroom_supervise.*agent-scheduler /state/agent/start.sh && echo ok`,
    };
  }
  // Match on the actual supervisor invocation, not the bare token —
  // a comment like "# TODO: wire agent-scheduler" would otherwise
  // falsely report "ok", and this check is the entire defense for
  // the #911 silent-cron-loss class.
  if (!/_switchroom_supervise\s+agent-scheduler\b/.test(content)) {
    return {
      name: label,
      status: "fail",
      detail:
        "missing agent-scheduler supervisor block — no crons will fire",
      fix:
        "Run `switchroom apply` to regenerate start.sh against the latest template, then `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d` to restart.",
    };
  }
  return { name: label, status: "ok", detail: "supervisor block present" };
}

/**
 * Detect leaked $HOME/.switchroom state inside an agent's bind-mounted
 * state dir (#933). Agents that ran before #910's symlink fix landed
 * may have written analytics-id / quota-cache / logs into the wrong
 * path — those writes manifest on the host as a real directory at
 * `<agentDir>/home/.switchroom/`. The start.sh symlink block refuses
 * to clobber a real dir (correctly, to protect operator data), so
 * #910's fix never takes effect for that agent until the operator
 * manually clears the leaked state. Symptom is silent: tilde paths
 * in cron prompts continue to resolve to the wrong location, so cron
 * skills that reference `~/.switchroom/skills/<x>/...` fail.
 *
 * @internal exported for testing
 */
export function checkLeakedHomeSwitchroom(
  agentName: string,
  agentDir: string,
): CheckResult {
  const label = `${agentName}: $HOME/.switchroom symlink (#910)`;
  const path = join(agentDir, "home", ".switchroom");
  // lstatSync, not existsSync — existsSync follows symlinks and would
  // return false for a symlink with a non-existent target (e.g. when
  // the operator's host home is mounted differently than expected),
  // misclassifying a fresh post-#910 symlink as "no leaked state".
  let stats;
  try {
    stats = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Either the agent's never run (no $HOME/.switchroom yet, will
      // be created as a symlink on first start.sh exec) OR the
      // post-#910 start.sh hasn't run yet. Either way: no leaked
      // state to clean up.
      return {
        name: label,
        status: "ok",
        detail: "no leaked state (will symlink on next start.sh exec)",
      };
    }
    return {
      name: label,
      status: "warn",
      detail: `unreadable: ${(err as Error).message}`,
    };
  }
  if (stats.isSymbolicLink()) {
    return {
      name: label,
      status: "ok",
      detail: "symlink in place — tilde paths resolve correctly",
    };
  }
  // Real dir or file → leaked state. Surface the cleanup recipe.
  return {
    name: label,
    status: "fail",
    detail:
      "real directory at $HOME/.switchroom — #910 symlink can't take " +
      "effect; tilde paths in cron prompts will resolve to the wrong location",
    fix:
      `Inside the container, move the leaked state out of the way and ` +
      `restart so start.sh re-creates the symlink:\n` +
      `        docker exec switchroom-${agentName} sh -c 'rm -rf $HOME/.switchroom'\n` +
      `        switchroom agent restart ${agentName}\n` +
      `      The symlink target ($HOME/.switchroom → host's ~/.switchroom) ` +
      `regenerates on next start.sh exec.`,
  };
}

/**
 * Hygiene probe for the switchroom git checkout itself (#1072).
 *
 * The original OpenClaw export bundle (`clerk-export/`) and its tarball
 * carry real secrets. They're gitignored, so they can't reach a commit,
 * but they sit on disk in the repo root and are exposed to any tool that
 * scans the working tree (backups, grep, "send my repo to X" workflows).
 *
 * The proper fix is to migrate the bundle into the vault and delete the
 * on-disk copies (see `scripts/migrate-clerk-export-to-vault.sh`). This
 * check surfaces the residual on-disk state so an operator who skipped
 * the migration script — or restored an old worktree — sees a clear
 * warning.
 *
 * Scope: only meaningful when doctor runs from inside a switchroom
 * checkout. The caller is expected to skip this section if `repoRoot`
 * isn't a switchroom repo.
 */
export function checkRepoHygiene(repoRoot: string): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. Directory: `clerk-export/`
  const exportDir = join(repoRoot, "clerk-export");
  if (existsSync(exportDir)) {
    results.push({
      name: "repo hygiene: clerk-export/ on disk (#1072)",
      status: "warn",
      detail:
        `${exportDir} contains real secrets exported from OpenClaw. ` +
        `Gitignored, so it can't be committed, but it's still readable ` +
        `by any tool that scans the working tree.`,
      fix:
        `Run scripts/migrate-clerk-export-to-vault.sh to move the bundle ` +
        `into the vault, then delete the on-disk copy.`,
    });
  }

  // 2. Tarball: known name + glob for any *-with-secrets*.tar.gz at repo root
  const knownTarball = join(repoRoot, "clerk-export-with-secrets.tar.gz");
  if (existsSync(knownTarball)) {
    results.push({
      name: "repo hygiene: clerk-export-with-secrets.tar.gz on disk (#1072)",
      status: "warn",
      detail:
        `${knownTarball} is a sealed copy of the OpenClaw secret bundle. ` +
        `Gitignored, but persists on disk.`,
      fix:
        `Run scripts/migrate-clerk-export-to-vault.sh (handles the tarball ` +
        `too) then 'trash' or 'rm' the file.`,
    });
  }

  // 3. Glob: any *-with-secrets*.tar.gz at repo root that wasn't the known one
  try {
    const entries = readdirSync(repoRoot);
    for (const name of entries) {
      if (name === "clerk-export-with-secrets.tar.gz") continue; // already reported
      // `[^/]*` rather than `.*` — `readdirSync` always returns
      // basenames (no path separators) so the two are functionally
      // equivalent today, but pinning out `/` makes the intent
      // obvious and forecloses the false-positive shape (`weird-
      // with-secrets/anything.tar.gz` as a single readdir entry)
      // if this regex ever migrates to a non-`readdirSync` caller.
      if (/-with-secrets[^/]*\.tar\.gz$/i.test(name)) {
        results.push({
          name: `repo hygiene: ${name} on disk (#1072)`,
          status: "warn",
          detail:
            `${join(repoRoot, name)} matches the *-with-secrets*.tar.gz ` +
            `pattern. Likely contains real credentials.`,
          fix:
            `Inspect, migrate any secrets into the vault, then delete the ` +
            `archive.`,
        });
      }
    }
  } catch {
    // Unreadable repo root — surface as a warning rather than crash.
    results.push({
      name: "repo hygiene: scan failed (#1072)",
      status: "warn",
      detail: `could not enumerate ${repoRoot} for *-with-secrets*.tar.gz`,
    });
  }

  if (results.length === 0) {
    results.push({
      name: "repo hygiene: clerk-export bundle (#1072)",
      status: "ok",
      detail: "no clerk-export/ or *-with-secrets*.tar.gz at repo root",
    });
  }

  return results;
}

/**
 * Heuristic: does this directory look like a switchroom git checkout?
 * Used to gate `checkRepoHygiene` so doctor running from a random cwd
 * on a non-developer host doesn't emit a noisy "ok" line.
 */
export function isSwitchroomCheckout(dir: string): boolean {
  try {
    if (!existsSync(join(dir, ".git"))) return false;
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
    return pkg.name === "switchroom";
  } catch {
    return false;
  }
}

export function checkAgents(config: SwitchroomConfig, configPath: string): CheckResult[] {
  const results: CheckResult[] = [];
  const agentsDir = resolveAgentsDir(config);
  const statuses = getAllAgentStatuses(config);
  const authStatuses = getAllAuthStatuses(config);

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const agentDir = resolve(agentsDir, name);

    // 1. Directory exists
    if (!existsSync(agentDir)) {
      results.push({
        name: `${name}: scaffold`,
        status: "fail",
        detail: `${agentDir} missing`,
        fix: `Run \`switchroom agent create ${name}\``,
      });
      continue;
    }

    // 1a. Quarantine marker (#1076). When the gateway exits via the
    // EX_CONFIG path (revoked / wrong-typed bot token, today), it
    // writes <agentDir>/telegram/quarantine.json and the supervisor
    // stops respawning. This check surfaces the state to the operator
    // so a silently-dead gateway can't hide behind a green doctor.
    // Reported as `fail` because the agent is non-functional until
    // the operator rotates the underlying credential and runs
    // `switchroom agent unquarantine <name>`.
    const quarantine = readQuarantineMarkerForAgent(agentsDir, name);
    if (quarantine != null) {
      const ageSec = Math.max(0, Math.floor((Date.now() - quarantine.ts) / 1000));
      const ageStr =
        ageSec < 60
          ? `${ageSec}s`
          : ageSec < 3600
            ? `${Math.floor(ageSec / 60)}m`
            : ageSec < 86400
              ? `${Math.floor(ageSec / 3600)}h`
              : `${Math.floor(ageSec / 86400)}d`;
      const reasonText =
        quarantine.reason === "startup.unauthorized"
          ? "bot token rejected by Telegram (401) at gateway startup"
          : quarantine.reason;
      results.push({
        name: `${name}: quarantine`,
        status: "fail",
        detail: `${reasonText} (${ageStr} ago)`,
        fix:
          `Rotate the bot token (e.g. via \`switchroom vault\`), then run ` +
          `\`switchroom agent unquarantine ${name}\` and \`switchroom agent restart ${name}\``,
      });
    }

    // 1b. start.sh has the post-Phase-4 scheduler supervisor block
    results.push(checkStartShStale(name, join(agentDir, "start.sh")));

    // 1c. Leaked $HOME/.switchroom state from pre-#910 runs (#933).
    // Inside the container HOME=/state/agent/home; if the agent ever
    // wrote to $HOME/.switchroom/ before the symlink fix landed, that
    // state lives at <agentDir>/home/.switchroom/ as a real dir. The
    // start.sh symlink-creation guard refuses to clobber a real dir,
    // so the #910 fix never takes effect for that agent — silent:
    // tilde paths in cron prompts continue to look in the wrong place.
    results.push(checkLeakedHomeSwitchroom(name, agentDir));

    // 2. Service status
    const status = statuses[name];
    const active = status?.active ?? "unknown";
    if (active === "active" || active === "running") {
      results.push({
        name: `${name}: service`,
        status: "ok",
        detail: active,
      });
    } else {
      results.push({
        name: `${name}: service`,
        status: "warn",
        detail: active,
        fix: `Run \`switchroom agent start ${name}\``,
      });
    }

    // 3. Auth
    const auth = authStatuses[name];
    if (!auth?.authenticated) {
      if (auth?.inaccessible) {
        // Per-agent credentials exist but the doctor process can't
        // open(2) them (UID mismatch — host operator vs. agent UID).
        // Agent state is almost certainly fine; the host just can't
        // verify. Render as warn with honest detail rather than the
        // false "not authenticated" fail that pre-fix polluted the
        // post-deploy doctor across the full fleet (2026-05-10).
        results.push({
          name: `${name}: auth`,
          status: "skip",
          detail: "auth state owned by agent UID — unverifiable from host (agent reads it fine)",
          fix: `Verify in-agent (PR2 hostd agent_smoke runs a real auth liveness check)`,
        });
      } else {
        results.push({
          name: `${name}: auth`,
          status: "fail",
          detail: auth?.pendingAuth
            ? "pending (auth flow in progress)"
            : "not authenticated",
          fix: `Run \`switchroom auth add <label> --via-claude\` then \`switchroom auth use <label>\` (RFC H — see docs/auth.md)`,
        });
      }
    } else {
      // Rich auth detail: plan · expires in · rate-limit tier
      const parts: string[] = [];
      parts.push(auth.subscriptionType ?? "authenticated");
      if (auth.timeUntilExpiry) parts.push(`expires ${auth.timeUntilExpiry}`);
      if (auth.rateLimitTier) parts.push(`tier ${auth.rateLimitTier}`);

      // Warn when expiry is near (<24h)
      const remainingMs =
        auth.expiresAt != null ? auth.expiresAt - Date.now() : Number.POSITIVE_INFINITY;
      const nearExpiry = remainingMs > 0 && remainingMs < 24 * 60 * 60 * 1000;

      results.push({
        name: `${name}: auth`,
        status: nearExpiry ? "warn" : "ok",
        detail: parts.join(" · "),
        fix: nearExpiry
          ? `Token expires soon — broker refreshes automatically below 60 min remaining; force with \`switchroom auth refresh\``
          : undefined,
      });
    }

    // 3b. Slot health (only if multi-slot or any slot unhealthy)
    let slots: SlotInfo[] = [];
    try {
      slots = getSlotInfos(agentDir);
    } catch { /* no slots layout yet */ }

    if (slots.length > 0) {
      // SlotInfo.health may be "active" (active + healthy), "healthy",
      // "expired", "quota-exhausted", or "missing".
      const healthy = slots.filter(
        (s) => s.health === "healthy" || s.health === "active",
      ).length;
      const expired = slots.filter((s) => s.health === "expired").length;
      const quotaOut = slots.filter((s) => s.health === "quota-exhausted").length;
      const active = slots.find((s) => s.active);

      // Only surface a slot row when multi-slot or any issue
      if (slots.length > 1 || expired > 0 || quotaOut > 0) {
        const issues: string[] = [];
        if (quotaOut > 0) issues.push(`${quotaOut} quota-exhausted`);
        if (expired > 0) issues.push(`${expired} expired`);

        const status: CheckStatus =
          quotaOut > 0 || expired === slots.length ? "warn" : "ok";

        const detail =
          `${slots.length} slot(s) · active=${active?.slot ?? "none"} · ${healthy} healthy` +
          (issues.length ? ` · ${issues.join(", ")}` : "");

        results.push({
          name: `${name}: auth slots`,
          status,
          detail,
          fix:
            quotaOut > 0
              ? `Quota-exhausted account(s) will auto-recover when the window resets; broker auto-rotates per \`auth.fallback_order\` (see \`switchroom auth show\`).`
              : expired > 0
                ? `Expired account(s) — add a fresh one via \`switchroom auth add <label> --via-claude\` and \`switchroom auth use <label>\` (RFC H).`
                : undefined,
        });
      }
    }

    // 4. MCP wireup drift detection (switchroom-telegram plugin agents)
    if (agentConfig.channels?.telegram?.plugin === "switchroom") {
      // SWITCHROOM_AGENT_NAME (set in compose.ts) is verified by the
      // dockerSection's compose-shape checks; nothing per-agent to
      // probe here.
      const mcpJsonPath = join(agentDir, ".mcp.json");
      if (!existsSync(mcpJsonPath)) {
        results.push({
          name: `${name}: .mcp.json`,
          status: "fail",
          detail: "missing",
          fix: `Run \`switchroom agent reconcile ${name}\``,
        });
      } else {
        try {
          const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
          const hasSwitchroomTelegram = !!mcp.mcpServers?.["switchroom-telegram"];
          const memoryEnabled = isHindsightEnabled(config);
          const hasHindsight = !!mcp.mcpServers?.hindsight;

          if (!hasSwitchroomTelegram) {
            results.push({
              name: `${name}: .mcp.json`,
              status: "fail",
              detail: "missing switchroom-telegram entry",
              fix: `Run \`switchroom agent reconcile ${name} --restart\``,
            });
          } else if (memoryEnabled && !hasHindsight) {
            results.push({
              name: `${name}: .mcp.json`,
              status: "warn",
              detail: "memory enabled in switchroom.yaml but hindsight missing from .mcp.json",
              fix: `Run \`switchroom agent reconcile ${name} --restart\``,
            });
          } else {
            results.push({
              name: `${name}: .mcp.json`,
              status: "ok",
              detail: memoryEnabled ? "switchroom-telegram + hindsight" : "switchroom-telegram",
            });
          }

          // User-declared MCPs configured-vs-delivered check (#1786
          // follow-up). The cascade-resolved `mcp_servers` (defaults
          // + per-agent merge) is the operator's contract; the
          // rendered .mcp.json is what Claude Code actually loads.
          // Pre-fix (PR #1786) the writer was template-driven and
          // silently dropped every user-declared entry — perplexity,
          // notion, etc. all absent from the live fleet despite being
          // in yaml. This probe surfaces any future regression of the
          // same class loudly instead of silently.
          results.push(
            checkUserDeclaredMcps(name, agentConfig, config, mcp.mcpServers ?? {}),
          );
        } catch (err) {
          results.push({
            name: `${name}: .mcp.json`,
            status: "fail",
            detail: `parse error: ${(err as Error).message}`,
            fix: `Run \`switchroom agent reconcile ${name}\``,
          });
        }
      }
    }
  }

  void configPath;
  return results;
}

export function printSection(title: string, results: CheckResult[]): {
  oks: number;
  warns: number;
  fails: number;
  skips: number;
} {
  console.log(chalk.bold(`\n${title}`));
  let oks = 0;
  let warns = 0;
  let fails = 0;
  let skips = 0;
  for (const r of results) {
    if (r.status === "ok") oks++;
    if (r.status === "warn") warns++;
    if (r.status === "fail") fails++;
    if (r.status === "skip") skips++;
    const detail = r.detail ? chalk.gray(`  (${r.detail})`) : "";
    console.log(`  ${statusGlyph(r.status)} ${r.name}${detail}`);
    // Show the how-to-verify line for skip too: it's not a problem,
    // but the operator should be able to verify it on demand. Honest,
    // not hidden (the "lying by omission" anti-pattern).
    if (r.fix && r.status !== "ok") {
      console.log(chalk.gray(`      \u2192 ${r.fix}`));
    }
  }
  return { oks, warns, fails, skips };
}

// ---------------------------------------------------------------------------
// MFF skill probes
// ---------------------------------------------------------------------------

/**
 * Vault key name used by the MFF skill.
 * @internal exported for testing
 */
export const MFF_VAULT_KEY = "mff/agent-private-key";

/**
 * Name of the first agent that enables the MFF skill, if any. Since
 * WS6-F2 (#1390) MFF credentials live per-agent under
 * `~/.switchroom/credentials/<agent>/my-family-finance/`, so the doctor
 * resolves the path from config rather than the retired flat location.
 * @internal exported for testing
 */
export function mffAgentName(config?: SwitchroomConfig): string | undefined {
  for (const [name, ac] of Object.entries(config?.agents ?? {})) {
    if (((ac?.skills as string[] | undefined) ?? []).includes("my-family-finance")) {
      return name;
    }
  }
  return undefined;
}

/**
 * Resolve the MFF skill `.env` path. Per-agent since WS6-F2; falls back
 * to the legacy flat path when no MFF agent is configured (preserves
 * behaviour for pre-WS6-F2 installs and explicit-path test calls).
 * @internal exported for testing
 */
export function mffEnvPath(config?: SwitchroomConfig): string {
  const home = process.env.HOME ?? "/root";
  const agent = mffAgentName(config);
  return agent
    ? resolve(home, ".switchroom/credentials", agent, "my-family-finance/.env")
    : resolve(home, ".switchroom/credentials/my-family-finance/.env");
}

/**
 * Classify the MFF env path. `agent-private` is the EXPECTED healthy
 * post-WS6-F2 state: the file exists but is owned by the agent UID
 * (mode 600), so the operator-run doctor cannot read it BY DESIGN —
 * that is the security boundary working, not a failure. `absent` is a
 * real misconfig; `readable` is a legacy-flat or test path the host
 * can fully validate.
 * @internal exported for testing
 */
export type MffEnvState = "absent" | "agent-private" | "readable";
export function mffEnvState(envPath: string): MffEnvState {
  if (!existsSync(envPath)) return "absent";
  try {
    accessSync(envPath, fsConstants.R_OK);
    return "readable";
  } catch {
    return "agent-private";
  }
}

/**
 * Probe 1: vault key present — is `mff/agent-private-key` in the vault?
 * Skips (warn) when the vault passphrase is not set.
 * @internal exported for testing
 */
export function checkMffVaultKeyPresent(
  passphrase: string | undefined,
  vaultPath: string,
): CheckResult {
  if (!passphrase) {
    return {
      name: "mff: vault key present",
      status: "skip",
      detail: "SWITCHROOM_VAULT_PASSPHRASE not set — skipping vault checks",
      fix: "Export SWITCHROOM_VAULT_PASSPHRASE to enable MFF vault probes",
    };
  }
  if (!existsSync(vaultPath)) {
    return {
      name: "mff: vault key present",
      status: "fail",
      detail: `vault file not found at ${vaultPath}`,
      fix: "Run `switchroom vault init` to create the vault",
    };
  }
  try {
    const keys = listSecrets(passphrase, vaultPath);
    if (!keys.includes(MFF_VAULT_KEY)) {
      return {
        name: "mff: vault key present",
        status: "fail",
        detail: `${MFF_VAULT_KEY} not found in vault`,
        fix: `Run \`switchroom vault set ${MFF_VAULT_KEY} --format pem\` to store the agent private key`,
      };
    }
    return { name: "mff: vault key present", status: "ok", detail: MFF_VAULT_KEY };
  } catch (err) {
    return {
      name: "mff: vault key present",
      status: "fail",
      detail: (err as Error).message,
      fix: "Verify SWITCHROOM_VAULT_PASSPHRASE is correct",
    };
  }
}

/**
 * Try to parse raw bytes as an Ed25519 key. Accepts:
 *  - PEM `-----BEGIN PRIVATE KEY-----`
 *  - raw 32-byte seed (returns the DER-wrapped key)
 * Returns the DER SubjectPublicKeyInfo bytes of the corresponding public key
 * on success, or null on failure.
 * @internal exported for testing
 */
export function deriveEd25519PublicKeyBytes(keyMaterial: string): Buffer | null {
  const trimmed = keyMaterial.trim();
  // Try PEM first
  if (trimmed.includes("-----BEGIN")) {
    try {
      const privKey = createPrivateKey({ key: trimmed, format: "pem" });
      const pubKey = createPublicKey(privKey);
      return pubKey.export({ type: "spki", format: "der" }) as Buffer;
    } catch {
      return null;
    }
  }
  // Try base64-encoded raw 32-byte seed
  try {
    const rawSeed = Buffer.from(trimmed, "base64");
    if (rawSeed.length !== 32) return null;
    // Build PKCS#8 DER for an Ed25519 private key from raw seed.
    // PKCS#8 Ed25519 = SEQUENCE { SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING { seed } } }
    const oidPkcs8Ed25519 = Buffer.from(
      "302e020100300506032b657004220420",
      "hex",
    );
    const der = Buffer.concat([oidPkcs8Ed25519, rawSeed]);
    const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const pubKey = createPublicKey(privKey);
    return pubKey.export({ type: "spki", format: "der" }) as Buffer;
  } catch {
    return null;
  }
}

/**
 * Probe 2: vault key format — deserializable as Ed25519 (PEM or raw seed).
 * Skips when passphrase not set or key not present.
 * @internal exported for testing
 */
export function checkMffVaultKeyFormat(
  passphrase: string | undefined,
  vaultPath: string,
): CheckResult {
  if (!passphrase || !existsSync(vaultPath)) {
    return {
      name: "mff: vault key format",
      status: "warn",
      detail: "skipped (vault not accessible)",
    };
  }
  try {
    const keyMaterial = getStringSecret(passphrase, vaultPath, MFF_VAULT_KEY);
    if (keyMaterial === null) {
      return {
        name: "mff: vault key format",
        status: "warn",
        detail: "skipped (key not in vault)",
      };
    }
    const pubKeyBytes = deriveEd25519PublicKeyBytes(keyMaterial);
    if (!pubKeyBytes) {
      return {
        name: "mff: vault key format",
        status: "fail",
        detail: "cannot parse as Ed25519 key (not PEM, not base64 raw 32-byte seed)",
        fix: `Re-store the key with \`switchroom vault set ${MFF_VAULT_KEY} --format pem\``,
      };
    }
    const trimmed = keyMaterial.trim();
    const fmt = trimmed.includes("-----BEGIN") ? "PEM" : "base64 raw seed (converted)";
    return {
      name: "mff: vault key format",
      status: "ok",
      detail: `valid Ed25519 key (${fmt})`,
    };
  } catch (err) {
    return {
      name: "mff: vault key format",
      status: "fail",
      detail: (err as Error).message,
      fix: "Verify the vault key material is a valid Ed25519 private key",
    };
  }
}

/**
 * Probe 3: .env present and MFF_API_URL populated.
 * @internal exported for testing
 */
export function checkMffEnvFile(
  envPath: string = mffEnvPath(),
): CheckResult {
  const state = mffEnvState(envPath);
  if (state === "absent") {
    return {
      name: "mff: .env present",
      status: "fail",
      detail: `${envPath} not found`,
      fix: "Place the MFF skill's .env in the per-agent credentials dir, e.g. `~/.switchroom/credentials/<agent>/my-family-finance/.env` (MFF_API_URL=https://...), then `switchroom update`",
    };
  }
  if (state === "agent-private") {
    return {
      name: "mff: .env present",
      status: "ok",
      detail: `present, agent-private (${envPath}) — per-agent since WS6-F2; the operator-run doctor cannot read it by design`,
    };
  }
  const env = parseEnvFile(envPath);
  if (!env.MFF_API_URL || env.MFF_API_URL.trim() === "") {
    return {
      name: "mff: .env present",
      status: "fail",
      detail: `MFF_API_URL is empty in ${envPath}`,
      fix: "Set MFF_API_URL=https://<your-mff-host> in the .env file",
    };
  }
  return {
    name: "mff: .env present",
    status: "ok",
    detail: `MFF_API_URL set (${env.MFF_API_URL})`,
  };
}

/**
 * Probe 4: API URL reachable — GET /api/health returns 200.
 * Skips when MFF_API_URL is not configured.
 * @internal exported for testing
 */
export async function checkMffApiReachable(
  envPath: string = mffEnvPath(),
  timeoutMs = 5000,
): Promise<CheckResult> {
  const state = mffEnvState(envPath);
  if (state !== "readable") {
    return {
      name: "mff: API reachable",
      status: "skip",
      detail:
        state === "agent-private"
          ? "skipped — MFF creds are per-agent/agent-private since WS6-F2; deep probe must run in-agent"
          : "skipped (MFF .env not found — see 'mff: .env present')",
    };
  }
  const env = parseEnvFile(envPath);
  const apiUrl = env.MFF_API_URL?.trim();
  if (!apiUrl) {
    return {
      name: "mff: API reachable",
      status: "warn",
      detail: "skipped (MFF_API_URL not set)",
    };
  }
  const healthUrl = `${apiUrl.replace(/\/$/, "")}/api/health`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "switchroom-doctor/1.0" },
    });
    if (res.ok) {
      return {
        name: "mff: API reachable",
        status: "ok",
        detail: `GET ${healthUrl} → ${res.status}`,
      };
    }
    return {
      name: "mff: API reachable",
      status: "fail",
      detail: `GET ${healthUrl} → HTTP ${res.status}`,
      fix: "Verify MFF_API_URL is correct and the service is running",
    };
  } catch (err) {
    const e = err as Error;
    const detail =
      e.name === "AbortError"
        ? `timeout after ${timeoutMs}ms reaching ${healthUrl}`
        : `${e.message} (${healthUrl})`;
    return {
      name: "mff: API reachable",
      status: "fail",
      detail,
      fix: "Check MFF_API_URL is reachable from this host",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe 5: Auth flow — run claude-auth.py --quiet and verify the returned
 * session token against /api/categories.
 * Skips when MFF_API_URL is not set or claude-auth.py is not found.
 * @internal exported for testing
 */
export async function checkMffAuthFlow(
  envPath: string = mffEnvPath(),
  timeoutMs = 8000,
): Promise<CheckResult> {
  const state = mffEnvState(envPath);
  if (state !== "readable") {
    return {
      name: "mff: auth flow",
      status: "skip",
      detail:
        state === "agent-private"
          ? "skipped — MFF creds are per-agent/agent-private since WS6-F2; deep probe must run in-agent"
          : "skipped (MFF .env not found — see 'mff: .env present')",
    };
  }
  const env = parseEnvFile(envPath);
  const apiUrl = env.MFF_API_URL?.trim();
  if (!apiUrl) {
    return {
      name: "mff: auth flow",
      status: "warn",
      detail: "skipped (MFF_API_URL not set)",
    };
  }

  // Locate claude-auth.py next to the .env (per-agent dir since
  // WS6-F2 — colocated with the skill's other credential files).
  const credDir = dirname(envPath);
  const authScript = join(credDir, "claude-auth.py");
  if (!existsSync(authScript)) {
    return {
      name: "mff: auth flow",
      status: "warn",
      detail: `claude-auth.py not found at ${authScript} — skipping auth probe`,
      fix: "Ensure the MFF skill's claude-auth.py is present in the credentials directory",
    };
  }

  // Run claude-auth.py --quiet; expect it to print a session token on stdout.
  const python3 = which("python3") ?? "python3";
  let token: string;
  try {
    const result = spawnSync(python3, [authScript, "--quiet"], {
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? "";
      return {
        name: "mff: auth flow",
        status: "fail",
        detail: `claude-auth.py exited ${result.status ?? "non-zero"}${stderr ? `: ${stderr}` : ""}`,
        fix: "Fix the auth script or the credentials it uses (vault key, API URL, passphrase)",
      };
    }
    token = (result.stdout ?? "").trim();
    if (!token) {
      return {
        name: "mff: auth flow",
        status: "fail",
        detail: "claude-auth.py printed no token",
        fix: "Verify claude-auth.py implements the email|timestamp → /api/auth/agent-login exchange",
      };
    }
  } catch (err) {
    return {
      name: "mff: auth flow",
      status: "fail",
      detail: (err as Error).message,
      fix: "Check claude-auth.py is executable and python3 is on PATH",
    };
  }

  // Probe the token against /api/categories
  const categoriesUrl = `${apiUrl.replace(/\/$/, "")}/api/categories`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(categoriesUrl, {
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "switchroom-doctor/1.0",
      },
    });
    if (res.ok) {
      return {
        name: "mff: auth flow",
        status: "ok",
        detail: `token accepted by ${categoriesUrl} → ${res.status}`,
      };
    }
    return {
      name: "mff: auth flow",
      status: "fail",
      detail: `token rejected by ${categoriesUrl} → HTTP ${res.status}`,
      fix: "The token from claude-auth.py is not accepted — verify the auth protocol matches the API",
    };
  } catch (err) {
    const e = err as Error;
    return {
      name: "mff: auth flow",
      status: "fail",
      detail: e.name === "AbortError" ? `timeout verifying token` : e.message,
      fix: "Check network connectivity to the MFF API",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe 6: Cloudflare UA bypass — detect whether the default Python urllib
 * user-agent is blocked (returns 403 / status 1010) while a browser UA is not.
 *
 * This probe *detects* the block; it does not fix it (changing the skill UA
 * is a separate concern).
 *
 * Skips when MFF_API_URL is not set.
 * @internal exported for testing
 */
export async function checkMffCloudflareUa(
  envPath: string = mffEnvPath(),
  timeoutMs = 5000,
): Promise<CheckResult> {
  const state = mffEnvState(envPath);
  if (state !== "readable") {
    return {
      name: "mff: Cloudflare UA bypass",
      status: "skip",
      detail:
        state === "agent-private"
          ? "skipped — MFF creds are per-agent/agent-private since WS6-F2; deep probe must run in-agent"
          : "skipped (MFF .env not found — see 'mff: .env present')",
    };
  }
  const env = parseEnvFile(envPath);
  const apiUrl = env.MFF_API_URL?.trim();
  if (!apiUrl) {
    return {
      name: "mff: Cloudflare UA bypass",
      status: "warn",
      detail: "skipped (MFF_API_URL not set)",
    };
  }

  const healthUrl = `${apiUrl.replace(/\/$/, "")}/api/health`;
  const pythonUa = "python-urllib3/1.26.0";
  const browserUa =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  async function probe(ua: string): Promise<{ status: number; ok: boolean } | { error: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(healthUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": ua },
      });
      return { status: res.status, ok: res.ok };
    } catch (err) {
      const e = err as Error;
      return { error: e.name === "AbortError" ? "timeout" : e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  const pythonResult = await probe(pythonUa);
  const browserResult = await probe(browserUa);

  if ("error" in pythonResult || "error" in browserResult) {
    return {
      name: "mff: Cloudflare UA bypass",
      status: "warn",
      detail: `probe error — python: ${"error" in pythonResult ? pythonResult.error : "ok"}, browser: ${"error" in browserResult ? browserResult.error : "ok"}`,
    };
  }

  const pythonBlocked = !pythonResult.ok && (pythonResult.status === 403 || pythonResult.status === 1010 || pythonResult.status === 503);
  const browserAllowed = browserResult.ok;

  if (pythonBlocked && browserAllowed) {
    return {
      name: "mff: Cloudflare UA bypass",
      status: "fail",
      detail: `Python UA returns ${pythonResult.status}, browser UA returns ${browserResult.status} — Cloudflare is blocking the skill's default UA`,
      fix: "Set a browser-like User-Agent in the MFF skill's HTTP requests (e.g. in claude-auth.py and any direct API calls)",
    };
  }

  if (!pythonBlocked) {
    return {
      name: "mff: Cloudflare UA bypass",
      status: "ok",
      detail: `Python UA not blocked (${pythonResult.status}) — Cloudflare pass-through confirmed`,
    };
  }

  // python blocked but browser also blocked — something else is wrong
  return {
    name: "mff: Cloudflare UA bypass",
    status: "warn",
    detail: `Python UA: ${pythonResult.status}, browser UA: ${browserResult.status} — API may be down or requires authentication`,
    fix: "Check MFF_API_URL and whether the /api/health endpoint is publicly accessible",
  };
}

/**
 * Run all MFF skill probes in sequence.
 * @internal exported for testing
 */
export async function checkMff(
  passphrase: string | undefined,
  vaultPath: string,
  config?: SwitchroomConfig,
  envPath: string = mffEnvPath(config),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(checkMffVaultKeyPresent(passphrase, vaultPath));
  results.push(checkMffVaultKeyFormat(passphrase, vaultPath));
  results.push(checkMffEnvFile(envPath));
  results.push(await checkMffApiReachable(envPath));
  results.push(await checkMffAuthFlow(envPath));
  results.push(await checkMffCloudflareUa(envPath));
  return results;
}

/**
 * Warn-only components for manifest drift checks.
 * Drift on these components produces a "warn" result, not a "fail".
 */
const MANIFEST_WARN_ONLY = new Set([
  "@playwright/mcp",
  "hindsight.backend",
  "hindsight.client",
  "vault_broker.protocol",
]);

/**
 * Probe installed versions and compare against the pinned manifest.
 * Returns an empty array when `dependencies.json` is not found — the
 * manifest is optional for users running from a non-git install.
 *
 * @param probers - Optional injectable version probers (for tests).
 * @internal exported for testing
 */
export async function checkManifestDrift(probers?: DriftProbers): Promise<CheckResult[]> {
  let manifest;
  try {
    manifest = loadManifest();
  } catch {
    // Missing manifest is not a failure — users without the file (e.g.
    // npm-installed switchroom without the repo) skip this check.
    return [];
  }

  const report = await detectDrift(manifest, probers);
  if (report.drift.length === 0) {
    return [
      {
        name: "dependency manifest",
        status: "ok",
        detail: `all versions match (manifest ${manifest.switchroom_version})`,
      },
    ];
  }

  const results: CheckResult[] = [];
  for (const item of report.drift) {
    const warnOnly = MANIFEST_WARN_ONLY.has(item.component);
    const installedStr = item.installed ?? "(not installed)";

    // Determine severity
    let status: CheckStatus = warnOnly ? "warn" : "fail";
    if (!warnOnly && item.installed !== null) {
      // Only fail on major-version mismatch; minor/patch → warn
      const dMajor = item.declared.match(/^(\d+)/)?.[1];
      const iMajor = item.installed.replace(/^v/, "").match(/^(\d+)/)?.[1];
      if (dMajor !== undefined && iMajor !== undefined && dMajor === iMajor) {
        status = "warn";
      }
    }

    results.push({
      name: `manifest drift: ${item.component}`,
      status,
      detail: `declared ${item.declared}, installed ${installedStr}`,
      fix:
        status === "fail"
          ? `Update ${item.component} to match the manifest, or re-run \`switchroom update\``
          : undefined,
    });
  }

  return results;
}

function runDockerSection(config: SwitchroomConfig): CheckResult[] {
  const composePath = resolve(
    process.env.HOME ?? "",
    ".switchroom",
    "compose",
    "docker-compose.yml",
  );
  const active = isDockerMode({ composePath });
  let composeYaml: string | undefined;
  let dockerfileAgent: string | undefined;
  try { composeYaml = readFileSync(composePath, "utf8"); } catch { /* none */ }
  // Dockerfile path is relative to the install — best-effort lookup.
  const dockerfilePath = resolve(
    process.env.HOME ?? "",
    ".switchroom",
    "docker",
    "Dockerfile.agent",
  );
  try { dockerfileAgent = readFileSync(dockerfilePath, "utf8"); } catch { /* none */ }

  return runDockerChecks({
    config,
    composeYaml,
    dockerfileAgent,
    active,
  });
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose Switchroom's setup: deps, vault, memory, agents, MCP wireup")
    .option("--json", "Output as JSON")
    .option("--skill <name>", "Run probes for a specific skill only (e.g. mff)")
    .option(
      "--fast",
      "Skip in-agent (hostd) liveness probes — offline/quick; the host-unverifiable rows stay `skip`",
    )
    .action(
      withConfigError(async (opts: { json?: boolean; skill?: string; fast?: boolean }) => {
        // Pre-config-load short-circuit: if no switchroom.yaml exists yet
        // (e.g. fresh install before `switchroom setup`), running doctor
        // should still be useful — that's exactly when an operator wants
        // to verify their dependencies. Run the config-free sections
        // (deps + skills prereqs) and exit, instead of erroring.
        try {
          getConfigPath(program);
        } catch (_e) {
          const depsOnlySections = [
            { title: "Dependencies", results: checkDependencies() },
            { title: "Skills Prerequisites", results: checkSkillsPrerequisites() },
          ];
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  sections: depsOnlySections,
                  configMissing: true,
                  hint: "No switchroom.yaml found; ran deps-only preflight. Run `switchroom setup` to bootstrap config.",
                },
                null,
                2,
              ),
            );
          } else {
            console.log(
              chalk.yellow(
                "No switchroom.yaml found — running deps-only preflight.",
              ),
            );
            console.log(
              chalk.gray(
                "  Run `switchroom setup` to bootstrap config + Telegram wiring.",
              ),
            );
            console.log();
            let totalFails = 0;
            for (const s of depsOnlySections) {
              const { fails } = printSection(s.title, s.results);
              totalFails += fails;
            }
            console.log();
            if (totalFails > 0) {
              process.exit(1);
            }
          }
          return;
        }

        const config = getConfig(program);
        const configPath = getConfigPath(program);

        const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
        const vaultPath = config.vault?.path
          ? config.vault.path.replace(/^~/, process.env.HOME ?? "")
          : resolveStatePath("vault.enc");

        // --skill mff: run MFF probes only
        if (opts.skill === "mff") {
          const mffResults = await checkMff(passphrase, vaultPath, config);
          if (opts.json) {
            console.log(
              JSON.stringify(
                { sections: [{ title: "MFF Skill", results: mffResults }] },
                null,
                2,
              ),
            );
          } else {
            const { fails } = printSection("MFF Skill", mffResults);
            console.log();
            if (fails > 0) {
              process.exit(1);
            }
          }
          return;
        }

        if (opts.skill) {
          console.error(`Unknown skill: ${opts.skill}. Supported: mff`);
          process.exit(1);
        }

        // Shared vault-broker ACL reader for the connection-health probes
        // (Notion + user-declared MCP secrets). Soft-fails to "unreachable"
        // so a down/locked broker yields warnings, never false failures.
        const vaultAclReader = async (
          key: string,
        ): Promise<
          | { kind: "ok"; allow: string[]; deny: string[] }
          | { kind: "unreachable"; msg: string }
          | { kind: "not_found" }
        > => {
          try {
            const { getViaBrokerStructured } = await import("../vault/broker/client.js");
            const result = await getViaBrokerStructured(key);
            if (result.kind === "ok") {
              return {
                kind: "ok",
                allow: result.entry.scope?.allow ?? [],
                deny: result.entry.scope?.deny ?? [],
              };
            }
            if (result.kind === "not_found") return { kind: "not_found" };
            return { kind: "unreachable", msg: result.msg };
          } catch (err) {
            return { kind: "unreachable", msg: (err as Error).message };
          }
        };

        const sections: Array<{ title: string; results: CheckResult[] }> = [
          { title: "Dependencies", results: checkDependencies() },
          { title: "Skills Prerequisites", results: checkSkillsPrerequisites() },
          { title: "Manifest Drift", results: await checkManifestDrift() },
          { title: "Configuration", results: checkConfig(config, configPath) },
          {
            title: "Config secrets (WS6-F3)",
            results: runInlinedSecretChecks(config, { configPath }),
          },
          { title: "Legacy State", results: checkLegacyState() },
          { title: "Vault", results: checkVault(config) },
          {
            title: "Vault-broker durability",
            results: runVaultBrokerDurabilityChecks(config),
          },
          { title: "Vault access", results: await runSecretAccessChecks(config) },
          { title: "Memory (Hindsight)", results: await checkHindsight(config) },
          { title: "Telegram", results: await checkTelegram(config) },
          { title: "Agents", results: checkAgents(config, configPath) },
          { title: "Credentials", results: runCredentialsMigrationChecks(config) },
          { title: "Audit integrity (WS10-F4)", results: runAuditIntegrityChecks() },
          { title: "Docker (Phase 1a)", results: runDockerSection(config) },
          { title: "Auth Broker", results: runAuthBrokerChecks(config) },
          { title: "Host control (hostd)", results: runHostdChecks(config) },
          {
            title: "Agent liveness (in-agent via hostd)",
            results: await runAgentSmokeChecks(config, { fast: opts.fast }),
          },
          {
            title: "Google Drive",
            results: [
              ...runDriveChecks(config),
              ...(await runDriveBrokerReachabilityChecks(config)),
            ],
          },
          {
            title: "Microsoft 365 (RFC #1873)",
            results: runMicrosoftChecks(config),
          },
          {
            title: "Notion (RFC notion-integration)",
            results: await runNotionChecks(config, { vaultAclReader }),
          },
          {
            title: "MCP Connections (auth)",
            results: await runMcpSecretChecks(config, { vaultAclReader }),
          },
          {
            title: "Context Headroom",
            results: await runContextChecks(config, {
              readSnapshot: async (agent) => {
                // Snapshot lives at the agent's 0700 state dir → read via
                // docker exec (mirrors how status queries agents).
                try {
                  const { execFileSync } = await import("node:child_process");
                  const out = execFileSync(
                    "docker",
                    ["exec", `switchroom-${agent}`, "cat", "/state/agent/context-occupancy.json"],
                    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
                  );
                  return { kind: "ok", snapshot: JSON.parse(out) };
                } catch (err) {
                  const msg = (err as Error).message ?? String(err);
                  // No file / container down → absent (skip), not a failure.
                  if (/No such|cannot|not running|exited|No such container/i.test(msg)) {
                    return { kind: "absent" };
                  }
                  return { kind: "unreadable", msg: `snapshot read failed: ${msg}` };
                }
              },
            }),
          },
          { title: "MFF Skill", results: await checkMff(passphrase, vaultPath, config) },
          { title: "Webkite", results: runWebkiteChecks(config) },
          // #2307 Tier-1: cron-session bridge liveness. Empty (no results) for
          // the fleet today — only agents the value-gate routes to a cron
          // session produce a line.
          { title: "Cron Session", results: runCronSessionChecks(config) },
        ];

        // Repo Hygiene (#1072): only when doctor runs from a switchroom
        // checkout. On a consumer host this section is silent — the
        // probe is for the developer/operator who has the source tree.
        const cwd = process.cwd();
        if (isSwitchroomCheckout(cwd)) {
          sections.push({
            title: "Repo Hygiene",
            results: checkRepoHygiene(cwd),
          });
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                sections: sections.map((s) => ({
                  title: s.title,
                  results: s.results,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }

        let totalOk = 0;
        let totalWarn = 0;
        let totalFail = 0;
        let totalSkip = 0;
        for (const { title, results } of sections) {
          if (results.length === 0) continue;
          const { oks, warns, fails, skips } = printSection(title, results);
          totalOk += oks;
          totalWarn += warns;
          totalFail += fails;
          totalSkip += skips;
        }

        console.log();
        // `skip` is appended last and never affects the exit code —
        // it means "not checked from here by design", not a problem.
        // Keeping the ok/warn/fail order stable preserves operator
        // muscle-memory and any loose output readers.
        const summary =
          `${chalk.green(`${totalOk} ok`)} · ${chalk.yellow(`${totalWarn} warn`)} · ${chalk.red(`${totalFail} fail`)}` +
          ` · ${chalk.gray(`${totalSkip} skip`)}`;
        console.log(`  ${summary}`);
        console.log();

        if (totalFail > 0) {
          process.exit(1);
        }
      }),
    );
}
