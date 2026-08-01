import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";

import {
  postOperatorNoticeViaGateways,
  type GatewayCandidate,
} from "../host-control/config-degraded.js";
import {
  CRON_LOG_PATH,
  CRON_PATH,
  CRON_SCHEDULE,
  ensureLogFile,
  installCron,
  installLogrotate,
} from "../hindsight-watch/install-cron.js";
import { tick } from "../hindsight-watch/run.js";
import { defaultStatePath } from "../hindsight-watch/state.js";
import {
  DEFAULT_CONTAINER,
  DEFAULT_METRICS_URL,
  QUEUE_FLOOR,
  QUEUE_GROWTH_FRACTION,
  QUEUE_GROWTH_MIN_ABS,
  RETAIN_FAILURE_RATE,
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
      "Model-free hindsight watchdog: recall health, retain failure rate, " +
        "spool growth, memory loss, container health. Alerts once, with hysteresis.",
    )
    .option(
      "--install-cron",
      `arm the watchdog: write ${CRON_PATH} (15-min, flock-guarded) and exit`,
      false,
    )
    .option("--cron-user <user>", "unix user the cron tick runs as (default: current user)")
    .option("--dry-run", "evaluate and print; send no DM and write no state", false)
    .option("--json", "emit machine-readable JSON", false)
    .option("--metrics-url <url>", "hindsight /metrics endpoint", DEFAULT_METRICS_URL)
    .option("--container <name>", "hindsight container to inspect", DEFAULT_CONTAINER)
    .option("--state <path>", "state file path (default ~/.switchroom/hindsight-watch/state.json)")
    .option("--agents-dir <path>", "agents scaffold dir (default ~/.switchroom/agents)")
    .action(async (opts) => {
      if (opts.installCron) {
        process.exitCode = runInstallCron(opts.cronUser);
        return;
      }
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
                queueFloor: QUEUE_FLOOR,
                queueGrowthFraction: QUEUE_GROWTH_FRACTION,
                queueGrowthMinAbs: QUEUE_GROWTH_MIN_ABS,
              },
              signals: result.outcomes.map((o) => ({
                signal: o.verdict.signal,
                state: o.verdict.state,
                severity: o.verdict.severity ?? null,
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
          // A `warn` breach renders distinctly from a `page` one. Without
          // this the terminal view collapses both onto "BREACH", so an
          // operator triaging a dry-run cannot tell a 4.6h consolidation
          // backlog from an 88% recall outage — the same flattening the DM
          // headers avoid. Signals with no severity keep the original label.
          const mark =
            o.verdict.state === "breach"
              ? o.verdict.severity === "warn"
                ? chalk.yellow("WARN  ")
                : o.verdict.severity === "page"
                  ? chalk.red("PAGE  ")
                  : chalk.red("BREACH")
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
 * `--install-cron`: arm the watchdog.
 *
 * Refuses rather than guessing in the two cases where a guess would install a
 * cron that silently never works:
 *
 *  - **running as root with no `--cron-user`.** `sudo switchroom …` would
 *    otherwise write `root` into the user field, and root's `$HOME` is not
 *    where the state file and the agents scaffold live — every tick would
 *    read an empty fleet and report a clean bill of health forever. That is
 *    the precise failure this whole change exists to eliminate, so it is a
 *    hard error, not a warning.
 *  - **an unresolvable binary path.** A relative or dev-mode argv[1] in a
 *    cron line produces a fragment that fails on every tick with a message
 *    only visible in `/var/log/syslog`.
 */
function runInstallCron(cronUser?: string): number {
  const user = cronUser ?? process.env.SUDO_USER ?? process.env.USER ?? process.env.LOGNAME;
  if (!user || user === "root") {
    process.stderr.write(
      chalk.red("hindsight-watch: refusing to install a cron for `root`.\n") +
        "  The state file and the agents scaffold live under the OPERATOR's " +
        "~/.switchroom, so a root tick would read an empty fleet and report " +
        "everything healthy forever.\n" +
        "  Re-run with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  // `process.argv[1]` is the entry script. Under `npm run dev` that is a .ts
  // file, which cron cannot execute — so require an absolute path to a real
  // installed binary rather than emitting a fragment that can never run.
  const binary = process.env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
  if (!binary.startsWith("/")) {
    process.stderr.write(
      chalk.red(`hindsight-watch: SWITCHROOM_BINARY must be an absolute path (got ${binary})\n`),
    );
    return 1;
  }

  let res: ReturnType<typeof installCron>;
  try {
    res = installCron({ user, binary });
  } catch (e) {
    process.stderr.write(
      chalk.red(`hindsight-watch: could not write ${CRON_PATH}: ${(e as Error).message}\n`) +
        "  This path needs root; re-run under sudo with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  // Provision the log file the cron redirects into, owned by the cron user
  // (#3991). Without this the `>> /var/log/hindsight-watch.log` redirection
  // fails "Permission denied" before switchroom is exec'd — every tick dies
  // and doctor FAILs forever with "the watchdog has never completed a tick".
  // A failure here is FATAL, not a warning: an armed cron that cannot write
  // its log is the exact silent-monitoring failure this verb exists to close.
  let logStatus: string;
  try {
    const logRes = ensureLogFile({ user });
    logStatus =
      logRes.status === "created"
        ? `created ${logRes.path} (owned by ${user})`
        : `${logRes.path} already present`;
  } catch (e) {
    process.stderr.write(
      chalk.red(`hindsight-watch: could not provision the log file: ${(e as Error).message}\n`) +
        `  The cron redirects into ${CRON_LOG_PATH} and would die at ` +
        "the redirection every tick.\n  This path needs root; re-run under sudo with " +
        "`--cron-user <operator>`.\n",
    );
    return 1;
  }

  // Bound the log with a logrotate drop-in (#3992). Best-effort: a missing
  // logrotate config only means unbounded growth, not a broken tick, so a
  // failure here WARNs rather than aborting the arm.
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
    `${chalk.green("✓")} hindsight-watch cron ${verb} at ${res.path} ` +
      `(${CRON_SCHEDULE}, as ${user})\n` +
      `  log: ${logStatus}\n` +
      `  logrotate: ${rotateStatus}\n` +
      `  Verify with: switchroom doctor  |  switchroom hindsight-watch --dry-run\n`,
  );
  return 0;
}

/**
 * The fleet's root/admin debugging agent. hindsight-watch is a host process
 * with no chat of its own, so it relays its single operator DM through
 * whichever live agent gateway socket answers first (see
 * `postOperatorNoticeViaGateways`, which is first-success-wins over the
 * candidate order). Left in raw alphabetical order the relay always came out
 * of the alphabetically-first live gateway, so every watch alert appeared to
 * be sent by an unrelated agent's bot. The operator wants these host-monitor
 * alerts attributed to the root debugging agent instead.
 *
 * This is a COSMETIC delivery preference only: if this agent's gateway is
 * down, delivery falls back to the remaining agents in alphabetical order
 * (see `orderRelayCandidates`), so an alert is never dropped for attribution.
 *
 * A bare constant — rather than reading the full config cascade to discover
 * which agent is admin/root — is deliberate: hindsight-watch is a zero-model
 * host cron that must stay cheap and dependency-light, and walking config per
 * tick to answer a purely cosmetic question isn't worth it.
 */
export const PREFERRED_RELAY_AGENT = "overlord";

/**
 * Reorder relay candidates so `preferred` is tried first when present,
 * preserving the relative order (alphabetical, as built by the caller) of the
 * rest as fallback. Pure; no IO. A candidate is only present here when its
 * gateway socket is live, so a missing/down preferred agent simply leaves the
 * alphabetical fallback list untouched.
 */
export function orderRelayCandidates(
  candidates: GatewayCandidate[],
  preferred: string = PREFERRED_RELAY_AGENT,
): GatewayCandidate[] {
  const first = candidates.filter((c) => c.agent === preferred);
  const rest = candidates.filter((c) => c.agent !== preferred);
  return [...first, ...rest];
}

/**
 * Walk the agents dir, collect every agent whose Telegram gateway socket is
 * live, and return them ordered with {@link PREFERRED_RELAY_AGENT} first. May
 * throw if the dir is unreadable — callers wrap this in try/catch.
 */
export function collectRelayCandidates(agentsDir: string): GatewayCandidate[] {
  const candidates: GatewayCandidate[] = [];
  for (const name of readdirSync(agentsDir).sort()) {
    const sock = resolve(agentsDir, name, "telegram", "gateway.sock");
    if (existsSync(sock)) candidates.push({ agent: name, sock });
  }
  return orderRelayCandidates(candidates);
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
  let candidates: GatewayCandidate[] = [];
  try {
    candidates = collectRelayCandidates(agentsDir);
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
