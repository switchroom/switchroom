import type { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { homedir } from "node:os";
import { startWebServer } from "../web/server.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import { ConfigError } from "../config/loader.js";
import {
  detectConfigMountFault,
  nextCrashBackoff,
  readCrashState,
  writeCrashState,
  clearCrashState,
} from "../web/startup-guard.js";
import { captureEvent } from "../analytics/posthog.js";

/**
 * #2915 — when the long-running web container fails to start (config
 * unreadable, e.g. the stale single-file-bind directory-inode fault), fail
 * LOUDLY once and then PACE subsequent `restart: always` relaunches with a
 * persisted, bounded exponential backoff, instead of crash-looping the host
 * hundreds of times per minute. Diagnoses the directory-inode case with an
 * actionable recreate remedy. Sleeps the backoff, then re-throws so the
 * normal ConfigError handler prints + exits non-zero.
 */
async function handleWebStartupFailure(
  err: unknown,
  configPath: string | undefined,
  stateFile: string,
): Promise<never> {
  if (err instanceof ConfigError && configPath) {
    const fault = detectConfigMountFault(configPath);
    if (fault) {
      console.error(chalk.red(fault.message));
    }
  }
  const { state, delayMs } = nextCrashBackoff(readCrashState(stateFile), Date.now());
  writeCrashState(stateFile, state);
  if (delayMs > 0) {
    console.error(
      chalk.yellow(
        `switchroom-web: startup has failed ${state.count}× in a row — backing off ` +
          `${Math.round(delayMs / 1000)}s before exit so \`restart: always\` doesn't ` +
          `crash-loop the host (issue #2915).`,
      ),
    );
    await new Promise<void>((r) => setTimeout(r, delayMs));
  }
  throw err;
}

/** Default location of the web crash-loop backoff marker. */
export function webCrashStatePath(): string {
  return join(homedir(), ".switchroom", "web", ".crashloop-state.json");
}

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Start the web dashboard for monitoring agents")
    .option("-p, --port <port>", "Port to listen on", "8080")
    .option("-b, --bind <host>", "Host/IP to bind to (default: 127.0.0.1, localhost-only)", "127.0.0.1")
    .action(
      withConfigError(async (opts) => {
        const configPath = getConfigPath(program);
        const stateFile = webCrashStatePath();
        let config;
        try {
          config = getConfig(program);
        } catch (err) {
          await handleWebStartupFailure(err, configPath, stateFile);
          throw err; // unreachable (handleWebStartupFailure always throws) — narrows `config`
        }
        // Config loaded cleanly — the crash loop (if any) is broken; reset
        // the backoff counter so a future failure starts fresh.
        clearCrashState(stateFile);
        const port = parseInt(opts.port, 10);
        const hostname = opts.bind as string;

        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("Invalid port number"));
          process.exit(1);
        }

        const isLanBind = hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";

        console.log(chalk.bold("\nStarting Switchroom dashboard...\n"));
        console.log(chalk.gray(`  Agents: ${Object.keys(config.agents).join(", ")}`));
        console.log(chalk.gray(`  Port:   ${port}`));
        if (isLanBind) {
          console.log(chalk.gray(`  Bind:   ${hostname} (network-accessible)\n`));
        } else {
          console.log();
        }

        const { token } = startWebServer(config, port, hostname, getConfigPath(program));

        void captureEvent("web_server_started", {
          port,
          hostname,
          agent_count: Object.keys(config.agents).length,
          auth_configured: Boolean(process.env.SWITCHROOM_WEB_TOKEN),
        });

        const displayHost = hostname === "0.0.0.0" ? "<host-ip>" : hostname;
        console.log(
          chalk.green(`\n  Dashboard: http://${displayHost}:${port}\n`)
        );
        if (isLanBind) {
          console.log(
            chalk.yellow(
              "  Network-accessible bind — reachable from LAN/Tailscale.\n" +
                "  The token below is required for all requests.\n"
            )
          );
        }
        // Token only echoes to TTY. Possession = full dashboard
        // access — non-TTY captures (CI logs, tmux scrollback, support
        // screen-shares) shouldn't get a copy. Operators reading from
        // a non-TTY context should fetch from ~/.switchroom/web-token.
        if (process.stdout.isTTY) {
          console.log(chalk.gray(`  Token: ${token}`));
        } else {
          console.log(
            chalk.gray(`  Token: <hidden, read ~/.switchroom/web-token>`),
          );
        }
        console.log(
          chalk.gray(
            "  Open the dashboard in a browser that can pass the bearer via\n" +
              "  Authorization header or Sec-WebSocket-Protocol. Override the\n" +
              "  token with SWITCHROOM_WEB_TOKEN env var; default persists at\n" +
              "  ~/.switchroom/web-token.\n"
          )
        );
      })
    );
}
