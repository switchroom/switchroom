/**
 * auth-broker — Microsoft provider dispatch (RFC #1873 broker repair).
 *
 * Before this fix the broker registered MicrosoftProvider but the
 * get-credentials / add-account / rm-account dispatch only routed
 * `anthropic` and `google` — every Microsoft call fell through to
 * `INTERNAL: unhandled provider 'microsoft'`, leaving the M365
 * integration non-functional end-to-end. These tests pin the four
 * Microsoft broker ops (get-credentials, add-account, rm-account,
 * list-microsoft-accounts) plus the refresh-tick, mirroring the Google
 * coverage in `server-list-google-accounts.test.ts` +
 * `server-google-refresh.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import {
  microsoftAccountCredentialsPath,
  microsoftAccountExists,
  writeMicrosoftAccountCredentials,
} from "./microsoft-storage.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { MicrosoftCredentialsShape } from "./protocol.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-microsoft-test-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

/**
 * Build a config with the Microsoft provider registered (client_id
 * present, no secret — public-client posture). `agents` and
 * `microsoft_accounts` are passed verbatim so tests can wire the
 * per-agent `microsoft_workspace.account` selector + the per-account
 * `enabled_for[]` ACL.
 */
function makeConfig(
  h: Harness,
  opts: {
    agents?: Record<string, object>;
    microsoftAccounts?: Record<string, { enabled_for?: string[] }>;
    withProvider?: boolean;
  } = {},
): SwitchroomConfig {
  const base: Record<string, unknown> = {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: opts.agents ?? {},
    auth: {},
  };
  if (opts.withProvider !== false) {
    base.microsoft_workspace = {
      microsoft_client_id: "11111111-2222-3333-4444-555555555555",
      authority: "https://login.microsoftonline.com/common",
    };
  }
  if (opts.microsoftAccounts) {
    base.microsoft_accounts = opts.microsoftAccounts;
  }
  return base as unknown as SwitchroomConfig;
}

function seedMicrosoftAccount(
  h: Harness,
  account: string,
  opts: {
    expiresAt: number;
    refreshToken?: string;
    accessToken?: string;
    scope?: string;
    accountType?: "personal" | "work";
    tenantId?: string;
  } = { expiresAt: Date.now() + 3600_000 },
): void {
  const accountType = opts.accountType ?? "personal";
  const creds: MicrosoftCredentialsShape = {
    microsoftOauth: {
      accessToken: opts.accessToken ?? `at-${account}`,
      refreshToken: opts.refreshToken ?? `rt-${account}`,
      expiresAt: opts.expiresAt,
      scope:
        opts.scope ??
        "openid profile offline_access Mail.ReadWrite Files.ReadWrite.All",
      clientId: "11111111-2222-3333-4444-555555555555",
      accountEmail: account,
      tokenType: "Bearer",
      tenantId:
        opts.tenantId ??
        (accountType === "personal"
          ? "9188040d-6c67-4c5b-b112-36a304b66dad"
          : "contoso-tenant-id"),
      accountType,
      homeAccountId: `oid-${account}.${opts.tenantId ?? "tid"}`,
    },
  };
  writeMicrosoftAccountCredentials(h.stateDir, account, creds);
}

/** Open UDS, send one request, read one response, close. */
async function rpc(socketPath: string, req: object): Promise<unknown> {
  return await new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      if (err) rejectP(err);
      else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        try {
          settle(decodeResponse(line));
        } catch (err) {
          settle(null, err as Error);
        }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

/**
 * Stub fetch returning a successful Microsoft token-exchange response.
 * `withIdToken: false` omits the id_token (a real Microsoft refresh
 * behavior under some scope/account combos) so we can assert the
 * provider preserves canonical identity fields from priorCredentials.
 */
function makeOkFetcher(opts: {
  newAccessToken?: string;
  rotatedRefreshToken?: string;
  expiresIn?: number;
  withIdToken?: boolean;
}): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const body: Record<string, unknown> = {
      access_token: opts.newAccessToken ?? "at-new",
      expires_in: opts.expiresIn ?? 3600,
      token_type: "Bearer",
      scope: "Mail.ReadWrite Files.ReadWrite.All",
    };
    if (opts.rotatedRefreshToken) {
      body.refresh_token = opts.rotatedRefreshToken;
    }
    // id_token deliberately omitted unless requested — exercises the
    // priorCredentials fallback in MicrosoftProvider.refresh.
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Awaited<ReturnType<typeof fetch>>;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function makeInvalidGrantFetcher(): typeof fetch {
  return (async () => {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "AADSTS70000: token revoked.",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ) as unknown as Awaited<ReturnType<typeof fetch>>;
  }) as unknown as typeof fetch;
}

