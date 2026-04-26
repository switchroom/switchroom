import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import { findLatestSessionJsonl } from "../agents/handoff-summarizer.js";
import {
  readTurnUsages,
  summarizeCache,
  formatCacheStatsText,
} from "../agents/perf.js";

/**
 * `switchroom agent perf <name>` — surface cache-hit telemetry from the
 * agent's most recent session JSONL. Pure read-only: walks
 * `$AGENT/.claude/projects/<...>/<latest>.jsonl`, plucks the last N
 * assistant turns' `usage` blocks, and prints aggregate cache_read /
 * cache_creation ratios.
 *
 * Default `--last 20` keeps the parse cheap and the numbers
 * operationally relevant (last hour or two of activity for a busy
 * agent). `--full` mirrors the eval-harness use case where we want
 * every turn since the agent booted.
 *
 * Exits 0 on every soft failure (agent missing, JSONL absent,
 * unparseable lines) so this can be safely invoked from cron / status
 * dashboards without spurious alerts.
 */
export function registerAgentPerfCommand(agent: Command): void {
  agent
    .command("perf <name>")
    .description(
      "Show cache-hit telemetry for an agent (cache_read / cache_creation per-turn from the latest session JSONL)"
    )
    .option("--last <n>", "Number of recent assistant turns to analyze", "20")
    .option("--full", "Analyze every turn in the JSONL (overrides --last)")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(
        async (
          name: string,
          opts: { last: string; full?: boolean; json?: boolean },
        ) => {
          const config = getConfig(program(agent));
          const agentsDir = resolveAgentsDir(config);
          const agentConfig = config.agents[name];
          if (!agentConfig) {
            console.error(
              chalk.red(`Agent "${name}" is not defined in switchroom.yaml`),
            );
            process.exit(1);
          }

          const agentDir = resolve(agentsDir, name);
          const claudeConfigDir = resolve(agentDir, ".claude");
          const jsonl = findLatestSessionJsonl(claudeConfigDir);
          if (!jsonl) {
            if (opts.json) {
              console.log(
                JSON.stringify({ name, error: "no session JSONL found" }, null, 2),
              );
            } else {
              console.error(
                chalk.yellow(
                  `perf: no session JSONL under ${claudeConfigDir}/projects — has the agent run yet?`,
                ),
              );
            }
            return;
          }

          // `--full` is implemented as "give me effectively unbounded N".
          // 1e9 turns is impossible to reach in practice but lets us reuse
          // the ring-buffer code path without a special case.
          const lastN = opts.full
            ? 1_000_000_000
            : Math.max(1, parseInt(opts.last, 10) || 20);

          const turns = readTurnUsages(jsonl, lastN);
          const stats = summarizeCache(turns);

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  name,
                  jsonlPath: jsonl,
                  ...stats,
                },
                null,
                2,
              ),
            );
            return;
          }

          if (stats.turnsAnalyzed === 0) {
            console.log(`agent: ${name}`);
            console.log("turns_analyzed: 0");
            console.log(
              chalk.gray(
                "  (JSONL had no assistant lines with usage; agent may not have completed a turn yet)",
              ),
            );
            return;
          }

          console.log(formatCacheStatsText(name, stats));
        },
      ),
    );
}

/**
 * Walk up to find the root `Command` (the program). commander attaches
 * the parent chain via `.parent`, and `withConfigError`'s helpers
 * (`getConfig`/`getConfigPath`) want the program-level command. The
 * `agent` sub-command we register on here is one level deep, so its
 * parent is the program — but we walk defensively in case the layout
 * changes.
 */
function program(cmd: Command): Command {
  let cur: Command = cmd;
  while (cur.parent) cur = cur.parent;
  return cur;
}
