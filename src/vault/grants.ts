/**
 * vault/grants.ts — capability-token mint/validate/revoke/list operations.
 *
 * A capability token = a row in vault_grants.db with a bcrypt-hashed secret
 * half. Token format: `vg_<6 hex chars>.<32 hex chars random>`.
 *
 * This module is pure (no side-effects at import time) and injectable: callers
 * pass the Database handle so tests can use an in-memory SQLite DB without
 * touching disk or shared state.
 *
 * Security constraints:
 *   - The raw secret half is returned ONCE from mintGrant, never stored.
 *   - The secret_hash column holds the bcrypt digest only.
 *   - validateGrant returns a typed result — callers must not soft-code the
 *     string reasons; use the exported `DenyReason` union instead.
 */

import { randomBytes } from "node:crypto";
import * as bcrypt from "bcryptjs";
import type { Database } from "bun:sqlite";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GrantRow {
  id: string;
  agent_slug: string;
  key_allow: string[]; // parsed from JSON — keys this grant authorizes for READ
  /**
   * Keys this grant authorizes for WRITE (broker PUT). Patterns ending in
   * `*` match by prefix (e.g. `OPENAI_*` matches `OPENAI_API_KEY` and
   * `OPENAI_API_KEY_PROD`). Empty array means read-only.
   *
   * Write-grants can introduce new keys — unlike path-as-identity PUT
   * which can only rotate existing entries. This is what unblocks the
   * "agent saves a user-provided secret" flow in issue #968 / #969.
   */
  write_allow: string[];
  expires_at: number | null; // unix seconds or null
  revoked_at: number | null;
  created_at: number;
  description: string | null;
}

export interface MintResult {
  /** Full token string: `vg_<id>.<secret>` */
  token: string;
  /** Just the ID portion */
  id: string;
  /** Unix seconds, or null if non-expiring */
  expires_at: number | null;
}

export type DenyReason =
  | "grant-expired"
  | "grant-revoked"
  | "grant-key-not-allowed"
  | "grant-invalid";

export type ValidateResult =
  | { ok: true; grant: GrantRow }
  | { ok: false; reason: DenyReason };

/**
 * Result of write-capability check. `grant-write-not-allowed` is a
 * distinct reason from `grant-key-not-allowed` (read) so audit logs
 * and broker error messages can name which capability was missing —
 * helps the operator know which `--write` vs `--keys` flag to grant.
 */
export type WriteDenyReason =
  | "grant-expired"
  | "grant-revoked"
  | "grant-write-not-allowed"
  | "grant-invalid";

export type ValidateWriteResult =
  | { ok: true; grant: GrantRow }
  | { ok: false; reason: WriteDenyReason };

// ─── Schema migration ─────────────────────────────────────────────────────────

/**
 * Create the vault_grants table if it doesn't exist.
 * Idempotent — safe to call on every broker startup.
 */
