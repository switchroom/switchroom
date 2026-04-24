import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { resolveAgentsDir } from "../config/loader.js";
import {
  loginAgent,
  getAllAuthStatuses,
  refreshAgent,
  submitAuthCode,
  cancelAuthSession,
  addAccountStart,
  listAccounts,
  switchAccount,
  removeAccount,
  startAuthSession,
} from "../auth/manager.js";
import { getAgentStatus, restartAgent } from "../agents/lifecycle.js";
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

function requireKnownAgent(config: ReturnType<typeof getConfig>, name: string): void {
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
}

function rejectAll(name: string, verb: string): void {
  if (name !== "all") return;
  console.error(chalk.red(`switchroom auth ${verb} all is not supported.`));
  console.error(
    chalk.gray("  Start one auth flow at a time so you can paste the browser code back in.")
  );
  process.exit(1);
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage OAuth authentication per agent");

  // switchroom auth login <name>
  auth
    .command("login <name>")
    .description("Start Claude OAuth token setup for an agent")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        rejectAll(name, "login");
        requireKnownAgent(config, name);

        const agentDir = resolve(agentsDir, name);
        const result = loginAgent(name, agentDir);

        console.log();
        for (const line of result.instructions) {
          console.log(line);
        }
        console.log();
      })
    );

  // switchroom auth reauth <name> [--slot <slot>]
  auth
    .command("reauth <name>")
    .description("Start a fresh Claude OAuth token flow and replace the current one")
    .option("--slot <slot>", "Re-auth a specific slot (defaults to active)")
    .action(
      withConfigError(async (name: string, opts: { slot?: string }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        rejectAll(name, "reauth");
        requireKnownAgent(config, name);

        const agentDir = resolve(agentsDir, name);
        const result = opts.slot
          ? startAuthSession(name, agentDir, { force: true, slot: opts.slot })
          : refreshAgent(name, agentDir);

        console.log();
        for (const line of result.instructions) {
          console.log(line);
        }
        console.log();
      })
    );

  // switchroom auth refresh <name> (back-compat alias)
  auth
    .command("refresh <name>")
    .description("Alias for reauth")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        rejectAll(name, "refresh");
        requireKnownAgent(config, name);

        const agentDir = resolve(agentsDir, name);
        const result = refreshAgent(name, agentDir);

        console.log();
        for (const line of result.instructions) {
          console.log(line);
        }
        console.log();
      })
    );

  // switchroom auth code <name> <code> [--slot <slot>] [--json]
  auth
    .command("code <name> <code>")
    .description("Finish a pending Claude OAuth token flow by pasting the browser code")
    .option("--slot <slot>", "Target slot for the pending flow (defaults to pending)")
    .option("--json", "Output structured JSON result (includes AuthCodeOutcome)")
    .action(
      withConfigError(async (name: string, code: string, opts: { slot?: string; json?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        requireKnownAgent(config, name);
        const agentDir = resolve(agentsDir, name);
        const result = submitAuthCode(name, agentDir, code, opts.slot);

        if (opts.json) {
          console.log(JSON.stringify({
            completed: result.completed,
            tokenSaved: result.tokenSaved,
            tokenPath: result.tokenPath ?? null,
            outcome: result.outcome ?? null,
            instructions: result.instructions,
          }));
          // Still attempt restart even in JSON mode so callers get the
          // full effect, but don't surface restart output to stdout.
          if (result.completed && result.tokenSaved) {
            try {
              const status = getAgentStatus(name);
              if (status.active === "active" || status.active === "running") {
                restartAgent(name);
              }
            } catch {
              // swallow — caller reads the JSON, not this
            }
          }
          return;
        }

        console.log();
        for (const line of result.instructions) {
          console.log(line);
        }

        if (result.completed && result.tokenSaved) {
          try {
            const status = getAgentStatus(name);
            if (status.active === "active" || status.active === "running") {
              restartAgent(name);
              console.log(`Restarted ${name} to pick up the new Claude account.`);
            } else {
              console.log(`Agent ${name} is not running — start or restart it when ready.`);
            }
          } catch (err) {
            console.log(
              `Saved token, but could not restart ${name}: ${(err as Error).message}`
            );
          }
        }

        console.log();
      })
    );

  // switchroom auth cancel <name> [--slot <slot>]
  auth
    .command("cancel <name>")
    .description("Cancel a pending Claude OAuth token flow")
    .option("--slot <slot>", "Target slot (defaults to pending)")
    .action(
      withConfigError(async (name: string, opts: { slot?: string }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        requireKnownAgent(config, name);
        const agentDir = resolve(agentsDir, name);
        const result = cancelAuthSession(name, agentDir, opts.slot);

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
              auth_source: status.source ?? null,
              pending_auth: status.pendingAuth ?? false,
              subscription_type: status.subscriptionType ?? null,
              expires_in: status.timeUntilExpiry ?? null,
              rate_limit_tier: status.rateLimitTier ?? null,
            };
          });
          console.log(JSON.stringify({ agents: data }, null, 2));
          return;
        }

        const headers = ["Name", "Source", "Subscription", "Expires In", "Rate Limit", "Status"];
        const widths = [16, 12, 14, 12, 26, 10];

        const rows = agentNames.map((name) => {
          const status = statuses[name];
          const source = status.source ?? (status.pendingAuth ? "pending" : "—");

          if (!status.authenticated) {
            return [
              name,
              source,
              "—",
              "—",
              "—",
              status.pendingAuth ? chalk.yellow("pending") : chalk.red("✗"),
            ];
          }

          const expiry = status.timeUntilExpiry ?? "—";
          const isExpiringSoon =
            status.expiresAt != null &&
            status.expiresAt - Date.now() < 60 * 60 * 1000 &&
            status.expiresAt > Date.now();

          const expiryDisplay = isExpiringSoon
            ? chalk.yellow(expiry)
            : expiry === "—"
              ? expiry
              : chalk.green(expiry);

          return [
            name,
            source,
            status.subscriptionType ?? "—",
            expiryDisplay,
            status.rateLimitTier ?? "—",
            chalk.green("✓"),
          ];
        });

        console.log();
        printAuthTable(headers, rows, widths);
        console.log();
      })
    );

  // ── Multi-account subcommands ────────────────────────────────────────

  // switchroom auth add <name> [--slot <slot>]
  auth
    .command("add <name>")
    .description("Start OAuth flow into a new account slot (fallback pool)")
    .option("--slot <slot>", "Slot name (auto-generated if omitted)")
    .action(
      withConfigError(async (name: string, opts: { slot?: string }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        rejectAll(name, "add");
        requireKnownAgent(config, name);

        const agentDir = resolve(agentsDir, name);
        const result = addAccountStart(name, agentDir, opts.slot);

        console.log();
        console.log(`Target slot: ${result.slot}`);
        for (const line of result.instructions) {
          console.log(line);
        }
        console.log(
          `Finish with: switchroom auth code ${name} <browser-code> --slot ${result.slot}`,
        );
        console.log();
      }),
    );

  // switchroom auth use <name> <slot>
  auth
    .command("use <name> <slot>")
    .description("Switch the active account slot for an agent")
    .action(
      withConfigError(async (name: string, slot: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        rejectAll(name, "use");
        requireKnownAgent(config, name);
        const agentDir = resolve(agentsDir, name);
        try {
          const { slot: active } = switchAccount(name, agentDir, slot);
          console.log(`Active slot for ${name} is now: ${active}`);
          console.log(`Restart ${name} to pick up the new account.`);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }),
    );

  // switchroom auth list <name> [--json]
  auth
    .command("list <name>")
    .description("List all account slots for an agent")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (name: string, opts: { json?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        rejectAll(name, "list");
        requireKnownAgent(config, name);
        const agentDir = resolve(agentsDir, name);
        const slots = listAccounts(name, agentDir);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                agent: name,
                slots: slots.map((s) => ({
                  slot: s.slot,
                  active: s.active,
                  health: s.health,
                  expires_at: s.expiresAt ?? null,
                  quota_exhausted_until: s.quotaExhaustedUntil ?? null,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }

        if (slots.length === 0) {
          console.log(
            chalk.yellow(
              `No account slots found for ${name}. Run 'switchroom auth login ${name}' or 'switchroom auth add ${name}'.`,
            ),
          );
          return;
        }
        const headers = ["Slot", "Active", "Health", "Notes"];
        const widths = [16, 8, 18, 30];
        const rows = slots.map((s) => {
          let notes = "";
          if (s.health === "quota-exhausted" && s.quotaExhaustedUntil) {
            const mins = Math.max(
              0,
              Math.round((s.quotaExhaustedUntil - Date.now()) / 60_000),
            );
            notes = `resets in ~${mins}m`;
          } else if (s.health === "expired") {
            notes = "run auth reauth";
          }
          return [
            s.slot,
            s.active ? chalk.green("✓") : "",
            s.health,
            notes,
          ];
        });
        console.log();
        printAuthTable(headers, rows, widths);
        console.log();
      }),
    );

  // switchroom auth rm <name> <slot>
  auth
    .command("rm <name> <slot>")
    .description("Delete an account slot")
    .action(
      withConfigError(async (name: string, slot: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        rejectAll(name, "rm");
        requireKnownAgent(config, name);
        const agentDir = resolve(agentsDir, name);
        try {
          removeAccount(name, agentDir, slot);
          console.log(`Removed slot "${slot}" from ${name}.`);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }),
    );
}
