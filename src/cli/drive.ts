/**
 * `switchroom drive connect <agent>` and `switchroom drive disconnect <agent>`.
 *
 * Composes the modules built in RFC C (oauth, vault-slots, onboarding,
 * disconnect) with the kernel-side `waitForApproval` helper from RFC B
 * follow-up so the operator gets a Telegram approval card after a successful
 * Google OAuth and the CLI blocks until they tap.
 *
 * Sourcing of inputs (precedence: env > config, with --approver winning
 * over both for the approver field):
 *   - Google OAuth client id/secret:
 *       env: SWITCHROOM_GOOGLE_CLIENT_ID, SWITCHROOM_GOOGLE_CLIENT_SECRET
 *       config: drive.google_client_id, drive.google_client_secret
 *         (raw strings or 'vault:<key>' refs resolved against the unlocked vault)
 *   - Approver user id (Telegram numeric id, prefixed `user:` per the kernel
 *     canonicalization convention used elsewhere):
 *       --approver flag, OR env SWITCHROOM_APPROVER_USER_ID, OR
 *       config agents.<agent>.drive.approvers (per-agent), OR
 *       config drive.approvers (top-level)
 *
 * Env-only operation is preserved for back-compat — agents that were
 * configured before the `drive:` block existed continue to work unchanged.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { loadConfig, resolvePath } from "../config/loader.js";
import {
  detectHeadless,
  selectInitialTier,
  nextTier,
  requestDeviceCode,
  pollDeviceToken,
  buildOobAuthUrl,
  exchangeOobCode,
  runLoopbackOAuth,
  OAuthTierRejected,
  type OAuthClientConfig,
  type OAuthTier,
  type TokenResponse,
} from "../drive/oauth.js";
import {
  writeRefreshToken,
  writeStatus,
  deleteSlots,
  readRefreshToken,
} from "../drive/vault-slots.js";
import { buildOnboardingCard } from "../drive/onboarding.js";
import { disconnectDrive } from "../drive/disconnect.js";
import {
  waitForApproval,
  type WaitForApprovalResult,
} from "../vault/approvals/wait.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import { getSecret } from "../vault/vault.js";

// ── Exit codes (documented in command help) ──────────────────────────────────
//   0 = success
//   1 = denied (user actively rejected)
//   2 = timeout
//   3 = rate-limited
//   4 = config error (missing env, missing approver, broker unreachable)
// 130 = SIGINT/aborted
const EXIT_OK = 0;
const EXIT_DENIED = 1;
const EXIT_TIMEOUT = 2;
const EXIT_RATE_LIMITED = 3;
const EXIT_ERROR = 4;
const EXIT_ABORTED = 130;

// Default Drive read-only scopes used by the wrapper. Keep in sync with
// onboarding's "Allow my Drive (read-only)" copy.
//
// Re-exported as `DRIVE_READONLY_SCOPES` for the new
// `auth google account add` verb (RFC G Phase 3b.3 de-stub) which
// shares the same OAuth flow.
export const DRIVE_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

// Opt-in write scope set. `drive.file` is least-privilege: it grants
// create + edit ONLY for files the app itself creates (or that the user
// explicitly opens with it) — it does NOT grant edit of arbitrary
// pre-existing user files (that would be the full `drive` scope). The
// read scopes are retained so the collab loop (browse folders, read an
// existing doc, draft a NEW doc next to it) still works. A read grant
// never silently becomes a write grant (RFC D §12) — callers must
// explicitly request these (the `--write` flag on `account add`).
export const DRIVE_WRITE_SCOPES = [
  ...DRIVE_READONLY_SCOPES,
  "https://www.googleapis.com/auth/drive.file",
];
const DEFAULT_SCOPES = DRIVE_READONLY_SCOPES;

// ── Google Workspace API scopes (issue #1663) ────────────────────────────
//
// `drive.file` alone authorizes *Drive*-level create/edit (a Drive file
// object), but native Google **Docs / Sheets / Slides** API calls
// (`documents.batchUpdate`, `spreadsheets.batchUpdate`,
// `presentations.batchUpdate`, and the matching `*.create` /
// `*.get`) each require their own product-specific scope. Without them
// the upstream Google Workspace MCP's Docs/Sheets/Slides tools 403 —
// and upstream then falls back to its OWN browser OAuth on port 8000,
// which is unrecoverable inside a container. These scopes are therefore
// tied to the `--tier` so the token a tier mints can actually drive
// every tool that tier exposes (see `selectGoogleWorkspaceScopes`).
//
// `documents` + `spreadsheets` cover the Docs/Sheets tools present at
// EVERY tier (`core` already exposes them — see GoogleWorkspaceTierSchema
// in src/config/schema.ts). `presentations` covers the Slides tools that
// first appear at `extended`.
//
// Deliberately NOT added here: `calendar`, `gmail.*`, Forms/Tasks/Chat
// scopes. The issue (#1663) scopes the fix to Slides/Docs/Sheets — the
// surfaces explicitly broken today. Calendar/Forms/Tasks/Chat/Gmail are
// a separate, larger scope-expansion decision (Gmail in particular has
// an unresolved per-thread-approval shape — RFC G §5 out-of-scope).
export const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
export const GOOGLE_SHEETS_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets";
export const GOOGLE_SLIDES_SCOPE =
  "https://www.googleapis.com/auth/presentations";

/**
 * The Google Workspace document scopes available at each tier. Tied to
 * the tier→tool mapping in `GoogleWorkspaceTierSchema`:
 *   - core / extended / complete  → Docs + Sheets (core already exposes
 *     these tools)
 *   - extended / complete         → + Slides (first exposed at extended)
 *
 * Pure + exported so the tier→scope contract is unit-pinned alongside
 * the tier→tool contract.
 */
