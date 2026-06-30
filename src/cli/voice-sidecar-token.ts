/**
 * Voice-sidecar shared-secret provisioning + compose `.env` injection
 * (voice feature PR-B2, the consuming side of src/agents/compose.ts).
 *
 * The generated compose emits `VOICE_SIDECAR_TOKEN: ${VOICE_SIDECAR_TOKEN}`
 * on the `voice-sidecar` service (a docker-compose interpolation, NOT a
 * literal secret — the secret never lands in the committed/generated YAML).
 * docker compose populates `${VOICE_SIDECAR_TOKEN}` from a `.env` file in
 * the same directory as the compose file. This module writes that `.env`.
 *
 * Why a `.env` file and not the LiteLLM `start.sh`-fetches-from-vault
 * pattern: the LiteLLM secret reaches an AGENT container, which runs the
 * `switchroom` CLI and can talk to the vault broker at boot. The
 * voice-sidecar container is a pure-Python faster-whisper server
 * (docker/voice-sidecar/server.py) with NO switchroom CLI and NO broker
 * socket mounted — it reads VOICE_SIDECAR_TOKEN straight from its
 * environment (server.py:65). So the cleanest way to get the vault secret
 * into its env, without baking it into the image or the YAML, is the
 * standard docker-compose `.env` interpolation file, written 0600 at apply
 * time and regenerated on every apply. The TOKEN itself is sourced from the
 * vault (`voice/sidecar-token`), the SAME key the gateway resolves at
 * use-time (src/telegram/materialize-sidecar-token.ts) — single source of
 * truth, both ends agree.
 *
 * Gating: this only runs on a `local` voice verdict (GPU present). On a
 * `cloud` verdict no sidecar service is emitted, so no `.env` is needed —
 * and we proactively remove any stale `.env` so a host that lost its GPU
 * doesn't leave a token lying around.
 *
 * Seeding: if `voice/sidecar-token` doesn't exist yet, generate a random
 * 256-bit hex secret and store it in the vault (operator-attested put,
 * mirroring provisionLiteLLMKeys). Idempotent — a subsequent apply reuses
 * the stored token. Best-effort: any failure is surfaced as a warning and
 * leaves the sidecar without a token (it then 401s every /stt and the
 * gateway falls back to "(voice message)") — never blocks apply.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import chalk from "chalk";

import { composeEnvPath } from "../agents/compose-env.js";
import { loadHostCapabilities } from "../setup/host-capabilities.js";
import { VOICE_SIDECAR_TOKEN_KEY } from "../telegram/materialize-sidecar-token.js";

export { composeEnvPath };

/** The compose `.env` variable name docker interpolates into the service. */
export const VOICE_SIDECAR_TOKEN_ENV = "VOICE_SIDECAR_TOKEN";

export interface ProvisionSidecarTokenCtx {
  writeOut: (s: string) => void;
  writeErr: (s: string) => void;
  /** Operator UID for chowning the `.env` when running under sudo. */
  operatorUid?: number;
  /**
   * Override the voice verdict (testing). When omitted, reads the persisted
   * host-capabilities verdict (defaults to `cloud` when no file exists).
   */
  voiceEngine?: "local" | "cloud";
  /**
   * Resolve the token from the vault, seeding a fresh one if absent.
   * Injectable for tests so they never touch the real broker/vault.
   * Returns the token string, or null on unrecoverable failure.
   */
  resolveOrSeedToken?: () => Promise<string | null>;
}

/**
 * Resolve the sidecar token from the vault, seeding a random one if the key
 * doesn't exist yet. Operator-attested via the same passphrase recovery the
 * LiteLLM provisioner uses. Returns null on any unrecoverable failure.
 */
async function defaultResolveOrSeedToken(
  home: string,
  writeErr: (s: string) => void,
): Promise<string | null> {
  const [{ getViaBrokerStructured, putViaBroker }, { resolveOperatorVaultPassphrase }] =
    await Promise.all([
      import("../vault/broker/client.js"),
      import("./apply.js"),
    ]);

  // Already seeded? Reuse it (idempotent — token is stable across applies).
  try {
    const existing = await getViaBrokerStructured(VOICE_SIDECAR_TOKEN_KEY);
    if (existing.kind === "ok") {
      const entry = existing.entry;
      if (entry.kind === "string" || entry.kind === "binary") return entry.value;
    }
  } catch {
    /* fall through to seeding */
  }

  // Need to seed — requires operator attestation to write a NEW vault key.
  const passphrase = await resolveOperatorVaultPassphrase(home);
  if (passphrase === null) {
    writeErr(
      chalk.yellow(
        `  ⚠ voice: vault passphrase unavailable — cannot seed ${VOICE_SIDECAR_TOKEN_KEY}. ` +
        `Run \`switchroom apply\` interactively (operator console or SWITCHROOM_VAULT_PASSPHRASE) ` +
        `once to provision the sidecar token.\n`,
      ),
    );
    return null;
  }

  const token = randomBytes(32).toString("hex");
  const put = await putViaBroker(
    VOICE_SIDECAR_TOKEN_KEY,
    { kind: "string", value: token },
    { passphrase },
  );
  if (put.kind !== "ok") {
    writeErr(
      chalk.yellow(
        `  ⚠ voice: could not store ${VOICE_SIDECAR_TOKEN_KEY} in the vault ` +
        `(${put.kind}${"code" in put ? `: ${put.code}` : ""}). The sidecar will 401 ` +
        `every /stt until this succeeds.\n`,
      ),
    );
    return null;
  }
  return token;
}

