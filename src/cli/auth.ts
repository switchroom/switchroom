/**
 * `switchroom auth` CLI surface — post-RFC-H thin client over the
 * auth-broker UDS.
 *
 * The fleet-wide model collapses what used to be a per-agent verb tree
 * (`auth login / reauth / heal / promote / enable / disable / share /
 * refresh-accounts / status / account add / account list / account rm`)
 * into a small accounts-and-fleet surface:
 *
 *   auth add <label> --from-agent | --from-credentials | --from-oauth
 *   auth list
 *   auth use <label>            — set fleet active
 *   auth rotate                 — cycle to next non-exhausted entry
 *   auth rm <label>
 *   auth show [<agent>]
 *   auth refresh [<label>]      — diagnostic force-tick
 *   auth agent override <agent> (<label> | --clear)
 *
 * Every verb hits the broker over the operator socket and prints the
 * result. No per-agent state writes from this code path; the broker
 * owns mirror files.
 *
 * `diagnoseAuthState` survives as a pure helper used by the
 * `auth-heal-diagnose` test. The CLI verb that wrapped it (`auth heal`)
 * is gone — there's no slot pool to heal post-RFC-H.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AuthBrokerClient,
  AuthBrokerError,
  AuthBrokerUnreachableError,
  withAuthBrokerClient,
  type AccountState,
  type AddAccountCredentials,
  type AgentState,
  type ConsumerState,
  type ListStateData,
} from "../auth/broker/client.js";
import {
  accountCredentialsPath,
  readAccountCredentials,
} from "../auth/account-store.js";
import { resolveAgentsDir } from "../config/loader.js";
import { withConfigError, getConfig } from "./helpers.js";
import { registerAuthGoogleSubcommands } from "./auth-google.js";

// ─── Diagnose (used by tests; CLI heal verb removed) ─────────────────────

export type AuthSeverity = "ok" | "warn" | "error" | "critical";

export interface AuthFinding {
  code: string;
  severity: AuthSeverity;
  summary: string;
}

export interface AuthDiagnosis {
  severity: AuthSeverity;
  findings: AuthFinding[];
  recommendation: string[];
}

const SEVERITY_RANK: Record<AuthSeverity, number> = {
  ok: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

/**
 * Inspect an agent's `.credentials.json` and return a structured
 * diagnosis. Pure read; no side effects. Used by the boot-self-test
 * issue card path and by `tests/auth-heal-diagnose.test.ts`.
 *
 * `auth heal` (which wrapped this in a CLI verb) was deleted with
 * RFC H — the broker writes mirrors directly, so there's no per-agent
 * state to heal from the CLI.
 */
