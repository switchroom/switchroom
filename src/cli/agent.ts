import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { resolveAgentsDir } from "../config/loader.js";
import { withConfigError, getConfig } from "./helpers.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import {
  startAgent,
  stopAgent,
  restartAgent,
  getAgentStatus,
  getAllAgentStatuses,
  attachAgent,
  getAgentLogs,
} from "../agents/lifecycle.js";
import { generateUnit, installUnit, uninstallUnit } from "../agents/systemd.js";

function formatUptime(timestamp: string | null): string {
  if (!timestamp) return "\u2014";
  const start = new Date(timestamp).getTime();
  if (isNaN(start)) return "\u2014";
  const seconds = Math.floor((Date.now() - start) / 1000);
  if (seconds <= 0) return "\u2014";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "active":
      return chalk.green(status);
    case "stopped":
    case "inactive":
    case "dead":
      return chalk.red(status);
    case "failed":
      return chalk.red(status);
    default:
      return chalk.yellow(status);
  }
}

function printTable(
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

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage individual agents");

  // clerk agent list
  agent
    .command("list")
    .description("List all agents with their status")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const statuses = getAllAgentStatuses(config);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        const headers = ["Name", "Status", "Uptime", "Template", "Topic"];
        const widths = [16, 10, 12, 15, 20];

        const rows = agentNames.map((name) => {
          const agentConfig = config.agents[name];
          const status = statuses[name];
          const topicDisplay = [
            agentConfig.topic_name,
            agentConfig.topic_emoji,
          ]
            .filter(Boolean)
            .join(" ");

          return [
            name,
            statusColor(status?.active ?? "unknown"),
            formatUptime(status?.uptime ?? null),
            agentConfig.template,
            topicDisplay,
          ];
        });

        console.log();
        printTable(headers, rows, widths);
        console.log();
      })
    );

  // clerk agent create <name>
  agent
    .command("create <name>")
    .description("Scaffold a new agent directory")
    .option("-t, --template <template>", "Template to use", "default")
    .action(
      withConfigError(async (name: string, opts: { template: string }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const agentConfig = config.agents[name];

        if (!agentConfig) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          console.error(
            chalk.gray(
              `  Add it to the agents section first, or use one of: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        console.log(chalk.bold(`\nScaffolding agent: ${name}\n`));
        scaffoldAgent(name, agentConfig, agentsDir, config.telegram, config);

        // Also generate and install the systemd unit
        const agentDir = resolve(agentsDir, name);
        const useAutoaccept = agentConfig.use_clerk_plugin === true;
        const unitContent = generateUnit(name, agentDir, useAutoaccept);
        installUnit(name, unitContent);

        console.log(chalk.green(`  Agent "${name}" scaffolded at ${agentDir}`));
        console.log(chalk.green(`  Systemd unit installed: clerk-${name}.service`));
        console.log(chalk.gray(`\n  Start with: clerk agent start ${name}\n`));
      })
    );

  // clerk agent start <name|all>
  agent
    .command("start <name>")
    .description("Start an agent (or 'all' to start all agents)")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const names =
          name === "all" ? Object.keys(config.agents) : [name];

        for (const n of names) {
          if (!config.agents[n]) {
            console.error(chalk.red(`Agent "${n}" is not defined in clerk.yaml`));
            continue;
          }
          try {
            startAgent(n);
            console.log(chalk.green(`Started ${n}`));
          } catch (err) {
            console.error(
              chalk.red(`Failed to start ${n}: ${(err as Error).message}`)
            );
          }
        }
      })
    );

  // clerk agent stop <name|all>
  agent
    .command("stop <name>")
    .description("Stop an agent (or 'all' to stop all agents)")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const names =
          name === "all" ? Object.keys(config.agents) : [name];

        for (const n of names) {
          if (!config.agents[n]) {
            console.error(chalk.red(`Agent "${n}" is not defined in clerk.yaml`));
            continue;
          }
          try {
            stopAgent(n);
            console.log(chalk.green(`Stopped ${n}`));
          } catch (err) {
            console.error(
              chalk.red(`Failed to stop ${n}: ${(err as Error).message}`)
            );
          }
        }
      })
    );

  // clerk agent restart <name|all>
  agent
    .command("restart <name>")
    .description("Restart an agent (or 'all' to restart all agents)")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const names =
          name === "all" ? Object.keys(config.agents) : [name];

        for (const n of names) {
          if (!config.agents[n]) {
            console.error(chalk.red(`Agent "${n}" is not defined in clerk.yaml`));
            continue;
          }
          try {
            restartAgent(n);
            console.log(chalk.green(`Restarted ${n}`));
          } catch (err) {
            console.error(
              chalk.red(`Failed to restart ${n}: ${(err as Error).message}`)
            );
          }
        }
      })
    );

  // clerk agent attach <name>
  agent
    .command("attach <name>")
    .description("Attach to an agent's tmux session")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);

        if (!config.agents[name]) {
          console.error(chalk.red(`Agent "${name}" is not defined in clerk.yaml`));
          process.exit(1);
        }

        // attachAgent must exec (replace process), so this won't return on success
        attachAgent(name);
      })
    );

  // clerk agent logs <name>
  agent
    .command("logs <name>")
    .description("Show agent logs")
    .option("-f, --follow", "Follow log output")
    .action(
      withConfigError(async (name: string, opts: { follow?: boolean }) => {
        const config = getConfig(program);

        if (!config.agents[name]) {
          console.error(chalk.red(`Agent "${name}" is not defined in clerk.yaml`));
          process.exit(1);
        }

        getAgentLogs(name, opts.follow ?? false);
      })
    );

  // clerk agent destroy <name>
  agent
    .command("destroy <name>")
    .description("Remove an agent's directory and systemd unit")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(
      withConfigError(async (name: string, opts: { yes?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const agentDir = resolve(agentsDir, name);

        if (!opts.yes) {
          process.stdout.write(
            chalk.yellow(
              `Destroy agent "${name}"? This removes ${agentDir} and the systemd unit. [y/N] `
            )
          );
          const response = await new Promise<string>((resolve) => {
            process.stdin.setEncoding("utf-8");
            process.stdin.once("data", (data) => resolve(data.toString().trim()));
          });
          if (response.toLowerCase() !== "y") {
            console.log("Aborted.");
            return;
          }
        }

        // Stop the agent first
        try {
          stopAgent(name);
        } catch {
          // may already be stopped
        }

        // Remove systemd unit
        try {
          uninstallUnit(name);
          console.log(chalk.green(`  Removed systemd unit: clerk-${name}.service`));
        } catch (err) {
          console.error(
            chalk.red(`  Failed to remove unit: ${(err as Error).message}`)
          );
        }

        // Remove agent directory
        if (existsSync(agentDir)) {
          rmSync(agentDir, { recursive: true, force: true });
          console.log(chalk.green(`  Removed directory: ${agentDir}`));
        } else {
          console.log(chalk.gray(`  Directory not found: ${agentDir}`));
        }

        console.log(chalk.green(`\nAgent "${name}" destroyed.`));
      })
    );
}
