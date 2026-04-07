import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { loadConfig, resolveAgentsDir, ConfigError } from "../config/loader.js";
import {
  loginAgent,
  loginAllAgents,
  getAuthStatus,
  getAllAuthStatuses,
  refreshAgent,
} from "../auth/manager.js";

function withConfigError(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(chalk.red(`Config error: ${err.message}`));
        if (err.details) {
          for (const d of err.details) {
            console.error(chalk.gray(d));
          }
        }
        process.exit(1);
      }
      throw err;
    }
  };
}

function getConfig(program: Command) {
  const parentOpts = program.opts();
  return loadConfig(parentOpts.config);
}

function printAuthTable(
  headers: string[],
  rows: string[][],
  widths: number[]
): void {
  const headerLine = headers
    .map((h, i) => chalk.bold(h.padEnd(widths[i])))
    .join("  ");
  console.log(`  ${headerLine}`);

  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
    console.log(`  ${line}`);
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage OAuth authentication per agent");

  // clerk auth login <name|all>
  auth
    .command("login <name>")
    .description(
      "Login an agent via OAuth (or 'all' to login all agents sequentially)"
    )
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (name === "all") {
          console.log(chalk.bold("\nLogging in all agents...\n"));
          const results = loginAllAgents(config);

          for (const [agentName, result] of Object.entries(results)) {
            if (result.success) {
              console.log(chalk.green(`  ${agentName}: authenticated`));
            } else {
              console.error(chalk.red(`  ${agentName}: failed`));
            }
          }
          console.log();
          return;
        }

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          console.error(
            chalk.gray(
              `  Available agents: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        console.log(chalk.bold(`\nLogging in agent: ${name}\n`));
        const result = loginAgent(name, agentDir);

        if (result.success) {
          console.log(chalk.green(`\nAgent "${name}" authenticated successfully.\n`));
        } else {
          console.error(chalk.red(`\nFailed to authenticate agent "${name}".\n`));
          process.exit(1);
        }
      })
    );

  // clerk auth status
  auth
    .command("status")
    .description("Show authentication status for all agents")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const statuses = getAllAuthStatuses(config);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        const headers = ["Name", "Subscription", "Expires In", "Rate Limit", "Status"];
        const widths = [16, 14, 12, 26, 8];

        const rows = agentNames.map((name) => {
          const status = statuses[name];

          if (!status.authenticated) {
            return [
              name,
              "\u2014",
              "\u2014",
              "\u2014",
              chalk.red("\u2717"),
            ];
          }

          const expiry = status.timeUntilExpiry ?? "\u2014";
          const isExpiringSoon =
            status.expiresAt != null &&
            status.expiresAt - Date.now() < 60 * 60 * 1000 &&
            status.expiresAt > Date.now();

          const expiryDisplay = isExpiringSoon
            ? chalk.yellow(expiry)
            : chalk.green(expiry);

          return [
            name,
            status.subscriptionType ?? "\u2014",
            expiryDisplay,
            status.rateLimitTier ?? "\u2014",
            chalk.green("\u2713"),
          ];
        });

        console.log();
        printAuthTable(headers, rows, widths);
        console.log();
      })
    );

  // clerk auth refresh <name>
  auth
    .command("refresh <name>")
    .description("Force re-login to refresh OAuth tokens for an agent")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          console.error(
            chalk.gray(
              `  Available agents: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        console.log(chalk.bold(`\nRefreshing auth for agent: ${name}\n`));
        const result = refreshAgent(name, agentDir);

        if (result.success) {
          console.log(chalk.green(`\nAgent "${name}" refreshed successfully.\n`));
        } else {
          console.error(chalk.red(`\nFailed to refresh agent "${name}".\n`));
          process.exit(1);
        }
      })
    );
}
