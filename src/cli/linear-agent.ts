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
import { setLinearAgent, setLinearDefaultTeam, addAgentSecret } from "./telegram-yaml.js";
import { vaultPut, vaultPutQuiet, vaultGet } from "./telegram.js";
import { performLinearRefresh, serializeBundle } from "../linear/oauth-refresh.js";

interface LinearAgentSetupOpts {
  agent: string;
  token: string;
  refreshToken?: string;
  tokenExpiresIn?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  workspaceId?: string;
  webhookBase?: string;
  dryRun?: boolean;
}

/** Vault key holding the agent's rotatable OAuth refresh bundle (JSON
 *  string: {client_id, client_secret, refresh_token, expires_at}). */
function bundleKeyFor(agent: string): string {
  return `linear/${agent}/oauth`;
}

/**
 * `setup`/`refresh` write the vault FILE directly (operator passphrase). Inside
 * an agent container there is no mounted vault + no passphrase, so those writes
 * silently create a throwaway vault and "succeed" — the exact footgun that left
 * clerk/carrie with a token but no refresh bundle (a daily 401 with no
 * self-heal, 2026-06-16). Fail loudly instead and point at the sanctioned
 * in-container path (the `linear_agent_setup` MCP tool) or the host shell.
 */
export function linearSandboxRefusal(
  verb: string,
  runtime: string | undefined = process.env.SWITCHROOM_RUNTIME,
): string | null {
  if (runtime !== "docker") return null;
  return (
    `'linear-agent ${verb}' is a HOST command — it writes the vault file directly, which ` +
    `doesn't work inside an agent container (no mounted vault, no passphrase) and would ` +
    `silently no-op.\n  • In-container: use the 'linear_agent_setup' MCP tool (operator-approved).\n` +
    `  • On the host shell: run this same command there.`
  );
}

