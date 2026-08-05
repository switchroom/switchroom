/**
 * Entitlement-403 probe hardening (PR2 of the two-PR change).
 *
 * A `fetchQuota` probe that gets a 403 whose body says the org/subscription has
 * DISABLED Claude Code access must return a STRUCTURED failure carrying
 * `httpStatus`, `apiErrorMessage`, and `failureKind:"entitlement_blocked"` — so
 * the broker can persist a real DISABLED signal instead of folding it into a
 * plain string and serving the stale cache. A bad-token-scope 403 (a different
 * body) must NOT be classified `entitlement_blocked`.
 *
 * `fetchImpl` is injected (the pattern from quota-model-tier.test.ts) so no
 * network is touched.
 */

import { describe, expect, it } from "vitest";
import {
  extractApiErrorCode,
  extractApiErrorMessage,
  fetchQuota,
  isEntitlementBlockedErrorCode,
  isEntitlementDisabledMessage,
} from "./quota.js";

/** Build a stub fetch returning a given status + JSON body, no rate headers. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** The observed entitlement-403 body: org disabled Claude Code access. */
const ENTITLEMENT_BODY = {
  type: "error",
  error: {
    type: "permission_error",
    message:
      "Your organization has disabled Claude subscription access for Claude Code",
  },
};

/** A bad-token-scope 403 body — 403, but NOT an entitlement disablement. */
const BAD_SCOPE_BODY = {
  type: "error",
  error: {
    type: "authentication_error",
    message:
      "This credential is only authorized for use with Claude Code and cannot be used for other API requests.",
  },
};

/**
 * The observed DEACTIVATED / OAuth-disabled-org 403 body (verbatim signature).
 * Its message carries neither "disabled" nor "claude code", so the prose
 * matcher misses it — the structured `error.details.error_code` is the only
 * reliable signal. This is the exact gap the fix closes.
 */
const OAUTH_DISABLED_ORG_BODY = {
  type: "error",
  error: {
    type: "permission_error",
    message: "OAuth authentication is currently not allowed for this organization.",
    details: { error_code: "oauth_not_allowed_for_organization" },
  },
  request_id: "req_abc123",
};

/** A generic 403 carrying an UNRELATED structured error_code (over-block guard). */
const UNRELATED_CODE_403_BODY = {
  type: "error",
  error: {
    type: "permission_error",
    message: "Some other permission problem.",
    details: { error_code: "some_unrelated_permission_error" },
  },
};

