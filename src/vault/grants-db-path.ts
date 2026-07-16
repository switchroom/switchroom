/**
 * vault/grants-db-path.ts — pure path resolution for the vault-grants DB.
 *
 * Kept free of any `bun:sqlite` import so it can be pulled into vitest-run
 * modules (e.g. the compose generator and doctor probes) without breaking the
 * vitest loader. The DB-opening + migration logic that DOES need `bun:sqlite`
 * lives in `grants-db.ts`, which re-exports these helpers.
 *
 * Canonical location: `~/.switchroom/vault-broker/vault-grants.db`.
 *
 * WHY A DEDICATED DIRECTORY (not the bare `~/.switchroom/vault-grants.db`):
 * the DB runs in WAL mode, which writes `-wal`/`-shm` sidecars BESIDE the main
 * file. The broker bind-mounts this DB in; if only the single main file is
 * mounted, the sidecars land in the container's ephemeral overlayfs, so
 * committed grants sit in the container-local WAL until a rare checkpoint and
 * are LOST on container recreate (the v0.13.31 grant-wipe incident, #1737 /
 * #3289). Mounting the whole directory keeps the main file AND its sidecars on
 * the host fs together.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** Dedicated directory that holds the grants DB + its WAL sidecars. */
export const GRANTS_DB_DIRNAME = "vault-broker";
/** Basename of the grants SQLite file inside {@link GRANTS_DB_DIRNAME}. */
export const GRANTS_DB_FILENAME = "vault-grants.db";

/**
 * In-container path the broker sees for the grants DB. The compose generator
 * bind-mounts the host `~/.switchroom/vault-broker` DIRECTORY here (not the
 * bare file), so the WAL sidecars persist alongside the main file.
 */
export const GRANTS_DB_CONTAINER_DIR = `/root/.switchroom/${GRANTS_DB_DIRNAME}`;
export const GRANTS_DB_CONTAINER_PATH = `${GRANTS_DB_CONTAINER_DIR}/${GRANTS_DB_FILENAME}`;

/** Resolve the dedicated grants-DB directory for a given home. */
export function getGrantsDbDir(home: string = os.homedir()): string {
  return path.join(home, ".switchroom", GRANTS_DB_DIRNAME);
}

/** Resolve the canonical grants-DB file path for a given home. */
export function getGrantsDbPath(home: string = os.homedir()): string {
  return path.join(getGrantsDbDir(home), GRANTS_DB_FILENAME);
}

/**
 * Legacy pre-#3289 location: the bare `~/.switchroom/vault-grants.db` file
 * (mounted into the broker as a single file, which is exactly the WAL
 * durability bug the directory move fixes). Derived from the NEW path so a
 * single shared definition covers both prod and test homes.
 */
export function getLegacyGrantsDbPath(
  newDbPath: string = getGrantsDbPath(),
): string {
  // new    = <home>/.switchroom/vault-broker/vault-grants.db
  // legacy = <home>/.switchroom/vault-grants.db
  return path.join(path.dirname(path.dirname(newDbPath)), GRANTS_DB_FILENAME);
}

