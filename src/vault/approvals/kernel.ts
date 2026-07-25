/**
 * Approval kernel — pure DB operations (RFC B §5–§7, §10).
 *
 * Stateless module: every function takes a Database handle and returns a
 * plain result. The IPC broker (server.ts) and the Telegram callback router
 * (gateway/approval-card.ts) call into here. Tests can drive these
 * functions directly against an in-memory SQLite DB without standing up the
 * broker.
 *
 * This module's column names track RFC B §5 verbatim (agent_unit, scope,
 * action, decision, ttl_expires_at, granted_by_user_id, last_used_at,
 * revoke_reason). No surface, no action_grammar, no decision_id chains.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { canonicalizeApproverSet } from "./canonical.js";
import {
  DEFAULT_MAX_TTL_LIFETIME_MS,
  type ApprovalAuditEvent,
  type ApprovalDecisionMode,
} from "./schema.js";

/**
 * `revoke_reason` stamped on an `allow_once` decision when it is burned by
 * its first (and only) successful match. Distinguishes a one-shot that did
 * its job from an operator revoke or approver-set drift in `approval_list`
 * / the audit log.
 */
export const ALLOW_ONCE_CONSUMED_REASON = "allow_once_consumed";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApprovalRequestInput {
  agent_unit: string;
  scope: string;            // RFC §6 scope grammar (e.g. "secret:OPENAI_*", "doc:gdrive:…")
  action: string;            // 'read' | 'write' | etc
  approver_set: string[];   // current allowFrom; canonicalized + stored on grant
  why?: string;
  ttl_ms?: number;          // nonce expiry; defaults to 5 minutes per §8.1
  /**
   * Phase 2b — optional informational fields populated by the kernel-server
   * IPC entrypoint (kernel-server.ts). Both flow into the `approval_audit`
   * row's `context` JSON blob — additive, NO schema migration.
   *
   * `peer_uid` — SO_PEERCRED UID captured at accept(2). Forensic only;
   * never used to gate ACL (agent identity is the listener's socket path).
   *
   * `agent_name` — agent slug derived from the listener's socket-dir,
   * matching what the kernel-server bound at startup. When present, this
   * is the trusted identity used for the ACL decision; any mismatch with
   * agent_unit is rejected upstream by checkApprovalAclByAgent.
   */
  peer_uid?: number;
  agent_name?: string;
}

export interface RequestApprovalResult {
  request_id: string;       // 32-hex (128-bit, #1399); goes on the apv: callback_data
  expires_at: number;       // unix-ms when the prompt times out
}

export interface DecisionRow {
  id: string;
  agent_unit: string;
  scope: string;
  action: string;
  decision: ApprovalDecisionMode;
  ttl_expires_at: number | null;
  granted_at: number;
  granted_by_user_id: number;
  approver_set_canonical: string;
  last_used_at: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
  /** 'agent' (forgeable, default) | 'operator' (host-verified). See origin column. */
  origin: "agent" | "operator";
}

/**
 * Lookup state per RFC §10 (granted | denied | pending | expired) plus
 * kernel-internal states (drift_revoked, no_decision). The wire-side
 * discriminant is `state` (not `status`) — see protocol.ts; this avoids
 * collision with BrokerStatus on the broker response union.
 */
