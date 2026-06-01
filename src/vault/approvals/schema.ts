/**
 * Approval kernel — SQLite schema (RFC B §5).
 *
 * Three tables in vault-grants.db (kernel folds into the existing broker DB
 * per RFC §4 — no rename, downgrade-friendly):
 *
 *   approval_decisions  — durable allow/deny decisions per (agent_unit, scope, action).
 *   approval_nonces     — short-lived 8-hex callback tokens; single-use redemption.
 *   approval_audit      — append-only audit trail of every kernel event.
 *
 * Schema columns track RFC B §5 verbatim. The kernel has shipped (Phase 1c
 * compose wiring; per-agent kernel sockets at /run/switchroom/kernel/<agent>/sock
 * are bind-mounted into every agent container). Migration is still
 * idempotent CREATE-IF-NOT-EXISTS so older deployments upgrade smoothly.
 *
 * No HMAC, no chains, no crypto: same-uid is game-over per docs/vault.md:227.
 */

import type { Database } from "bun:sqlite";

/**
 * Idempotent migration. Safe to call on every broker startup. The vault
 * broker already does this for `vault_grants`; we piggyback on the same
 * lifecycle so a fresh vault-grants.db gets all three tables in one shot.
 *
 * Idempotent CREATE-IF-NOT-EXISTS. Earlier revisions of this file used
 * DROP+CREATE on the assumption that no production deployment of the
 * kernel had landed yet — that assumption broke when issue #969 P1a
 * shipped the `vault_request_save` flow and other callsites started
 * minting durable `allow_always` decisions. Preserving the data across
 * broker restarts is now load-bearing for user expectations
 * (a tap-Always decision should survive a deploy).
 */
export function migrateApprovalSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS approval_decisions (
      id                       TEXT PRIMARY KEY,
      agent_unit               TEXT NOT NULL,
      scope                    TEXT NOT NULL,
      action                   TEXT NOT NULL,
      decision                 TEXT NOT NULL,
      ttl_expires_at           INTEGER,
      granted_at               INTEGER NOT NULL,
      granted_by_user_id       INTEGER NOT NULL,
      approver_set_canonical   TEXT NOT NULL,
      last_used_at             INTEGER,
      revoked_at               INTEGER,
      revoke_reason            TEXT,
      -- Provenance of the operator-authorization (RFC vault-approval-hard-
      -- boundary). 'agent': recorded on a per-agent socket — claude shares
      -- that socket, so it is FORGEABLE and must NOT be trusted as proof an
      -- operator tapped. 'operator': recorded via the host-side verifier on a
      -- claude-unreachable channel — the only value the broker's mint gate
      -- trusts. Default 'agent' (fail-closed for the new gate).
      origin                   TEXT NOT NULL DEFAULT 'agent'
    )
  `);

  // Idempotent add-column for DBs created before `origin` existed. SQLite
  // ALTER ADD COLUMN throws if the column is already present, so guard on
  // PRAGMA table_info (the CREATE above only fires on a truly fresh DB).
  const decisionCols = db
    .query("PRAGMA table_info(approval_decisions)")
    .all() as Array<{ name: string }>;
  if (!decisionCols.some((c) => c.name === "origin")) {
    db.run(
      `ALTER TABLE approval_decisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'`,
    );
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS approval_decisions_lookup
    ON approval_decisions(agent_unit, scope, action)
    WHERE revoked_at IS NULL
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS approval_nonces (
      request_id   TEXT PRIMARY KEY,
      decision_id  TEXT,
      agent_unit   TEXT NOT NULL,
      scope        TEXT NOT NULL,
      action       TEXT NOT NULL,
      approver_set_canonical TEXT NOT NULL,
      why          TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      consumed_at  INTEGER,
      FOREIGN KEY (decision_id) REFERENCES approval_decisions(id)
    )
  `);

  // Index for B2 rate-cap lookup: count pending nonces per agent_unit and
  // globally. WHERE consumed_at IS NULL keeps the index lean.
  db.run(`
    CREATE INDEX IF NOT EXISTS approval_nonces_pending
    ON approval_nonces(agent_unit, expires_at)
    WHERE consumed_at IS NULL
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS approval_audit (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      agent_unit  TEXT NOT NULL,
      scope       TEXT NOT NULL,
      action      TEXT NOT NULL,
      decision_id TEXT,
      event       TEXT NOT NULL,
      context     TEXT,
      FOREIGN KEY (decision_id) REFERENCES approval_decisions(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS approval_audit_by_scope
    ON approval_audit(scope, ts)
  `);
}

/** Decision modes per RFC §7. Stored verbatim in approval_decisions.decision. */
export type ApprovalDecisionMode =
  | "allow_once"
  | "allow_always"
  | "allow_ttl"
  | "deny"
  | "deny_perm";

/** Audit event vocabulary — one of these strings goes into approval_audit.event. */
export type ApprovalAuditEvent =
  | "request"
  | "grant"
  | "revoke"
  | "drift_revoke"
  | "consume"
  | "expire"
  | "deny"
  | "match"
  | "timeout"
  // RFC E §4.4 — missing→present recovery. Fired by the reconciler
  // driver when a Drive scope's grant transitions from missing
  // (deleted/trashed) back to present (un-trashed/restored). No
  // approval_decisions row — recoveries don't create grants, they
  // surface that an existing grant is reachable again.
  | "recover";

/**
 * Sliding-window TTL hard cap. RFC §7 specifies a default; the brief asks
 * for a configurable max with default 7 days. Renewal of an `allow_ttl`
 * decision cannot extend `ttl_expires_at` past `granted_at + this`.
 */
export const DEFAULT_MAX_TTL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
