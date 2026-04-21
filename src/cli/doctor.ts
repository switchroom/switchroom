import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
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
import { resolveAgentsDir, resolvePath } from "../config/loader.js";
import { resolveStatePath } from "../config/paths.js";
import { getConfig, getConfigPath, withConfigError } from "./helpers.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getSlotInfos, type SlotInfo } from "../auth/accounts.js";
import type { SwitchroomConfig } from "../config/schema.js";

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
    // Lazy import so we don't pull vault crypto when not needed
    const { listSecrets } = require("../vault/vault.js") as typeof import("../vault/vault.js");
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

  return [
    {
      name: "hindsight reachable",
      status: "ok",
      detail: `${host}:${port}`,
    },
  ];
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

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose Switchroom's setup: deps, vault, memory, agents, MCP wireup")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const configPath = getConfigPath(program);

        const sections: Array<{ title: string; results: CheckResult[] }> = [
          { title: "Dependencies", results: checkDependencies() },
          { title: "Skills Prerequisites", results: checkSkillsPrerequisites() },
          { title: "Configuration", results: checkConfig(config, configPath) },
          { title: "Vault", results: checkVault(config) },
          { title: "Memory (Hindsight)", results: checkHindsight(config) },
          { title: "Telegram", results: await checkTelegram(config) },
          { title: "Agents", results: checkAgents(config, configPath) },
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
