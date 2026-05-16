/**
 * `switchroom drive-mcp-launcher` — the in-container MCP `command` that
 * boots upstream `taylorwilsdon/google_workspace_mcp` browserless,
 * fed by switchroom's auth-broker.
 *
 * This is a hidden CLI verb. It is NOT meant to be run by operators
 * directly — it's wired as the `command` of the per-agent `gdrive` MCP
 * entry (see `getGdriveMcpSettingsEntry` in scaffold-integration.ts) and
 * is spawned by Claude Code inside the agent container as the agent UID.
 *
 * ## Why a launcher (and not bare `uvx`)
 *
 * Upstream's OAuth flow is interactive (browser device-code) by default.
 * It runs *browserless* only when ALL of these hold:
 *
 *   - spawned with `--single-user`, AND
 *   - a credentials file is pre-seeded at
 *     `${WORKSPACE_MCP_CREDENTIALS_DIR}/<encoded-email>.json`, AND
 *   - that file has `token: null` + `expiry: null` (forces upstream
 *     down the refresh-token branch — no browser), AND
 *   - none of `MCP_ENABLE_OAUTH21`, `WORKSPACE_MCP_STATELESS_MODE`, or
 *     the service-account env are set (all incompatible with
 *     `--single-user`).
 *
 * The filename is the account email run through Python
 * `urllib.parse.quote(email, safe="@._-")` — for `pixsoul@gmail.com`
 * the file is literally `pixsoul@gmail.com.json`.
 *
 * ## Credential sourcing (fail loud — never spawn with no/stale creds)
 *
 *   1. Google refresh token + scopes + clientId + accountEmail come from
 *      the **auth-broker** via the in-container per-agent socket
 *      (path-as-identity; broker derives the account from
 *      `google_workspace.account` and enforces
 *      `google_accounts.<acct>.enabled_for[]`). The launcher passes NO
 *      account argument.
 *   2. The OAuth `client_secret` is NOT in the broker schema. It is
 *      sourced from `config.google_workspace.google_client_secret` —
 *      either a literal or a `vault:` ref resolved through the
 *      IN-CONTAINER vault-broker (peercred auth, no passphrase prompt).
 *      `google_client_id` is sourced the same way and used as a fallback
 *      only if the broker cred lacks a `clientId`.
 *
 * Any failure (broker unreachable, no Google account, secret
 * unresolvable) exits non-zero with a clear stderr message rather than
 * spawning upstream with bad credentials.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { GOOGLE_WORKSPACE_MCP_PINNED_SHA } from "../memory/scaffold-integration.js";

// ─── Pure, unit-testable core ─────────────────────────────────────────────

/**
 * Encode a Google account email into the credentials filename upstream
 * expects. Upstream uses Python `urllib.parse.quote(email,
 * safe="@._-")`: every byte that is NOT an unreserved char (A-Z a-z 0-9)
 * and NOT one of the explicitly-safe `@ . _ -` is percent-encoded as
 * uppercase `%XX` over the UTF-8 bytes. Space → `%20` (NOT `+` —
 * `quote`, not `quote_plus`).
 *
 * For `pixsoul@gmail.com` nothing needs escaping, so the result is
 * `pixsoul@gmail.com` and the file is `pixsoul@gmail.com.json`.
 */
export function encodeCredentialsFilename(email: string): string {
  const SAFE = new Set<string>([
    // unreserved per RFC 3986 (Python `quote` always keeps these)
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    // explicitly passed safe="@._-"
    "@",
    ".",
    "_",
    "-",
  ]);
  const bytes = Buffer.from(email, "utf8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (b < 0x80 && SAFE.has(ch)) {
      out += ch;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out + ".json";
}

/**
 * Inputs the pure seed-JSON builder needs. `refreshToken`, `clientId`,
 * `scope` come from the broker's Google credentials; `clientSecret`
 * (and `clientId` fallback) from config/vault.
 */
export interface SeedCredentialsInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scope string, exactly as Google / the broker returns it. */
  scope: string;
}

/**
 * The exact on-disk JSON shape upstream `google_workspace_mcp` reads in
 * its `--single-user` refresh branch. `token` and `expiry` MUST be null
 * so upstream refreshes instead of opening a browser. Field order /
 * names mirror upstream's `Credentials.to_json()` so a future upstream
 * strict-parse can't reject it.
 */
