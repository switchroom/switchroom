/**
 * auth-broker protocol — encode/decode round-trip, oversize rejection,
 * version / verb / args validation.
 */

import { describe, expect, it } from "vitest";

import {
  decodeRequest,
  decodeResponse,
  encodeError,
  encodeRequest,
  encodeSuccess,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type Request,
} from "./protocol.js";

describe("protocol encode/decode", () => {
  it("round-trips every v1 verb", () => {
    const cases: Request[] = [
      { v: 1, id: "a", op: "get-credentials" },
      { v: 1, id: "b", op: "list-state" },
      { v: 1, id: "c", op: "set-active", account: "default" },
      { v: 1, id: "d", op: "mark-exhausted", until: 123 },
      { v: 1, id: "d2", op: "mark-exhausted" },
      { v: 1, id: "e", op: "refresh-account", account: "default" },
      {
        v: 1,
        id: "f",
        op: "add-account",
        label: "default",
        credentials: { claudeAiOauth: { accessToken: "at", refreshToken: "rt" } },
      },
      { v: 1, id: "g", op: "rm-account", label: "default" },
      { v: 1, id: "h", op: "set-override", agent: "ziggy", account: "default" },
      { v: 1, id: "h2", op: "set-override", agent: "ziggy", account: null },
    ];
    for (const c of cases) {
      const wire = encodeRequest(c);
      expect(wire.endsWith("\n")).toBe(true);
      const decoded = decodeRequest(wire);
      expect(decoded).toEqual(c);
    }
  });

  it("rejects requests with the wrong version", () => {
    const bad = JSON.stringify({ v: 99, id: "x", op: "list-state" });
    expect(() => decodeRequest(bad)).toThrow();
  });

  it("rejects unknown verbs", () => {
    const bad = JSON.stringify({ v: 1, id: "x", op: "wat" });
    expect(() => decodeRequest(bad)).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => decodeRequest("{not json")).toThrow(/not valid JSON/);
  });

  it("encodes / decodes success and error envelopes", () => {
    const ok = encodeSuccess("1", { foo: "bar" });
    const decodedOk = decodeResponse(ok);
    expect(decodedOk).toEqual({ v: PROTOCOL_VERSION, id: "1", ok: true, data: { foo: "bar" } });

    const err = encodeError("2", "FORBIDDEN", "no admin");
    const decodedErr = decodeResponse(err);
    expect(decodedErr).toEqual({
      v: PROTOCOL_VERSION,
      id: "2",
      ok: false,
      error: { code: "FORBIDDEN", message: "no admin" },
    });
  });

  it("rejects oversized request frames", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES);
    expect(() =>
      encodeRequest({ v: 1, id: huge, op: "list-state" }),
    ).toThrow(/MAX_FRAME_BYTES/);
  });
});