describe("fetchQuota — structured entitlement-403 classification", () => {
  it("a 403 with a Code-disabled body → structured entitlement_blocked failure", async () => {
    const res = await fetchQuota({
      accessToken: "tok",
      fetchImpl: stubFetch(403, ENTITLEMENT_BODY),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureKind).toBe("entitlement_blocked");
    expect(res.httpStatus).toBe(403);
    expect(res.apiErrorMessage).toBe(
      "Your organization has disabled Claude subscription access for Claude Code",
    );
    // The legacy log string is still present for observability.
    expect(res.reason).toContain("HTTP 403");
  });

  it("a deactivated-org 403 (oauth_not_allowed_for_organization) → entitlement_blocked via the structured error_code", async () => {
    // This body's message has no "disabled"/"claude code" — the prose matcher
    // misses it. Classification MUST come from error.details.error_code.
    const res = await fetchQuota({
      accessToken: "tok",
      fetchImpl: stubFetch(403, OAUTH_DISABLED_ORG_BODY),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureKind).toBe("entitlement_blocked");
    expect(res.httpStatus).toBe(403);
    expect(res.apiErrorMessage).toBe(
      "OAuth authentication is currently not allowed for this organization.",
    );
    // Sanity: the prose matcher genuinely does NOT catch this message, so the
    // pass is proving the CODE path, not accidentally the fallback path.
    expect(isEntitlementDisabledMessage(res.apiErrorMessage)).toBe(false);
  });

  it("a generic 403 with an UNRELATED error_code stays 'other' (over-block guard)", async () => {
    const res = await fetchQuota({
      accessToken: "tok",
      fetchImpl: stubFetch(403, UNRELATED_CODE_403_BODY),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureKind).toBe("other");
    expect(res.httpStatus).toBe(403);
  });

  it("a bad-token-scope 403 is NOT entitlement_blocked (failureKind 'other')", async () => {
    const res = await fetchQuota({
      accessToken: "tok",
      fetchImpl: stubFetch(403, BAD_SCOPE_BODY),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureKind).toBe("other");
    expect(res.httpStatus).toBe(403);
    expect(res.apiErrorMessage).toContain("only authorized for use with Claude Code");
  });

  it("a non-403 failure (500) is 'other' with httpStatus, never entitlement_blocked", async () => {
    const res = await fetchQuota({
      accessToken: "tok",
      fetchImpl: stubFetch(500, { type: "error", error: { message: "overloaded" } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureKind).toBe("other");
    expect(res.httpStatus).toBe(500);
  });

  it("a 403 with a disabled message but non-JSON body still classifies via raw text", async () => {
    const res = await fetchQuota({
      accessToken: "tok",
      fetchImpl: stubFetch(
        403,
        "Your organization has disabled Claude subscription access for Claude Code",
      ),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureKind).toBe("entitlement_blocked");
    expect(res.httpStatus).toBe(403);
  });
});

describe("isEntitlementDisabledMessage", () => {
  it("matches the org-disabled Claude Code message", () => {
    expect(
      isEntitlementDisabledMessage(
        "Your organization has disabled Claude subscription access for Claude Code",
      ),
    ).toBe(true);
  });

  it("does not match a scope error (no 'disabled')", () => {
    expect(
      isEntitlementDisabledMessage(
        "This credential is only authorized for use with Claude Code and cannot be used for other API requests.",
      ),
    ).toBe(false);
  });

  it("does not match an unrelated disabled message lacking a Code/org reference", () => {
    expect(isEntitlementDisabledMessage("This feature is disabled")).toBe(false);
  });

  it("null / empty → false", () => {
    expect(isEntitlementDisabledMessage(null)).toBe(false);
    expect(isEntitlementDisabledMessage("")).toBe(false);
  });
});

describe("extractApiErrorMessage", () => {
  it("pulls error.message from a JSON error body", () => {
    expect(extractApiErrorMessage(JSON.stringify(ENTITLEMENT_BODY))).toBe(
      "Your organization has disabled Claude subscription access for Claude Code",
    );
  });

  it("falls back to raw (truncated) text for a non-JSON body", () => {
    expect(extractApiErrorMessage("plain text error")).toBe("plain text error");
  });

  it("empty body → null", () => {
    expect(extractApiErrorMessage("")).toBeNull();
  });
});

describe("extractApiErrorCode", () => {
  it("pulls error.details.error_code from a deactivated-org body", () => {
    expect(extractApiErrorCode(JSON.stringify(OAUTH_DISABLED_ORG_BODY))).toBe(
      "oauth_not_allowed_for_organization",
    );
  });

  it("returns null when there is no details.error_code", () => {
    expect(extractApiErrorCode(JSON.stringify(ENTITLEMENT_BODY))).toBeNull();
  });

  it("null for non-JSON and empty bodies", () => {
    expect(extractApiErrorCode("plain text error")).toBeNull();
    expect(extractApiErrorCode("")).toBeNull();
  });
});

describe("isEntitlementBlockedErrorCode", () => {
  it("matches the deactivated-org code", () => {
    expect(isEntitlementBlockedErrorCode("oauth_not_allowed_for_organization")).toBe(true);
  });

  it("does not match an unrelated code, null, or empty", () => {
    expect(isEntitlementBlockedErrorCode("some_unrelated_permission_error")).toBe(false);
    expect(isEntitlementBlockedErrorCode(null)).toBe(false);
    expect(isEntitlementBlockedErrorCode(undefined)).toBe(false);
    expect(isEntitlementBlockedErrorCode("")).toBe(false);
  });
});
