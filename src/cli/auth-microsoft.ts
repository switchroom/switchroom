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
import { readFileSync, writeFileSync } from "node:fs";

import {
  disableAgentsOnMicrosoftAccount,
  enableAgentsOnMicrosoftAccount,
  getEnabledAgentsForMicrosoftAccount,
  listMicrosoftAccounts,
  removeMicrosoftAccountEntry,
} from "./microsoft-accounts-yaml.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import type { SwitchroomConfig } from "../config/schema.js";

export function registerAuthMicrosoftSubcommands(
  program: Command,
  authParent: Command,
): void {
  const microsoft = authParent
    .command("microsoft")
    .description(
      "Manage Microsoft 365 accounts shared across agents (RFC #1873 — see docs/rfcs/microsoft-workspace.md)",
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
      "Enable a Microsoft account on one or more agents. Use `all` to enable on every declared agent. Appends to microsoft_accounts.<account>.enabled_for[] — does NOT mint the broker credentials (use `auth microsoft account add` for that).",
    )
    .action(
      withConfigError(async (account: string, agents: string[]) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);
        validateAgentSlugs(agents, config);
        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        const enabledBefore = getEnabledAgentsBefore(before, normalizedAccount);

        const after = enableAgentsOnMicrosoftAccount(before, normalizedAccount, agents);
        if (after !== before) writeFileSync(yamlPath, after);

        const enabledAfter = getEnabledAgentsForMicrosoftAccount(after, normalizedAccount) ?? [];
        const newlyEnabled = enabledAfter.filter((a) => !enabledBefore.includes(a));

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
        console.log();
        if (newlyEnabled.length > 0) {
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${newlyEnabled.join(" ")}`)} so the wrapper picks up the new ACL.`,
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

        const after = disableAgentsOnMicrosoftAccount(before, normalizedAccount, agents);
        if (after !== before) writeFileSync(yamlPath, after);

        const enabledAfter = getEnabledAgentsForMicrosoftAccount(after, normalizedAccount) ?? [];
        const removed = enabledBefore.filter((a) => !enabledAfter.includes(a));

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
        console.log();
        if (removed.length > 0) {
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${removed.join(" ")}`)} so the wrapper drops its access.`,
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
const SCOPE_SET_DEFAULT = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Calendars.ReadWrite",
  "Files.ReadWrite.All",
];

const SCOPE_SET_ORG_MODE = [
  ...SCOPE_SET_DEFAULT,
  "Sites.ReadWrite.All",
];

function selectMicrosoftScopes(orgMode: boolean): string[] {
  return orgMode ? SCOPE_SET_ORG_MODE : SCOPE_SET_DEFAULT;
}

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
          const mw = config.microsoft_workspace;
          if (!mw) {
            throw new Error(
              microsoftClientSetupGuidance(
                "switchroom.yaml has no `microsoft_workspace:` block, so there is no Microsoft OAuth app to connect accounts against.",
              ),
            );
          }

          let clientIdRaw =
            process.env.SWITCHROOM_MICROSOFT_CLIENT_ID ?? mw.microsoft_client_id;
          let clientSecretRaw =
            process.env.SWITCHROOM_MICROSOFT_CLIENT_SECRET ??
            mw.microsoft_client_secret;
          if (!clientIdRaw) {
            throw new Error(
              microsoftClientSetupGuidance(
                "The `microsoft_workspace:` block is present but `microsoft_client_id` is empty.",
              ),
            );
          }
          // client_secret optional — public-client apps don't need one.

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

          const orgMode = opts["orgMode"] ?? mw.org_mode ?? false;
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
      if (after !== before) writeFileSync(yamlPath, after);

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
}): import("../auth/broker/protocol.js").MicrosoftCredentialsShape {
  const { tokens, clientId, accountEmail, fallbackScope } = opts;

  // Lazy module-level import to keep CLI startup snappy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { decodeJwtPayloadUnsafe, classifyAccountType, buildHomeAccountId } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../microsoft/oauth.js") as typeof import("../microsoft/oauth.js");

  let tenantId = "";
  let accountType: "personal" | "work" = "work";
  let homeAccountId = "";
  let resolvedEmail = accountEmail;

  if (tokens.id_token) {
    const claims = decodeJwtPayloadUnsafe(tokens.id_token);
    if (claims) {
      if (typeof claims.tid === "string") tenantId = claims.tid;
      if (tenantId) accountType = classifyAccountType(tenantId);
      const home = buildHomeAccountId(claims);
      if (home) homeAccountId = home;
      if (typeof claims.preferred_username === "string") {
        resolvedEmail = claims.preferred_username.toLowerCase();
      } else if (typeof claims.email === "string") {
        resolvedEmail = claims.email.toLowerCase();
      }
    }
  }

  // Catch typo'd account args: if Microsoft authenticated a different
  // email than what the operator passed, warn loudly. Easy to miss
  // otherwise — broker indexes by the passed arg, credentials.json says
  // the real email, and `enable` on the typo would still "work" but
  // route to the wrong account. Reviewer ask.
  if (resolvedEmail.toLowerCase() !== accountEmail.toLowerCase()) {
    console.warn();
    console.warn(
      `  ⚠ Account argument was '${accountEmail}' but Microsoft authenticated as '${resolvedEmail}'.`,
    );
    console.warn(
      `    The broker will index by '${accountEmail}' (what you typed). If this isn't what`,
    );
    console.warn(
      `    you intended (e.g. a typo), 'switchroom auth microsoft account remove ${accountEmail}' to undo.`,
    );
    console.warn();
  }

  return {
    microsoftOauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? fallbackScope,
      clientId,
      accountEmail: resolvedEmail,
      tokenType: "Bearer",
      tenantId,
      accountType,
      homeAccountId,
    },
  };
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

export function microsoftClientSetupGuidance(reason: string): string {
  return [
    reason,
    "",
    "Switchroom ships no shared Microsoft OAuth app — register your own.",
    "One-time per install:",
    "",
    "  1. Go to https://entra.microsoft.com → App registrations → New",
    "     registration",
    "  2. Supported account types: 'Accounts in any organizational",
    "     directory AND personal Microsoft accounts' (multi-tenant + MSA)",
    "  3. Redirect URI: platform 'Mobile and desktop applications',",
    "     value `http://localhost` (port-agnostic; Microsoft ignores port",
    "     for loopback URIs)",
    "  4. Authentication → Advanced settings → 'Allow public client",
    "     flows': Yes (enables device-code on personal MSA)",
    "  5. Copy the Application (client) ID from the Overview page",
    "  6. Optional: create a client secret in 'Certificates & secrets'",
    "     (skip if using public-client flow only)",
    "  7. Vault the credentials:",
    "",
    "    switchroom vault set microsoft-oauth-client-id",
    "    switchroom vault set microsoft-oauth-client-secret  # optional",
    "",
    "  8. If your work tenant requires admin consent, your IT admin must",
    "     grant the requested Graph scopes (Files.ReadWrite.All etc.) at",
    "     first sign-in. Personal MSA accounts (outlook.com / hotmail.com)",
    "     don't need this step.",
    "  9. Add to ~/.switchroom/switchroom.yaml (top level):",
    "",
    "    microsoft_workspace:",
    '      microsoft_client_id: "vault:microsoft-oauth-client-id"',
    '      microsoft_client_secret: "vault:microsoft-oauth-client-secret"  # omit if public-client',
    "      authority: https://login.microsoftonline.com/common",
    "      org_mode: false",
    "",
    "Env vars SWITCHROOM_MICROSOFT_CLIENT_ID / _SECRET override the block",
    "for one-off debugging.",
    "",
    "Full walkthrough: docs/microsoft-workspace.md (PR 5 will land this).",
    "Don't reuse an existing Entra app — see RFC §4.1 (signInAudience",
    "mismatch + token-version drift make app sharing brittle).",
  ].join("\n");
}
