/**
 * Runtime materialization of TELEGRAM_BOT_TOKEN from the vault.
 *
 * Issue #758: the persistent telegram gateway previously required the
 * bot token to be present in `<agent>/telegram/.env`. When the
 * operator's switchroom.yaml stores the token as a `vault:` reference
 * there is no plaintext to copy into .env, so cold restarts of the
 * gateway died with "TELEGRAM_BOT_TOKEN required".
 *
 * This helper resolves the token from the vault at startup and exposes it
 * via `process.env.TELEGRAM_BOT_TOKEN` IN-MEMORY ONLY — it never writes the
 * resolved value back to disk.
 *
 * Resolution order:
 *   1. `process.env.TELEGRAM_BOT_TOKEN` (preserves existing plaintext-.env
 *      and explicit env-var overrides; also makes this helper a no-op).
 *   2. The agent-scoped or global `bot_token` field in switchroom.yaml:
 *        - literal string  → use directly
 *        - "vault:<key>"   → resolve via broker, then fall back to a direct
 *                            vault decrypt with SWITCHROOM_VAULT_PASSPHRASE
 *                            if the broker is unreachable.
 *
 * Failure modes are surfaced with actionable messages — the gateway used to
 * tell users to "set TELEGRAM_BOT_TOKEN in .env" even when the actual fix
 * was `switchroom vault unlock`.
 */

import { existsSync } from "node:fs";
import { loadConfig, resolvePath } from "../config/loader.js";
import { isVaultReference, parseVaultReference, resolveVaultReferencesViaBroker } from "../vault/resolver.js";
import { openVault } from "../vault/vault.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { isDockerRuntime } from "../runtime-mode.js";

export class BotTokenMaterializeError extends Error {
  constructor(message: string, public readonly reason: "locked" | "unreachable" | "denied" | "not_found" | "config" | "unknown") {
    super(message);
    this.name = "BotTokenMaterializeError";
  }
}

