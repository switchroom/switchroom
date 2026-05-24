import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  fsyncSync,
  openSync,
  closeSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { acquireLock, DEFAULT_LOCK_RETRY_MS, VaultBusyError } from "./flock.js";

/**
 * Filename patterns that saveVault and the migration helper produce
 * alongside `vault.enc`. Compose-gen's parent-dir whitelist consults
 * this list so future write artifacts (rotation spool, audit log,
 * etc.) don't trip the "unexpected files" guard. Update here when
 * adding any new write path that lands a file in the vault dir.
 *
 * Match logic (see compose.ts):
 *   - exact-match: `vault.enc`, `vault.enc.bak`, `vault.enc.tmp`,
 *     `vault.enc.lock`
 *   - regex-match: `^\.vault\.enc\.\d+\.\d+\.tmp$`
 *     (atomicWriteFileSync sibling-tmp pattern)
 *   - exact: `.vault.enc.symlink-tmp` (migration helper)
 *   - file: `vault.enc.lock` (PID-file flock from src/vault/flock.ts;
 *     v0.7.12-v0.7.14 was a directory of the same name from
 *     proper-lockfile — the flock module's acquire path lazily
 *     migrates the dir to a file on first save)
 */
export const KNOWN_VAULT_ARTIFACT_NAMES: ReadonlySet<string> = new Set([
  "vault.enc",
  "vault.enc.bak",
  "vault.enc.tmp",
  "vault.enc.lock", // PID-file flock (file post-v0.7.15, dir pre-v0.7.15)
  ".vault.enc.symlink-tmp",
]);
export const KNOWN_VAULT_ARTIFACT_PATTERNS: ReadonlyArray<RegExp> = [
  // atomicWriteFileSync produces `.vault.enc.<pid>.<ms>.tmp`
  /^\.vault\.enc\.\d+\.\d+\.tmp$/,
];

/** Lock retry budget for saveVault flock acquisition. */
const SAVE_VAULT_LOCK_RETRY_MS = DEFAULT_LOCK_RETRY_MS;

/**
 * scrypt cost parameters. N=2^15=32768 (~32 MB, ~100ms on modern hardware)
 * doubles the historical N=16384 and keeps pace with 2024+ KDF guidance.
 * `maxmem` must be raised accordingly: default is 32 MB, which refuses
 * the higher cost.
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // 128 MB

function atomicWriteFileSync(path: string, data: string, mode: number): void {
  // Write to a sibling temp file then rename. Rename is atomic on the same
  // filesystem, which guarantees readers never see a half-written vault.
  //
  // Issue #1000: when `path` is a symlink (the v0.7.12+ layout has
  // `~/.switchroom/vault.enc -> vault/vault.enc`), a naive `renameSync(tmp,
  // path)` REPLACES the symlink with a regular file, leaving the directory
  // entry orphaned and stale. The broker keeps reading the (untouched)
  // target file, so writes silently don't reach it; the next
  // `switchroom apply` then trips the divergence guard. Resolve the
  // symlink first so the rename targets the underlying file, preserving
  // the layout invariant.
  let effectivePath = path;
  try {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      effectivePath = realpathSync(path);
    }
  } catch {
    // Best-effort introspection: if we can't lstat/realpath (perm
    // error, race, target missing), fall back to the path as given.
    // The downstream write will surface the real failure.
  }
  const dir = dirname(resolve(effectivePath));
  const tmp = resolve(dir, `.${basename(effectivePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode });
    renameSync(tmp, effectivePath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw err;
  }
}

export class VaultError extends Error {
  /**
   * The underlying error, when this VaultError wraps a more specific
   * vault-layer exception (currently only `VaultBusyError` from the
   * flock acquisition path). Consumers that want structured access
   * to lock-contention details (holder PID, acquired-ago, lock path)
   * can `instanceof VaultBusyError` against this field instead of
   * re-parsing the error message.
   *
   * Note: TC39 `Error.prototype.cause` is supported in Node ≥16.9 but
   * we keep an explicit field for IDE clarity and to document the
   * contract — only the flock path sets it.
   */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "VaultError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Format hints for vault entries (issue #172).
 *
 * Stored alongside the value as an opt-in annotation set via
 * `switchroom vault set --format <kind>`.  Consumers can pass
 * `--expect <kind>` at get-time to get an early warning when the stored
 * format does not match what they need.
 *
 * Allowed values:
 *   pem            — PEM-encoded key or certificate (-----BEGIN …-----)
 *   base64-raw-seed — 32-byte raw seed, base64-encoded (no PEM wrapper)
 *   base64         — arbitrary base64-encoded binary (no structural meaning)
 *   json           — UTF-8 JSON text
 *   string         — plain text (the default; no structural meaning)
 */
