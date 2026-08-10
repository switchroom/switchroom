/**
 * vault/grants-db.ts — open the vault-grants SQLite database.
 *
 * DB path: ~/.switchroom/vault-broker/vault-grants.db (mode 0600).
 * Runs the schema migration on every open (idempotent).
 *
 * WHY A DEDICATED DIRECTORY (not the bare `~/.switchroom/vault-grants.db`):
 * the DB runs in WAL mode, which writes `-wal`/`-shm` sidecars BESIDE the main
 * file. The broker bind-mounts this DB in; if only the single main file is
 * mounted, the sidecars land in the container's ephemeral overlayfs, so
 * committed grants sit in the container-local WAL until a rare checkpoint and
 * are LOST on container recreate (the v0.13.31 grant-wipe incident, #1737).
 * Mounting the whole directory keeps the main file AND its sidecars on the
 * host fs together, so grants survive recreate regardless of checkpoint state.
 * All readers/writers resolve the path from `getGrantsDbPath()` — never a
 * duplicated literal.
 *
 * This module is kept separate from grants.ts so callers can inject any
 * Database handle in tests (in-memory), while production always uses this
 * canonical path.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { migrateGrantsSchema } from "./grants.js";
import { migrateApprovalSchema } from "./approvals/schema.js";
import {
  GRANTS_DB_DIRNAME,
  GRANTS_DB_FILENAME,
  GRANTS_DB_CONTAINER_DIR,
  GRANTS_DB_CONTAINER_PATH,
  getGrantsDbDir,
  getGrantsDbPath,
  getLegacyGrantsDbPath,
  migrateLegacyGrantsDbLocation,
} from "./grants-db-path.js";

// Re-export the pure path + migration helpers so existing `grants-db.js`
// importers keep working without needing to know about the split.
export {
  GRANTS_DB_DIRNAME,
  GRANTS_DB_FILENAME,
  GRANTS_DB_CONTAINER_DIR,
  GRANTS_DB_CONTAINER_PATH,
  getGrantsDbDir,
  getGrantsDbPath,
  getLegacyGrantsDbPath,
  migrateLegacyGrantsDbLocation,
};

export const DEFAULT_GRANTS_DB_PATH = getGrantsDbPath();

/**
 * WAL sidecar suffixes that must be quarantined alongside the main DB file.
 * A stale/corrupt -wal or -shm can re-corrupt a freshly recreated DB, so they
 * move aside together.
 */
const WAL_SIDECAR_SUFFIXES = ["-wal", "-shm"];

/**
 * Decide whether an error thrown while opening/migrating the grants DB
 * indicates genuine on-disk corruption (as opposed to a transient/operational
 * failure such as EACCES, ENOSPC, or a bug in our own migration SQL).
 *
 * We are deliberately conservative: only SQLite's corruption / not-a-database
 * error classes trigger the destructive quarantine-and-recreate path. Anything
 * else is re-thrown so we never silently wipe legitimate grants on, e.g., a
 * permissions problem.
 */
export function isGrantsDbCorruption(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // bun:sqlite surfaces SQLite result codes on `.code` (e.g. "SQLITE_CORRUPT")
  // and a human-readable message. Match on both so we are robust across Bun
  // versions that populate one but not the other.
  //
  // Deliberately EXCLUDED: SQLITE_NOTADB / "file is not a database" / "file is
  // encrypted or is not a database". Those codes are raised when SQLite cannot
  // read the file *as a database* — most commonly because of a wrong or missing
  // encryption key (a RECOVERABLE key-availability condition), not because the
  // on-disk bytes are structurally damaged. Treating NOTADB as corruption would
  // let a transient key problem trigger the destructive quarantine-and-recreate
  // path and wipe every legitimate grant. We only quarantine on signals that
  // genuinely mean the on-disk image itself is damaged.
  const code = String(
    (err as { code?: unknown }).code ?? "",
  ).toUpperCase();
  if (code === "SQLITE_CORRUPT" || code.startsWith("SQLITE_CORRUPT_")) {
    return true;
  }

  const message = String(
    (err as { message?: unknown }).message ?? "",
  ).toLowerCase();
  return (
    message.includes("database disk image is malformed") ||
    message.includes("database is corrupt")
  );
}

/**
 * Move a corrupt grants DB (and any WAL sidecars) aside to a timestamped
 * `.corrupt-<ISO>` copy for forensics, then return the quarantine path of the
 * main file. Never deletes — availability wins over the corrupt bytes, but the
 * bytes are preserved so the outage can be investigated.
 */
