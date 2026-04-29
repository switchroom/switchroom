import type { Command } from "commander";
import chalk from "chalk";
import { execSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createPublicKey, createPrivateKey } from "node:crypto";
import { listSecrets, getStringSecret } from "../vault/vault.js";
import { resolveAgentsDir, resolvePath } from "../config/loader.js";
import { resolveStatePath } from "../config/paths.js";
import { getConfig, getConfigPath, withConfigError } from "./helpers.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getSlotInfos, type SlotInfo } from "../auth/accounts.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { loadManifest, detectDrift, type DriftProbers } from "../manifest.js";

/**
 * Result of a single doctor check.
 */
type CheckStatus = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

function statusGlyph(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return chalk.green("\u2713");
    case "warn":
      return chalk.yellow("!");
    case "fail":
      return chalk.red("\u2717");
  }
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
    checkBinary("docker", "docker", "Install Docker (only required for Hindsight memory)"),
    checkBinary("systemctl", "systemctl", "Switchroom requires a systemd-based Linux distro"),
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
 * browser cache at ~/.cache/ms-playwright/. Returns the path to the
 * first match, or null.
 * @internal exported for testing
 */
export function findChromium(
  homeDir: string = process.env.HOME ?? "",
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

  const playwrightCache = join(homeDir, ".cache", "ms-playwright");
  if (!existsSync(playwrightCache)) return null;
  try {
    const entries = readdirSync(playwrightCache).filter((e) =>
      e.startsWith("chromium"),
    );
    for (const entry of entries) {
      const linuxPath = join(
        playwrightCache,
        entry,
        "chrome-linux",
        "chrome",
      );
      if (existsSync(linuxPath)) return linuxPath;
    }
  } catch {
    /* unreadable */
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

  return results;
}

function checkVault(config: SwitchroomConfig): CheckResult[] {
  const vaultPath = config.vault?.path
    ? config.vault.path.replace(/^~/, process.env.HOME ?? "")
    : resolveStatePath("vault.enc");

  if (!existsSync(vaultPath)) {
    return [
      {
        name: "vault file present",
        status: "warn",
        detail: `${vaultPath} not found`,
        fix: "Run `switchroom vault init` if you plan to store secrets in the vault",
      },
    ];
  }

  const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (!passphrase) {
    return [
      {
        name: "vault file present",
        status: "ok",
        detail: vaultPath,
      },
      {
        name: "vault unlock",
        status: "warn",
        detail: "SWITCHROOM_VAULT_PASSPHRASE not set; cannot verify decrypt",
        fix: "Export SWITCHROOM_VAULT_PASSPHRASE to verify the vault unlocks",
      },
    ];
  }

  try {
    const keys = listSecrets(passphrase, vaultPath);
    return [
      {
        name: "vault unlock",
        status: "ok",
        detail: `${keys.length} secret(s)`,
      },
    ];
  } catch (err) {
    return [
      {
        name: "vault unlock",
        status: "fail",
        detail: (err as Error).message,
        fix: "SWITCHROOM_VAULT_PASSPHRASE is wrong, or the vault file is corrupted",
      },
    ];
  }
}

function checkHindsight(config: SwitchroomConfig): CheckResult[] {
  const memoryBackend = config.memory?.backend;
  if (memoryBackend !== "hindsight") {
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
          "Run `switchroom memory setup` to start the Hindsight container, " +
          "or check `docker ps --filter name=hindsight`",
      },
    ];
  }

  results.push({
    name: "hindsight reachable",
    status: "ok",
    detail: `${host}:${port}`,
  });

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

  return results;
}