export function diagnoseAuthState(claudeConfigDir: string): AuthDiagnosis {
  const findings: AuthFinding[] = [];
  const credsPath = join(claudeConfigDir, ".credentials.json");
  const oauthTokenPath = join(claudeConfigDir, ".oauth-token");

  const hasCreds = existsSync(credsPath);
  const hasOauthToken = existsSync(oauthTokenPath);

  if (!hasCreds && !hasOauthToken) {
    findings.push({
      code: "credentials_missing",
      severity: "error",
      summary: "needs first-time login — send /auth in this chat to start the flow",
    });
  } else if (hasCreds) {
    let parsed:
      | { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } }
      | undefined;
    try {
      parsed = JSON.parse(readFileSync(credsPath, "utf-8"));
    } catch {
      findings.push({
        code: "credentials_malformed",
        severity: "error",
        summary: "credentials file corrupted — send /auth in this chat to reset",
      });
    }
    if (parsed) {
      const oauth = parsed.claudeAiOauth;
      if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
        findings.push({
          code: "credentials_malformed",
          severity: "error",
          summary: "credentials file corrupted — send /auth in this chat to reset",
        });
      } else {
        const expiresAt = oauth.expiresAt;
        if (typeof expiresAt === "number") {
          if (!Number.isFinite(expiresAt)) {
            findings.push({
              code: "credentials_malformed",
              severity: "warn",
              summary: "credentials file has invalid expiry — send /auth in this chat to reset",
            });
          } else if (expiresAt < Date.now()) {
            const days = Math.floor((Date.now() - expiresAt) / 86_400_000);
            findings.push({
              code: "token_expired",
              severity: "error",
              summary: `login expired ${days}d ago — send /auth in this chat to refresh`,
            });
          }
        } else if (expiresAt !== undefined) {
          findings.push({
            code: "credentials_malformed",
            severity: "warn",
            summary: "credentials file has invalid expiry — send /auth in this chat to reset",
          });
        }
        if (!oauth.refreshToken || oauth.refreshToken.length === 0) {
          findings.push({
            code: "refresh_token_missing",
            severity: "warn",
            summary: "send /auth in this chat to renew credentials before they expire",
          });
        }
      }
    }
  }

  let severity: AuthSeverity = "ok";
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[severity]) {
      severity = f.severity;
    }
  }

  const recommendation: string[] = [];
  if (severity !== "ok") {
    if (findings.some((f) => f.code === "credentials_missing" && f.severity === "error")) {
      recommendation.push("This agent has never been authenticated. Start the OAuth flow:");
    } else if (findings.some((f) => f.code === "token_expired")) {
      recommendation.push("The access token has expired and can't be refreshed automatically. Reauth:");
    } else if (findings.some((f) => f.code === "credentials_malformed")) {
      recommendation.push(".credentials.json is corrupted. A fresh OAuth flow will replace it:");
    } else {
      recommendation.push("Recommended: refresh credentials so the access token can be renewed:");
    }
    recommendation.push("");
    recommendation.push("  switchroom auth add default --from-oauth");
    recommendation.push("");
  }

  return { severity, findings, recommendation };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function dieBrokerUnreachable(err: AuthBrokerUnreachableError): never {
  console.error(chalk.red(`  auth-broker unreachable: ${err.message}`));
  console.error(
    chalk.gray(
      `  Check the daemon: docker compose -p switchroom ps switchroom-auth-broker`,
    ),
  );
  process.exit(2);
}

function dieBrokerError(err: AuthBrokerError): never {
  console.error(chalk.red(`  ${err.code}: ${err.message}`));
  process.exit(1);
}

async function brokerCall<T>(fn: (client: AuthBrokerClient) => Promise<T>): Promise<T> {
  try {
    return await withAuthBrokerClient(fn);
  } catch (err) {
    if (err instanceof AuthBrokerUnreachableError) dieBrokerUnreachable(err);
    if (err instanceof AuthBrokerError) dieBrokerError(err);
    throw err;
  }
}

function formatExpiry(expiresAt?: number): string {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "—";
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return chalk.red("expired");
  const days = Math.floor(remainingMs / 86_400_000);
  const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h`;
}

function formatQuotaReset(state: AccountState): string {
  if (!state.exhausted) return "—";
  const u = state.exhausted_until;
  if (typeof u !== "number") return "exhausted";
  const remainingMs = u - Date.now();
  if (remainingMs <= 0) return "—";
  const hours = Math.floor(remainingMs / 3_600_000);
  const mins = Math.floor((remainingMs % 3_600_000) / 60_000);
  return `${hours}h ${mins}m`;
}

function printAccountsTable(state: ListStateData): void {
  console.log(
    chalk.bold("  ACCOUNT                           STATUS       EXPIRES    QUOTA-RESET"),
  );
  for (const a of state.accounts) {
    const marker =
      a.label === state.active
        ? chalk.green("●")
        : a.exhausted
          ? chalk.red("!")
          : chalk.gray("✓");
    const status =
      a.label === state.active
        ? chalk.green("active   ")
        : a.exhausted
          ? chalk.red("exhausted")
          : "available";
    const label = a.label.padEnd(32);
    const exp = formatExpiry(a.expiresAt).padEnd(10);
    const quota = formatQuotaReset(a);
    console.log(`  ${marker} ${label} ${status}    ${exp} ${quota}`);
  }
}

function printAgentsTable(state: ListStateData): void {
  console.log();
  console.log(chalk.bold("  AGENT       ACTIVE                       SOURCE"));
  for (const a of state.agents) {
    const acct = a.account.padEnd(28);
    const source = a.override ? "override" : "fleet-active";
    console.log(`  ${a.name.padEnd(10)} ${acct} ${source}`);
  }
}

function printConsumersTable(state: ListStateData): void {
  if (state.consumers.length === 0) return;
  console.log();
  console.log(chalk.bold("  CONSUMER    ACTIVE                       STATUS"));
  for (const c of state.consumers) {
    const acct = c.account.padEnd(28);
    const status =
      c.last_seen_at == null
        ? chalk.gray("never seen")
        : `last seen ${Math.round((Date.now() - c.last_seen_at) / 1000)}s ago`;
    console.log(`  ${c.name.padEnd(10)} ${acct} ${status}`);
  }
}

function printAgentDetail(state: ListStateData, agent: AgentState): void {
  console.log();
  console.log(chalk.bold(`  ${agent.name}`));
  console.log(
    `    Active account: ${agent.account} (${agent.override ? "override" : "fleet-active"})`,
  );
  const acct = state.accounts.find((a) => a.label === agent.account);
  if (acct) {
    console.log(
      `    Token expires:  ${formatExpiry(acct.expiresAt)} (refreshes at 60 min remaining)`,
    );
    if (typeof acct.last_refreshed_at === "number") {
      console.log(
        `    Last refresh:   ${new Date(acct.last_refreshed_at).toISOString()}`,
      );
    }
    if (acct.exhausted) {
      console.log(`    Quota:          ${chalk.red("exhausted")} (resets in ${formatQuotaReset(acct)})`);
    }
    if (typeof acct.threshold_violations === "number" && acct.threshold_violations > 0) {
      console.log(
        chalk.yellow(
          `    Threshold violations: ${acct.threshold_violations} — claude refreshed under the broker's feet`,
        ),
      );
    }
  }
}

