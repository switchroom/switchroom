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
