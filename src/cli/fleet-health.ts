import type { Command } from "commander";
import chalk from "chalk";

import { getConfig, withConfigError } from "./helpers.js";
import {
  runScan,
  writeLedger,
  resolveSwitchroomBase,
} from "../fleet-health/scan.js";
import { syncLedgerIssues, defaultGhDeps } from "../fleet-health/gh-sync.js";
import type {
  FleetHealthLedger,
  FleetHealthRecord,
} from "../web/fleet-health-read.js";
import { SIGNAL_MAP } from "../fleet-health/mapping.js";

/**
 * `switchroom fleet-health` — the LIVE detection pipeline for the Fleet Health
 * feature. Design: `reference/rfcs/fleet-health.md`, serving the job
 * `fleet-stays-healthy` (outcome `always-available`).
 *
 * Subcommands:
 * - `scan` — the nightly model-free (zero-token) sensor. Reads every agent's
 *   `turns.jsonl` + gateway log, runs the L0 detectors, classifies into the
 *   9-class taxonomy, maps to the 22 job specs, scores by
 *   `severity × frequency × reach × recency`, and writes the ledger the admin
 *   page reads. `--sync-issues` opens/updates/closes the GitHub issues.
 * - `deep-dive-targets` — prints the top-N ledger records as a structured brief
 *   the owner agent's weekly cron consumes for the budgeted Opus deep-dive.
 * - `mapping` — prints the signal→job-spec mapping table (documentation).
 *
 * The GitHub sync is default-OFF (network-guarded), so CI/tests never hit it.
 */
export function registerFleetHealthCommand(program: Command): void {
  const cmd = program
    .command("fleet-health")
    .description(
      "Fleet Health live detection pipeline: model-free sensor, priority " +
        "ledger, and GitHub-issue lifecycle (RFC fleet-health.md).",
    );

  cmd
    .command("scan")
    .description(
      "Nightly model-free sensor: scan every agent's turns.jsonl + gateway " +
        "log, rank recurring failures by priority, write the ledger.",
    )
    .option("--dry-run", "print the ledger, do not write it", false)
    .option("--json", "emit machine-readable JSON", false)
    .option(
      "--sync-issues",
      "open/update/close GitHub issues (needs an authed gh; off by default)",
      false,
    )
    .option("--window-days <n>", "scan window in days", "30")
    .option(
      "--repo <owner/name>",
      "GitHub repo for issue sync (default switchroom/switchroom)",
      "switchroom/switchroom",
    )
    .action(
      withConfigError(async (opts: Record<string, unknown>) => {
        const cfg = getConfig(program);
        const ownerAgent = cfg.fleet_health?.owner_agent;
        const windowDays = Number(opts.windowDays) || 30;
        const log = (m: string) => console.error(chalk.gray(m));

        const result = runScan({ ownerAgent, windowDays, log });
        const ledger = result.ledger;

        log(
          `fleet-health: scanned ${result.agentsScanned} agents` +
            (result.agentsSkipped.length
              ? `, skipped ${result.agentsSkipped.length} (${result.agentsSkipped.join(", ")})`
              : ""),
        );

        if (opts.syncIssues && !opts.dryRun) {
          const deps = defaultGhDeps(log);
          const sync = syncLedgerIssues(ledger, String(opts.repo), deps);
          if (!sync.skipped) {
            log(`fleet-health: synced ${sync.synced} issues to ${String(opts.repo)}`);
          }
        } else if (opts.syncIssues && opts.dryRun) {
          log("fleet-health: --dry-run set, skipping GitHub issue sync.");
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(ledger, null, 2) + "\n");
        } else {
          printLedgerTable(ledger);
        }

        if (opts.dryRun) {
          log("fleet-health: --dry-run — ledger NOT written.");
          return;
        }
        const base = resolveSwitchroomBase();
        const path = writeLedger(base, ledger);
        log(chalk.green(`fleet-health: wrote ledger → ${path}`));
      }),
    );

  cmd
    .command("deep-dive-targets")
    .description(
      "Print the top-N ledger records (by priority) as a structured brief " +
        "for the owner agent's weekly Opus deep-dive cron.",
    )
    .option("--top <n>", "number of targets", "2")
    .option("--json", "emit machine-readable JSON", false)
    .action(
      withConfigError(async (opts: Record<string, unknown>) => {
        const base = resolveSwitchroomBase();
        const { readLedgerIfPresent } = await import("../fleet-health/scan.js");
        const ledger = readLedgerIfPresent(base);
        const top = Number(opts.top) || 2;
        if (!ledger) {
          console.error(
            chalk.yellow(
              "fleet-health: no ledger yet — run `fleet-health scan` first.",
            ),
          );
          return;
        }
        const targets = [...ledger.records]
          .filter((r) => r.open_issue_count > 0)
          .sort((a, b) => b.priority_score - a.priority_score)
          .slice(0, top);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ targets }, null, 2) + "\n");
          return;
        }
        printDeepDiveBrief(targets);
      }),
    );

  cmd
    .command("mapping")
    .description("Print the signal→job-spec mapping + severity table.")
    .action(() => {
      console.log(chalk.bold("Signal → job-spec mapping (model-free):\n"));
      for (const [signal, m] of Object.entries(SIGNAL_MAP)) {
        console.log(
          `  ${chalk.cyan(signal.padEnd(28))} → ${m.job_spec.padEnd(30)} ` +
            `[${m.failure_mode}, sev ${m.severity}]`,
        );
      }
    });
}

