/**
 * Tests for the approval-decision `origin` provenance (RFC vault-approval-
 * hard-boundary, PR ①). `origin='operator'` is the only value the broker's
 * mint gate trusts as proof an operator tapped; it must be server-set (never
 * from a wire payload) and default to the forgeable 'agent'.
 *
 * Runs under bun (bun:sqlite).
 */
import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { migrateApprovalSchema } from "./schema.js";
import {
  requestApproval,
  consumeNonce,
  consumeAndRecord,
  recordDecision,
  getDecision,
  revokeDecision,
  isOperatorVerifiedDecision,
  type DecisionRow,
} from "./kernel.js";

function newDb(): Database {
  const db = new Database(":memory:");
  migrateApprovalSchema(db);
  return db;
}

function mintNonce(db: Database, agent_unit = "clerk", scope = "vault:k") {
  const r = requestApproval(db, {
    agent_unit,
    scope,
    action: "grant",
    approver_set: ["123"],
  });
  return consumeNonce(db, r.request_id)!;
}

describe("approval_decisions.origin", () => {
  it("defaults to 'agent' when not specified", () => {
    const db = newDb();
    const id = recordDecision(db, {
      nonce: mintNonce(db),
      decision: "allow_once",
      approver_set: ["123"],
      granted_by_user_id: 123,
    });
    expect(getDecision(db, id)?.origin).toBe("agent");
    db.close();
  });

  it("persists 'operator' when set, and getDecision round-trips it", () => {
    const db = newDb();
    const id = recordDecision(db, {
      nonce: mintNonce(db),
      decision: "allow_always",
      approver_set: ["123"],
      granted_by_user_id: 123,
      origin: "operator",
    });
    expect(getDecision(db, id)?.origin).toBe("operator");
    db.close();
  });

  it("consumeAndRecord threads origin through", () => {
    const db = newDb();
    const r = requestApproval(db, {
      agent_unit: "clerk",
      scope: "vault:k",
      action: "grant",
      approver_set: ["123"],
    });
    const res = consumeAndRecord(db, {
      request_id: r.request_id,
      decision: "allow_once",
      approver_set: ["123"],
      granted_by_user_id: 123,
      origin: "operator",
    });
    expect(res.consumed).toBe(true);
    if (res.consumed) {
      expect(getDecision(db, res.decision_id)?.origin).toBe("operator");
    }
    db.close();
  });

  it("migrateApprovalSchema is idempotent with the origin column", () => {
    const db = newDb();
    expect(() => migrateApprovalSchema(db)).not.toThrow();
    const cols = db
      .query("PRAGMA table_info(approval_decisions)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "origin")).toBe(true);
    db.close();
  });
});

describe("isOperatorVerifiedDecision — the broker mint gate predicate", () => {
  const base: DecisionRow = {
    id: "d1",
    agent_unit: "clerk",
    scope: "vault:k",
    action: "grant",
    decision: "allow_once",
    ttl_expires_at: null,
    granted_at: 1000,
    granted_by_user_id: 123,
    approver_set_canonical: "123",
    last_used_at: null,
    revoked_at: null,
    revoke_reason: null,
    origin: "operator",
  };

  it("accepts an operator-verified, matching, allow, unexpired, unrevoked decision", () => {
    expect(isOperatorVerifiedDecision(base, "clerk", 2000)).toBe(true);
  });

  it("rejects null (no decision referenced)", () => {
    expect(isOperatorVerifiedDecision(null, "clerk")).toBe(false);
  });

  it("rejects origin='agent' (forgeable — the whole point)", () => {
    expect(isOperatorVerifiedDecision({ ...base, origin: "agent" }, "clerk", 2000)).toBe(false);
  });

  it("rejects a decision for a different agent", () => {
    expect(isOperatorVerifiedDecision(base, "marko", 2000)).toBe(false);
  });

  it("rejects a deny decision", () => {
    expect(isOperatorVerifiedDecision({ ...base, decision: "deny" }, "clerk", 2000)).toBe(false);
    expect(isOperatorVerifiedDecision({ ...base, decision: "deny_perm" }, "clerk", 2000)).toBe(false);
  });

  it("rejects a revoked decision", () => {
    expect(isOperatorVerifiedDecision({ ...base, revoked_at: 1500 }, "clerk", 2000)).toBe(false);
  });

  it("rejects an expired allow_ttl decision; accepts an unexpired one", () => {
    const ttl = { ...base, decision: "allow_ttl" as const, ttl_expires_at: 1800 };
    expect(isOperatorVerifiedDecision(ttl, "clerk", 2000)).toBe(false); // expired
    expect(isOperatorVerifiedDecision(ttl, "clerk", 1700)).toBe(true); // still valid
  });

  it("real round-trip: an operator-origin decision read back via getDecision passes", () => {
    const db = newDb();
    const id = recordDecision(db, {
      nonce: mintNonce(db, "clerk"),
      decision: "allow_once",
      approver_set: ["123"],
      granted_by_user_id: 123,
      origin: "operator",
    });
    expect(isOperatorVerifiedDecision(getDecision(db, id), "clerk")).toBe(true);
    // and once revoked, it fails closed
    revokeDecision(db, id, "operator", "test");
    expect(isOperatorVerifiedDecision(getDecision(db, id), "clerk")).toBe(false);
    db.close();
  });
});