describe("AuthBroker — Microsoft get-credentials op", () => {
  it("returns stored credentials for an agent pinned + ACL-enabled on the account", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      agents: { ziggy: { microsoft_workspace: { account: "lisa@outlook.com" } } },
      microsoftAccounts: { "lisa@outlook.com": { enabled_for: ["ziggy"] } },
    });
    seedMicrosoftAccount(h, "lisa@outlook.com", {
      expiresAt: Date.now() + 3600_000,
      accessToken: "at-lisa-live",
    });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "ms-1",
      op: "get-credentials",
      provider: "microsoft",
    })) as {
      ok: true;
      data: { account: string; credentials: MicrosoftCredentialsShape };
    };

    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("lisa@outlook.com");
    expect(resp.data.credentials.microsoftOauth.accessToken).toBe("at-lisa-live");

    broker.stop();
  });

  it("FORBIDs an agent not listed in the account's enabled_for[]", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      agents: { ziggy: { microsoft_workspace: { account: "lisa@outlook.com" } } },
      // ziggy pinned to the account but NOT in enabled_for.
      microsoftAccounts: { "lisa@outlook.com": { enabled_for: ["clerk"] } },
    });
    seedMicrosoftAccount(h, "lisa@outlook.com", { expiresAt: Date.now() + 3600_000 });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "ms-2",
      op: "get-credentials",
      provider: "microsoft",
    })) as { ok: false; error: { code: string } };

    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("FORBIDDEN");

    broker.stop();
  });

  it("ACCOUNT_NOT_FOUND when the agent has no microsoft_workspace.account configured", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: { ziggy: {} } });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "ms-3",
      op: "get-credentials",
      provider: "microsoft",
    })) as { ok: false; error: { code: string } };

    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("ACCOUNT_NOT_FOUND");

    broker.stop();
  });

  it("ACCOUNT_NOT_FOUND when pinned + enabled but no credentials on disk", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      agents: { ziggy: { microsoft_workspace: { account: "lisa@outlook.com" } } },
      microsoftAccounts: { "lisa@outlook.com": { enabled_for: ["ziggy"] } },
    });
    // No seedMicrosoftAccount — nothing on disk.

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "ms-4",
      op: "get-credentials",
      provider: "microsoft",
    })) as { ok: false; error: { code: string } };

    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("ACCOUNT_NOT_FOUND");

    broker.stop();
  });
});

describe("AuthBroker — Microsoft add-account / rm-account ops", () => {
  const validCreds = {
    microsoftOauth: {
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: Date.now() + 3600_000,
      scope: "Mail.ReadWrite Files.ReadWrite.All",
      clientId: "11111111-2222-3333-4444-555555555555",
      accountEmail: "newguy@outlook.com",
      tokenType: "Bearer" as const,
      tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
      accountType: "personal" as const,
      homeAccountId: "oid.tid",
    },
  };

  it("admin can add a Microsoft account; non-admin cannot", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      agents: { ziggy: {}, clerk: { admin: true } },
    });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const denied = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "add-1",
      op: "add-account",
      provider: "microsoft",
      label: "newguy@outlook.com",
      credentials: validCreds,
    })) as { ok: false; error: { code: string } };
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("FORBIDDEN");
    expect(microsoftAccountExists(h.stateDir, "newguy@outlook.com")).toBe(false);

    const ok = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "add-2",
      op: "add-account",
      provider: "microsoft",
      label: "newguy@outlook.com",
      credentials: validCreds,
    })) as { ok: true; data: { label: string } };
    expect(ok.ok).toBe(true);
    expect(ok.data.label).toBe("newguy@outlook.com");
    expect(microsoftAccountExists(h.stateDir, "newguy@outlook.com")).toBe(true);

    broker.stop();
  });

  it("ACCOUNT_ALREADY_EXISTS without replace; succeeds with replace", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: { clerk: { admin: true } } });
    seedMicrosoftAccount(h, "newguy@outlook.com", { expiresAt: Date.now() + 3600_000 });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const dup = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "add-3",
      op: "add-account",
      provider: "microsoft",
      label: "newguy@outlook.com",
      credentials: validCreds,
    })) as { ok: false; error: { code: string } };
    expect(dup.ok).toBe(false);
    expect(dup.error.code).toBe("ACCOUNT_ALREADY_EXISTS");

    const replaced = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "add-4",
      op: "add-account",
      provider: "microsoft",
      label: "newguy@outlook.com",
      credentials: validCreds,
      replace: true,
    })) as { ok: true };
    expect(replaced.ok).toBe(true);

    broker.stop();
  });

  it("rm-account refuses while the account is still enabled_for an agent", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      agents: { clerk: { admin: true } },
      microsoftAccounts: { "lisa@outlook.com": { enabled_for: ["ziggy"] } },
    });
    seedMicrosoftAccount(h, "lisa@outlook.com", { expiresAt: Date.now() + 3600_000 });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const refused = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "rm-1",
      op: "rm-account",
      provider: "microsoft",
      label: "lisa@outlook.com",
    })) as { ok: false; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("INVALID_ARGS");
    expect(refused.error.message).toContain("still enabled");
    expect(microsoftAccountExists(h.stateDir, "lisa@outlook.com")).toBe(true);

    broker.stop();
  });

  it("rm-account removes an account with no remaining grants", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: { clerk: { admin: true } } });
    seedMicrosoftAccount(h, "lisa@outlook.com", { expiresAt: Date.now() + 3600_000 });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const removed = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "rm-2",
      op: "rm-account",
      provider: "microsoft",
      label: "lisa@outlook.com",
    })) as { ok: true };
    expect(removed.ok).toBe(true);
    expect(microsoftAccountExists(h.stateDir, "lisa@outlook.com")).toBe(false);

    broker.stop();
  });
});

