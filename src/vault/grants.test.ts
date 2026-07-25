/**
 * Tests for the vault grants module (grants.ts).
 *
 * Uses an in-memory SQLite database for isolation — no disk I/O.
 *
 * Covers:
 *   - mintGrant round-trip: token returned, validateGrant accepts it
 *   - validateGrant rejects expired grants
 *   - validateGrant rejects revoked grants
 *   - validateGrant rejects wrong key (not in key_allow)
 *   - validateGrant rejects malformed/unknown token
 *   - revokeGrant soft-deletes and returns correct boolean
 *   - listGrants filters by agent_slug and excludes revoked
 *   - migrateGrantsSchema is idempotent (safe to run twice)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  migrateGrantsSchema,
  mintGrant,
  validateGrant,
  revokeGrant,
  listGrants,
  __clearGrantCompareMemo,
} from "./grants.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

describe("migrateGrantsSchema", () => {
  it("is idempotent — running twice does not throw", () => {
    const db = new Database(":memory:");
    expect(() => {
      migrateGrantsSchema(db);
      migrateGrantsSchema(db);
    }).not.toThrow();
  });

  it("creates the vault_grants table with expected columns", () => {
    const db = new Database(":memory:");
    migrateGrantsSchema(db);
    // PRAGMA table_info returns one row per column
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(vault_grants)")
      .all()
      .map((r) => r.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "secret_hash",
        "agent_slug",
        "key_allow",
        "expires_at",
        "revoked_at",
        "created_at",
        "description",
      ]),
    );
  });
});

describe("mintGrant", () => {
  it("returns a token, id, and expires_at", async () => {
    const db = makeDb();
    const result = await mintGrant(db, "myagent", ["MY_SECRET"], 3600);
    expect(result.token).toMatch(/^vg_[0-9a-f]{6}\.[0-9a-f]{32}$/);
    expect(result.id).toMatch(/^vg_[0-9a-f]{6}$/);
    expect(result.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("stores a row with bcrypt-hashed secret (not plaintext)", async () => {
    const db = makeDb();
    const result = await mintGrant(db, "myagent", ["KEY"], 3600);
    const row = db
      .query<{ secret_hash: string }, [string]>(
        "SELECT secret_hash FROM vault_grants WHERE id = ?",
      )
      .get(result.id);
    expect(row).not.toBeNull();
    // Hash must start with $2 (bcrypt prefix) — NOT the raw secret
    expect(row!.secret_hash).toMatch(/^\$2[aby]\$/);
    // Raw secret is NOT in the hash field
    const secret = result.token.split(".")[1];
    expect(row!.secret_hash).not.toBe(secret);
  });

  it("stores null expires_at when ttl_seconds is null", async () => {
    const db = makeDb();
    const result = await mintGrant(db, "myagent", ["KEY"], null);
    expect(result.expires_at).toBeNull();
    const row = db
      .query<{ expires_at: number | null }, [string]>(
        "SELECT expires_at FROM vault_grants WHERE id = ?",
      )
      .get(result.id);
    expect(row!.expires_at).toBeNull();
  });

  it("stores description when provided", async () => {
    const db = makeDb();
    const result = await mintGrant(db, "myagent", ["KEY"], 3600, "my note");
    const row = db
      .query<{ description: string }, [string]>(
        "SELECT description FROM vault_grants WHERE id = ?",
      )
      .get(result.id);
    expect(row!.description).toBe("my note");
  });
});

describe("validateGrant", () => {
  it("accepts a valid token for an allowed key", async () => {
    const db = makeDb();
    const { token } = await mintGrant(db, "myagent", ["MY_KEY", "OTHER"], 3600);
    const result = await validateGrant(db, token, "MY_KEY");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.agent_slug).toBe("myagent");
      expect(result.grant.key_allow).toContain("MY_KEY");
    }
  });

  it("rejects an expired grant", async () => {
    const db = makeDb();
    const { id } = await mintGrant(db, "myagent", ["KEY"], 1);
    // Back-date expires_at to the past
    db.run("UPDATE vault_grants SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 10,
      id,
    ]);
    const token = db
      .query<{ id: string; secret_hash: string }, [string]>(
        "SELECT id, secret_hash FROM vault_grants WHERE id = ?",
      )
      .get(id);
    // Re-mint fresh so we have the real token string to validate
    const db2 = makeDb();
    const { token: freshToken } = await mintGrant(db2, "myagent", ["KEY"], 1);
    // Back-date in db2
    const freshId = freshToken.split(".")[0];
    db2.run("UPDATE vault_grants SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 10,
      freshId,
    ]);
    const result = await validateGrant(db2, freshToken, "KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-expired");
  });

  it("rejects a revoked grant", async () => {
    const db = makeDb();
    const { token, id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    revokeGrant(db, id);
    const result = await validateGrant(db, token, "KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-revoked");
  });

  it("rejects a key not in key_allow", async () => {
    const db = makeDb();
    const { token } = await mintGrant(db, "myagent", ["ALLOWED_KEY"], 3600);
    const result = await validateGrant(db, token, "OTHER_KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-key-not-allowed");
  });

  it("rejects a malformed token (no dot)", async () => {
    const db = makeDb();
    const result = await validateGrant(db, "nodot", "KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-invalid");
  });

  it("rejects a token with unknown ID", async () => {
    const db = makeDb();
    const result = await validateGrant(db, "vg_000000.abcdef1234567890abcdef1234567890", "KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-invalid");
  });

  it("rejects a token with wrong secret half", async () => {
    const db = makeDb();
    const { id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    const badToken = `${id}.ffffffffffffffffffffffffffffffff`;
    const result = await validateGrant(db, badToken, "KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-invalid");
  });
});

describe("validateGrant bcrypt-compare memo (#3574)", () => {
  beforeEach(() => {
    __clearGrantCompareMemo();
  });

  it("collapses repeat validation cost to well under one bcrypt compare", async () => {
    // WHY THIS EXISTS: the broker calls validateGrant once per `get`
    // (server.ts:1284) and once per `list` (:1105), and bcryptjs is pure JS
    // that BLOCKS the broker's single shared event loop. Measured on the
    // fleet host: ~57ms per compare, and 8 "concurrent" compares took 459ms
    // (fully serialized). N-key hooks like secret-guard-pretool.mjs
    // therefore cost the broker (N+1) compares of serialized CPU, which no
    // client-side concurrency can shorten — and when that blows a client's
    // deadline the hook scans a PARTIAL key set, silently unguarding
    // secrets. Hence the memo.
    //
    // Self-baselining: measure ONE cold compare in-test rather than
    // hardcoding a millisecond figure, so the assertion holds on any CPU.
    const db = makeDb();
    const { token } = await mintGrant(db, "myagent", ["KEY"], 3600);

    const coldStart = performance.now();
    expect((await validateGrant(db, token, "KEY")).ok).toBe(true);
    const coldMs = performance.now() - coldStart;

    const REPEATS = 20;
    const warmStart = performance.now();
    for (let i = 0; i < REPEATS; i++) {
      expect((await validateGrant(db, token, "KEY")).ok).toBe(true);
    }
    const warmMs = performance.now() - warmStart;

    // 20 memoized validations must cost less than a SINGLE cold compare.
    // Un-memoized that loop is 20 × coldMs, so the margin is ~20×.
    expect(warmMs).toBeLessThan(coldMs);
  });

  it("still honours revocation immediately after a memoized success", async () => {
    // THE security property. The memo covers only the immutable
    // "secret hashes to this digest" fact; revoked_at is re-read from
    // SQLite on every call, so a kill-switch must take effect on the very
    // next request — no TTL wait.
    const db = makeDb();
    const { token, id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    expect((await validateGrant(db, token, "KEY")).ok).toBe(true); // memoize

    revokeGrant(db, id);

    const after = await validateGrant(db, token, "KEY");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("grant-revoked");
  });

  it("still honours expiry after a memoized success", async () => {
    const db = makeDb();
    const { token, id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    expect((await validateGrant(db, token, "KEY")).ok).toBe(true); // memoize

    db.run("UPDATE vault_grants SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 10,
      id,
    ]);

    const after = await validateGrant(db, token, "KEY");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("grant-expired");
  });

  it("still honours key_allow after a memoized success", async () => {
    const db = makeDb();
    const { token } = await mintGrant(db, "myagent", ["ALLOWED_KEY"], 3600);
    expect((await validateGrant(db, token, "ALLOWED_KEY")).ok).toBe(true); // memoize

    // Same token, different key — the memo is keyed on the secret, NOT on
    // the requested key, so scope must still be evaluated per call.
    const other = await validateGrant(db, token, "OTHER_KEY");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe("grant-key-not-allowed");
  });

  it("does not accept a wrong secret for a grant whose real secret is memoized", async () => {
    // A cache that keyed on grant id alone would turn one successful
    // validation into a bypass for every other secret. The memo key
    // includes sha256(secret), so it cannot.
    const db = makeDb();
    const { token, id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    expect((await validateGrant(db, token, "KEY")).ok).toBe(true); // memoize

    const forged = `${id}.ffffffffffffffffffffffffffffffff`;
    const result = await validateGrant(db, forged, "KEY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("grant-invalid");
  });

  it("does not accept the old secret after the stored hash is rotated", async () => {
    // The memo key includes secret_hash, so rotating the row's hash
    // invalidates the entry structurally — no TTL wait, no explicit flush.
    const db = makeDb();
    const { token, id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    expect((await validateGrant(db, token, "KEY")).ok).toBe(true); // memoize

    const { id: otherId } = await mintGrant(db, "myagent", ["KEY"], 3600);
    const otherHash = db
      .query<{ secret_hash: string }, [string]>(
        "SELECT secret_hash FROM vault_grants WHERE id = ?",
      )
      .get(otherId)!.secret_hash;
    db.run("UPDATE vault_grants SET secret_hash = ? WHERE id = ?", [otherHash, id]);

    const after = await validateGrant(db, token, "KEY");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("grant-invalid");
  });
});

describe("revokeGrant", () => {
  it("returns true for existing active grant", async () => {
    const db = makeDb();
    const { id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    expect(revokeGrant(db, id)).toBe(true);
  });

  it("returns false for already-revoked grant", async () => {
    const db = makeDb();
    const { id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    revokeGrant(db, id);
    expect(revokeGrant(db, id)).toBe(false);
  });

  it("returns false for unknown ID", () => {
    const db = makeDb();
    expect(revokeGrant(db, "vg_000000")).toBe(false);
  });

  it("sets revoked_at to current unix time", async () => {
    const db = makeDb();
    const before = Math.floor(Date.now() / 1000);
    const { id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    revokeGrant(db, id);
    const after = Math.floor(Date.now() / 1000);
    const row = db
      .query<{ revoked_at: number }, [string]>(
        "SELECT revoked_at FROM vault_grants WHERE id = ?",
      )
      .get(id);
    expect(row!.revoked_at).toBeGreaterThanOrEqual(before);
    expect(row!.revoked_at).toBeLessThanOrEqual(after + 1);
  });
});

describe("listGrants", () => {
  it("returns all active grants when no filter", async () => {
    const db = makeDb();
    await mintGrant(db, "agent-a", ["K1"], 3600);
    await mintGrant(db, "agent-b", ["K2"], 3600);
    const grants = listGrants(db);
    expect(grants.length).toBe(2);
  });

  it("filters by agent_slug", async () => {
    const db = makeDb();
    await mintGrant(db, "agent-a", ["K1"], 3600);
    await mintGrant(db, "agent-b", ["K2"], 3600);
    const grants = listGrants(db, "agent-a");
    expect(grants.length).toBe(1);
    expect(grants[0].agent_slug).toBe("agent-a");
  });

  it("excludes revoked grants", async () => {
    const db = makeDb();
    const { id } = await mintGrant(db, "myagent", ["KEY"], 3600);
    await mintGrant(db, "myagent", ["KEY2"], 3600);
    revokeGrant(db, id);
    const grants = listGrants(db);
    expect(grants.length).toBe(1);
    expect(grants.every((g) => g.revoked_at === null)).toBe(true);
  });

  it("does not include secret_hash in returned rows", async () => {
    const db = makeDb();
    await mintGrant(db, "myagent", ["KEY"], 3600);
    const grants = listGrants(db);
    for (const g of grants) {
      expect(Object.keys(g)).not.toContain("secret_hash");
    }
  });

  it("parses key_allow as an array", async () => {
    const db = makeDb();
    await mintGrant(db, "myagent", ["A", "B", "C"], 3600);
    const [grant] = listGrants(db);
    expect(grant.key_allow).toEqual(["A", "B", "C"]);
  });
});
