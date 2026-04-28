/**
 * vault/grants-db.ts — open the vault-grants SQLite database.
 *
 * DB path: ~/.switchroom/vault-grants.db (mode 0600, beside vault.enc).
 * Runs the schema migration on every open (idempotent).
 *
 * This module is kept separate from grants.ts so callers can inject any
 * Database handle in tests (in-memory), while production always uses this
 * canonical path.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { migrateGrantsSchema } from "./grants.js";

export const DEFAULT_GRANTS_DB_PATH = path.join(
  os.homedir(),
  ".switchroom",
  "vault-grants.db",
);

/**
 * Open (or create) the grants database at the given path.
 *
 * - Creates parent directory if needed.
 * - Sets file mode 0600 after creation.
 * - Runs schema migration.
 *
 * @param dbPath Absolute path (defaults to ~/.switchroom/vault-grants.db).
 */
export function openGrantsDb(dbPath = DEFAULT_GRANTS_DB_PATH): Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath, { create: true });

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
  db.run("PRAGMA foreign_keys=ON");

  // Idempotent schema migration
  migrateGrantsSchema(db);

  return db;
}