function quarantineGrantsDb(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${dbPath}.corrupt-${stamp}`;
  fs.renameSync(dbPath, quarantinePath);

  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      try {
        fs.renameSync(sidecar, `${quarantinePath}${suffix}`);
      } catch {
        // A leftover sidecar is non-fatal for recreation; best-effort move.
      }
    }
  }

  return quarantinePath;
}

/**
 * Open the grants DB, set perms, enable pragmas, and run the idempotent schema
 * migrations. Throws on any failure (caller decides whether to quarantine).
 */
function openAndMigrate(dbPath: string): Database {
  // allow-rw-db-open: the vault-broker OWNS grants.db — it is the writer
  const db = new Database(dbPath, { create: true });

  // If any post-open step throws (pragma / migration), the Database handle is
  // already open and holds a file descriptor. Close it before propagating so
  // the corruption/quarantine path (or any re-throw) doesn't leak an fd and,
  // critically, doesn't keep a lock on a file we're about to rename aside.
  try {
    // Set mode 0600 (user-only). chmodSync on the path — Database opens the
    // file before we can set mode, so we set it after open. The window is tiny
    // on a private ~/.switchroom directory.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Non-fatal: may already have correct perms, or on a FS that ignores modes
    }

    // Enable WAL mode for better concurrency
    db.run("PRAGMA journal_mode=WAL");
    // Without a busy_timeout, bun:sqlite defaults to 0ms and a contending
    // writer fails IMMEDIATELY with SQLITE_BUSY — a grant write can be
    // silently dropped. Wait-and-retry instead of dropping.
    db.run("PRAGMA busy_timeout=5000");
    db.run("PRAGMA foreign_keys=ON");

    // Idempotent schema migration — vault grants (existing) + approval kernel
    // (RFC B §5). Both live in vault-grants.db; the kernel reuses this DB
    // handle rather than standing up a parallel file.
    migrateGrantsSchema(db);
    migrateApprovalSchema(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // Best-effort close; the original error is what matters.
    }
    throw err;
  }

  return db;
}

/**
 * Open (or create) the grants database at the given path.
 *
 * - Creates parent directory if needed.
 * - Sets file mode 0600 after creation.
 * - Runs schema migration.
 *
 * Durability: a corrupt/truncated grants DB is a regenerable file (grants are
 * re-derivable via the approval flow), so rather than crash-looping the broker
 * — which takes down secret access across the whole fleet — a genuinely
 * corrupt DB is quarantined to a timestamped `.corrupt-<ISO>` copy and a fresh
 * empty DB is recreated in its place. Only SQLite corruption error classes
 * trigger this; operational errors (EACCES, ENOSPC, …) are re-thrown so we
 * never wipe legitimate grants for a transient problem.
 *
 * @param dbPath Absolute path (defaults to ~/.switchroom/vault-grants.db).
 * @param opener Injection seam for tests — how a DB is opened+migrated at a
 *   path. Defaults to the canonical `openAndMigrate`. Tests use this to force a
 *   corruption vs. non-corruption throw without depending on SQLite internals.
 */
export function openGrantsDb(
  dbPath = DEFAULT_GRANTS_DB_PATH,
  opener: (p: string) => Database = openAndMigrate,
): Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  // Boot-time relocation: if a legacy `~/.switchroom/vault-grants.db` still
  // sits at the old single-file location and nothing has been written to the
  // new path yet, move it into the dedicated directory before opening. Safe
  // no-op on greenfield and on already-migrated deployments.
  migrateLegacyGrantsDbLocation(dbPath);

  try {
    return opener(dbPath);
  } catch (err) {
    // Non-corruption failures (EACCES, ENOSPC, a bug in our migration SQL, a
    // recoverable key-availability/NOTADB condition) must propagate WITHOUT
    // touching the on-disk file — we never quarantine or wipe legitimate grants
    // for a transient/operational problem.
    if (!isGrantsDbCorruption(err)) throw err;

    const quarantinePath = quarantineGrantsDb(dbPath);
    console.error(
      `[vault-broker] grants DB at ${dbPath} is corrupt (${
        (err as { message?: string }).message ?? err
      }); quarantined to ${quarantinePath} and recreating an empty grants DB. ` +
        "Existing grants must be re-approved via the vault approval flow.",
    );

    // Recreate from scratch. If this second attempt also fails it is not a
    // corruption problem we can recover from — let it throw.
    return opener(dbPath);
  }
}