export function workspaceScopesForTier(
  tier: "core" | "extended" | "complete",
): string[] {
  const docScopes = [GOOGLE_DOCS_SCOPE, GOOGLE_SHEETS_SCOPE];
  if (tier === "extended" || tier === "complete") {
    return [...docScopes, GOOGLE_SLIDES_SCOPE];
  }
  return docScopes;
}

/**
 * Pick the OAuth scope set for `auth google account add`. Default is
 * read-only; write is strictly opt-in (RFC D §12 — a read grant must
 * never silently authorize writes). Pure + exported so the
 * default-is-read invariant is unit-pinned.
 *
 * Back-compat shim: this is the pre-#1663 Drive-only selector. New
 * callers should use {@link selectGoogleWorkspaceScopes}, which folds
 * the tier-tied Docs/Sheets/Slides scopes in.
 */
export function selectDriveAccountScopes(write: boolean): string[] {
  return write ? DRIVE_WRITE_SCOPES : DRIVE_READONLY_SCOPES;
}

/**
 * Pick the full OAuth scope set for `auth google account add`, tying the
 * Google Workspace API scopes (Docs / Sheets / Slides) to the `--tier`
 * (issue #1663). The Drive base is always present (read, plus
 * `drive.file` when `write`); the Workspace document scopes are added
 * per {@link workspaceScopesForTier}.
 *
 * Why tie scopes to tier: a tier advertises a set of MCP *tools*, but
 * before #1663 the minted token carried Drive scopes only — so
 * `extended`/`complete` surfaced Slides/Docs/Sheets tools that could
 * never authenticate. Minting the matching scope set means every tool a
 * tier exposes can actually run.
 *
 * Pure + exported so the tier→scope contract is unit-pinned. Tier
 * defaults to `core` (matching `GoogleWorkspaceTierSchema`'s documented
 * default) when unset.
 */
export function selectGoogleWorkspaceScopes(opts: {
  write: boolean;
  tier?: "core" | "extended" | "complete";
}): string[] {
  const base = selectDriveAccountScopes(opts.write);
  const workspace = workspaceScopesForTier(opts.tier ?? "core");
  // De-dup defensively — base and workspace sets are disjoint today but
  // a future scope move shouldn't silently produce a doubled scope
  // string in the consent URL.
  return [...new Set([...base, ...workspace])];
}

