/**
 * Tests for the vault-broker wire protocol.
 *
 * Covers:
 *   - Encode/decode roundtrip for every request and response shape
 *   - Oversized frame (> 64 KiB) rejection
 *   - Malformed JSON rejection
 *   - Schema validation (wrong op, missing fields, extra fields tolerated by union)
 */

import { describe, expect, it } from "vitest";
import {
  AgentNameSchema,
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  errorResponse,
  entryResponse,
  MAX_FRAME_BYTES,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";

// ─── Request roundtrips ────────────────────────────────────────────────────

describe("encodeRequest / decodeRequest roundtrip", () => {
  const cases: BrokerRequest[] = [
    { v: 1, op: "get", key: "my_key" },
    { v: 1, op: "get", key: "my_key", filename: "config.json" },
    { v: 1, op: "list" },
    { v: 1, op: "status" },
    { v: 1, op: "lock" },
    // op:put — agent-driven key rotation. String + binary kinds only;
    // the schema deliberately excludes "files" since rotation of multi-
    // file entries is operator territory, not agent-self-service.
    { v: 1, op: "put", key: "microsoft/ken-tokens", entry: { kind: "string", value: "{\"access_token\":\"new\"}" } },
    { v: 1, op: "put", key: "ssh/id_rsa", entry: { kind: "binary", value: "aGVsbG8=" } },
  ];

  for (const req of cases) {
    it(`roundtrip: ${JSON.stringify(req)}`, () => {
      const frame = encodeRequest(req);
      expect(frame.endsWith("\n")).toBe(true);
      const line = frame.slice(0, -1);
      const decoded = decodeRequest(line);
      expect(decoded).toEqual(req);
    });
  }
});

// ─── Response roundtrips ───────────────────────────────────────────────────

describe("encodeResponse / decodeResponse roundtrip", () => {
  const stringEntry = { kind: "string" as const, value: "hello" };
  const binaryEntry = { kind: "binary" as const, value: "aGVsbG8=" };
  const filesEntry = {
    kind: "files" as const,
    files: { "key.pem": { encoding: "utf8" as const, value: "---" } },
  };

  const cases: BrokerResponse[] = [
    { ok: true, entry: stringEntry },
    { ok: true, entry: binaryEntry },
    { ok: true, entry: filesEntry },
    { ok: true, keys: ["foo", "bar"] },
    { ok: true, status: { unlocked: true, keyCount: 3, uptimeSec: 42 } },
    { ok: true, locked: true },
    { ok: true, put: true, key: "microsoft/ken-tokens" },
    { ok: false, code: "LOCKED", msg: "Vault is locked" },
    { ok: false, code: "DENIED", msg: "Not in ACL" },
    { ok: false, code: "UNKNOWN_KEY", msg: "Key not found: x" },
    { ok: false, code: "BAD_REQUEST", msg: "Malformed" },
    { ok: false, code: "INTERNAL", msg: "Internal error" },
  ];

  for (const resp of cases) {
    it(`roundtrip: ${JSON.stringify(resp).slice(0, 60)}`, () => {
      const frame = encodeResponse(resp);
      expect(frame.endsWith("\n")).toBe(true);
      const line = frame.slice(0, -1);
      const decoded = decodeResponse(line);
      expect(decoded).toEqual(resp);
    });
  }
});

// ─── Response union ordering (#4069) ───────────────────────────────────────
//
// ResponseSchema is a plain z.union: first match wins and zod objects strip
// unknown keys. OkApprovalConsumeResponse is a structural prefix of
// OkApprovalConsumeRecordResponse, so if Consume is ordered before
// ConsumeRecord, an approval_consume_record reply matches the Consume schema
// and `decision_id` is silently stripped — the gateway then false-toasts
// "kernel record failed" on every approval tap. These tests go through the
// REAL decodeResponse (the kernel tests use raw JSON.parse and missed this).

describe("response union ordering: approval_consume_record vs approval_consume (#4069)", () => {
  it("preserves decision_id on a consume_record reply", () => {
    const wire = JSON.stringify({
      ok: true,
      consumed: true,
      decision_id: "dec-123",
      agent_unit: "clerk",
      scope: "ms365:calendar:write",
      action: "update-calendar-event",
      why: null,
    });
    const decoded = decodeResponse(wire) as Record<string, unknown>;
    expect(decoded.ok).toBe(true);
    expect(decoded.consumed).toBe(true);
    // The load-bearing assertion: decision_id must survive the union.
    expect(decoded.decision_id).toBe("dec-123");
    expect(decoded.scope).toBe("ms365:calendar:write");
  });

  it("still decodes a plain consume reply (no decision_id) losslessly", () => {
    const resp = {
      ok: true,
      consumed: true,
      agent_unit: "clerk",
      scope: "drive:file:read",
      action: "read",
      why: "user asked",
    };
    const decoded = decodeResponse(JSON.stringify(resp));
    expect(decoded).toEqual(resp);
  });

  it("still decodes a consumed:false reply (burned/expired nonce)", () => {
    const decoded = decodeResponse(JSON.stringify({ ok: true, consumed: false }));
    expect(decoded).toEqual({ ok: true, consumed: false });
  });

  it("still routes a plain approval_record reply to its own schema", () => {
    // {ok, decision_id} lacks `consumed`, so it must NOT be swallowed
    // (or rejected) by the ConsumeRecord schema ordered ahead of it.
    const resp = { ok: true, decision_id: "dec-456" };
    const decoded = decodeResponse(JSON.stringify(resp));
    expect(decoded).toEqual(resp);
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

describe("errorResponse helper", () => {
  it("builds a typed error response", () => {
    const r = errorResponse("DENIED", "not allowed");
    expect(r).toEqual({ ok: false, code: "DENIED", msg: "not allowed" });
  });
});

describe("entryResponse helper", () => {
  it("builds a typed entry response for string kind", () => {
    const entry = { kind: "string" as const, value: "secret" };
    const r = entryResponse(entry);
    expect(r).toEqual({ ok: true, entry });
  });
});

// ─── Oversized frames ─────────────────────────────────────────────────────

describe("oversized frame rejection", () => {
  it("encodeRequest throws when serialized frame exceeds MAX_FRAME_BYTES", () => {
    const bigKey = "k".repeat(MAX_FRAME_BYTES);
    expect(() => encodeRequest({ v: 1, op: "get", key: bigKey })).toThrow(
      /too large/i,
    );
  });

  it("decodeRequest throws RangeError when line exceeds MAX_FRAME_BYTES", () => {
    const bigLine = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => decodeRequest(bigLine)).toThrow(RangeError);
  });

  it("encodeResponse throws when serialized frame exceeds MAX_FRAME_BYTES", () => {
    const bigValue = "v".repeat(MAX_FRAME_BYTES);
    expect(() =>
      encodeResponse({ ok: true, entry: { kind: "string", value: bigValue } }),
    ).toThrow(/too large/i);
  });

  it("decodeResponse throws RangeError when line exceeds MAX_FRAME_BYTES", () => {
    const bigLine = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => decodeResponse(bigLine)).toThrow(RangeError);
  });
});

// ─── Malformed JSON ────────────────────────────────────────────────────────

describe("malformed JSON rejection", () => {
  it("decodeRequest throws SyntaxError on bad JSON", () => {
    expect(() => decodeRequest("{not valid json")).toThrow(SyntaxError);
  });

  it("decodeResponse throws SyntaxError on bad JSON", () => {
    expect(() => decodeResponse("{not valid json")).toThrow(SyntaxError);
  });

  it("decodeRequest throws ZodError on structurally invalid request", () => {
    // Valid JSON but wrong schema (missing op)
    expect(() => decodeRequest(JSON.stringify({ v: 1 }))).toThrow();
  });

  it("decodeRequest throws ZodError on unknown op", () => {
    expect(() =>
      decodeRequest(JSON.stringify({ v: 1, op: "unlock" })),
    ).toThrow();
  });
});

// ─── Agent-name validation (#1448) ─────────────────────────────────────────
//
// Pre-fix the broker accepted any non-empty `agent` string on mint_grant
// (and friends) and joined it directly into a filesystem path
// (`~/.switchroom/agents/<agent>/.vault-token`). A peer with broker-IPC
// access could escape the agents tree with `agent: "../foo"`. The
// validation now happens at the schema layer so the bad request is
// rejected before any filesystem call is reached.

describe("agent-name validation on broker requests (#1448)", () => {
  // Minimum-viable mint_grant body — the test mutates only `agent`.
  function mintGrantBody(agent: unknown) {
    return JSON.stringify({
      v: 1,
      op: "mint_grant",
      agent,
      keys: ["some_key"],
      ttl_seconds: 60,
      passphrase: "doesn't-matter-rejected-before-broker-runs",
    });
  }

  it("accepts a kebab-case agent slug (regression)", () => {
    // Common-case agent names must continue to validate cleanly.
    for (const ok of ["klanker", "gymbro", "lawgpt", "carrie", "finn", "a1", "z9", "agent-1", "a_b_c"]) {
      expect(() => decodeRequest(mintGrantBody(ok))).not.toThrow();
    }
  });

  it("rejects path-traversal agent names", () => {
    expect(() => decodeRequest(mintGrantBody("../escape"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("foo/../bar"))).toThrow();
    expect(() => decodeRequest(mintGrantBody(".."))).toThrow();
  });

  it("rejects absolute-path agent names", () => {
    expect(() => decodeRequest(mintGrantBody("/etc/passwd"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("/abs"))).toThrow();
  });

  it("rejects names with separators or shell metacharacters", () => {
    expect(() => decodeRequest(mintGrantBody("foo/bar"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("foo bar"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("foo;bar"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("foo\nbar"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("foo\\bar"))).toThrow();
  });

  it("rejects names starting with non-alnum (dot, hyphen, underscore)", () => {
    // Leading `-` or `_` would collide with CLI flag parsing in audit
    // contexts; leading `.` is the dotfile escape.
    expect(() => decodeRequest(mintGrantBody(".hidden"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("-flag"))).toThrow();
    expect(() => decodeRequest(mintGrantBody("_under"))).toThrow();
  });

  it("rejects reserved identity names (operator)", () => {
    // `operator` resolves to the operator identity in peercred; allowing
    // it as an agent slug lets a malicious peer mis-route mint_grant.
    expect(() => decodeRequest(mintGrantBody("operator"))).toThrow();
  });

  it("rejects empty and overlong names", () => {
    expect(() => decodeRequest(mintGrantBody(""))).toThrow();
    expect(() => decodeRequest(mintGrantBody("a".repeat(65)))).toThrow();
    // Exactly 64 is at the boundary and should pass.
    expect(() => decodeRequest(mintGrantBody("a".repeat(64)))).not.toThrow();
  });

  it("applies the same validation to list_grants (when agent is set)", () => {
    const body = JSON.stringify({
      v: 1,
      op: "list_grants",
      agent: "../escape",
    });
    expect(() => decodeRequest(body)).toThrow();
  });

  it("list_grants accepts omitted agent (back-compat)", () => {
    const body = JSON.stringify({ v: 1, op: "list_grants" });
    expect(() => decodeRequest(body)).not.toThrow();
  });

  it("applies the same validation to preflight_access", () => {
    const body = JSON.stringify({
      v: 1,
      op: "preflight_access",
      agent: "foo/../bar",
      keys: ["k"],
    });
    expect(() => decodeRequest(body)).toThrow();
  });
});

// ─── AgentNameSchema direct use (#1448 follow-up) ──────────────────────────
//
// The schema is also used on the READ path in the revoke_grant handler
// (defense-in-depth against pre-fix stored grants whose agent_slug
// predates wire validation). Tests below pin the safeParse semantics
// the handler relies on.

describe("AgentNameSchema safeParse (read-path use)", () => {
  it("returns success for canonical fleet agent names", () => {
    for (const ok of ["klanker", "gymbro", "ziggy", "lawgpt", "carrie", "finn", "reggie", "clerk"]) {
      expect(AgentNameSchema.safeParse(ok).success).toBe(true);
    }
  });

  it("returns failure for path-traversal slugs (pre-fix DB rows)", () => {
    expect(AgentNameSchema.safeParse("../escape").success).toBe(false);
    expect(AgentNameSchema.safeParse("foo/../bar").success).toBe(false);
    expect(AgentNameSchema.safeParse("/abs").success).toBe(false);
    expect(AgentNameSchema.safeParse("").success).toBe(false);
  });

  it("returns failure for reserved identity names", () => {
    expect(AgentNameSchema.safeParse("operator").success).toBe(false);
    expect(AgentNameSchema.safeParse("hostd").success).toBe(false);
  });
});
