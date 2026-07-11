/**
 * `switchroom auth microsoft ...` — RFC #1873 PR 2 CLI verbs.
 *
 * Mirrors `auth-google.ts` shape, swapping Google OAuth client + broker
 * provider for Microsoft. Two-tier ladder (loopback + device-code) where
 * Google needed three for Drive scope rejections — Microsoft's device-code
 * works fine on personal MSA + work for the v1 scope set.
 *
 *   switchroom auth microsoft enable <account> <agents...>
 *   switchroom auth microsoft disable <account> <agents...>
 *   switchroom auth microsoft list
 *   switchroom auth microsoft account add <account> [--replace] [--org-mode]
 *   switchroom auth microsoft account remove <account>
 *   switchroom auth microsoft account list
 *
 * `connect` wizard deferred to a follow-up — operators bootstrap by
 * registering an Entra app + vaulting credentials + writing the YAML
 * block manually. `account add` prints actionable guidance when the
 * block is missing.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, statSync } from "node:fs";

import {
  getEnabledAgentsForMicrosoftAccount,
  listMicrosoftAccounts,
  removeMicrosoftAccountEntry,
} from "./microsoft-accounts-yaml.js";
import { writeConfigFileSync } from "../util/atomic.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import {
  planMicrosoftEnable,
  planMicrosoftDisable,
} from "./microsoft-enable-plan.js";
import {
  reloadAuthBroker,
  authBrokerReloadHint,
} from "./broker-reload.js";
import { resolveMicrosoftClientId } from "../auth/default-oauth-clients.js";
import { selectMicrosoftScopes } from "../microsoft/scopes.js";
import { buildMicrosoftCredentials as buildMicrosoftCredentialsCore } from "../microsoft/credentials.js";
import type { MicrosoftCredentialsShape } from "../auth/broker/protocol.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * Atomically persist a mutated switchroom.yaml (microsoft enable/disable/
 * remove ACL edits). Crash/ENOSPC mid-write must never truncate the fleet
 * config. Bind-mount aware (in-place fsync'd fallback on EBUSY); preserves mode.
 */
function writeMicrosoftYaml(configPath: string, text: string): void {
  let mode = 0o644;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    /* default 0o644 */
  }
  writeConfigFileSync(configPath, text, mode);
}

export function registerAuthMicrosoftSubcommands(
  program: Command,
  authParent: Command,
): void {
  const microsoft = authParent
    .command("microsoft")
    .description(
      "Manage Microsoft 365 accounts shared across agents (RFC #1873 — see reference/rfcs/microsoft-workspace.md)",
    );

  registerEnable(microsoft, program);
  registerDisable(microsoft, program);
  registerList(microsoft, program);

  const account = microsoft
    .command("account")
    .description(
      "Manage Microsoft account credentials in the auth-broker (add / remove / list).",
    );
  registerAccountAdd(account);
  registerAccountRemove(account);
  registerAccountList(account);
}

// ────────────────────────────────────────────────────────────────────────
// enable / disable / list — YAML-side operations
// ────────────────────────────────────────────────────────────────────────

