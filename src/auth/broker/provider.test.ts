/**
 * Tests for the provider abstraction (RFC G Phase 3b.1).
 *
 * Covers the `Provider` interface contract via a fixture provider, the
 * `AccountKey` composite-key utilities, and the `ProviderRegistry`
 * register/lookup/has/names surface.
 *
 * The actual Anthropic + Google providers are implemented in Phase
 * 3b.1b (server refactor) and Phase 3b.2 (Google provider). This file
 * pins the contract those implementations must honor.
 */

import { describe, expect, it } from "vitest";

import {
  accountKeyString,
  ProviderRegistry,
  type AccountKey,
  type Provider,
  type ProviderName,
  type RefreshRequest,
  type RefreshResult,
} from "./provider.js";

// ────────────────────────────────────────────────────────────────────────
// Fixture provider — minimal implementation for testing the registry
// + interface contract.
// ────────────────────────────────────────────────────────────────────────

function makeFixtureProvider(name: ProviderName, opts: {
  refreshResult?: RefreshResult;
  expiresAt?: number;
  invalidShape?: boolean;
} = {}): Provider {
  return {
    name,
    async refresh(_req: RefreshRequest): Promise<RefreshResult> {
      return opts.refreshResult ?? {
        ok: true,
        accessToken: "fixture-access",
        expiresAt: opts.expiresAt ?? Date.now() + 3600_000,
        rawCredentials: {},
      };
    },
    extractExpiresAt(creds: unknown): number | undefined {
      return (creds as { expiresAt?: number })?.expiresAt;
    },
    validateCredentialShape(creds: unknown): string | null {
      if (opts.invalidShape) return "fixture provider rejects all shapes";
      if (!creds || typeof creds !== "object") return "credentials must be an object";
      return null;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// AccountKey + accountKeyString
// ────────────────────────────────────────────────────────────────────────

describe("accountKeyString — composite (provider, account) encoding", () => {
  it("encodes anthropic accounts as 'anthropic:<label>'", () => {
    expect(accountKeyString({ provider: "anthropic", account: "default" })).toBe(
      "anthropic:default",
    );
  });

  it("encodes google accounts as 'google:<email>'", () => {
    expect(
      accountKeyString({ provider: "google", account: "alice@example.com" }),
    ).toBe("google:alice@example.com");
  });

  it("the same account label under different providers produces different keys (collision avoidance)", () => {
    // Load-bearing for the broker's per-(provider, account) state map.
    // Without this, an Anthropic account labeled "alice@example.com"
    // would collide with a Google account named "alice@example.com".
    const a: AccountKey = { provider: "anthropic", account: "alice@example.com" };
    const g: AccountKey = { provider: "google", account: "alice@example.com" };
    expect(accountKeyString(a)).not.toBe(accountKeyString(g));
  });
});

// ────────────────────────────────────────────────────────────────────────
// ProviderRegistry
// ────────────────────────────────────────────────────────────────────────

describe("ProviderRegistry", () => {
  it("registers and looks up a single provider", () => {
    const reg = new ProviderRegistry();
    const anthropic = makeFixtureProvider("anthropic");
    reg.register(anthropic);
    expect(reg.lookup("anthropic")).toBe(anthropic);
  });

  it("registers two providers and looks up each independently", () => {
    const reg = new ProviderRegistry();
    const anthropic = makeFixtureProvider("anthropic");
    const google = makeFixtureProvider("google");
    reg.register(anthropic);
    reg.register(google);
    expect(reg.lookup("anthropic")).toBe(anthropic);
    expect(reg.lookup("google")).toBe(google);
    expect(reg.lookup("anthropic")).not.toBe(google);
  });

  it("rejects double-registration of the same provider name (single-instance invariant)", () => {
    const reg = new ProviderRegistry();
    reg.register(makeFixtureProvider("anthropic"));
    expect(() => reg.register(makeFixtureProvider("anthropic"))).toThrow(
      /already registered/,
    );
  });

  it("lookup throws on unknown provider with operator-actionable message", () => {
    const reg = new ProviderRegistry();
    reg.register(makeFixtureProvider("anthropic"));
    expect(() => reg.lookup("google")).toThrow(/'google' is not registered/);
  });

  it("has() returns true for registered providers, false for unknown", () => {
    const reg = new ProviderRegistry();
    reg.register(makeFixtureProvider("google"));
    expect(reg.has("google")).toBe(true);
    expect(reg.has("anthropic")).toBe(false);
  });

  it("names() returns registered provider names", () => {
    const reg = new ProviderRegistry();
    expect(reg.names()).toEqual([]);
    reg.register(makeFixtureProvider("anthropic"));
    reg.register(makeFixtureProvider("google"));
    expect(reg.names().sort()).toEqual(["anthropic", "google"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Provider contract — what every implementation must honor
// ────────────────────────────────────────────────────────────────────────

describe("Provider interface contract (pinned via fixture)", () => {
  it("refresh returns RefreshSuccess with accessToken + expiresAt + rawCredentials", async () => {
    const p = makeFixtureProvider("anthropic", { expiresAt: 12345 });
    const r = await p.refresh({ refreshToken: "rt" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accessToken).toBe("fixture-access");
      expect(r.expiresAt).toBe(12345);
      expect(r.rawCredentials).toBeDefined();
    }
  });

  it("refresh can return RefreshFailure with kind + detail (broker maps to REFRESH_FAILED)", async () => {
    const p = makeFixtureProvider("anthropic", {
      refreshResult: { ok: false, kind: "invalid_grant", detail: "rotated" },
    });
    const r = await p.refresh({ refreshToken: "rt" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invalid_grant");
      expect(r.detail).toBe("rotated");
    }
  });

  it("refresh accepts optional clientId + scopes (Google needs them, Anthropic doesn't)", async () => {
    const p = makeFixtureProvider("google");
    const r = await p.refresh({
      refreshToken: "rt",
      clientId: "client-id",
      scopes: ["drive", "docs"],
    });
    expect(r.ok).toBe(true);
  });

  it("extractExpiresAt returns the expiry from credential shape", () => {
    const p = makeFixtureProvider("anthropic");
    expect(p.extractExpiresAt({ expiresAt: 9999 })).toBe(9999);
    expect(p.extractExpiresAt({})).toBeUndefined();
    expect(p.extractExpiresAt(null)).toBeUndefined();
  });

  it("validateCredentialShape returns null on valid shapes", () => {
    const p = makeFixtureProvider("anthropic");
    expect(p.validateCredentialShape({ accessToken: "x" })).toBeNull();
  });

  it("validateCredentialShape returns a string error on invalid shapes", () => {
    const p = makeFixtureProvider("anthropic");
    expect(p.validateCredentialShape("not-an-object")).toContain("must be");
    const strict = makeFixtureProvider("anthropic", { invalidShape: true });
    expect(strict.validateCredentialShape({})).toContain("rejects");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Refresh failure kinds — pin the discriminant set so downstream UX
// (CLI / MCP wrapper) can rely on the values being stable.
// ────────────────────────────────────────────────────────────────────────

describe("RefreshErrorKind discriminant set", () => {
  it("supports the four documented kinds", () => {
    const kinds: Array<RefreshResult> = [
      { ok: false, kind: "invalid_grant", detail: "" },
      { ok: false, kind: "network", detail: "" },
      { ok: false, kind: "quota_exceeded", detail: "" },
      { ok: false, kind: "provider_error", detail: "" },
    ];
    for (const r of kinds) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // TS narrows kind to the union; this just exercises every variant.
        expect(typeof r.kind).toBe("string");
      }
    }
  });
});