function refuseInSandbox(verb: string): void {
  const msg = linearSandboxRefusal(verb);
  if (msg) fail(msg);
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
    .option("--client-id <id>", "Linear OAuth app client id. Stored (with --client-secret + --refresh-token) to enable unattended token refresh.")
    .option("--client-secret <secret>", "Linear OAuth app client secret. Stored in the vault (with --client-id + --refresh-token) so the token can be refreshed without a browser re-auth.")
    .option("--refresh-token <token>", "The refresh_token from the OAuth exchange. Stored so an expired access token self-heals (see 'linear-agent refresh').")
    .option("--token-expires-in <seconds>", "expires_in from the OAuth token response (seconds). Records when the access token expires so refresh runs proactively. Defaults to 86400.")
    .option("--redirect-uri <uri>", "OAuth redirect URI registered on the Linear app (for the authorize-URL hint).")
    .option("--workspace-id <id>", "Optional Linear workspace (organization) id to record in config.")
    .option(
      "--webhook-base <url>",
      "Base URL of the switchroom web server (e.g. https://hooks.switchroom.ai). Used to print the webhook URL to register in Linear. Defaults to a placeholder.",
    )
    .option("--dry-run", "Print the YAML diff + instructions without writing or vaulting anything")
    .action(
      withConfigError(async (opts: LinearAgentSetupOpts) => {
        refuseInSandbox("setup");
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(opts.agent)) {
          fail(`--agent must be a lowercase agent slug (got '${opts.agent}').`);
        }
        if (!opts.token || opts.token.trim().length === 0) {
          fail("--token must be a non-empty Linear app token.");
        }

        const vaultKey = `linear/${opts.agent}/token`;
        const bundleKey = bundleKeyFor(opts.agent);
        // Auto-refresh needs the full set: refresh_token + the app creds to
        // exchange it. Anything less stores only the (short-lived) access
        // token, same as before.
        const canRefresh = Boolean(opts.refreshToken && opts.clientId && opts.clientSecret);
        if (!opts.dryRun) {
          await vaultPut(program, vaultKey, opts.token);
          if (canRefresh) {
            const expiresIn = Number.parseInt(opts.tokenExpiresIn ?? "", 10);
            const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86400;
            const bundle = serializeBundle({
              clientId: opts.clientId!,
              clientSecret: opts.clientSecret!,
              refreshToken: opts.refreshToken!,
              expiresAt: Math.floor(Date.now() / 1000) + ttl,
            });
            await vaultPutQuiet(program, bundleKey, bundle);
          }
        } else {
          console.log(chalk.gray(`[dry-run] would store the Linear token in the vault as '${vaultKey}'`));
          if (canRefresh) {
            console.log(chalk.gray(`[dry-run] would store the refresh bundle as '${bundleKey}' (enables auto-refresh)`));
          }
        }

        const path = getConfigPath(program);
        const before = readFileSync(path, "utf-8");
        let after: string;
        try {
          after = setLinearAgent(before, opts.agent, {
            token: `vault:${vaultKey}`,
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          });
          // Auto-refresh needs the agent to be able to read + rotate its
          // refresh bundle via the broker — grant it ACL by adding the key
          // to the agent's standing secrets[] (the access-token key is
          // already there or added by the operator's standing grant).
          if (canRefresh) {
            after = addAgentSecret(after, opts.agent, bundleKey);
            after = addAgentSecret(after, opts.agent, vaultKey);
          }
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
          if (canRefresh) {
            console.log(chalk.green(`✓ Auto-refresh enabled — refresh bundle stored at '${bundleKey}'`));
            console.log(
              chalk.gray(
                `  Granted ACL: '${bundleKey}' + '${vaultKey}' added to agents.${opts.agent}.secrets[] (agent rotates them in-container on a 401).`,
              ),
            );
          } else {
            console.log(
              chalk.yellow(
                `⚠ No refresh bundle stored — the access token will expire (~24h) and need a manual re-auth.`,
              ),
            );
            console.log(
              chalk.gray(
                `  To enable auto-refresh, re-run with --refresh-token <rt> --client-id <id> --client-secret <secret> --token-expires-in <sec>.`,
              ),
            );
          }
          console.log(chalk.gray(`  Run 'switchroom agent restart ${opts.agent}' to pick up the change.`));
        }

        printLinearInstructions(opts, vaultKey);
      }),
    );

  linear
    .command("refresh")
    .description(
      "Refresh <agent>'s Linear app token using the stored refresh bundle (linear/<agent>/oauth). Exchanges the refresh_token for a fresh access token, writes it to linear/<agent>/token, and rotates the stored refresh_token + expiry. Use to recover an expired token or seed automation. Host-side write — the running agent picks it up on its next broker re-mirror / restart.",
    )
    .requiredOption("--agent <name>", "Agent name (must have a linear_agent block)")
    .action(
      withConfigError(async (opts: { agent: string }) => {
        refuseInSandbox("refresh");
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(opts.agent)) {
          fail(`--agent must be a lowercase agent slug (got '${opts.agent}').`);
        }
        const bundleKey = bundleKeyFor(opts.agent);
        const res = await performLinearRefresh({
          readBundle: () => vaultGet(program, bundleKey),
          writeToken: (t) => vaultPutQuiet(program, `linear/${opts.agent}/token`, t),
          writeBundle: (json) => vaultPutQuiet(program, bundleKey, json),
        });
        if (!res.ok) {
          if (res.reason === "no_bundle") {
            fail(
              `No refresh bundle at '${bundleKey}'. Provision one via 'linear-agent setup --agent ${opts.agent} ` +
                `--token <t> --refresh-token <rt> --client-id <id> --client-secret <secret>'.`,
            );
          }
          if (res.reason === "revoked") {
            fail(
              `Refresh token is dead (revoked/expired) — re-authorize in a browser (actor=app) and re-run setup with the new --refresh-token. (${res.detail})`,
            );
          }
          fail(`Refresh failed (${res.reason}): ${res.detail}`);
        }
        if (res.ok) {
          const hours = Math.max(1, Math.round((res.expiresAt - Date.now() / 1000) / 3600));
          console.log(chalk.green(`✓ Refreshed Linear token for '${opts.agent}' (expires in ~${hours}h).`));
          console.log(
            chalk.gray(
              `  Written to vault:linear/${opts.agent}/token (+ rotated bundle). Restart the agent or wait for the broker to re-mirror.`,
            ),
          );
        }
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
