/**
 * `switchroom auth google ...` — RFC G Phase 3a CLI verbs.
 *
 * Mirrors the `switchroom auth account ...` shape from `auth-accounts.ts`
 * exactly (per RFC G §4.5), but indexes per-Google-account rather than
 * per-Anthropic-account:
 *
 *   switchroom auth google enable <account> <agents...>
 *   switchroom auth google disable <account> <agents...>
 *   switchroom auth google list                              # accounts × agents matrix
 *
 * Phase 3a (this file) intentionally OMITS:
 *   - account add / remove (need OAuth flow refactor — Phase 3b)
 *   - share (one-shot enable + add) — Phase 3b
 *   - drive connect/disconnect aliasing — Phase 3b
 *   - apply-time legacy-slot detector wiring — Phase 3b
 *
 * `connect` (the one-time install onboarding wizard — GCP client →
 * vault → `google_workspace:` block) is implemented below in
 * `registerConnect`; it is the native equivalent of the manual
 * prerequisite documented in docs/google-workspace.md § Prerequisite.
 *
 * The reason for the split: the OAuth flow is currently inlined in
 * `src/cli/drive.ts:runConnect()` (lines 259–620, narrowly wired to the
 * Drive-only approval flow). Extracting it cleanly is its own piece of
 * work, and the load-bearing value of Phase 3 — letting operators
 * declare which agents share which Google account in YAML — is reachable
 * with just enable/disable/list. Operators can populate
 * `google_accounts.<email>.enabled_for[]` by hand or via these verbs;
 * Phase 3b adds the OAuth-driven `account add` that mints the vault
 * slot for them.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";

import {
  disableAgentsOnGoogleAccount,
  enableAgentsOnGoogleAccount,
  getEnabledAgentsForGoogleAccount,
  listGoogleAccounts,
} from "./google-accounts-yaml.js";
import type { PutResult, GetResult } from "../vault/broker/client.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import type { SwitchroomConfig } from "../config/schema.js";

export function registerAuthGoogleSubcommands(
  program: Command,
  authParent: Command,
): void {
  const google = authParent
    .command("google")
    .description(
      "Manage Google Workspace accounts shared across agents (RFC G — see reference/rfcs/google-workspace-generalization.md)",
    );

  registerConnect(google, program);
  registerEnable(google, program);
  registerDisable(google, program);
  registerList(google, program);

  // RFC G Phase 3b.3 — account-lifecycle verbs (auth-broker thin clients).
  const account = google
    .command("account")
    .description(
      "Manage Google account credentials in the auth-broker (add / remove / list).",
    );
  registerAccountAdd(account);
  registerAccountRemove(account);
  registerAccountList(account);
}

/**
 * `switchroom auth google connect` — one-time-per-install onboarding
 * wizard. The native equivalent of the manual prerequisite in
 * docs/google-workspace.md § Prerequisite: walks the operator through
 * the GCP Console, vaults the OAuth client id/secret, and writes the
 * `google_workspace:` block into switchroom.yaml (comment-preserving
 * via the shared yaml Document pattern; never clobbers an existing
 * block).
 *
 * Conservative by construction:
 *   - refuses on a non-TTY (a wizard in CI is meaningless),
 *   - refuses if the block (or its legacy `drive:` alias) already
 *     exists — prints the block for manual paste instead of touching
 *     a configured file,
 *   - re-validates switchroom.yaml after the write and surfaces a
 *     clear error if (somehow) invalid.
 */
