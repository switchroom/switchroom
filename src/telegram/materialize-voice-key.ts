/**
 * Runtime materialization of the voice-transcription (STT) provider API
 * key from the vault.
 *
 * PR-A of the staged voice feature: the gateway's voice-in path used to
 * read the STT key from a plaintext file (`~/.switchroom/openai-api-key`),
 * while the CLI `enable voice-in` already vault-stored it under
 * `openai/api-key` and wrote `api_key: vault:openai/api-key` into the
 * yaml. That seam was a no-op vault ref + a hand-placed plaintext file.
 *
 * This helper closes it: it resolves the `voice_in.api_key` reference
 * through the vault broker (with a direct-decrypt fallback when the
 * broker is unreachable but SWITCHROOM_VAULT_PASSPHRASE is set), the same
 * way `materialize-bot-token.ts` resolves the bot token. The resolved key
 * is returned to the caller and held in memory only — it is NEVER written
 * to disk or surfaced into the agent-facing prompt / any agent-readable
 * file. Voice-in is a UX enhancement, not a critical path, so resolution
 * failure returns null (the caller falls back to the `(voice message)`
 * envelope) rather than throwing.
 *
 * Resolution order for the configured reference (default
 * `vault:openai/api-key`):
 *   1. literal string (not a `vault:` ref) → use directly.
 *   2. `vault:<key>` → broker, then direct vault decrypt with
 *      SWITCHROOM_VAULT_PASSPHRASE if the broker is unreachable.
 */

import { existsSync } from "node:fs";
import { loadConfig, resolvePath } from "../config/loader.js";
import { isVaultReference, parseVaultReference, resolveVaultReferencesViaBroker } from "../vault/resolver.js";
import { openVault } from "../vault/vault.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** The default STT key vault reference when `voice_in.api_key` is unset. */
export const DEFAULT_VOICE_API_KEY_REF = "vault:openai/api-key";

export interface MaterializeVoiceKeyOpts {
  /**
   * The configured `voice_in.api_key` value (a literal key or a
   * `vault:<key>` reference). When undefined/empty, defaults to
   * DEFAULT_VOICE_API_KEY_REF.
   */
  apiKeyRef?: string;
  /** Pre-loaded config (testing). When omitted, loadConfig() is called. */
  config?: SwitchroomConfig;
  /** Override env reads (testing). */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the broker-resolve function (testing). Defaults to the real
   * `resolveVaultReferencesViaBroker`.
   */
  resolveViaBroker?: typeof resolveVaultReferencesViaBroker;
}

/**
 * Try to resolve a `vault:<key>` reference WITHOUT going through the broker —
 * decrypt the vault file directly using SWITCHROOM_VAULT_PASSPHRASE. Mirrors
 * the bot-token helper's fallback.
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
 * Resolve the voice-transcription API key. Returns the resolved key string
 * on success, or null on any failure (so the caller can fall back to the
 * `(voice message)` envelope). Never throws, never writes the key to disk.
 *
 * @param logger Optional stderr-style log sink for diagnostics. Defaults to
 *               process.stderr.write.
 */
export async function materializeVoiceKey(
  opts: MaterializeVoiceKeyOpts = {},
  logger: (line: string) => void = (line) => process.stderr.write(line),
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const ref =
    opts.apiKeyRef && opts.apiKeyRef.length > 0
      ? opts.apiKeyRef
      : DEFAULT_VOICE_API_KEY_REF;

  // Literal (non-vault) key — use directly. Discouraged but supported.
  if (!isVaultReference(ref)) {
    return ref;
  }

  let config: SwitchroomConfig;
  try {
    config = opts.config ?? loadConfig();
  } catch (err) {
    logger(
      `telegram gateway: voice-in: could not load config to resolve api key: ${(err as Error).message} — falling back\n`,
    );
    return null;
  }

  const resolveViaBroker = opts.resolveViaBroker ?? resolveVaultReferencesViaBroker;

  // Narrow the config so the broker only fetches this one key and unrelated
  // vault: refs elsewhere in the config can't fail this resolution.
  const brokerResult = await resolveViaBroker({
    ...config,
    telegram: {
      ...config.telegram,
      bot_token: ref,
    } as SwitchroomConfig["telegram"],
    agents: {} as SwitchroomConfig["agents"],
  });

  if (brokerResult.ok) {
    const resolved = brokerResult.config.telegram?.bot_token;
    if (resolved && !isVaultReference(resolved)) {
      return resolved;
    }
    // ok but still a ref — shouldn't happen; fall through to direct decrypt.
  } else {
    logger(
      `telegram gateway: voice-in: vault broker could not resolve ${ref} (reason=${brokerResult.reason}) — trying direct decrypt / falling back\n`,
    );
  }

  const direct = tryDirectVaultRead(ref, config, env.SWITCHROOM_VAULT_PASSPHRASE);
  if (direct) {
    return direct;
  }

  logger(
    `telegram gateway: voice-in: could not resolve STT key ${ref} (broker unreachable/denied and no SWITCHROOM_VAULT_PASSPHRASE) — falling back to "(voice message)"\n`,
  );
  return null;
}