export interface SeedCredentialsFile {
  token: null;
  refresh_token: string;
  token_uri: "https://oauth2.googleapis.com/token";
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: null;
}

/**
 * Build the seed credentials object. Pure — no I/O. `scopes` is the
 * scope string split on whitespace with empties dropped.
 */
export function buildSeedCredentials(
  input: SeedCredentialsInput,
): SeedCredentialsFile {
  if (!input.refreshToken) {
    throw new Error("buildSeedCredentials: refreshToken is required");
  }
  if (!input.clientId) {
    throw new Error("buildSeedCredentials: clientId is required");
  }
  if (!input.clientSecret) {
    throw new Error("buildSeedCredentials: clientSecret is required");
  }
  const scopes = input.scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (scopes.length === 0) {
    // Fail loud, consistent with the other required-field guards above.
    // A scopeless seed starts upstream with zero Drive scopes — every
    // tool call then 403s downstream, a deferred/opaque symptom with no
    // signal at the layer that was actually wrong. The broker should
    // never return an empty scope string for a Google credential; if it
    // does, that's the bug to surface, not paper over.
    throw new Error(
      "buildSeedCredentials: scope is required (empty scope string would " +
        "seed upstream with zero Drive scopes — every tool call 403s)",
    );
  }
  return {
    token: null,
    refresh_token: input.refreshToken,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scopes,
    expiry: null,
  };
}

/**
 * Assemble the upstream `uvx` argv. Pure. The pinned SHA is the single
 * shared constant so the scaffold entry and this launcher can never run
 * different upstream revisions.
 *
 *   uvx --from git+https://github.com/taylorwilsdon/google_workspace_mcp.git@<sha> \
 *       workspace-mcp --single-user [--tool-tier <tier>]
 *
 * NB: the executable is `workspace-mcp`, NOT `google-workspace-mcp`.
 * The upstream package is named `workspace-mcp` and provides exactly
 * two entrypoints — `workspace-mcp` (the MCP server) and
 * `workspace-cli`. Passing `google-workspace-mcp` makes uvx exit with
 * "An executable named `google-workspace-mcp` is not provided by
 * package `workspace-mcp`" — verified in-container against the pinned
 * SHA.
 */
// Upstream dependency landmine. `workspace-mcp` pulls a modern
// `fastmcp` whose `oauth_proxy → key_value → filetree` import chain
// imports `aiofile`. `aiofile/version.py` (still, on master) does
// `package_metadata["Author"]`; under the `importlib_metadata`
// backport's #371 behavior change (KeyError on a missing key) and
// aiofile's newer wheels emitting only `Author-email`, that import
// raises `KeyError: 'Author'` and the MCP server never starts. NOT a
// switchroom bug and NOT fixed by repinning workspace-mcp (==1.20.4
// and latest PyPI both crash identically — verified in-container).
// Constraining the leaf package to a version whose wheel metadata
// still carries `Author` defuses it with minimal blast radius (vs.
// pinning the foundational importlib_metadata). `aiofile==3.8.8`
// validated end-to-end in a real agent container: reaches "Starting
// MCP server 'google_workspace' (stdio)". Bump in lockstep with the
// upstream SHA + a re-test of the import+startup path.
// Exported so the test imports the single source of truth instead of
// re-typing the literal — a bump here can't silently pass a stale test.
export const AIOFILE_PIN = "aiofile==3.8.8";

export function buildUvxArgs(tier?: string): string[] {
  const args = [
    "--from",
    `git+https://github.com/taylorwilsdon/google_workspace_mcp.git@${GOOGLE_WORKSPACE_MCP_PINNED_SHA}`,
    // uvx option — must precede the `workspace-mcp` entrypoint positional.
    "--with",
    AIOFILE_PIN,
    "workspace-mcp",
    "--single-user",
  ];
  if (tier && tier.length > 0) {
    args.push("--tool-tier", tier);
  }
  return args;
}

