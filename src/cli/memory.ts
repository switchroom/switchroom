import type { Command } from "commander";
import chalk from "chalk";
import { getCollectionForAgent, isStrictIsolation } from "../memory/hindsight.js";
import { searchMemory, getMemoryStats, reflectAcrossAgents } from "../memory/search.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import {
  isDockerAvailable,
  isHindsightRunning,
  isHindsightContainerExists,
  startHindsight,
  stopHindsight,
  getHindsightStatus,
  generateHindsightComposeSnippet,
  pickHindsightPorts,
  HINDSIGHT_DEFAULT_API_PORT,
} from "../setup/hindsight.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Hindsight memory operations");

  // switchroom memory search <query>
  memory
    .command("search <query>")
    .description("Search agent memories via Hindsight")
    .option("-a, --agent <name>", "Search a specific agent's collection")
    .action(
      withConfigError(async (query: string, opts: { agent?: string }) => {
        const config = getConfig(program);

        if (opts.agent) {
          if (!config.agents[opts.agent]) {
            console.error(chalk.red(`Agent "${opts.agent}" is not defined in switchroom.yaml`));
            process.exit(1);
          }
          const collection = getCollectionForAgent(opts.agent, config);
          console.log(chalk.bold(`\nSearch: ${opts.agent} (collection: ${collection})\n`));
          console.log(chalk.gray(`  $ ${searchMemory(query, collection)}`));
          console.log();
          return;
        }

        // Search all non-strict collections
        const agentNames = Object.keys(config.agents);
        console.log(chalk.bold(`\nSearching all eligible collections:\n`));

        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          if (isStrictIsolation(name, config)) {
            console.log(chalk.gray(`  ${name} (${collection}) — skipped (strict isolation)`));
            continue;
          }
          console.log(chalk.cyan(`  ${name} (${collection}):`));
          console.log(chalk.gray(`    $ ${searchMemory(query, collection)}`));
        }
        console.log();
      }),
    );

  // switchroom memory stats
  memory
    .command("stats")
    .description("List agents with their collection names and isolation mode")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          return;
        }

        const headers = ["Agent", "Collection", "Isolation", "Auto-recall"];
        const widths = [20, 20, 12, 12];

        const headerLine = headers
          .map((h, i) => chalk.bold(h.padEnd(widths[i])))
          .join("  ");
        console.log(`\n  ${headerLine}`);

        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          const isolation = isStrictIsolation(name, config) ? "strict" : "default";
          const autoRecall = config.agents[name].memory?.auto_recall ?? true;

          const row = [
            name.padEnd(widths[0]),
            collection.padEnd(widths[1]),
            isolation.padEnd(widths[2]),
            (autoRecall ? "yes" : "no").padEnd(widths[3]),
          ].join("  ");
          console.log(`  ${row}`);
        }

        console.log();

        // Print stats commands
        console.log(chalk.bold("  Hindsight CLI commands:\n"));
        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          console.log(chalk.gray(`    $ ${getMemoryStats(collection)}`));
        }
        console.log();
      }),
    );

  // switchroom memory reflect
  memory
    .command("reflect")
    .description("Show cross-agent reflection plan")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const { eligible, excluded, commands } = reflectAcrossAgents(config);

        console.log(chalk.bold("\nCross-agent reflection plan\n"));

        if (eligible.length > 0) {
          console.log(chalk.green("  Eligible collections:"));
          for (const { agent, collection } of eligible) {
            console.log(chalk.white(`    ${agent} -> ${collection}`));
          }
        }

        if (excluded.length > 0) {
          console.log(chalk.red("\n  Excluded (strict isolation):"));
          for (const { agent, collection } of excluded) {
            console.log(chalk.gray(`    ${agent} -> ${collection}`));
          }
        }

        if (commands.length > 0) {
          console.log(chalk.bold("\n  Hindsight CLI commands:\n"));
          for (const cmd of commands) {
            console.log(chalk.gray(`    $ ${cmd}`));
          }
        } else {
          console.log(chalk.yellow("\n  No eligible collections for reflection."));
        }
        console.log();
      }),
    );

  // switchroom memory setup
  memory
    .command("setup")
    .description("Manage the Hindsight Docker container")
    .option("--stop", "Stop and remove the Hindsight container")
    .option("--status", "Show Hindsight container status")
    .option("--provider <provider>", "LLM provider (ollama, openai, anthropic)")
    .action(async (opts: { stop?: boolean; status?: boolean; provider?: string }) => {
      if (opts.status) {
        if (!isDockerAvailable()) {
          console.log(chalk.red("  Docker is not available."));
          process.exit(1);
        }
        const status = getHindsightStatus();
        if (status) {
          console.log(chalk.bold("\n  Hindsight container status:"));
          console.log(`  ${chalk.cyan("switchroom-hindsight")}: ${status}\n`);
        } else {
          console.log(chalk.yellow("\n  Hindsight container not found.\n"));
          console.log(chalk.gray("  Run 'switchroom memory setup' to start it."));
        }
        return;
      }

      if (opts.stop) {
        if (!isDockerAvailable()) {
          console.log(chalk.red("  Docker is not available."));
          process.exit(1);
        }
        if (!isHindsightContainerExists()) {
          console.log(chalk.yellow("  No switchroom-hindsight container found."));
          return;
        }
        console.log(chalk.gray("  Stopping switchroom-hindsight..."));
        stopHindsight();
        console.log(chalk.green("  Hindsight container stopped and removed."));
        return;
      }

      // Default: start the container
      if (!isDockerAvailable()) {
        console.log(chalk.red("\n  Docker is not available."));
        console.log(chalk.gray("  Install Docker: https://docs.docker.com/get-docker/\n"));
        process.exit(1);
      }

      if (isHindsightRunning()) {
        console.log(chalk.green("\n  Hindsight container is already running (switchroom-hindsight).\n"));
        return;
      }

      if (isHindsightContainerExists()) {
        console.log(chalk.gray("  Removing stopped switchroom-hindsight container..."));
        stopHindsight();
      }

      // Pick host ports — try upstream defaults first, fall back to 18888/19999
      // if anything is already bound on 8888/9999.
      let ports: { apiPort: number; uiPort: number };
      try {
        ports = await pickHindsightPorts();
      } catch (err) {
        console.error(chalk.red(`\n  ${(err as Error).message}\n`));
        process.exit(1);
      }
      if (ports.apiPort !== HINDSIGHT_DEFAULT_API_PORT) {
        console.log(
          chalk.yellow(
            `  Port ${HINDSIGHT_DEFAULT_API_PORT} is already in use; ` +
            `using ${ports.apiPort}/${ports.uiPort} instead.`
          )
        );
      }

      // Resolve OpenAI key from vault if available, falling back to env
      let apiKey: string | undefined = process.env.OPENAI_API_KEY;
      const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
      const { resolveStatePath } = await import("../config/paths.js");
      const vaultPath = resolveStatePath("vault.enc");
      if (!apiKey && passphrase && existsSync(vaultPath)) {
        try {
          const { getSecret } = await import("../vault/vault.js");
          const fromVault = getSecret(passphrase, vaultPath, "openai-api-key");
          if (fromVault) apiKey = fromVault;
        } catch { /* ignore — fall through to provider default */ }
      }

      const provider = opts.provider ?? (apiKey ? "openai" : undefined);

      console.log(chalk.gray("  Starting Hindsight Docker container..."));
      try {
        startHindsight(provider, apiKey, ports);
        console.log(chalk.green(`\n  Hindsight container started (switchroom-hindsight) on port ${ports.apiPort}.\n`));
      } catch (err) {
        console.error(chalk.red(`\n  Failed to start Hindsight: ${(err as Error).message}\n`));
        process.exit(1);
      }

      // Update switchroom.yaml with the chosen URL so agents pick it up
      const url = `http://127.0.0.1:${ports.apiPort}/mcp/`;
      const configPath = getConfigPath(program);
      try {
        if (existsSync(configPath)) {
          const raw = readFileSync(configPath, "utf-8");
          const doc = YAML.parseDocument(raw);
          if (!doc.has("memory")) {
            doc.set("memory", { backend: "hindsight", shared_collection: "shared", config: { provider: "openai", url } });
          } else {
            const memNode = doc.get("memory") as YAML.YAMLMap;
            if (!memNode.has("config")) {
              memNode.set("config", { provider: provider ?? "openai", url });
            } else {
              const configNode = memNode.get("config") as YAML.YAMLMap;
              configNode.set("url", url);
              if (provider && !configNode.has("provider")) {
                configNode.set("provider", provider);
              }
            }
          }
          writeFileSync(configPath, doc.toString(), "utf-8");
          console.log(chalk.gray(`  Updated ${configPath} with memory.config.url = ${url}`));
          console.log(
            chalk.gray(
              "  Run `switchroom agent reconcile all --restart` to apply this to existing agents."
            )
          );
        }
      } catch (err) {
        console.error(
          chalk.yellow(
            `  Note: could not auto-update switchroom.yaml: ${(err as Error).message}\n` +
            `  Add memory.config.url: ${url} manually.`
          )
        );
      }
    });

  // switchroom memory docker-compose
  memory
    .command("docker-compose")
    .description("Output a docker-compose snippet for Hindsight")
    .option("--provider <provider>", "LLM provider (ollama, openai, anthropic)")
    .action((opts: { provider?: string }) => {
      console.log(chalk.bold("\n# Add this to your docker-compose.yml:\n"));
      console.log(generateHindsightComposeSnippet(opts.provider));
      console.log();
    });
}
