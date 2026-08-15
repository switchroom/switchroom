/**
 * CLI surface for the worktree subsystem.
 *
 * Commands:
 *   switchroom worktree claim <repo> [--task <name>] [--agent <name>]
 *   switchroom worktree release <id>
 *   switchroom worktree list [--json]
 *   switchroom worktree reap [--dry-run]
 *   switchroom worktree reap-report [--json] [--append <file>] [--budget-gb <n>]
 *   switchroom worktree gc [--root <dir>...] [--yes] [--json]
 *   switchroom worktree gc --purge-trash [--older-than <days>] [--yes]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { appendFileSync } from "node:fs";
import { claimWorktree } from "../worktree/claim.js";
import { releaseWorktree } from "../worktree/release.js";
import { listWorktrees } from "../worktree/list.js";
import { runReaper, planReaper, reapSkipReasonText } from "../worktree/reaper.js";
import {
  planGc,
  applyGc,
  defaultRoots,
  defaultTaskTreeRoots,
  trashRoot,
  listTrashEntries,
  selectPurgeTargets,
  purgeTrash,
} from "../worktree/gc.js";
import {
  agentTreeBudgetBytes,
  buildReapReport,
  formatReapReport,
} from "../worktree/reap-report.js";

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
      // Stale = heartbeat older than the reaper's threshold (a live claim
      // refreshes its heartbeat from the gateway watch loop, so a stale one is
      // reap-eligible — subject to the reaper's dirty/in-use fail-safes).
      const STALE_MS = 10 * 60 * 1000;
      for (const wt of worktrees) {
        const hbAge = Math.round(wt.heartbeatAgeSeconds / 60);
        const isStale = wt.heartbeatAgeSeconds * 1000 > STALE_MS;
        const fresh = wt.heartbeatAgeSeconds < 120
          ? chalk.green("fresh")
          : isStale
            ? chalk.red(`${hbAge}m ago — STALE (reap-eligible; kept if dirty/in-use)`)
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
    .description(
      "Run the reaper — remove stale/orphaned worktrees.\n" +
        "A stale worktree with UNCOMMITTED changes is NEVER auto-deleted; it is\n" +
        "reported as skipped. Clear it manually: inspect, commit/salvage, then\n" +
        "`switchroom worktree release <id>` (or `git worktree remove <path>`).",
    )
    .option("--dry-run", "Show what would be reaped without acting")
    .option("--json", "Output raw JSON")
    .action((opts: { dryRun?: boolean; json?: boolean }) => {
      if (opts.dryRun) {
        // L1 fix: route the dry-run through the SAME predicate as the real
        // reaper (planReaper) so its output matches what a real run would do —
        // the dirty + probe guards are applied here too, not just heartbeat
        // age (which used to over-report dirty/in-use worktrees as reapable).
        const plan = planReaper();
        const wouldReap = plan.filter(
          e => e.action === "reap" || e.action === "reap-orphan",
        );
        const wouldSkip = plan.filter(e => e.action.startsWith("skip-"));
        if (opts.json) {
          console.log(
            JSON.stringify({
              would_reap: wouldReap.map(e => e.record.id),
              would_skip: wouldSkip.map(e => ({
                id: e.record.id,
                reason: e.action,
              })),
            }),
          );
        } else if (wouldReap.length === 0 && wouldSkip.length === 0) {
          console.log("No stale worktrees found.");
        } else {
          if (wouldReap.length > 0) {
            console.log(chalk.yellow(`Would reap ${wouldReap.length} worktree(s):`));
            for (const e of wouldReap) {
              console.log(`  ${e.record.id} — ${e.record.branch}`);
            }
          }
          if (wouldSkip.length > 0) {
            console.log(
              chalk.yellow(
                `${wouldReap.length > 0 ? "\n" : ""}Would SKIP ${wouldSkip.length} stale worktree(s) (kept for safety):`,
              ),
            );
            for (const e of wouldSkip) {
              console.log(
                `  ${e.record.id} — ${e.record.branch} — would skip (${reapSkipReasonText(e.action)})`,
              );
            }
            if (wouldSkip.some(e => e.action === "skip-dirty")) {
              console.log(
                chalk.dim(
                  "\n  Dirty worktrees are never auto-removed. Clear one manually:\n" +
                    "  inspect, commit/salvage, then `switchroom worktree release <id>`\n" +
                    "  (or `git worktree remove <path>`).",
                ),
              );
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
        // M2: surface stale-but-kept worktrees so the never-auto-delete-dirty
        // policy doesn't let them accumulate invisibly.
        if (result.skipped.length > 0) {
          console.log(
            chalk.yellow(`\nSkipped ${result.skipped.length} stale worktree(s) (kept for safety):`),
          );
          for (const s of result.skipped) {
            console.log(
              chalk.yellow(`  ${s.record.id} — ${reapSkipReasonText(s.action)} — ${s.record.path}`),
            );
          }
          const dirty = result.skipped.filter(s => s.action === "skip-dirty");
          if (dirty.length > 0) {
            console.log(
              chalk.dim(
                `\n  ${dirty.length} worktree(s) have UNCOMMITTED changes and will NOT be\n` +
                  "  auto-removed. Inspect, commit/salvage, then\n" +
                  "  `switchroom worktree release <id>` (or `git worktree remove <path>`).",
              ),
            );
          }
        }
      }
    });

  // ─── reap-report (scheduled, report-only) ────────────────────────────────

  worktree
    .command("reap-report")
    .description(
      "REPORT ONLY: what the reaper and the task-tree sweep WOULD reclaim.\n" +
        "Deletes nothing — there is no --yes on this verb. Built to run from\n" +
        "cron so a week of evidence exists before any automatic deletion is\n" +
        "considered. Groups per agent against a size budget, oldest-first.",
    )
    .option("--json", "Output the raw report as JSON")
    .option(
      "--append <file>",
      "Append the JSON report as one line to <file> (JSONL evidence log)",
    )
    .option("--budget-gb <gb>", "Per-agent task-tree budget in GB (default 5)")
    .option("--idle-days <days>", "Idle threshold for task trees (default 14)", "14")
    .option("--no-task-roots", "Skip the per-agent task-tree sweep")
    .action(
      (opts: {
        json?: boolean;
        append?: string;
        budgetGb?: string;
        idleDays: string;
        taskRoots?: boolean;
      }) => {
        const parsedIdle = Number(opts.idleDays);
        const idleDays = Number.isFinite(parsedIdle) && parsedIdle >= 0 ? parsedIdle : 14;
        const parsedBudget = opts.budgetGb == null ? NaN : Number(opts.budgetGb);
        const budgetBytes =
          Number.isFinite(parsedBudget) && parsedBudget > 0
            ? Math.round(parsedBudget * 1024 * 1024 * 1024)
            : agentTreeBudgetBytes();

        const report = buildReapReport({
          idleDays,
          budgetBytes,
          taskTreeRoots: opts.taskRoots === false ? [] : undefined,
        });

        if (opts.append) {
          try {
            appendFileSync(opts.append, JSON.stringify(report) + "\n");
          } catch (err) {
            console.error(
              chalk.yellow(`Could not append to ${opts.append}: ${(err as Error).message}`),
            );
          }
        }

        if (opts.json) {
          console.log(JSON.stringify(report));
          return;
        }
        console.log(formatReapReport(report));
      },
    );

  // ─── gc ─────────────────────────────────────────────────────────────────

  worktree
    .command("gc")
    .description(
      "Reclaim dev worktrees that outlived their PR, and per-agent task trees.\n" +
        "Dry-run by default; pass --yes to act. Quarantines orphaned worktree\n" +
        "directories (move, not delete) and removes registered worktrees whose\n" +
        "PR is MERGED and whose tree is clean. Also sweeps per-agent home/work\n" +
        "task trees (all shapes) that are clean + pushed + idle + merged/closed;\n" +
        "dead-but-dirty/unpushed trees are surfaced and reclaimed only with\n" +
        "--reclaim-dirty (reversible quarantine).",
    )
    .option(
      "--root <dir>",
      "Dev-worktree scan root (repeatable). Default: ~/code",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option(
      "--task-root <dir>",
      "Task-tree scan root (repeatable). Default: every agent's home/work + home/workspace",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option("--no-task-roots", "Skip the per-agent task-tree sweep entirely")
    .option("--idle-days <days>", "Idle threshold for task trees (default 14)", "14")
    .option(
      "--reclaim-dirty",
      "Operator escape hatch: quarantine IDLE dirty/unpushed task trees (reversible)",
    )
    .option("--yes", "Actually act (default is dry-run)")
    .option("--json", "Output raw JSON")
    .option("--purge-trash", "Hard-delete quarantined dirs older than --older-than")
    .option("--older-than <days>", "Age threshold for --purge-trash (default 14)", "14")
    .action(
      (opts: {
        root: string[];
        taskRoot: string[];
        taskRoots?: boolean;
        idleDays: string;
        reclaimDirty?: boolean;
        yes?: boolean;
        json?: boolean;
        purgeTrash?: boolean;
        olderThan: string;
      }) => {
        if (opts.purgeTrash) {
          const parsed = Number(opts.olderThan);
          const olderThan = isNaN(parsed) ? 14 : parsed;
          const entries = listTrashEntries(Date.now());
          const targets = selectPurgeTargets(entries, olderThan);
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
        const taskTreeRoots =
          opts.taskRoots === false
            ? []
            : opts.taskRoot.length > 0
              ? opts.taskRoot
              : defaultTaskTreeRoots();
        const parsedIdle = Number(opts.idleDays);
        const idleDays = Number.isFinite(parsedIdle) && parsedIdle >= 0 ? parsedIdle : 14;
        const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const plan = planGc(
          roots,
          { dateStamp, idleDays, escapeHatch: opts.reclaimDirty },
          taskTreeRoots,
        );
        const toRemove = plan.registered.filter((r) => r.verdict === "remove");
        const taskReap = plan.taskTrees.filter((t) => t.willAct);
        // Surfaced-but-untouched: dead-but-dirty/unpushed trees the escape hatch
        // would reclaim (RFC §4). Shown so the consequence is operator-visible.
        const taskEscape = plan.taskTrees.filter(
          (t) => !t.willAct && t.idle && (t.verdict === "skip-dirty" || t.verdict === "skip-unpushed"),
        );

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
          if (taskTreeRoots.length) {
            const label = opts.reclaimDirty ? "reclaim (reap + escape-hatch)" : "reap (clean + pushed + idle + merged/closed)";
            console.log(`\nTask trees to ${label}: ${chalk.bold(taskReap.length)}`);
            for (const t of taskReap)
              console.log(`  ${t.dir}  ${chalk.dim(`[${t.branch ?? "detached"}] ${t.shape} ${t.verdict} → ${t.dest}`)}`);
            if (taskEscape.length) {
              console.log(
                chalk.yellow(
                  `\nDead-but-dirty/unpushed task trees kept (${taskEscape.length}) — reclaim with --reclaim-dirty:`,
                ),
              );
              for (const t of taskEscape)
                console.log(chalk.dim(`  ${t.verdict.replace("skip-", "")}: ${t.dir} [${t.branch ?? "detached"}] ${t.shape}`));
            }
            const taskKept = plan.taskTrees.filter(
              (t) => !t.willAct && !(t.idle && (t.verdict === "skip-dirty" || t.verdict === "skip-unpushed")) && t.verdict !== "skip-protected",
            );
            if (taskKept.length) {
              console.log(chalk.dim(`\nOther task trees kept (${taskKept.length}):`));
              for (const t of taskKept)
                console.log(chalk.dim(`  ${t.verdict.replace("skip-", "")}: ${t.dir} [${t.branch ?? "detached"}] (pr=${t.prSignal})`));
            }
          }
          // A failed git probe is NOT a negative answer — the tree is unreadable
          // and nothing about it is known. Surfaced separately and loudly, so a
          // fleet-wide probe failure can never hide inside the bland
          // "ignored non-switchroom dirs" count again.
          const probeFailed = plan.skipped.filter((s) => s.kind === "probe-failed");
          const notOurs = plan.skipped.filter((s) => s.kind !== "probe-failed");
          if (probeFailed.length) {
            console.log(
              chalk.yellow(`\nUnreadable dirs — git probe failed, kept (${probeFailed.length}):`),
            );
            for (const s of probeFailed) console.log(chalk.dim(`  ${s.dir}: ${s.reason}`));
          }
          if (notOurs.length) {
            console.log(chalk.dim(`\nIgnored non-switchroom dirs: ${notOurs.length}`));
          }
          console.log(chalk.dim("\nRe-run with --yes to act. Reclaimed trees are MOVED to the trash dir, not deleted."));
          return;
        }

        const result = applyGc(plan);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(chalk.green(`Quarantined ${result.quarantined.length} dir(s) → ${plan.trashDir}`));
          console.log(chalk.green(`Removed ${result.removed.length} merged worktree(s); deleted ${result.branchesDeleted.length} branch(es).`));
          console.log(chalk.dim(`Pruned metadata in ${result.pruned.length} repo(s).`));
          if (taskEscape.length && !opts.reclaimDirty) {
            console.log(
              chalk.yellow(
                `\n${taskEscape.length} dead-but-dirty/unpushed task tree(s) were kept. Reclaim reversibly with --reclaim-dirty.`,
              ),
            );
          }
          for (const e of result.errors) console.warn(chalk.yellow(e));
          console.log(chalk.dim(`\nQuarantined dirs are recoverable until \`switchroom worktree gc --purge-trash --yes\`.`));
        }
      },
    );
}
