/**
 * `switchroom auth` CLI surface — post-RFC-H thin client over the
 * auth-broker UDS.
 *
 * The fleet-wide model collapses what used to be a per-agent verb tree
 * (`auth login / reauth / heal / promote / enable / disable / share /
 * refresh-accounts / status / account add / account list / account rm`)
 * into a small accounts-and-fleet surface:
 *
 *   auth add <label> --from-agent | --from-credentials | --from-oauth | --via-claude
 *   auth list
 *   auth use <label>            — set fleet active
 *   auth rotate                 — cycle to next non-exhausted entry
 *   auth rm <label>
 *   auth show [<agent>]
 *   auth schedule               — per-account 5h vs WEEKLY window + reset day
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
  type AccountState,
  type AddAccountCredentials,
  type AgentState,
  type ConsumerState,
  type ListStateData,
} from "../auth/broker/client.js";
import { brokerCall } from "./broker-call.js";
import {
  accountCredentialsPath,
  readAccountCredentials,
} from "../auth/account-store.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  startAuthSession,
  submitAuthCode,
  cancelAuthSession,
} from "../auth/manager.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import { registerAuthGoogleSubcommands } from "./auth-google.js";
import { registerAuthMicrosoftSubcommands } from "./auth-microsoft.js";
import { registerAuthScheduleSubcommands } from "./auth-schedule.js";
import { setAuthActive } from "./auth-active-yaml.js";
import { atomicWriteFileSync } from "../util/atomic.js";
import { statSync } from "node:fs";

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
 * Warn about a missing refresh token only when the access token is
 * actually expiring soon. Modern Claude Pro/Max subscription OAuth
 * issues long-lived access tokens (~317 days) with NO refresh token by
 * design — this is the current steady state for every subscription-
 * authenticated agent. Emitting a "renew before they expire" warning on
 * every boot for a token valid for ~10 months is noise, not signal.
 *
 * 14 days gives the operator comfortable runway to re-auth before the
 * token lapses while keeping boots quiet for the common long-lived case.
 */
const REFRESH_TOKEN_WARN_WITHIN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

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
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") {
        // The auth-broker writes .credentials.json owned by the
        // per-agent UID, mode 0600. When diagnoseAuthState runs as
        // the operator (not the agent) the read is denied — that is
        // expected and is NOT corruption; the agent process itself
        // can read it. Misreporting EACCES as "malformed" sent
        // operators into a needless re-auth (install-validation
        // 2026-05-17, R9).
        findings.push({
          code: "credentials_unreadable",
          severity: "warn",
          summary:
            "credentials present but owned by the agent UID (mode 0600) — not readable by the operator. The agent can read it; this is not corruption.",
        });
      } else {
        findings.push({
          code: "credentials_malformed",
          severity: "error",
          summary: "credentials file corrupted — send /auth in this chat to reset",
        });
      }
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
        // Only warn about a missing refresh token when the access token
        // is actually expiring soon. Long-lived subscription OAuth tokens
        // (~317 days, no refresh token by design) should not trigger this
        // warning on every boot — it fires only when renewal is genuinely
        // imminent (within REFRESH_TOKEN_WARN_WITHIN_MS).
        const expiresAtValid =
          typeof expiresAt === "number" && Number.isFinite(expiresAt);
        const expiringSoon =
          !expiresAtValid || expiresAt < Date.now() + REFRESH_TOKEN_WARN_WITHIN_MS;
        if ((!oauth.refreshToken || oauth.refreshToken.length === 0) && expiringSoon) {
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
  const onlyUnreadable =
    findings.length > 0 &&
    findings.every((f) => f.code === "credentials_unreadable");
  if (severity !== "ok" && !onlyUnreadable) {
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
    // --via-claude mints the broad scope claude `server:` mode needs
    // (org:create_api_key user:profile user:inference
    // user:sessions:claude_code user:mcp_servers user:file_upload).
    // --from-oauth mints scope=user:inference only — Claude refuses
    // it on boot, so recommending it here just reproduces the
    // failure (install-validation 2026-05-17, R4/R8).
    recommendation.push("  switchroom auth add default --via-claude");
    recommendation.push("");
  } else if (onlyUnreadable) {
    recommendation.push(
      "No action needed. .credentials.json is present and agent-owned; run the check inside the agent container if you need a definitive read.",
    );
  }

  return { severity, findings, recommendation };
}

