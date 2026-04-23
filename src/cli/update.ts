import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { reconcileAgent } from "../agents/scaffold.js";
import { restartAgent } from "../agents/lifecycle.js";
import { installAllUnits } from "../agents/systemd.js";
import { resolveAgentsDir } from "../config/loader.js";
import { getConfigPath } from "./helpers.js";

/**
 * Locate the directory where switchroom is installed (the git checkout root).
 *
 * Strategy:
 *   1. Walk up from this source file looking for a package.json with
 *      `"name": "switchroom-ai"` and a `.git` sibling. This handles both `bun
 *      link`-installed and direct-checkout invocations.
 *   2. Fall back to `realpath $(command -v switchroom)` and walk up from there.
 *
 * Returns null if no install dir can be located.
 */
function locateSwitchroomInstallDir(): string | null {
  // Strategy 1: walk up from import.meta.dirname
  let dir = import.meta.dirname;
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

  // Strategy 2: realpath of the switchroom binary
  try {
    const which = execSync("command -v switchroom", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (which) {
      const real = realpathSync(which);
      let d = dirname(real);
      for (let i = 0; i < 10 && d && d !== "/"; i++) {
        if (existsSync(join(d, "package.json")) && existsSync(join(d, ".git"))) {
          return d;
        }
        d = dirname(d);
      }
    }
  } catch { /* switchroom not on PATH */ }

  return null;
}

/**
 * Run a shell command, streaming output. Returns true on success.
 */
function runStreamed(cmd: string, cwd: string): boolean {
  try {
    execSync(cmd, { cwd, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a shell command and capture stdout. Returns the output or null on error.
 */
function runCaptured(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).toString();
  } catch {
    return null;
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Pull the latest Switchroom source, reinstall deps, reconcile agents to switchroom.yaml, and restart them"
    )
    .option("--check", "Show pending changes without applying them")
    .option(
      "--no-restart",
      "Update sources and reconcile config but skip restarting agents"
    )
    .action(
      withConfigError(async (opts: { check?: boolean; restart?: boolean }) => {
        const installDir = locateSwitchroomInstallDir();
        if (!installDir) {
          console.error(
            chalk.red(
              "Could not locate Switchroom's install directory. " +
                "Run `switchroom update` from a switchroom checkout, or reinstall Switchroom."
            )
          );
          process.exit(1);
        }

        console.log(chalk.bold(`\nUpdating Switchroom at ${installDir}\n`));

        // 1. Capture current commit
        const before = runCaptured("git rev-parse --short HEAD", installDir)?.trim() ?? "unknown";
        console.log(chalk.gray(`  Current commit: ${before}`));

        // 2. Fetch from origin
        console.log(chalk.gray("\n  Fetching from origin..."));
        if (!runStreamed("git fetch --quiet origin", installDir)) {
          console.error(chalk.red("  git fetch failed"));
          process.exit(1);
        }

        // 3. Check what's pending
        const branch = runCaptured("git rev-parse --abbrev-ref HEAD", installDir)?.trim() ?? "main";
        const log = runCaptured(
          `git log --oneline HEAD..origin/${branch}`,
          installDir,
        )?.trim() ?? "";

        if (!log) {
          console.log(chalk.green("\n  Already up to date.\n"));
          if (opts.check) return;
          // Still reconcile in case switchroom.yaml changed locally without an update
        } else {
          const lines = log.split("\n");
          console.log(chalk.bold(`\n  ${lines.length} new commit(s) on origin/${branch}:`));
          for (const line of lines) {
            console.log(chalk.gray(`    ${line}`));
          }
        }

        if (opts.check) {
          console.log(chalk.gray("\n  --check mode: not applying changes.\n"));
          return;
        }

        // 4. Pull
        if (log) {
          console.log(chalk.gray("\n  Pulling..."));
          if (!runStreamed(`git pull --ff-only --quiet origin ${branch}`, installDir)) {
            console.error(
              chalk.red(
                "  git pull failed (not a fast-forward?). " +
                  "Resolve manually with `cd " + installDir + " && git status`."
              )
            );
            process.exit(1);
          }

          // 5. Reinstall deps if package.json or bun.lock changed
          const changed = runCaptured(
            `git diff --name-only ${before}..HEAD`,
            installDir,
          )?.trim() ?? "";
          if (changed.includes("package.json") || changed.includes("bun.lock")) {
            console.log(chalk.gray("\n  Reinstalling dependencies (package.json changed)..."));
            if (!runStreamed("bun install --quiet", installDir)) {
              console.error(chalk.yellow("  bun install reported a non-zero exit"));
            }
          }

          // Also rebuild telegram-plugin deps if those changed
          const pluginPkg = join(installDir, "telegram-plugin", "package.json");
          if (existsSync(pluginPkg) && changed.includes("telegram-plugin/package.json")) {
            console.log(chalk.gray("  Reinstalling telegram-plugin dependencies..."));
            runStreamed("bun install --quiet", join(installDir, "telegram-plugin"));
          }
        }

        // 6. Reconcile every agent
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const configPath = getConfigPath(program);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("\n  No agents defined in switchroom.yaml — nothing to reconcile.\n"));
          return;
        }

        // 6a. Regenerate systemd units BEFORE reconcile+restart so restarted
        //     agents pick up any env-var changes (e.g. SWITCHROOM_TIMEZONE,
        //     TZ) baked into the unit file. Without this, upgraded installs
        //     keep their stale units and new env-based features silently
        //     no-op until `switchroom systemd install` is run manually.
        //
        //     installAllUnits is idempotent: it rewrites every per-agent
        //     unit + gateway unit from the current config, runs
        //     `systemctl --user daemon-reload`, and re-enables the units.
        //     Safe to call every `switchroom update`.
        console.log(chalk.bold("\n  Regenerating systemd units..."));
        try {
          installAllUnits(config);
          console.log(chalk.green(`    ${agentNames.length} unit(s) rewritten`));
        } catch (err) {
          console.error(
            chalk.red(`    Failed to regenerate units: ${(err as Error).message}`)
          );
        }

        console.log(chalk.bold(`\n  Reconciling ${agentNames.length} agent(s)...`));
        let reconciledCount = 0;
        const restartCandidates: string[] = [];

        for (const name of agentNames) {
          const agentConfig = config.agents[name];
          try {
            const result = reconcileAgent(
              name,
              agentConfig,
              agentsDir,
              config.telegram,
              config,
              configPath,
            );
            if (result.changes.length === 0) {
              console.log(chalk.gray(`    ${name}: in sync`));
            } else {
              console.log(chalk.green(`    ${name}: updated`));
              for (const f of result.changes) {
                console.log(chalk.gray(`      - ${f}`));
              }
              reconciledCount++;
              restartCandidates.push(name);
            }
          } catch (err) {
            console.error(chalk.red(`    ${name}: ${(err as Error).message}`));
          }
        }

        // 7. Restart agents (if requested) — always restart on source pull,
        //    only restart on config change otherwise.
        const sourceChanged = !!log;
        const shouldRestart = opts.restart !== false && (sourceChanged || reconciledCount > 0);
        const toRestart = sourceChanged ? agentNames : restartCandidates;

        if (shouldRestart && toRestart.length > 0) {
          console.log(chalk.bold(`\n  Restarting ${toRestart.length} agent(s)...`));
          for (const name of toRestart) {
            try {
              restartAgent(name);
              console.log(chalk.green(`    ${name}: restarted`));
            } catch (err) {
              console.error(
                chalk.red(`    ${name}: restart failed: ${(err as Error).message}`)
              );
            }
          }
        } else if (opts.restart === false) {
          console.log(
            chalk.gray(
              "\n  --no-restart given; agents NOT restarted. Run `switchroom agent restart all` to apply."
            )
          );
        }

        // 8. Summary
        const after = runCaptured("git rev-parse --short HEAD", installDir)?.trim() ?? "unknown";
        console.log(chalk.bold(`\n  Done. ${before} → ${after}\n`));
      })
    );

  void resolve; // referenced for symmetry; resolve was previously imported
}
