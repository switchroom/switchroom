/**
 * `switchroom linear-agent setup <agent>` (#2298).
 *
 * Provisions an agent as a first-class Linear agent (app actor):
 *   1. Stores the already-obtained Linear OAuth app token in the vault
 *      under `linear/<agent>/token` (a `vault:` reference, never inline).
 *   2. Patches switchroom.yaml to add
 *      `agents.<agent>.channels.telegram.linear_agent = { enabled: true,
 *       token: "vault:linear/<agent>/token" }` (mirrors the
 *      `telegram enable webhook` verb's YAML-edit shape).
 *   3. Prints the webhook URL the operator must register in Linear and the
 *      OAuth authorize-URL hint block (the interactive browser dance can't
 *      run headless here, so it's emitted as instructions).
 *
 * Why `--token` rather than a full OAuth flow: the `actor=app` OAuth dance
 * requires a browser redirect (`/oauth/authorize` → Linear → callback). We
 * can't open a browser from a server CLI, so this verb takes the token the
 * operator obtained out-of-band (e.g. via Linear's developer settings or the
 * linear-agent-demo worker) and wires the rest. The authorize-URL hint block
 * documents the browser step for operators who haven't done it yet.
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";
import { getConfigPath, withConfigError } from "./helpers.js";
import { setLinearAgent, setLinearDefaultTeam } from "./telegram-yaml.js";
import { vaultPut } from "./telegram.js";

interface LinearAgentSetupOpts {
  agent: string;
  token: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  workspaceId?: string;
  webhookBase?: string;
  dryRun?: boolean;
}

export function registerLinearAgentCommand(program: Command): void {
  const linear = program
    .command("linear-agent")
    .description(
      "Install an agent into a Linear workspace as a first-class app actor (#2298) — @-mentionable, delegate-assignable, agent sessions wake it instantly.",
    );

  linear
    .command("setup")
    .description(
      "Provision <agent> as a Linear agent. Vault-stores the Linear OAuth app token (actor=app) under 'linear/<agent>/token' and enables the linear_agent block in switchroom.yaml. The OAuth browser authorize step is printed as instructions (it can't run headless); pass the already-obtained --token.",
    )
    .requiredOption("--agent <name>", "Agent name (must exist in switchroom.yaml)")
    .requiredOption(
      "--token <token>",
      "The Linear OAuth app token (actor=app), obtained out-of-band via the browser authorize step. Stored in the vault, never in switchroom.yaml.",
    )
    .option("--client-id <id>", "Linear OAuth app client id (for the printed authorize-URL hint).")
    .option("--client-secret <secret>", "Linear OAuth app client secret (informational — not stored by this verb).")
    .option("--redirect-uri <uri>", "OAuth redirect URI registered on the Linear app (for the authorize-URL hint).")
    .option("--workspace-id <id>", "Optional Linear workspace (organization) id to record in config.")
    .option(
      "--webhook-base <url>",
      "Base URL of the switchroom web server (e.g. https://hooks.switchroom.ai). Used to print the webhook URL to register in Linear. Defaults to a placeholder.",
    )
    .option("--dry-run", "Print the YAML diff + instructions without writing or vaulting anything")
    .action(
      withConfigError(async (opts: LinearAgentSetupOpts) => {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(opts.agent)) {
          fail(`--agent must be a lowercase agent slug (got '${opts.agent}').`);
        }
        if (!opts.token || opts.token.trim().length === 0) {
          fail("--token must be a non-empty Linear app token.");
        }

        const vaultKey = `linear/${opts.agent}/token`;
        if (!opts.dryRun) {
          await vaultPut(program, vaultKey, opts.token);
        } else {
          console.log(chalk.gray(`[dry-run] would store the Linear token in the vault as '${vaultKey}'`));
        }

        const path = getConfigPath(program);
        const before = readFileSync(path, "utf-8");
        let after: string;
        try {
          after = setLinearAgent(before, opts.agent, {
            token: `vault:${vaultKey}`,
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          });
        } catch (err) {
          fail((err as Error).message);
        }

        if (opts.dryRun) {
          console.log(chalk.bold(`[dry-run] would edit ${path}`));
          console.log(makeUnifiedDiff(before, after));
        } else {
          writeFileSync(path, after, "utf-8");
          console.log(chalk.green(`✓ Enabled linear-agent for agent '${opts.agent}'`));
          console.log(chalk.gray(`  Vault key: ${vaultKey}`));
          console.log(chalk.gray(`  Run 'switchroom agent restart ${opts.agent}' to pick up the change.`));
        }

        printLinearInstructions(opts, vaultKey);
      }),
    );

  linear
    .command("set-team")
    .description(
      "Set (or clear) the default Linear team captured issues file into for <agent>. Only needed when the workspace has multiple teams — a single-team workspace auto-resolves. Pass --clear to remove the default.",
    )
    .requiredOption("--agent <name>", "Agent name (must have a linear_agent block)")
    .option("--team <id>", "Linear team id new captured issues default to.")
    .option("--clear", "Remove the configured default team (revert to auto-resolve).")
    .action(
      withConfigError(async (opts: { agent: string; team?: string; clear?: boolean }) => {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(opts.agent)) {
          fail(`--agent must be a lowercase agent slug (got '${opts.agent}').`);
        }
        if (!opts.clear && (!opts.team || opts.team.trim().length === 0)) {
          fail("pass either --team <id> or --clear.");
        }

        const path = getConfigPath(program);
        const before = readFileSync(path, "utf-8");
        let after: string;
        try {
          after = setLinearDefaultTeam(before, opts.agent, opts.clear ? null : opts.team!.trim());
        } catch (err) {
          fail((err as Error).message);
        }
        writeFileSync(path, after, "utf-8");
        if (opts.clear) {
          console.log(chalk.green(`✓ Cleared default Linear team for '${opts.agent}' (auto-resolve).`));
        } else {
          console.log(chalk.green(`✓ Default Linear team for '${opts.agent}' set to ${opts.team!.trim()}.`));
        }
        console.log(chalk.gray(`  Run 'switchroom agent restart ${opts.agent}' to pick up the change.`));
      }),
    );
}

function printLinearInstructions(opts: LinearAgentSetupOpts, vaultKey: string): void {
  const base = opts.webhookBase ?? "https://<your-switchroom-web-host>";
  const webhookUrl = `${base.replace(/\/$/, "")}/webhook/${opts.agent}/linear`;

  console.log("");
  console.log(chalk.bold("Next steps in Linear (browser, one-time per agent):"));
  console.log(chalk.gray("  1. Create / open your Linear OAuth app with actor=app and scopes"));
  console.log(chalk.gray("     app:mentionable + app:assignable (https://linear.app/developers/agents)."));
  if (opts.clientId) {
    const redirect = opts.redirectUri ?? `${base.replace(/\/$/, "")}/oauth/callback`;
    const authorizeUrl =
      `https://linear.app/oauth/authorize?` +
      `client_id=${encodeURIComponent(opts.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent("read,write,app:assignable,app:mentionable")}` +
      `&actor=app`;
    console.log(chalk.gray("  2. Authorize the app as an actor (open in a browser):"));
    console.log(chalk.cyan(`     ${authorizeUrl}`));
    console.log(chalk.gray("     The redirect delivers the app token you pass to this verb via --token."));
  } else {
    console.log(chalk.gray("  2. Authorize the app (actor=app) in a browser; capture the app token and"));
    console.log(chalk.gray("     re-run this verb with --token (and optionally --client-id to print the"));
    console.log(chalk.gray("     authorize URL)."));
  }
  console.log(chalk.gray("  3. Register this webhook URL on the app (AgentSessionEvent + Issue/Comment):"));
  console.log(chalk.cyan(`     ${webhookUrl}`));
  console.log(
    chalk.gray(
      "     Use Linear's signing secret as the webhook secret — store it in the vault " +
        `under webhook/${opts.agent}/linear (e.g. 'switchroom telegram enable webhook ` +
        `--agent ${opts.agent} --source linear --secret <signing-secret>').`,
    ),
  );
  console.log("");
  console.log(chalk.gray(`  Token is read at runtime from vault:${vaultKey} (actor=app).`));
}

function makeUnifiedDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || a[i] !== b[j])) {
      out.push(chalk.green(`+ ${b[j]}`));
      j++;
    } else {
      out.push(chalk.red(`- ${a[i]}`));
      i++;
    }
  }
  return out.join("\n");
}

function fail(msg: string): never {
  console.error(chalk.red(`Error: ${msg}`));
  process.exit(1);
}