function printLedgerTable(ledger: FleetHealthLedger): void {
  const ranked = [...ledger.records].sort(
    (a, b) => b.priority_score - a.priority_score,
  );
  console.log(chalk.bold("\nFleet Health ledger (worst-first):"));
  console.log(
    chalk.gray(
      `owner=${ledger.owner_agent ?? "(unset)"}  generated_at=${ledger.generated_at}`,
    ),
  );
  for (const r of ranked) {
    if (r.open_issue_count === 0 && r.priority_score === 0) continue;
    console.log(
      `  ${chalk.yellow(r.priority_score.toFixed(2).padStart(8))}  ` +
        `${r.job_spec.padEnd(34)} open=${r.open_issue_count} ` +
        `issues=${r.issues.length}`,
    );
    for (const iss of r.issues) {
      console.log(
        chalk.gray(
          `        - ${iss.dedup_key}  freq=${iss.frequency} ` +
            `reach=[${iss.reach.join(",")}] sev=${iss.severity} ${iss.status}`,
        ),
      );
    }
  }
}

function printDeepDiveBrief(targets: FleetHealthRecord[]): void {
  console.log(chalk.bold("Fleet Health — weekly deep-dive targets\n"));
  if (targets.length === 0) {
    console.log("  (no open issues — nothing to deep-dive this week)");
    return;
  }
  for (const r of targets) {
    console.log(chalk.cyan(`## ${r.job_spec}  (score ${r.priority_score.toFixed(2)})`));
    console.log(`   spec: reference/jobs/${r.job_spec}.md`);
    console.log(`   open issues: ${r.open_issue_count}`);
    for (const iss of r.issues) {
      console.log(`   - ${iss.dedup_key} [${iss.failure_mode}, sev ${iss.severity}]`);
      console.log(
        `     freq=${iss.frequency} reach=[${iss.reach.join(",")}] ` +
          `newest=${iss.recency ?? "—"} gh=${iss.gh_issue ?? "none"}`,
      );
      for (const o of iss.occurrences.slice(0, 5)) {
        console.log(`       • ${o.agent} ${o.turn_id} — ${o.log_pointer ?? ""}`);
      }
    }
    console.log("");
  }
  console.log(
    chalk.gray(
      "Deep-dive: read the flagged turns' transcripts (join by turn_id), " +
        "root-cause, and write the finding into the linked GitHub issue.",
    ),
  );
}
