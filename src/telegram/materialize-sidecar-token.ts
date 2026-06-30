/**
 * Runtime materialization of the voice-sidecar shared-secret token from
 * the vault (voice feature PR-B2).
 *
 * The LOCAL STT path (engine `local`) authenticates every /stt call to
 * the `voice-sidecar` service with a shared secret. Both ends resolve the
 * SAME secret from the vault at `voice/sidecar-token`:
 *   - the sidecar container gets it via the compose `.env` file that
 *     `switchroom apply` writes (see src/cli/voice-sidecar-token.ts), so
 *     docker's `${VOICE_SIDECAR_TOKEN}` interpolation populates its env;
 *   - the gateway resolves it here, at use-time, through the vault broker
 *     — never reads a plaintext file, never surfaces it into the prompt.
 *
 * This mirrors `materialize-voice-key.ts` (the OpenAI STT key) exactly:
 * resolve `vault:voice/sidecar-token` via the broker, with a
 * direct-decrypt fallback when the broker is unreachable but
 * SWITCHROOM_VAULT_PASSPHRASE is set. Any failure returns null and the
 * gateway caller falls back to the legacy "(voice message)" envelope —
 * voice-in is a UX enhancement, not a critical path.
 */

import { existsSync } from "node:fs";
import { loadConfig, resolvePath } from "../config/loader.js";
import {
  isVaultReference,
  parseVaultReference,
  resolveVaultReferencesViaBroker,
} from "../vault/resolver.js";
import { openVault } from "../vault/vault.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** The vault key holding the voice-sidecar shared secret. */
export const VOICE_SIDECAR_TOKEN_KEY = "voice/sidecar-token";
/** The default `vault:` reference for the sidecar token. */
export const DEFAULT_VOICE_SIDECAR_TOKEN_REF = `vault:${VOICE_SIDECAR_TOKEN_KEY}`;

export interface MaterializeSidecarTokenOpts {
  /** Override the token reference (testing / non-default config). */
  tokenRef?: string;
  /** Pre-loaded config (testing). When omitted, loadConfig() is called. */
  config?: SwitchroomConfig;
  /** Override env reads (testing). */
  env?: NodeJS.ProcessEnv;
  /** Override the broker-resolve function (testing). */
  resolveViaBroker?: typeof resolveVaultReferencesViaBroker;
}

/** Direct vault decrypt fallback (broker unreachable). Mirrors the key helper. */
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
 * Resolve the voice-sidecar shared-secret token. Returns the token string
 * on success, or null on any failure (caller falls back). Never throws,
 * never writes the token to disk.
 */
export async function materializeSidecarToken(
  opts: MaterializeSidecarTokenOpts = {},
  logger: (line: string) => void = (line) => process.stderr.write(line),
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const ref =
    opts.tokenRef && opts.tokenRef.length > 0
      ? opts.tokenRef
      : DEFAULT_VOICE_SIDECAR_TOKEN_REF;

  // Literal (non-vault) token — use directly (testing / edge config).
  if (!isVaultReference(ref)) {
    return ref;
  }

  let config: SwitchroomConfig;
  try {
    config = opts.config ?? loadConfig();
  } catch (err) {
    logger(
      `telegram gateway: voice-in: could not load config to resolve sidecar token: ${(err as Error).message} — falling back\n`,
    );
    return null;
  }

  const resolveViaBroker = opts.resolveViaBroker ?? resolveVaultReferencesViaBroker;

  // Narrow the config so the broker only fetches this one key (reuse the
  // bot_token slot as the carrier, same trick as materialize-voice-key.ts).
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
    `telegram gateway: voice-in: could not resolve sidecar token ${ref} (broker unreachable/denied and no SWITCHROOM_VAULT_PASSPHRASE) — falling back to "(voice message)"\n`,
  );
  return null;
}