/**
 * Build the child-process environment for upstream. Starts from the
 * current env, points `WORKSPACE_MCP_CREDENTIALS_DIR` at the seed dir,
 * pins `USER_GOOGLE_EMAIL` to the seeded account, and DELETES the env
 * knobs that are incompatible with `--single-user` (so an operator-set
 * or inherited value can't silently break the browserless path).
 *
 * `USER_GOOGLE_EMAIL` is load-bearing, not cosmetic. Upstream
 * single-user resolves auth per tool call by the agent-supplied
 * `user_google_email` arg and, when it doesn't match a seeded file,
 * *refuses to fall back* — it drops to interactive OAuth instead
 * (`get_credentials:951` "no credentials for requested user …; not
 * falling back to another user" → port-8000 bind → fail). The agent's
 * notion of "the user" (e.g. its own operator email) is unrelated to
 * the Google account we seeded. Setting `USER_GOOGLE_EMAIL` makes
 * `core.server` configure that address as THE single user and marks
 * the per-call arg optional (`server.py:106`,
 * `service_decorator.py:78`), so every call authenticates against the
 * seed regardless of what the agent passes. It MUST be the exact same
 * value handed to `writeSeedFile` (the broker's `accountEmail`) — same
 * source ⇒ seed filename and single-user pin can never diverge.
 */
export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  credentialsDir: string,
  accountEmail: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.WORKSPACE_MCP_CREDENTIALS_DIR = credentialsDir;
  env.USER_GOOGLE_EMAIL = accountEmail;
  // Incompatible with --single-user — see upstream. Strip unconditionally.
  delete env.MCP_ENABLE_OAUTH21;
  delete env.WORKSPACE_MCP_STATELESS_MODE;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.WORKSPACE_MCP_SERVICE_ACCOUNT_FILE;
  return env;
}

// ─── I/O helpers (thin) ───────────────────────────────────────────────────

/**
 * Resolve the per-agent credentials directory. Honours an explicit
 * `WORKSPACE_MCP_CREDENTIALS_DIR` if already set in env; otherwise
 * defaults to a per-agent, UID-owned, writable path under the agent
 * state dir (`/state/agent` is the per-agent bind mount, owned by the
 * agent UID inside the container).
 */
export function resolveCredentialsDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.WORKSPACE_MCP_CREDENTIALS_DIR;
  if (explicit && explicit.length > 0) return explicit;
  // /state/agent is the per-agent bind mount (~/.switchroom/agents/<name>),
  // owned by the agent UID — unique per agent and writable. Fall back to
  // HOME for non-container/dev contexts.
  const stateBase = env.SWITCHROOM_CONTAINER === "1" ? "/state/agent" : (env.HOME ?? ".");
  return join(stateBase, "google-workspace-mcp", "credentials");
}

/**
 * Write the seed credentials file as the single file in `dir`, with the
 * dir at 0700 and the file at 0600. Any pre-existing files in the dir
 * are removed first so exactly one credentials file exists (upstream
 * single-user expects exactly one).
 */
