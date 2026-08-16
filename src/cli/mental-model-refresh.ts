import type { Command } from "commander";
import chalk from "chalk";

import { getConfig } from "./helpers.js";
import { isHindsightEnabled } from "../memory/hindsight.js";
import { HINDSIGHT_DEFAULT_MCP_URL } from "../setup/hindsight.js";
import {
  collectRefreshBanks,
  DEFAULT_STALE_DAYS,
  runMentalModelRefresh,
} from "../memory/mental-model-refresh.js";
import {
  CRON_LOG_PATH,
  CRON_PATH,
  CRON_SCHEDULE,
  ensureLogFile,
  installCron,
  installLogrotate,
} from "../memory/mm-refresh-cron.js";

/**
 * `switchroom mental-model-refresh` — the model-free stale-model refresh sweep
 * (memory-redesign RFC P10).
 *
 * Mental models are hindsight's only synthesis layer and nothing refreshes them
 * unattended (phase-2 J5: six models 41 days old, zero refreshes). This verb
 * lists every bank's models, selects the ones past a staleness interval, and
 * refreshes each via the engine's `refresh_mental_model` MCP tool. Zero model
 * tokens: no `claude`, no session wake — the same host-cron shape as
 * `switchroom hindsight-watch`.
 *
 * WHY a host CLI verb on a host cron, not a switchroom.yaml `schedule:` entry:
 * the scheduler's only non-model `kind` is `action`, whose engine is
 * egress-only (telegram/webhook) and cannot POST to the local hindsight
 * `/mcp/`; a `prompt` entry could, but only by waking a model to do
 * deterministic work. So the mechanism lives in `/etc/cron.d`, the fleet's
 * model-free-cron home. See `src/memory/mm-refresh-cron.ts`.
 *
 * Exit codes (cron-meaningful):
 *   0 — swept. Some individual refreshes may have failed (logged per model);
 *       transient per-model failures do not fail the tick.
 *   1 — could NOT complete: memory backend disabled, or EVERY bank failed
 *       inspection (engine unreachable). Loud by design.
 */
export function registerMentalModelRefreshCommand(program: Command): void {
  program
    .command("mental-model-refresh")
    .description(
      "Model-free refresh of stale mental models: list each bank's models, " +
        "select those past the staleness interval, refresh via the hindsight MCP tool.",
    )
    .option(
      "--install-cron",
      `arm the sweep: write ${CRON_PATH} (${CRON_SCHEDULE}, flock-guarded) and exit`,
      false,
    )
    .option("--cron-user <user>", "unix user the cron sweep runs as (default: current user)")
    .option(
      "--stale-days <n>",
      `refresh models whose last refresh is older than N days (default: ${DEFAULT_STALE_DAYS})`,
      String(DEFAULT_STALE_DAYS),
    )
    .option("--bank <id>", "restrict the sweep to a single bank (default: every fleet bank)")
    .option("--mcp-url <url>", "hindsight MCP endpoint (default: config or built-in)")
    .option("--dry-run", "select and print stale models but issue no refreshes", false)
    .option("--json", "emit machine-readable JSON", false)
    .action(async (opts) => {
      if (opts.installCron) {
        process.exitCode = runInstallCron(opts.cronUser);
        return;
      }

      const staleDays = Number(opts.staleDays);
      if (!Number.isFinite(staleDays) || staleDays < 0) {
        process.stderr.write(chalk.red(`mental-model-refresh: --stale-days must be a non-negative number (got ${opts.staleDays})\n`));
        process.exitCode = 1;
        return;
      }

      const config = getConfig(program);
      if (!isHindsightEnabled(config)) {
        process.stderr.write(
          chalk.red("mental-model-refresh: hindsight memory backend is not enabled — nothing to refresh.\n"),
        );
        process.exitCode = 1;
        return;
      }

      const mcpUrl: string =
        opts.mcpUrl ??
        (config.memory?.config?.url as string | undefined) ??
        HINDSIGHT_DEFAULT_MCP_URL;

      const bankIds = opts.bank ? [String(opts.bank)] : collectRefreshBanks(config);
      if (bankIds.length === 0) {
        process.stderr.write(chalk.yellow("mental-model-refresh: no banks to sweep.\n"));
        // Not a failure: a config with memory on but zero banks is a no-op, not
        // an incident.
        process.exitCode = 0;
        return;
      }

      const log = opts.json
        ? undefined
        : (m: string): void => {
            process.stderr.write(`${m}\n`);
          };
      const result = await runMentalModelRefresh({
        mcpUrl,
        bankIds,
        staleDays,
        dryRun: Boolean(opts.dryRun),
        log,
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify({ staleDays, dryRun: Boolean(opts.dryRun), ...result }, null, 2) + "\n");
      } else {
        const verb = opts.dryRun ? "would refresh" : "refreshed";
        process.stdout.write(
          `\n${chalk.bold(`${verb} ${result.totalRefreshed} model(s)`)}` +
            (result.totalFailed > 0 ? chalk.yellow(` — ${result.totalFailed} refresh failure(s)`) : "") +
            ` across ${result.banks.length} bank(s).\n`,
        );
        if (result.couldNotComplete) {
          process.stdout.write(chalk.red("  every bank failed inspection — hindsight unreachable?\n"));
        }
      }

      // Exit 1 ONLY when the sweep could not do its job at all (every bank
      // failed inspection). Individual refresh failures are reported but do not
      // fail the tick — they are transient and must not make a healthy cron
      // look perpetually broken (see FleetRefreshResult.couldNotComplete).
      process.exitCode = result.couldNotComplete ? 1 : 0;
    });
}

