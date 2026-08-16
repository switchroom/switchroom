/**
 * Stat-on-access lazy reload of the on-disk vault.
 *
 * The broker decrypts the vault ONCE at unlock and serves every `get` from
 * its in-memory `secrets` dict. Before this module existed nothing ever
 * re-read the file, so an operator-side `switchroom vault set <key>` wrote
 * `vault.enc` and EVERY agent kept serving the old value indefinitely —
 * SIGHUP swapped config only, and `docker compose up -d` left a Running
 * broker untouched, so the sole recovery was
 * `docker restart switchroom-vault-broker`. A write no reader can observe is
 * the worst failure shape a secret store has.
 *
 * WHY A SEPARATE MODULE: `server.ts` imports `bun:sqlite` at module scope
 * (grants DB), so vitest cannot load it and every test that constructs
 * `VaultBroker` is bun-only — and the bun CI job only runs targets under
 * `telegram-plugin/` (see scripts/check-test-runner-coverage.mjs), which is
 * why 17 broker suites sit on the known-orphan allowlist for #3756. Keeping
 * the reload decision in a module with no bun-only imports means its
 * regression test (`vault-refresh.test.ts`) runs under vitest in CI on every
 * PR, instead of being one more orphan nothing executes.
 *
 * Design constraints (no polling, no timers, no re-prompting):
 *  - Pure stat-on-access. Callers invoke this on the read path; it compares
 *    (mtime, size, inode) against the stamp of the load in memory and
 *    re-opens with the RETAINED passphrase only when it moved.
 *  - No-op when locked (`secrets`/`passphrase` null) and when there is no
 *    stamp to compare (seeded test state): never unlocks a locked broker,
 *    never prompts.
 *  - A failed re-open (torn write caught mid-flight, or a file re-encrypted
 *    under a different passphrase) KEEPS the previously loaded secrets,
 *    warns once, and remembers the bad stamp so later reads do not pay
 *    another scrypt derivation against the same unusable file. The loaded
 *    stamp is deliberately NOT advanced, so the moment the file changes
 *    again — a completing tmp+rename lands a new inode and mtime — the next
 *    read retries and the broker self-heals.
 *  - The fail-open above covers DECRYPT failures only. A `beforeOpen`
 *    (vault-layout-drift) throw is fatal and propagates to the caller —
 *    server.ts escalates it by locking the broker rather than serving a file
 *    it can no longer identify as the fleet's vault.
 *  - The superseded entries are zeroed exactly as `lock()` does.
 *  - Never logs a secret value: only the path and the error message.
 */
import { statSync } from "node:fs";
import { openVault, type VaultEntry } from "../vault.js";

/**
 * Identity of the vault file on disk at the moment it was loaded.
 *
 * bigint stats: `mtimeNs` keeps full filesystem timestamp precision. The
 * float `mtimeMs` is millisecond-rounded, so two writes inside the same
 * millisecond that also produce equal-size ciphertext (a same-length value
 * rotation) would be indistinguishable. `ino` catches it regardless —
 * `saveVault()` writes tmp+rename, so a fresh write lands on a NEW inode.
 */
export type VaultStamp = { mtimeNs: bigint; size: bigint; ino: bigint };

export function sameVaultStamp(a: VaultStamp, b: VaultStamp): boolean {
  return a.mtimeNs === b.mtimeNs && a.size === b.size && a.ino === b.ino;
}

/**
 * Stat the vault file and return its identity stamp, or null when it cannot
 * be stat'd (deleted, unreadable, mid-rename). MUST NOT throw: every caller
 * sits on a read path where a stat hiccup must not cost the fleet its vault
 * access.
 */