export function writeSeedFile(
  dir: string,
  email: string,
  seed: SeedCredentialsFile,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten in case the dir pre-existed with looser perms.
  chmodSync(dir, 0o700);
  // Ensure exactly one file: clear any stale credentials.
  for (const name of readdirSync(dir)) {
    rmSync(join(dir, name), { force: true, recursive: true });
  }
  const filename = encodeCredentialsFilename(email);
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(seed), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

// ─── Broker + config sourcing ─────────────────────────────────────────────

interface BrokerGoogleCreds {
  refreshToken: string;
  clientId: string | undefined;
  accountEmail: string;
  scope: string;
}

/**
 * Pull the agent's Google credentials from the auth-broker. The broker
 * derives the account from config (path-as-identity) and enforces the
 * ACL — we pass NO account. Throws with a clear message on any failure.
 */
async function fetchBrokerGoogleCreds(): Promise<BrokerGoogleCreds> {
  const { withAuthBrokerClient, AuthBrokerError, AuthBrokerUnreachableError } =
    await import("../auth/broker/client.js");
  let data: { account: string; credentials: unknown };
  try {
    data = await withAuthBrokerClient(async (client) => {
      return await client.getCredentials("google");
    });
  } catch (err) {
    if (err instanceof AuthBrokerUnreachableError) {
      throw new Error(
        `auth-broker unreachable (${err.message}). The Google Workspace MCP ` +
          `cannot start without credentials — refusing to spawn upstream. ` +
          `Check the daemon: docker compose -p switchroom ps switchroom-auth-broker`,
      );
    }
    if (err instanceof AuthBrokerError) {
      throw new Error(
        `auth-broker refused Google credentials (${err.code}: ${err.message}). ` +
          `This usually means the agent has no \`google_workspace.account\` set, ` +
          `or is not listed in \`google_accounts.<account>.enabled_for[]\`. ` +
          `Refusing to spawn the Google Workspace MCP.`,
      );
    }
    throw err;
  }
  const creds = data.credentials as
    | { googleOauth?: { refreshToken?: string; clientId?: string; accountEmail?: string; scope?: string } }
    | undefined;
  const g = creds?.googleOauth;
  if (!g || typeof g.refreshToken !== "string" || g.refreshToken.length === 0) {
    throw new Error(
      `auth-broker returned credentials for '${data.account}' without a Google ` +
        `refresh token — refusing to spawn the Google Workspace MCP.`,
    );
  }
  const accountEmail =
    typeof g.accountEmail === "string" && g.accountEmail.length > 0
      ? g.accountEmail
      : data.account;
  return {
    refreshToken: g.refreshToken,
    clientId: typeof g.clientId === "string" && g.clientId.length > 0 ? g.clientId : undefined,
    accountEmail,
    scope: typeof g.scope === "string" ? g.scope : "",
  };
}

/**
 * Resolve a config value that may be a literal or a `vault:` ref. For a
 * literal, returns it. For a `vault:` ref, resolves it through the
 * IN-CONTAINER vault-broker (`getViaBrokerStructured` — peercred auth,
 * NO passphrase prompt; we deliberately do NOT reuse the operator-side
 * resolver which prompts via readHiddenLine). Fails loud with the
 * broker's reason on denial/unreachable.
 */
async function resolveConfigSecret(
  raw: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (raw === undefined || raw.length === 0) return undefined;
  const { isVaultReference, parseVaultReference } = await import(
    "../vault/resolver.js"
  );
  if (!isVaultReference(raw)) return raw;
  const key = parseVaultReference(raw);
  const { getViaBrokerStructured } = await import("../vault/broker/client.js");
  // No socket override — the in-container client resolves
  // SWITCHROOM_VAULT_BROKER_SOCK and authenticates via peercred.
  const result = await getViaBrokerStructured(key);
  if (result.kind === "ok") {
    if (result.entry.kind !== "string") {
      throw new Error(
        `${label} vault entry '${key}' is not a string (kind=${result.entry.kind}) ` +
          `— refusing to spawn the Google Workspace MCP.`,
      );
    }
    return result.entry.value;
  }
  if (result.kind === "not_found") {
    throw new Error(
      `${label} references vault key '${key}' but the vault-broker has no such ` +
        `secret (${result.code}: ${result.msg}). Refusing to spawn the Google ` +
        `Workspace MCP.`,
    );
  }
  if (result.kind === "denied") {
    throw new Error(
      `${label} vault key '${key}' denied by the vault-broker (${result.code}: ` +
        `${result.msg}). The agent's peercred identity is not authorized to ` +
        `read this key. Refusing to spawn the Google Workspace MCP.`,
    );
  }
  throw new Error(
    `${label} vault key '${key}' unreachable via the vault-broker (${result.msg}). ` +
      `Refusing to spawn the Google Workspace MCP.`,
  );
}

interface ConfigSecrets {
  clientId: string | undefined;
  clientSecret: string | undefined;
  tier: string | undefined;
}

/**
 * Load the OAuth client secret (+ id fallback + tier) from
 * switchroom.yaml. Honours `SWITCHROOM_CONFIG` (bind-mounted into the
 * container at /state/config/switchroom.yaml).
 */
async function loadConfigSecrets(): Promise<ConfigSecrets> {
  const { loadConfig } = await import("../config/loader.js");
  const config = loadConfig();
  const gw = config.google_workspace;
  if (!gw) {
    throw new Error(
      `switchroom.yaml has no \`google_workspace:\` block — there is no OAuth ` +
        `client secret to feed the Google Workspace MCP. Refusing to spawn.`,
    );
  }
  const clientId = await resolveConfigSecret(
    gw.google_client_id,
    "google_client_id",
  );
  const clientSecret = await resolveConfigSecret(
    gw.google_client_secret,
    "google_client_secret",
  );
  return { clientId, clientSecret, tier: gw.tier };
}

// ─── Entry ────────────────────────────────────────────────────────────────

/**
 * Run the launcher: source creds, seed the file, exec upstream. On
 * success this REPLACES the process (never returns). On any failure it
 * exits non-zero with a clear stderr message — it never spawns upstream
 * with missing/stale credentials.
 */
export async function runDriveMcpLauncher(opts: {
  tier?: string;
}): Promise<never> {
  let brokerCreds: BrokerGoogleCreds;
  let configSecrets: ConfigSecrets;
  try {
    [brokerCreds, configSecrets] = await Promise.all([
      fetchBrokerGoogleCreds(),
      loadConfigSecrets(),
    ]);
  } catch (err) {
    process.stderr.write(
      `drive-mcp-launcher: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // clientId: broker's value wins; config is the documented fallback.
  const clientId = brokerCreds.clientId ?? configSecrets.clientId;
  if (!clientId) {
    process.stderr.write(
      `drive-mcp-launcher: no OAuth client_id available — the auth-broker cred ` +
        `had none and \`google_workspace.google_client_id\` is unset/empty. ` +
        `Refusing to spawn the Google Workspace MCP.\n`,
    );
    process.exit(1);
  }
  if (!configSecrets.clientSecret) {
    process.stderr.write(
      `drive-mcp-launcher: no OAuth client_secret resolved from ` +
        `\`google_workspace.google_client_secret\`. Refusing to spawn the ` +
        `Google Workspace MCP.\n`,
    );
    process.exit(1);
  }

  let seed: SeedCredentialsFile;
  try {
    seed = buildSeedCredentials({
      refreshToken: brokerCreds.refreshToken,
      clientId,
      clientSecret: configSecrets.clientSecret,
      scope: brokerCreds.scope,
    });
  } catch (err) {
    process.stderr.write(
      `drive-mcp-launcher: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const credentialsDir = resolveCredentialsDir(process.env);
  try {
    writeSeedFile(credentialsDir, brokerCreds.accountEmail, seed);
  } catch (err) {
    process.stderr.write(
      `drive-mcp-launcher: failed to write seed credentials into ` +
        `${credentialsDir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Per-agent tier override (passed via --tier from the scaffold entry)
  // wins over the config top-level tier.
  const tier = opts.tier ?? configSecrets.tier;
  const args = buildUvxArgs(tier);
  const env = buildChildEnv(
    process.env,
    credentialsDir,
    brokerCreds.accountEmail,
  );

  // Replace this process with upstream so Claude Code's MCP stdio
  // transport talks directly to it and signals/exit propagate. Node has
  // no execvp; spawn with stdio:inherit + mirror the child's exit is the
  // idiomatic equivalent for a stdio MCP server.
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const child = spawn("uvx", args, { stdio: "inherit", env });
  child.on("error", (err) => {
    process.stderr.write(
      `drive-mcp-launcher: failed to exec uvx: ${err.message}. Is \`uv\` ` +
        `installed in the agent image?\n`,
    );
    process.exit(127);
  });
  const forward = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig);
    } catch {
      /* child already gone */
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) {
      // Mirror death-by-signal as the conventional 128+n exit.
      const n = os.constants.signals[signal as NodeJS.Signals] ?? 0;
      process.exit(128 + n);
    }
    process.exit(code ?? 0);
  });
  // Never resolves — the process exits via the child 'exit' handler.
  return new Promise<never>(() => {}) as Promise<never>;
}

/**
 * Register the hidden `drive-mcp-launcher` verb. Hidden because it is an
 * internal MCP `command`, not an operator-facing verb (mirrors how
 * other switchroom-internal MCP entries are spawned).
 */
export function registerDriveMcpLauncherCommand(program: Command): void {
  program
    .command("drive-mcp-launcher", { hidden: true })
    .description(
      "Internal: launch the Google Workspace MCP browserless, fed by the " +
        "auth-broker. Spawned as the `gdrive` MCP command inside agents.",
    )
    .option(
      "--tier <tier>",
      "Upstream --tool-tier (core|extended|complete). Overrides config.",
    )
    .action(async (opts: { tier?: string }) => {
      await runDriveMcpLauncher({ tier: opts.tier });
    });
}