/**
 * Parse a simple KEY=VALUE env file. Quotes around values are stripped.
 * Lines starting with `#` and blank lines are ignored.
 * @internal exported for testing
 */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
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
    const env = parseEnvFile(envPath);
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      results.push({
        name: `${name}: bot token`,
        status: "fail",
        detail: `TELEGRAM_BOT_TOKEN missing from ${envPath}`,
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
 * Verify that an agent's generated gateway systemd unit pins
 * `Environment=SWITCHROOM_AGENT_NAME=<agent>` into the gateway process's
 * environment.
 *
 * Without that env var the gateway falls back to `basename(process.cwd())`,
 * which is literally the string "telegram" because `WorkingDirectory` is
 * `.../<agent>/telegram`. That makes every self-targeting command
 * (`/restart`, `/reconcile --restart`, `/update`, etc.) resolve the agent
 * as "telegram" — a name that doesn't exist in switchroom.yaml — so the
 * detached `switchroom agent <verb>` child exits non-zero and the user
 * sees nothing happen. See `generateGatewayUnit()` in
 * `src/agents/systemd.ts` for the matching producer-side fix.
 *
 * Overridable via `unitPath` for tests.
 * @internal exported for testing
 */
export function checkGatewayUnit(
  agentName: string,
  unitPath: string = resolve(
    process.env.HOME ?? "/root",
    ".config/systemd/user",
    `switchroom-${agentName}-gateway.service`,
  ),
): CheckResult {
  const label = `${agentName}: gateway unit`;
  if (!existsSync(unitPath)) {
    return {
      name: label,
      status: "warn",
      detail: `${unitPath} not installed`,
      fix: `Run \`switchroom reconcile --restart\` to install the gateway unit`,
    };
  }

  let content: string;
  try {
    content = readFileSync(unitPath, "utf-8");
  } catch (err) {
    return {
      name: label,
      status: "fail",
      detail: `unreadable: ${(err as Error).message}`,
      fix: `Run \`switchroom reconcile --restart\``,
    };
  }

  const expected = `Environment=SWITCHROOM_AGENT_NAME=${agentName}`;
  if (!content.includes(expected)) {
    return {
      name: label,
      status: "fail",
      detail:
        `missing \`${expected}\` — self-targeting commands (/restart, /reconcile) will silently fail`,
      fix: `Run \`switchroom reconcile --restart\` to regenerate the gateway unit and bounce the gateway`,
    };
  }

  return {
    name: label,
    status: "ok",
    detail: `SWITCHROOM_AGENT_NAME=${agentName} set`,
  };
}

function checkAgents(config: SwitchroomConfig, configPath: string): CheckResult[] {
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
      results.push({
        name: `${name}: auth`,
        status: "fail",
        detail: auth?.pendingAuth
          ? "pending (auth flow in progress)"
          : "not authenticated",
        fix: `Run \`switchroom auth login ${name}\` and complete the OAuth flow`,
      });
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
          ? `Token expires soon — run \`switchroom auth login ${name}\` to refresh`
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
              ? `Quota-exhausted slot(s) will auto-recover. Add a fresh slot with \`switchroom auth add ${name} <slot>\``
              : expired > 0
                ? `Expired slot(s) — run \`switchroom auth login ${name} --slot <name>\``
                : undefined,
        });
      }
    }

    // 4. MCP wireup drift detection (switchroom-telegram plugin agents)
    if (agentConfig.channels?.telegram?.plugin === "switchroom") {
      // 4a. Gateway unit health — ensures the generated systemd unit
      // pins the agent name into the gateway process's environment so
      // self-targeting commands (/restart, /reconcile, /update) resolve
      // correctly instead of falling back to basename(cwd) == "telegram".
      results.push(checkGatewayUnit(name));

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
          const memoryEnabled = config.memory?.backend === "hindsight";
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

function printSection(title: string, results: CheckResult[]): {
  oks: number;
  warns: number;
  fails: number;
} {
  console.log(chalk.bold(`\n${title}`));
  let oks = 0;
  let warns = 0;
  let fails = 0;
  for (const r of results) {
    if (r.status === "ok") oks++;
    if (r.status === "warn") warns++;
    if (r.status === "fail") fails++;
    const detail = r.detail ? chalk.gray(`  (${r.detail})`) : "";
    console.log(`  ${statusGlyph(r.status)} ${r.name}${detail}`);
    if (r.fix && r.status !== "ok") {
      console.log(chalk.gray(`      \u2192 ${r.fix}`));
    }
  }
  return { oks, warns, fails };
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
 * Default .env path for the MFF skill credentials.
 * @internal exported for testing
 */
export function mffEnvPath(): string {
  return resolve(
    process.env.HOME ?? "/root",
    ".switchroom/credentials/my-family-finance/.env",
  );
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
      status: "warn",
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
  if (!existsSync(envPath)) {
    return {
      name: "mff: .env present",
      status: "fail",
      detail: `${envPath} not found`,
      fix: "Create ~/.switchroom/credentials/my-family-finance/.env with MFF_API_URL=https://...",
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
  const env = parseEnvFile(envPath);
  const apiUrl = env.MFF_API_URL?.trim();
  if (!apiUrl) {
    return {
      name: "mff: auth flow",
      status: "warn",
      detail: "skipped (MFF_API_URL not set)",
    };
  }

  // Locate claude-auth.py relative to the MFF credentials dir.
  const credDir = resolve(process.env.HOME ?? "/root", ".switchroom/credentials/my-family-finance");
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
  envPath: string = mffEnvPath(),
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

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose Switchroom's setup: deps, vault, memory, agents, MCP wireup")
    .option("--json", "Output as JSON")
    .option("--skill <name>", "Run probes for a specific skill only (e.g. mff)")
    .action(
      withConfigError(async (opts: { json?: boolean; skill?: string }) => {
        const config = getConfig(program);
        const configPath = getConfigPath(program);

        const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
        const vaultPath = config.vault?.path
          ? config.vault.path.replace(/^~/, process.env.HOME ?? "")
          : resolveStatePath("vault.enc");

        // --skill mff: run MFF probes only
        if (opts.skill === "mff") {
          const mffResults = await checkMff(passphrase, vaultPath);
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

        const sections: Array<{ title: string; results: CheckResult[] }> = [
          { title: "Dependencies", results: checkDependencies() },
          { title: "Skills Prerequisites", results: checkSkillsPrerequisites() },
          { title: "Manifest Drift", results: await checkManifestDrift() },
          { title: "Configuration", results: checkConfig(config, configPath) },
          { title: "Vault", results: checkVault(config) },
          { title: "Memory (Hindsight)", results: checkHindsight(config) },
          { title: "Telegram", results: await checkTelegram(config) },
          { title: "Agents", results: checkAgents(config, configPath) },
          { title: "MFF Skill", results: await checkMff(passphrase, vaultPath) },
        ];

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
        for (const { title, results } of sections) {
          if (results.length === 0) continue;
          const { oks, warns, fails } = printSection(title, results);
          totalOk += oks;
          totalWarn += warns;
          totalFail += fails;
        }

        console.log();
        const summary = `${chalk.green(`${totalOk} ok`)} · ${chalk.yellow(`${totalWarn} warn`)} · ${chalk.red(`${totalFail} fail`)}`;
        console.log(`  ${summary}`);
        console.log();

        if (totalFail > 0) {
          process.exit(1);
        }
      }),
    );
}
