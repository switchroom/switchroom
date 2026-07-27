import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";

import {
  postOperatorNoticeViaGateways,
  type GatewayCandidate,
} from "../host-control/config-degraded.js";
import { CRON_PATH, CRON_SCHEDULE, installCron } from "../openrouter/install-cron.js";
import { tick } from "../openrouter/run.js";
import { defaultStatePath } from "../openrouter/state.js";
import {
  FAIL_REMAINING_FRACTION,
  FAIL_REMAINING_USD,
  OPENROUTER_VAULT_KEY,
  WARN_REMAINING_FRACTION,
  WARN_REMAINING_USD,
} from "../openrouter/credit.js";
import { RENOTIFY_MS } from "../openrouter/watch.js";

/**
 * `switchroom openrouter-watch` — the model-free OpenRouter credit watchdog.
 *
 * `switchroom doctor` answers "is credit low right now, when someone asks".
 * This is the half that answers before anyone asks. Same evaluator
 * (`src/openrouter/credit.ts`), so a green doctor and a silent watchdog can
 * never mean different things.
 *
 * WHY a host CLI verb on a host cron rather than an agent cron: the check
 * needs the vault broker and must not depend on a model choosing to speak. An
 * alert that a model can decline to send is not a monitor. Zero model tokens
 * per tick — the only outputs are stdout and, at most one per 6 h, a plain
 * operator DM through an agent's gateway socket (the same relay hostd's
 * degraded-boot notice uses).
 *
 * THE HONEST LIMIT, stated here because it is the case that will actually
 * apply today: with NO per-key credit limit set on the OpenRouter key,
 * `GET /api/v1/key` returns `limit`/`limit_remaining` as null and carries no
 * account-balance field, so there is nothing to threshold. This watchdog then
 * cannot warn about the account running dry, `switchroom doctor` says so as a
 * WARN, and this tick deliberately stays silent — a standing configuration
 * gap is not an incident, and paging about it hourly is how a channel gets
 * muted. Setting the per-key limit at https://openrouter.ai/settings/keys is
 * a manual console action; it is what makes proactive monitoring possible at
 * all.
 *
 * Exit codes (cron-meaningful):
 *   0  — ran, nothing firing
 *  10  — ran, a credit signal is firing (DM sent, subject to the re-notify window)
 *   1  — could NOT complete (vault key unreadable, OpenRouter unreachable,
 *        state unwritable, or an alert that reached no gateway)
 */
export function registerOpenRouterWatchCommand(program: Command): void {
  program
    .command("openrouter-watch")
    .description(
      "Model-free OpenRouter credit watchdog: warns before the key's credit runs out. " +
        "Alerts at most once per 6h, and escalates immediately.",
    )
    .option(
      "--install-cron",
      `arm the watchdog: write ${CRON_PATH} (${CRON_SCHEDULE}, flock-guarded) and exit`,
      false,
    )
    .option("--cron-user <user>", "unix user the cron tick runs as (default: current user)")
    .option("--dry-run", "evaluate and print; send no DM and write no state", false)
    .option("--json", "emit machine-readable JSON", false)
    .option("--state <path>", "state file path (default ~/.switchroom/openrouter-watch/state.json)")
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
        dryRun: Boolean(opts.dryRun),
        log,
        // The key is read through the NORMAL vault broker path at runtime and
        // used only as an Authorization header. It is never logged or printed.
        readSecret: async (key) => {
          const { getViaBrokerStructured } = await import("../vault/broker/client.js");
          const res = await getViaBrokerStructured(key);
          if (res.kind === "ok" && res.entry.kind === "string") return res.entry.value;
          return null;
        },
        fetchFn: (url, init) =>
          fetch(url, {
            headers: init?.headers,
            signal: init?.signal ?? AbortSignal.timeout(10_000),
          }),
        notify: (text) => notifyOperator(agentsDir, text, log),
      });

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: result.assessment.status,
              detail: result.assessment.detail,
              fix: result.assessment.fix ?? null,
              actionable: result.assessment.actionable,
              firing: result.firing,
              notified: result.notice,
              delivered: result.delivered,
              exitCode: result.exitCode,
              vaultKey: OPENROUTER_VAULT_KEY,
              thresholds: {
                warnRemainingFraction: WARN_REMAINING_FRACTION,
                warnRemainingUsd: WARN_REMAINING_USD,
                failRemainingFraction: FAIL_REMAINING_FRACTION,
                failRemainingUsd: FAIL_REMAINING_USD,
                renotifyMs: RENOTIFY_MS,
              },
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        const mark =
          result.assessment.status === "fail"
            ? chalk.red("FAIL")
            : result.assessment.status === "warn"
              ? chalk.yellow("WARN")
              : result.assessment.status === "skip"
                ? chalk.gray("skip")
                : chalk.green("ok  ");
        process.stdout.write(`${mark}  ${result.assessment.detail}\n`);
        if (result.assessment.fix) process.stdout.write(`      → ${result.assessment.fix}\n`);
        if (result.notice) {
          const header = opts.dryRun ? "would send" : result.delivered ? "sent" : "UNDELIVERED";
          process.stdout.write(`\n${chalk.bold(`operator DM ${header}:`)}\n`);
          process.stdout.write(
            result.notice.split("\n").map((l) => `  | ${l}`).join("\n") + "\n",
          );
        } else if (result.firing) {
          process.stdout.write(
            chalk.gray(`      (firing, but already reported within the ${RENOTIFY_MS / 3_600_000}h window)\n`),
          );
        }
      }
      process.exitCode = result.exitCode;
    });
}