/** WAL sidecar suffixes that live beside the main DB file. */
export const WAL_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * One-time relocation of the legacy `~/.switchroom/vault-grants.db` file (and
 * its WAL sidecars) into the dedicated `~/.switchroom/vault-broker/` directory
 * — the #3289 WAL-durability fix. Idempotent and safe to call on every
 * apply/boot:
 *
 *   - No-op when the legacy file is absent (greenfield) or the new file
 *     already exists (already migrated), or when the two resolve equal.
 *   - Moves any `-wal`/`-shm` sidecars FIRST, then the main DB file. Ordering
 *     matters: a `-wal` can hold committed-but-not-checkpointed grants, and
 *     SQLite only replays a `-wal` that sits BESIDE its main file. If a
 *     sidecar move fails (EXDEV, perms), already-moved sidecars are rolled
 *     back and the migration aborts loudly with the legacy pair intact — it
 *     retries on the next apply/boot. Moving the main file first would risk
 *     splitting the pair (main at the new path, `-wal` stranded at the old
 *     one) and silently losing committed grants — exactly the bug class this
 *     migration exists to fix.
 *   - Moving (rather than checkpointing then discarding) is the conservative,
 *     `bun:sqlite`-free choice: SQLite replays a matched `-wal` against its
 *     main file on the next open, so no committed grant can be lost even if a
 *     checkpoint would have failed. This keeps the migration usable from
 *     vitest-run host code (`apply`) that must not import `bun:sqlite`.
 *   - Concurrency (apply racing a broker boot): the final main-file rename is
 *     guarded — if it throws but the new path now exists and the legacy one is
 *     gone, the other migrator won the race and this call returns
 *     `{migrated: false}` instead of propagating a spurious ENOENT that would
 *     abort apply or wedge the broker boot loop.
 *
 * UPGRADE-WINDOW CAVEAT (inherent, documented): a still-running PRE-fix
 * broker holds the legacy DB open via the old single-file bind mount. A grant
 * minted between this migration and the broker's recreate lands in a fresh
 * container-local legacy `-wal` the new broker never replays. This window is
 * unavoidable without stopping the broker first; it is why apply runs the
 * migration as part of compose-source preparation immediately before the
 * `docker compose up` that recreates the broker, and why a grant minted
 * mid-upgrade may need re-minting.
 *
 * Returns a small descriptor so callers can log/observe the outcome.
 */
export function migrateLegacyGrantsDbLocation(
  newDbPath: string = getGrantsDbPath(),
  deps?: {
    /**
     * Injection seam for tests — how a file is renamed. Lets tests force a
     * sidecar-move or main-move failure (EXDEV, ENOENT race) deterministically
     * without depending on filesystem quirks. DO NOT set outside tests.
     */
    rename?: (from: string, to: string) => void;
  },
): { migrated: boolean; from?: string; to?: string } {
  const rename = deps?.rename ?? fs.renameSync;
  const legacyPath = getLegacyGrantsDbPath(newDbPath);

  if (path.resolve(legacyPath) === path.resolve(newDbPath)) {
    return { migrated: false };
  }
  if (!fs.existsSync(legacyPath)) return { migrated: false };
  if (fs.existsSync(newDbPath)) return { migrated: false };

  fs.mkdirSync(path.dirname(newDbPath), { recursive: true, mode: 0o700 });

  // Sidecars FIRST (see doc comment). Track moves so a mid-way failure can
  // roll back and leave the legacy main+wal pair intact for a retry.
  const movedSidecars: { from: string; to: string }[] = [];
  const rollbackSidecars = () => {
    for (const m of [...movedSidecars].reverse()) {
      try {
        rename(m.to, m.from);
      } catch {
        // Rollback is best-effort; the main file has NOT moved, so the worst
        // case is a stray sidecar copy at the new path, which the next
        // successful migration's rename overwrites.
      }
    }
  };
  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const from = `${legacyPath}${suffix}`;
    const to = `${newDbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    try {
      rename(from, to);
      movedSidecars.push({ from, to });
    } catch (err) {
      // A half-migrated WAL pair means committed grants could be split from
      // their main file — abort loudly with the legacy pair intact (M1).
      rollbackSidecars();
      throw new Error(
        `grants-db migration: failed to move WAL sidecar ${from} -> ${to} ` +
          `(${(err as Error).message}); aborted with the legacy DB intact — ` +
          `will retry on the next apply/boot`,
      );
    }
  }

  // Main file LAST, guarded against a concurrent migrator (L1 TOCTOU).
  try {
    rename(legacyPath, newDbPath);
  } catch (err) {
    if (fs.existsSync(newDbPath) && !fs.existsSync(legacyPath)) {
      // Lost the race to a concurrent apply/boot — already migrated by them.
      return { migrated: false };
    }
    rollbackSidecars();
    throw err;
  }
  try {
    fs.chmodSync(newDbPath, 0o600);
  } catch {
    // Non-fatal: FS may ignore modes, or perms already correct.
  }

  return { migrated: true, from: legacyPath, to: newDbPath };
}
