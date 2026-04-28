import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import { restartAgent, writeRestartReasonMarker, getAgentStatus } from "../agents/lifecycle.js";
import { reconcileAndRestartAgent } from "./agent.js";
import { printHealthSummary } from "./version.js";
import { getAuthStatus } from "../auth/manager.js";

/**
 * Poll auth status for `name` until it reads authenticated=true, up to
 * `timeoutMs` (default 30 s).  Returns true if auth converged within the
 * window, false if it timed out.  Fixes #176: restart now blocks until auth
 * status reflects reality so `switchroom restart && switchroom auth status`
 * shows ✓ without a second manual run.
 */
function waitForAuthConverge(
  name: string,
  agentDir: string,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = getAuthStatus(name, agentDir);
      if (s.authenticated) return true;
    } catch {
      // ignore transient errors during settle window
    }
    // Synchronous sleep — restart command is already blocking on systemctl.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  return false;
}

/**
 * `switchroom restart [agent]`
 *
 * With no agent argument: restart all agents.
 * With an agent name: restart just that agent.
 *
 * Drain semantics: by default we use the graceful-restart path which
 * waits for an in-flight claude turn to complete before cycling the
 * process (same as `agent restart --graceful-restart`). When a turn is
 * in flight, the restart is *scheduled* — the CLI prints "restart
 * scheduled (waiting for turn to complete)" and exits 0. The actual
 * bounce happens asynchronously when the gateway observes the turn
 * complete (or hits the 60s drain cap and forces). Automation that
 * needs a synchronous wait should poll `switchroom version` until the
 * uptime resets, or use `--force`.
 *
 * --force: skip drain, SIGTERM immediately. Synchronous from the CLI's
 * perspective — exits when the systemctl restart returns.
 *
 * Prints the one-line health summary when done.
 */
export function registerRestartCommand(program: Command): void {
  program
    .command("restart [agent]")
    .description(
      "Restart all agents (or a named agent). Drains in-flight turns by default; use --force to skip."
    )
    .option("--force", "Skip drain — SIGTERM immediately without waiting for turn to complete")
    .action(
      withConfigError(async (agentArg: string | undefined, opts: { force?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const configPath = getConfigPath(program);
        const allNames = Object.keys(config.agents);

        const names = agentArg
          ? agentArg === "all"
            ? allNames
            : [agentArg]
          : allNames;

        if (names.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml — nothing to restart."));
          return;
        }

        const graceful = !opts.force;

        for (const name of names) {
          if (!config.agents[name]) {
            console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
            continue;
          }

          try {
            writeRestartReasonMarker(name, "cli: switchroom restart", { preserveExisting: true });

            const res = await reconcileAndRestartAgent(
              name,
              config,
              agentsDir,
              configPath,
              { graceful },
            );

            if (graceful) {
              if (res.restarted) {
                console.log(chalk.green(`  ${name}: restarted`));
              } else if (res.waitingForTurn) {
                console.log(chalk.yellow(`  ${name}: restart scheduled (waiting for turn to complete)`));
              }
            } else {
              console.log(chalk.green(`  ${name}: restarted`));
            }

            // Auth-settling wait (#176): after a synchronous restart, poll
            // until auth status converges so the very next `auth status` run
            // shows the correct value without a manual retry.  Only applies
            // when the restart actually completed (not "waiting for turn") —
            // for scheduled restarts auth settles asynchronously.
            const didRestart = res.restarted || !graceful;
            if (didRestart) {
              const agentDir = resolve(agentsDir, name);
              const converged = waitForAuthConverge(name, agentDir);
              if (!converged) {
                console.log(
                  chalk.yellow(
                    `  ${name}: agent is up but auth status didn't converge in 30s — check logs`,
                  ),
                );
              }
            }
          } catch (err) {
            console.error(chalk.red(`  ${name}: restart failed: ${(err as Error).message}`));
          }
        }

        // Print health summary
        console.log();
        printHealthSummary(config);
      })
    );
}