function registerConnect(googleParent: Command, program: Command): void {
  googleParent
    .command("connect")
    .description(
      "One-time install wizard: create + register your Google OAuth client (GCP Console → vault → google_workspace: block). Run once, then `auth google account add`.",
    )
    .action(
      withConfigError(async () => {
        if (!process.stdin.isTTY) {
          throw new Error(
            oauthClientSetupGuidance(
              "`switchroom auth google connect` is an interactive wizard and needs a TTY.",
            ),
          );
        }

        const [
          { loadConfig, resolvePath },
          { putViaBroker, resolveBrokerSocketPath },
          { setGoogleWorkspaceBlock },
          { atomicWriteFileSync },
        ] = await Promise.all([
          import("../config/loader.js"),
          import("../vault/broker/client.js"),
          import("./google-workspace-yaml.js"),
          import("../util/atomic.js"),
        ]);

        const configPath = getConfigPath(program);
        const config = loadConfig(configPath);
        const gw = config.google_workspace;
        if (gw?.google_client_id && gw?.google_client_secret) {
          console.log();
          console.log(
            chalk.green(
              "  ✓ A Google OAuth client is already configured in switchroom.yaml.",
            ),
          );
          console.log();
          console.log("  Nothing to do here. Next: connect a Google account:");
          console.log(
            chalk.cyan(
              "    switchroom auth google account add <your-google-email>",
            ),
          );
          console.log();
          return;
        }

        console.log();
        console.log(
          chalk.bold("Google Workspace — one-time OAuth client setup"),
        );
        console.log(
          chalk.gray(
            "  Switchroom ships no shared client by design (per-install client\n" +
              "  keeps the integration subscription-honest). This is one-time.\n",
          ),
        );
        console.log("  In the Google Cloud Console (~5 min):");
        console.log(
          "    1. https://console.cloud.google.com — create a project.",
        );
        console.log(
          "    2. APIs & Services → Library — enable the Drive, Docs,",
        );
        console.log("       Sheets, and Calendar APIs.");
        console.log(
          "    3. OAuth consent screen → External; add yourself as a Test user.",
        );
        console.log(
          "    4. Credentials → Create credentials → OAuth client ID →",
        );
        console.log('       Application type: "Desktop app".');
        console.log(
          chalk.gray(
            "\n  Must be Desktop app. Google's device-code flow does NOT\n" +
              "  support Drive scopes (it returns invalid_scope), and OOB is\n" +
              "  retired — so Drive auth uses the loopback flow, which\n" +
              "  requires a Desktop client. On a headless server you complete\n" +
              "  the one browser step over an SSH port-forward (the CLI\n" +
              "  prints the exact URL + port).\n",
          ),
        );

        const clientId = (
          await readVisibleLine("  Paste the OAuth client ID: ")
        ).trim();
        const clientSecret = (
          await readHiddenLine("  Paste the OAuth client secret: ")
        ).trim();
        if (!clientId || !clientSecret) {
          throw new Error(
            "Client id and secret are both required. Re-run `switchroom auth google connect` when you have them.",
          );
        }

        const approversRaw = (
          await readVisibleLine(
            "  Telegram numeric user id(s) allowed to approve Drive onboarding\n" +
              "  (comma-separated, ≥1): ",
          )
        ).trim();
        const approvers = approversRaw
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((s) => {
            if (!/^\d+$/.test(s)) {
              throw new Error(
                `"${s}" is not a numeric Telegram user id. Approvers must be numeric ids.`,
              );
            }
            return Number(s);
          });
        if (approvers.length === 0) {
          throw new Error(
            "At least one approver Telegram user id is required.",
          );
        }

        const tierRaw = (
          await readVisibleLine(
            "  Workspace tier [core] / extended / complete: ",
          )
        )
          .trim()
          .toLowerCase();
        const tier =
          tierRaw === "" ? "core" : (tierRaw as "core" | "extended" | "complete");
        if (!["core", "extended", "complete"].includes(tier)) {
          throw new Error(
            `Unknown tier "${tierRaw}". Use core, extended, or complete.`,
          );
        }

        // Write the secrets through the vault-broker, not the vault file
        // directly. The broker is the single owner/writer of vault.enc
        // (it runs as root and rewrites the file on its own schedule);
        // a host-side direct write races it and breaks the moment the
        // broker has re-owned the file (the classic root:root EACCES).
        // `switchroom vault set` is broker-routed for the same reason —
        // `--no-broker` direct-file is the legacy escape hatch, not the
        // default. We forward the operator passphrase as attestation
        // (#969 P1a): when it matches the broker's unlocked passphrase
        // the broker treats the call as operator-issued and bypasses
        // the unknown-key gate, so it can create these brand-new keys —
        // the same path the Telegram one-tap save uses.
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
        const passphrase =
          process.env.SWITCHROOM_VAULT_PASSPHRASE ??
          (await readHiddenLine("  Vault passphrase: "));
        for (const [key, value] of [
          ["google-oauth-client-id", clientId],
          ["google-oauth-client-secret", clientSecret],
        ] as const) {
          const result = await putViaBroker(
            key,
            { kind: "string", value },
            { socket: brokerSocket, passphrase },
          );
          const verdict = interpretConnectPutResult(
            key,
            result,
            config.vault?.broker?.enabled === false,
          );
          if (!verdict.ok) {
            throw new Error(verdict.message);
          }
        }
        console.log(
          chalk.green(
            "\n  ✓ Stored client id + secret in the vault via the broker\n" +
              "    (google-oauth-client-id / google-oauth-client-secret).",
          ),
        );

        const blockYaml = [
          "google_workspace:",
          '  google_client_id: "vault:google-oauth-client-id"',
          '  google_client_secret: "vault:google-oauth-client-secret"',
          `  approvers: [${approvers.join(", ")}]`,
          `  tier: ${tier}`,
        ].join("\n");

        const raw = readFileSync(configPath, "utf-8");
        const patched = setGoogleWorkspaceBlock(raw, {
          clientIdRef: "vault:google-oauth-client-id",
          clientSecretRef: "vault:google-oauth-client-secret",
          approvers,
          tier,
        });

        if (patched === raw) {
          console.log(
            chalk.yellow(
              "\n  switchroom.yaml already has a google_workspace:/drive: block —\n" +
                "  leaving it untouched. Merge these values yourself if needed:\n",
            ),
          );
          console.log(blockYaml.replace(/^/gm, "    "));
          console.log();
          return;
        }

        let mode = 0o644;
        try {
          const { statSync } = await import("node:fs");
          mode = statSync(configPath).mode & 0o777;
        } catch {
          /* default 0644 */
        }
        atomicWriteFileSync(configPath, patched, mode);

        try {
          loadConfig(configPath);
        } catch (err) {
          throw new Error(
            `Wrote google_workspace: to ${configPath} but it no longer validates: ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              `The OAuth client id/secret are safely in the vault — fix or remove ` +
              `the block by hand (it is the last top-level key).`,
          );
        }

        console.log(
          chalk.green(
            `\n  ✓ Wrote the google_workspace: block to ${configPath}.`,
          ),
        );
        console.log();
        console.log("  Next: connect a Google account:");
        console.log(
          chalk.cyan(
            "    switchroom auth google account add <your-google-email>",
          ),
        );
        console.log();
      }),
    );
}

function registerEnable(googleParent: Command, program: Command): void {
  googleParent
    .command("enable <account> <agents...>")
    .description(
      "Enable a Google account on one or more agents (appends to switchroom.yaml google_accounts.<account>.enabled_for[]). Use `all` to enable on every declared agent. Mirrors `auth enable` exactly.",
    )
    .action(
      withConfigError(async (account: string, agents: string[]) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);

        // Verify all named agents exist in switchroom.yaml. Fail-fast
        // before touching the YAML.
        for (const name of agents) {
          if (!config.agents[name]) {
            throw new Error(
              `agent '${name}' is not declared in switchroom.yaml under 'agents:'`,
            );
          }
        }

        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        const after = enableAgentsOnGoogleAccount(before, normalizedAccount, agents);
        const noop = after === before;
        if (!noop) {
          writeFileSync(yamlPath, after);
        }

        const enabledAfter = getEnabledAgentsForGoogleAccount(after, normalizedAccount) ?? [];
        const newlyEnabled = agents.filter((a) => !getEnabledAgentsBefore(before, normalizedAccount).includes(a));

        console.log();
        if (noop) {
          console.log(
            `No change — ${chalk.bold(normalizedAccount)} already enabled on: ${agents.join(", ")}`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Enabled ${chalk.bold(normalizedAccount)} on: ${newlyEnabled.join(", ")}`,
          );
        }
        console.log(
          `  ${chalk.gray("now enabled on:")} ${enabledAfter.join(", ") || "(none)"}`,
        );
        console.log();
        // Restart hint only when something actually changed — pure
        // no-op enables don't require a restart, and printing a
        // restart command with no agents to restart is misleading.
        if (newlyEnabled.length > 0) {
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${newlyEnabled.join(" ")}`)} so the wrapper picks up the new ACL.`,
          );
          console.log();
        }
      }),
    );
}

