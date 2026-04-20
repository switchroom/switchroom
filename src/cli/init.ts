import type { Command } from "commander";
import chalk from "chalk";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveAgentsDir, findConfigFile, ConfigError } from "../config/loader.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import { installAllUnits } from "../agents/systemd.js";
import { captureEvent, captureException } from "../analytics/posthog.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize all agents: scaffold directories and install systemd units")
    .option(
      "--example <name>",
      "Copy an example config before initializing (e.g., 'switchroom' or 'minimal')"
    )
    .action(async (opts) => {
      try {
        const parentOpts = program.opts();

        // If --example is given, copy the example config into cwd
        if (opts.example) {
          if (!/^[a-z0-9_-]+$/.test(opts.example)) {
            console.error(
              chalk.red(`Invalid example name: ${opts.example} (must match /^[a-z0-9_-]+$/)`)
            );
            process.exit(1);
          }
          const exampleFile = resolve(
            import.meta.dirname,
            `../../examples/${opts.example}.yaml`
          );
          const dest = resolve(process.cwd(), "switchroom.yaml");

          if (!existsSync(exampleFile)) {
            console.error(
              chalk.red(`Example config not found: ${opts.example}.yaml`)
            );
            console.error(
              chalk.gray(
                `  Available examples: switchroom, minimal`
              )
            );
            process.exit(1);
          }

          if (existsSync(dest)) {
            console.error(
              chalk.yellow("switchroom.yaml already exists — skipping example copy")
            );
          } else {
            copyFileSync(exampleFile, dest);
            console.log(chalk.green(`Copied ${opts.example}.yaml -> switchroom.yaml`));
          }
        }

        const config = loadConfig(parentOpts.config);
        const switchroomConfigPath = parentOpts.config ?? findConfigFile();
        const agentsDir = resolveAgentsDir(config);
        const agentNames = Object.keys(config.agents);

        console.log(chalk.bold("\nInitializing switchroom agents...\n"));

        // Scaffold each agent
        let scaffolded = 0;
        for (const name of agentNames) {
          const agentConfig = config.agents[name];
          try {
            const result = scaffoldAgent(
              name,
              agentConfig,
              agentsDir,
              config.telegram,
              config,
              undefined,
              switchroomConfigPath,
            );
            const detail = result.created.length > 0
              ? `${result.created.length} files created`
              : "up to date";
            console.log(chalk.green(`  + ${name}`) + chalk.gray(` (${agentConfig.extends ?? "default"}) — ${detail}`));
            scaffolded++;
          } catch (err) {
            console.error(
              chalk.red(`  x ${name}: ${(err as Error).message}`)
            );
          }
        }

        // Generate and install systemd units
        console.log(chalk.bold("\nInstalling systemd units...\n"));
        try {
          installAllUnits(config);
          for (const name of agentNames) {
            console.log(chalk.green(`  + switchroom-${name}.service`));
          }
        } catch (err) {
          console.error(
            chalk.red(`  Failed to install units: ${(err as Error).message}`)
          );
        }

        // Summary
        console.log(
          chalk.bold(`\nDone.`) +
            ` Scaffolded ${scaffolded}/${agentNames.length} agents, systemd units installed.`
        );
        console.log(
          chalk.gray(`  Agents dir: ${agentsDir}`)
        );
        console.log(
          chalk.gray(`  Start all:  switchroom agent start all\n`)
        );

        await captureEvent("init_completed", {
          agents_total: agentNames.length,
          agents_scaffolded: scaffolded,
          example: opts.example ?? null,
        });
      } catch (err) {
        await captureException(err, { action: "init" });
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
    });
}
