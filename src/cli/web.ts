import type { Command } from "commander";
import chalk from "chalk";
import { startWebServer } from "../web/server.js";
import { withConfigError, getConfig } from "./helpers.js";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Start the web dashboard for monitoring agents")
    .option("-p, --port <port>", "Port to listen on", "8080")
    .action(
      withConfigError(async (opts) => {
        const config = getConfig(program);
        const port = parseInt(opts.port, 10);

        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("Invalid port number"));
          process.exit(1);
        }

        console.log(chalk.bold("\nStarting Switchroom dashboard...\n"));
        console.log(chalk.gray(`  Agents: ${Object.keys(config.agents).join(", ")}`));
        console.log(chalk.gray(`  Port:   ${port}\n`));

        const { token } = startWebServer(config, port);

        console.log(
          chalk.green(`\n  Dashboard: http://localhost:${port}\n`)
        );
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
