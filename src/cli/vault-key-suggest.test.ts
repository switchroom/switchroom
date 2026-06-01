import { describe, it, expect } from "vitest";
import { suggestVaultKeys } from "./vault-key-suggest.js";

// The keys an agent (marko) actually holds, from `switchroom vault list`.
const MARKO_KEYS = [
  "perplexity/api-key",
  "webkite/cloudflare-account-id",
  "webkite/cloudflare-api-token",
  "marko-bot-token",
  "marko/postiz-api-key",
  "marko/cf-access-client-id",
  "marko/cf-access-client-secret",
  "marko/brevo-api-key",
  "marko/meta-access-token",
  "meta/page-token",
  "marko/meta-ads-token",
];

describe("suggestVaultKeys", () => {
  it("maps a guessed postiz key to the real namespaced one, ranked first", () => {
    const out = suggestVaultKeys("postiz/api-key", MARKO_KEYS);
    expect(out[0]).toBe("marko/postiz-api-key");
  });

  it("maps a guessed cf-access key to the real one", () => {
    expect(suggestVaultKeys("postiz/cf-access-client-id", MARKO_KEYS)[0]).toBe(
      "marko/cf-access-client-id",
    );
    expect(
      suggestVaultKeys("postiz/cf-access-client-secret", MARKO_KEYS)[0],
    ).toBe("marko/cf-access-client-secret");
  });

  it("returns nothing when no token overlaps at all", () => {
    expect(suggestVaultKeys("garmin/oauth-token-totally-different", ["foo/bar-baz"])).toEqual(
      [],
    );
  });

  it("never suggests the requested key itself", () => {
    expect(suggestVaultKeys("marko/postiz-api-key", MARKO_KEYS)).not.toContain(
      "marko/postiz-api-key",
    );
  });

  it("caps the number of suggestions", () => {
    expect(suggestVaultKeys("marko/x-token", MARKO_KEYS, 2).length).toBeLessThanOrEqual(2);
  });

  it("ranks more-shared-tokens above fewer", () => {
    const out = suggestVaultKeys("marko/postiz-api-key-extra", MARKO_KEYS, 5);
    // postiz-api-key shares postiz/api/key (+marko) — must outrank brevo-api-key (api/key).
    expect(out.indexOf("marko/postiz-api-key")).toBeLessThan(
      out.indexOf("marko/brevo-api-key"),
    );
  });

  it("is case-insensitive and tolerates empty input", () => {
    expect(suggestVaultKeys("POSTIZ/API-KEY", MARKO_KEYS)[0]).toBe("marko/postiz-api-key");
    expect(suggestVaultKeys("", MARKO_KEYS)).toEqual([]);
    expect(suggestVaultKeys("postiz/api-key", [])).toEqual([]);
  });
});
