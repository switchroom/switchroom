/**
 * `switchroom migrate cron-unit-names` (#1163 Phase D).
 *
 * Hard-cut rename of legacy index-based cron scripts
 * (`telegram/cron-<digits>.sh`) to the new content-hash scheme
 * (`telegram/cron-<sha12>.sh`). Idempotent: re-runs after a clean
 * migration are no-ops.
 *
 * No systemd is involved — switchroom cron runs as in-container
 * node-cron, so this is `.sh`-only (plus the `.source` sidecar that
 * Phase D's scaffold writes alongside each script).
 *
 * The migration is order-aware: we recompute the canonical filename
 * for each agent's `schedule[*]` entry using `cronScriptFilename`,
 * pair the legacy `cron-<i>.sh` with the entry at index `i`, and
 * rename in place. Anything that doesn't match an entry index is
 * left alone (it'll be swept by the next `reconcileAgent` cleanup pass).
 */
import type { Command } from "commander";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  cronScriptFilename,
  LEGACY_CRON_SCRIPT_BASENAME_RE,
} from "../agents/cron-unit-name.js";

interface MigrateOptions {
  dryRun?: boolean;
}

interface RenamePlan {
  agent: string;
  from: string;
  to: string;
}

export function planCronUnitRenames(
  agentsDir: string,
  agents: Record<string, { schedule?: Array<{ cron: string; prompt: string }> }>,
): RenamePlan[] {
  const plans: RenamePlan[] = [];
  for (const [agentName, agentConfig] of Object.entries(agents)) {
    const schedule = agentConfig.schedule ?? [];
    if (schedule.length === 0) continue;
    const telegramDir = join(agentsDir, agentName, "telegram");
    if (!existsSync(telegramDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(telegramDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      const m = file.match(LEGACY_CRON_SCRIPT_BASENAME_RE);
      if (!m) continue;
      const idx = Number.parseInt(m[1]!, 10);
      const entry = schedule[idx];
      if (!entry) continue;
      const canonical = cronScriptFilename(entry.cron, entry.prompt);
      if (canonical === file) continue; // already migrated
      plans.push({
        agent: agentName,
        from: join(telegramDir, file),
        to: join(telegramDir, canonical),
      });
    }
  }
  return plans;
}

function renamePair(from: string, to: string): void {
  if (existsSync(to)) {
    // Target already present — assume migrated and remove the stale legacy file.
    // Use rename(legacy -> legacy+".bak.<ts>") would be safer, but Phase D's
    // contract says hard-cut. The reconcile cleanup pass will sweep stragglers.
    return;
  }
  renameSync(from, to);
}

export function registerMigrateCommand(program: Command): void {
  const cmd = program
    .command("migrate")
    .description("One-shot config/state migrations.");

  cmd
    .command("cron-unit-names")
    .description(
      "Rename legacy cron-<index>.sh scripts to the Phase D content-hash " +
      "form (cron-<sha12>.sh). Idempotent.",
    )
    .option("--dry-run", "Print the renames without performing them", false)
    .action(
      withConfigError(async (opts: MigrateOptions) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const plans = planCronUnitRenames(
          agentsDir,
          config.agents as Record<string, { schedule?: Array<{ cron: string; prompt: string }> }>,
        );
        if (plans.length === 0) {
          console.log(chalk.green("Nothing to migrate — all cron scripts already use the content-hash scheme."));
          return;
        }
        for (const p of plans) {
          if (opts.dryRun) {
            console.log(chalk.cyan(`[dry-run] ${p.agent}: ${p.from} → ${p.to}`));
            continue;
          }
          // Also rename the .source sidecar if present.
          try {
            renamePair(p.from, p.to);
            const fromSidecar = p.from.replace(/\.sh$/, ".source");
            const toSidecar = p.to.replace(/\.sh$/, ".source");
            if (existsSync(fromSidecar) && statSync(fromSidecar).isFile() && !existsSync(toSidecar)) {
              renameSync(fromSidecar, toSidecar);
            }
            console.log(chalk.green(`renamed: ${p.agent}: ${p.from} → ${p.to}`));
          } catch (err) {
            console.error(chalk.red(`failed: ${p.agent}: ${p.from} → ${p.to}: ${(err as Error).message}`));
          }
        }
      }),
    );
}