describe("AuthBroker — list-microsoft-accounts op", () => {
  it("returns stored accounts sorted by email with accountType, no tokens", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: { ziggy: {} } });
    seedMicrosoftAccount(h, "carol@contoso.com", {
      expiresAt: 3000,
      accountType: "work",
    });
    seedMicrosoftAccount(h, "alice@outlook.com", {
      expiresAt: 1000,
      accountType: "personal",
    });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "list-1",
      op: "list-microsoft-accounts",
    })) as { ok: true; data: { accounts: Array<Record<string, unknown>> } };

    expect(resp.ok).toBe(true);
    expect(resp.data.accounts.map((a) => a.account)).toEqual([
      "alice@outlook.com",
      "carol@contoso.com",
    ]);
    expect(resp.data.accounts[0].accountType).toBe("personal");
    expect(resp.data.accounts[1].accountType).toBe("work");
    for (const a of resp.data.accounts) {
      expect(a).not.toHaveProperty("refreshToken");
      expect(a).not.toHaveProperty("accessToken");
    }

    broker.stop();
  });

  it("returns an empty list when no Microsoft accounts are stored", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: { ziggy: {} } });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "list-2",
      op: "list-microsoft-accounts",
    })) as { ok: true; data: { accounts: unknown[] } };

    expect(resp.ok).toBe(true);
    expect(resp.data.accounts).toEqual([]);

    broker.stop();
  });
});

describe("AuthBroker — Microsoft refresh-tick", () => {
  it("refreshes a near-expiry account and preserves identity fields when the refresh omits id_token", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: {} });
    const aboutToExpire = Date.now() + 5 * 60 * 1000; // inside the 60-min threshold
    seedMicrosoftAccount(h, "lisa@outlook.com", {
      expiresAt: aboutToExpire,
      refreshToken: "rt-lisa",
      accountType: "work",
      tenantId: "contoso-tenant-id",
    });

    const { fetcher, calls } = makeOkFetcher({
      newAccessToken: "at-lisa-fresh",
      rotatedRefreshToken: "rt-lisa-rotated",
      withIdToken: false, // no id_token → must fall back to priorCredentials
    });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("login.microsoftonline.com/common/oauth2/v2.0/token");

    const onDisk = JSON.parse(
      readFileSync(microsoftAccountCredentialsPath(h.stateDir, "lisa@outlook.com"), "utf-8"),
    ) as MicrosoftCredentialsShape;
    expect(onDisk.microsoftOauth.accessToken).toBe("at-lisa-fresh");
    expect(onDisk.microsoftOauth.expiresAt).toBeGreaterThan(aboutToExpire);
    // RT rotated and persisted.
    expect(onDisk.microsoftOauth.refreshToken).toBe("rt-lisa-rotated");
    // Identity fields preserved from priorCredentials (no id_token in response).
    expect(onDisk.microsoftOauth.tenantId).toBe("contoso-tenant-id");
    expect(onDisk.microsoftOauth.accountType).toBe("work");

    broker.stop();
  });

  it("does NOT refresh when the token is comfortably valid (>1h remaining)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: {} });
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    seedMicrosoftAccount(h, "bob@outlook.com", { expiresAt: farFuture });

    const { fetcher, calls } = makeOkFetcher({});
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    expect(calls).toHaveLength(0);
    broker.stop();
  });

  it("does NOT touch on-disk credentials when Microsoft returns invalid_grant", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: {} });
    const originalExpiresAt = Date.now() + 5 * 60 * 1000;
    seedMicrosoftAccount(h, "dave@outlook.com", {
      expiresAt: originalExpiresAt,
      accessToken: "at-dave-original",
      refreshToken: "rt-dave-revoked",
    });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher: makeInvalidGrantFetcher(),
    });
    await broker.start();
    await broker._tick(); // must not throw

    const onDisk = JSON.parse(
      readFileSync(microsoftAccountCredentialsPath(h.stateDir, "dave@outlook.com"), "utf-8"),
    ) as MicrosoftCredentialsShape;
    expect(onDisk.microsoftOauth.accessToken).toBe("at-dave-original");
    expect(onDisk.microsoftOauth.refreshToken).toBe("rt-dave-revoked");
    expect(onDisk.microsoftOauth.expiresAt).toBe(originalExpiresAt);

    broker.stop();
  });

  it("is a no-op when microsoft_workspace config is absent (provider not registered)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { agents: {}, withProvider: false });
    seedMicrosoftAccount(h, "alice@outlook.com", {
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const { fetcher, calls } = makeOkFetcher({});
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    expect(calls).toHaveLength(0);
    broker.stop();
  });
});
