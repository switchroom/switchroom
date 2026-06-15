/**
 * Pure unit tests for the Linear OAuth refresh core.
 * No network, no clock — fetch + nowSec injected.
 */
import { describe, it, expect } from "vitest";
import {
  refreshLinearAppToken,
  needsRefresh,
  parseBundle,
  serializeBundle,
  performLinearRefresh,
  LINEAR_TOKEN_ENDPOINT,
  type LinearOAuthBundle,
} from "../src/linear/oauth-refresh.js";

const BUNDLE: LinearOAuthBundle = {
  clientId: "cid",
  clientSecret: "csecret",
  refreshToken: "lin_refresh_old",
  expiresAt: 1000,
};

function fakeFetch(
  status: number,
  body: unknown,
  capture?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  }) as unknown as typeof fetch;
}

describe("refreshLinearAppToken", () => {
  it("POSTs the refresh grant form to Linear and returns the new token", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchImpl = fakeFetch(
      200,
      { access_token: "lin_new", refresh_token: "lin_refresh_new", expires_in: 86400, scope: "read write" },
      (url, init) => {
        seenUrl = url;
        seenBody = String(init.body);
      },
    );
    const r = await refreshLinearAppToken(BUNDLE, { fetchImpl, nowSec: () => 5000 });
    expect(seenUrl).toBe(LINEAR_TOKEN_ENDPOINT);
    expect(seenBody).toContain("grant_type=refresh_token");
    expect(seenBody).toContain("refresh_token=lin_refresh_old");
    expect(seenBody).toContain("client_id=cid");
    expect(seenBody).toContain("client_secret=csecret");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accessToken).toBe("lin_new");
      expect(r.refreshToken).toBe("lin_refresh_new"); // rotated
      expect(r.expiresAt).toBe(5000 + 86400);
      expect(r.scope).toBe("read write");
    }
  });

  it("keeps the OLD refresh token when Linear doesn't rotate it", async () => {
    const fetchImpl = fakeFetch(200, { access_token: "lin_new", expires_in: 3600 });
    const r = await refreshLinearAppToken(BUNDLE, { fetchImpl, nowSec: () => 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refreshToken).toBe("lin_refresh_old");
      expect(r.expiresAt).toBe(3600);
    }
  });

  it("classifies a dead refresh token (400 invalid_grant) as 'revoked'", async () => {
    const r = await refreshLinearAppToken(BUNDLE, {
      fetchImpl: fakeFetch(400, "invalid_grant: token revoked"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("revoked");
  });

  it("classifies a 500 as transient http_error (not revoked)", async () => {
    const r = await refreshLinearAppToken(BUNDLE, { fetchImpl: fakeFetch(503, "upstream down") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("http_error");
  });

  it("network failure → reason 'network'", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await refreshLinearAppToken(BUNDLE, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("network");
  });

  it("missing access_token → bad_response", async () => {
    const r = await refreshLinearAppToken(BUNDLE, { fetchImpl: fakeFetch(200, { expires_in: 3600 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_response");
  });
});

describe("needsRefresh", () => {
  it("true at/after expiry-minus-skew; false comfortably before; false on unknown expiry", () => {
    // expiresAt=1000, skew=100
    expect(needsRefresh(1000, 800, 100)).toBe(false); // 200s left > skew
    expect(needsRefresh(1000, 900, 100)).toBe(true); // exactly at skew boundary
    expect(needsRefresh(1000, 950, 100)).toBe(true); // inside skew
    expect(needsRefresh(1000, 2000, 100)).toBe(true); // already expired
    expect(needsRefresh(undefined, 999999, 100)).toBe(false); // unknown → don't churn
  });
});

describe("parseBundle / serializeBundle", () => {
  it("round-trips a complete bundle", () => {
    const s = serializeBundle(BUNDLE);
    const b = parseBundle(s);
    expect(b).toEqual(BUNDLE);
  });

  it("parses without expires_at", () => {
    const b = parseBundle(JSON.stringify({ client_id: "a", client_secret: "b", refresh_token: "c" }));
    expect(b).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c" });
  });

  it("returns null on absent / malformed / incomplete input", () => {
    expect(parseBundle(null)).toBeNull();
    expect(parseBundle("")).toBeNull();
    expect(parseBundle("not json")).toBeNull();
    expect(parseBundle(JSON.stringify({ client_id: "a", refresh_token: "c" }))).toBeNull(); // missing secret
    expect(parseBundle(JSON.stringify({ client_id: "", client_secret: "b", refresh_token: "c" }))).toBeNull(); // empty
  });
});

describe("performLinearRefresh (orchestration over injected I/O)", () => {
  it("reads bundle, refreshes, persists rotated bundle THEN token", async () => {
    const order: string[] = [];
    let writtenToken = "";
    let writtenBundle = "";
    const res = await performLinearRefresh({
      readBundle: async () => serializeBundle(BUNDLE),
      writeBundle: async (j) => { order.push("bundle"); writtenBundle = j; },
      writeToken: async (t) => { order.push("token"); writtenToken = t; },
      fetchImpl: fakeFetch(200, { access_token: "lin_new", refresh_token: "lin_refresh_new", expires_in: 86400 }),
      nowSec: () => 100,
    });
    expect(res).toEqual({ ok: true, accessToken: "lin_new", expiresAt: 100 + 86400 });
    // bundle persisted before token (rotation-safety)
    expect(order).toEqual(["bundle", "token"]);
    expect(writtenToken).toBe("lin_new");
    expect(parseBundle(writtenBundle)).toMatchObject({ refreshToken: "lin_refresh_new", expiresAt: 100 + 86400 });
  });

  it("no/invalid bundle → no_bundle, nothing written", async () => {
    let wrote = false;
    const res = await performLinearRefresh({
      readBundle: async () => null,
      writeToken: async () => { wrote = true; },
      writeBundle: async () => { wrote = true; },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_bundle");
    expect(wrote).toBe(false);
  });

  it("revoked refresh token surfaces and writes nothing", async () => {
    let wrote = false;
    const res = await performLinearRefresh({
      readBundle: async () => serializeBundle(BUNDLE),
      writeToken: async () => { wrote = true; },
      writeBundle: async () => { wrote = true; },
      fetchImpl: fakeFetch(400, "invalid_grant"),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("revoked");
    expect(wrote).toBe(false);
  });

  it("persist failure is reported as persist_failed", async () => {
    const res = await performLinearRefresh({
      readBundle: async () => serializeBundle(BUNDLE),
      writeBundle: async () => { throw new Error("broker denied"); },
      writeToken: async () => {},
      fetchImpl: fakeFetch(200, { access_token: "lin_new", expires_in: 3600 }),
      nowSec: () => 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.reason).toBe("persist_failed"); expect(res.detail).toContain("broker denied"); }
  });
});

describe("performLinearRefresh — rotation-safety on partial persist", () => {
  it("writeBundle succeeds but writeToken fails → persist_failed, BUT the rotated bundle WAS written (recovery possible)", async () => {
    let writtenBundle: string | null = null;
    const res = await performLinearRefresh({
      readBundle: async () => serializeBundle(BUNDLE),
      writeBundle: async (j) => { writtenBundle = j; }, // succeeds
      writeToken: async () => { throw new Error("token write failed"); }, // fails AFTER bundle
      fetchImpl: fakeFetch(200, { access_token: "lin_new", refresh_token: "lin_refresh_rotated", expires_in: 3600 }),
      nowSec: () => 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("persist_failed");
    // The doc's core claim: the rotated refresh token is persisted, so a
    // retry reads it and recovers — nothing stranded on the dead old one.
    expect(writtenBundle).not.toBeNull();
    expect(parseBundle(writtenBundle)).toMatchObject({ refreshToken: "lin_refresh_rotated" });
  });
});
