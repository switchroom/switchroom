/**
 * Microsoft credential storage for the auth-broker (RFC #1873).
 *
 * Mirrors `google-storage.ts` shape: per-account directories under the
 * broker's state dir, atomic writes, idempotent removal. **Phase 1
 * shortcut** matches Google's — credentials live on the broker's own
 * filesystem under `~/.switchroom/state/auth-broker/microsoft/<account>/`
 * rather than the vault-broker. Future work (mirroring RFC G's Phase
 * 3b.2d follow-up) migrates to vault-broker-mediated storage uniformly
 * across providers.
 *
 * Storage layout:
 *
 *   ~/.switchroom/state/auth-broker/microsoft/
 *     ken@outlook.com/
 *       credentials.json   ← `{ microsoftOauth: { ... } }`, mode 0600
 *     ken@work.example.com/
 *       credentials.json
 *
 * Account labels are normalized (lowercase + trim) — Microsoft account
 * keys are `preferred_username` claims which are typically email-shaped
 * but can be UPNs for work accounts (still email-shaped — UPN format
 * is `<user>@<domain>`). The normalization rule is identical to
 * Google's, allowing the same filesystem-safety contract.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { atomicWriteFileSync } from "../../util/atomic.js";
import type { MicrosoftCredentialsShape } from "./protocol.js";

/**
 * Normalize an account label to the on-disk-safe form. Mirrors
 * `normalizeGoogleAccountForStorage` so the same email resolves
 * identically across providers.
 */
export function normalizeMicrosoftAccountForStorage(account: string): string {
  return account.trim().toLowerCase();
}

/**
 * Validate that an account label is safe to use as a filesystem path
 * component before any fs op touches it. Same email-shape contract as
 * Google: no path separators, no `..`, no whitespace, no `:` (broker's
 * slot-key separator), no control characters.
 *
 * Microsoft's `preferred_username` claim is typically email-shaped but
 * the v2 endpoint can return UPNs that don't strictly match an email
 * regex (e.g. `alice_outlook.com#EXT#@aliceoutlook.onmicrosoft.com`
 * for B2B guest accounts). For switchroom v1 we restrict to clean
 * email shape — if guest-account UPNs come up in practice, the regex
 * can be relaxed in a follow-up.
 */
export function validateMicrosoftAccountLabel(account: string): void {
  if (typeof account !== "string" || account.length === 0) {
    throw new Error(`Microsoft account label must be a non-empty string`);
  }
  if (account !== account.trim()) {
    throw new Error(`Microsoft account label must not have leading/trailing whitespace`);
  }
  // Reject control characters — POSIX filenames reject null bytes,
  // and the email-shape regex below would otherwise let `\x00@x.y`
  // through.
  if (/[\x00-\x1f\x7f]/.test(account)) {
    throw new Error(
      `Microsoft account label '${account.replace(/[\x00-\x1f\x7f]/g, "?")}' contains control characters; email shape rejects them.`,
    );
  }
  if (!/^[^@\s:/\\]+@[^@\s:/\\]+\.[^@\s:/\\]+$/.test(account)) {
    throw new Error(
      `Microsoft account label '${account}' is not a valid email shape. Expected like 'alice@outlook.com' or 'alice@contoso.com' (no slashes, colons, or whitespace).`,
    );
  }
}

/**
 * Resolve the per-account directory under the broker's state dir.
 * Caller passes the broker's own stateDir (typically
 * `~/.switchroom/state/auth-broker/`).
 */
export function microsoftAccountDir(stateDir: string, account: string): string {
  return resolve(
    stateDir,
    "microsoft",
    normalizeMicrosoftAccountForStorage(account),
  );
}

export function microsoftAccountCredentialsPath(
  stateDir: string,
  account: string,
): string {
  return join(microsoftAccountDir(stateDir, account), "credentials.json");
}

/**
 * Whether the per-account directory exists. Used by `add-account` to
 * detect "account already exists" vs "first add."
 */
export function microsoftAccountExists(
  stateDir: string,
  account: string,
): boolean {
  return existsSync(microsoftAccountCredentialsPath(stateDir, account));
}

/**
 * Read the per-account credentials.json. Returns null if absent or
 * malformed (broker treats missing/malformed as "needs add-account").
 */
export function readMicrosoftAccountCredentials(
  stateDir: string,
  account: string,
): MicrosoftCredentialsShape | null {
  const path = microsoftAccountCredentialsPath(stateDir, account);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MicrosoftCredentialsShape>;
    if (!parsed?.microsoftOauth?.accessToken) return null;
    return parsed as MicrosoftCredentialsShape;
  } catch {
    return null;
  }
}

/**
 * Write per-account credentials.json. Creates the parent dir if absent
 * (mode 0700). File written via atomicWriteFileSync — survives
 * concurrent readers.
 *
 * **Critical invariant**: Microsoft rotates refresh tokens every
 * exchange. A torn write (process killed mid-write) loses the new RT
 * and the old RT has already been invalidated by Microsoft. The atomic
 * helper handles this via temp-file + rename.
 *
 * Returns the absolute path written.
 */
export function writeMicrosoftAccountCredentials(
  stateDir: string,
  account: string,
  credentials: MicrosoftCredentialsShape,
): string {
  const path = microsoftAccountCredentialsPath(stateDir, account);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(credentials, null, 2), 0o600);
  return path;
}

/**
 * Delete the per-account directory + credentials. Idempotent — no
 * error if the account doesn't exist.
 */
export function removeMicrosoftAccount(stateDir: string, account: string): void {
  const dir = microsoftAccountDir(stateDir, account);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * List all Microsoft accounts the broker has stored. Used by the
 * `list-microsoft-accounts` op (PR 2 will add the verb) + the refresh
 * tick loop + doctor probes.
 *
 * Reads filesystem layout, not in-memory state — operators can drop a
 * credentials.json by hand and the broker will pick it up on next read
 * (same shape as Google + Anthropic).
 */
export function listMicrosoftAccounts(stateDir: string): string[] {
  const root = join(stateDir, "microsoft");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((name) =>
      existsSync(join(root, name, "credentials.json")),
    );
}
