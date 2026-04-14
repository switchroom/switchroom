import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { resolveAgentsDir } from "../config/loader.js";
import {
  loginAgent,
  getAuthStatus,
  getAllAuthStatuses,
  refreshAgent,
} from "../auth/manager.js";
import { withConfigError, getConfig } from "./helpers.js";

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

  // switchroom auth login <name|all>
  auth
    .command("login <name>")
    .description(
      "Show instructions for completing Claude Code onboarding for an agent"
    )
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (name === "all") {
          console.log(chalk.bold("\nAuth instructions for all agents:\n"));
          for (const agentName of Object.keys(config.agents)) {
            const agentDir = resolve(agentsDir, agentName);
            const result = loginAgent(agentName, agentDir);
            console.log(chalk.cyan(`--- ${agentName} ---`));
            for (const line of result.instructions) {
              console.log(`  ${line}`);
            }
            console.log();
          }
          return;
        }

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in switchroom.yaml`)
          );
          console.error(
            chalk.gray(
              `  Available agents: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        const result = loginAgent(name, agentDir);

        console.log();
        for (const line of result.instructions) {
          console.log(line);
        }
        console.log();
      })
    );

  // switchroom auth status
  auth
    .command("status")
    .description("Show authentication status for all agents")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const statuses = getAllAuthStatuses(config);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ agents: [] }));
          } else {
            console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          }
          return;
        }

        if (opts.json) {
          const data = agentNames.map((name) => {
            const status = statuses[name];
            return {
              name,
              authenticated: status.authenticated,
              subscription_type: status.subscriptionType ?? null,
              expires_in: status.timeUntilExpiry ?? null,
              rate_limit_tier: status.rateLimitTier ?? null,
            };
          });
          console.log(JSON.stringify({ agents: data }, null, 2));
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

  // switchroom auth refresh <name>
  auth
    .command("refresh <name>")
    .description("Show instructions for refreshing OAuth tokens for an agent")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in switchroom.yaml`)
          );
          console.error(
            chalk.gray(
              `  Available agents: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        const result = refreshAgent(name, agentDir);

        console.log();
        for (const line of result.instructions) {
          console.log(line);
        }
        console.log();
      })
    );
}