/**
 * `--install-cron`: arm the watchdog.
 *
 * Refuses rather than guessing in the two cases where a guess installs a cron
 * that silently never works — identical reasoning to `hindsight-watch`:
 * a root tick reads the wrong `$HOME` (so the re-notify ledger lives
 * somewhere the operator's tooling never looks), and a relative argv[1] under
 * dev mode produces a cron line that fails on every tick into syslog.
 */
function runInstallCron(cronUser?: string): number {
  const user = cronUser ?? process.env.SUDO_USER ?? process.env.USER ?? process.env.LOGNAME;
  if (!user || user === "root") {
    process.stderr.write(
      chalk.red("openrouter-watch: refusing to install a cron for `root`.\n") +
        "  The state file and the agents scaffold live under the OPERATOR's " +
        "~/.switchroom, so a root tick would keep its re-notify ledger somewhere " +
        "nothing else reads.\n" +
        "  Re-run with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  const binary = process.env.SWITCHROOM_BINARY ?? "/usr/local/bin/switchroom";
  if (!binary.startsWith("/")) {
    process.stderr.write(
      chalk.red(`openrouter-watch: SWITCHROOM_BINARY must be an absolute path (got ${binary})\n`),
    );
    return 1;
  }

  let res: ReturnType<typeof installCron>;
  try {
    res = installCron({ user, binary });
  } catch (e) {
    process.stderr.write(
      chalk.red(`openrouter-watch: could not write ${CRON_PATH}: ${(e as Error).message}\n`) +
        "  This path needs root; re-run under sudo with `--cron-user <operator>`.\n",
    );
    return 1;
  }

  const verb = res.status === "installed" ? "installed" : "already up to date";
  process.stdout.write(
    `${chalk.green("✓")} openrouter-watch cron ${verb} at ${res.path} ` +
      `(${CRON_SCHEDULE}, as ${user})\n` +
      `  Verify with: switchroom openrouter-watch --dry-run\n`,
  );
  return 0;
}

/**
 * Deliver one plain operator DM through the first agent gateway socket that
 * accepts it. Identical transport to hostd's degraded-boot notice; the gateway
 * fences delivery to its own operator chat, so this cannot address a foreign
 * chat.
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
    log(`openrouter-watch: agents dir unreadable (${(e as Error).message})`);
  }
  if (candidates.length === 0) {
    log("openrouter-watch: no gateway socket found — alert undelivered, will retry next tick");
    return false;
  }
  const agent = await postOperatorNoticeViaGateways(
    candidates,
    text,
    log,
    5_000,
    "openrouter-watch",
    "",
  );
  return agent !== null;
}
