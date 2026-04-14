import type { Command } from "commander";
import chalk from "chalk";
import {
  installAllUnits,
  uninstallUnit,
  daemonReload,
} from "../agents/systemd.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { withConfigError, getConfig } from "./helpers.js";

export function registerSystemdCommand(program: Command): void {
  const systemd = program
    .command("systemd")
    .description("Manage systemd user units for agents");

  // switchroom systemd install
  systemd
    .command("install")
    .description("Generate and install systemd units for all agents")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        console.log(chalk.bold("\nInstalling systemd units...\n"));

        try {
          installAllUnits(config);
          for (const name of agentNames) {
            console.log(chalk.green(`  + switchroom-${name}.service`));
          }
          console.log(
            chalk.bold(`\nInstalled ${agentNames.length} units. Daemon reloaded.`)
          );
          console.log(chalk.gray(`  Enable with: switchroom agent start all\n`));
        } catch (err) {
          console.error(
            chalk.red(`Failed to install units: ${(err as Error).message}`)
          );
          process.exit(1);
        }
      })
    );

  // switchroom systemd status
  systemd
    .command("status")
    .description("Show status of all agent systemd units")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);
        const statuses = getAllAgentStatuses(config);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          return;
        }

        console.log(chalk.bold("\nSystemd unit status:\n"));

        const nameWidth = 28;
        const statusWidth = 12;

        console.log(
          `  ${chalk.bold("Unit".padEnd(nameWidth))}  ${chalk.bold("Status".padEnd(statusWidth))}`
        );

        for (const name of agentNames) {
          const status = statuses[name];
          const unitName = `switchroom-${name}.service`;
          const state = status?.active ?? "unknown";
          const stateStr =
            state === "running" || state === "active"
              ? chalk.green(state)
              : state === "stopped" || state === "inactive" || state === "dead"
                ? chalk.red(state)
                : chalk.yellow(state);

          console.log(
            `  ${unitName.padEnd(nameWidth)}  ${stateStr}`
          );
        }
        console.log();
      })
    );

  // switchroom systemd uninstall
  systemd
    .command("uninstall")
    .description("Remove all agent systemd units")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        console.log(chalk.bold("\nUninstalling systemd units...\n"));

        for (const name of agentNames) {
          try {
            uninstallUnit(name);
            console.log(chalk.green(`  - switchroom-${name}.service`));
          } catch (err) {
            console.error(
              chalk.red(
                `  Failed to remove switchroom-${name}.service: ${(err as Error).message}`
              )
            );
          }
        }

        try {
          daemonReload();
        } catch {
          // best effort
        }

        console.log(chalk.bold(`\nRemoved ${agentNames.length} units.\n`));
      })
    );
}