export function readVaultStamp(vaultPath: string): VaultStamp | null {
  try {
    const st = statSync(vaultPath, { bigint: true });
    return { mtimeNs: st.mtimeNs, size: st.size, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * Best-effort overwrite of secret string values before they are dropped.
 * Strings are immutable in JS — we can't zero the underlying bytes, so we
 * blank the reference and rely on GC. Known limitation, documented in the
 * security design notes; shared by `lock()` and the lazy-reload swap.
 */
export function zeroSecrets(secrets: Record<string, VaultEntry>): void {
  for (const [, entry] of Object.entries(secrets)) {
    try {
      if (entry.kind === "string" || entry.kind === "binary") {
        (entry as { value: string }).value = "";
      }
    } catch { /* best-effort */ }
  }
}

/** The broker's reload-relevant state. Owned by `VaultBroker`, read+returned here. */
export interface VaultRefreshState {
  secrets: Record<string, VaultEntry> | null;
  passphrase: string | null;
  /** Stamp of the load that produced `secrets`; null when locked/seeded. */
  loadedStamp: VaultStamp | null;
  /** Stamp of the last file whose re-open FAILED; null when none. */
  failedStamp: VaultStamp | null;
}

export interface VaultRefreshOptions {
  vaultPath: string;
  /** Re-open even when the stamp has not moved (SIGHUP belt-and-braces). */
  force?: boolean;
  /**
   * Layout-drift check run immediately before the re-open (server.ts supplies
   * `detectVaultLayoutDrift`). A throw from this callback is FATAL and
   * PROPAGATES out of `refreshVaultIfChanged` — it is not folded into the
   * keep-serving path. See the call site for why.
   */
  beforeOpen?: (vaultPath: string) => void;
  /** Seam for tests; defaults to the real `openVault`. */
  open?: (passphrase: string, vaultPath: string) => Record<string, VaultEntry>;
  /** Seam for tests; defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Return the state the broker should hold after a stat-on-access check.
 *
 * Returns the SAME state object when nothing changed, so a caller can cheaply
 * detect a no-op. On a successful reload the superseded secrets are zeroed
 * before returning.
 */
export function refreshVaultIfChanged(
  state: VaultRefreshState,
  opts: VaultRefreshOptions,
): VaultRefreshState {
  const { vaultPath, force = false } = opts;
  const open = opts.open ?? openVault;
  const warn = opts.warn ?? ((m: string) => { process.stderr.write(m); });

  const secrets = state.secrets;
  const passphrase = state.passphrase;
  if (secrets === null || passphrase === null) return state; // locked
  const known = state.loadedStamp;
  if (known === null) return state; // no disk-backed load to compare against

  const current = readVaultStamp(vaultPath);
  if (current === null) return state; // unreadable right now — keep serving
  if (!force && sameVaultStamp(current, known)) return state;
  // Already tried THIS exact file and it wouldn't open: don't burn a scrypt
  // derivation per get against an unusable vault. Cleared as soon as the file
  // changes again (or on a successful load / lock).
  if (
    !force &&
    state.failedStamp !== null &&
    sameVaultStamp(state.failedStamp, current)
  ) {
    return state;
  }

  // Layout drift is FATAL and must NEVER be folded into the fail-open path
  // below. `beforeOpen` (server.ts supplies `detectVaultLayoutDrift`) throws
  // when the broker's vault file and the legacy CLI path are two divergent
  // regular files — at unlock that throw deliberately aborts the unlock,
  // because from that moment the broker cannot know which file is the fleet's
  // vault. Catching it here would downgrade a documented fatal to one stderr
  // line AND set `failedStamp`, which suppresses the re-check until the file
  // changes again: precisely the unbounded "serve stale data" outcome the
  // guard exists to prevent. Deliberately OUTSIDE the try — it propagates to
  // the caller, which escalates (server.ts locks the broker + audits).
  opts.beforeOpen?.(vaultPath);

  let next: Record<string, VaultEntry>;
  try {
    next = open(passphrase, vaultPath);
  } catch (err: unknown) {
    const alreadyWarned =
      state.failedStamp !== null && sameVaultStamp(state.failedStamp, current);
    if (!alreadyWarned) {
      warn(
        `[vault-broker] WARNING: ${vaultPath} changed on disk but ` +
        `could not be re-opened (${(err as Error)?.message ?? "unknown error"}) — ` +
        `continuing to serve the previously loaded secrets; will retry when ` +
        `the file changes again\n`,
      );
    }
    // Keep serving `secrets`, keep `loadedStamp` where it was.
    return { ...state, failedStamp: current };
  }

  zeroSecrets(secrets);
  return { secrets: next, passphrase, loadedStamp: current, failedStamp: null };
}
