/**
 * Vault auto-unlock — machine-bound encryption of the vault passphrase.
 *
 * The broker needs the vault passphrase at boot, before any human is around
 * to type it. This module encrypts the passphrase against a key derived from
 * `/etc/machine-id` and writes it to a small file under the user's config
 * dir. At broker start the same derivation reproduces the key, decrypts the
 * file, and the passphrase unlocks the vault. No systemd-creds, no polkit,
 * no TPM, no sudo, no privileged daemon — works identically on every Linux
 * distro that has /etc/machine-id (which is all of them since ~2014).
 *
 * ## Threat model
 *
 * What this protects against:
 *   - **Disk theft.** The encryption key is derived from /etc/machine-id,
 *     which is per-machine and not stored on the data disk in a portable
 *     form. An attacker who steals just the disk image (or copies the home
 *     directory) cannot decrypt the auto-unlock blob on a different machine.
 *   - **Casual snooping by other UNIX users on the same box.** The blob
 *     lives at mode 0600 in the user's home; only the owning user (and root)
 *     can read it.
 *
 * What this does NOT protect against:
 *   - **Root on the same machine.** Root can read /etc/machine-id and the
 *     blob; this is by design and matches every comparable system (gpg-agent,
 *     ssh-agent, gnome-keyring, systemd-creds host scope).
 *   - **The user account being compromised.** Same as the vault itself —
 *     the attacker who can read your home can read the vault.
 *
 * Why machine-id and not TPM? TPM2 sealing is stronger, but it's also
 * fragile across kernel updates, firmware changes, and bare-metal moves —
 * and on Ubuntu it requires the user to be in the `tss` group, which they
 * usually aren't. Machine-id is universal, never breaks, and gives the same
 * "blob alone is useless" property for the disk-theft threat. We trade
 * theoretical strength against TPM-clearing attacks for in-practice
 * reliability across thousands of boxes.
 *
 * ## File format (v1)
 *
 *   offset  size  field
 *   0       1     version (always 0x01)
 *   1       16    salt (random per-encryption)
 *   17      12    AES-GCM nonce (random per-encryption)
 *   29      N     ciphertext + 16-byte GCM auth tag
 *
 * Total = 29 + len(passphrase) + 16 bytes.
 */

import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FORMAT_VERSION = 0x01;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HKDF_INFO = "switchroom-vault-auto-unlock-v1";

const MACHINE_ID_PRIMARY = "/etc/machine-id";
// On systems without systemd (or where /etc/machine-id is missing), fall back
// to dbus's mirror file. Both are written once at install and persist for the
// life of the install.
const MACHINE_ID_FALLBACK = "/var/lib/dbus/machine-id";

export class MachineIdUnavailableError extends Error {
  constructor() {
    super(
      `Cannot derive machine-bound key: neither ${MACHINE_ID_PRIMARY} nor ` +
        `${MACHINE_ID_FALLBACK} is readable. Auto-unlock requires a stable ` +
        `machine identifier. On a fresh install, run \`systemd-machine-id-setup\` ` +
        `or boot once to populate it.`,
    );
    this.name = "MachineIdUnavailableError";
  }
}

export class AutoUnlockDecryptError extends Error {
  constructor(public readonly reason: "tag-mismatch" | "format" | "io") {
    super(
      reason === "tag-mismatch"
        ? "Auto-unlock blob failed to decrypt — likely bound to a different " +
          "machine-id. Re-run `switchroom vault broker enable-auto-unlock` to refresh."
        : reason === "format"
          ? "Auto-unlock blob is malformed (wrong length or version)."
          : "Auto-unlock blob could not be read.",
    );
    this.name = "AutoUnlockDecryptError";
  }
}

/**
 * Read the machine-id from the standard locations. Returns the raw 32-char
 * hex string with any trailing newline stripped. Throws
 * MachineIdUnavailableError when neither file exists or is readable.
 *
 * Exported so tests can stub via vi.mock.
 */
export function readMachineId(): string {
  // Test-only override. Honored ONLY under a vitest / NODE_ENV=test
  // process (so a hostile or careless prod env var cannot downgrade
  // machine-binding by injecting a known value). Production behaviour
  // — read /etc/machine-id — is unchanged. The file-helper tests
  // need a deterministic machine-id without mocking node:fs; setting
  // this var to a fixed hex value under vitest gives the same
  // property.
  // VITEST is set to "true" by vitest itself (per its docs); we accept
  // any non-empty value defensively. An empty string counts as "not
  // set" — `vi.stubEnv(name, "")` in tests is how we simulate the
  // env var being absent.
  const vitestVal = process.env.VITEST;
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    (vitestVal !== undefined && vitestVal.length > 0);
  if (isTestEnv) {
    const override = process.env.SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE;
    if (override && override.length > 0) return override;
  }
  for (const path of [MACHINE_ID_PRIMARY, MACHINE_ID_FALLBACK]) {
    try {
      const id = readFileSync(path, "utf8").trim();
      if (id.length > 0) return id;
    } catch {
      // try next
    }
  }
  throw new MachineIdUnavailableError();
}