export function migrateGrantsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS vault_grants (
      id          TEXT    PRIMARY KEY,
      secret_hash TEXT    NOT NULL,
      agent_slug  TEXT    NOT NULL,
      key_allow   TEXT    NOT NULL,
      expires_at  INTEGER,
      revoked_at  INTEGER,
      created_at  INTEGER NOT NULL,
      description TEXT
    )
  `);

  // Add write_allow column for existing DBs (issue #969 P1b). Safe to
  // run on every open — guard with a PRAGMA check so we don't rely on
  // SQLite's lack of `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (added in
  // 3.35.0 but bun:sqlite ships an older bundled libsqlite on some
  // platforms). Default `[]` = read-only grant.
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(vault_grants)`)
    .all();
  const hasWriteAllow = cols.some((c) => c.name === "write_allow");
  if (!hasWriteAllow) {
    db.run(`ALTER TABLE vault_grants ADD COLUMN write_allow TEXT NOT NULL DEFAULT '[]'`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BCRYPT_COST = 10;

function generateId(): string {
  // "vg_" + 6 random hex chars
  return "vg_" + randomBytes(3).toString("hex");
}

function generateSecret(): string {
  // 32 random hex chars (16 bytes)
  return randomBytes(16).toString("hex");
}

function parseKeyAllow(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

function rowToGrant(row: Record<string, unknown>): GrantRow {
  return {
    id: row.id as string,
    agent_slug: row.agent_slug as string,
    key_allow: parseKeyAllow(row.key_allow as string),
    write_allow: parseKeyAllow((row.write_allow as string) ?? "[]"),
    expires_at: (row.expires_at as number | null) ?? null,
    revoked_at: (row.revoked_at as number | null) ?? null,
    created_at: row.created_at as number,
    description: (row.description as string | null) ?? null,
  };
}

/**
 * Defense-in-depth WAL durability: fold the write-ahead log back into the
 * main DB file immediately after a grant mutation.
 *
 * The primary durability fix is mounting the whole grants-DB DIRECTORY into
 * the broker (so `-wal`/`-shm` persist across container recreate — see
 * grants-db.ts). This checkpoint is the belt-and-braces: grant write volume
 * is trivial (a mint or revoke is a rare, human-paced event), so truncating
 * the WAL after every mutation is effectively free and guarantees the main
 * file is always current for host-side readers (doctor, migration) without a
 * race on the next automatic checkpoint. We keep WAL mode (not journal_mode=
 * DELETE) because the broker and the approval-kernel share this one handle and
 * rely on WAL's concurrent-reader behaviour + busy_timeout; DELETE would
 * change those shared semantics, whereas an explicit checkpoint does not.
 *
 * Best-effort: an in-memory test DB or a non-WAL handle makes this a harmless
 * no-op/throw which we swallow — the mutation is already committed; this only
 * advances the durability point of the main file.
 */
function checkpointGrantsWal(db: Database): void {
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Non-fatal — see above.
  }
}

/**
 * Match a key name against a list of patterns. Patterns are literal
 * key names, optionally with a trailing `*` for prefix-glob (e.g.
 * `OPENAI_*` matches `OPENAI_API_KEY` and `OPENAI_TIMEOUT`). No other
 * glob metacharacters are honored — keep the surface tight.
 *
 * Operator note: a lone `*` IS a valid prefix-glob with an empty
 * prefix, which means it matches every key. `vault grant <agent>
 * --write '*'` mints a vault-wide write capability — useful for
 * trusted operator-tier agents, dangerous for general agents. Audit
 * carefully.
 */
export function keyMatchesPatterns(patterns: string[], key: string): boolean {
  for (const pat of patterns) {
    if (pat.endsWith("*")) {
      const prefix = pat.slice(0, -1);
      if (key.startsWith(prefix)) return true;
    } else if (pat === key) {
      return true;
    }
  }
  return false;
}

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Mint a new capability grant.
 *
 * @param db          Opened SQLite Database handle.
 * @param agent_slug  Agent this grant belongs to.
 * @param key_allow   List of vault key names the grant may access.
 * @param ttl_seconds Seconds until expiry, or null for no expiry.
 * @param description Human-readable note (optional).
 * @returns MintResult with the one-time token string, id, and expires_at.
 */
export async function mintGrant(
  db: Database,
  agent_slug: string,
  key_allow: string[],
  ttl_seconds: number | null,
  description?: string,
  write_allow: string[] = [],
): Promise<MintResult> {
  const id = generateId();
  const secret = generateSecret();
  const token = `${id}.${secret}`;

  const secret_hash = await bcrypt.hash(secret, BCRYPT_COST);

  const now = Math.floor(Date.now() / 1000);
  const expires_at = ttl_seconds != null ? now + ttl_seconds : null;

  db.run(
    `INSERT INTO vault_grants (id, secret_hash, agent_slug, key_allow, write_allow, expires_at, revoked_at, created_at, description)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      secret_hash,
      agent_slug,
      JSON.stringify(key_allow),
      JSON.stringify(write_allow),
      expires_at,
      now,
      description ?? null,
    ],
  );
  checkpointGrantsWal(db);

  return { token, id, expires_at };
}

/**
 * Validate a token string against the database.
 *
 * Parses `vg_<id>.<secret>`, looks up the row, bcrypt-compares the secret,
 * then checks expiry and revocation, then checks the requested key.
 *
 * @param db    Opened SQLite Database handle.
 * @param token Full token string.
 * @param key   Vault key being requested.
 */
