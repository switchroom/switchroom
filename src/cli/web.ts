import type { Command } from "commander";
import chalk from "chalk";
import { startWebServer } from "../web/server.js";
import { withConfigError, getConfig } from "./helpers.js";
import { captureEvent } from "../analytics/posthog.js";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Start the web dashboard for monitoring agents")
    .option("-p, --port <port>", "Port to listen on", "8080")
    .option("-b, --bind <host>", "Host/IP to bind to (default: 127.0.0.1, localhost-only)", "127.0.0.1")
    .action(
      withConfigError(async (opts) => {
        const config = getConfig(program);
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

        const { token } = startWebServer(config, port, hostname);

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
        console.log(chalk.gray(`  Token: ${token}`));
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
