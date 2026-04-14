import type { Command } from "commander";
import chalk from "chalk";
import { syncTopics, listTopics, resolveBotToken, TopicSyncError, findOrphanedTopics, cleanupOrphanedTopics } from "../telegram/topic-manager.js";
import { withConfigError, getConfig } from "./helpers.js";

function withTopicError(fn: (...args: any[]) => Promise<void>) {
  return withConfigError(async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof TopicSyncError) {
        console.error(chalk.red(`Topic sync error: ${err.message}`));
        if (err.agent) {
          console.error(chalk.gray(`  Agent: ${err.agent}`));
        }
        process.exit(1);
      }
      throw err;
    }
  });
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

export function registerTopicsCommand(program: Command): void {
  const topics = program
    .command("topics")
    .description("Manage Telegram forum topics for agents");

  // switchroom topics sync
  topics
    .command("sync")
    .description("Create forum topics for agents that don't have one yet")
    .action(
      withTopicError(async () => {
        const config = getConfig(program);

        // Warn about vault reference early
        resolveBotToken(config.telegram.bot_token);

        const agentNames = Object.keys(config.agents);
        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          return;
        }

        console.log(chalk.bold("\nSyncing forum topics...\n"));

        const results = await syncTopics(config);

        if (results.length === 0) {
          console.log(chalk.yellow("  No agents with topic_name found."));
          console.log();
          return;
        }

        const headers = ["Agent", "Topic", "ID", "Status"];
        const widths = [20, 20, 14, 10];

        const rows = results.map((r) => [
          r.agent,
          r.topic_name,
          String(r.topic_id),
          r.status === "created"
            ? chalk.green(r.status)
            : chalk.gray(r.status),
        ]);

        printTable(headers, rows, widths);

        const created = results.filter((r) => r.status === "created").length;
        const existing = results.filter((r) => r.status === "existing").length;
        console.log();
        console.log(
          chalk.gray(`  ${created} created, ${existing} already existed`)
        );
        console.log();
      })
    );

  // switchroom topics list
  topics
    .command("list")
    .description("List agent topic mappings")
    .action(
      withTopicError(async () => {
        const config = getConfig(program);

        const agentNames = Object.keys(config.agents);
        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          return;
        }

        const results = listTopics(config);

        if (results.length === 0) {
          console.log(chalk.yellow("  No agents with topic_name found."));
          return;
        }

        console.log();
        const headers = ["Agent", "Topic", "ID"];
        const widths = [20, 20, 14];

        const rows = results.map((r) => [
          r.agent,
          r.topic_name,
          r.topic_id !== null ? String(r.topic_id) : chalk.gray("(not synced)"),
        ]);

        printTable(headers, rows, widths);
        console.log();
      })
    );

  // switchroom topics cleanup
  topics
    .command("cleanup")
    .description("Close orphaned topics (in state but not in current config)")
    .action(
      withTopicError(async () => {
        const config = getConfig(program);

        const orphans = findOrphanedTopics(config);
        if (orphans.length === 0) {
          console.log(chalk.green("\n  No orphaned topics found.\n"));
          return;
        }

        console.log(chalk.bold(`\nCleaning up ${orphans.length} orphaned topic(s)...\n`));

        const results = await cleanupOrphanedTopics(config);

        const headers = ["Agent", "Topic ID", "Status"];
        const widths = [20, 14, 10];

        const rows = results.map((r) => [
          r.agent,
          String(r.topic_id),
          r.closed ? chalk.green("closed") : chalk.yellow("failed"),
        ]);

        printTable(headers, rows, widths);

        const closed = results.filter((r) => r.closed).length;
        console.log();
        console.log(
          chalk.gray(`  ${closed}/${results.length} orphaned topics closed and removed from state`)
        );
        console.log();
      })
    );
}