// ─── Helpers ──────────────────────────────────────────────────────────────
// `dieBrokerUnreachable` / `dieBrokerError` / `brokerCall` previously
// lived here. Phase 3b.3 (RFC G review feedback) extracted them to
// `./broker-call.ts` so the auth-google verbs can reuse the same
// error UX shape — operators see identical "broker unreachable"
// hints and stderr/exit-code discipline regardless of which CLI
// surface they're using.

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

/**
 * Cached-utilization cell. Honesty fix (2026-06-09 incident follow-up):
 * the table previously rendered ONLY the broker exhausted flag, so a
 * 99%-utilized account read "available —" — and an agent verbally
 * parroting `switchroom auth list` under-reported. Shows the broker's
 * cached 5h·7d utilization with its age; "no data" (never probed) is
 * distinct from "not exhausted". The (age) suffix is the staleness
 * disclosure — this is the broker cache, not a live probe.
 */
export function formatQuotaUtilCell(
  a: { last_quota?: { fiveHourUtilizationPct: number; sevenDayUtilizationPct: number; capturedAt: number } | null },
  now: number = Date.now(),
): string {
  const lq = a.last_quota;
  if (!lq) return "no data";
  const ageMs = Math.max(0, now - lq.capturedAt);
  const mins = Math.floor(ageMs / 60_000);
  const ageStr =
    mins < 1 ? "just now"
    : mins < 60 ? `${mins}m ago`
    : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
    : `${Math.floor(mins / 1440)}d ago`;
  const five = Math.round(lq.fiveHourUtilizationPct);
  const seven = Math.round(lq.sevenDayUtilizationPct);
  return `${five}%·${seven}% (${ageStr})`;
}