export type LookupResult =
  | { state: "granted"; decision: DecisionRow }
  | { state: "denied"; decision: DecisionRow }
  | { state: "pending"; request_id: string }
  | { state: "expired" }
  | { state: "drift_revoked" }
  | { state: "no_decision" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRequestId(): string {
  // 128-bit (32 hex chars). #1399: 32-bit (randomBytes(4)) was online-
  // guessable against a long-lived daemon and compounded the cross-agent
  // nonce/decision attack surface. Still well under Telegram's 64-byte
  // callback_data limit (`apv:<32hex>:allow_always` ≈ 49 bytes).
  return randomBytes(16).toString("hex");
}

function audit(
  db: Database,
  event: ApprovalAuditEvent,
  fields: {
    agent_unit: string;
    scope: string;
    action: string;
    decision_id?: string | null;
    context?: Record<string, unknown>;
  },
): void {
  db.run(
    `INSERT INTO approval_audit
       (ts, agent_unit, scope, action, decision_id, event, context)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      fields.agent_unit,
      fields.scope,
      fields.action,
      fields.decision_id ?? null,
      event,
      fields.context ? JSON.stringify(fields.context) : null,
    ],
  );
}

function rowToDecision(row: Record<string, unknown>): DecisionRow {
  return {
    id: row.id as string,
    agent_unit: row.agent_unit as string,
    scope: row.scope as string,
    action: row.action as string,
    decision: row.decision as ApprovalDecisionMode,
    ttl_expires_at: (row.ttl_expires_at as number | null) ?? null,
    granted_at: row.granted_at as number,
    granted_by_user_id: row.granted_by_user_id as number,
    approver_set_canonical: row.approver_set_canonical as string,
    last_used_at: (row.last_used_at as number | null) ?? null,
    revoked_at: (row.revoked_at as number | null) ?? null,
    revoke_reason: (row.revoke_reason as string | null) ?? null,
    origin: (row.origin as "agent" | "operator" | null) === "operator"
      ? "operator"
      : "agent",
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Per-agent and global pending-nonce caps (RFC §10). */
export const MAX_PENDING_PER_AGENT = 2;
export const MAX_PENDING_GLOBAL = 32;

/**
 * Count currently-pending (unconsumed, unexpired) nonces. Used by the broker
 * to enforce RFC §10 rate caps before issuing a new request_id.
 */
export function countPendingNonces(
  db: Database,
  now: number = Date.now(),
): { perAgent: Map<string, number>; global: number } {
  const rows = db
    .query<{ agent_unit: string; n: number }, [number]>(
      `SELECT agent_unit, COUNT(*) AS n FROM approval_nonces
       WHERE consumed_at IS NULL AND expires_at > ?
       GROUP BY agent_unit`,
    )
    .all(now);
  const perAgent = new Map<string, number>();
  let global = 0;
  for (const r of rows) {
    perAgent.set(r.agent_unit, r.n);
    global += r.n;
  }
  return { perAgent, global };
}

/**
 * Compute retry_after_ms as the time until the soonest-expiring active
 * nonce frees a slot. Falls back to a 5s floor if no rows are present
 * (shouldn't happen if we're rate-limiting, but defensive).
 */
export function computeRetryAfterMs(
  db: Database,
  agent_unit: string | null,
  now: number = Date.now(),
): number {
  const row = agent_unit
    ? db
        .query<{ expires_at: number }, [string, number]>(
          `SELECT MIN(expires_at) AS expires_at FROM approval_nonces
           WHERE consumed_at IS NULL AND expires_at > ? AND agent_unit = ?
           LIMIT 1`,
        )
        .get(agent_unit, now)
    : db
        .query<{ expires_at: number }, [number]>(
          `SELECT MIN(expires_at) AS expires_at FROM approval_nonces
           WHERE consumed_at IS NULL AND expires_at > ?
           LIMIT 1`,
        )
        .get(now);
  if (!row || row.expires_at == null) return 5000;
  const delta = row.expires_at - now;
  return Math.max(1000, delta);
}

/**
 * Open a fresh approval request: insert a nonce row, return the request_id
 * the gateway will embed in `apv:<request_id>:<action>` callback_data.
 *
 * No decision row is created yet — that happens on consume (user tap).
 *
 * Caller (broker) is responsible for rate-cap enforcement via
 * `countPendingNonces` before invoking this.
 */
export function requestApproval(
  db: Database,
  input: ApprovalRequestInput,
  now: number = Date.now(),
): RequestApprovalResult {
  const request_id = generateRequestId();
  const ttl = input.ttl_ms ?? 5 * 60 * 1000; // 5 min default per §8.1
  const expires_at = now + ttl;
  const canonical = canonicalizeApproverSet(input.approver_set);

  db.run(
    `INSERT INTO approval_nonces
       (request_id, decision_id, agent_unit, scope, action,
        approver_set_canonical, why, created_at, expires_at, consumed_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      request_id,
      input.agent_unit,
      input.scope,
      input.action,
      canonical,
      input.why ?? null,
      now,
      expires_at,
    ],
  );

  audit(db, "request", {
    agent_unit: input.agent_unit,
    scope: input.scope,
    action: input.action,
    context: {
      request_id,
      why: input.why,
      // Phase 2b additive fields — only present on the docker IPC path.
      ...(input.peer_uid !== undefined ? { peer_uid: input.peer_uid } : {}),
      ...(input.agent_name !== undefined ? { agent_name: input.agent_name } : {}),
    },
  });

  return { request_id, expires_at };
}

/**
 * Look up whether (agent_unit, scope, action) is currently granted. Performs
 * config-drift detection (§5.1) and sliding-window TTL renewal (§7).
 */
export function lookupDecision(
  db: Database,
  query: {
    agent_unit: string;
    scope: string;
    action: string;
    current_approver_set: string[];
  },
  opts: { max_ttl_lifetime_ms?: number } = {},
  now: number = Date.now(),
): LookupResult {
  const currentCanonical = canonicalizeApproverSet(query.current_approver_set);

  const row = db
    .query<Record<string, unknown>, [string, string, string]>(
      `SELECT * FROM approval_decisions
       WHERE agent_unit = ? AND scope = ? AND action = ?
         AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`,
    )
    .get(query.agent_unit, query.scope, query.action);

  if (!row) return { state: "no_decision" };

  return evaluateDecisionRow(db, row, currentCanonical, opts, now);
}

/**
 * Correlate a verdict to the SPECIFIC request_id the caller registered —
 * NOT to the (agent, scope, action) triple. Two concurrent requests can
 * share a scope (e.g. `ms-365:write:(new)` for two different new-file
 * uploads); a scope-keyed `lookupDecision` would let one request's
 * approval be mis-attributed to the other. This resolves the nonce by
 * request_id, follows its `decision_id` link (set atomically at
 * consume+record time), and evaluates only that request's own decision
 * row. (review 2026-07-11, W2 verdict-correlation finding.)
 *
 * States:
 *   - unknown request_id                       → no_decision
 *   - nonce pending, not yet decided, unexpired → pending
 *   - nonce pending, past its TTL               → expired
 *   - decision recorded but revoked             → denied
 *   - otherwise → evaluate the linked decision row (granted/denied/…)
 */
export function lookupDecisionByRequestId(
  db: Database,
  query: {
    agent_unit: string;
    request_id: string;
    current_approver_set: string[];
  },
  opts: { max_ttl_lifetime_ms?: number } = {},
  now: number = Date.now(),
): LookupResult {
  const currentCanonical = canonicalizeApproverSet(query.current_approver_set);

  const nonceRow = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_nonces WHERE request_id = ?`,
    )
    .get(query.request_id);
  if (!nonceRow) return { state: "no_decision" };

  const nonce = nonceFromRow(nonceRow);

  // Cross-agent isolation (#1399 pattern): a request_id is only readable
  // by the agent that owns it. A mismatch returns the same non-committal
  // no_decision as an unknown id — no cross-agent existence/verdict oracle.
  if (nonce.agent_unit !== query.agent_unit) return { state: "no_decision" };

  if (nonce.decision_id === null) {
    // No verdict recorded yet. Distinguish "still waiting" from "the
    // prompt timed out" so the caller can fail closed promptly rather
    // than spin to its own deadline.
    if (nonce.expires_at < now) return { state: "expired" };
    return { state: "pending", request_id: nonce.request_id };
  }

  const decRow = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_decisions WHERE id = ?`,
    )
    .get(nonce.decision_id);
  // Linked decision vanished (can't happen — decisions are never deleted,
  // only revoked). Defensive terminal fail-closed rather than a hang.
  if (!decRow) return { state: "expired" };

  // A revoked decision is terminal-not-granted for THIS request.
  if ((decRow.revoked_at as number | null) != null) {
    return { state: "denied", decision: rowToDecision(decRow) };
  }

  return evaluateDecisionRow(db, decRow, currentCanonical, opts, now);
}

