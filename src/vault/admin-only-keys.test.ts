import { describe, it, expect } from "vitest";
import {
  matchesAdminOnlyKey,
  filterAdminOnlyKeys,
  adminOnlyKeysBeingAdded,
} from "./admin-only-keys.js";

describe("matchesAdminOnlyKey", () => {
  it("matches exact key names", () => {
    expect(matchesAdminOnlyKey("microsoft/ken-tokens", ["microsoft/ken-tokens"])).toBe(true);
    expect(matchesAdminOnlyKey("microsoft/ken-tokens", ["microsoft/other"])).toBe(false);
  });

  it("matches `prefix/*` globs including the slash segment", () => {
    expect(matchesAdminOnlyKey("stripe/secret-key", ["stripe/*"])).toBe(true);
    expect(matchesAdminOnlyKey("stripe/webhook/signing", ["stripe/*"])).toBe(true);
    expect(matchesAdminOnlyKey("stripey/secret", ["stripe/*"])).toBe(false);
  });

  it("matches `*/suffix` and bare `*` globs", () => {
    expect(matchesAdminOnlyKey("marko/oauth-token", ["*/oauth-token"])).toBe(true);
    expect(matchesAdminOnlyKey("clerk/oauth-token", ["*/oauth-token"])).toBe(true);
    expect(matchesAdminOnlyKey("marko/oauth-token-2", ["*/oauth-token"])).toBe(false);
    expect(matchesAdminOnlyKey("anything/at-all", ["*"])).toBe(true);
  });

  it("is case-sensitive (vault keys are)", () => {
    expect(matchesAdminOnlyKey("Stripe/Key", ["stripe/*"])).toBe(false);
  });

  it("does not treat regex metachars in the pattern as special", () => {
    // A `.` in the pattern must match a literal dot, not any char.
    expect(matchesAdminOnlyKey("aXb/key", ["a.b/*"])).toBe(false);
    expect(matchesAdminOnlyKey("a.b/key", ["a.b/*"])).toBe(true);
  });

  it("returns false for an empty pattern list", () => {
    expect(matchesAdminOnlyKey("anything", [])).toBe(false);
  });
});

describe("filterAdminOnlyKeys", () => {
  it("returns only the admin-only subset, order-preserving and deduped", () => {
    const patterns = ["stripe/*", "microsoft/ken-tokens"];
    expect(
      filterAdminOnlyKeys(
        ["perplexity/api-key", "stripe/secret", "microsoft/ken-tokens", "stripe/secret"],
        patterns,
      ),
    ).toEqual(["stripe/secret", "microsoft/ken-tokens"]);
  });
});

describe("adminOnlyKeysBeingAdded (posture retain-but-not-add)", () => {
  const patterns = ["stripe/*", "microsoft/ken-tokens"];

  it("blocks a NEW admin-only key not already held", () => {
    expect(
      adminOnlyKeysBeingAdded(["stripe/secret"], [], patterns),
    ).toEqual(["stripe/secret"]);
  });

  it("ALLOWS retaining an admin-only key the agent already holds (union re-mint)", () => {
    // The gateway unions the new key (perplexity/api-key) with the
    // agent's existing grant which already includes stripe/secret. The
    // admin-only key is retained, not added → not blocked.
    expect(
      adminOnlyKeysBeingAdded(
        ["stripe/secret", "perplexity/api-key"],
        ["stripe/secret"],
        patterns,
      ),
    ).toEqual([]);
  });

  it("blocks the new admin-only key even while retaining an existing one", () => {
    expect(
      adminOnlyKeysBeingAdded(
        ["stripe/secret", "microsoft/ken-tokens"],
        ["stripe/secret"],
        patterns,
      ),
    ).toEqual(["microsoft/ken-tokens"]);
  });

  it("never blocks non-admin-only keys", () => {
    expect(
      adminOnlyKeysBeingAdded(["perplexity/api-key", "webkite/token"], [], patterns),
    ).toEqual([]);
  });

  it("is a no-op when no admin-only patterns are configured", () => {
    expect(adminOnlyKeysBeingAdded(["stripe/secret"], [], [])).toEqual([]);
  });
});