/**
 * HKDF-SHA256(machine-id, salt, info) → 32-byte key. We do this by hand
 * (Node has crypto.hkdfSync but it's a recent addition; this implementation
 * works on every supported Node version and is auditable in 5 lines).
 *
 * ikm: machine-id ASCII bytes
 * salt: 16 random bytes from the file header
 * info: stable string identifying this key's purpose
 */
function deriveKey(machineId: string, salt: Buffer): Buffer {
  const ikm = Buffer.from(machineId, "utf8");
  // Extract: HMAC-SHA256(salt, ikm)
  const prk = createHmac("sha256", salt).update(ikm).digest();
  // Expand: HMAC-SHA256(prk, info || 0x01) — single block since L=32 ≤ HashLen.
  const okm = createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(HKDF_INFO, "utf8"), Buffer.from([0x01])]))
    .digest();
  return okm.subarray(0, KEY_LEN);
}

/**
 * Encrypt a passphrase to the binary auto-unlock format.
 *
 * Reads /etc/machine-id, generates fresh salt + nonce, AES-256-GCM encrypts.
 * Returns the packed buffer ready to write to disk.
 *
 * @param passphrase the vault passphrase to protect
 * @param machineId optional override (used by tests so we don't need to mock fs)
 */
export function encryptAutoUnlock(passphrase: string, machineId?: string): Buffer {
  const id = machineId ?? readMachineId();
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = deriveKey(id, salt);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(passphrase, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    salt,
    nonce,
    ciphertext,
    tag,
  ]);
}

/**
 * Decrypt an auto-unlock blob back to the passphrase. Throws
 * AutoUnlockDecryptError on any failure — caller decides what to do
 * (broker should log + stay locked; CLI should exit with a clear message).
 */
export function decryptAutoUnlock(blob: Buffer, machineId?: string): string {
  if (blob.length < 1 + SALT_LEN + NONCE_LEN + TAG_LEN) {
    throw new AutoUnlockDecryptError("format");
  }
  if (blob[0] !== FORMAT_VERSION) {
    throw new AutoUnlockDecryptError("format");
  }
  const salt = blob.subarray(1, 1 + SALT_LEN);
  const nonce = blob.subarray(1 + SALT_LEN, 1 + SALT_LEN + NONCE_LEN);
  const ctAndTag = blob.subarray(1 + SALT_LEN + NONCE_LEN);
  const ciphertext = ctAndTag.subarray(0, ctAndTag.length - TAG_LEN);
  const tag = ctAndTag.subarray(ctAndTag.length - TAG_LEN);

  const id = machineId ?? readMachineId();
  const key = deriveKey(id, salt);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // GCM throws on tag mismatch — most common cause is a stale blob from
    // a different machine-id (host re-image, container rebuild).
    throw new AutoUnlockDecryptError("tag-mismatch");
  }
}

/**
 * Convenience: write encrypted blob to disk with mode 0600 and ensure the
 * parent dir is mode 0700.
 */
export function writeAutoUnlockFile(passphrase: string, filePath: string): void {
  const blob = encryptAutoUnlock(passphrase);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, blob, { mode: 0o600 });
  // writeFileSync respects mode only on file creation; chmod for the
  // existing-file case so re-running enable-auto-unlock tightens perms even
  // if the user loosened them by hand.
  chmodSync(filePath, 0o600);
}

/**
 * Convenience: read + decrypt. Throws AutoUnlockDecryptError("io") for
 * missing/unreadable files, otherwise the underlying error class.
 */
export function readAutoUnlockFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new AutoUnlockDecryptError("io");
  }
  let blob: Buffer;
  try {
    blob = readFileSync(filePath);
  } catch {
    throw new AutoUnlockDecryptError("io");
  }
  return decryptAutoUnlock(blob);
}

/**
 * Default location for the auto-unlock blob. Lives under ~/.switchroom
 * so it's co-located with other operator state and easily mounted into
 * the broker container by the compose definition.
 */
export const DEFAULT_AUTO_UNLOCK_PATH = "~/.switchroom/vault-auto-unlock";