export async function validateGrant(
  db: Database,
  token: string,
  key: string,
): Promise<ValidateResult> {
  // Parse token format: `vg_<id>.<secret>`
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1 || !token.startsWith("vg_")) {
    return { ok: false, reason: "grant-invalid" };
  }

  const id = token.slice(0, dotIdx);
  const secret = token.slice(dotIdx + 1);

  if (!id || !secret) {
    return { ok: false, reason: "grant-invalid" };
  }

  // Look up row
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT id, secret_hash, agent_slug, key_allow, expires_at, revoked_at, created_at, description
       FROM vault_grants WHERE id = ?`,
    )
    .get(id);

  if (!row) {
    return { ok: false, reason: "grant-invalid" };
  }

  // bcrypt compare (timing-safe)
  const secretHash = row.secret_hash as string;
  let hashMatches: boolean;
  try {
    hashMatches = await bcrypt.compare(secret, secretHash);
  } catch {
    hashMatches = false;
  }

  if (!hashMatches) {
    return { ok: false, reason: "grant-invalid" };
  }

  const grant = rowToGrant(row);
  const now = Math.floor(Date.now() / 1000);

  // Check revoked
  if (grant.revoked_at !== null) {
    return { ok: false, reason: "grant-revoked" };
  }

  // Check expiry
  if (grant.expires_at !== null && grant.expires_at < now) {
    return { ok: false, reason: "grant-expired" };
  }

  // Check key allowed
  if (!grant.key_allow.includes(key)) {
    return { ok: false, reason: "grant-key-not-allowed" };
  }

  return { ok: true, grant };
}

/**
 * Validate a token for WRITE access to a key. Mirrors `validateGrant` but
 * consults `write_allow` (with prefix-glob support) instead of `key_allow`.
 *
 * Unlike `validateGrant`, a valid write-grant authorizes both rotation of
 * existing keys AND creation of new keys matching the pattern — this is
 * what unblocks the agent-initiated "save this user-provided secret"
 * flow (issue #968 / #969 P1b).
 */
export async function validateGrantForWrite(
  db: Database,
  token: string,
  key: string,
): Promise<ValidateWriteResult> {
  // Reuse the parse + bcrypt + revoke + expiry path from validateGrant,
  // then swap the final key check for the write-pattern check. Keep this
  // standalone (not a flag on validateGrant) so the typed result names
  // the missing capability — auditors reading "grant-write-not-allowed"
  // know immediately the grant lacked --write coverage, not --keys.
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1 || !token.startsWith("vg_")) {
    return { ok: false, reason: "grant-invalid" };
  }
  const id = token.slice(0, dotIdx);
  const secret = token.slice(dotIdx + 1);
  if (!id || !secret) {
    return { ok: false, reason: "grant-invalid" };
  }

  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT id, secret_hash, agent_slug, key_allow, write_allow, expires_at, revoked_at, created_at, description
       FROM vault_grants WHERE id = ?`,
    )
    .get(id);
  if (!row) return { ok: false, reason: "grant-invalid" };

  const secretHash = row.secret_hash as string;
  let hashMatches: boolean;
  try {
    hashMatches = await bcrypt.compare(secret, secretHash);
  } catch {
    hashMatches = false;
  }
  if (!hashMatches) return { ok: false, reason: "grant-invalid" };

  const grant = rowToGrant(row);
  const now = Math.floor(Date.now() / 1000);
  if (grant.revoked_at !== null) return { ok: false, reason: "grant-revoked" };
  if (grant.expires_at !== null && grant.expires_at < now) {
    return { ok: false, reason: "grant-expired" };
  }
  if (!keyMatchesPatterns(grant.write_allow, key)) {
    return { ok: false, reason: "grant-write-not-allowed" };
  }
  return { ok: true, grant };
}

/**
 * Revoke a grant by ID. Sets revoked_at to current unix time.
 *
 * @returns true if the row existed and was revoked; false if not found.
 */
export function revokeGrant(db: Database, id: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const result = db.run(
    `UPDATE vault_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    [now, id],
  );
  checkpointGrantsWal(db);
  return (result.changes ?? 0) > 0;
}

/**
 * List active (non-revoked) grants, optionally filtered by agent slug.
 *
 * @param db         Opened SQLite Database handle.
 * @param agent_slug Optional filter; if omitted returns all active grants.
 * @returns Array of GrantRow objects (no secret_hash).
 */
export function listGrants(db: Database, agent_slug?: string): GrantRow[] {
  let rows: Record<string, unknown>[];
  if (agent_slug !== undefined) {
    rows = db
      .query<Record<string, unknown>, [string]>(
        `SELECT id, agent_slug, key_allow, write_allow, expires_at, revoked_at, created_at, description
         FROM vault_grants WHERE revoked_at IS NULL AND agent_slug = ?
         ORDER BY created_at DESC`,
      )
      .all(agent_slug);
  } else {
    rows = db
      .query<Record<string, unknown>, []>(
        `SELECT id, agent_slug, key_allow, write_allow, expires_at, revoked_at, created_at, description
         FROM vault_grants WHERE revoked_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all();
  }
  return rows.map(rowToGrant);
}
