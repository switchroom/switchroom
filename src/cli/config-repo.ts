/**
 * `switchroom config-repo` — change control for the operator's private
 * `~/.switchroom-config` git repo.
 *
 * Slice 1 ships the `sync` subcommand: a native, flock-guarded, secret-scanned
 * port of the hand-written `sync.sh`, with the personal-skills force-add (GAP
 * A) and the `require_private` push gate. See `src/config-repo/sync.ts` for the
 * full rationale.
 *
 * Exit codes:
 *   0  — synced cleanly (committed or already up to date; pushed if enabled).
 *  10  — synced, but a WARN fired: a secret was withheld, a symlink escaped,
 *        or the push was skipped/failed. The commit still landed locally.
 *   1  — could not complete (not a git repo, live config missing, lock
 *        contention, git commit failure).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";

import { loadConfig, resolvePath } from "../config/loader.js";
import {
  defaultSyncDeps,
  runConfigRepoSyncLocked,
  type ConfigRepoSyncOptions,
} from "../config-repo/sync.js";
import {
  CRON_LOG_PATH,
  CRON_PATH,
  DEFAULT_INTERVAL_MINUTES,
  DAILY_CRON_SCHEDULE,
  ensureLogFile,
  installCron,
  installLogrotate,
  uninstallCron,
  uninstallLogrotate,
  type IncludeVaultBackup,
} from "../config-repo/install-cron.js";
import { VaultBusyError } from "../vault/flock.js";

function switchroomHome(): string {
  return process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir();
}

interface SyncOptions {
  message?: string;
  push: boolean;
  path?: string;
  remote?: string;
  requirePrivate?: boolean;
}

/**
 * Resolve the effective sync options from CLI flags, then `config_repo:`, then
 * built-in defaults — so the verb works with an empty/absent config block.
 */
function resolveSyncOptions(configPath: string | undefined, opts: SyncOptions): ConfigRepoSyncOptions {
  let cfg: { path?: string; push?: boolean; remote?: string; require_private?: boolean } = {};
  try {
    const loaded = loadConfig(configPath);
    if (loaded.config_repo) cfg = loaded.config_repo;
  } catch {
    /* tolerate missing/malformed config — defaults below still work */
  }

  const home = switchroomHome();
  const repoPath = opts.path
    ? resolvePath(opts.path)
    : cfg.path
      ? resolvePath(cfg.path)
      : join(home, ".switchroom-config");

  const livePath = process.env.SWITCHROOM_CONFIG ?? join(home, ".switchroom", "switchroom.yaml");
  const agentsDir =
    process.env.SWITCHROOM_AGENTS_DIR ?? join(home, ".switchroom", "agents");

  // --no-push (commander sets push:false) always wins; otherwise config, else true.
  const push = opts.push === false ? false : (cfg.push ?? true);
  const remote = opts.remote ?? cfg.remote ?? "origin";
  const requirePrivate = opts.requirePrivate ?? cfg.require_private ?? true;

  return {
    repoPath,
    livePath,
    agentsDir,
    push,
    remote,
    requirePrivate,
    message: opts.message,
  };
}

