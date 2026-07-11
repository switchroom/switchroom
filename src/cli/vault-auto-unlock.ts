/**
 * Vault auto-unlock setup — shared logic between the
 * `vault broker enable-auto-unlock` CLI command and the `switchroom setup`
 * wizard.
 *
 * The auto-unlock blob is encrypted with a key derived from /etc/machine-id.
 * The broker decrypts it itself at boot — no sudo, no systemd-creds, no
 * polkit, no TPM groups. See `src/vault/auto-unlock.ts` for the crypto and
 * threat model. This module just glues that crypto to the CLI flow:
 *
 *   1. encryptCredential — write the blob to disk (mode 0600).
 *   2. applyAutoUnlock — flip vault.broker.autoUnlock=true in
 *      switchroom.yaml, restart the broker container via
 *      `docker compose restart vault-broker`, poll status to verify the
 *      vault came up unlocked.
 *
 * Pre-v0.7 this module reconciled systemd user units and called
 * `systemctl --user restart switchroom-vault-broker.service`. v0.7
 * dropped the systemd substrate; the orchestration is now Docker
 * Compose. The crypto path is unchanged.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { writeConfigFileSync } from "../util/atomic.js";

import { findConfigFile, loadConfig, resolvePath } from "../config/loader.js";
import { statusViaBroker, resolveBrokerSocketPath } from "../vault/broker/client.js";
import {
  AutoUnlockDecryptError,
  DEFAULT_AUTO_UNLOCK_PATH,
  MachineIdUnavailableError,
  readMachineId,
  writeAutoUnlockFile,
} from "../vault/auto-unlock.js";

export class EncryptFailedError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = "EncryptFailedError";
  }
}

/**
 * Detect whether auto-unlock can be set up on this host. We don't need
 * sudo, polkit, systemd-creds, or any group membership — just a readable
 * machine-id. Returns null on hosts that don't have one.
 */
export function autoUnlockSupported(): { supported: true } | null {
  try {
    readMachineId();
    return { supported: true };
  } catch {
    return null;
  }
}

/**
 * Encrypt the vault passphrase to the configured auto-unlock blob path.
 * Throws EncryptFailedError on machine-id unavailable; the caller is
 * expected to catch and present a clear error.
 *
 * The passphrase is held in this function only as long as it takes to
 * encrypt; we don't keep a reference. (V8 won't let us truly zero a
 * string, but we don't pin it either.)
 */
