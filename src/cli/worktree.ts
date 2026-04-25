/**
 * CLI surface for the worktree subsystem.
 *
 * Commands:
 *   switchroom worktree claim <repo> [--task <name>] [--agent <name>]
 *   switchroom worktree release <id>
 *   switchroom worktree list [--json]
 *   switchroom worktree reap [--dry-run]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { claimWorktree } from "../worktree/claim.js";
import { releaseWorktree } from "../worktree/release.js";
import { listWorktrees } from "../worktree/list.js";
import { runReaper } from "../worktree/reaper.js";

export function registerWorktreeCommand(program: Command): void {
  const worktree = program
    .command("worktree")
    .description("Manage git worktrees for parallel sub-agent isolation");

  // ─── claim ────────────────────────────────────────────────────────────────

  worktree
    .command("claim <repo>")
    .description(
      "Claim a worktree for the given repo alias or absolute path.\n" +
      "Outputs the worktree id, path, and branch.",
    )
    .option("-t, --task <name>", "Human-readable task name (used as branch suffix)")
    .option("-a, --agent <name>", "Agent name to associate with this claim")
    .option("--json", "Output raw JSON")
    .action(async (repo: string, opts: { task?: string; agent?: string; json?: boolean }) => {
      try {
        const result = await claimWorktree({
          repo,
          taskName: opts.task,
          ownerAgent: opts.agent,
        });
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(chalk.green("Worktree claimed"));
          console.log(`  id:     ${chalk.bold(result.id)}`);
          console.log(`  branch: ${chalk.bold(result.branch)}`);
          console.log(`  path:   ${chalk.bold(result.path)}`);
        }
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    });

  // ─── release ──────────────────────────────────────────────────────────────

  worktree
    .command("release <id>")
    .description("Release a claimed worktree by ID")
    .option("--json", "Output raw JSON")
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const result = releaseWorktree({ id });
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          if (result.released) {
            console.log(chalk.green(`Worktree ${id} released.`));
          } else {
            console.log(
              chalk.yellow(
                `Worktree ${id} release was partial (git remove failed, registry cleaned up).`,
              ),
            );
          }
        }
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    });

  // ─── list ─────────────────────────────────────────────────────────────────

  worktree
    .command("list")
    .description("List all active worktree claims")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const { worktrees } = listWorktrees();
      if (opts.json) {
        console.log(JSON.stringify({ worktrees }));
        return;
      }
      if (worktrees.length === 0) {
        console.log("No active worktrees.");
        return;
      }
      console.log(chalk.bold(`${worktrees.length} active worktree(s):\n`));
      for (const wt of worktrees) {
        const hbAge = Math.round(wt.heartbeatAgeSeconds / 60);
        const fresh = wt.heartbeatAgeSeconds < 120
          ? chalk.green("fresh")
          : chalk.yellow(`${hbAge}m ago`);
        console.log(`  ${chalk.bold(wt.id)}`);
        console.log(`    repo:    ${wt.repoName} (${wt.repo})`);
        console.log(`    branch:  ${wt.branch}`);
        console.log(`    path:    ${wt.path}`);
        console.log(`    agent:   ${wt.ownerAgent ?? "(none)"}`);
        console.log(`    heartbeat: ${fresh}`);
        console.log();
      }
    });

  // ─── reap ─────────────────────────────────────────────────────────────────

  worktree
    .command("reap")
    .description("Run the reaper — remove stale/orphaned worktrees")
    .option("--dry-run", "Show what would be reaped without acting")
    .option("--json", "Output raw JSON")
    .action((opts: { dryRun?: boolean; json?: boolean }) => {
      if (opts.dryRun) {
        // Show stale records without acting
        const { worktrees } = listWorktrees();
        const STALE_MS = 10 * 60 * 1000;
        const stale = worktrees.filter(
          w => w.heartbeatAgeSeconds * 1000 > STALE_MS,
        );
        if (opts.json) {
          console.log(JSON.stringify({ would_reap: stale.map(w => w.id) }));
        } else {
          if (stale.length === 0) {
            console.log("No stale worktrees found.");
          } else {
            console.log(chalk.yellow(`Would reap ${stale.length} worktree(s):`));
            for (const w of stale) {
              console.log(`  ${w.id} — ${w.branch}`);
            }
          }
        }
        return;
      }

      const result = runReaper();
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        if (result.reaped.length === 0) {
          console.log("No worktrees reaped.");
        } else {
          console.log(chalk.green(`Reaped ${result.reaped.length} worktree(s): ${result.reaped.join(", ")}`));
        }
        for (const w of result.warnings) {
          console.warn(chalk.yellow(w));
        }
      }
    });
}