export type VaultFormatHint =
  | "pem"
  | "base64-raw-seed"
  | "base64"
  | "json"
  | "string";

export const VAULT_FORMAT_HINTS: VaultFormatHint[] = [
  "pem",
  "base64-raw-seed",
  "base64",
  "json",
  "string",
];

/**
 * Per-entry agent scope ACL (issue #8).
 *
 * Controls which agents may read this vault entry via the broker.
 * Evaluated AFTER the existing cron-unit ACL (checkAcl) passes.
 *
 * Semantics:
 *   - Neither allow nor deny set  → all agents may read (current behaviour)
 *   - allow set (non-empty)       → only listed agents may read
 *   - deny set (non-empty)        → listed agents are blocked (checked first)
 *   - deny takes precedence over allow: an agent in both lists is denied
 *
 * Agent names are the agent slug, e.g. "clerk" — the same identity the
 * broker derives from the per-agent socket bind path (path-as-identity).
 */
export interface VaultEntryScope {
  allow?: string[];
  deny?: string[];
}

export type VaultEntry =
  | { kind: "string"; value: string; format?: VaultFormatHint; scope?: VaultEntryScope }
  | { kind: "binary"; value: string; format?: VaultFormatHint; scope?: VaultEntryScope }
  | {
      kind: "files";
      files: Record<string, { encoding: "utf8" | "base64"; value: string }>;
      scope?: VaultEntryScope;
    };

interface VaultFile {
  salt: string;
  iv: string;
  data: string;
  tag: string;
  /** KDF cost parameters. Older vaults omit these; fall back to N=16384. */
  kdf?: { N: number; r: number; p: number };
}

/** Default cost for vaults written before the kdf field existed. */
const LEGACY_SCRYPT_N = 16384;

type StoredSecrets = Record<string, VaultEntry | string>;

interface VaultData {
  secrets: StoredSecrets;
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number } = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

function encrypt(key: Buffer, plaintext: string): { iv: string; data: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    data: encrypted.toString("hex"),
    tag: tag.toString("hex"),
  };
}

function decrypt(key: Buffer, iv: string, data: string, tag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function normalizeEntry(raw: VaultEntry | string): VaultEntry {
  if (typeof raw === "string") {
    return { kind: "string", value: raw };
  }
  return raw;
}

function normalizeSecrets(raw: StoredSecrets): Record<string, VaultEntry> {
  const out: Record<string, VaultEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = normalizeEntry(v);
  }
  return out;
}

/**
 * Validate that a value's content matches the claimed format hint.
 *
 * Returns null on success or an error string describing the mismatch.
 * Only called at `set` time when the caller passes `--format`.
 */
export function validateFormatHint(
  value: string,
  format: VaultFormatHint,
): string | null {
  switch (format) {
    case "pem": {
      const trimmed = value.trim();
      if (
        !trimmed.startsWith("-----BEGIN ") ||
        !trimmed.includes("-----END ")
      ) {
        return `value does not look like PEM (expected -----BEGIN ...-----)`;
      }
      return null;
    }
    case "base64-raw-seed": {
      // Must be valid base64, decoding to 32 bytes (256-bit seed)
      const trimmed = value.trim();
      try {
        const decoded = Buffer.from(trimmed, "base64");
        if (decoded.length !== 32) {
          return `expected a 32-byte base64-raw-seed but decoded to ${decoded.length} bytes`;
        }
      } catch {
        return `value is not valid base64`;
      }
      return null;
    }
    case "base64": {
      const trimmed = value.trim();
      try {
        Buffer.from(trimmed, "base64");
      } catch {
        return `value is not valid base64`;
      }
      return null;
    }
    case "json": {
      try {
        JSON.parse(value);
      } catch {
        return `value is not valid JSON`;
      }
      return null;
    }
    case "string":
      // No structural validation for plain strings
      return null;
    default:
      return null;
  }
}

/**
 * Detect the most likely format of a stored value for mismatch-warning
 * purposes.  This is a best-effort heuristic; it returns the detected
 * VaultFormatHint or null when uncertain.
 */