/**
 * `--install-cron`: arm the sweep. Same refusals as
 * `src/cli/hindsight-watch.ts` {@link runInstallCron} — a `root` cron user and
 * a non-absolute binary path each install a fragment that silently never works,
 * so both are hard errors, not warnings.
 */
function runInstallCron(cronUser?: string): number {
  const user = cronUser ?? process.env.SUDO_USER ?? process.env.USER ?? process.env.LOGNAME;
  if (!user || user === "root") {
    process.stderr.write(
      chalk.red("mental-model-refresh: refusing to install a cron for `root`.\n") +
        "  The config the sweep reads lives under the OPERATOR's ~/.switchroom, " +
        "so a root tick would read the wrong config.\n" +
        "  Re-run with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  const binary = process.env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
  if (!binary.startsWith("/")) {
    process.stderr.write(
      chalk.red(`mental-model-refresh: SWITCHROOM_BINARY must be an absolute path (got ${binary})\n`),
    );
    return 1;
  }

  let res: ReturnType<typeof installCron>;
  try {
    res = installCron({ user, binary });
  } catch (e) {
    process.stderr.write(
      chalk.red(`mental-model-refresh: could not write ${CRON_PATH}: ${(e as Error).message}\n`) +
        "  This path needs root; re-run under sudo with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  // Provision the log file the cron redirects into, owned by the cron user
  // (#3991 fix, applied here for the same reason). FATAL on failure: an armed
  // cron that cannot write its log dies at the redirection every tick.
  let logStatus: string;
  try {
    const logRes = ensureLogFile({ user });
    logStatus =
      logRes.status === "created"
        ? `created ${logRes.path} (owned by ${user})`
        : `${logRes.path} already present`;
  } catch (e) {
    process.stderr.write(
      chalk.red(`mental-model-refresh: could not provision the log file: ${(e as Error).message}\n`) +
        `  The cron redirects into ${CRON_LOG_PATH} and would die at the redirection every tick.\n` +
        "  This path needs root; re-run under sudo with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  // Bound the log with a logrotate drop-in (#3992). Best-effort: a missing
  // config only means unbounded growth, not a broken tick.
  let rotateStatus: string;
  try {
    const rotateRes = installLogrotate({ user });
    rotateStatus =
      rotateRes.status === "installed"
        ? `installed ${rotateRes.path}`
        : `${rotateRes.path} already up to date`;
  } catch (e) {
    rotateStatus = chalk.yellow(`logrotate drop-in NOT written (${(e as Error).message}) — log growth is unbounded`);
  }

  const verb = res.status === "installed" ? "installed" : "already up to date";
  process.stdout.write(
    `${chalk.green("✓")} mental-model-refresh cron ${verb} at ${res.path} ` +
      `(${CRON_SCHEDULE}, as ${user})\n` +
      `  log: ${logStatus}\n` +
      `  logrotate: ${rotateStatus}\n` +
      `  Verify with: switchroom mental-model-refresh --dry-run\n`,
  );
  return 0;
}
