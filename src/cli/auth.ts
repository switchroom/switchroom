import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
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

export type AuthSeverity = "ok" | "warn" | "error" | "critical";

export interface AuthFinding {
  /** Stable identifier (matches boot-self-test fingerprint codes). */
  code: string;
  severity: AuthSeverity;
  summary: string;
}

export interface AuthDiagnosis {
  /** Aggregated severity (max of finding severities). "ok" when no issue. */
  severity: AuthSeverity;
  findings: AuthFinding[];
  /** Operator-readable lines for the recommended next step. */
  recommendation: string[];
}

const SEVERITY_RANK: Record<AuthSeverity, number> = {
  ok: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

/**
 * Inspect the agent's `.credentials.json` and `.oauth-token` and
 * return a structured diagnosis matching the boot-self-test (#427)
 * checks. Pure read; no side effects.
 *
 * Exposed for tests and for the heal CLI verb. The recommendation
 * lines are scoped to what the user can actually do — currently that
 * means `switchroom auth reauth <name>` for any non-ok state, since
 * none of these failure modes are auto-recoverable yet (Phase 1.1
 * adds the OAuth refresh loop that would self-heal `token_expired`
 * when a refreshToken is present).
 */
export function diagnoseAuthState(claudeConfigDir: string): AuthDiagnosis {
  const findings: AuthFinding[] = [];
  const credsPath = join(claudeConfigDir, ".credentials.json");
  const oauthTokenPath = join(claudeConfigDir, ".oauth-token");

  const hasCreds = existsSync(credsPath);
  const hasOauthToken = existsSync(oauthTokenPath);

  // Summary text is the user-facing string surfaced in the boot-self-test
  // issue card on Telegram. It must be ACTIONABLE without docs — see
  // reference/principles.md "docs test." The technical fingerprint is
  // preserved in `code` for forensics; `summary` tells the user what to
  // do. Send /auth in the agent's chat to open the inline auth dashboard
  // (telegram-plugin/auth-dashboard.ts), which has Reauth / Add / Use
  // buttons — no terminal needed.
  if (!hasCreds && !hasOauthToken) {
    findings.push({
      code: "credentials_missing",
      severity: "error",
      summary: "needs first-time login — send /auth in this chat to start the flow",
    });
  } else if (!hasCreds) {
    // `.oauth-token`-only IS switchroom's intended steady state. The
    // auth flow (src/auth/manager.ts:writeOAuthToken + the deliberate
    // `rmSync(credentialsPath(...))` at line 922) explicitly persists
    // ONLY the bearer token; the temp `.credentials.json` written by
    // `claude setup-token` is wiped to prevent state-drift incidents
    // (gymbro 2026-04-25). Hooks that shell `claude -p` get the token
    // via the `CLAUDE_CODE_OAUTH_TOKEN` env var injected at start.sh
    // (and re-injected by `defaultClaudeCliRunner` when the parent
    // strips it) — they never read `.credentials.json`.
    //
    // So `.credentials.json` absence is NOT a problem under
    // switchroom's design. Earlier versions of this diagnoser
    // (inherited from claude CLI's assumptions) flagged it as a warn
    // and told users to `/auth` to fix — but `/auth` produces the
    // same `.oauth-token`-only state, so the warning was unfixable
    // and the user-facing message was a UX dead end. Suppress it.
    //
    // Token-expiry tracking lives in `.oauth-token.meta.json`
    // (createdAt + expiresAt) — that's where any future "your token
    // is about to expire" warning belongs, not in this branch.
  } else {
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
        // Token shape OK; check expiry.
        const expiresAt = oauth.expiresAt;
        if (typeof expiresAt === "number") {
          if (!Number.isFinite(expiresAt)) {
            // NaN / Infinity — same masking concern as #441: silently
            // skipping non-numeric values lets a corrupt creds file
            // appear healthy when it isn't.
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
          // expiresAt present but the wrong type (string/null/object).
          // Pre-fix this branch silently fell through, masking a corrupt
          // creds file as healthy. See #441.
          findings.push({
            code: "credentials_malformed",
            severity: "warn",
            summary: "credentials file has invalid expiry — send /auth in this chat to reset",
          });
        }
        // Refresh token: warn if missing.
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

  // Aggregate severity.
  let severity: AuthSeverity = "ok";
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[severity]) {
      severity = f.severity;
    }
  }

  // Build the recommendation. For now everything routes to reauth —
  // Phase 1.1 will add a programmatic refresh path for the
  // refreshToken-present case.
  const recommendation: string[] = [];
  if (severity === "ok") {
    // No recommendation needed.
  } else {
    // Different prescription depending on what's broken — but the
    // command is the same. The PROSE differs to be actionable.
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
    recommendation.push("  switchroom auth reauth <agent-name>");
    recommendation.push("");
    recommendation.push("Or pass --auto to this command to start the flow now.");
  }

  return { severity, findings, recommendation };
}

/**
 * Suppress the unused-import warning when the build path doesn't
 * statically reference these. Keeps the import list intentional.
 */
void execFileSync;

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

  // switchroom auth heal <name> [--auto]
  //
  // Diagnostic verb for the issue cards (#427, #428): inspects an
  // agent's auth state and prints the specific next step the operator
  // needs. With --auto, kicks off `auth reauth` directly instead of
  // requiring a copy-paste.
  //
  // Mirrors the boot-self-test checks (creds present, not expired,
  // refreshToken present, claude -p works in stripped env) so the
  // diagnosis here matches what the issue card shows. Default mode is
  // read-only — diagnose-only — so an operator can run it from
  // anywhere without side effects.
  auth
    .command("heal <name>")
    .description("Diagnose and (optionally) repair an agent's broken auth state")
    .option("--auto", "Trigger reauth automatically instead of just printing instructions", false)
    .option("--json", "Emit a structured diagnosis instead of prose", false)
    .option(
      "--config-dir <path>",
      "Inspect this CLAUDE_CONFIG_DIR directly instead of resolving from " +
        "switchroom.yaml. Used by boot-self-test and tests where agents may " +
        "not be registered in a yaml file.",
    )
    .action(
      withConfigError(async (
        name: string,
        opts: { auto?: boolean; json?: boolean; configDir?: string },
      ) => {
        // --config-dir bypasses yaml validation. The agent must still
        // be a valid name (used in output), but we don't require a
        // switchroom.yaml entry. --auto is incompatible because the
        // reauth flow requires the registered agentsDir.
        let claudeConfigDir: string;
        let agentDir: string;
        if (opts.configDir) {
          if (opts.auto) {
            console.error(chalk.red("--auto is incompatible with --config-dir; " +
              "the reauth flow needs the agent registered in switchroom.yaml."));
            process.exit(2);
          }
          claudeConfigDir = resolve(opts.configDir);
          agentDir = resolve(claudeConfigDir, "..");
        } else {
          const config = getConfig(program);
          const agentsDir = resolveAgentsDir(config);
          rejectAll(name, "heal");
          requireKnownAgent(config, name);
          agentDir = resolve(agentsDir, name);
          claudeConfigDir = join(agentDir, ".claude");
        }
        const diagnosis = diagnoseAuthState(claudeConfigDir);

        if (opts.json) {
          console.log(JSON.stringify({ agent: name, ...diagnosis }, null, 2));
          if (diagnosis.severity === "critical" || diagnosis.severity === "error") {
            process.exit(2);
          }
          return;
        }

        // Prose output — dim header, then the prescribed action.
        console.log();
        console.log(`  ${chalk.bold(name)}:`);
        for (const finding of diagnosis.findings) {
          const tag =
            finding.severity === "critical" ? chalk.red("[critical]") :
            finding.severity === "error"    ? chalk.red("[error]") :
            finding.severity === "warn"     ? chalk.yellow("[warn]") :
                                              chalk.green("[ok]");
          console.log(`    ${tag} ${finding.summary}`);
        }
        console.log();
        if (diagnosis.severity === "ok") {
          console.log(chalk.green("  ok: Auth healthy - nothing to do."));
          console.log();
          return;
        }

        console.log(chalk.bold("  Recommended next step:"));
        for (const line of diagnosis.recommendation) {
          console.log(`    ${line}`);
        }
        console.log();

        if (opts.auto) {
          console.log(chalk.dim("  --auto specified; kicking off reauth..."));
          console.log();
          // Hand off to the existing reauth flow. We don't try to
          // recover state ourselves — the reauth path is already the
          // authoritative way to bootstrap fresh creds.
          const result = refreshAgent(name, agentDir);
          for (const line of result.instructions) {
            console.log(line);
          }
          console.log();
        } else {
          console.log(chalk.dim("  Pass --auto to start the reauth flow now."));
          console.log();
          // Non-zero exit so callers (issue card resolution flows,
          // CI scripts) can detect a non-healthy state.
          process.exit(2);
        }
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
