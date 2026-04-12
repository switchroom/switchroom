import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { resolveAgentsDir, loadConfig } from "../config/loader.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import { scaffoldAgent, reconcileAgent } from "../agents/scaffold.js";
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
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const statuses = getAllAgentStatuses(config);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ agents: [] }));
          } else {
            console.log(chalk.yellow("No agents defined in clerk.yaml"));
          }
          return;
        }

        if (opts.json) {
          const data = agentNames.map((name) => {
            const agentConfig = config.agents[name];
            const status = statuses[name];
            return {
              name,
              status: status?.active ?? "unknown",
              uptime: formatUptime(status?.uptime ?? null),
              template: agentConfig.template ?? "default",
              topic_name: agentConfig.topic_name,
              topic_emoji: agentConfig.topic_emoji,
            };
          });
          console.log(JSON.stringify({ agents: data }, null, 2));
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
            agentConfig.template ?? "default",
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
        scaffoldAgent(
          name,
          agentConfig,
          agentsDir,
          config.telegram,
          config,
          undefined,
          getConfigPath(program),
        );

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

  // clerk agent reconcile <name|all>
  agent
    .command("reconcile <name>")
    .description(
      "Re-apply clerk.yaml to an existing agent (rewrites .mcp.json + settings.json + start.sh without touching CLAUDE.md/SOUL.md)"
    )
    .option("--restart", "Restart the agent after reconciling")
    .option(
      "--force-claude-md",
      "Also re-render CLAUDE.md from the template (overwrites user customizations — use after a template fix)"
    )
    .action(
      withConfigError(async (name: string, opts: { restart?: boolean; forceClaudeMd?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const configPath = getConfigPath(program);

        const names = name === "all" ? Object.keys(config.agents) : [name];
        let totalChanges = 0;
        let agentsTouched = 0;

        for (const n of names) {
          const agentConfig = config.agents[n];
          if (!agentConfig) {
            console.error(
              chalk.red(`Agent "${n}" is not defined in clerk.yaml`)
            );
            continue;
          }
          try {
            const result = reconcileAgent(
              n,
              agentConfig,
              agentsDir,
              config.telegram,
              config,
              configPath,
              { forceClaudeMd: opts.forceClaudeMd },
            );
            if (result.changes.length === 0) {
              console.log(chalk.gray(`  ${n}: already in sync`));
            } else {
              agentsTouched++;
              totalChanges += result.changes.length;
              console.log(chalk.green(`  ${n}: updated`));
              for (const f of result.changes) {
                console.log(chalk.gray(`    - ${f}`));
              }
            }

            if (opts.restart && result.changes.length > 0) {
              try {
                restartAgent(n);
                console.log(chalk.green(`  ${n}: restarted`));
              } catch (err) {
                console.error(
                  chalk.red(`  ${n}: restart failed: ${(err as Error).message}`)
                );
              }
            }
          } catch (err) {
            console.error(
              chalk.red(`  ${n}: ${(err as Error).message}`)
            );
          }
        }

        if (totalChanges === 0 && agentsTouched === 0) {
          console.log(chalk.gray("\nNothing to do."));
        } else {
          console.log(
            chalk.bold(
              `\nReconciled ${agentsTouched} agent(s), ${totalChanges} file(s) changed.`
            )
          );
          if (!opts.restart) {
            console.log(
              chalk.gray(
                "  Tip: pass --restart to apply changes immediately, or run `clerk agent restart <name>`."
              )
            );
          }
        }
      })
    );

  // clerk agent grant <name> <tool>
  agent
    .command("grant <name> <tool>")
    .description(
      "Add a tool name (or 'all') to an agent's tools.allow in clerk.yaml, then reconcile"
    )
    .option("--no-restart", "Skip restarting the agent after granting")
    .action(
      withConfigError(async (name: string, tool: string, opts: { restart?: boolean }) => {
        const configPath = getConfigPath(program);
        if (!existsSync(configPath)) {
          console.error(chalk.red(`clerk.yaml not found at ${configPath}`));
          process.exit(1);
        }

        // Mutate the YAML in place, preserving comments where possible
        const raw = readFileSync(configPath, "utf-8");
        const doc = YAML.parseDocument(raw);
        const agents = doc.get("agents") as YAML.YAMLMap | null;
        if (!agents || !agents.has(name)) {
          console.error(chalk.red(`Agent "${name}" is not defined in clerk.yaml`));
          process.exit(1);
        }
        const agentNode = agents.get(name) as YAML.YAMLMap;

        let tools = agentNode.get("tools") as YAML.YAMLMap | null;
        if (!tools) {
          tools = new YAML.YAMLMap();
          agentNode.set("tools", tools);
        }
        let allow = tools.get("allow") as YAML.YAMLSeq | null;
        if (!allow) {
          allow = new YAML.YAMLSeq();
          tools.set("allow", allow);
        }
        const existingAllow = (allow.toJSON() as string[]) ?? [];
        if (existingAllow.includes(tool)) {
          console.log(chalk.gray(`  ${name}: ${tool} already allowed`));
        } else {
          allow.add(tool);
          writeFileSync(configPath, doc.toString(), "utf-8");
          console.log(chalk.green(`  ${name}: granted ${tool}`));
        }

        // Reload + reconcile
        const config = loadConfig(configPath);
        const agentsDir = resolveAgentsDir(config);
        const result = reconcileAgent(
          name,
          config.agents[name],
          agentsDir,
          config.telegram,
          config,
          configPath,
        );
        if (result.changes.length > 0) {
          console.log(chalk.green(`  ${name}: reconciled (${result.changes.length} file(s))`));
          if (opts.restart !== false) {
            try {
              restartAgent(name);
              console.log(chalk.green(`  ${name}: restarted`));
            } catch (err) {
              console.error(chalk.red(`  ${name}: restart failed: ${(err as Error).message}`));
            }
          }
        } else {
          console.log(chalk.gray(`  ${name}: already in sync`));
        }
      })
    );

  // clerk agent dangerous <name>
  agent
    .command("dangerous <name>")
    .description(
      "Enable full tool access for an agent (sets tools.allow: [all] in clerk.yaml). Reconciles + restarts."
    )
    .option("--off", "Disable: clear tools.allow")
    .option("--no-restart", "Skip restarting the agent")
    .action(
      withConfigError(async (name: string, opts: { off?: boolean; restart?: boolean }) => {
        const configPath = getConfigPath(program);
        if (!existsSync(configPath)) {
          console.error(chalk.red(`clerk.yaml not found at ${configPath}`));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const doc = YAML.parseDocument(raw);
        const agents = doc.get("agents") as YAML.YAMLMap | null;
        if (!agents || !agents.has(name)) {
          console.error(chalk.red(`Agent "${name}" is not defined in clerk.yaml`));
          process.exit(1);
        }
        const agentNode = agents.get(name) as YAML.YAMLMap;

        if (opts.off) {
          const tools = agentNode.get("tools") as YAML.YAMLMap | null;
          if (tools && tools.has("allow")) {
            tools.set("allow", new YAML.YAMLSeq());
            writeFileSync(configPath, doc.toString(), "utf-8");
            console.log(chalk.yellow(`  ${name}: dangerous mode OFF (tools.allow cleared)`));
          } else {
            console.log(chalk.gray(`  ${name}: dangerous mode was already off`));
          }
        } else {
          let tools = agentNode.get("tools") as YAML.YAMLMap | null;
          if (!tools) {
            tools = new YAML.YAMLMap();
            agentNode.set("tools", tools);
          }
          const allowSeq = new YAML.YAMLSeq();
          allowSeq.add("all");
          tools.set("allow", allowSeq);
          writeFileSync(configPath, doc.toString(), "utf-8");
          console.log(chalk.red(`  ${name}: dangerous mode ON — every built-in tool pre-approved`));
          console.log(chalk.gray(`    (tools.allow: [all] expands to Bash, Read, Write, Edit, WebFetch, ...)`));
        }

        // Reload + reconcile
        const config = loadConfig(configPath);
        const agentsDir = resolveAgentsDir(config);
        const result = reconcileAgent(
          name,
          config.agents[name],
          agentsDir,
          config.telegram,
          config,
          configPath,
        );
        if (result.changes.length > 0) {
          console.log(chalk.green(`  ${name}: reconciled (${result.changes.length} file(s))`));
          if (opts.restart !== false) {
            try {
              restartAgent(name);
              console.log(chalk.green(`  ${name}: restarted`));
            } catch (err) {
              console.error(chalk.red(`  ${name}: restart failed: ${(err as Error).message}`));
            }
          }
        } else {
          console.log(chalk.gray(`  ${name}: already in sync`));
        }
      })
    );

  // clerk agent permissions <name>
  agent
    .command("permissions <name>")
    .description("Show the current permissions.allow list for an agent")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const settingsPath = resolve(
          agentsDir,
          name,
          ".claude",
          "settings.json",
        );
        if (!existsSync(settingsPath)) {
          console.error(
            chalk.red(`Agent "${name}" not found at ${settingsPath}`)
          );
          process.exit(1);
        }
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const allow: string[] = settings.permissions?.allow ?? [];
        const deny: string[] = settings.permissions?.deny ?? [];
        const defaultMode: string | undefined = settings.permissions?.defaultMode;

        console.log(chalk.bold(`\nPermissions for ${name}\n`));
        if (defaultMode) {
          console.log(chalk.cyan(`  defaultMode: ${defaultMode}`));
        }
        console.log(chalk.bold(`\n  allow (${allow.length})`));
        for (const t of allow) console.log(chalk.green(`    + ${t}`));
        if (deny.length > 0) {
          console.log(chalk.bold(`\n  deny (${deny.length})`));
          for (const t of deny) console.log(chalk.red(`    - ${t}`));
        }
        console.log();
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