export interface DriveCliDeps {
  /** Test seam: substitute the OAuth flow runner. */
  runOAuth?: (
    cfg: OAuthClientConfig,
    tier: OAuthTier,
    env: Record<string, string | undefined>,
  ) => Promise<TokenResponse>;
  /** Test seam: substitute the kernel wait helper. */
  waitForApproval?: typeof waitForApproval;
  /** Test seam: substitute the disconnect helper. */
  disconnectDrive?: typeof disconnectDrive;
  /** Test seam: substitute vault-slot writers. */
  writeRefreshToken?: typeof writeRefreshToken;
  readRefreshToken?: typeof readRefreshToken;
  writeStatus?: typeof writeStatus;
  deleteSlots?: typeof deleteSlots;
  /** Test seam: capture exits without killing the process. */
  exit?: (code: number) => void;
  /** Test seam: capture stdout. */
  log?: (...args: unknown[]) => void;
  /** Test seam: capture stderr. */
  err?: (...args: unknown[]) => void;
  /** Test seam: passphrase resolver (skips the TTY prompt). */
  getPassphrase?: () => Promise<string>;
  /** Test seam: AbortSignal wired in for SIGINT. */
  abortSignal?: AbortSignal;
}

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  } catch {
    return resolvePath("~/.switchroom/vault.enc");
  }
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
        } else if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "\u007F" || char === "\b") {
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

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function defaultGetPassphrase(): Promise<string> {
  const env = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (env) return env;
  const v = await promptHidden("Vault passphrase: ");
  if (!v) throw new Error("Passphrase cannot be empty");
  return v;
}

/**
 * Run the OAuth tier chain (device-code → OOB-paste). Loopback is a future
 * extension; today we surface a helpful error if the headless detection
 * ruled out the only remaining tier.
 */
/**
 * Run the three-tier OAuth flow (device-code → OOB-paste →
 * desktop-loopback) interactively, prompting the operator and
 * returning the resulting TokenResponse.
 *
 * Exported (was private to drive.ts) so the new `auth google account
 * add` verb (RFC G Phase 3b.3 de-stub) can reuse the same flow
 * without duplicating it.
 */
export async function runDriveOAuthFlow(
  cfg: OAuthClientConfig,
  tier: OAuthTier,
  env: Record<string, string | undefined>,
): Promise<TokenResponse> {
  return defaultRunOAuth(cfg, tier, env);
}

async function defaultRunOAuth(
  cfg: OAuthClientConfig,
  tier: OAuthTier,
  env: Record<string, string | undefined>,
): Promise<TokenResponse> {
  let current: OAuthTier | null = tier;
  while (current !== null) {
    try {
      if (current === "device_code") {
        const dc = await requestDeviceCode(cfg);
        console.log();
        console.log(chalk.bold("To authorize this agent, open:"));
        console.log("  " + chalk.cyan(dc.verification_url));
        console.log("And enter the code:");
        console.log("  " + chalk.bold.green(dc.user_code));
        console.log();
        console.log(chalk.dim("Waiting for you to approve..."));
        const tok = await pollDeviceToken(cfg, dc);
        return tok;
      }
      if (current === "oob_paste") {
        const url = buildOobAuthUrl(cfg);
        console.log();
        console.log(chalk.bold("Open this URL in any browser:"));
        console.log("  " + chalk.cyan(url));
        console.log();
        const code = (
          await promptLine("Paste the authorization code Google shows you: ")
        ).trim();
        if (!code) throw new Error("Auth code cannot be empty");
        return await exchangeOobCode(cfg, code);
      }
      if (current === "desktop_loopback") {
        console.log();
        console.log(chalk.bold("Opening your browser to authorize this agent..."));
        const tok = await runLoopbackOAuth(cfg, {
          onAuthUrl: (url, opened) => {
            if (!opened) {
              console.log(
                chalk.yellow(
                  "Could not auto-open a browser. Open this URL manually:",
                ),
              );
            } else {
              console.log(chalk.dim("If your browser didn't open, visit:"));
            }
            console.log("  " + chalk.cyan(url));
            console.log();
            console.log(chalk.dim("Waiting for browser callback..."));
          },
        });
        return tok;
      }
      throw new Error(`Unknown OAuth tier: ${current}`);
    } catch (e) {
      if (e instanceof OAuthTierRejected) {
        console.log(
          chalk.yellow(
            `OAuth tier '${current}' rejected by Google; falling through.`,
          ),
        );
        current = nextTier(current, env);
        continue;
      }
      throw e;
    }
  }
  throw new Error("All OAuth tiers exhausted with no path forward.");
}

interface ConnectArgs {
  agentName: string;
  approver?: string;
}

async function runConnect(args: ConnectArgs, deps: DriveCliDeps): Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const log = deps.log ?? ((...a: unknown[]) => console.log(...a));
  const err = deps.err ?? ((...a: unknown[]) => console.error(...a));

  // 1. Validate agent exists.
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    err(chalk.red(`Config error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }
  if (!config.agents[args.agentName]) {
    err(
      chalk.red(
        `Unknown agent '${args.agentName}'. Known agents: ${Object.keys(config.agents).sort().join(", ") || "(none)"}`,
      ),
    );
    return exit(EXIT_ERROR);
  }

  // 2. Resolve OAuth client + approver.
  //
  // Precedence (env > config) is deliberate: env vars are used for one-off
  // overrides (CI, debugging, emergency rotation) while the config block is
  // the persistent baseline. This also preserves back-compat with operators
  // who set the env vars before the `drive:` block existed.
  //
  // Values from config that look like 'vault:<key>' are resolved AFTER the
  // passphrase prompt below (we don't have the unlocked vault yet here).
  const driveCfg = config.drive;
  const agentDriveCfg = config.agents[args.agentName]?.drive;

  let clientIdRaw = process.env.SWITCHROOM_GOOGLE_CLIENT_ID ?? driveCfg?.google_client_id;
  let clientSecretRaw = process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET ?? driveCfg?.google_client_secret;
  if (!clientIdRaw || !clientSecretRaw) {
    err(
      chalk.red(
        "Error: missing Google OAuth client credentials. Set drive.google_client_id " +
          "and drive.google_client_secret in switchroom.yaml (vault:<key> refs supported), " +
          "or set env vars SWITCHROOM_GOOGLE_CLIENT_ID and SWITCHROOM_GOOGLE_CLIENT_SECRET.",
      ),
    );
    return exit(EXIT_ERROR);
  }

  // Approver: --approver flag > env > per-agent config > top-level config.
  // Per-agent config replaces (does not extend) the top-level approvers list.
  let approver = args.approver ?? process.env.SWITCHROOM_APPROVER_USER_ID ?? "";
  if (!approver) {
    const cfgApprovers = agentDriveCfg?.approvers ?? driveCfg?.approvers;
    if (cfgApprovers && cfgApprovers.length > 0) {
      // Use the first entry. Multi-approver-set is supported by the kernel
      // but the CLI's current model is one approver per connect invocation
      // (any one of the set is sufficient — but we only pass one here for
      // back-compat with the existing wait flow).
      approver = String(cfgApprovers[0]);
    }
  }
  if (!approver) {
    err(
      chalk.red(
        "Error: no approver configured. Pass --approver <user_id>, set " +
          "drive.approvers in switchroom.yaml, or set SWITCHROOM_APPROVER_USER_ID.",
      ),
    );
    return exit(EXIT_ERROR);
  }
  // Validate approver shape: must be numeric Telegram user_id (optionally
  // already prefixed `user:`). Rejecting non-numeric handles avoids the
  // silent "user:ken never matches any decision" failure mode.
  const approverRaw = approver.startsWith("user:")
    ? approver.slice("user:".length)
    : approver;
  if (!/^\d+$/.test(approverRaw)) {
    err(
      chalk.red(
        `Error: --approver must be a numeric Telegram user_id (got '${approver}'). ` +
          "Find your numeric id via @userinfobot or by inspecting an inbound update.",
      ),
    );
    return exit(EXIT_ERROR);
  }
  const approverPrincipal = `user:${approverRaw}`;

  // 3. Resolve passphrase BEFORE OAuth (fail-fast). If the passphrase is
  // wrong, the OAuth flow would otherwise complete and the freshly-minted
  // refresh_token would be lost when the vault write throws.
  const vaultPath = getVaultPath();
  let passphrase: string;
  try {
    passphrase = await (deps.getPassphrase ?? defaultGetPassphrase)();
  } catch (e) {
    err(chalk.red(`Passphrase error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  const writeToken = deps.writeRefreshToken ?? writeRefreshToken;
  const readToken = deps.readRefreshToken ?? readRefreshToken;
  const writeStat = deps.writeStatus ?? writeStatus;
  const deleter = deps.deleteSlots ?? deleteSlots;

  // Verify passphrase against the vault by attempting a slot read. A bad
  // passphrase throws here; a missing slot returns null (also fine). Retry
  // up to 3 times before giving up so the user can recover from typos
  // without losing OAuth progress.
  const envPassphrase = !!process.env.SWITCHROOM_VAULT_PASSPHRASE;
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      readToken({ passphrase, vaultPath, agentUnit: args.agentName });
      break;
    } catch (e) {
      attempts++;
      if (envPassphrase || attempts >= 3) {
        err(
          chalk.red(
            `Passphrase verification failed: ${(e as Error).message}`,
          ),
        );
        return exit(EXIT_ERROR);
      }
      err(
        chalk.yellow(
          `Passphrase rejected (attempt ${attempts}/3). Try again.`,
        ),
      );
      try {
        passphrase = await (deps.getPassphrase ?? defaultGetPassphrase)();
      } catch (pe) {
        err(chalk.red(`Passphrase error: ${(pe as Error).message}`));
        return exit(EXIT_ERROR);
      }
    }
  }

  // 4. If a refresh_token already exists in the vault for this agent (e.g.
  // a prior `connect` was rate_limited at the approval-card stage), skip
  // the OAuth tier entirely and re-fire the approval card.
  let existingToken: string | null = null;
  try {
    existingToken = readToken({
      passphrase,
      vaultPath,
      agentUnit: args.agentName,
    });
  } catch {
    // already handled above; defensive only
    existingToken = null;
  }

  // Resolve any 'vault:<key>' references that came from the config block.
  // Env-supplied values are used as-is (operators set raw values in env).
  const resolveMaybeVaultRef = (raw: string, label: string): string | null => {
    if (!isVaultReference(raw)) return raw;
    const key = parseVaultReference(raw);
    try {
      const entry = getSecret(passphrase, vaultPath, key);
      if (!entry) {
        err(
          chalk.red(
            `Error: ${label} references vault key '${key}' but no such secret is in the vault.`,
          ),
        );
        return null;
      }
      if (entry.kind !== "string") {
        err(
          chalk.red(
            `Error: ${label} vault entry '${key}' is not a string (kind=${entry.kind}).`,
          ),
        );
        return null;
      }
      return entry.value;
    } catch (e) {
      err(
        chalk.red(
          `Error resolving ${label} vault ref '${key}': ${(e as Error).message}`,
        ),
      );
      return null;
    }
  };

  const clientId = resolveMaybeVaultRef(clientIdRaw, "google_client_id");
  if (clientId === null) return exit(EXIT_ERROR);
  const clientSecret = resolveMaybeVaultRef(clientSecretRaw, "google_client_secret");
  if (clientSecret === null) return exit(EXIT_ERROR);

  const oauthCfg: OAuthClientConfig = {
    client_id: clientId,
    client_secret: clientSecret,
    scopes: DEFAULT_SCOPES,
  };

  if (!existingToken) {
    // 5. Pick OAuth tier and run the flow.
    const env = process.env as Record<string, string | undefined>;
    const tier = selectInitialTier(env);
    log(
      chalk.dim(
        `Host detected as ${detectHeadless(env) ? "headless" : "desktop"}; trying ${tier} first.`,
      ),
    );

    let tokens: TokenResponse;
    try {
      const runner = deps.runOAuth ?? defaultRunOAuth;
      tokens = await runner(oauthCfg, tier, env);
    } catch (e) {
      // No vault writes have happened yet — nothing to clean up.
      err(chalk.red(`OAuth failed: ${(e as Error).message}`));
      return exit(EXIT_ERROR);
    }
    if (!tokens.refresh_token) {
      err(
        chalk.red(
          "Google did not return a refresh_token. Re-run with prompt=consent to force one.",
        ),
      );
      return exit(EXIT_ERROR);
    }
    log(chalk.green("OAuth succeeded."));

    // 6. Write refresh token + status to vault.
    try {
      writeToken({
        passphrase,
        vaultPath,
        agentUnit: args.agentName,
        refreshToken: tokens.refresh_token,
      });
      writeStat({
        passphrase,
        vaultPath,
        agentUnit: args.agentName,
        status: "connected",
      });
    } catch (e) {
      err(chalk.red(`Vault write failed: ${(e as Error).message}`));
      return exit(EXIT_ERROR);
    }
  } else {
    log(
      chalk.dim(
        `Existing refresh_token found in vault; skipping OAuth and re-firing the approval card.`,
      ),
    );
  }

  // 5. Fire the approval card and block.
  const card = buildOnboardingCard(args.agentName);
  log();
  log(chalk.bold("Waiting for you to approve in Telegram..."));
  log(chalk.dim(`(scope: ${card.scope}, action: ${card.action})`));

  const ac = new AbortController();
  if (deps.abortSignal) {
    if (deps.abortSignal.aborted) ac.abort();
    else deps.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const sigintHandler = () => ac.abort();
  process.once("SIGINT", sigintHandler);

  let result: WaitForApprovalResult;
  try {
    const wait = deps.waitForApproval ?? waitForApproval;
    result = await wait({
      agent_unit: args.agentName,
      scope: card.scope,
      action: card.action,
      approver_set: [approverPrincipal],
      why: card.body,
      signal: ac.signal,
    });
  } catch (e) {
    process.removeListener("SIGINT", sigintHandler);
    // Defensive: waitForApproval (per upstream/main) returns
    // `{kind:"aborted"}` rather than throwing AbortError, but a future
    // refactor or a non-default sleep impl could change that. Map an
    // AbortError to exit 130, not exit 4.
    if (
      e instanceof Error &&
      (e.name === "AbortError" ||
        (typeof e.message === "string" && e.message.toLowerCase().includes("aborted")))
    ) {
      err(chalk.yellow(`Aborted. Cleaning up local credentials.`));
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ABORTED);
    }
    err(chalk.red(`Approval wait failed: ${(e as Error).message}`));
    deleter({ passphrase, vaultPath, agentUnit: args.agentName });
    return exit(EXIT_ERROR);
  }
  process.removeListener("SIGINT", sigintHandler);

  // 6. Act on the result.
  switch (result.kind) {
    case "decided":
      if (result.state === "granted") {
        log(chalk.green(`✓ Drive connected for ${args.agentName}.`));
        return exit(EXIT_OK);
      }
      err(
        chalk.yellow(
          `Approval denied. Cleaning up local credentials.`,
        ),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_DENIED);
    case "timeout":
      err(
        chalk.yellow(
          `Approval timed out. Re-run \`switchroom drive connect ${args.agentName}\` when ready.`,
        ),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_TIMEOUT);
    case "aborted":
      err(chalk.yellow(`Aborted. Cleaning up local credentials.`));
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ABORTED);
    case "rate_limited":
      err(
        chalk.yellow(
          `Broker rate-limited the request. Retry in ${result.retry_after_ms}ms ` +
            `by re-running \`switchroom drive connect ${args.agentName}\`. ` +
            `Your refresh_token is preserved in the vault — OAuth will be skipped on retry.`,
        ),
      );
      // IMPORTANT: do NOT delete the vault slot here. If we did, the
      // freshly-minted refresh_token would be discarded and the user would
      // have to re-do the Google OAuth flow on retry. Leaving it intact
      // means the next `connect` invocation sees the existing token,
      // skips OAuth, and re-fires only the approval card.
      return exit(EXIT_RATE_LIMITED);
    case "expired":
      err(chalk.yellow(`Approval request expired before decision.`));
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_TIMEOUT);
    case "drift_revoked":
      err(
        chalk.yellow(
          `Approver-set drifted; the request was auto-revoked. Re-run after fixing approver config.`,
        ),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ERROR);
    case "error":
      // `not_operator_verified` is NOT a broker fault: the grant exists and
      // is live, but was not recorded with origin='operator', so it is not
      // proof an operator tapped (it may be the agent's own self-recorded
      // row — see src/vault/approvals/gated-write-policy.ts). Fail closed
      // with an accurate message instead of blaming the broker.
      err(
        result.reason === "not_operator_verified"
          ? chalk.red(
              `Approval was not operator-verified (origin != 'operator' with ` +
                `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE=1). ` +
                `Cleaning up local credentials.`,
            )
          : chalk.red(`Broker error: ${result.reason}`),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ERROR);
  }
}