function registerDisable(googleParent: Command, program: Command): void {
  googleParent
    .command("disable <account> <agents...>")
    .description(
      "Disable a Google account on one or more agents. Use `all` to disable on every declared agent. Leaves the account in google_accounts: with an empty enabled_for[] (dormant) — does NOT remove the vault slot. Use `auth google account remove` (Phase 3b) for full teardown.",
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

        const after = disableAgentsOnGoogleAccount(before, normalizedAccount, agents);
        const noop = after === before;
        if (!noop) {
          writeFileSync(yamlPath, after);
        }

        const enabledAfter = getEnabledAgentsForGoogleAccount(after, normalizedAccount) ?? [];
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
          console.log(
            `  Standing approval-kernel grants under removed agents become dormant (RFC G §4.4).`,
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

function registerList(googleParent: Command, program: Command): void {
  googleParent
    .command("list")
    .description(
      "List every Google account configured in switchroom.yaml with its enabled_for[] agents. Matrix view of accounts × agents.",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const yamlPath = getConfigPath(program);
        const yaml = readFileSync(yamlPath, "utf-8");
        const accounts = listGoogleAccounts(yaml);

        if (opts.json) {
          console.log(JSON.stringify(accounts, null, 2));
          return;
        }

        console.log();
        if (accounts.length === 0) {
          console.log(
            chalk.gray("No Google accounts configured."),
          );
          console.log(
            `Add one (Phase 3b): ${chalk.bold("switchroom auth google account add <email>")}`,
          );
          console.log(
            `Or hand-edit: add a ${chalk.bold("google_accounts:")} block to switchroom.yaml.`,
          );
          console.log();
          return;
        }

        const accountColWidth = Math.max(
          ...accounts.map((a) => a.account.length),
          "ACCOUNT".length,
        );
        console.log(
          `${pad("ACCOUNT", accountColWidth)}  AGENTS`,
        );
        console.log(
          `${pad("-".repeat(7), accountColWidth)}  ${"-".repeat(6)}`,
        );
        for (const { account, enabled_for } of accounts) {
          const agentList = enabled_for.length === 0
            ? chalk.gray("(dormant — empty enabled_for)")
            : enabled_for.join(", ");
          console.log(`${pad(account, accountColWidth)}  ${agentList}`);
        }
        console.log();
      }),
    );
}

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Normalize an account email to the form used everywhere else in the
 * pipeline (lowercase + trim) — schema does this at parse time, vault
 * slot helpers do it on write/read, broker does it on lookup. Doing it
 * here too means the CLI accepts whatever case the operator types.
 *
 * Also enforces the same email-shape regex the schema uses, so
 * malformed input fails at the CLI layer with an actionable error
 * rather than getting written to YAML and rejected on the next
 * config-load (would force operators to hand-edit the YAML to
 * recover).
 */
function validateAndNormalizeAccountEmail(account: string): string {
  const normalized = account.trim().toLowerCase();
  // Same regex as src/config/schema.ts:google_accounts key validator
  // — must contain @ + dot, must NOT contain `:` (which would break
  // the broker's slot-key parser).
  if (!/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/.test(normalized)) {
    throw new Error(
      `'${account}' is not a valid Google account email. Expected format like 'alice@example.com' (colons not allowed).`,
    );
  }
  return normalized;
}

function getEnabledAgentsBefore(yamlText: string, account: string): string[] {
  return getEnabledAgentsForGoogleAccount(yamlText, account) ?? [];
}

/**
 * Expand the literal token `all` to every declared agent. Mirrors
 * `auth-accounts.ts:expandAllAgents` exactly — operators reasonably
 * try `auth google enable alice@example.com all`, and treating that as
 * literal-agent-named-`all` would be a confusing failure.
 *
 * Pass-through if `all` isn't in the list. Multiple `all`s are
 * harmless (deduplicated by the YAML mutator's idempotency).
 */
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

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 3b.3 — `auth google account add | remove | list`
// Thin clients over the auth-broker (RFC H), with provider="google"
// passed through. add + remove are functional end-to-end; list awaits
// a `list-google-accounts` broker op (tracked follow-up).
// ────────────────────────────────────────────────────────────────────────

function registerAccountAdd(accountParent: Command): void {
  accountParent
    .command("add <account>")
    .description(
      "Mint a Google OAuth refresh token for <account> and register it with the auth-broker. For Drive scopes the effective flow is desktop-loopback (device-code returns invalid_scope for Drive; OOB is retired) — use a Desktop OAuth client; on a headless host complete the browser step over an SSH port-forward. Add --write for create/edit (drive.file); default is read-only.",
    )
    .option(
      "--replace",
      "Overwrite existing credentials for <account> (default refuses if account already registered)",
      false,
    )
    .option(
      "--write",
      "Request Drive WRITE scope (drive.file: create + edit app-created files) in addition to read. Default is read-only — a read grant never silently becomes a write grant. Re-consent an existing account with `--replace --write`.",
      false,
    )
    .action(
      withConfigError(
        async (account: string, opts: { replace?: boolean; write?: boolean }) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);

        // Lazy-import the OAuth flow + vault resolver — they pull in
        // sizeable trees (Drive scaffolding, AES vault) that the
        // sibling enable/disable/list verbs don't need.
        const [
          { runDriveOAuthFlow, selectGoogleWorkspaceScopes },
          { selectInitialTier },
          { brokerCall },
          { loadConfig, resolvePath },
          { getSecret },
          { isVaultReference, parseVaultReference },
          { getViaBrokerStructured, statusViaBroker, resolveBrokerSocketPath },
        ] = await Promise.all([
          import("./drive.js"),
          import("../drive/oauth.js"),
          import("./broker-call.js"),
          import("../config/loader.js"),
          import("../vault/vault.js"),
          import("../vault/resolver.js"),
          import("../vault/broker/client.js"),
        ]);

        const config = loadConfig();
        const gw = config.google_workspace;
        if (!gw) {
          throw new Error(
            oauthClientSetupGuidance(
              "switchroom.yaml has no `google_workspace:` block, so there is no Google OAuth client to connect accounts against.",
            ),
          );
        }

        // Resolve OAuth client id + secret. Env wins over config (one-
        // off overrides during operator debugging). vault:<key> refs
        // require the vault passphrase.
        let clientIdRaw =
          process.env.SWITCHROOM_GOOGLE_CLIENT_ID ?? gw.google_client_id;
        let clientSecretRaw =
          process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET ??
          gw.google_client_secret;
        if (!clientIdRaw || !clientSecretRaw) {
          throw new Error(
            oauthClientSetupGuidance(
              "The `google_workspace:` block is present but `google_client_id` and/or `google_client_secret` is empty.",
            ),
          );
        }

        const needsVault =
          isVaultReference(clientIdRaw) || isVaultReference(clientSecretRaw);
        if (needsVault) {
          // Broker-first, mirroring `switchroom vault get`. On a host
          // running the vault-broker, the broker owns vault.enc as root
          // — a direct `getSecret` then fails with root:root EACCES
          // (the same failure connect hit before #1347). When the
          // broker is reachable + unlocked we read through it (the
          // operator socket can read any key without an "operator"-
          // excluding scope — connect writes these keys unscoped). We
          // only fall back to a direct file read when there is no
          // usable broker, in which case the file isn't broker-owned
          // anyway so the direct read is correct (the documented
          // `--no-broker` interactive path).
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
              const verdict = interpretRefGetResult(label, key, result);
              if (verdict.ok) return verdict.value;
              if (!verdict.fallback) throw new Error(verdict.message);
              // fallback: broker vanished between status and get — fall
              // through to the direct path below. Don't do it silently
              // (mirrors the yellow notice `vault get` prints on the
              // same transition); a direct read of a broker-owned vault
              // can EACCES, so the operator should know why we're now
              // prompting for the passphrase.
              console.error(
                chalk.yellow(
                  `  vault-broker became unreachable mid-request — ` +
                    `falling back to a direct vault read for '${key}'.`,
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
          clientIdRaw = await resolveRef(clientIdRaw, "google_client_id");
          clientSecretRaw = await resolveRef(
            clientSecretRaw,
            "google_client_secret",
          );
        }

        // Tie the OAuth scope set to the configured Workspace tier
        // (issue #1663). `gw.tier` defaults to `core` when unset — same
        // default as GoogleWorkspaceTierSchema. core/extended/complete
        // all mint Docs+Sheets scopes; extended/complete add Slides, so
        // the token a tier mints can drive every tool that tier exposes
        // (instead of advertising Slides/Docs/Sheets tools that 403 and
        // trigger upstream's doomed port-8000 OAuth fallback).
        const tier = gw.tier ?? "core";
        const accountScopes = selectGoogleWorkspaceScopes({
          write: opts.write ?? false,
          tier,
        });
        const oauthCfg = {
          client_id: clientIdRaw,
          client_secret: clientSecretRaw,
          scopes: accountScopes,
        };
        if (opts.write) {
          console.log(
            chalk.yellow(
              "  Requesting Drive WRITE scope (drive.file — create/edit app-created files).",
            ),
          );
        }
        console.log(
          chalk.gray(
            `  Workspace tier: ${tier} — requesting Docs + Sheets` +
              (tier === "extended" || tier === "complete"
                ? " + Slides"
                : "") +
              " API scopes so the tier's tools can authenticate.",
          ),
        );
        console.log(
          chalk.gray(
            "  Changing the tier later requires re-running this command\n" +
              "  (`--replace`) — OAuth scopes are fixed at consent time.",
          ),
        );
        // OAuthEnv is a shaped subset of process.env — picking the
        // fields the selector reads (rather than passing process.env
        // wholesale) keeps the call typed.
        //
        // `account add` ALWAYS requests Drive scopes, and for Drive the
        // device-code and OOB tiers are dead ends (Google returns
        // invalid_scope for Drive on device-code; OOB was retired in
        // 2022). On a headless host the generic ladder doesn't recover —
        // the OOB tier blocks on an un-answerable paste prompt and
        // nextTier() dead-ends at null before loopback. So default the
        // initial tier to desktop-loopback here (the one flow that works
        // for Drive); the operator can still override via
        // SWITCHROOM_DRIVE_OAUTH_TIER. selectInitialTier honours the
        // override ahead of its headless-avoidance, so loopback is
        // selected even headless (operator completes the browser step
        // over an SSH port-forward to the printed 127.0.0.1:<port>).
        const oauthEnv = {
          DISPLAY: process.env.DISPLAY,
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
          SSH_CONNECTION: process.env.SSH_CONNECTION,
          SSH_TTY: process.env.SSH_TTY,
          SWITCHROOM_DRIVE_OAUTH_TIER:
            process.env.SWITCHROOM_DRIVE_OAUTH_TIER ?? "desktop_loopback",
        };
        const initialTier = selectInitialTier(oauthEnv);

        console.log();
        console.log(
          chalk.bold(
            `Connecting Google account ${chalk.cyan(normalizedAccount)} to switchroom auth-broker.`,
          ),
        );
        console.log(
          chalk.gray(
            `  OAuth tier: ${initialTier} (will fall through if Google rejects)`,
          ),
        );
        console.log();

        const tokens = await runDriveOAuthFlow(
          oauthCfg,
          initialTier,
          process.env,
        );

        if (!tokens.refresh_token) {
          throw new Error(
            "Google did not return a refresh_token. Re-run after revoking prior consent at https://myaccount.google.com/permissions, or set OAUTH_PROMPT=consent in the environment.",
          );
        }

        const googleCreds = buildGoogleCredentials({
          tokens,
          clientId: clientIdRaw,
          accountEmail: normalizedAccount,
          fallbackScope: accountScopes.join(" "),
        });

        await brokerCall(async (client) => {
          await client.addAccount(
            normalizedAccount,
            googleCreds,
            opts.replace ?? false,
            "google",
          );
        });

        console.log();
        console.log(
          chalk.green(
            `  ✓ Registered Google account ${chalk.bold(normalizedAccount)} with auth-broker.`,
          ),
        );
        console.log();
        console.log(`  Next: enable on one or more agents:`);
        console.log(
          chalk.cyan(
            `    switchroom auth google enable ${normalizedAccount} <agent> [...]`,
          ),
        );
        console.log();
      }),
    );
}

/**
 * Build the guided error shown when the Google OAuth client isn't
 * configured. The CLI is the doc here (principles.md "docs test"): the
 * operator should be able to recover from the error text alone without
 * opening docs/. Leads with the native one-command fix, then the manual
 * equivalent, then the doc pointer. `reason` is the specific thing that
 * was missing so the two callsites stay distinguishable.
 *
 * Exported for the unit test that pins this contract.
 */
export function oauthClientSetupGuidance(reason: string): string {
  return [
    reason,
    "",
    "Switchroom ships no shared OAuth client by design (per-install",
    "client keeps the integration subscription-honest). Set one up —",
    "one-time per install:",
    "",
    "  Native (recommended): a wizard that walks the GCP Console, vaults",
    "  the secrets, and writes the config block for you —",
    "",
    "    switchroom auth google connect",
    "",
    "  Manual: at https://console.cloud.google.com create an OAuth",
    '  client of type "Desktop app" (Drive uses the loopback flow —',
    "  device-code returns invalid_scope for Drive and OOB is retired),",
    "  enable the Drive/Docs/Sheets/Calendar APIs, add yourself as a",
    "  test user, then:",
    "",
    "    switchroom vault set google-oauth-client-id",
    "    switchroom vault set google-oauth-client-secret",
    "",
    "  and add to ~/.switchroom/switchroom.yaml (top level):",
    "",
    "    google_workspace:",
    '      google_client_id: "vault:google-oauth-client-id"',
    '      google_client_secret: "vault:google-oauth-client-secret"',
    "      approvers: [<your-telegram-user-id>]",
    "      tier: core",
    "",
    "Env vars SWITCHROOM_GOOGLE_CLIENT_ID / _SECRET override the block",
    "for one-off debugging. Full walkthrough: docs/google-workspace.md",
    "§ Prerequisite.",
  ].join("\n");
}

/**
 * Decide whether a broker `put` during `connect` succeeded, and if not,
 * produce the operator-facing recovery message. Pure + exported so the
 * broker-failure contract is unit-tested without driving the
 * interactive wizard (the wizard action itself is smoke-tested per the
 * file header).
 *
 * Deliberately does NOT fall back to a direct vault.enc write on
 * failure: the broker owns the file, so a host-side direct write is the
 * exact thing that breaks under a broker-owned (root:root) vault.
 * Stopping with an actionable message beats silently regressing to the
 * path this change exists to remove.
 */
export function interpretConnectPutResult(
  key: string,
  result: PutResult,
  brokerDisabled = false,
): { ok: true } | { ok: false; message: string } {
  switch (result.kind) {
    case "ok":
      return { ok: true };
    case "unreachable":
      // Two very different causes, two different next steps. If the
      // operator deliberately runs vault.broker.enabled:false, telling
      // them to restart the broker is useless — point them at the
      // manual seed path (the documented `--no-broker` direct write,
      // which is correct there because the file isn't broker-owned).
      return {
        ok: false,
        message: brokerDisabled
          ? `'${key}' was not stored: connect writes secrets through the ` +
            `vault-broker, but vault.broker.enabled is false in your ` +
            `config (${result.msg}). On a broker-disabled host, seed the ` +
            `two keys directly instead — 'switchroom vault set ` +
            `--no-broker google-oauth-client-id' and ' --no-broker ` +
            `google-oauth-client-secret' — then add the google_workspace: ` +
            `block by hand (docs/google-workspace.md § Prerequisite). Or ` +
            `enable the broker and re-run 'switchroom auth google connect'.`
          : `Vault broker is unreachable (${result.msg}); '${key}' was ` +
            `not stored. connect writes secrets through the broker, not ` +
            `the vault file. Check it on the host — 'switchroom vault ` +
            `broker status'; if wedged, 'docker compose -p switchroom ` +
            `restart vault-broker' — then re-run 'switchroom auth google ` +
            `connect' (the write is idempotent).`,
      };
    case "denied":
      return {
        ok: false,
        message:
          `Vault broker refused to store '${key}' [${result.code}]: ` +
          `${result.msg}. Most common cause: the passphrase does not ` +
          `match the broker's unlocked passphrase. Re-run 'switchroom ` +
          `auth google connect' with the vault passphrase the broker is ` +
          `unlocked with.`,
      };
    case "not_found":
      return {
        ok: false,
        message:
          `Vault broker reached but rejected creating '${key}' ` +
          `[${result.code}]: ${result.msg}. Creating a new key needs ` +
          `operator-passphrase attestation and the supplied passphrase ` +
          `did not attest. Re-run with the real vault passphrase (the ` +
          `one the broker is unlocked with).`,
      };
  }
}

/**
 * Interpret a broker `get` result while resolving a `vault:` ref for
 * `account add`. Pure + exported so the contract is unit-tested
 * without a live broker.
 *
 * Three outcomes:
 *   - { ok: true, value }              — string entry resolved.
 *   - { ok: false, fallback: true }    — broker unreachable; caller
 *                                        should fall through to the
 *                                        direct-file read (legacy /
 *                                        broker-disabled path).
 *   - { ok: false, fallback: false }   — hard error (key missing,
 *                                        wrong kind, or ACL/scope
 *                                        denial) — abort with message.
 *
 * Only `unreachable` is fallback-eligible: a reached broker that says
 * not_found / denied is authoritative — silently reading the file
 * instead would mask a real misconfiguration (and reintroduce the
 * root-owned-vault failure mode).
 */
export function interpretRefGetResult(
  label: string,
  key: string,
  result: GetResult,
):
  | { ok: true; value: string }
  | { ok: false; fallback: true }
  | { ok: false; fallback: false; message: string } {
  switch (result.kind) {
    case "ok":
      if (result.entry.kind !== "string") {
        return {
          ok: false,
          fallback: false,
          message: `${label} vault entry '${key}' is not a string (kind=${result.entry.kind}).`,
        };
      }
      return { ok: true, value: result.entry.value };
    case "unreachable":
      return { ok: false, fallback: true };
    case "not_found":
      return {
        ok: false,
        fallback: false,
        message: `${label} references vault key '${key}' but the broker has no such secret [${result.code}]: ${result.msg}.`,
      };
    case "denied":
      return {
        ok: false,
        fallback: false,
        message:
          `${label} vault key '${key}' was refused by the broker ` +
          `[${result.code}]: ${result.msg}. If the entry is scoped, it ` +
          `must allow "operator"; re-store it unscoped via 'switchroom ` +
          `auth google connect' or 'switchroom vault set ${key}'.`,
      };
  }
}

/**
 * Read a single visible line (echoed) — for non-secret wizard prompts
 * (client id, approver ids, tier). The client *secret* and vault
 * passphrase use readHiddenLine instead.
 */
async function readVisibleLine(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

/**
 * Read a single line from stdin without echoing characters. Mirrors
 * the inline implementations in drive.ts:121 and telegram.ts:584
 * exactly — manual `'data'` accumulation under setRawMode (so
 * keystrokes never reach stdout), `rl.question(prompt, …)` fallback
 * for the non-TTY/pipe case where echo isn't a concern.
 *
 * Extraction of the three duplicates into a shared module is its own
 * cleanup PR (would touch unrelated callsites).
 */
async function readHiddenLine(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  return await new Promise<string>((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      let input = "";
      const onData = (data: Buffer) => {
        const char = data.toString("utf8");
        if (char === "\n" || char === "\r") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          resolve(input);
        } else if (char === "") {
          // Ctrl-C
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "" || char === "\b") {
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += char;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

function registerAccountRemove(accountParent: Command): void {
  accountParent
    .command("remove <account>")
    .alias("rm")
    .description(
      "Revoke + delete the Google OAuth credentials for <account>. Refused if any agent is still enabled on the account (run `auth google disable <account> all` first).",
    )
    .action(
      withConfigError(async (account: string) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        // Use the shared brokerCall helper so error UX matches every
        // other broker-touching verb (operator-actionable
        // "broker unreachable" hint, exit code 2; broker error code
        // + message to stderr, exit code 1).
        const { brokerCall } = await import("./broker-call.js");
        await brokerCall(async (client) => {
          await client.rmAccount(normalizedAccount, "google");
        });
        console.log();
        console.log(
          chalk.green(
            `  ✓ Removed Google account ${chalk.bold(normalizedAccount)} from broker.`,
          ),
        );
        console.log();
      }),
    );
}

function registerAccountList(accountParent: Command): void {
  accountParent
    .command("list")
    .description(
      "List Google accounts stored in the auth-broker. Distinct from `auth google list` (which shows the YAML google_accounts × agents matrix).",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const { brokerCall } = await import("./broker-call.js");
        const data = await brokerCall(async (client) =>
          client.listGoogleAccounts(),
        );

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log();
        if (data.accounts.length === 0) {
          console.log(chalk.gray("  No Google accounts stored in broker."));
          console.log(
            `  Add one: ${chalk.bold("switchroom auth google account add <email>")}`,
          );
          console.log();
          return;
        }

        const accountColWidth = Math.max(
          ...data.accounts.map((a) => a.account.length),
          "ACCOUNT".length,
        );
        const expiresColWidth = "EXPIRES".length + 2;
        console.log(
          `${pad("ACCOUNT", accountColWidth)}  ${pad("EXPIRES", expiresColWidth)}  SCOPE`,
        );
        console.log(
          `${pad("-".repeat(7), accountColWidth)}  ${pad("-".repeat(7), expiresColWidth)}  ${"-".repeat(5)}`,
        );
        const now = Date.now();
        for (const a of data.accounts) {
          const remainingMs = a.expiresAt - now;
          const expiresLabel = formatExpiry(remainingMs);
          // Compress scope display — operators don't need the full URL
          // prefix on every list. Keep enough to distinguish read-only
          // from writable scopes.
          const scopes = a.scope
            .split(" ")
            .map((s) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ""))
            .filter(Boolean)
            .join(", ");
          console.log(
            `${pad(a.account, accountColWidth)}  ${pad(expiresLabel, expiresColWidth)}  ${scopes}`,
          );
        }
        console.log();
      }),
    );
}

/**
 * Format a millisecond duration as a short relative time. Negative
 * durations render as "expired" — the broker's refresh-tick keeps
 * stored creds within the 60-min threshold so this should be rare.
 */
function formatExpiry(remainingMs: number): string {
  if (remainingMs <= 0) return chalk.red("expired");
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

// ────────────────────────────────────────────────────────────────────────
// Pure helpers — extracted for unit testing
// ────────────────────────────────────────────────────────────────────────

interface BuildGoogleCredentialsArgs {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  clientId: string;
  accountEmail: string;
  /** Joined-with-spaces scope to fall back to if Google omits scope. */
  fallbackScope: string;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
}

interface GoogleAddAccountCredentialsLike {
  googleOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope: string;
    clientId: string;
    accountEmail: string;
    tokenType: "Bearer";
  };
}

/**
 * Construct the GoogleAddAccountCredentials payload the auth-broker
 * expects from a Google token-exchange response. Pure — easy to unit
 * test and reason about. Refuses tokens missing refresh_token (Google
 * only returns it on first consent or `prompt=consent` re-consent).
 */
export function buildGoogleCredentials(
  args: BuildGoogleCredentialsArgs,
): GoogleAddAccountCredentialsLike {
  const { tokens, clientId, accountEmail, fallbackScope, now } = args;
  if (!tokens.refresh_token) {
    throw new Error(
      "Google token-exchange did not return a refresh_token — re-consent required.",
    );
  }
  const epochMs = (now ?? Date.now)();
  return {
    googleOauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: epochMs + tokens.expires_in * 1000,
      scope: tokens.scope ?? fallbackScope,
      clientId,
      accountEmail,
      tokenType: "Bearer",
    },
  };
}

// Re-export for tests.
export const _testing = {
  validateAndNormalizeAccountEmail,
  getEnabledAgentsBefore,
  expandAllAgents,
  buildGoogleCredentials,
  oauthClientSetupGuidance,
  interpretConnectPutResult,
  interpretRefGetResult,
};

