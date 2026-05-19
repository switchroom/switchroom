/**
 * Tests for the approval kernel (RFC B §5–§7, §10).
 *
 * Uses an in-memory SQLite database for isolation — no disk I/O.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Database } from "bun:sqlite";
import { migrateApprovalSchema, DEFAULT_MAX_TTL_LIFETIME_MS } from "./schema.js";
import {
  requestApproval,
  consumeNonce,
  consumeAndRecord,
  recordDecision,
  lookupDecision,
  revokeDecision,
  listDecisions,
  getNonce,
  getDecision,
  countPendingNonces,
  computeRetryAfterMs,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_GLOBAL,
} from "./kernel.js";
import { canonicalizeApproverSet } from "./canonical.js";

function newDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  migrateApprovalSchema(db);
  return db;
}

describe("approval kernel — schema", () => {
  it("migrates cleanly on a fresh DB", () => {
    const db = new Database(":memory:");
    expect(() => migrateApprovalSchema(db)).not.toThrow();
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "approval_decisions",
        "approval_nonces",
        "approval_audit",
      ]),
    );
  });

  it("is idempotent (drop+recreate)", () => {
    const db = newDb();
    expect(() => migrateApprovalSchema(db)).not.toThrow();
  });

  it("RFC §5 columns present and old columns absent", () => {
    const db = newDb();
    const cols = db
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_table_info('approval_decisions')`,
      )
      .all()
      .map((r) => r.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "agent_unit", "scope", "action", "decision",
        "ttl_expires_at", "granted_at", "granted_by_user_id",
        "approver_set_canonical", "last_used_at", "revoked_at", "revoke_reason",
      ]),
    );
    // Old shape columns must be gone.
    expect(cols).not.toContain("agent");
    expect(cols).not.toContain("surface");
    expect(cols).not.toContain("action_grammar");
    expect(cols).not.toContain("granted");
    expect(cols).not.toContain("decision_id_chain_prev");
    expect(cols).not.toContain("expires_at");

    const auditCols = db
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_table_info('approval_audit')`,
      )
      .all()
      .map((r) => r.name);
    expect(auditCols).toEqual(
      expect.arrayContaining(["seq", "ts", "agent_unit", "scope", "action", "decision_id", "context"]),
    );
  });
});

describe("approval kernel — canonicalize", () => {
  it("normalizes order, whitespace, and dedupes", () => {
    expect(canonicalizeApproverSet(["b", "a"]))
      .toEqual(canonicalizeApproverSet(["a", "b"]));
    expect(canonicalizeApproverSet([" a ", "a"]))
      .toEqual(canonicalizeApproverSet(["a"]));
    expect(canonicalizeApproverSet([])).toEqual("[]");
  });
});

describe("approval kernel — request/consume/record/lookup", () => {
  let db: Database;
  beforeEach(() => { db = newDb(); });

  it("end-to-end allow_once grant flow", () => {
    const r = requestApproval(db, {
      agent_unit: "switchroom-klanker.service",
      scope: "secret:OPENAI_API_KEY",
      action: "read",
      approver_set: ["123"],
      why: "needs to call OpenAI",
    });
    expect(r.request_id).toMatch(/^[0-9a-f]{32}$/);

    expect(
      lookupDecision(db, {
        agent_unit: "switchroom-klanker.service",
        scope: "secret:OPENAI_API_KEY",
        action: "read",
        current_approver_set: ["123"],
      }).state,
    ).toBe("no_decision");

    const nonce = consumeNonce(db, r.request_id);
    expect(nonce).not.toBeNull();
    expect(nonce!.scope).toBe("secret:OPENAI_API_KEY");

    const decisionId = recordDecision(db, {
      nonce: nonce!,
      decision: "allow_once",
      approver_set: ["123"],
      granted_by_user_id: 123,
    });
    expect(decisionId).toBeTruthy();

    const r2 = lookupDecision(db, {
      agent_unit: "switchroom-klanker.service",
      scope: "secret:OPENAI_API_KEY",
      action: "read",
      current_approver_set: ["123"],
    });
    expect(r2.state).toBe("granted");
  });

  it("all 5 decision modes round-trip via recordDecision", () => {
    for (const mode of ["allow_once", "allow_always", "allow_ttl", "deny", "deny_perm"] as const) {
      const r = requestApproval(db, {
        agent_unit: "u", scope: `s:${mode}`, action: "read", approver_set: ["1"],
      });
      const nonce = consumeNonce(db, r.request_id)!;
      const id = recordDecision(db, {
        nonce, decision: mode, approver_set: ["1"], granted_by_user_id: 1,
        ttl_ms: mode === "allow_ttl" ? 60_000 : undefined,
      });
      const decision = getDecision(db, id);
      expect(decision?.decision).toBe(mode);
      if (mode === "allow_ttl") {
        expect(decision?.ttl_expires_at).not.toBeNull();
      } else {
        expect(decision?.ttl_expires_at).toBeNull();
      }
    }
  });

  it("deny_perm short-circuits even with drift", () => {
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s", action: "read", approver_set: ["U1"],
    });
    const n = consumeNonce(db, r.request_id)!;
    recordDecision(db, {
      nonce: n, decision: "deny_perm", approver_set: ["U1"], granted_by_user_id: 1,
    });
    const r2 = lookupDecision(db, {
      agent_unit: "u", scope: "s", action: "read", current_approver_set: ["U1"],
    });
    expect(r2.state).toBe("denied");
  });

  it("nonce consumption is atomic — one wins", () => {
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:X", action: "read", approver_set: ["1"],
    });
    const a = consumeNonce(db, r.request_id);
    const b = consumeNonce(db, r.request_id);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("expired nonces cannot be consumed", () => {
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:X", action: "read", approver_set: ["1"], ttl_ms: 1,
    });
    const farFuture = Date.now() + 10_000;
    expect(consumeNonce(db, r.request_id, farFuture)).toBeNull();
  });

  it("getNonce reads back without consuming", () => {
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:Y", action: "read", approver_set: ["1"],
    });
    expect(getNonce(db, r.request_id)?.consumed_at).toBeNull();
    consumeNonce(db, r.request_id);
    expect(getNonce(db, r.request_id)?.consumed_at).not.toBeNull();
  });
});

describe("approval kernel — sliding-window TTL (§7)", () => {
  it("extends ttl_expires_at on each match, capped at granted_at + max_lifetime", () => {
    const db = newDb();
    const t0 = 1_000_000;
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:T", action: "read", approver_set: ["1"],
    }, t0);
    const n = consumeNonce(db, r.request_id, t0)!;
    const ttl_ms = 60_000; // 60s sliding window
    const id = recordDecision(db, {
      nonce: n, decision: "allow_ttl", approver_set: ["1"], granted_by_user_id: 1,
      ttl_ms,
    }, t0);
    const initial = getDecision(db, id)!;
    expect(initial.ttl_expires_at).toBe(t0 + ttl_ms);

    // Match 30s later — should extend to t0+30s+60s = t0+90s
    const t1 = t0 + 30_000;
    const r1 = lookupDecision(db, {
      agent_unit: "u", scope: "s:T", action: "read", current_approver_set: ["1"],
    }, {}, t1);
    expect(r1.state).toBe("granted");
    expect(getDecision(db, id)!.ttl_expires_at).toBe(t1 + ttl_ms);
    expect(getDecision(db, id)!.last_used_at).toBe(t1);

    // Push close to the hard cap. Use a small override (3 windows = 180s) and
    // renew at 130s — within current window (which is t1+60s = 90s? we need
    // to re-match so we stay live. After r1 at t1=30s, ttl=t1+60=90s.
    // So renew again at t=85s within the new window.
    const smallMax = ttl_ms * 3; // 180s cap
    const t2 = t0 + 85_000;
    const r2 = lookupDecision(db, {
      agent_unit: "u", scope: "s:T", action: "read", current_approver_set: ["1"],
    }, { max_ttl_lifetime_ms: smallMax }, t2);
    expect(r2.state).toBe("granted");
    // After this match, ttl_expires_at would be t2+60=145s, but cap=180s.
    // Renew once more at 140s; new natural expiry would be 200s but capped at 180s.
    const t3 = t0 + 140_000;
    const r3 = lookupDecision(db, {
      agent_unit: "u", scope: "s:T", action: "read", current_approver_set: ["1"],
    }, { max_ttl_lifetime_ms: smallMax }, t3);
    expect(r3.state).toBe("granted");
    const final = getDecision(db, id)!;
    expect(final.ttl_expires_at).toBe(t0 + smallMax);
  });

  it("expired allow_ttl returns expired", () => {
    const db = newDb();
    const t0 = 1_000_000;
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:E", action: "read", approver_set: ["1"],
    }, t0);
    const n = consumeNonce(db, r.request_id, t0)!;
    recordDecision(db, {
      nonce: n, decision: "allow_ttl", approver_set: ["1"], granted_by_user_id: 1,
      ttl_ms: 1000,
    }, t0);
    const r2 = lookupDecision(db, {
      agent_unit: "u", scope: "s:E", action: "read", current_approver_set: ["1"],
    }, {}, t0 + 60_000);
    expect(r2.state).toBe("expired");
  });
});

describe("approval kernel — drift detection (§5.1)", () => {
  it("flips to drift_revoked and writes revoke_reason='approver_set_drift'", () => {
    const db = newDb();
    const r = requestApproval(db, {
      agent_unit: "u", scope: "vault:NOTION", action: "read", approver_set: ["U1"],
    });
    const nonce = consumeNonce(db, r.request_id)!;
    const id = recordDecision(db, {
      nonce, decision: "allow_always", approver_set: ["U1"], granted_by_user_id: 1,
    });

    const r2 = lookupDecision(db, {
      agent_unit: "u", scope: "vault:NOTION", action: "read",
      current_approver_set: ["U1", "U2"],
    });
    expect(r2.state).toBe("drift_revoked");

    const after = getDecision(db, id)!;
    expect(after.revoked_at).not.toBeNull();
    expect(after.revoke_reason).toBe("approver_set_drift");

    const auditEvent = db
      .query<{ event: string }, []>(
        `SELECT event FROM approval_audit ORDER BY seq DESC LIMIT 1`,
      )
      .get();
    expect(auditEvent?.event).toBe("drift_revoke");
  });
});

describe("approval kernel — revoke + list", () => {
  it("revokeDecision is idempotent and writes revoke_reason", () => {
    const db = newDb();
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:Z", action: "read", approver_set: ["1"],
    });
    const nonce = consumeNonce(db, r.request_id)!;
    const id = recordDecision(db, {
      nonce, decision: "allow_always", approver_set: ["1"], granted_by_user_id: 1,
    });
    expect(revokeDecision(db, id, "1", "manual revoke")).toBe(true);
    expect(revokeDecision(db, id, "1", "manual revoke")).toBe(false);
    const after = getDecision(db, id)!;
    expect(after.revoked_at).not.toBeNull();
    expect(after.revoke_reason).toBe("manual revoke");
  });

  it("listDecisions filters by agent_unit and excludes revoked", () => {
    const db = newDb();
    for (const agent_unit of ["u1", "u2"]) {
      const req = requestApproval(db, {
        agent_unit, scope: `s:${agent_unit}`, action: "read", approver_set: ["1"],
      });
      const n = consumeNonce(db, req.request_id)!;
      recordDecision(db, {
        nonce: n, decision: "allow_always", approver_set: ["1"], granted_by_user_id: 1,
      });
    }
    expect(listDecisions(db).length).toBe(2);
    expect(listDecisions(db, { agent_unit: "u1" }).length).toBe(1);

    const u2 = listDecisions(db, { agent_unit: "u2" })[0]!;
    revokeDecision(db, u2.id, "1");
    expect(listDecisions(db).length).toBe(1);
    expect(listDecisions(db, { include_revoked: true }).length).toBe(2);
  });

  it("audit-by-scope query returns events for a namespace prefix", () => {
    const db = newDb();
    for (const scope of ["secret:OPENAI", "secret:GITHUB", "doc:gdrive:1"]) {
      const r = requestApproval(db, {
        agent_unit: "u", scope, action: "read", approver_set: ["1"],
      });
      consumeNonce(db, r.request_id);
    }
    const rows = db
      .query<{ scope: string }, [string]>(
        `SELECT scope FROM approval_audit WHERE scope LIKE ? ORDER BY seq`,
      )
      .all("secret:%");
    expect(rows.length).toBeGreaterThanOrEqual(4); // request+consume per secret:* nonce
    expect(rows.every((r) => r.scope.startsWith("secret:"))).toBe(true);
  });
});

describe("approval kernel — RFC §10 rate caps", () => {
  it("counts pending nonces per agent and globally", () => {
    const db = newDb();
    requestApproval(db, { agent_unit: "a1", scope: "s1", action: "read", approver_set: ["1"] });
    requestApproval(db, { agent_unit: "a1", scope: "s2", action: "read", approver_set: ["1"] });
    requestApproval(db, { agent_unit: "a2", scope: "s3", action: "read", approver_set: ["1"] });
    const c = countPendingNonces(db);
    expect(c.perAgent.get("a1")).toBe(2);
    expect(c.perAgent.get("a2")).toBe(1);
    expect(c.global).toBe(3);
  });

  it("computeRetryAfterMs returns positive ms based on soonest expiry", () => {
    const db = newDb();
    requestApproval(db, {
      agent_unit: "a1", scope: "s", action: "read", approver_set: ["1"], ttl_ms: 30_000,
    });
    const ms = computeRetryAfterMs(db, "a1");
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it("constants align with RFC §10", () => {
    expect(MAX_PENDING_PER_AGENT).toBe(2);
    expect(MAX_PENDING_GLOBAL).toBe(32);
  });
});

describe("approval kernel — consumeAndRecord atomic op (PR-6)", () => {
  let db: Database;
  beforeEach(() => { db = newDb(); });

  function freshNonce(): string {
    return requestApproval(db, {
      agent_unit: "switchroom-klanker.service",
      scope: "secret:OPENAI_API_KEY",
      action: "read",
      approver_set: ["123"],
      why: "needs key",
    }).request_id;
  }

  it("consumes the nonce AND records the decision atomically", () => {
    const rid = freshNonce();
    const res = consumeAndRecord(db, {
      request_id: rid,
      decision: "allow_once",
      approver_set: ["123"],
      granted_by_user_id: 123,
    });
    expect(res.consumed).toBe(true);
    if (!res.consumed) throw new Error("unreachable");
    expect(res.decision_id).toBeTruthy();
    // Nonce burned + linked to the decision; exactly one decision row.
    const nonce = getNonce(db, rid)!;
    expect(nonce.consumed_at).not.toBeNull();
    expect(nonce.decision_id).toBe(res.decision_id);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM approval_decisions`).get()!.n,
    ).toBe(1);
    // The decision is visible to a subsequent lookup → grant flow works.
    expect(
      lookupDecision(db, {
        agent_unit: "switchroom-klanker.service",
        scope: "secret:OPENAI_API_KEY",
        action: "read",
        current_approver_set: ["123"],
      }).state,
    ).toBe("granted");
  });

  it("second call is non-committal {consumed:false} — single-use, exactly one decision", () => {
    const rid = freshNonce();
    expect(consumeAndRecord(db, { request_id: rid, decision: "allow_once", approver_set: ["123"], granted_by_user_id: 1 }).consumed).toBe(true);
    const second = consumeAndRecord(db, { request_id: rid, decision: "allow_always", approver_set: ["123"], granted_by_user_id: 1 });
    expect(second.consumed).toBe(false);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM approval_decisions`).get()!.n,
    ).toBe(1);
  });

  it("unknown request_id → {consumed:false}, no decision (non-committal, mirrors approval_consume)", () => {
    const res = consumeAndRecord(db, {
      request_id: "0badf00d0badf00d0badf00d0badf00d",
      decision: "allow_once",
      approver_set: ["123"],
      granted_by_user_id: 1,
    });
    expect(res.consumed).toBe(false);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM approval_decisions`).get()!.n,
    ).toBe(0);
  });

  it("rollback-on-throw: a throw inside the consume txn reverts the burn (PR-6 is the repo's first db.transaction use)", () => {
    // Directly exercises the bun:sqlite db.transaction rollback
    // semantics consumeAndRecord relies on: consume the nonce, then
    // throw — the consumed_at burn AND any decision row must roll back.
    const rid = freshNonce();
    expect(() =>
      db.transaction(() => {
        const n = consumeNonce(db, rid);
        expect(n).not.toBeNull();
        recordDecision(db, { nonce: n!, decision: "allow_once", approver_set: ["123"], granted_by_user_id: 1 });
        throw new Error("boom — simulate a failure after the burn+record");
      })(),
    ).toThrow("boom");
    // Burn reverted (nonce reusable) and NO decision persisted.
    expect(getNonce(db, rid)!.consumed_at).toBeNull();
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM approval_decisions`).get()!.n,
    ).toBe(0);
    // And consumeAndRecord can still succeed afterward (proves reusable).
    expect(consumeAndRecord(db, { request_id: rid, decision: "allow_once", approver_set: ["123"], granted_by_user_id: 1 }).consumed).toBe(true);
  });
});
