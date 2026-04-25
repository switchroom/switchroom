import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { COMMIT_SHA, VERSION } from "../build-info.js";

/**
 * Try to get the installed claude-code version.
 * Returns a string like "2.1.119" or null if not installed / not parseable.
 */
function getClaudeCodeVersion(): string | null {
  try {
    const out = execSync("claude --version 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    // claude --version prints something like "1.0.3 (claude-code)"
    const m = out.match(/^(\S+)/);
    return m ? m[1] : (out || null);
  } catch {
    return null;
  }
}

/**
 * Check if the switchroom git tree is clean (no uncommitted changes).
 * Returns "clean" or "dirty", or null if not in a git repo.
 */
function getTreeStatus(installDir: string | null): "clean" | "dirty" | null {
  if (!installDir) return null;
  try {
    const out = execSync("git status --porcelain", {
      cwd: installDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out ? "dirty" : "clean";
  } catch {
    return null;
  }
}

/**
 * Parse an ActiveEnterTimestamp systemd property into a human-readable
 * uptime string like "5m", "4h", "2d".
 */
function formatUptime(timestamp: string | null): string {
  if (!timestamp) return "?";
  const start = new Date(timestamp).getTime();
  if (isNaN(start)) return "?";
  const seconds = Math.floor((Date.now() - start) / 1000);
  if (seconds <= 0) return "?";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Try to locate the switchroom install directory (git checkout root) from the
 * current process's import path. Mirrors the logic in update.ts.
 */
function locateSwitchroomInstallDir(): string | null {
  let dir: string | undefined = import.meta.dirname;
  for (let i = 0; i < 10 && dir && dir !== "/"; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "switchroom-ai" && existsSync(join(dir, ".git"))) {
          return dir;
        }
      } catch { /* ignore */ }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Build and print the one-line health summary:
 *
 *   ✓ claude-code 2.1.119
 *   ✓ switchroom 7278044 (clean)
 *   ✓ klanker → up 5m, on 7278044
 *   ✗ gymbro → down
 *   ✓ foreman → up 2d, on ?
 */
export function printHealthSummary(config: ReturnType<typeof getConfig>): void {
  const lines: string[] = [];

  // Claude CLI version
  const claudeVersion = getClaudeCodeVersion();
  if (claudeVersion) {
    lines.push(chalk.green(`✓ claude-code ${claudeVersion}`));
  } else {
    lines.push(chalk.yellow("! claude-code (version unknown)"));
  }

  // Switchroom binary version + SHA + tree status
  const sha = COMMIT_SHA ?? "?";
  const installDir = locateSwitchroomInstallDir();
  const tree = getTreeStatus(installDir);
  const treeLabel = tree ? ` (${tree})` : "";
  // Show both semver and SHA for full context
  lines.push(chalk.green(`✓ switchroom ${VERSION} / ${sha}${treeLabel}`));

  // Agent lines
  const agentNames = Object.keys(config.agents);
  if (agentNames.length > 0) {
    const statuses = getAllAgentStatuses(config);
    for (const name of agentNames) {
      const s = statuses[name];
      const isUp = s.active === "active" || s.active === "running";
      const uptime = formatUptime(s.uptime);
      // The SHA the process was started with is not trivially available
      // from systemd alone. We use the COMMIT_SHA of the current binary
      // as a proxy (since switchroom update rebuilds + restarts everything).
      // A future iteration can embed the SHA into the systemd Environment=
      // at install time for per-process accuracy.
      if (isUp) {
        lines.push(chalk.green(`✓ ${name} → up ${uptime}, on ${sha}`));
      } else {
        lines.push(chalk.red(`✗ ${name} → ${s.active}`));
      }
    }
  }

  for (const line of lines) {
    console.log(line);
  }
}

export function registerVersionCommand(program: Command): void {
  program
    .command("version")
    .description(
      "Show switchroom version, claude-code version, and running agent health summary"
    )
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        printHealthSummary(config);
      })
    );
}