/**
 * Shared decision-row evaluator: deny_perm short-circuit, TTL expiry,
 * approver-set drift auto-revoke, single-shot deny, and §7 sliding-window
 * TTL renewal. Factored out of `lookupDecision` so the request-id-keyed
 * path (`lookupDecisionByRequestId`) applies the identical policy.
 */
function evaluateDecisionRow(
  db: Database,
  row: Record<string, unknown>,
  currentCanonical: string,
  opts: { max_ttl_lifetime_ms?: number },
  now: number,
): LookupResult {
  const decision = rowToDecision(row);

  // deny_perm short-circuits before drift / TTL — it's a permanent reject.
  if (decision.decision === "deny_perm") {
    return { state: "denied", decision };
  }

  // Expiry check (allow_ttl)
  if (decision.ttl_expires_at !== null && decision.ttl_expires_at < now) {
    return { state: "expired" };
  }

  // Drift detection (§5.1): canonical mismatch → auto-revoke + re-prompt.
  if (decision.approver_set_canonical !== currentCanonical) {
    db.run(
      `UPDATE approval_decisions
       SET revoked_at = ?, revoke_reason = 'approver_set_drift'
       WHERE id = ?`,
      [now, decision.id],
    );
    audit(db, "drift_revoke", {
      agent_unit: decision.agent_unit,
      scope: decision.scope,
      action: decision.action,
      decision_id: decision.id,
      context: {
        stored_canonical: decision.approver_set_canonical,
        current_canonical: currentCanonical,
      },
    });
    return { state: "drift_revoked" };
  }

  // Single-shot deny — record the match and don't auto-renew.
  if (decision.decision === "deny") {
    return { state: "denied", decision };
  }

  // allow_once is SINGLE-USE. Burn it here, on the one and only successful
  // match, by revoking the row in the same statement that claims it. The
  // conditional `WHERE ... revoked_at IS NULL` is the compare-and-swap: a
  // single SQLite UPDATE is atomic and holds the write lock, so of two
  // concurrent uses (same process, or two processes on the same DB file)
  // exactly one observes changes === 1 and is granted; the loser observes
  // changes === 0 and is denied. Fail closed on the loser.
  //
  // Revoking (rather than only stamping last_used_at) is deliberate:
  // `lookupDecision` selects `... AND revoked_at IS NULL`, so a burned row
  // becomes invisible to the scope-keyed fast path and the next attempt
  // re-prompts with a fresh card. Marking it "used" but leaving it visible
  // would instead make it the newest matching row and return `denied`
  // forever, which would false-deny the re-prompt poll in the Drive/M365
  // pretools (src/cli/drive-write-pretool.ts:349).
  if (decision.decision === "allow_once") {
    const burn = db.run(
      `UPDATE approval_decisions
       SET last_used_at = ?, revoked_at = ?, revoke_reason = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [now, now, ALLOW_ONCE_CONSUMED_REASON, decision.id],
    );
    if ((burn.changes ?? 0) === 0) {
      // Lost the race (or already burned) — this use gets nothing.
      audit(db, "deny", {
        agent_unit: decision.agent_unit,
        scope: decision.scope,
        action: decision.action,
        decision_id: decision.id,
        context: { reason: ALLOW_ONCE_CONSUMED_REASON },
      });
      return { state: "denied", decision };
    }
    // The returned row deliberately carries the POST-burn truth: this is the
    // one and only `granted` verdict it will ever produce, and it is already
    // revoked. `state` is the authority for "may I proceed" — callers MUST
    // NOT re-gate a granted verdict on `revoked_at`. See the matching
    // invariant note on kernel-server.ts's approval_lookup handler.
    decision.last_used_at = now;
    decision.revoked_at = now;
    decision.revoke_reason = ALLOW_ONCE_CONSUMED_REASON;
    audit(db, "match", {
      agent_unit: decision.agent_unit,
      scope: decision.scope,
      action: decision.action,
      decision_id: decision.id,
    });
    audit(db, "revoke", {
      agent_unit: decision.agent_unit,
      scope: decision.scope,
      action: decision.action,
      decision_id: decision.id,
      context: { actor: "kernel", reason: ALLOW_ONCE_CONSUMED_REASON },
    });
    return { state: "granted", decision };
  }

  // §7 sliding-window TTL renewal for allow_ttl. Each successful match
  // updates last_used_at and extends ttl_expires_at by the original TTL,
  // capped at granted_at + max_lifetime.
  if (decision.decision === "allow_ttl") {
    const maxLifetime = opts.max_ttl_lifetime_ms ?? DEFAULT_MAX_TTL_LIFETIME_MS;
    const hardCap = decision.granted_at + maxLifetime;
    // Original TTL window = (ttl_expires_at - granted_at) at first grant.
    // last_used_at is null on first match; treat that as the original window.
    const originalWindow =
      decision.ttl_expires_at !== null
        ? decision.ttl_expires_at - (decision.last_used_at ?? decision.granted_at)
        : 0;
    let newExpires = decision.ttl_expires_at;
    if (originalWindow > 0) {
      newExpires = Math.min(now + originalWindow, hardCap);
    }
    db.run(
      `UPDATE approval_decisions
       SET last_used_at = ?, ttl_expires_at = ?
       WHERE id = ?`,
      [now, newExpires, decision.id],
    );
    decision.last_used_at = now;
    decision.ttl_expires_at = newExpires;
  } else {
    // allow_always — just update last_used_at for staleness. (allow_once is
    // handled above and never reaches here.)
    db.run(
      `UPDATE approval_decisions SET last_used_at = ? WHERE id = ?`,
      [now, decision.id],
    );
    decision.last_used_at = now;
  }

  audit(db, "match", {
    agent_unit: decision.agent_unit,
    scope: decision.scope,
    action: decision.action,
    decision_id: decision.id,
  });

  return { state: "granted", decision };
}

/**
 * Atomically consume a single-use nonce. Returns the nonce row on first
 * call; returns null on every subsequent call (already consumed, expired,
 * or unknown).
 */
export interface NonceRow {
  request_id: string;
  decision_id: string | null;
  agent_unit: string;
  scope: string;
  action: string;
  approver_set_canonical: string;
  why: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

function nonceFromRow(row: Record<string, unknown>): NonceRow {
  return {
    request_id: row.request_id as string,
    decision_id: (row.decision_id as string | null) ?? null,
    agent_unit: row.agent_unit as string,
    scope: row.scope as string,
    action: row.action as string,
    approver_set_canonical: row.approver_set_canonical as string,
    why: (row.why as string | null) ?? null,
    created_at: row.created_at as number,
    expires_at: row.expires_at as number,
    consumed_at: (row.consumed_at as number | null) ?? null,
  };
}

export function consumeNonce(
  db: Database,
  request_id: string,
  now: number = Date.now(),
): NonceRow | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_nonces WHERE request_id = ?`,
    )
    .get(request_id);
  if (!row) return null;

  const nonce = nonceFromRow(row);

  if (nonce.expires_at < now) {
    audit(db, "expire", {
      agent_unit: nonce.agent_unit,
      scope: nonce.scope,
      action: nonce.action,
      context: { request_id },
    });
    return null;
  }

  const result = db.run(
    `UPDATE approval_nonces SET consumed_at = ?
     WHERE request_id = ? AND consumed_at IS NULL`,
    [now, request_id],
  );

  if ((result.changes ?? 0) === 0) {
    return null;
  }

  audit(db, "consume", {
    agent_unit: nonce.agent_unit,
    scope: nonce.scope,
    action: nonce.action,
    context: { request_id },
  });
  return nonce;
}

/**
 * Record the user's decision and write the durable approval_decisions row.
 * Called by the gateway after a successful consumeNonce.
 */
export interface RecordDecisionInput {
  nonce: NonceRow;
  decision: ApprovalDecisionMode;
  approver_set: string[];      // current allowFrom (canonicalized inside)
  granted_by_user_id: number;  // Telegram user_id of approver
  ttl_ms?: number;             // for allow_ttl; ignored otherwise
  /**
   * Provenance of the operator-authorization. MUST be set by the SERVER from
   * the connection identity, never from a wire payload — 'operator' is only
   * legitimate on the host-side verifier's claude-unreachable channel.
   * Defaults to 'agent' (forgeable, not trusted by the broker mint gate).
   * See RFC vault-approval-hard-boundary + approval_decisions.origin.
   */
  origin?: "agent" | "operator";
  /**
   * Hard cap applied to `ttl_ms` at write time. Defaults to
   * DEFAULT_MAX_TTL_LIFETIME_MS. See the clamp note in recordDecision.
   */
  max_ttl_lifetime_ms?: number;
}

export function recordDecision(
  db: Database,
  input: RecordDecisionInput,
  now: number = Date.now(),
): string {
  const id = randomUUID();
  // Clamp ttl_ms at WRITE time, not only at match time. `ttl_ms` arrives over
  // the wire validated as nothing more than a positive int
  // (src/vault/broker/protocol.ts:302,363,380), so an unclamped write persists
  // an arbitrarily distant ttl_expires_at. evaluateDecisionRow's sliding-window
  // renewal caps to granted_at + max_lifetime on the first match, but readers
  // that never go through that path — isOperatorVerifiedDecision (kernel.ts,
  // used by the broker mint gate at src/vault/broker/server.ts:2405) and
  // listDecisions — compare ttl_expires_at to `now` directly, so a 100-year
  // TTL would be honoured verbatim by them. Clamping here makes the stored
  // value itself bounded and is the deterministic fix.
  const maxLifetime = input.max_ttl_lifetime_ms ?? DEFAULT_MAX_TTL_LIFETIME_MS;
  const ttl_expires_at =
    input.decision === "allow_ttl" && input.ttl_ms
      ? now + Math.min(input.ttl_ms, maxLifetime)
      : null;
  const canonical = canonicalizeApproverSet(input.approver_set);

  db.run(
    `INSERT INTO approval_decisions
       (id, agent_unit, scope, action, decision,
        ttl_expires_at, granted_at, granted_by_user_id,
        approver_set_canonical, last_used_at, revoked_at, revoke_reason, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    [
      id,
      input.nonce.agent_unit,
      input.nonce.scope,
      input.nonce.action,
      input.decision,
      ttl_expires_at,
      now,
      input.granted_by_user_id,
      canonical,
      input.origin ?? "agent",
    ],
  );

  // Link the nonce → decision for audit traceability.
  db.run(
    `UPDATE approval_nonces SET decision_id = ? WHERE request_id = ?`,
    [id, input.nonce.request_id],
  );

  const granted =
    input.decision === "allow_once" ||
    input.decision === "allow_always" ||
    input.decision === "allow_ttl";

  audit(db, granted ? "grant" : "deny", {
    agent_unit: input.nonce.agent_unit,
    scope: input.nonce.scope,
    action: input.nonce.action,
    decision_id: id,
    context: {
      request_id: input.nonce.request_id,
      decision: input.decision,
      ttl_ms: input.ttl_ms ?? null,
      granted_by_user_id: input.granted_by_user_id,
    },
  });

  return id;
}

/**
 * Atomically consume the single-use nonce AND record the decision in
 * ONE SQLite transaction (PR-6). Composes the existing primitives — no
 * new SQL. If `recordDecision` throws (or anything else in the body),
 * bun:sqlite rolls back the `consumed_at` burn too, so the nonce stays
 * reusable rather than being burned with no decision (the exact gap
 * that wedged the agent's turn when the broker died between the two
 * legacy ops — RFC §6.1 always specified this as one atomic
 * rowcount-gated step; the two-RPC split was a Phase-1 expedient, see
 * MIGRATION.md).
 *
 * `{ consumed: false }` ⇒ already-consumed / expired / unknown (race or
 * re-tap): NO decision row is written, identical to a standalone
 * `consumeNonce` returning null. Audit rows (`consume` + `grant|deny`,
 * or just `expire`) are emitted by the composed primitives and commit
 * atomically with the state — `approval_audit` is unchained
 * (schema.ts), so a rolled-back+retried call cannot corrupt any chain.
 *
 * NOTE: first explicit `db.transaction()` use in the repo — covered by
 * an explicit rollback-on-throw test.
 */
export function consumeAndRecord(
  db: Database,
  input: {
    request_id: string;
    decision: ApprovalDecisionMode;
    approver_set: string[];
    granted_by_user_id: number;
    ttl_ms?: number;
    /** Server-set provenance — see RecordDecisionInput.origin. Default 'agent'. */
    origin?: "agent" | "operator";
  },
  now: number = Date.now(),
): { consumed: false } | { consumed: true; decision_id: string; nonce: NonceRow } {
  const run = db.transaction(():
    | { consumed: false }
    | { consumed: true; decision_id: string; nonce: NonceRow } => {
    const nonce = consumeNonce(db, input.request_id, now);
    if (nonce === null) return { consumed: false };
    const decision_id = recordDecision(
      db,
      {
        nonce,
        decision: input.decision,
        approver_set: input.approver_set,
        granted_by_user_id: input.granted_by_user_id,
        ttl_ms: input.ttl_ms,
        origin: input.origin,
      },
      now,
    );
    return { consumed: true, decision_id, nonce };
  });
  return run();
}

/**
 * Revoke a decision by id. Idempotent (revoking a revoked row is a no-op).
 * `reason` is persisted into approval_decisions.revoke_reason.
 */
export function revokeDecision(
  db: Database,
  decision_id: string,
  actor: string,
  reason?: string,
  now: number = Date.now(),
): boolean {
  // Read first so we can build the audit row with agent_unit/scope/action.
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_decisions WHERE id = ?`,
    )
    .get(decision_id);
  if (!row) return false;
  const decision = rowToDecision(row);
  if (decision.revoked_at !== null) return false;

  const result = db.run(
    `UPDATE approval_decisions SET revoked_at = ?, revoke_reason = ?
     WHERE id = ? AND revoked_at IS NULL`,
    [now, reason ?? null, decision_id],
  );
  if ((result.changes ?? 0) === 0) return false;

  audit(db, "revoke", {
    agent_unit: decision.agent_unit,
    scope: decision.scope,
    action: decision.action,
    decision_id,
    context: { actor, reason: reason ?? null },
  });
  return true;
}

/**
 * List active (non-revoked, non-expired) decisions.
 * Optional `agent_unit` filter for the per-agent /approvals list view (§9).
 */
export function listDecisions(
  db: Database,
  filter?: { agent_unit?: string; include_revoked?: boolean },
  now: number = Date.now(),
): DecisionRow[] {
  const includeRevoked = filter?.include_revoked === true;
  let sql = `SELECT * FROM approval_decisions WHERE 1=1`;
  const params: unknown[] = [];
  if (!includeRevoked) {
    sql += ` AND revoked_at IS NULL AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)`;
    params.push(now);
  }
  if (filter?.agent_unit !== undefined) {
    sql += ` AND agent_unit = ?`;
    params.push(filter.agent_unit);
  }
  sql += ` ORDER BY granted_at DESC`;
  const rows = (
    db.query(sql) as unknown as {
      all: (...binds: unknown[]) => Record<string, unknown>[];
    }
  ).all(...params);
  return rows.map(rowToDecision);
}

/** Get a single decision by id (for /approvals revoke confirmation, etc). */
export function getDecision(db: Database, id: string): DecisionRow | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_decisions WHERE id = ?`,
    )
    .get(id);
  return row ? rowToDecision(row) : null;
}

/**
 * Is `dec` proof that an OPERATOR verified this grant for `agent_unit`?
 * The broker's hard-boundary mint gate (RFC vault-approval-hard-boundary)
 * uses this to decide whether a posture-attested mint is backed by a real
 * operator tap. True iff the decision exists, was recorded with
 * `origin='operator'` (host-side verifier — claude can't produce this),
 * belongs to this agent, is an allow-mode, not revoked, and not expired.
 * Pure — unit-tested directly; fails closed on null / any missing condition.
 */
export function isOperatorVerifiedDecision(
  dec: DecisionRow | null,
  agent_unit: string,
  now: number = Date.now(),
): boolean {
  return (
    dec !== null &&
    dec.origin === "operator" &&
    dec.agent_unit === agent_unit &&
    dec.revoked_at === null &&
    (dec.decision === "allow_once" ||
      dec.decision === "allow_always" ||
      dec.decision === "allow_ttl") &&
    (dec.ttl_expires_at === null || dec.ttl_expires_at > now)
  );
}

/** Get a pending/recently-consumed nonce (for callback handlers). */
export function getNonce(db: Database, request_id: string): NonceRow | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_nonces WHERE request_id = ?`,
    )
    .get(request_id);
  return row ? nonceFromRow(row) : null;
}