interface DisconnectArgs {
  agentName: string;
}

async function runDisconnect(
  args: DisconnectArgs,
  deps: DriveCliDeps,
): Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const log = deps.log ?? ((...a: unknown[]) => console.log(...a));
  const err = deps.err ?? ((...a: unknown[]) => console.error(...a));

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    err(chalk.red(`Config error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }
  if (!config.agents[args.agentName]) {
    err(
      chalk.red(
        `Unknown agent '${args.agentName}'. Known agents: ${Object.keys(config.agents).sort().join(", ") || "(none)"}`,
      ),
    );
    return exit(EXIT_ERROR);
  }

  const vaultPath = getVaultPath();
  let passphrase: string;
  try {
    passphrase = await (deps.getPassphrase ?? defaultGetPassphrase)();
  } catch (e) {
    err(chalk.red(`Passphrase error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  const dis = deps.disconnectDrive ?? disconnectDrive;
  let result;
  try {
    result = await dis({
      passphrase,
      vaultPath,
      agentUnit: args.agentName,
    });
  } catch (e) {
    err(chalk.red(`Disconnect failed: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  const grev =
    result.google_revoke === "ok"
      ? chalk.green("ok")
      : result.google_revoke === "skipped"
        ? chalk.dim("skipped (no token)")
        : chalk.yellow(
            `failed:${result.google_revoke_detail ?? "unknown"} — visit https://myaccount.google.com/permissions to confirm`,
          );

  log(
    `Disconnected gdrive for ${chalk.bold(args.agentName)} ` +
      `(local: ${result.local_revoked ? chalk.green("ok") : chalk.red("failed")}, ` +
      `Google revoke: ${grev})`,
  );
  return exit(EXIT_OK);
}

export function registerDriveCommand(program: Command, deps: DriveCliDeps = {}): void {
  const drive = program
    .command("drive")
    .description("Manage Google Drive OAuth + approval bindings for agents");

  drive
    .command("connect <agent>")
    .description(
      "Run Google OAuth for <agent>, persist refresh token to vault, then " +
        "block on a Telegram approval card. Recommended: configure the `drive:` " +
        "block in switchroom.yaml (google_client_id, google_client_secret — " +
        "vault:<key> refs supported — and approvers list). Env vars " +
        "SWITCHROOM_GOOGLE_CLIENT_ID / SWITCHROOM_GOOGLE_CLIENT_SECRET / " +
        "SWITCHROOM_APPROVER_USER_ID still work and override the config block.",
    )
    .option(
      "--approver <user_id>",
      "Telegram user id (numeric, or `user:<id>`) authorized to approve the onboarding card.",
    )
    .addHelpText(
      "after",
      [
        "",
        "Exit codes:",
        "  0  success",
        "  1  denied (user actively rejected)",
        "  2  approval timed out / expired",
        "  3  rate-limited by broker (retry preserves refresh_token)",
        "  4  config error (missing env, missing approver, broker unreachable)",
        "  130 aborted (SIGINT)",
      ].join("\n"),
    )
    .action(async (agent: string, opts: { approver?: string }) => {
      await runConnect({ agentName: agent, approver: opts.approver }, deps);
    });

  drive
    .command("disconnect <agent>")
    .description(
      "Killswitch: delete the local refresh token + status slot for <agent>, " +
        "then best-effort-revoke the token at Google. Always exits 0 on local " +
        "cleanup success even if Google revoke fails.",
    )
    .action(async (agent: string) => {
      await runDisconnect({ agentName: agent }, deps);
    });
}

// Exported for tests.
export const __test = {
  runConnect,
  runDisconnect,
  defaultRunOAuth,
};