function registerEnable(microsoftParent: Command, program: Command): void {
  microsoftParent
    .command("enable <account> <agents...>")
    .description(
      "Enable a Microsoft account on one or more agents. Use `all` to enable on every declared agent. Appends to microsoft_accounts.<account>.enabled_for[] AND pins agents.<agent>.microsoft_workspace.account (both are required, else the broker returns ACCOUNT_NOT_FOUND), then hot-reloads the running auth-broker so it's live immediately. Does NOT mint the broker credentials — use `auth microsoft account add` for that.",
    )
    .action(
      withConfigError(async (account: string, agents: string[]) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);
        validateAgentSlugs(agents, config);
        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");

        // Plan + write BOTH halves of the gate (ACL + per-agent selector). The
        // broker needs both, else it returns ACCOUNT_NOT_FOUND; `enable` used
        // to write only the ACL. See microsoft-enable-plan.ts.
        const { text, newlyEnabled, enabledAfter, selectorSet, selectorConflict } =
          planMicrosoftEnable(before, normalizedAccount, agents);
        if (text !== before) writeMicrosoftYaml(yamlPath, text);

        console.log();
        if (newlyEnabled.length === 0) {
          console.log(
            `No change — all of ${agents.join(", ")} already enabled on ${chalk.bold(normalizedAccount)}.`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Enabled ${chalk.bold(normalizedAccount)} on: ${newlyEnabled.join(", ")}`,
          );
        }
        if (enabledAfter.length > 0 && enabledAfter.length !== newlyEnabled.length) {
          const alreadyEnabled = enabledAfter.filter((a) => !newlyEnabled.includes(a));
          console.log(
            `  ${chalk.gray("already enabled on:")} ${alreadyEnabled.join(", ")}`,
          );
        }
        if (selectorSet.length > 0) {
          console.log(
            `  ${chalk.green("✓")} ${chalk.gray("pinned")} ${chalk.bold("microsoft_workspace.account")} ${chalk.gray("on:")} ${selectorSet.join(", ")}`,
          );
        }
        for (const { agent, current } of selectorConflict) {
          console.log(
            chalk.yellow(
              `  ⚠ ${chalk.bold(agent)} already pins a different account (${chalk.bold(current)}) — left as-is. Repin with \`switchroom auth microsoft disable ${current} ${agent}\` first if that's unintended.`,
            ),
          );
        }

        // 3. Hot-reload the running broker so the new ACL + selector are live
        //    immediately — no manual `docker restart switchroom-auth-broker`.
        if (text !== before) {
          const reload = reloadAuthBroker();
          if (reload.ok) {
            console.log(
              `  ${chalk.green("✓")} ${chalk.gray("auth-broker hot-reloaded — credentials are live.")}`,
            );
          } else {
            const hint = authBrokerReloadHint(reload);
            if (hint) console.log(chalk.yellow(`  ⚠ ${hint}`));
          }
        }

        console.log();
        if (newlyEnabled.length > 0 || selectorSet.length > 0) {
          const restartTargets = [...new Set([...newlyEnabled, ...selectorSet])];
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${restartTargets.join(" ")}`)} to regenerate the agent's MCP config and surface the Microsoft/OneDrive tools.`,
          );
          console.log();
        }
      }),
    );
}