export function registerConfigRepoCommand(program: Command): void {
  const configRepo = program
    .command("config-repo")
    .description(
      "Change control for the operator's private ~/.switchroom-config git repo " +
        "(backup + audit trail of live host config, agent workspace state, and " +
        "mirrored personal skills).",
    );

  configRepo
    .command("sync")
    .description(
      "Copy live host config + owned agent workspace state + mirrored personal " +
        "skills into the config repo, secret-scan, commit, and (unless " +
        "--no-push) push — refusing to push a non-private remote.",
    )
    .option("-m, --message <msg>", "commit message override")
    .option("--no-push", "commit locally only; do not push")
    .option("--path <path>", "config repo path (default: config_repo.path or ~/.switchroom-config)")
    .option("--remote <name>", "git remote to push to (default: config_repo.remote or origin)")
    .option(
      "--no-require-private",
      "skip the private-remote push gate (DANGEROUS — allows push to a public remote)",
    )
    .action(async (opts: SyncOptions) => {
      const parentOpts = program.opts();
      const resolved = resolveSyncOptions(parentOpts.config, opts);
      const log = (m: string): void => {
        process.stderr.write(`${m}\n`);
      };

      let result;
      try {
        result = runConfigRepoSyncLocked(resolved, defaultSyncDeps(resolved.repoPath, log));
      } catch (e) {
        if (e instanceof VaultBusyError) {
          process.stderr.write(
            chalk.yellow(
              `config-repo sync: another sync holds the lock — ${e.message}\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        process.stderr.write(chalk.red(`config-repo sync: ${(e as Error).message}\n`));
        process.exitCode = 1;
        return;
      }

      // Summary.
      if (result.committed) {
        process.stdout.write(
          `${chalk.green("✓")} committed ${result.commitSha ?? ""}`.trim() + "\n",
        );
      } else {
        process.stdout.write(`${chalk.gray("•")} nothing to commit\n`);
      }
      if (resolved.push) {
        if (result.pushed) {
          process.stdout.write(`${chalk.green("✓")} pushed to ${resolved.remote}\n`);
        } else {
          process.stdout.write(
            `${chalk.yellow("⚠")} not pushed: ${result.pushSkippedReason ?? "unknown"}\n`,
          );
        }
      }
      for (const f of result.secretFindings) {
        process.stdout.write(
          `${chalk.red("⚠")} secret withheld from ${f.file} (${f.pattern})\n`,
        );
      }
      for (const s of result.skippedSymlinks) {
        process.stdout.write(`${chalk.yellow("⚠")} skipped ${s.file}: ${s.reason}\n`);
      }

      process.exitCode = result.exitCode;
    });

  configRepo
    .command("install-cron")
    .description(
      "Arm the scheduled auto-backup: write /etc/cron.d/switchroom-config-sync " +
        "(30-min `config-repo sync` tick + a daily `vault backup && sync` leg), " +
        "provision its log, and install a logrotate drop-in. Gated on " +
        "config_repo.enabled; refuses to run as root.",
    )
    .option("--cron-user <user>", "unix user the cron tick runs as (default: current user)")
    .action((opts: { cronUser?: string }) => {
      const parentOpts = program.opts();
      process.exitCode = runInstallCron(parentOpts.config, opts.cronUser);
    });

  configRepo
    .command("uninstall-cron")
    .description(
      "Disarm the scheduled auto-backup: remove /etc/cron.d/switchroom-config-sync " +
        "and its logrotate drop-in (the sync verb still works on demand). Idempotent.",
    )
    .action(() => {
      process.exitCode = runUninstallCron();
    });
}

/**
 * `install-cron`: arm the config-repo auto-backup schedule.
 *
 * Gated and refuse-guarded like `hindsight-watch --install-cron`, because the
 * two ways a guess installs a cron that never does its job are the same here:
 *
 *  - **running as root with no `--cron-user`.** The push rides the OPERATOR's
 *    `gh` credential helper; a root tick has no such auth and would fail every
 *    push forever. Hard error, not a warning.
 *  - **an unresolvable binary path.** A relative/dev-mode argv in a cron line
 *    fails every tick with a message only visible in syslog.
 *
 * Additionally gated on `config_repo.enabled`: arming a schedule for a feature
 * the operator has not turned on would start pushing workspace/memory state to
 * the remote without an explicit opt-in.
 */
function runInstallCron(configPath: string | undefined, cronUser?: string): number {
  // Config gate: refuse to arm unless the feature is enabled.
  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  let includeVaultBackup: IncludeVaultBackup = "daily";
  let enabled = false;
  try {
    const loaded = loadConfig(configPath);
    if (loaded.config_repo) {
      enabled = loaded.config_repo.enabled;
      intervalMinutes = loaded.config_repo.interval_minutes ?? DEFAULT_INTERVAL_MINUTES;
      includeVaultBackup = loaded.config_repo.include_vault_backup ?? "daily";
    }
  } catch {
    /* fall through — enabled stays false, gate fires below */
  }
  if (!enabled) {
    process.stderr.write(
      chalk.red("config-repo: refusing to arm the auto-backup cron.\n") +
        "  config_repo.enabled is not true. Set `config_repo.enabled: true` in " +
        "switchroom.yaml (and confirm the repo is present + private with " +
        "`switchroom doctor`) before arming the schedule.\n",
    );
    return 1;
  }

  const user = cronUser ?? process.env.SUDO_USER ?? process.env.USER ?? process.env.LOGNAME;
  if (!user || user === "root") {
    process.stderr.write(
      chalk.red("config-repo: refusing to install a cron for `root`.\n") +
        "  The push rides the OPERATOR's `gh` credential helper, so the tick " +
        "must run as the operator — a root tick has no push auth and every " +
        "push would fail forever.\n" +
        "  Re-run with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  const binary = process.env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
  if (!binary.startsWith("/")) {
    process.stderr.write(
      chalk.red(`config-repo: SWITCHROOM_BINARY must be an absolute path (got ${binary})\n`),
    );
    return 1;
  }

  let res: ReturnType<typeof installCron>;
  try {
    res = installCron({ user, binary, intervalMinutes, includeVaultBackup });
  } catch (e) {
    process.stderr.write(
      chalk.red(`config-repo: could not write ${CRON_PATH}: ${(e as Error).message}\n`) +
        "  This path needs root; re-run under sudo with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  // Provision the log file the cron redirects into, owned by the cron user
  // (#3991 class): without it the `>>` redirection dies "Permission denied"
  // before switchroom is exec'd and every tick fails silently. FATAL here — an
  // armed cron that cannot write its log is the exact silent-failure this verb
  // exists to close.
  let logStatus: string;
  try {
    const logRes = ensureLogFile({ user });
    logStatus =
      logRes.status === "created"
        ? `created ${logRes.path} (owned by ${user})`
        : `${logRes.path} already present`;
  } catch (e) {
    process.stderr.write(
      chalk.red(`config-repo: could not provision the log file: ${(e as Error).message}\n`) +
        `  The cron redirects into ${CRON_LOG_PATH} and would die at the ` +
        "redirection every tick.\n  This path needs root; re-run under sudo with " +
        "`--cron-user <operator>`.\n",
    );
    return 1;
  }

  // Bound the log with a logrotate drop-in. Best-effort: a missing config only
  // means unbounded growth, not a broken tick, so a failure here WARNs.
  let rotateStatus: string;
  try {
    const rotateRes = installLogrotate({ user });
    rotateStatus =
      rotateRes.status === "installed"
        ? `installed ${rotateRes.path}`
        : `${rotateRes.path} already up to date`;
  } catch (e) {
    rotateStatus = chalk.yellow(
      `logrotate drop-in NOT written (${(e as Error).message}) — log growth is unbounded`,
    );
  }

  const verb = res.status === "installed" ? "installed" : "already up to date";
  const backupNote =
    includeVaultBackup === "off"
      ? "no vault backup"
      : includeVaultBackup === "every_tick"
        ? "vault backup every tick"
        : `daily vault backup at ${DAILY_CRON_SCHEDULE}`;
  process.stdout.write(
    `${chalk.green("✓")} config-repo auto-backup cron ${verb} at ${res.path} ` +
      `(*/${intervalMinutes} * * * *, ${backupNote}, as ${user})\n` +
      `  log: ${logStatus}\n` +
      `  logrotate: ${rotateStatus}\n` +
      `  Verify with: switchroom doctor\n`,
  );
  return 0;
}

/** `uninstall-cron`: remove the schedule + logrotate drop-in (idempotent). */
function runUninstallCron(): number {
  let cronRes: ReturnType<typeof uninstallCron>;
  try {
    cronRes = uninstallCron();
  } catch (e) {
    process.stderr.write(
      chalk.red(`config-repo: could not remove ${CRON_PATH}: ${(e as Error).message}\n`) +
        "  This path needs root; re-run under sudo.\n",
    );
    return 1;
  }
  // Logrotate removal is best-effort — a stranded drop-in for a missing log is
  // harmless (`missingok`).
  let rotateNote = "";
  try {
    const r = uninstallLogrotate();
    rotateNote = r.status === "removed" ? ` and its logrotate drop-in (${r.path})` : "";
  } catch {
    /* leave it — harmless */
  }

  if (cronRes.status === "removed") {
    process.stdout.write(
      `${chalk.green("✓")} config-repo auto-backup cron removed (${cronRes.path})${rotateNote}\n` +
        "  The `config-repo sync` verb still works on demand.\n",
    );
  } else {
    process.stdout.write(
      `${chalk.gray("•")} config-repo auto-backup cron was not installed (${cronRes.path})\n`,
    );
  }
  return 0;
}
