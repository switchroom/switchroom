/**
 * CLI surface for the worktree subsystem.
 *
 * Commands:
 *   switchroom worktree claim <repo> [--task <name>] [--agent <name>]
 *   switchroom worktree release <id>
 *   switchroom worktree list [--json]
 *   switchroom worktree reap [--dry-run]
 *   switchroom worktree gc [--root <dir>...] [--yes] [--json]
 *   switchroom worktree gc --purge-trash [--older-than <days>] [--yes]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { claimWorktree } from "../worktree/claim.js";
import { releaseWorktree } from "../worktree/release.js";
import { listWorktrees } from "../worktree/list.js";
import { runReaper } from "../worktree/reaper.js";
import {
  planGc,
  applyGc,
  defaultRoots,
  trashRoot,
  listTrashEntries,
  selectPurgeTargets,
  purgeTrash,
} from "../worktree/gc.js";

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

  // ─── gc ─────────────────────────────────────────────────────────────────

  worktree
    .command("gc")
    .description(
      "Reclaim dev worktrees that outlived their PR.\n" +
        "Dry-run by default; pass --yes to act. Quarantines orphaned worktree\n" +
        "directories (move, not delete) and removes registered worktrees whose\n" +
        "PR is MERGED and whose tree is clean.",
    )
    .option(
      "--root <dir>",
      "Scan root (repeatable). Default: ~/code",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option("--yes", "Actually act (default is dry-run)")
    .option("--json", "Output raw JSON")
    .option("--purge-trash", "Hard-delete quarantined dirs older than --older-than")
    .option("--older-than <days>", "Age threshold for --purge-trash (default 14)", "14")
    .action(
      (opts: {
        root: string[];
        yes?: boolean;
        json?: boolean;
        purgeTrash?: boolean;
        olderThan: string;
      }) => {
        if (opts.purgeTrash) {
          const olderThan = Number(opts.olderThan);
          const entries = listTrashEntries(Date.now());
          const targets = selectPurgeTargets(entries, isNaN(olderThan) ? 14 : olderThan);
          if (!opts.yes) {
            if (opts.json) {
              console.log(JSON.stringify({ would_purge: targets, trashRoot: trashRoot() }));
            } else if (targets.length === 0) {
              console.log(`No quarantined worktrees older than ${olderThan}d in ${trashRoot()}.`);
            } else {
              console.log(chalk.yellow(`Would purge ${targets.length} quarantined dir(s) (≥${olderThan}d):`));
              for (const t of targets) console.log(`  ${t}`);
              console.log(chalk.dim("\nRe-run with --yes to delete."));
            }
            return;
          }
          const r = purgeTrash(targets);
          if (opts.json) {
            console.log(JSON.stringify(r));
          } else {
            console.log(chalk.green(`Purged ${r.deleted.length} dir(s).`));
            for (const e of r.errors) console.warn(chalk.yellow(e));
          }
          return;
        }

        const roots = opts.root.length > 0 ? opts.root : defaultRoots();
        const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const plan = planGc(roots, { dateStamp });
        const toRemove = plan.registered.filter((r) => r.verdict === "remove");

        if (!opts.yes) {
          if (opts.json) {
            console.log(JSON.stringify({ dryRun: true, plan }));
            return;
          }
          console.log(chalk.bold(`worktree gc — dry-run (roots: ${roots.join(", ")})\n`));
          console.log(`Orphaned dirs to quarantine: ${chalk.bold(plan.orphans.length)}`);
          for (const o of plan.orphans) console.log(`  ${o.dir}  ${chalk.dim("→ " + o.dest)}`);
          console.log(`\nRegistered worktrees to remove (PR merged + clean): ${chalk.bold(toRemove.length)}`);
          for (const r of toRemove) console.log(`  ${r.path}  ${chalk.dim("[" + r.branch + "]")}`);
          const skips = plan.registered.filter((r) => r.verdict.startsWith("skip-") && r.verdict !== "skip-protected");
          if (skips.length) {
            console.log(chalk.dim(`\nKept (${skips.length}):`));
            for (const r of skips) console.log(chalk.dim(`  ${r.verdict.replace("skip-", "")}: ${r.path} [${r.branch}] (pr=${r.prSignal})`));
          }
          if (plan.skipped.length) {
            console.log(chalk.dim(`\nIgnored non-switchroom dirs: ${plan.skipped.length}`));
          }
          console.log(chalk.dim("\nRe-run with --yes to act. Orphans are MOVED to the trash dir, not deleted."));
          return;
        }

        const result = applyGc(plan);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(chalk.green(`Quarantined ${result.quarantined.length} orphan(s) → ${plan.trashDir}`));
          console.log(chalk.green(`Removed ${result.removed.length} merged worktree(s); deleted ${result.branchesDeleted.length} branch(es).`));
          console.log(chalk.dim(`Pruned metadata in ${result.pruned.length} repo(s).`));
          for (const e of result.errors) console.warn(chalk.yellow(e));
          console.log(chalk.dim(`\nQuarantined dirs are recoverable until \`switchroom worktree gc --purge-trash --yes\`.`));
        }
      },
    );
}