export function encryptCredential(passphrase: string, credPath: string): void {
  try {
    writeAutoUnlockFile(passphrase, credPath);
  } catch (err) {
    if (err instanceof MachineIdUnavailableError) {
      throw new EncryptFailedError(err.message);
    }
    throw new EncryptFailedError(
      `Failed to write auto-unlock blob to ${credPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Set `vault.broker.autoUnlock: <value>` in the user's switchroom.yaml,
 * preserving comments, key ordering, and surrounding formatting. Mirrors
 * the YAML.parseDocument pattern used by `updateAgentExtendsInConfig` in
 * src/cli/agent.ts.
 */
export function setVaultBrokerAutoUnlock(configPath: string, value: boolean): void {
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  doc.setIn(["vault", "broker", "autoUnlock"], value);
  // Atomic tmp+fsync+rename so a crash/ENOSPC mid-write can never truncate
  // switchroom.yaml (which would take the whole fleet's config with it).
  // writeConfigFileSync is the bind-mount-aware variant: a single-file bind
  // mount of switchroom.yaml rejects rename(2) with EBUSY, in which case it
  // falls back to an in-place fsync'd rewrite. Preserve the file's mode.
  let mode = 0o644;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    /* default 0o644 */
  }
  writeConfigFileSync(configPath, doc.toString(), mode);
}

export interface ApplyOptions {
  configPath?: string;
  log?: (line: string) => void;
  err?: (line: string) => void;
  /**
   * Override the docker compose invocation in tests. Receives the full
   * argv (excluding the `docker` program name itself, e.g.
   * `["compose", "-f", "/path/compose.yaml", "restart", "vault-broker"]`)
   * and returns an object with the exit status. Defaults to a real
   * `spawnSync("docker", ...)` with stdio inherit.
   */
  runDockerCompose?: (args: string[]) => { status: number | null };
  /**
   * Path to the generated docker-compose file. Defaults to
   * `~/.switchroom/compose/docker-compose.yml` — the canonical location
   * emitted by `switchroom apply`.
   */
  composeFile?: string;
  /** Override status polling in tests. */
  pollStatus?: () => Promise<{ unlocked: boolean } | null>;
  /** How long to wait for the broker to come up unlocked. */
  verifyTimeoutMs?: number;
}

const DEFAULT_COMPOSE_FILE = join(homedir(), ".switchroom", "compose", "docker-compose.yml");

/**
 * Flip vault.broker.autoUnlock=true in switchroom.yaml, restart the
 * vault-broker container via docker compose, and poll status to confirm
 * the vault came up unlocked. The whole thing is one call so callers
 * don't have to re-implement the 3-step "Next steps" list.
 *
 * Note that the broker container reads the auto-unlock blob via the
 * bind-mount declared in src/agents/compose.ts. The blob is written
 * by `encryptCredential` BEFORE this function runs; here we just need
 * to bounce the container so the broker re-reads its config + the blob.
 */
export async function applyAutoUnlock(opts: ApplyOptions = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const err = opts.err ?? ((s: string) => console.error(s));
  const runDockerCompose =
    opts.runDockerCompose ??
    ((args: string[]) => spawnSync("docker", args, { stdio: "inherit" }));
  // 10s default — generous enough for cold-cache decrypt on slow boxes,
  // short enough that a real auto-unlock failure surfaces before the user
  // gives up.
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 10000;

  const configPath = opts.configPath ?? findConfigFile();
  const composeFile = opts.composeFile ?? DEFAULT_COMPOSE_FILE;

  setVaultBrokerAutoUnlock(configPath, true);
  log(`✓ Set vault.broker.autoUnlock=true in ${configPath}`);

  // Reload the config from disk so the post-restart status poll can
  // resolve the broker socket from the (possibly relative) configured
  // path. Surfaces parse errors early too.
  const config = loadConfig(configPath);

  const composeArgs = ["compose", "-f", composeFile, "restart", "vault-broker"];
  const restart = runDockerCompose(composeArgs);
  if (restart.status !== 0) {
    err(
      "Broker restart failed. Check:\n" +
        `  docker compose -f ${composeFile} ps vault-broker\n` +
        `  docker compose -f ${composeFile} logs vault-broker`,
    );
    throw new Error(`docker compose restart exited ${restart.status}`);
  }
  log("✓ Restarted vault-broker container (docker compose restart)");

  // Canonical resolver — env first, then config, then legacy fallback.
  // Same shape as the other vault CLI files post-fix.
  const socket = resolveBrokerSocketPath({
    vaultBrokerSocket: config.vault?.broker?.socket
      ? resolvePath(config.vault.broker.socket)
      : undefined,
  });
  const poll = opts.pollStatus ?? (() => statusViaBroker({ socket }));

  const deadline = Date.now() + verifyTimeoutMs;
  while (Date.now() < deadline) {
    const status = await poll();
    if (status?.unlocked) {
      log("✓ Vault unlocked via auto-unlock blob");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  err(
    "Broker restarted but vault did not unlock within " +
      `${verifyTimeoutMs}ms. Check:\n` +
      `  docker compose -f ${composeFile} ps vault-broker\n` +
      `  docker compose -f ${composeFile} logs vault-broker`,
  );
  throw new Error("verification timeout: broker did not unlock");
}

/** Re-export the path constant so the broker CLI doesn't have to import twice. */
export { AutoUnlockDecryptError, DEFAULT_AUTO_UNLOCK_PATH };