function loadCredentialsFromAgent(agentName: string): AddAccountCredentials {
  const config = getConfigSafe();
  const agentsDir = resolveAgentsDir(config);
  const agentDir = resolve(agentsDir, agentName);
  const credsPath = join(agentDir, ".claude", ".credentials.json");
  if (!existsSync(credsPath)) {
    console.error(
      chalk.red(`  Agent "${agentName}" has no .claude/.credentials.json — log it in first.`),
    );
    process.exit(1);
  }
  let parsed: AddAccountCredentials;
  try {
    parsed = JSON.parse(readFileSync(credsPath, "utf-8")) as AddAccountCredentials;
  } catch (err) {
    console.error(
      chalk.red(`  Failed to parse credentials.json: ${(err as Error).message}`),
    );
    process.exit(1);
  }
  if (typeof parsed?.claudeAiOauth?.accessToken !== "string") {
    console.error(
      chalk.red(`  credentials.json missing claudeAiOauth.accessToken`),
    );
    process.exit(1);
  }
  return parsed;
}

function loadCredentialsFromFile(path: string): AddAccountCredentials {
  if (!existsSync(path)) {
    console.error(chalk.red(`  No file at ${path}`));
    process.exit(1);
  }
  let parsed: AddAccountCredentials;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as AddAccountCredentials;
  } catch (err) {
    console.error(chalk.red(`  Failed to parse ${path}: ${(err as Error).message}`));
    process.exit(1);
  }
  if (typeof parsed?.claudeAiOauth?.accessToken !== "string") {
    console.error(chalk.red(`  ${path} is missing claudeAiOauth.accessToken`));
    process.exit(1);
  }
  return parsed;
}

function loadCredentialsFromGlobalAccount(label: string): AddAccountCredentials {
  const creds = readAccountCredentials(label);
  if (!creds || typeof creds.claudeAiOauth?.accessToken !== "string") {
    console.error(
      chalk.red(
        `  No credentials found at ${accountCredentialsPath(label)}.\n` +
          `  Run 'claude setup-token' first to populate them.`,
      ),
    );
    process.exit(1);
  }
  return {
    claudeAiOauth: {
      accessToken: creds.claudeAiOauth.accessToken,
      refreshToken: creds.claudeAiOauth.refreshToken,
      expiresAt: creds.claudeAiOauth.expiresAt,
      scopes: creds.claudeAiOauth.scopes,
      subscriptionType: creds.claudeAiOauth.subscriptionType,
      rateLimitTier: creds.claudeAiOauth.rateLimitTier,
    },
  };
}

function getConfigSafe(): ReturnType<typeof getConfig> {
  // Some `auth` verbs (add --from-oauth, list, show) don't strictly need
  // a switchroom.yaml, but the helpers `getConfig` does require one. The
  // CLI integration test relies on `getConfig` failing loudly when the
  // config is missing.
  // Use a tiny faux Command so getConfig's traversal works.
  type GetConfigArg = Parameters<typeof getConfig>[0];
  return getConfig(undefined as unknown as GetConfigArg);
}