function registerDisable(microsoftParent: Command, program: Command): void {
  microsoftParent
    .command("disable <account> <agents...>")
    .description(
      "Disable a Microsoft account on one or more agents. Use `all` to disable on every declared agent. Leaves the account in microsoft_accounts: with an empty enabled_for[] (dormant — matches shipped Google behavior per RFC §6.1).",
    )
    .action(
      withConfigError(async (account: string, agents: string[]) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);
        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        const enabledBefore = getEnabledAgentsBefore(before, normalizedAccount);

        if (enabledBefore.length === 0) {
          console.log();
          console.log(
            chalk.yellow(`Account ${chalk.bold(normalizedAccount)} is not currently enabled on any agent — nothing to do.`),
          );
          console.log();
          return;
        }

        // Plan + write: drop the ACL AND clear each removed agent's now-dangling
        // selector (symmetry with enable). See microsoft-enable-plan.ts.
        const { text, removed, enabledAfter, selectorCleared } =
          planMicrosoftDisable(before, normalizedAccount, agents);
        if (text !== before) writeMicrosoftYaml(yamlPath, text);

        console.log();
        if (removed.length === 0) {
          console.log(
            `No change — none of ${agents.join(", ")} were enabled on ${chalk.bold(normalizedAccount)}.`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Disabled ${chalk.bold(normalizedAccount)} from: ${removed.join(", ")}`,
          );
        }
        if (enabledAfter.length === 0) {
          console.log(
            `  ${chalk.gray("account is now")} ${chalk.bold("dormant")} ${chalk.gray("(empty enabled_for[])")}`,
          );
        } else {
          console.log(
            `  ${chalk.gray("still enabled on:")} ${enabledAfter.join(", ")}`,
          );
        }
        if (selectorCleared.length > 0) {
          console.log(
            `  ${chalk.gray("cleared")} ${chalk.bold("microsoft_workspace.account")} ${chalk.gray("on:")} ${selectorCleared.join(", ")}`,
          );
        }

        // Hot-reload the running broker so the dropped access is live now.
        if (text !== before) {
          const reload = reloadAuthBroker();
          if (reload.ok) {
            console.log(
              `  ${chalk.green("✓")} ${chalk.gray("auth-broker hot-reloaded — access revoked live.")}`,
            );
          } else {
            const hint = authBrokerReloadHint(reload);
            if (hint) console.log(chalk.yellow(`  ⚠ ${hint}`));
          }
        }

        console.log();
        if (removed.length > 0) {
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${removed.join(" ")}`)} so the agent drops the Microsoft MCP from its config.`,
          );
          console.log();
        }
      }),
    );
}

function registerList(microsoftParent: Command, program: Command): void {
  microsoftParent
    .command("list")
    .description(
      "List every Microsoft account configured in switchroom.yaml with its enabled_for[] agents.",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const yamlPath = getConfigPath(program);
        const yaml = readFileSync(yamlPath, "utf-8");
        const accounts = listMicrosoftAccounts(yaml);

        if (opts.json) {
          console.log(JSON.stringify(accounts, null, 2));
          return;
        }

        console.log();
        if (accounts.length === 0) {
          console.log(chalk.gray("No Microsoft accounts configured."));
          console.log(
            `Add one: ${chalk.bold("switchroom auth microsoft account add <email>")}`,
          );
          console.log(
            `Then enable on agents: ${chalk.bold("switchroom auth microsoft enable <email> <agent>...")}`,
          );
          console.log();
          return;
        }

        const accountColWidth = Math.max(
          ...accounts.map((a) => a.account.length),
          "ACCOUNT".length,
        );
        console.log(`${pad("ACCOUNT", accountColWidth)}  AGENTS`);
        console.log(`${pad("-".repeat(7), accountColWidth)}  ${"-".repeat(6)}`);
        for (const { account, enabled_for } of accounts) {
          const agentList =
            enabled_for.length === 0
              ? chalk.gray("(dormant — empty enabled_for)")
              : enabled_for.join(", ");
          console.log(`${pad(account, accountColWidth)}  ${agentList}`);
        }
        console.log();
      }),
    );
}

// ────────────────────────────────────────────────────────────────────────
// account add / remove / list — broker thin clients
// ────────────────────────────────────────────────────────────────────────

/**
 * v1 scope sets — RFC §4.3. `org_mode: false` (default) covers personal
 * MSA + standard work surfaces. `org_mode: true` opts in to SharePoint
 * (and softeria's --org-mode for Teams tools at PR 3 time).
 */
function registerAccountAdd(accountParent: Command): void {
  accountParent
    .command("add <account>")
    .description(
      "Mint a Microsoft OAuth refresh token for <account> and register with the auth-broker. Uses desktop-loopback by default (or device-code on headless hosts); both work for personal MSA and work/school. --org-mode also requests Sites.ReadWrite.All (SharePoint).",
    )
    .option(
      "--replace",
      "Overwrite existing credentials for <account> (default refuses if account already registered)",
      false,
    )
    .option(
      "--org-mode",
      "Request the SharePoint scope (Sites.ReadWrite.All) in addition to the default set. Useful for work accounts with SharePoint document libraries. Default is OneDrive-only.",
      false,
    )
    .action(
      withConfigError(
        async (account: string, opts: { replace?: boolean; "orgMode"?: boolean }) => {
          const normalizedAccount = validateAndNormalizeAccountEmail(account);

          const [
            { selectInitialTier, runLoopbackOAuth, requestDeviceCode, pollDeviceToken },
            { brokerCall },
            { loadConfig, resolvePath },
            { getSecret },
            { isVaultReference, parseVaultReference },
            { getViaBrokerStructured, statusViaBroker, resolveBrokerSocketPath },
          ] = await Promise.all([
            import("../microsoft/oauth.js"),
            import("./broker-call.js"),
            import("../config/loader.js"),
            import("../vault/vault.js"),
            import("../vault/resolver.js"),
            import("../vault/broker/client.js"),
          ]);

          const config = loadConfig();
          // microsoft_workspace is optional — when absent, the shipped
          // default Microsoft app is used (zero-config out-of-box).
          const mw = config.microsoft_workspace;

          // Precedence: env → operator config → shipped default.
          const resolvedClientId = resolveMicrosoftClientId(
            mw?.microsoft_client_id,
          );
          let clientIdRaw = resolvedClientId.clientId;
          let clientSecretRaw =
            process.env.SWITCHROOM_MICROSOFT_CLIENT_SECRET ??
            mw?.microsoft_client_secret;
          // client_secret optional — public-client apps don't need one.
          if (resolvedClientId.source === "default") {
            console.error(
              chalk.gray(
                "  Using switchroom's shipped Microsoft OAuth app (zero-config).\n" +
                "  To use your own Entra app instead, set " +
                "microsoft_workspace.microsoft_client_id in switchroom.yaml\n" +
                "  (or the SWITCHROOM_MICROSOFT_CLIENT_ID env var).",
              ),
            );
          }

          const needsVault =
            isVaultReference(clientIdRaw) ||
            (clientSecretRaw !== undefined && isVaultReference(clientSecretRaw));

          if (needsVault) {
            let brokerSocket: string | undefined;
            try {
              brokerSocket = resolveBrokerSocketPath({
                vaultBrokerSocket: config.vault?.broker?.socket
                  ? resolvePath(config.vault.broker.socket)
                  : undefined,
              });
            } catch {
              brokerSocket = resolveBrokerSocketPath();
            }
            const status = await statusViaBroker({ socket: brokerSocket });
            const viaBroker = status !== null && status.unlocked;

            let directVaultPath: string | undefined;
            let directPassphrase: string | undefined;
            const resolveRef = async (
              raw: string,
              label: string,
            ): Promise<string> => {
              if (!isVaultReference(raw)) return raw;
              const key = parseVaultReference(raw);

              if (viaBroker) {
                const result = await getViaBrokerStructured(key, {
                  socket: brokerSocket,
                });
                if (result.kind === "ok") {
                  if (result.entry.kind !== "string") {
                    throw new Error(
                      `${label} vault entry '${key}' is not a string (kind=${result.entry.kind}).`,
                    );
                  }
                  return result.entry.value;
                }
                if (result.kind !== "unreachable") {
                  throw new Error(
                    `${label} references vault key '${key}': broker ${result.kind} [${(result as { code?: string }).code ?? "?"}] ${(result as { msg?: string }).msg ?? ""}`,
                  );
                }
                console.error(
                  chalk.yellow(
                    `  vault-broker became unreachable — falling back to direct vault read for '${key}'.`,
                  ),
                );
              }

              directVaultPath ??= resolvePath(
                config.vault?.path ?? "~/.switchroom/vault.enc",
              );
              directPassphrase ??=
                process.env.SWITCHROOM_VAULT_PASSPHRASE ??
                (await readHiddenLine("Vault passphrase: "));
              const entry = getSecret(directPassphrase, directVaultPath, key);
              if (!entry) {
                throw new Error(
                  `${label} references vault key '${key}' but no such secret in vault.`,
                );
              }
              if (entry.kind !== "string") {
                throw new Error(
                  `${label} vault entry '${key}' is not a string (kind=${entry.kind}).`,
                );
              }
              return entry.value;
            };
            clientIdRaw = await resolveRef(clientIdRaw, "microsoft_client_id");
            if (clientSecretRaw !== undefined) {
              clientSecretRaw = await resolveRef(clientSecretRaw, "microsoft_client_secret");
            }
          }

          const orgMode = opts["orgMode"] ?? mw?.org_mode ?? false;
          const scopes = selectMicrosoftScopes(orgMode);
          const oauthCfg = {
            client_id: clientIdRaw,
            client_secret: clientSecretRaw,
            scopes,
          };

          if (orgMode) {
            console.log(
              chalk.yellow(
                "  Requesting SharePoint scope (Sites.ReadWrite.All) — grants read/write to every SharePoint site this account can access. Per RFC §4.3, opt-in for work accounts with SharePoint document libraries.",
              ),
            );
          }
          console.log(
            chalk.gray(
              `  Scopes: ${scopes.join(" ")}`,
            ),
          );

          const oauthEnv = {
            DISPLAY: process.env.DISPLAY,
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
            SSH_CONNECTION: process.env.SSH_CONNECTION,
            SSH_TTY: process.env.SSH_TTY,
            SWITCHROOM_MICROSOFT_OAUTH_TIER:
              process.env.SWITCHROOM_MICROSOFT_OAUTH_TIER,
          };
          const initialTier = selectInitialTier(oauthEnv);

          console.log();
          console.log(
            chalk.bold(
              `Connecting Microsoft account ${chalk.cyan(normalizedAccount)} to switchroom auth-broker.`,
            ),
          );
          console.log(
            chalk.gray(`  OAuth tier: ${initialTier}`),
          );
          console.log();

          let tokens;
          if (initialTier === "desktop_loopback") {
            tokens = await runLoopbackOAuth(oauthCfg, {
              onAuthUrl: (url: string, opened: boolean) => {
                if (opened) {
                  console.log(chalk.gray("  Browser opened — complete consent at:"));
                } else {
                  console.log(chalk.yellow("  Open this URL in any browser:"));
                }
                console.log(`    ${url}`);
                console.log();
              },
            });
          } else {
            const device = await requestDeviceCode(oauthCfg);
            console.log(chalk.bold("  Open this URL on any device + paste the code:"));
            console.log(`    ${chalk.cyan(device.verification_uri)}`);
            console.log(`    code: ${chalk.bold.yellow(device.user_code)}`);
            console.log(chalk.gray(`  (expires in ${Math.round(device.expires_in / 60)}min)`));
            console.log();
            tokens = await pollDeviceToken(oauthCfg, device);
          }

          if (!tokens.refresh_token) {
            throw new Error(
              "Microsoft did not return a refresh_token — ensure `offline_access` is in the consented scope set and try again.",
            );
          }

          const microsoftCreds = buildMicrosoftCredentials({
            tokens,
            clientId: clientIdRaw,
            accountEmail: normalizedAccount,
            fallbackScope: scopes.join(" "),
          });

          await brokerCall(async (client) => {
            await client.addAccount(
              normalizedAccount,
              microsoftCreds,
              opts.replace ?? false,
              "microsoft",
            );
          });

          console.log();
          console.log(
            chalk.green(
              `  ✓ Registered Microsoft account ${chalk.bold(normalizedAccount)} with auth-broker.`,
            ),
          );
          const accountType = microsoftCreds.microsoftOauth.accountType;
          console.log(
            chalk.gray(
              `  Account type: ${accountType} ${accountType === "personal" ? "(MSA — outlook.com / hotmail.com)" : `(work/school — tenant ${microsoftCreds.microsoftOauth.tenantId})`}`,
            ),
          );
          console.log();
          console.log(`  Next: enable on one or more agents:`);
          console.log(
            chalk.cyan(
              `    switchroom auth microsoft enable ${normalizedAccount} <agent> [...]`,
            ),
          );
          console.log();
        },
      ),
    );
}

function registerAccountRemove(accountParent: Command): void {
  // .alias("rm") to match Google's verb shape.
  const cmd = accountParent
    .command("remove <account>")
    .alias("rm")
    .description(
      "Remove a Microsoft account from the auth-broker AND prune the YAML entry. Refused if any agent still enabled — run `auth microsoft disable <account> all` first.",
    );
  cmd.action(
    withConfigError(async (account: string, _opts: unknown, command) => {
      const normalizedAccount = validateAndNormalizeAccountEmail(account);
      const { brokerCall } = await import("./broker-call.js");

      // Resolve YAML path via the program (honors --config flag) rather
      // than hand-rolling ~ expansion. The action callback's `command`
      // arg is the leaf subcommand; walk up to the top-level program.
      const program = command.parent?.parent?.parent ?? command;
      const yamlPath = getConfigPath(program);
      const before = readFileSync(yamlPath, "utf-8");
      const enabled = getEnabledAgentsForMicrosoftAccount(before, normalizedAccount);
      if (enabled && enabled.length > 0) {
        throw new Error(
          `Account ${normalizedAccount} is still enabled on agents: ${enabled.join(", ")}. ` +
          `Run 'switchroom auth microsoft disable ${normalizedAccount} all' first.`,
        );
      }

      await brokerCall(async (client) => {
        await client.rmAccount(normalizedAccount, "microsoft");
      });

      // Prune the dormant YAML entry now that the broker creds are gone.
      // Idempotent — if the entry was already absent, returns input verbatim.
      const after = removeMicrosoftAccountEntry(before, normalizedAccount);
      if (after !== before) writeMicrosoftYaml(yamlPath, after);

      console.log();
      console.log(
        chalk.green(
          `  ✓ Removed Microsoft account ${chalk.bold(normalizedAccount)} from auth-broker.`,
        ),
      );
      if (after !== before) {
        console.log(
          chalk.gray(
            `    pruned dormant entry from microsoft_accounts: in switchroom.yaml`,
          ),
        );
      }
      console.log();
    }),
  );
}

function registerAccountList(accountParent: Command): void {
  accountParent
    .command("list")
    .description(
      "List Microsoft accounts the broker holds credentials for. Distinct from `auth microsoft list` (YAML ACL matrix).",
    )
    .option("--json", "Emit raw JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const { brokerCall } = await import("./broker-call.js");
        const data = await brokerCall(async (client) =>
          client.listMicrosoftAccounts(),
        );

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log();
        if (data.accounts.length === 0) {
          console.log(chalk.gray("  No Microsoft accounts stored in broker."));
          console.log(
            `  Add one: ${chalk.bold("switchroom auth microsoft account add <email>")}`,
          );
          console.log();
          return;
        }

        const accountColWidth = Math.max(
          ...data.accounts.map((a) => a.account.length),
          "ACCOUNT".length,
        );
        const typeColWidth = "TYPE".length + 4;
        const expiresColWidth = "EXPIRES".length + 2;
        console.log(
          `${pad("ACCOUNT", accountColWidth)}  ${pad("TYPE", typeColWidth)}  ${pad("EXPIRES", expiresColWidth)}  SCOPE`,
        );
        console.log(
          `${pad("-".repeat(7), accountColWidth)}  ${pad("-".repeat(4), typeColWidth)}  ${pad("-".repeat(7), expiresColWidth)}  ${"-".repeat(5)}`,
        );
        const now = Date.now();
        for (const a of data.accounts) {
          const expiresLabel = formatMicrosoftExpiry(a.expiresAt - now);
          // Compress Graph scope display — drop the noisy openid/profile/
          // email/offline_access scaffolding scopes; keep the resource
          // scopes (Mail/Files/Calendars) that tell the operator what the
          // account can actually do.
          const scopes = a.scope
            .split(" ")
            .filter(
              (s) =>
                s.length > 0 &&
                !["openid", "profile", "email", "offline_access"].includes(s),
            )
            .join(", ");
          console.log(
            `${pad(a.account, accountColWidth)}  ${pad(a.accountType, typeColWidth)}  ${pad(expiresLabel, expiresColWidth)}  ${scopes}`,
          );
        }
        console.log();
      }),
    );
}

/**
 * Format a millisecond duration as a short relative time. Negative
 * durations render as "expired" — the broker's refresh-tick keeps
 * stored creds fresh, so this should be rare for a live account.
 */
function formatMicrosoftExpiry(remainingMs: number): string {
  if (remainingMs <= 0) return chalk.red("expired");
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

function validateAndNormalizeAccountEmail(account: string): string {
  const normalized = account.trim().toLowerCase();
  if (!/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/.test(normalized)) {
    throw new Error(
      `'${account}' is not a valid Microsoft account email. Expected format like 'alice@outlook.com' or 'alice@contoso.com' (colons not allowed).`,
    );
  }
  return normalized;
}

function getEnabledAgentsBefore(yamlText: string, account: string): string[] {
  return getEnabledAgentsForMicrosoftAccount(yamlText, account) ?? [];
}

function expandAllAgents(agents: string[], config: SwitchroomConfig): string[] {
  if (!agents.includes("all")) return agents;
  const allNames = Object.keys(config.agents);
  if (allNames.length === 0) {
    throw new Error(
      "switchroom.yaml has no agents declared — `all` matches nothing.",
    );
  }
  return allNames;
}

function validateAgentSlugs(agents: string[], config: SwitchroomConfig): void {
  const known = new Set(Object.keys(config.agents));
  const unknown = agents.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown agent(s) in switchroom.yaml: ${unknown.join(", ")}. ` +
      `Known agents: ${[...known].join(", ")}`,
    );
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Build the Microsoft broker credentials shape from a token response.
 * Decodes the id_token (if present) to populate canonical identity
 * fields (tenantId, accountType, homeAccountId, accountEmail).
 *
 * The broker's MicrosoftProvider also does this on refresh; here we do
 * it at account-add time to seed the on-disk credentials.json with
 * canonical values.
 */
function buildMicrosoftCredentials(opts: {
  tokens: import("../microsoft/oauth.js").MicrosoftTokenResponse;
  clientId: string;
  accountEmail: string;
  fallbackScope: string;
}): MicrosoftCredentialsShape {
  // Shared, side-effect-free core (also used by the Telegram device-code
  // connect flow). The CLI keeps its loud requested-vs-authenticated
  // email mismatch warning here so the operator catches a typo'd arg.
  const built = buildMicrosoftCredentialsCore(opts);

  if (built.emailMismatch) {
    console.warn();
    console.warn(
      `  ⚠ Account argument was '${opts.accountEmail}' but Microsoft authenticated as '${built.resolvedEmail}'.`,
    );
    console.warn(
      `    The broker will index by '${opts.accountEmail}' (what you typed). If this isn't what`,
    );
    console.warn(
      `    you intended (e.g. a typo), 'switchroom auth microsoft account remove ${opts.accountEmail}' to undo.`,
    );
    console.warn();
  }

  return built.credentials;
}

/**
 * Read a single hidden line of input (no echo) — for secret prompts
 * like the vault passphrase. On non-TTY input (CI, piped stdin) falls
 * back to readline.question for sensible behavior.
 */
async function readHiddenLine(prompt: string): Promise<string> {
  const readline = await import("node:readline");
  const stdin = process.stdin as unknown as {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  // Non-TTY: use readline.question — manual data listener + readline
  // interface fight each other on piped stdin. Matches Google's
  // auth-google.ts:1063 shape.
  if (!stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const stdout = process.stdout as unknown as { write: (s: string) => void };
    stdout.write(prompt);
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    let line = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
          process.stdin.off("data", onData);
          rl.close();
          stdout.write("\n");
          resolve(line);
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          line = line.slice(0, -1);
          continue;
        }
        if (ch === "\x03") {
          // Ctrl-C
          if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
          process.stdin.off("data", onData);
          rl.close();
          reject(new Error("aborted"));
          return;
        }
        line += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}
