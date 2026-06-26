import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshAccountIfNeeded,
  DEFAULT_CLIENT_ID,
} from "./account-refresh.js";
import { writeAccountCredentials } from "./account-store.js";

// Hermetic: every test points `home` at its own tmpdir — never ~/.switchroom.
const tmpHomes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "sr-acct-refresh-"));
  tmpHomes.push(h);
  return h;
}
afterEach(() => {
  while (tmpHomes.length) {
    try {
      rmSync(tmpHomes.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Seed a near-expiry credential (with a refresh token) so the refresh fires. */
function seedExpiringAccount(home: string, label: string): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: "at-" + "expiring",
        refreshToken: "rt-" + "valid",
        // Expired an hour ago → below threshold → refresh path taken.
        expiresAt: Date.now() - 60 * 60 * 1000,
        scopes: ["user:inference"],
      },
    } as never,
    home,
  );
}

/** A fetcher that captures the request body and returns a canned token. */
function capturingFetcher(captured: { body?: string }) {
  return async (_url: string, init: { body?: string }) => {
    captured.body = init.body;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "at-" + "new",
          refresh_token: "rt-" + "new",
          expires_in: 28800,
          token_type: "Bearer",
        }),
    };
  };
}

describe("account-refresh client_id", () => {
  it("is the Claude Code OAuth client (NOT the legacy 9d1cd16e value)", () => {
    // Regression guard for the latent bug: every account was a long-lived
    // setup-token that never refreshed, so the wrong id (9d1cd16e-…) 400'd
    // only once a short-lived session token was added. Pin the correct value.
    expect(DEFAULT_CLIENT_ID).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(DEFAULT_CLIENT_ID).not.toBe("9d1cd16e-bcb9-40c9-a915-196412f27aa6");
  });

  it("sends the default client_id in the refresh exchange body", async () => {
    const home = freshHome();
    seedExpiringAccount(home, "alice@example.com");
    const captured: { body?: string } = {};
    const res = await refreshAccountIfNeeded("alice@example.com", {
      home,
      fetcher: capturingFetcher(captured),
    });
    expect(res.kind).toBe("refreshed");
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.grant_type).toBe("refresh_token");
    expect(body.client_id).toBe(DEFAULT_CLIENT_ID);
  });

  it("honors an explicit clientId override", async () => {
    const home = freshHome();
    seedExpiringAccount(home, "bob@example.com");
    const captured: { body?: string } = {};
    await refreshAccountIfNeeded("bob@example.com", {
      home,
      clientId: "override-" + "client-id",
      fetcher: capturingFetcher(captured),
    });
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.client_id).toBe("override-client-id");
  });
});
