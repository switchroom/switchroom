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
      { v: 1, id: "d3", op: "mark-throttled", until: 456 },
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

  it("rejects mark-throttled without an until (required, unlike mark-exhausted)", () => {
    const bad = JSON.stringify({ v: 1, id: "x", op: "mark-throttled" });
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

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 3b.1 — provider field on per-account verbs
// ────────────────────────────────────────────────────────────────────────

describe("provider: field (RFC G Phase 3b.1) — back-compat + new providers", () => {
  it("set-active accepts requests WITHOUT provider field (back-compat with RFC H clients)", () => {
    const line = encodeRequest({ v: 1, id: "x", op: "set-active", account: "default" });
    const back = decodeRequest(line);
    expect(back.op).toBe("set-active");
    if (back.op === "set-active") {
      expect(back.provider).toBeUndefined();
    }
  });

  it("set-active accepts provider: 'anthropic' (explicit default)", () => {
    const back = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "set-active", account: "default", provider: "anthropic",
    }));
    expect(back.op).toBe("set-active");
    if (back.op === "set-active") {
      expect(back.provider).toBe("anthropic");
    }
  });

  it("set-active accepts provider: 'google' on the wire (server may reject)", () => {
    const back = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "set-active", account: "alice@example.com", provider: "google",
    }));
    if (back.op === "set-active") {
      expect(back.provider).toBe("google");
    }
  });

  it("rejects unknown provider names", () => {
    const bad = JSON.stringify({
      v: 1, id: "x", op: "set-active", account: "x", provider: "openai",
    });
    expect(() => decodeRequest(bad)).toThrow();
  });

  it("refresh-account carries provider field with same back-compat semantics", () => {
    const noProvider = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "refresh-account", account: "default",
    }));
    if (noProvider.op === "refresh-account") {
      expect(noProvider.provider).toBeUndefined();
    }
    const google = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "refresh-account", account: "alice@example.com", provider: "google",
    }));
    if (google.op === "refresh-account") {
      expect(google.provider).toBe("google");
    }
  });

  it("rm-account carries provider field with same back-compat semantics", () => {
    const noProvider = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "rm-account", label: "default",
    }));
    if (noProvider.op === "rm-account") {
      expect(noProvider.provider).toBeUndefined();
    }
    const google = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "rm-account", label: "alice@example.com", provider: "google",
    }));
    if (google.op === "rm-account") {
      expect(google.provider).toBe("google");
    }
  });
});

describe("add-account credentials union (RFC G Phase 3b.1)", () => {
  const anthropicCreds = {
    claudeAiOauth: {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1234,
    },
  };

  const googleCreds = {
    googleOauth: {
      accessToken: "at-google",
      refreshToken: "rt-google",
      expiresAt: 5678,
      scope: "https://www.googleapis.com/auth/drive",
      clientId: "client-id-x",
      accountEmail: "alice@example.com",
      tokenType: "Bearer" as const,
    },
  };

  it("accepts Anthropic-shaped credentials with no provider field (back-compat)", () => {
    const back = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "add-account", label: "default",
      credentials: anthropicCreds,
    }));
    expect(back.op).toBe("add-account");
    if (back.op === "add-account") {
      expect(back.provider).toBeUndefined();
      expect("claudeAiOauth" in back.credentials).toBe(true);
    }
  });

  it("accepts Anthropic-shaped credentials with provider: 'anthropic'", () => {
    const back = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "add-account", label: "default",
      provider: "anthropic", credentials: anthropicCreds,
    }));
    if (back.op === "add-account") {
      expect(back.provider).toBe("anthropic");
    }
  });

  it("accepts Google-shaped credentials with provider: 'google'", () => {
    const back = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "add-account", label: "alice@example.com",
      provider: "google", credentials: googleCreds,
    }));
    if (back.op === "add-account") {
      expect(back.provider).toBe("google");
      expect("googleOauth" in back.credentials).toBe(true);
    }
  });

  it("rejects malformed credentials (neither claudeAiOauth nor googleOauth)", () => {
    const bad = JSON.stringify({
      v: 1, id: "x", op: "add-account", label: "x",
      credentials: { wrongShape: {} },
    });
    expect(() => decodeRequest(bad)).toThrow();
  });

  it("rejects Google credentials missing required fields", () => {
    const bad = JSON.stringify({
      v: 1, id: "x", op: "add-account", label: "x", provider: "google",
      credentials: { googleOauth: { accessToken: "at" } }, // missing refreshToken, etc
    });
    expect(() => decodeRequest(bad)).toThrow();
  });

  it("the schema is a union — server is responsible for cross-checking provider matches credentials shape", () => {
    // Protocol layer accepts (Anthropic creds + provider:google) since
    // both are valid sub-shapes — the server enforces the cross-check
    // and rejects with INVALID_ARGS. This pins that the schema layer
    // doesn't pre-empt the server's check.
    const back = decodeRequest(encodeRequest({
      v: 1, id: "x", op: "add-account", label: "x", provider: "google",
      credentials: anthropicCreds, // mismatch
    }));
    expect(back.op).toBe("add-account");
    // Decoded successfully; server-side check fires on receive.
  });
});

describe("DEFAULT_PROVIDER constant + ProviderNameSchema enum", () => {
  it("DEFAULT_PROVIDER is 'anthropic' (RFC H back-compat)", async () => {
    const { DEFAULT_PROVIDER } = await import("./protocol.js");
    expect(DEFAULT_PROVIDER).toBe("anthropic");
  });

  it("ProviderNameSchema accepts the v1 provider enum", async () => {
    const { ProviderNameSchema } = await import("./protocol.js");
    expect(ProviderNameSchema.parse("anthropic")).toBe("anthropic");
    expect(ProviderNameSchema.parse("google")).toBe("google");
    expect(() => ProviderNameSchema.parse("unknown")).toThrow();
  });
});
