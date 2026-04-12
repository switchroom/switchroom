import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAgentsDir } from "../config/loader.js";
import { getConfig, getConfigPath, withConfigError } from "./helpers.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import type { ClerkConfig } from "../config/schema.js";

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
      "sudo apt install expect (only required for clerk-telegram plugin agents)",
    ),
    checkBinary("docker", "docker", "Install Docker (only required for Hindsight memory)"),
    checkBinary("systemctl", "systemctl", "Clerk requires a systemd-based Linux distro"),
  ];
}

function checkConfig(config: ClerkConfig, configPath: string): CheckResult[] {
  const results: CheckResult[] = [];

  results.push({
    name: "clerk.yaml loaded",
    status: "ok",
    detail: configPath,
  });

  const agentCount = Object.keys(config.agents).length;
  results.push({
    name: "agents defined",
    status: agentCount > 0 ? "ok" : "warn",
    detail: agentCount > 0 ? `${agentCount} agent(s)` : "no agents",
    fix: agentCount === 0
      ? "Add at least one agent under `agents:` in clerk.yaml"
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

  return results;
}

function checkVault(config: ClerkConfig): CheckResult[] {
  const vaultPath = config.vault?.path
    ? config.vault.path.replace(/^~/, process.env.HOME ?? "")
    : join(process.env.HOME ?? "", ".clerk/vault.enc");

  if (!existsSync(vaultPath)) {
    return [
      {
        name: "vault file present",
        status: "warn",
        detail: `${vaultPath} not found`,
        fix: "Run `clerk vault init` if you plan to store secrets in the vault",
      },
    ];
  }

  const passphrase = process.env.CLERK_VAULT_PASSPHRASE;
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
        detail: "CLERK_VAULT_PASSPHRASE not set; cannot verify decrypt",
        fix: "Export CLERK_VAULT_PASSPHRASE to verify the vault unlocks",
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
        fix: "CLERK_VAULT_PASSPHRASE is wrong, or the vault file is corrupted",
      },
    ];
  }
}

function checkHindsight(config: ClerkConfig): CheckResult[] {
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
          "Run `clerk memory setup` to start the Hindsight container, " +
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

function checkAgents(config: ClerkConfig, configPath: string): CheckResult[] {
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
        fix: `Run \`clerk agent create ${name}\``,
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
        fix: `Run \`clerk agent start ${name}\``,
      });
    }

    // 3. Auth
    const auth = authStatuses[name];
    if (!auth?.authenticated) {
      results.push({
        name: `${name}: auth`,
        status: "fail",
        detail: "not authenticated",
        fix: `Run \`clerk auth login ${name}\` and complete the OAuth flow`,
      });
    } else {
      results.push({
        name: `${name}: auth`,
        status: "ok",
        detail: auth.subscriptionType ?? "authenticated",
      });
    }

    // 4. MCP wireup drift detection (clerk-telegram plugin agents)
    if (agentConfig.channels?.telegram?.plugin === "clerk") {
      const mcpJsonPath = join(agentDir, ".mcp.json");
      if (!existsSync(mcpJsonPath)) {
        results.push({
          name: `${name}: .mcp.json`,
          status: "fail",
          detail: "missing",
          fix: `Run \`clerk agent reconcile ${name}\``,
        });
      } else {
        try {
          const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
          const hasClerkTelegram = !!mcp.mcpServers?.["clerk-telegram"];
          const memoryEnabled = config.memory?.backend === "hindsight";
          const hasHindsight = !!mcp.mcpServers?.hindsight;

          if (!hasClerkTelegram) {
            results.push({
              name: `${name}: .mcp.json`,
              status: "fail",
              detail: "missing clerk-telegram entry",
              fix: `Run \`clerk agent reconcile ${name} --restart\``,
            });
          } else if (memoryEnabled && !hasHindsight) {
            results.push({
              name: `${name}: .mcp.json`,
              status: "warn",
              detail: "memory enabled in clerk.yaml but hindsight missing from .mcp.json",
              fix: `Run \`clerk agent reconcile ${name} --restart\``,
            });
          } else {
            results.push({
              name: `${name}: .mcp.json`,
              status: "ok",
              detail: memoryEnabled ? "clerk-telegram + hindsight" : "clerk-telegram",
            });
          }
        } catch (err) {
          results.push({
            name: `${name}: .mcp.json`,
            status: "fail",
            detail: `parse error: ${(err as Error).message}`,
            fix: `Run \`clerk agent reconcile ${name}\``,
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
    .description("Diagnose Clerk's setup: deps, vault, memory, agents, MCP wireup")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const configPath = getConfigPath(program);

        const sections: Array<{ title: string; results: CheckResult[] }> = [
          { title: "Dependencies", results: checkDependencies() },
          { title: "Configuration", results: checkConfig(config, configPath) },
          { title: "Vault", results: checkVault(config) },
          { title: "Memory (Hindsight)", results: checkHindsight(config) },
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
