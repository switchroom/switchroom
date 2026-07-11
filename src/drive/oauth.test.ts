/**
 * Tests for OAuth tier auto-selection + refresh-token rotation handling.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  detectHeadless,
  selectInitialTier,
  nextTier,
  refreshAccessToken,
  InvalidGrantError,
  pollDeviceToken,
  buildOobAuthUrl,
  exchangeOobCode,
  revokeRefreshToken,
  runLoopbackOAuth,
  buildLoopbackAuthUrl,
  requestDeviceCode,
  OAuthTierRejected,
  generatePkcePair,
  exchangeAuthCode,
} from "./oauth.js";
import { createHash } from "node:crypto";

const cfg = {
  client_id: "cid",
  client_secret: "csecret",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
};

describe("detectHeadless", () => {
  it("treats SSH session with no display as headless", () => {
    expect(
      detectHeadless({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }),
    ).toBe(true);
  });

  it("treats laptop with $DISPLAY set as not headless", () => {
    expect(detectHeadless({ DISPLAY: ":0" })).toBe(false);
  });

  it("treats Wayland display as not headless", () => {
    expect(detectHeadless({ WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
  });

  it("ignores empty DISPLAY/WAYLAND_DISPLAY strings (real-world env shape)", () => {
    expect(
      detectHeadless({ DISPLAY: "", WAYLAND_DISPLAY: "", SSH_TTY: "/dev/pts/0" }),
    ).toBe(true);
  });

  it("non-SSH headless box still treated as headless (no display means no browser)", () => {
    expect(detectHeadless({})).toBe(true);
  });
});

describe("selectInitialTier", () => {
  it("picks device_code on headless SSH boxes", () => {
    expect(
      selectInitialTier({ SSH_CONNECTION: "x" }),
    ).toBe("device_code");
  });

  it("picks desktop_loopback on laptops with display + browser opener", () => {
    expect(
      selectInitialTier({
        DISPLAY: ":0",
        SWITCHROOM_DRIVE_HAS_BROWSER_OPENER: "1",
      } as never),
    ).toBe("desktop_loopback");
  });

  it("picks device_code on display-host with no browser opener", () => {
    expect(
      selectInitialTier({
        DISPLAY: ":0",
        SWITCHROOM_DRIVE_HAS_BROWSER_OPENER: "0",
      } as never),
    ).toBe("device_code");
  });

  it("honours SWITCHROOM_DRIVE_OAUTH_TIER override", () => {
    expect(
      selectInitialTier({
        DISPLAY: ":0",
        SWITCHROOM_DRIVE_OAUTH_TIER: "desktop_loopback",
      }),
    ).toBe("desktop_loopback");
  });

  // Load-bearing for the `account add` Drive default: the override must
  // win even on a headless host (no DISPLAY, inside SSH), ahead of the
  // headless-avoidance. account add defaults the env to
  // desktop_loopback for Drive precisely because device-code/OOB are
  // dead ends for Drive and the ladder otherwise dead-ends headless.
  it("override beats headless-avoidance (desktop_loopback on a headless SSH host)", () => {
    expect(
      selectInitialTier({
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
        SSH_CONNECTION: "10.0.0.2 5 10.0.0.1 22",
        SWITCHROOM_DRIVE_OAUTH_TIER: "desktop_loopback",
      }),
    ).toBe("desktop_loopback");
  });
});

describe("nextTier", () => {
  it("falls device_code → oob_paste", () => {
    expect(nextTier("device_code", { SSH_CONNECTION: "x" })).toBe("oob_paste");
  });

  it("falls oob_paste → desktop_loopback when display present", () => {
    expect(nextTier("oob_paste", { DISPLAY: ":0" })).toBe("desktop_loopback");
  });

  it("falls oob_paste → null on truly headless boxes", () => {
    expect(nextTier("oob_paste", { SSH_CONNECTION: "x" })).toBe(null);
  });

  it("returns null after desktop_loopback (last tier)", () => {
    expect(nextTier("desktop_loopback", { DISPLAY: ":0" })).toBe(null);
  });
});

describe("refreshAccessToken — invalid_grant rotation", () => {
  it("throws InvalidGrantError when Google rejects the refresh token", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(refreshAccessToken(cfg, "rt", fakeFetch)).rejects.toBeInstanceOf(
      InvalidGrantError,
    );
  });

  it("returns the new access token on success", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({
          access_token: "at-new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const r = await refreshAccessToken(cfg, "rt", fakeFetch);
    expect(r.access_token).toBe("at-new");
    expect(r.expires_in).toBe(3600);
  });

  it("rethrows non-invalid_grant errors as plain Error", async () => {
    const fakeFetch = mock(async () =>
      new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(refreshAccessToken(cfg, "rt", fakeFetch)).rejects.toThrow(
      /refresh failed/,
    );
  });
});

describe("pollDeviceToken", () => {
  it("returns access_token on first non-pending poll", async () => {
    let calls = 0;
    const fakeFetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const tok = await pollDeviceToken(
      cfg,
      { device_code: "dc", user_code: "uc", verification_url: "v", expires_in: 600, interval: 1 },
      { fetchImpl: fakeFetch, sleepMs: async () => undefined },
    );
    expect(tok.access_token).toBe("at");
    expect(tok.refresh_token).toBe("rt");
  });

  it("backs off on slow_down then succeeds", async () => {
    let calls = 0;
    const fakeFetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "slow_down" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const tok = await pollDeviceToken(
      cfg,
      { device_code: "dc", user_code: "uc", verification_url: "v", expires_in: 600, interval: 1 },
      { fetchImpl: fakeFetch, sleepMs: async () => undefined },
    );
    expect(tok.access_token).toBe("at");
  });

  it("throws on access_denied", async () => {
    const fakeFetch = mock(
      async () => new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      pollDeviceToken(
        cfg,
        { device_code: "dc", user_code: "uc", verification_url: "v", expires_in: 600, interval: 1 },
        { fetchImpl: fakeFetch, sleepMs: async () => undefined },
      ),
    ).rejects.toThrow(/denied/);
  });
});

describe("OOB-paste flow", () => {
  it("buildOobAuthUrl includes redirect_uri=urn:ietf:wg:oauth:2.0:oob", () => {
    const url = buildOobAuthUrl(cfg);
    expect(url).toContain("redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("access_type=offline");
  });

  it("exchangeOobCode round-trips via the token endpoint", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const tok = await exchangeOobCode(cfg, "pasted-code", fakeFetch);
    expect(tok.refresh_token).toBe("rt");
  });
});

describe("requestDeviceCode — tier-rejection classification", () => {
  const resp = (status: number, body: unknown) =>
    mock(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    ) as unknown as typeof fetch;

  it("200 → returns the device-code response", async () => {
    const f = resp(200, {
      device_code: "dc",
      user_code: "UC",
      verification_url: "https://g/v",
      expires_in: 1800,
      interval: 5,
    });
    const r = await requestDeviceCode(cfg, f);
    expect(r.device_code).toBe("dc");
  });

  it("401 invalid_client (\"Invalid client type\") → OAuthTierRejected, not a hard error", async () => {
    // Exactly what Google returns for a Desktop/Web client hitting the
    // device endpoint — must fall through, not crash.
    const f = resp(401, {
      error: "invalid_client",
      error_description: "Invalid client type.",
    });
    await expect(requestDeviceCode(cfg, f)).rejects.toBeInstanceOf(
      OAuthTierRejected,
    );
  });

  it("400 / 403 still classify as OAuthTierRejected (unchanged)", async () => {
    await expect(
      requestDeviceCode(cfg, resp(400, { error: "invalid_scope" })),
    ).rejects.toBeInstanceOf(OAuthTierRejected);
    await expect(
      requestDeviceCode(cfg, resp(403, { error: "disabled_client" })),
    ).rejects.toBeInstanceOf(OAuthTierRejected);
  });

  it("401 WITHOUT invalid_client → hard Error (don't over-broaden)", async () => {
    let err: unknown;
    try {
      await requestDeviceCode(cfg, resp(401, { error: "something_else" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OAuthTierRejected);
  });

  it("500 → hard Error (a server fault is not a tier rejection)", async () => {
    let err: unknown;
    try {
      await requestDeviceCode(cfg, resp(500, "upstream boom"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OAuthTierRejected);
  });
});

describe("revokeRefreshToken", () => {
  it("returns ok on Google 200", async () => {
    const fakeFetch = mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    expect(await revokeRefreshToken("rt", fakeFetch)).toEqual({ ok: true });
  });

  it("returns ok on Google 400 (already invalidated counts as consistent)", async () => {
    const fakeFetch = mock(
      async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 }),
    ) as unknown as typeof fetch;
    expect(await revokeRefreshToken("rt", fakeFetch)).toEqual({ ok: true });
  });

  it("returns failed on unexpected non-2xx", async () => {
    const fakeFetch = mock(
      async () => new Response("oops", { status: 503 }),
    ) as unknown as typeof fetch;
    const r = await revokeRefreshToken("rt", fakeFetch);
    expect(r.ok).toBe(false);
  });

  it("returns failed when fetch itself throws (network down)", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await revokeRefreshToken("rt", fakeFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("ECONNREFUSED");
  });
});

describe("PKCE (sec F1 — Google loopback parity with Microsoft)", () => {
  it("generatePkcePair returns a verifier and its S256 challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    // Verifier is base64url of 32 random bytes → 43 chars, unreserved set.
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    // Challenge MUST be base64url(SHA-256(verifier)).
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generatePkcePair is non-deterministic across calls", () => {
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });

  it("buildLoopbackAuthUrl carries code_challenge + code_challenge_method=S256", () => {
    const url = buildLoopbackAuthUrl(cfg, "http://127.0.0.1:54321", "abc123", "chal-xyz");
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge")).toBe("chal-xyz");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchangeAuthCode sends code_verifier when provided", async () => {
    let sentBody = "";
    const fakeFetch = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await exchangeAuthCode(cfg, "code-1", "http://127.0.0.1:9/", "verifier-abc", fakeFetch);
    const params = new URLSearchParams(sentBody);
    expect(params.get("code_verifier")).toBe("verifier-abc");
    expect(params.get("grant_type")).toBe("authorization_code");
  });

  it("exchangeAuthCode omits code_verifier when not provided (OOB path)", async () => {
    let sentBody = "";
    const fakeFetch = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await exchangeAuthCode(cfg, "code-1", "urn:ietf:wg:oauth:2.0:oob", undefined, fakeFetch);
    expect(new URLSearchParams(sentBody).has("code_verifier")).toBe(false);
  });
});

describe("desktop-loopback flow", () => {
  it("buildLoopbackAuthUrl includes redirect_uri, state, code response_type", () => {
    const url = buildLoopbackAuthUrl(cfg, "http://127.0.0.1:54321", "abc123", "chal");
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321");
    expect(url).toContain("state=abc123");
    expect(url).toContain("response_type=code");
    expect(url).toContain("access_type=offline");
  });

  it("happy path: simulates Google redirect with valid state and exchanges code with a code_verifier", async () => {
    const fakeFetch = mock(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain("code=auth-code-xyz");
      expect(body).toContain("redirect_uri=http");
      // sec F1: the loopback exchange MUST carry a PKCE verifier.
      expect(new URLSearchParams(body).get("code_verifier")).toBeTruthy();
      return new Response(
        JSON.stringify({
          access_token: "at-loop",
          refresh_token: "rt-loop",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    let capturedAuthUrl = "";
    const promise = runLoopbackOAuth(cfg, {
      fetchImpl: fakeFetch,
      openImpl: async (url) => {
        capturedAuthUrl = url;
        // Simulate the browser hitting our local server.
        // Defer slightly so the listen() callback registers state.
        setTimeout(() => {
          const u = new URL(url);
          const redirectUri = u.searchParams.get("redirect_uri")!;
          const state = u.searchParams.get("state")!;
          const cb = `${redirectUri}/?code=auth-code-xyz&state=${state}`;
          fetch(cb).catch(() => {
            /* response body not needed */
          });
        }, 5);
        return true;
      },
      timeoutMs: 5000,
    });

    const tok = await promise;
    expect(tok.access_token).toBe("at-loop");
    expect(tok.refresh_token).toBe("rt-loop");
    expect(capturedAuthUrl).toContain("state=");
    // sec F1: the consent URL the browser opened MUST carry the S256 challenge.
    const authU = new URL(capturedAuthUrl);
    expect(authU.searchParams.get("code_challenge")).toBeTruthy();
    expect(authU.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("rejects callback with mismatched state and never exchanges", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("token endpoint must not be hit on state mismatch");
    }) as unknown as typeof fetch;

    await expect(
      runLoopbackOAuth(cfg, {
        fetchImpl: fakeFetch,
        openImpl: async (url) => {
          const u = new URL(url);
          const redirectUri = u.searchParams.get("redirect_uri")!;
          setTimeout(() => {
            const cb = `${redirectUri}/?code=c&state=WRONG`;
            fetch(cb).catch(() => undefined);
          }, 5);
          return true;
        },
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/state parameter mismatch/i);
  });

  it("times out cleanly when no callback arrives", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("must not exchange on timeout");
    }) as unknown as typeof fetch;

    await expect(
      runLoopbackOAuth(cfg, {
        fetchImpl: fakeFetch,
        openImpl: async () => true, // never trigger callback
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("closes the ephemeral server after success (port becomes reusable)", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    let capturedRedirect = "";
    await runLoopbackOAuth(cfg, {
      fetchImpl: fakeFetch,
      openImpl: async (url) => {
        const u = new URL(url);
        capturedRedirect = u.searchParams.get("redirect_uri")!;
        const state = u.searchParams.get("state")!;
        setTimeout(() => {
          fetch(`${capturedRedirect}/?code=c&state=${state}`).catch(() => undefined);
        }, 5);
        return true;
      },
      timeoutMs: 5000,
    });

    // Server should be closed; a fresh connect attempt should be refused.
    const port = Number(new URL(capturedRedirect).port);
    let connRefused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      connRefused = true;
    }
    expect(connRefused).toBe(true);
  });

  it("closes the ephemeral server after timeout (no leaked listener)", async () => {
    const fakeFetch = mock(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    let capturedRedirect = "";
    await runLoopbackOAuth(cfg, {
      fetchImpl: fakeFetch,
      openImpl: async (url) => {
        capturedRedirect = new URL(url).searchParams.get("redirect_uri")!;
        return true;
      },
      timeoutMs: 50,
    }).catch(() => undefined);

    const port = Number(new URL(capturedRedirect).port);
    let connRefused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      connRefused = true;
    }
    expect(connRefused).toBe(true);
  });
});
