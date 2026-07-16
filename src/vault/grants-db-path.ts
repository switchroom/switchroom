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
 *   - Moves the main DB file AND any `-wal`/`-shm` sidecars TOGETHER into the
 *     new directory. Moving them together (rather than checkpointing then
 *     discarding) is the conservative, `bun:sqlite`-free choice: SQLite
 *     replays a matched `-wal` against its main file on the next open, so no
 *     committed grant can be lost even if a checkpoint would have failed. This
 *     keeps the migration usable from vitest-run host code (`apply`) that must
 *     not import `bun:sqlite`.
 *
 * Returns a small descriptor so callers can log/observe the outcome.
 */
export function migrateLegacyGrantsDbLocation(
  newDbPath: string = getGrantsDbPath(),
): { migrated: boolean; from?: string; to?: string } {
  const legacyPath = getLegacyGrantsDbPath(newDbPath);

  if (path.resolve(legacyPath) === path.resolve(newDbPath)) {
    return { migrated: false };
  }
  if (!fs.existsSync(legacyPath)) return { migrated: false };
  if (fs.existsSync(newDbPath)) return { migrated: false };

  fs.mkdirSync(path.dirname(newDbPath), { recursive: true, mode: 0o700 });

  fs.renameSync(legacyPath, newDbPath);
  try {
    fs.chmodSync(newDbPath, 0o600);
  } catch {
    // Non-fatal: FS may ignore modes, or perms already correct.
  }

  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const from = `${legacyPath}${suffix}`;
    const to = `${newDbPath}${suffix}`;
    if (fs.existsSync(from)) {
      try {
        fs.renameSync(from, to);
      } catch {
        // Best-effort; a `-shm` is rebuildable and a lone leftover sidecar
        // beside the now-absent legacy main file is inert.
      }
    }
  }

  return { migrated: true, from: legacyPath, to: newDbPath };
}