// ─── Register ─────────────────────────────────────────────────────────────

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage OAuth authentication via switchroom-auth-broker (RFC H)");

  registerAuthGoogleSubcommands(program, auth);

  // ── auth heal <agent> --json --config-dir <dir> ────────────────────────
  // Minimal surface kept for boot-self-test.sh's structural diagnoser
  // shell-out (`diagnoseAuthState`). The pre-RFC-H "heal the slot pool"
  // CLI verb is gone — there's no slot pool. This verb just emits the
  // diagnoser's JSON so the boot script can decide which issue card
  // to file. Human-facing path is empty by design.
  auth
    .command("heal <agent>")
    .description("[boot self-test] emit structural auth-state diagnosis as JSON")
    .option("--json", "Emit JSON (the only supported output)")
    .option(
      "--config-dir <dir>",
      "Override the .claude config dir to inspect (default: <agentsDir>/<agent>/.claude)",
    )
    .action(
      withConfigError(
        async (
          agent: string,
          opts: { json?: boolean; configDir?: string },
        ) => {
          const config = getConfig(program);
          const agentsDir = resolveAgentsDir(config);
          const configDir = opts.configDir ?? join(agentsDir, agent, ".claude");
          const diag = diagnoseAuthState(configDir);
          if (opts.json) {
            console.log(JSON.stringify(diag));
          } else {
            console.log(JSON.stringify(diag, null, 2));
          }
        },
      ),
    );

  // ── auth add <label> ──────────────────────────────────────────────────
  auth
    .command("add <label>")
    .description(
      "Add a new account to the broker (seeds the credentials store)",
    )
    .option("--from-agent <name>", "Seed from an existing agent's .claude/.credentials.json")
    .option("--from-credentials <path>", "Seed from a credentials.json file")
    .option(
      "--from-oauth",
      "Seed from a freshly-completed OAuth flow's credentials at ~/.switchroom/accounts/<label>/credentials.json",
    )
    .option("--replace", "Overwrite an existing account (drift recovery)")
    .action(
      withConfigError(
        async (
          label: string,
          opts: {
            fromAgent?: string;
            fromCredentials?: string;
            fromOauth?: boolean;
            replace?: boolean;
          },
        ) => {
          const sources = [opts.fromAgent, opts.fromCredentials, opts.fromOauth]
            .filter((v) => v !== undefined && v !== false).length;
          if (sources !== 1) {
            console.error(
              chalk.red(
                "  Pass exactly one of --from-agent, --from-credentials, --from-oauth.",
              ),
            );
            process.exit(2);
          }
          let credentials: AddAccountCredentials;
          if (opts.fromAgent) credentials = loadCredentialsFromAgent(opts.fromAgent);
          else if (opts.fromCredentials)
            credentials = loadCredentialsFromFile(opts.fromCredentials);
          else credentials = loadCredentialsFromGlobalAccount(label);

          const data = await brokerCall((client) =>
            client.addAccount(label, credentials, opts.replace === true),
          );
          console.log(chalk.green(`  Added "${data.label}" to the broker.`));
          if (typeof data.expiresAt === "number") {
            console.log(chalk.gray(`  Token expires: ${formatExpiry(data.expiresAt)}`));
          }
        },
      ),
    );

  // ── auth list ─────────────────────────────────────────────────────────
  auth
    .command("list")
    .description("List every account known to the broker")
    .option("--json", "Output JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const state = await brokerCall((client) => client.listState());
        if (opts.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        console.log();
        printAccountsTable(state);
        console.log();
      }),
    );

  // ── auth use <label> ──────────────────────────────────────────────────
  auth
    .command("use <label>")
    .description("Set the fleet-wide active account")
    .action(
      withConfigError(async (label: string) => {
        const data = await brokerCall((client) => client.setActive(label));
        console.log(chalk.green(`  Fleet active: ${data.active}`));
        if (data.fanned.length > 0) {
          console.log(
            chalk.gray(`  Re-mirrored to ${data.fanned.length} agent(s): ${data.fanned.join(", ")}`),
          );
        }
      }),
    );

  // ── auth rotate ───────────────────────────────────────────────────────
  auth
    .command("rotate")
    .description("Cycle to the next non-exhausted entry in auth.fallback_order")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const order = config.auth?.fallback_order ?? [];
        if (order.length === 0) {
          console.error(
            chalk.red("  auth.fallback_order is empty — nothing to rotate."),
          );
          process.exit(1);
        }
        const state = await brokerCall((client) => client.listState());
        const current = state.active;
        const exhausted = new Set(
          state.accounts.filter((a) => a.exhausted).map((a) => a.label),
        );
        const startIdx = order.indexOf(current);
        let pick: string | undefined;
        for (let i = 1; i <= order.length; i++) {
          const candidate = order[(startIdx + i) % order.length];
          if (!exhausted.has(candidate)) {
            pick = candidate;
            break;
          }
        }
        if (!pick) {
          console.error(
            chalk.red(
              `  Every account in auth.fallback_order is exhausted. Nothing to roll to.`,
            ),
          );
          process.exit(1);
        }
        if (pick === current) {
          console.log(chalk.gray(`  Already on ${current} — no rotation needed.`));
          return;
        }
        const data = await brokerCall((client) => client.setActive(pick!));
        console.log(chalk.green(`  Rotated to ${data.active}`));
        if (data.fanned.length > 0) {
          console.log(
            chalk.gray(`  Re-mirrored to ${data.fanned.length} agent(s)`),
          );
        }
      }),
    );

  // ── auth rm <label> ───────────────────────────────────────────────────
  auth
    .command("rm <label>")
    .description("Remove an account from the broker")
    .action(
      withConfigError(async (label: string) => {
        const data = await brokerCall((client) => client.rmAccount(label));
        console.log(chalk.green(`  Removed "${data.label}".`));
      }),
    );

  // ── auth show [<agent>] ───────────────────────────────────────────────
  auth
    .command("show [agent]")
    .description("Show broker state — global by default, per-agent when named")
    .option("--json", "Output JSON")
    .action(
      withConfigError(async (agentName: string | undefined, opts: { json?: boolean }) => {
        const state = await brokerCall((client) => client.listState());
        if (opts.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        if (!agentName) {
          console.log();
          printAccountsTable(state);
          printAgentsTable(state);
          printConsumersTable(state);
          console.log();
          return;
        }
        const agent = state.agents.find((a) => a.name === agentName);
        if (!agent) {
          console.error(chalk.red(`  No agent named "${agentName}" in broker view.`));
          process.exit(1);
        }
        printAgentDetail(state, agent);
        console.log();
      }),
    );

  // ── auth refresh [<label>] ────────────────────────────────────────────
  auth
    .command("refresh [label]")
    .description("Force a refresh tick (diagnostic). Without a label, refreshes the fleet active.")
    .action(
      withConfigError(async (label: string | undefined) => {
        const target =
          label ??
          (await brokerCall((client) => client.listState())).active;
        const data = await brokerCall((client) => client.refreshAccount(target));
        console.log(
          chalk.green(
            `  Refreshed ${data.account}` +
              (typeof data.expiresAt === "number"
                ? ` — expires ${formatExpiry(data.expiresAt)}`
                : ""),
          ),
        );
      }),
    );

  // ── auth agent override <agent> <label|--clear> ───────────────────────
  const agentCmd = auth
    .command("agent")
    .description("Per-agent overrides (edge case — fleet active is the default)");

  agentCmd
    .command("override <agent> [label]")
    .description("Pin an agent to a specific account (or --clear to drop the pin)")
    .option("--clear", "Clear an existing override and return to fleet active")
    .action(
      withConfigError(
        async (
          agent: string,
          label: string | undefined,
          opts: { clear?: boolean },
        ) => {
          if (opts.clear) {
            const data = await brokerCall((client) => client.setOverride(agent, null));
            console.log(
              chalk.green(`  Cleared override on ${data.agent} (returned to fleet active).`),
            );
            return;
          }
          if (!label) {
            console.error(
              chalk.red("  Pass a label or --clear."),
            );
            process.exit(2);
          }
          const data = await brokerCall((client) => client.setOverride(agent, label));
          console.log(
            chalk.green(`  ${data.agent} is now pinned to ${data.account}.`),
          );
        },
      ),
    );
}