export interface MaterializeOpts {
  /** Agent name (from SWITCHROOM_AGENT_NAME) — selects per-agent override. */
  agentName?: string;
  /** Pre-loaded config (testing). When omitted, loadConfig() is called. */
  config?: SwitchroomConfig;
  /** Override env reads (testing). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Pick the effective bot_token string from config. Per-agent override wins
 * over the global `telegram.bot_token` (matches schema.ts:776 contract).
 */
function pickConfiguredToken(
  config: SwitchroomConfig,
  agentName?: string,
): string | undefined {
  if (agentName) {
    const agent = config.agents?.[agentName] as { bot_token?: string } | undefined;
    if (agent?.bot_token && agent.bot_token.length > 0) {
      return agent.bot_token;
    }
  }
  return config.telegram?.bot_token;
}

/**
 * Try to resolve a `vault:<key>` reference WITHOUT going through the broker —
 * decrypt the vault file directly using SWITCHROOM_VAULT_PASSPHRASE. This is
 * the same fallback the install-time `resolveOrPromptToken` uses
 * (src/cli/setup.ts:373).
 */
function tryDirectVaultRead(
  ref: string,
  config: SwitchroomConfig,
  passphrase: string | undefined,
): string | null {
  if (!passphrase) return null;
  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  if (!existsSync(vaultPath)) return null;
  try {
    const secrets = openVault(passphrase, vaultPath);
    const key = parseVaultReference(ref);
    const entry = secrets[key];
    if (!entry) return null;
    if (entry.kind === "string" || entry.kind === "binary") return entry.value;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the bot token and (if found) set process.env.TELEGRAM_BOT_TOKEN
 * in-memory. Returns the resolved token, or throws BotTokenMaterializeError
 * with a structured `reason` so the caller can print an actionable message.
 *
 * Idempotent: if TELEGRAM_BOT_TOKEN is already set, returns it unchanged.
 */
export async function materializeBotToken(opts: MaterializeOpts = {}): Promise<string> {
  const env = opts.env ?? process.env;

  // Step 1 — env-set token wins (back-compat; plaintext-.env path).
  const fromEnv = env.TELEGRAM_BOT_TOKEN;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  // Step 2 — load config.
  let config: SwitchroomConfig;
  try {
    config = opts.config ?? loadConfig();
  } catch (err) {
    throw new BotTokenMaterializeError(
      `Bot token not in env and switchroom.yaml could not be loaded: ${(err as Error).message}`,
      "config",
    );
  }

  const configured = pickConfiguredToken(config, opts.agentName);
  if (!configured || configured.length === 0) {
    throw new BotTokenMaterializeError(
      "Bot token not in env and not configured in switchroom.yaml (telegram.bot_token).",
      "config",
    );
  }

  // Step 3 — literal config token: use it directly. No vault touch.
  if (!isVaultReference(configured)) {
    if (process.env === env) {
      process.env.TELEGRAM_BOT_TOKEN = configured;
    }
    return configured;
  }

  // Step 4 — vault reference. Try broker first, then direct decrypt fallback.
  const brokerResult = await resolveVaultReferencesViaBroker({
    ...config,
    // Narrow the config to just the bot_token reference so the broker only
    // has to fetch one key (and we don't accidentally surface unrelated
    // failures from other vault: refs in the config).
    telegram: { ...config.telegram, bot_token: configured } as SwitchroomConfig["telegram"],
    agents: {} as SwitchroomConfig["agents"],
  });

  if (brokerResult.ok) {
    const resolved = brokerResult.config.telegram?.bot_token;
    if (resolved && !isVaultReference(resolved)) {
      if (process.env === env) {
        process.env.TELEGRAM_BOT_TOKEN = resolved;
      }
      return resolved;
    }
    // Broker returned ok but token is still a vault ref — shouldn't happen,
    // fall through to the direct-decrypt path.
  }

  if (!brokerResult.ok && brokerResult.reason === "locked") {
    throw new BotTokenMaterializeError(
      "Bot token is a vault reference but vault is locked. Run: switchroom vault unlock",
      "locked",
    );
  }

  if (!brokerResult.ok && brokerResult.reason === "denied") {
    throw new BotTokenMaterializeError(
      `Bot token resolution denied by vault broker (ACL). Check that this unit is authorised for the bot_token key in switchroom.yaml.`,
      "denied",
    );
  }

  if (!brokerResult.ok && brokerResult.reason === "not_found") {
    throw new BotTokenMaterializeError(
      `Bot token vault key not found: ${configured}`,
      "not_found",
    );
  }

  // unreachable / unknown — try the --no-broker direct-decrypt fallback
  // (matches the install-time pattern in src/cli/setup.ts:373).
  const direct = tryDirectVaultRead(configured, config, env.SWITCHROOM_VAULT_PASSPHRASE);
  if (direct) {
    if (process.env === env) {
      process.env.TELEGRAM_BOT_TOKEN = direct;
    }
    return direct;
  }

  // Docker mode and host shell each have a different "unlock from
  // here" surface. Tell the operator the path that actually works in
  // their context — under v0.7 docker, `switchroom vault broker unlock`
  // talks to the operator socket; if THAT is unreachable, the broker
  // container itself is down and needs to be brought up first.
  const unlockHint = isDockerRuntime()
    ? "Bring up the project (docker compose -p switchroom up -d), then `switchroom vault broker unlock` (or `docker exec -it switchroom-vault-broker switchroom vault broker unlock`), or set SWITCHROOM_VAULT_PASSPHRASE."
    : "Start the broker (switchroom vault unlock) or set SWITCHROOM_VAULT_PASSPHRASE.";
  throw new BotTokenMaterializeError(
    `Bot token is a vault reference (${configured}) but vault broker is unreachable and no SWITCHROOM_VAULT_PASSPHRASE is available for direct decrypt. ` +
    unlockHint,
    brokerResult.ok ? "unknown" : brokerResult.reason,
  );
}
