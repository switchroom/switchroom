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
}
