/**
 * CLI: vault grant management commands (issue #225)
 *
 * Subcommands (registered under `switchroom vault`):
 *
 *   vault grant <agent> [--keys X,Y] [--duration 30d] [--description "..."]
 *     Mint a new capability token for the given agent. Prints the token and
 *     the path it was written to (~/.switchroom/agents/<agent>/.vault-token).
 *
 *   vault grants [--agent X]
 *     List active (non-revoked) grants, formatted as a table.
 *     Pass --agent to filter to one agent.
 *
 *   vault revoke <id>
 *     Revoke a grant by ID. Prints confirmation.
 *
 * These commands talk to the running vault-broker daemon via the broker client.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config/loader.js";
import { resolvePath } from "../config/loader.js";
import {
  mintGrantViaBroker,
  listGrantsViaBroker,
  revokeGrantViaBroker,
  type BrokerClientOpts,
} from "../vault/broker/client.js";
import type { GrantMeta } from "../vault/broker/protocol.js";

// ─── Duration parsing ─────────────────────────────────────────────────────────

/**
 * Parse a human-readable duration string into seconds.
 * Supports: 30d, 7d, 12h, 30m, 3600s
 * Returns null if the string is "0", "never", "none", or not provided.
 * Throws on unrecognised format.
 */
function parseDuration(raw: string): number | null {
  const lower = raw.toLowerCase().trim();
  if (lower === "0" || lower === "never" || lower === "none") return null;

  const m = lower.match(/^(\d+(?:\.\d+)?)(d|h|m|s)$/);
  if (!m) {
    throw new Error(
      `Unrecognised duration '${raw}'. Use <N>d (days), <N>h (hours), <N>m (minutes), <N>s (seconds), or 'never'.`,
    );
  }
  const n = parseFloat(m[1]);
  const unit = m[2];
  switch (unit) {
    case "d": return Math.round(n * 86400);
    case "h": return Math.round(n * 3600);
    case "m": return Math.round(n * 60);
    case "s": return Math.round(n);
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBrokerOpts(configPath?: string): BrokerClientOpts {
  try {
    const config = loadConfig(configPath);
    const socket = resolvePath(
      config.vault?.broker?.socket ?? "~/.switchroom/vault-broker.sock",
    );
    return { socket };
  } catch {
    return { socket: resolvePath("~/.switchroom/vault-broker.sock") };
  }
}

function formatDate(unixSec: number | null): string {
  if (unixSec === null) return chalk.dim("never");
  const d = new Date(unixSec * 1000);
  return d.toLocaleString();
}

function formatGrantTable(grants: GrantMeta[]): void {
  if (grants.length === 0) {
    console.log(chalk.dim("No active grants."));
    return;
  }

  // Column widths
  const idLen = Math.max(4, ...grants.map((g) => g.id.length));
  const agentLen = Math.max(5, ...grants.map((g) => g.agent_slug.length));
  const keysLen = Math.max(4, ...grants.map((g) => g.key_allow.join(", ").length));

  const header =
    chalk.bold("ID".padEnd(idLen)) +
    "  " +
    chalk.bold("AGENT".padEnd(agentLen)) +
    "  " +
    chalk.bold("KEYS".padEnd(keysLen)) +
    "  " +
    chalk.bold("EXPIRES") +
    "  " +
    chalk.bold("DESCRIPTION");

  console.log(header);
  console.log(chalk.dim("─".repeat(header.replace(/\x1b\[[0-9;]*m/g, "").length)));

  for (const g of grants) {
    const keys = g.key_allow.join(", ");
    const expires = formatDate(g.expires_at);
    const desc = g.description ?? chalk.dim("—");
    console.log(
      g.id.padEnd(idLen) +
      "  " +
      g.agent_slug.padEnd(agentLen) +
      "  " +
      keys.padEnd(keysLen) +
      "  " +
      expires +
      "  " +
      desc,
    );
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerVaultGrantCommands(vault: Command, program: Command): void {

  // `vault grant <agent>` — mint a new capability token
  vault
    .command("grant <agent>")
    .description(
      "Mint a capability token for an agent (delegates to the broker)",
    )
    .option(
      "--keys <keys>",
      "Comma-separated list of vault key names the token may access",
    )
    .option(
      "--duration <duration>",
      "Token lifetime: 30d, 12h, 60m, never (default: never)",
      "never",
    )
    .option(
      "--description <text>",
      "Human-readable note for the audit log",
    )
    .action(
      async (
        agent: string,
        opts: { keys?: string; duration?: string; description?: string },
      ) => {
        const parentOpts = program.opts();
        const brokerOpts = getBrokerOpts(parentOpts.config);

        // Parse key list
        const keys: string[] = opts.keys
          ? opts.keys.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
          : [];

        if (keys.length === 0) {
          console.error(
            chalk.red(
              "Error: --keys is required. Specify at least one vault key name.",
            ),
          );
          process.exit(1);
        }

        // Parse duration
        let ttl_seconds: number | null;
        try {
          ttl_seconds = parseDuration(opts.duration ?? "never");
        } catch (err) {
          console.error(chalk.red(`Error: ${(err as Error).message}`));
          process.exit(1);
        }

        const result = await mintGrantViaBroker({
          ...brokerOpts,
          agent,
          keys,
          ttl_seconds,
          description: opts.description,
        });

        if (result.kind === "unreachable") {
          console.error(chalk.red(`Broker unreachable: ${result.msg}`));
          process.exit(1);
        }
        if (result.kind === "error") {
          console.error(chalk.red(`Failed to mint grant: ${result.msg}`));
          process.exit(1);
        }

        const tokenPath = join(
          homedir(),
          ".switchroom",
          "agents",
          agent,
          ".vault-token",
        );

        console.log(chalk.green(`✓ Grant minted`));
        console.log(chalk.bold("Token: ") + result.token);
        console.log(chalk.bold("Grant ID: ") + result.id);
        console.log(
          chalk.bold("Expires: ") +
            (result.expires_at
              ? new Date(result.expires_at * 1000).toLocaleString()
              : chalk.dim("never")),
        );
        console.log(chalk.bold("Token file: ") + tokenPath);
        console.log(
          chalk.dim(
            "\nThe token file was written to the agent directory (mode 0600).",
          ),
        );
      },
    );

  // `vault grants [--agent X]` — list active grants
  vault
    .command("grants")
    .description("List active capability grants (talks to the broker)")
    .option("--agent <agent>", "Filter by agent name")
    .action(async (opts: { agent?: string }) => {
      const parentOpts = program.opts();
      const brokerOpts = getBrokerOpts(parentOpts.config);

      const result = await listGrantsViaBroker(opts.agent, brokerOpts);

      if (result.kind === "unreachable") {
        console.error(chalk.red(`Broker unreachable: ${result.msg}`));
        process.exit(1);
      }
      if (result.kind === "error") {
        console.error(chalk.red(`Failed to list grants: ${result.msg}`));
        process.exit(1);
      }

      formatGrantTable(result.grants);
    });

  // `vault revoke <id>` — revoke a grant by ID
  vault
    .command("revoke <id>")
    .description("Revoke a capability grant by ID")
    .action(async (id: string) => {
      const parentOpts = program.opts();
      const brokerOpts = getBrokerOpts(parentOpts.config);

      const result = await revokeGrantViaBroker(id, brokerOpts);

      if (result.kind === "unreachable") {
        console.error(chalk.red(`Broker unreachable: ${result.msg}`));
        process.exit(1);
      }
      if (result.kind === "error") {
        console.error(chalk.red(`Failed to revoke grant: ${result.msg}`));
        process.exit(1);
      }

      if (!result.revoked) {
        console.error(chalk.yellow(`Grant '${id}' not found or already revoked.`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Grant '${id}' revoked.`));
      console.log(
        chalk.dim(
          "The token file was removed from the agent directory (best-effort).",
        ),
      );
    });
}
