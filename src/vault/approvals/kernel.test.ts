/**
 * Tests for the approval kernel (RFC B §5–§7, §10).
 *
 * Uses an in-memory SQLite database for isolation — no disk I/O, except the
 * allow_once concurrency test, which needs a real file so several
 * independent connections can race the same row (it cleans up its tmpdir).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrateApprovalSchema, DEFAULT_MAX_TTL_LIFETIME_MS } from "./schema.js";
import {
  requestApproval,
  consumeNonce,
  consumeAndRecord,
  recordDecision,
  lookupDecision,
  lookupDecisionByRequestId,
  revokeDecision,
  listDecisions,
  getNonce,
  getDecision,
  countPendingNonces,
  computeRetryAfterMs,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_GLOBAL,
  ALLOW_ONCE_CONSUMED_REASON,
  isOperatorVerifiedDecision,
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

describe("approval kernel — lookupDecisionByRequestId (verdict correlation, W2)", () => {
  let db: Database;
  beforeEach(() => { db = newDb(); });

  const AGENT = "switchroom-klanker.service";
  const SCOPE = "ms-365:write:(new)"; // the collision-prone shared scope

  it("unknown request_id → no_decision", () => {
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT,
        request_id: "0".repeat(32),
        current_approver_set: ["1"],
      }).state,
    ).toBe("no_decision");
  });

  it("registered but undecided → pending", () => {
    const r = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: r.request_id, current_approver_set: ["1"],
      }).state,
    ).toBe("pending");
  });

  it("does NOT cross-attribute a same-scope concurrent request's verdict", () => {
    // Two concurrent writes share the scope `ms-365:write:(new)`.
    const reqA = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    const reqB = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });

    // Operator approves ONLY request A. Deliberately allow_always, not
    // allow_once: this test pins scope-keyed MIS-ATTRIBUTION, and a one-shot
    // would be burned by the first lookup below (see the "allow_once is
    // single-use" suite), hiding the very leak this asserts.
    const resA = consumeAndRecord(db, {
      request_id: reqA.request_id,
      decision: "allow_always",
      approver_set: ["1"],
      granted_by_user_id: 1,
    });
    expect(resA.consumed).toBe(true);

    // Request A's own verdict → granted.
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: reqA.request_id, current_approver_set: ["1"],
      }).state,
    ).toBe("granted");

    // Request B must NOT inherit A's grant — it's still pending (its own
    // card hasn't been tapped). The old scope-keyed lookup returned
    // "granted" here, which was the fail-open mis-attribution.
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: reqB.request_id, current_approver_set: ["1"],
      }).state,
    ).toBe("pending");

    // Contrast: the scope-keyed lookup DOES see the leaked grant — this is
    // exactly why the hook must correlate by request_id, not scope.
    expect(
      lookupDecision(db, {
        agent_unit: AGENT, scope: SCOPE, action: "write", current_approver_set: ["1"],
      }).state,
    ).toBe("granted");
  });

  it("independently reflects deny for the specific request", () => {
    const reqA = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    const reqB = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    consumeAndRecord(db, {
      request_id: reqB.request_id, decision: "deny",
      approver_set: ["1"], granted_by_user_id: 1,
    });
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: reqB.request_id, current_approver_set: ["1"],
      }).state,
    ).toBe("denied");
    // A is untouched.
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: reqA.request_id, current_approver_set: ["1"],
      }).state,
    ).toBe("pending");
  });

  it("enforces cross-agent isolation — a foreign agent_unit gets no_decision", () => {
    const r = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    consumeAndRecord(db, {
      request_id: r.request_id, decision: "allow_once",
      approver_set: ["1"], granted_by_user_id: 1,
    });
    // Same request_id, different (attacker) agent_unit → no verdict oracle.
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: "switchroom-evil.service",
        request_id: r.request_id,
        current_approver_set: ["1"],
      }).state,
    ).toBe("no_decision");
  });

  it("a revoked decision is terminal-not-granted for its request", () => {
    const r = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    const res = consumeAndRecord(db, {
      request_id: r.request_id, decision: "allow_once",
      approver_set: ["1"], granted_by_user_id: 1,
    });
    expect(res.consumed).toBe(true);
    revokeDecision(db, (res as { decision_id: string }).decision_id, "operator", "test");
    expect(
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: r.request_id, current_approver_set: ["1"],
      }).state,
    ).toBe("denied");
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

describe("approval kernel — allow_once is single-use (burned on first grant)", () => {
  const AGENT = "switchroom-klanker.service";
  const SCOPE = "doc:gdrive:write:1AbCdEfGh";

  let db: Database;
  beforeEach(() => { db = newDb(); });

  /** Operator taps "Allow once" on a card for (AGENT, SCOPE, write). */
  function grantOnce(dbh: Database = db): string {
    const r = requestApproval(dbh, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    const res = consumeAndRecord(dbh, {
      request_id: r.request_id,
      decision: "allow_once",
      approver_set: ["1"],
      granted_by_user_id: 1,
    });
    if (!res.consumed) throw new Error("setup: nonce not consumed");
    return res.decision_id;
  }

  function scopeLookup(dbh: Database = db) {
    return lookupDecision(dbh, {
      agent_unit: AGENT, scope: SCOPE, action: "write", current_approver_set: ["1"],
    });
  }

  it("grants exactly once on the scope-keyed fast path, then stops granting", () => {
    grantOnce();
    // Use #1 — the write the operator actually approved.
    expect(scopeLookup().state).toBe("granted");
    // Use #2..#4 — the bug: these used to be silently auto-approved forever
    // via src/cli/drive-write-pretool.ts:349.
    expect(scopeLookup().state).toBe("no_decision");
    expect(scopeLookup().state).toBe("no_decision");
    expect(scopeLookup().state).toBe("no_decision");
  });

  it("grants exactly once on the request-id-keyed path too", () => {
    const r = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    expect(
      consumeAndRecord(db, {
        request_id: r.request_id, decision: "allow_once",
        approver_set: ["1"], granted_by_user_id: 1,
      }).consumed,
    ).toBe(true);
    const byId = () =>
      lookupDecisionByRequestId(db, {
        agent_unit: AGENT, request_id: r.request_id, current_approver_set: ["1"],
      }).state;
    expect(byId()).toBe("granted");
    // Burned → terminal-not-granted for this request. Fail closed.
    expect(byId()).toBe("denied");
    expect(byId()).toBe("denied");
  });

  it("burns by revoking, stamped with a distinguishable reason", () => {
    const id = grantOnce();
    expect(getDecision(db, id)!.revoked_at).toBeNull();
    expect(scopeLookup().state).toBe("granted");
    const after = getDecision(db, id)!;
    expect(after.revoked_at).not.toBeNull();
    expect(after.revoke_reason).toBe(ALLOW_ONCE_CONSUMED_REASON);
    expect(after.last_used_at).not.toBeNull();
    // A burned one-shot is no longer an active grant in the operator view.
    expect(listDecisions(db, { agent_unit: AGENT }).map((d) => d.id)).not.toContain(id);
  });

  it("allow_always is NOT burned — the contrast that proves the fix is scoped", () => {
    const r = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    consumeAndRecord(db, {
      request_id: r.request_id, decision: "allow_always",
      approver_set: ["1"], granted_by_user_id: 1,
    });
    expect(scopeLookup().state).toBe("granted");
    expect(scopeLookup().state).toBe("granted");
    expect(scopeLookup().state).toBe("granted");
  });

  it("a burned one-shot re-prompts cleanly — the next tap grants once again", () => {
    grantOnce();
    expect(scopeLookup().state).toBe("granted");
    // no_decision (not 'denied') is what lets the pretool post a fresh card
    // and poll without false-denying itself.
    expect(scopeLookup().state).toBe("no_decision");
    grantOnce();
    expect(scopeLookup().state).toBe("granted");
    expect(scopeLookup().state).toBe("no_decision");
  });

  it("a burned one-shot is not operator-verified proof for the broker mint gate", () => {
    const r = requestApproval(db, {
      agent_unit: AGENT, scope: SCOPE, action: "write", approver_set: ["1"],
    });
    const res = consumeAndRecord(db, {
      request_id: r.request_id, decision: "allow_once",
      approver_set: ["1"], granted_by_user_id: 1, origin: "operator",
    });
    if (!res.consumed) throw new Error("setup");
    expect(isOperatorVerifiedDecision(getDecision(db, res.decision_id), AGENT)).toBe(true);
    expect(scopeLookup().state).toBe("granted");
    expect(isOperatorVerifiedDecision(getDecision(db, res.decision_id), AGENT)).toBe(false);
  });

  it("exactly one grant across independent connections to one allow_once row", () => {
    // Honest about what this exercises: `conns.map(...)` below is a
    // SEQUENTIAL synchronous map — this is not parallel execution. What it
    // proves, and what the in-memory tests above cannot, is that the burn is
    // durable in the FILE and immediately visible to other connections: eight
    // separate hook processes each opening their own handle get exactly one
    // grant between them. The atomicity of the losing claim is pinned
    // separately by the compare-and-swap test below.
    //
    // NB if this is ever made genuinely parallel: these connections do NOT set
    // `PRAGMA busy_timeout` (openKernelDb does — kernel-server.ts:91), and
    // bun:sqlite defaults it to 0ms, so a contending writer would fail
    // immediately with SQLITE_BUSY rather than wait, and this would flake.
    // Production goes through openKernelDb and waits up to 5s.
    const dir = mkdtempSync(join(tmpdir(), "kernel-once-race-"));
    const path = join(dir, "kernel.sqlite");
    const conns: Database[] = [];
    try {
      const writer = new Database(path);
      writer.run("PRAGMA journal_mode=WAL");
      migrateApprovalSchema(writer);
      grantOnce(writer);
      writer.close();

      for (let i = 0; i < 8; i++) conns.push(new Database(path));
      const states = conns.map((c) => scopeLookup(c).state);
      expect(states.filter((s) => s === "granted").length).toBe(1);
      expect(states.filter((s) => s !== "granted").length).toBe(7);
    } finally {
      for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the burn UPDATE is a compare-and-swap — a racing loser claims nothing", () => {
    // Models the interleave where two callers both pass the SELECT before
    // either writes: the second conditional UPDATE must report 0 changes,
    // which is the branch that returns 'denied' rather than 'granted'.
    const id = grantOnce();
    expect(scopeLookup().state).toBe("granted");
    const loser = db.run(
      `UPDATE approval_decisions
       SET last_used_at = ?, revoked_at = ?, revoke_reason = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [Date.now(), Date.now(), ALLOW_ONCE_CONSUMED_REASON, id],
    );
    expect(loser.changes ?? 0).toBe(0);
  });
});

describe("approval kernel — ttl_ms is clamped at write time", () => {
  let db: Database;
  beforeEach(() => { db = newDb(); });

  function recordTtl(ttl_ms: number, max?: number): string {
    const r = requestApproval(db, {
      agent_unit: "u", scope: "s:ttl", action: "read", approver_set: ["1"],
    });
    const n = consumeNonce(db, r.request_id)!;
    return recordDecision(db, {
      nonce: n, decision: "allow_ttl", approver_set: ["1"],
      granted_by_user_id: 1, ttl_ms,
      ...(max !== undefined ? { max_ttl_lifetime_ms: max } : {}),
    });
  }

  it("clamps an absurd wire ttl_ms to the max lifetime in the stored row", () => {
    const hundredYears = 100 * 365 * 24 * 60 * 60 * 1000;
    const dec = getDecision(db, recordTtl(hundredYears))!;
    expect(dec.ttl_expires_at).not.toBeNull();
    expect(dec.ttl_expires_at! - dec.granted_at).toBe(DEFAULT_MAX_TTL_LIFETIME_MS);
    // Without the write-time clamp this row would satisfy the broker's
    // mint gate (server.ts:2405) for a century — evaluateDecisionRow's
    // match-time cap never runs on that path.
    expect(
      isOperatorVerifiedDecision(
        { ...dec, origin: "operator", agent_unit: "u" },
        "u",
        dec.granted_at + DEFAULT_MAX_TTL_LIFETIME_MS + 1,
      ),
    ).toBe(false);
  });

  it("leaves a sane ttl_ms untouched", () => {
    const dec = getDecision(db, recordTtl(60_000))!;
    expect(dec.ttl_expires_at! - dec.granted_at).toBe(60_000);
  });

  it("honours an explicit max_ttl_lifetime_ms override", () => {
    const dec = getDecision(db, recordTtl(60_000, 5_000))!;
    expect(dec.ttl_expires_at! - dec.granted_at).toBe(5_000);
  });
});
