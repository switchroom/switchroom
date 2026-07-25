import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";

import {
  postOperatorNoticeViaGateways,
  type GatewayCandidate,
} from "../host-control/config-degraded.js";
import { tick } from "../hindsight-watch/run.js";
import { defaultStatePath } from "../hindsight-watch/state.js";
import {
  DEFAULT_CONTAINER,
  DEFAULT_METRICS_URL,
  RETAIN_FAILURE_RATE,
  RETAIN_P95_SECONDS,
} from "../hindsight-watch/thresholds.js";

/**
 * `switchroom hindsight-watch` — the model-free hindsight watchdog.
 *
 * Serves `reference/jobs/remember-across-sessions.md` (memory actually
 * lands) via `reference/jobs/fleet-stays-healthy.md` (the fleet watches
 * itself, deterministically, and puts the failure in front of the operator).
 *
 * WHY a host CLI verb on a host cron rather than an agent cron: the check
 * needs the docker socket AND every agent's spool directory, neither of
 * which an agent container has for its peers; and an alert that depends on a
 * model choosing to speak is not a monitor. Zero model tokens per tick — the
 * only outputs are stdout and one plain operator DM through an agent's
 * gateway socket (the same `rollout_status_post` relay hostd's degraded-boot
 * notice uses).
 *
 * Exit codes (cron-meaningful):
 *   0  — ran, nothing firing
 *  10  — ran, at least one signal firing (DM sent, subject to hysteresis)
 *   1  — could NOT complete (hindsight unreachable, /metrics unparseable,
 *        state unwritable, or an alert that reached no gateway). Loud by
 *        design: a watchdog that cannot see — or cannot speak — is an
 *        incident, not a no-op.
 */
export function registerHindsightWatchCommand(program: Command): void {
  program
    .command("hindsight-watch")
    .description(
      "Model-free hindsight watchdog: retain failure rate, spool growth, " +
        "container health, retain p95. Alerts the operator once, with hysteresis.",
    )
    .option("--dry-run", "evaluate and print; send no DM and write no state", false)
    .option("--json", "emit machine-readable JSON", false)
    .option("--metrics-url <url>", "hindsight /metrics endpoint", DEFAULT_METRICS_URL)
    .option("--container <name>", "hindsight container to inspect", DEFAULT_CONTAINER)
    .option("--state <path>", "state file path (default ~/.switchroom/hindsight-watch/state.json)")
    .option("--agents-dir <path>", "agents scaffold dir (default ~/.switchroom/agents)")
    .action(async (opts) => {
      const agentsDir: string =
        opts.agentsDir ??
        process.env.SWITCHROOM_AGENTS_DIR ??
        join(process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(), ".switchroom", "agents");
      const statePath: string = opts.state ?? defaultStatePath();
      const log = (m: string): void => {
        process.stderr.write(`${m}\n`);
      };

      const result = await tick({
        statePath,
        metricsUrl: opts.metricsUrl,
        container: opts.container,
        agentsDir,
        dryRun: Boolean(opts.dryRun),
        log,
        notify: (text) => notifyOperator(agentsDir, text, log),
      });

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              probeError: result.probeError,
              exitCode: result.exitCode,
              thresholds: {
                retainFailureRate: RETAIN_FAILURE_RATE,
                retainP95Seconds: RETAIN_P95_SECONDS,
              },
              signals: result.outcomes.map((o) => ({
                signal: o.verdict.signal,
                state: o.verdict.state,
                detail: o.verdict.detail,
                measured: o.verdict.measured ?? null,
                transition: o.transition,
                status: o.state.status,
              })),
              notified: result.notified,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        for (const o of result.outcomes) {
          const mark =
            o.verdict.state === "breach"
              ? chalk.red("BREACH")
              : o.verdict.state === "no-data"
                ? chalk.gray("no-data")
                : chalk.green("ok");
          const suffix = o.transition === "none" ? "" : chalk.yellow(`  [${o.transition}]`);
          process.stdout.write(`${mark}  ${o.verdict.signal}: ${o.verdict.detail}${suffix}\n`);
        }
        if (result.notified.length > 0) {
          const header = opts.dryRun ? "would send" : "sent";
          process.stdout.write(`\n${chalk.bold(`${result.notified.length} operator DM ${header}:`)}\n`);
          for (const t of result.notified) {
            process.stdout.write(t.split("\n").map((l) => `  | ${l}`).join("\n") + "\n");
          }
        }
      }
      process.exitCode = result.exitCode;
    });
}

/**
 * Deliver one plain operator DM through the first agent gateway socket that
 * accepts it. Identical transport to hostd's degraded-boot notice; the
 * gateway fences delivery to its own operator chat, so this cannot address a
 * foreign chat.
 */
async function notifyOperator(
  agentsDir: string,
  text: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const candidates: GatewayCandidate[] = [];
  try {
    for (const name of readdirSync(agentsDir).sort()) {
      const sock = resolve(agentsDir, name, "telegram", "gateway.sock");
      if (existsSync(sock)) candidates.push({ agent: name, sock });
    }
  } catch (e) {
    log(`hindsight-watch: agents dir unreadable (${(e as Error).message})`);
  }
  if (candidates.length === 0) {
    log("hindsight-watch: no gateway socket found — alert undelivered, will retry next tick");
    return false;
  }
  const agent = await postOperatorNoticeViaGateways(candidates, text, log, 5_000, "hindsight-watch", "");
  return agent !== null;
}