export function detectFormat(value: string): VaultFormatHint | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN ") && trimmed.includes("-----END ")) {
    return "pem";
  }
  // Try to detect a 32-byte base64 seed (43 or 44 chars with optional = padding)
  if (/^[A-Za-z0-9+/]{43}={0,1}$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) return "base64-raw-seed";
    } catch { /* ignore */ }
  }
  // Try generic base64
  if (/^[A-Za-z0-9+/\n\r]+=*$/.test(trimmed) && trimmed.length > 0) {
    return "base64";
  }
  // Try JSON
  try {
    JSON.parse(value);
    return "json";
  } catch { /* ignore */ }
  return null;
}

export function createVault(passphrase: string, vaultPath: string): void {
  if (existsSync(vaultPath)) {
    throw new VaultError(`Vault file already exists: ${vaultPath}`);
  }

  const dir = dirname(vaultPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const vaultData: VaultData = { secrets: {} };
  const { iv, data, tag } = encrypt(key, JSON.stringify(vaultData));

  const vaultFile: VaultFile = {
    salt: salt.toString("hex"),
    iv,
    data,
    tag,
    kdf: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
  };

  atomicWriteFileSync(vaultPath, JSON.stringify(vaultFile, null, 2), 0o600);
}

export function openVault(
  passphrase: string,
  vaultPath: string
): Record<string, VaultEntry> {
  if (!existsSync(vaultPath)) {
    throw new VaultError(`Vault file not found: ${vaultPath}`);
  }

  let vaultFile: VaultFile;
  try {
    vaultFile = JSON.parse(readFileSync(vaultPath, "utf8"));
  } catch {
    throw new VaultError(`Failed to read vault file: ${vaultPath}`);
  }

  const salt = Buffer.from(vaultFile.salt, "hex");
  const kdfParams = vaultFile.kdf ?? { N: LEGACY_SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const key = deriveKey(passphrase, salt, kdfParams);

  let plaintext: string;
  try {
    plaintext = decrypt(key, vaultFile.iv, vaultFile.data, vaultFile.tag);
  } catch {
    throw new VaultError("Failed to decrypt vault. Wrong passphrase?");
  }

  let vaultData: VaultData;
  try {
    vaultData = JSON.parse(plaintext);
  } catch {
    throw new VaultError("Vault data is corrupted");
  }

  return normalizeSecrets(vaultData.secrets ?? {});
}

export function saveVault(
  passphrase: string,
  vaultPath: string,
  secrets: Record<string, VaultEntry>
): void {
  if (!existsSync(vaultPath)) {
    throw new VaultError(`Vault file not found: ${vaultPath}`);
  }

  // Acquire an exclusive lock before reading the existing vault file so
  // a concurrent writer (broker vs host CLI race window introduced by
  // op:put — see plan v3 §4) doesn't cause a lost update.
  //
  // The lock is a PID-file at `${vaultPath}.lock`. Acquisition is
  // O_CREAT|O_EXCL with the holder's PID written to the file content
  // for forensic readability — closes plan v3 §11's ask for
  // diagnosable busy errors that name the offending writer. See
  // `src/vault/flock.ts` for the full implementation rationale and
  // the v0.7.14 → v0.7.15 sentinel-dir → PID-file migration logic.
  //
  // Retry budget 5s — typical hold time is <100ms for ~38KB encrypt
  // + write. acquireLock surfaces a `VaultBusyError` on timeout with
  // structured holder fields the gateway error-renderer (#972) can
  // format directly without re-parsing the message.
  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = acquireLock(vaultPath, { budgetMs: SAVE_VAULT_LOCK_RETRY_MS }).release;
  } catch (err: unknown) {
    if (err instanceof VaultBusyError) {
      // Wrap with cause so callers retain access to the structured
      // fields (holderPid, heldForMs, lockPath, budgetMs) without
      // re-parsing the message string. Gateway error renderer in
      // #972 reads `.cause` to format the Telegram reply.
      throw new VaultError(err.message, { cause: err });
    }
    throw err;
  }

  try {
    let vaultFile: VaultFile;
    try {
      vaultFile = JSON.parse(readFileSync(vaultPath, "utf8"));
    } catch {
      throw new VaultError(`Failed to read vault file: ${vaultPath}`);
    }

    // Always re-encrypt with the current (strong) KDF params on save —
    // legacy vaults transparently upgrade the first time a secret changes.
    const salt = Buffer.from(vaultFile.salt, "hex");
    const key = deriveKey(passphrase, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    vaultFile.kdf = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

    const vaultData: VaultData = { secrets };
    const { iv, data, tag } = encrypt(key, JSON.stringify(vaultData));

    vaultFile.iv = iv;
    vaultFile.data = data;
    vaultFile.tag = tag;

    atomicWriteFileSync(vaultPath, JSON.stringify(vaultFile, null, 2), 0o600);
  } finally {
    // acquireLock returns a release fn; call it to close the FD and
    // unlink the lock file. Best-effort: a release failure leaves a
    // stale lock file that the next writer's PID-liveness check
    // clears.
    if (releaseLock !== null) {
      try { releaseLock(); } catch { /* */ }
    }
  }
}

/**
 * Test injection seam — exposed here to keep the `acquireVaultLock`
 * helper used by the migration helper (`src/vault/migrate-layout.ts`)
 * consistent with what saveVault itself acquires.
 *
 * Returns a release function. The lock ALSO holds for read-during-
 * migration — the migration helper hashes both old and new paths under
 * the same lock to defeat the broker-writes-between-hashes TOCTOU
 * (plan v3 §2 + R3 round 2).
 */
export function acquireVaultLock(vaultPath: string): () => void {
  // Delegates to the shared PID-file flock so the migration helper
  // and saveVault contend on the same lock shape.
  try {
    return acquireLock(vaultPath, { budgetMs: SAVE_VAULT_LOCK_RETRY_MS }).release;
  } catch (err: unknown) {
    if (err instanceof VaultBusyError) {
      // Wrap with cause so callers retain access to the structured
      // fields (holderPid, heldForMs, lockPath, budgetMs) without
      // re-parsing the message string. Gateway error renderer in
      // #972 reads `.cause` to format the Telegram reply.
      throw new VaultError(err.message, { cause: err });
    }
    throw err;
  }
}

export function setSecret(
  passphrase: string,
  vaultPath: string,
  key: string,
  entry: VaultEntry
): void {
  const secrets = openVault(passphrase, vaultPath);
  secrets[key] = entry;
  saveVault(passphrase, vaultPath, secrets);
}

export function getSecret(
  passphrase: string,
  vaultPath: string,
  key: string
): VaultEntry | null {
  const secrets = openVault(passphrase, vaultPath);
  return secrets[key] ?? null;
}

export function setStringSecret(
  passphrase: string,
  vaultPath: string,
  key: string,
  value: string,
  format?: VaultFormatHint,
  scope?: VaultEntryScope,
): void {
  const entry: VaultEntry = format
    ? { kind: "string", value, format }
    : { kind: "string", value };
  if (scope !== undefined) {
    (entry as { kind: "string"; value: string; format?: VaultFormatHint; scope?: VaultEntryScope }).scope = scope;
  }
  setSecret(passphrase, vaultPath, key, entry);
}

/**
 * Store a binary secret. `value` is expected to be a base64 string —
 * callers convert their bytes (e.g. `buf.toString("base64")`) before
 * passing them in. Retrievers know to `base64 -d` the returned value.
 */
export function setBinarySecret(
  passphrase: string,
  vaultPath: string,
  key: string,
  value: string,
  format?: VaultFormatHint,
  scope?: VaultEntryScope,
): void {
  const entry: VaultEntry = format
    ? { kind: "binary", value, format }
    : { kind: "binary", value };
  if (scope !== undefined) {
    (entry as { kind: "binary"; value: string; format?: VaultFormatHint; scope?: VaultEntryScope }).scope = scope;
  }
  setSecret(passphrase, vaultPath, key, entry);
}

export function getStringSecret(
  passphrase: string,
  vaultPath: string,
  key: string
): string | null {
  const entry = getSecret(passphrase, vaultPath, key);
  if (entry === null) return null;
  if (entry.kind !== "string") {
    throw new VaultError(
      `Secret "${key}" is kind="${entry.kind}", not "string". Use getSecret() for the full entry.`
    );
  }
  return entry.value;
}

export function setFilesSecret(
  passphrase: string,
  vaultPath: string,
  key: string,
  files: Record<string, { encoding: "utf8" | "base64"; value: string }>
): void {
  setSecret(passphrase, vaultPath, key, { kind: "files", files });
}

export function listSecrets(passphrase: string, vaultPath: string): string[] {
  const secrets = openVault(passphrase, vaultPath);
  return Object.keys(secrets);
}

export function removeSecret(
  passphrase: string,
  vaultPath: string,
  key: string
): void {
  const secrets = openVault(passphrase, vaultPath);
  if (!(key in secrets)) {
    throw new VaultError(`Secret not found: ${key}`);
  }
  delete secrets[key];
  saveVault(passphrase, vaultPath, secrets);
}