function printAccountsTable(state: ListStateData): void {
  console.log(
    chalk.bold("  ACCOUNT                           STATUS       EXPIRES    QUOTA 5h·7d          QUOTA-RESET"),
  );
  for (const a of state.accounts) {
    // Status precedence: active > DISABLED (org) > RETIRED > exhausted >
    // available. A retired account (removed from every config list — `!in_service`)
    // and an org-disabled account both linger on disk but must never read
    // "available". `in_service === false` (not `!in_service`) so a pre-field
    // broker, which omits the flag, never falsely retires the fleet.
    const isActive = a.label === state.active;
    const orgBlocked = a.entitlement_blocked === true;
    const retired = a.in_service === false;
    const marker = isActive
      ? chalk.green("●")
      : orgBlocked
        ? chalk.red("⊘")
        : retired
          ? chalk.gray("∅")
          : a.exhausted
            ? chalk.red("!")
            : chalk.gray("✓");
    const status = isActive
      ? chalk.green("active   ")
      : orgBlocked
        ? chalk.red("DISABLED ")
        : retired
          ? chalk.gray("retired  ")
          : a.exhausted
            ? chalk.red("exhausted")
            : "available";
    const label = a.label.padEnd(32);
    const exp = formatExpiry(a.expiresAt).padEnd(10);
    const util = formatQuotaUtilCell(a).padEnd(20);
    const quota = formatQuotaReset(a);
    console.log(`  ${marker} ${label} ${status}    ${exp} ${util} ${quota}`);
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

/**
 * #3185 — render the per-account usage ledger, foregrounding PREMIUM (flagship /
 * Fable) headroom — the operator's "how much Fable is left on each account"
 * question — with the standard tier alongside. Refill-normalized by the broker;
 * `no data` when a tier hasn't been observed (e.g. premium is only probed for
 * the serving set). Purely from the durable ledger — no live probe.
 */
interface UsageCell {
  /** Plain (uncolored) text — pad on THIS, then color, so ANSI escapes never
   *  throw the column width off. */
  plain: string;
  /** Apply the tier's status color to a (possibly padded) string. */
  color: (s: string) => string;
}

function usageHeadroomCell(
  t:
    | {
        headroomPct: number | null;
        walled: boolean;
        refilled: boolean;
        peakUtilizationPct: number | null;
        observations: number;
      }
    | null,
): UsageCell {
  const noColor = (s: string) => s;
  if (t == null) return { plain: "no data", color: chalk.gray };
  if (t.headroomPct == null) return { plain: "unknown", color: chalk.gray };
  const left = Math.round(t.headroomPct);
  const peak = t.peakUtilizationPct == null ? "?" : `${Math.round(t.peakUtilizationPct)}`;
  const base = `${left}% left (peak ${peak}%, n=${t.observations})`;
  if (t.walled) return { plain: `WALLED - ${base}`, color: chalk.red };
  if (t.refilled) return { plain: `refilled - ${base}`, color: chalk.green };
  if (left <= 10) return { plain: base, color: chalk.yellow };
  return { plain: base, color: noColor };
}

function printUsageTable(state: ListStateData): void {
  console.log(
    chalk.bold("  ACCOUNT                           PREMIUM (Fable) HEADROOM                    STANDARD HEADROOM"),
  );
  const WIDTH = 44;
  for (const a of state.accounts) {
    const isActive = a.label === state.active;
    const orgBlocked = a.entitlement_blocked === true;
    const retired = a.in_service === false;
    const marker = isActive
      ? chalk.green("*")
      : orgBlocked
        ? chalk.red("⊘")
        : retired
          ? chalk.gray("∅")
          : " ";
    const label = a.label.padEnd(32);
    // Precedence DISABLED (org) > RETIRED: an out-of-service account's live
    // headroom is meaningless (and misleading — it reads as available), so
    // replace both cells with a single status note rather than a quota bar.
    if (orgBlocked || retired) {
      const note = orgBlocked
        ? chalk.red("DISABLED (org) — no fleet routing")
        : chalk.gray("retired — removed from fleet rotation");
      console.log(`  ${marker} ${label} ${note}`);
      continue;
    }
    const premium = usageHeadroomCell(a.usage_ledger?.premium ?? null);
    const standard = usageHeadroomCell(a.usage_ledger?.standard ?? null);
    // Pad the PLAIN text to a fixed column, THEN color — ANSI escapes can never
    // distort the width this way.
    const premiumCol = premium.color(premium.plain.padEnd(WIDTH));
    const standardCol = standard.color(standard.plain);
    console.log(`  ${marker} ${label} ${premiumCol} ${standardCol}`);
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
  if (
    !("claudeAiOauth" in parsed) ||
    typeof parsed.claudeAiOauth?.accessToken !== "string"
  ) {
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
  if (
    !("claudeAiOauth" in parsed) ||
    typeof parsed.claudeAiOauth?.accessToken !== "string"
  ) {
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
          `  For a first-time setup, use \`switchroom auth add ${label} --via-claude\`\n` +
          `  (drives claude through its native OAuth flow to mint a broader-scope token\n` +
          `  that works with agents running in claude server: mode). \`claude setup-token\`\n` +
          `  mints scope=user:inference only, which is rejected by server: mode at boot.`,
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

/**
 * `--via-claude` entry point. Spawns claude in a tmux session, surfaces
 * the OAuth URL claude itself emits (which requests the broader scope
 * set that server: mode needs), prompts the operator for the pasted
 * code, waits for credentials.json to land, returns it.
 *
 * Lazy-imports the via-claude module so the more common
 * --from-credentials / --from-agent paths don't pay the file-watch +
 * tmux-helper import cost. Mirrors the `auth-google` pattern (Phase
 * 3b.3 of RFC G) of lazy-importing OAuth heavy modules.
 *
 * Install-validation finding #38.
 */
async function loadCredentialsViaClaude(label: string): Promise<AddAccountCredentials> {
  const [{ runViaClaude }, { homedir }, { default: readline }] = await Promise.all([
    import("../auth/via-claude.js"),
    import("node:os"),
    import("node:readline"),
  ]);
  const configDir = join(homedir(), ".switchroom", "accounts", label);

  const result = await runViaClaude({
    configDir,
    promptForCode: async (_url) => {
      // We surface the URL inside runViaClaude (via its log callback).
      // Block here on stdin for the operator's paste.
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await new Promise<string>((resolve) => {
          rl.question("  Paste the code Claude shows you: ", (answer) => resolve(answer));
        });
      } finally {
        rl.close();
      }
    },
  });

  const oauth = result.credentials.claudeAiOauth;
  return {
    claudeAiOauth: {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
      subscriptionType: oauth.subscriptionType,
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
  registerAuthMicrosoftSubcommands(program, auth);
  registerAuthScheduleSubcommands(program, auth);

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
      async (
        agent: string,
        opts: { json?: boolean; configDir?: string },
      ) => {
        // boot-self-test.sh shells this from start.sh BEFORE the
        // switchroom.yaml is reliably reachable (the script runs with
        // a stripped env to mirror the hook sub-process context — see
        // tests/boot-self-test.test.ts). When --config-dir is set, the
        // caller already knows the exact path to inspect; loading
        // global config here just makes `auth heal` ConfigError-out and
        // the boot script swallow the error (its `2>/dev/null` masks it).
        // Skip the config lookup unless we actually need to derive the
        // default config-dir from `<agentsDir>/<agent>/.claude`.
        let configDir = opts.configDir;
        if (configDir === undefined) {
          // Wrap just the config-derivation branch in withConfigError so a
          // human typing `switchroom auth heal foo` without a yaml gets
          // the friendly `chalk.red("Config error: ...")` line rather than
          // an unformatted commander stack trace. boot-self-test always
          // passes --config-dir and bypasses this branch entirely, so the
          // wrapper has no effect on the programmatic path.
          await withConfigError(async () => {
            const config = getConfig(program);
            const agentsDir = resolveAgentsDir(config);
            configDir = join(agentsDir, agent, ".claude");
          })();
        }
        const diag = diagnoseAuthState(configDir!);
        if (opts.json) {
          console.log(JSON.stringify(diag));
        } else {
          console.log(JSON.stringify(diag, null, 2));
        }
      },
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
      "Seed from a freshly-completed `claude setup-token` flow at ~/.switchroom/accounts/<label>/credentials.json. NOTE: setup-token mints scope=user:inference only; the token won't work for agents running in claude server: mode. Prefer --via-claude for first-time setup.",
    )
    .option(
      "--via-claude",
      "Drive `claude` interactively in a tmux session to mint a broader-scope OAuth token (recommended for first-time setup). Spawns claude, surfaces the OAuth URL, accepts your pasted code, ingests the resulting credentials.json. See src/auth/via-claude.ts.",
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
            viaClaude?: boolean;
            replace?: boolean;
          },
        ) => {
          const sources = [
            opts.fromAgent,
            opts.fromCredentials,
            opts.fromOauth,
            opts.viaClaude,
          ].filter((v) => v !== undefined && v !== false).length;
          if (sources !== 1) {
            console.error(
              chalk.red(
                "  Pass exactly one of --from-agent, --from-credentials, --from-oauth, --via-claude.",
              ),
            );
            process.exit(2);
          }
          let credentials: AddAccountCredentials;
          if (opts.fromAgent) credentials = loadCredentialsFromAgent(opts.fromAgent);
          else if (opts.fromCredentials)
            credentials = loadCredentialsFromFile(opts.fromCredentials);
          else if (opts.viaClaude) credentials = await loadCredentialsViaClaude(label);
          else credentials = loadCredentialsFromGlobalAccount(label);

          const data = await brokerCall((client) =>
            client.addAccount(label, credentials, opts.replace === true),
          );
          console.log(chalk.green(`  Added "${data.label}" to the broker.`));
          if (typeof data.expiresAt === "number") {
            console.log(chalk.gray(`  Token expires: ${formatExpiry(data.expiresAt)}`));
          }
          if (opts.viaClaude) {
            console.log();
            console.log(chalk.gray("  Next: enable on the fleet"));
            console.log(chalk.cyan(`    switchroom auth use ${data.label}`));
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

  // ── auth usage ────────────────────────────────────────────────────────
  // #3185 — "how much Fable is left on each account?" answered instantly from
  // the broker's durable per-tier usage ledger (no live probe). Premium
  // (flagship/Fable) headroom is foregrounded; standard tier alongside.
  auth
    .command("usage")
    .description("Per-account premium (Fable) + standard usage headroom, from the durable ledger")
    .option("--json", "Output the raw per-account usage_ledger summaries as JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const state = await brokerCall((client) => client.listState());
        if (opts.json) {
          console.log(
            JSON.stringify(
              state.accounts.map((a) => ({ label: a.label, usage_ledger: a.usage_ledger ?? null })),
              null,
              2,
            ),
          );
          return;
        }
        console.log();
        printUsageTable(state);
        console.log();
        console.log(
          chalk.gray(
            "  Premium = flagship (Fable) 7d_oi tier; standard = 5h/7d. Passive: harvested from probe headers, no extra requests.",
          ),
        );
        console.log(
          chalk.gray(
            "  'X% left' is current (refill-aware); 'peak' is the max over retained history (~48h) and may predate the latest reset.",
          ),
        );
        console.log();
      }),
    );

  // Shared YAML-pin helper for `auth use` and `auth rotate`. Without
  // this, doctor's `auth-broker: fleet active account` check stays red
  // until manual YAML edit (caught live on 2026-05-15 RFC H redeploy).
  // Failure is intentionally soft (yellow warn, command stays exit-0)
  // because the broker is the runtime source of truth — the YAML write
  // is for next-boot persistence and the operator can retry.
  function pinAuthActiveInYaml(label: string, quiet = false): void {
    try {
      const yamlPath = getConfigPath(program);
      const before = readFileSync(yamlPath, "utf-8");
      const after = setAuthActive(before, label);
      if (after !== before) {
        let mode = 0o644;
        try { mode = statSync(yamlPath).mode & 0o777; } catch { /* default */ }
        atomicWriteFileSync(yamlPath, after, mode);
        if (!quiet) {
          console.log(chalk.gray(`  Pinned auth.active: ${label} in ${yamlPath}`));
        }
      }
    } catch (err) {
      console.error(
        chalk.yellow(
          `  ⚠ Could not write auth.active to YAML: ${(err as Error).message}`,
        ),
      );
    }
  }

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
        pinAuthActiveInYaml(data.active);
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
        // Pin the rotation target into YAML so doctor + restart-after-OOM
        // pick up the new active (quiet — the "Rotated to" line above is
        // the operator-facing signal).
        pinAuthActiveInYaml(data.active, true);
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

  // ── auth reauth <agent> ───────────────────────────────────────────────
  // Per-agent OAuth re-auth. RFC-H #1254 removed the CLI registrations
  // (registerReauthCommand/registerCodeCommand/registerCancelCommand,
  // §7.2) but left the engine (src/auth/manager.ts), every caller
  // (telegram-plugin gateway op:reauth / `/auth reauth`), welcome-text,
  // operator-events) and the tests all expecting these verbs — an
  // orphaned-glue regression that broke the whole Telegram reauth flow.
  // These are thin wrappers over the existing, tested manager engine;
  // the credential write stays where claude/the agent already reads it
  // (`<agentDir>/.claude/.credentials.json`).
  auth
    .command("reauth <agent>")
    .description(
      "Start/resume an OAuth re-auth session for an agent; prints the login URL",
    )
    .option(
      "--slot <label>",
      "Target a specific account slot/label instead of the agent's active one",
    )
    .option(
      "--force",
      "Kill any existing session and force a fresh login (use to switch accounts)",
    )
    .action(
      withConfigError(
        async (agent: string, opts: { slot?: string; force?: boolean }) => {
          const config = getConfig(program);
          const agentDir = join(resolveAgentsDir(config), agent);
          const r = startAuthSession(agent, agentDir, {
            force: opts.force,
            slot: opts.slot,
          });
          for (const line of r.instructions) console.log(line);
          // The gateway extracts the URL with /https:\/\/\S+/ from the
          // combined output. startAuthSession's instructions already
          // include the bare URL line; only print it separately if it
          // somehow wasn't folded into the instructions.
          if (
            r.loginUrl &&
            !r.instructions.some((l) => l.includes(r.loginUrl!))
          ) {
            console.log(r.loginUrl);
          }
        },
      ),
    );

  // ── auth code <agent> <code> ──────────────────────────────────────────
  auth
    .command("code <agent> <code>")
    .description(
      "Submit the browser OAuth code to complete a pending `auth reauth`",
    )
    .option("--slot <label>", "Target a specific account slot/label")
    .option(
      "--json",
      "Emit the structured AuthCodeResult as JSON (consumed by the Telegram gateway)",
    )
    .action(
      withConfigError(
        async (
          agent: string,
          code: string,
          opts: { slot?: string; json?: boolean },
        ) => {
          const config = getConfig(program);
          const agentDir = join(resolveAgentsDir(config), agent);
          const r = submitAuthCode(agent, agentDir, code, opts.slot);
          if (opts.json) {
            // Shape pinned by telegram-plugin/gateway/gateway.ts
            // `AuthCodeJsonResult` (execAuthCode parses this). Keep the
            // field set + nullability exactly in sync with that type.
            console.log(
              JSON.stringify({
                completed: r.completed,
                tokenSaved: r.tokenSaved,
                tokenPath: r.tokenPath ?? null,
                outcome: r.outcome ?? null,
                instructions: r.instructions,
              }),
            );
          } else {
            for (const line of r.instructions) console.log(line);
          }
          // Intentionally exits 0 even on a failed/timed-out code: the
          // body (JSON or instructions) carries the actionable outcome
          // and the gateway parses that, not the exit status.
        },
      ),
    );

  // ── auth cancel <agent> ───────────────────────────────────────────────
  auth
    .command("cancel <agent>")
    .description("Cancel a pending `auth reauth` session for an agent")
    .option("--slot <label>", "Target a specific account slot/label")
    .action(
      withConfigError(async (agent: string, opts: { slot?: string }) => {
        const config = getConfig(program);
        const agentDir = join(resolveAgentsDir(config), agent);
        const r = cancelAuthSession(agent, agentDir, opts.slot);
        for (const line of r.instructions) console.log(line);
      }),
    );
}