/**
 * Provision the voice-sidecar token and write the compose `.env` so docker's
 * `${VOICE_SIDECAR_TOKEN}` interpolation populates the sidecar's env.
 *
 * No-op (and stale-`.env` cleanup) on a non-`local` verdict. Best-effort:
 * never throws, never blocks apply.
 */
export async function provisionVoiceSidecarToken(
  composePath: string,
  home: string,
  ctx: ProvisionSidecarTokenCtx,
): Promise<void> {
  const engine =
    ctx.voiceEngine ?? loadHostCapabilities()?.voice.engine ?? "cloud";
  const envPath = composeEnvPath(composePath);

  if (engine !== "local") {
    // No sidecar emitted on a cloud verdict — remove any stale token file so
    // a host that lost its GPU doesn't leave the secret on disk. Only touch
    // the file if it exists AND looks like ours (contains our var) so we
    // never clobber an operator-managed compose `.env`.
    try {
      if (existsSync(envPath)) {
        const body = readFileSync(envPath, "utf-8");
        if (body.includes(`${VOICE_SIDECAR_TOKEN_ENV}=`)) rmSync(envPath);
      }
    } catch {
      /* best-effort cleanup */
    }
    return;
  }

  const resolveOrSeed =
    ctx.resolveOrSeedToken ??
    (() => defaultResolveOrSeedToken(home, ctx.writeErr));

  let token: string | null = null;
  try {
    token = await resolveOrSeed();
  } catch (err) {
    ctx.writeErr(
      chalk.yellow(
        `  ⚠ voice: sidecar-token provisioning errored (${(err as Error).message}) — ` +
        `the sidecar will lack a token.\n`,
      ),
    );
    return;
  }
  if (!token) return; // resolveOrSeed already warned.

  try {
    mkdirSync(dirname(envPath), { recursive: true });
    // Upsert just our key — preserve any other lines an operator placed in
    // this `.env` (it becomes a real interpolation surface once the fleet
    // `up` loads it via `--env-file`, see composeEnvFileArgs / #2700). Write
    // 0600 — the token is a secret; the value lives only here, never in YAML.
    // docker does NOT auto-read this file (it's beside the `-f` compose, not
    // in the compose CWD), so the fleet commands pass `--env-file` explicitly.
    let body = "";
    try {
      if (existsSync(envPath)) body = readFileSync(envPath, "utf-8");
    } catch {
      /* unreadable — fall back to a fresh write */
    }
    const line = `${VOICE_SIDECAR_TOKEN_ENV}=${token}`;
    const keyRe = new RegExp(`^${VOICE_SIDECAR_TOKEN_ENV}=.*$`, "m");
    const next = keyRe.test(body)
      ? body.replace(keyRe, line)
      : (body.length > 0 && !body.endsWith("\n") ? body + "\n" : body) +
        line +
        "\n";
    writeFileSync(envPath, next, {
      encoding: "utf-8",
      mode: 0o600,
    });
    // `mode` in writeFileSync only applies when CREATING the file; an
    // upsert over an existing operator `.env` would keep its old (possibly
    // 0644) perms and leave the token world-readable. Force 0600 always.
    chmodSync(envPath, 0o600);
    // Keep operator-owned when written under sudo (mirrors writeComposeFile).
    if (ctx.operatorUid !== undefined && process.geteuid?.() === 0) {
      try {
        chownSync(envPath, ctx.operatorUid, ctx.operatorUid);
      } catch {
        /* best-effort */
      }
    }
    ctx.writeOut(
      chalk.gray(`  Wrote voice-sidecar token to ${envPath} (0600)\n`),
    );
  } catch (err) {
    ctx.writeErr(
      chalk.yellow(
        `  ⚠ voice: could not write ${envPath} (${(err as Error).message}) — ` +
        `the sidecar will lack a token.\n`,
      ),
    );
  }
}
