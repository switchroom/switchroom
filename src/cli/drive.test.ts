/**
 * Tests for `switchroom drive connect / disconnect`.
 *
 * The CLI runner is exercised through the `__test` exports so we can drive
 * the result-state machine without spawning a child process. All network and
 * vault I/O is faked through dependency injection on `DriveCliDeps`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mutable config seam so individual tests can swap in `drive:` blocks.
const configMock = {
  current: {
    switchroom: { version: 1 },
    telegram: { bot_token: "x", forum_chat_id: "1" },
    agents: { klanker: {} },
    vault: { path: "~/.switchroom/vault.enc" },
  } as Record<string, unknown>,
};

vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn(() => configMock.current),
  resolvePath: (p: string) => p.replace(/^~/, "/tmp"),
  findConfigFile: () => "/tmp/switchroom.yaml",
  ConfigError: class ConfigError extends Error {},
}));

// Vault-secret resolver seam: tests opt in by populating this map and
// configuring drive.google_client_id = 'vault:<key>'.
const vaultMock = {
  secrets: {} as Record<string, { kind: string; value: string } | null>,
};
vi.mock("../vault/vault.js", () => ({
  getSecret: vi.fn((_pp: string, _vp: string, key: string) =>
    vaultMock.secrets[key] ?? null,
  ),
}));

import {
  __test,
  selectDriveAccountScopes,
  selectGoogleWorkspaceScopes,
  workspaceScopesForTier,
  DRIVE_READONLY_SCOPES,
  DRIVE_WRITE_SCOPES,
  GOOGLE_DOCS_SCOPE,
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_SLIDES_SCOPE,
  type DriveCliDeps,
} from "./drive.js";
import type { WaitForApprovalResult } from "../vault/approvals/wait.js";
import type { TokenResponse } from "../drive/oauth.js";

const VALID_TOKENS: TokenResponse = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 3600,
  token_type: "Bearer",
};

interface CapturedExit {
  code: number | null;
}

function makeDeps(overrides: Partial<DriveCliDeps> = {}): {
  deps: DriveCliDeps;
  exit: CapturedExit;
  out: string[];
  errOut: string[];
  writes: { token: number; status: number; deletes: number };
} {
  const exit: CapturedExit = { code: null };
  const out: string[] = [];
  const errOut: string[] = [];
  const writes = { token: 0, status: 0, deletes: 0 };

  const deps: DriveCliDeps = {
    runOAuth: vi.fn(async () => VALID_TOKENS),
    waitForApproval: vi.fn(
      async () =>
        ({
          kind: "decided",
          state: "granted",
          decision: {} as never,
          request_id: "r1",
        }) as WaitForApprovalResult,
    ),
    writeRefreshToken: vi.fn(() => {
      writes.token++;
    }),
    readRefreshToken: vi.fn(() => null),
    writeStatus: vi.fn(() => {
      writes.status++;
    }),
    deleteSlots: vi.fn(() => {
      writes.deletes++;
    }),
    getPassphrase: vi.fn(async () => "pp"),
    exit: (c: number) => {
      exit.code = c;
    },
    log: (...a: unknown[]) => out.push(a.map(String).join(" ")),
    err: (...a: unknown[]) => errOut.push(a.map(String).join(" ")),
    ...overrides,
  };
  return { deps, exit, out, errOut, writes };
}

describe("drive connect", () => {
  beforeEach(() => {
    process.env.SWITCHROOM_GOOGLE_CLIENT_ID = "cid";
    process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET = "csec";
    process.env.SWITCHROOM_APPROVER_USER_ID = "42";
    configMock.current = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      agents: { klanker: {} },
      vault: { path: "~/.switchroom/vault.enc" },
    };
    vaultMock.secrets = {};
  });

  it("granted: writes vault slots and exits 0", async () => {
    const { deps, exit, writes } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(writes.token).toBe(1);
    expect(writes.status).toBe(1);
    expect(writes.deletes).toBe(0);
  });

  it("denied: cleans up vault slots and exits 1", async () => {
    const { deps, exit, writes } = makeDeps({
      waitForApproval: vi.fn(
        async () =>
          ({
            kind: "decided",
            state: "denied",
            decision: {} as never,
            request_id: "r1",
          }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(1);
    expect(writes.token).toBe(1); // initial write happens before wait
    expect(writes.deletes).toBe(1); // cleanup
  });

  it("timeout: cleans up and exits 2", async () => {
    const { deps, exit, writes } = makeDeps({
      waitForApproval: vi.fn(
        async () => ({ kind: "timeout", request_id: "r1" }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(2);
    expect(writes.deletes).toBe(1);
  });

  it("aborted via SIGINT: cleans up and exits 130", async () => {
    const ac = new AbortController();
    const { deps, exit, writes } = makeDeps({
      abortSignal: ac.signal,
      waitForApproval: vi.fn(
        async () => ({ kind: "aborted", request_id: "r1" }) as WaitForApprovalResult,
      ),
    });
    ac.abort();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(130);
    expect(writes.deletes).toBe(1);
  });

  it("rate_limited: preserves vault slot and exits 3", async () => {
    const { deps, exit, writes } = makeDeps({
      waitForApproval: vi.fn(
        async () =>
          ({ kind: "rate_limited", retry_after_ms: 5000 }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(3);
    expect(writes.token).toBe(1); // OAuth completed, write happened
    expect(writes.deletes).toBe(0); // but the slot was preserved for retry
  });

  it("existing refresh_token skips OAuth and re-fires approval", async () => {
    const { deps, exit, writes } = makeDeps({
      readRefreshToken: vi.fn(() => "existing-rt"),
    });
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(oauthSpy).not.toHaveBeenCalled();
    expect(writes.token).toBe(0); // already there, no fresh write
    expect(writes.status).toBe(0);
  });

  it("OAuth failure: exits 4 and does NOT call deleter", async () => {
    const { deps, exit, writes } = makeDeps({
      runOAuth: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
    expect(writes.token).toBe(0);
    expect(writes.deletes).toBe(0); // nothing was written, nothing to clean
  });

  it("waitForApproval throws AbortError: exits 130 (defensive)", async () => {
    const ac = new AbortController();
    const { deps, exit, writes } = makeDeps({
      abortSignal: ac.signal,
      waitForApproval: vi.fn(async () => {
        const e = new Error("Aborted");
        e.name = "AbortError";
        throw e;
      }),
    });
    ac.abort();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(130);
    expect(writes.deletes).toBe(1);
  });

  it("non-numeric --approver: exits 4 without OAuth", async () => {
    const { deps, exit } = makeDeps();
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    await __test.runConnect({ agentName: "klanker", approver: "ken" }, deps);
    expect(exit.code).toBe(4);
    expect(oauthSpy).not.toHaveBeenCalled();
  });

  it("unknown agent: exits 4 without OAuth", async () => {
    const { deps, exit } = makeDeps();
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    await __test.runConnect({ agentName: "ghost" }, deps);
    expect(exit.code).toBe(4);
    expect(oauthSpy).not.toHaveBeenCalled();
  });

  it("missing client id: exits 4", async () => {
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
    const { deps, exit } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
  });

  // ─── drive: config block ────────────────────────────────────────────────
  // Precedence is env > config: env vars exist for one-off override (CI,
  // emergency rotation) and back-compat with the env-only flow shipped in
  // #766. Config is the persistent baseline.

  it("config: reads google_client_id/secret from drive: block when env is unset", async () => {
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET;
    delete process.env.SWITCHROOM_APPROVER_USER_ID;
    configMock.current = {
      ...configMock.current,
      drive: {
        google_client_id: "cfg-id",
        google_client_secret: "cfg-secret",
        approvers: [42],
      },
    };
    const { deps, exit, writes } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(writes.token).toBe(1);
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    const cfgArg = oauthSpy.mock.calls[0]?.[0] as { client_id: string; client_secret: string };
    expect(cfgArg.client_id).toBe("cfg-id");
    expect(cfgArg.client_secret).toBe("cfg-secret");
  });

  it("config: env wins over config (precedence: env > config)", async () => {
    process.env.SWITCHROOM_GOOGLE_CLIENT_ID = "env-id";
    process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET = "env-secret";
    configMock.current = {
      ...configMock.current,
      drive: {
        google_client_id: "cfg-id",
        google_client_secret: "cfg-secret",
        approvers: [42],
      },
    };
    const { deps, exit } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    const cfgArg = oauthSpy.mock.calls[0]?.[0] as { client_id: string; client_secret: string };
    expect(cfgArg.client_id).toBe("env-id");
    expect(cfgArg.client_secret).toBe("env-secret");
  });

  it("config: vault: refs in google_client_id/secret are resolved", async () => {
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET;
    vaultMock.secrets = {
      "google-oauth-client-id": { kind: "string", value: "resolved-id" },
      "google-oauth-client-secret": { kind: "string", value: "resolved-secret" },
    };
    configMock.current = {
      ...configMock.current,
      drive: {
        google_client_id: "vault:google-oauth-client-id",
        google_client_secret: "vault:google-oauth-client-secret",
        approvers: [42],
      },
    };
    const { deps, exit } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    const cfgArg = oauthSpy.mock.calls[0]?.[0] as { client_id: string; client_secret: string };
    expect(cfgArg.client_id).toBe("resolved-id");
    expect(cfgArg.client_secret).toBe("resolved-secret");
  });

  it("config: missing vault entry referenced by drive.google_client_id exits 4", async () => {
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET;
    configMock.current = {
      ...configMock.current,
      drive: {
        google_client_id: "vault:nope",
        google_client_secret: "raw",
        approvers: [42],
      },
    };
    const { deps, exit, errOut } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
    expect(errOut.join("\n")).toMatch(/vault key 'nope'/);
  });

  it("config: per-agent drive.approvers wins over top-level drive.approvers", async () => {
    delete process.env.SWITCHROOM_APPROVER_USER_ID;
    configMock.current = {
      ...configMock.current,
      agents: { klanker: { drive: { approvers: [777] } } },
      drive: {
        google_client_id: "id",
        google_client_secret: "secret",
        approvers: [42],
      },
    };
    const { deps, exit } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    const waitSpy = deps.waitForApproval as ReturnType<typeof vi.fn>;
    const callArg = waitSpy.mock.calls[0]?.[0] as { approver_set: string[] };
    expect(callArg.approver_set).toEqual(["user:777"]);
  });

  it("config: top-level drive.approvers used when no env, no flag, no per-agent override", async () => {
    delete process.env.SWITCHROOM_APPROVER_USER_ID;
    configMock.current = {
      ...configMock.current,
      drive: {
        google_client_id: "id",
        google_client_secret: "secret",
        approvers: [42],
      },
    };
    const { deps, exit } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    const waitSpy = deps.waitForApproval as ReturnType<typeof vi.fn>;
    const callArg = waitSpy.mock.calls[0]?.[0] as { approver_set: string[] };
    expect(callArg.approver_set).toEqual(["user:42"]);
  });

  it("missing all sources (env + config): exits 4 with helpful message naming both", async () => {
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET;
    delete process.env.SWITCHROOM_APPROVER_USER_ID;
    const { deps, exit, errOut } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
    const blob = errOut.join("\n");
    expect(blob).toMatch(/switchroom\.yaml/);
    expect(blob).toMatch(/SWITCHROOM_GOOGLE_CLIENT_ID/);
  });

  it("missing approver across all sources: exits 4 naming both options", async () => {
    delete process.env.SWITCHROOM_APPROVER_USER_ID;
    // client id/secret still come from env; only approver is missing.
    const { deps, exit, errOut } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
    const blob = errOut.join("\n");
    expect(blob).toMatch(/drive\.approvers/);
    expect(blob).toMatch(/SWITCHROOM_APPROVER_USER_ID/);
    expect(blob).toMatch(/--approver/);
  });
});

describe("drive disconnect", () => {
  it("happy path: local + Google ok, exit 0", async () => {
    const { deps, exit, out } = makeDeps({
      disconnectDrive: vi.fn(async () => ({
        agent_unit: "klanker",
        local_revoked: true,
        google_revoke: "ok" as const,
      })),
    });
    await __test.runDisconnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(out.join("\n")).toMatch(/klanker/);
    expect(out.join("\n")).toMatch(/Google revoke: .*ok/);
  });

  it("Google revoke failed: still exit 0, surface in stdout", async () => {
    const { deps, exit, out } = makeDeps({
      disconnectDrive: vi.fn(async () => ({
        agent_unit: "klanker",
        local_revoked: true,
        google_revoke: "failed" as const,
        google_revoke_detail: "503: upstream",
      })),
    });
    await __test.runDisconnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(out.join("\n")).toMatch(/failed:503/);
  });

  it("unknown agent: exit 4", async () => {
    const { deps, exit } = makeDeps();
    await __test.runDisconnect({ agentName: "ghost" }, deps);
    expect(exit.code).toBe(4);
  });
});

describe("selectDriveAccountScopes", () => {
  it("defaults to read-only — a read grant never silently becomes write", () => {
    const s = selectDriveAccountScopes(false);
    expect(s).toEqual(DRIVE_READONLY_SCOPES);
    expect(s).not.toContain("https://www.googleapis.com/auth/drive.file");
  });

  it("write=true adds drive.file (least-privilege) and keeps read scopes", () => {
    const s = selectDriveAccountScopes(true);
    expect(s).toEqual(DRIVE_WRITE_SCOPES);
    expect(s).toContain("https://www.googleapis.com/auth/drive.file");
    // Read scopes retained so the browse+read collab loop still works.
    expect(s).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(s).toContain(
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    );
    // Least-privilege: NOT the full read/write `drive` scope.
    expect(s).not.toContain("https://www.googleapis.com/auth/drive");
  });
});

describe("workspaceScopesForTier (issue #1663)", () => {
  it("core → Docs + Sheets (core already exposes those tools)", () => {
    const s = workspaceScopesForTier("core");
    expect(s).toEqual([GOOGLE_DOCS_SCOPE, GOOGLE_SHEETS_SCOPE]);
    expect(s).not.toContain(GOOGLE_SLIDES_SCOPE);
  });

  it("extended → adds Slides (first tier exposing Slides tools)", () => {
    const s = workspaceScopesForTier("extended");
    expect(s).toContain(GOOGLE_DOCS_SCOPE);
    expect(s).toContain(GOOGLE_SHEETS_SCOPE);
    expect(s).toContain(GOOGLE_SLIDES_SCOPE);
  });

  it("complete → also includes Slides", () => {
    expect(workspaceScopesForTier("complete")).toContain(GOOGLE_SLIDES_SCOPE);
  });

  it("does NOT add calendar/gmail scopes (deferred per #1663)", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      const s = workspaceScopesForTier(tier);
      expect(s.some((x) => x.includes("calendar"))).toBe(false);
      expect(s.some((x) => x.includes("gmail"))).toBe(false);
    }
  });
});

describe("selectGoogleWorkspaceScopes (issue #1663)", () => {
  it("core read-only: Drive read + Docs + Sheets, no Slides, no drive.file", () => {
    const s = selectGoogleWorkspaceScopes({ write: false, tier: "core" });
    expect(s).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(s).toContain(GOOGLE_DOCS_SCOPE);
    expect(s).toContain(GOOGLE_SHEETS_SCOPE);
    expect(s).not.toContain(GOOGLE_SLIDES_SCOPE);
    expect(s).not.toContain("https://www.googleapis.com/auth/drive.file");
  });

  it("extended write: Drive read + drive.file + Docs + Sheets + Slides", () => {
    const s = selectGoogleWorkspaceScopes({ write: true, tier: "extended" });
    expect(s).toContain("https://www.googleapis.com/auth/drive.file");
    expect(s).toContain(GOOGLE_DOCS_SCOPE);
    expect(s).toContain(GOOGLE_SHEETS_SCOPE);
    expect(s).toContain(GOOGLE_SLIDES_SCOPE);
  });

  it("undefined tier defaults to core (matches schema default)", () => {
    const s = selectGoogleWorkspaceScopes({ write: false });
    expect(s).toEqual(selectGoogleWorkspaceScopes({ write: false, tier: "core" }));
  });

  it("produces no duplicate scopes", () => {
    const s = selectGoogleWorkspaceScopes({ write: true, tier: "complete" });
    expect(new Set(s).size).toBe(s.length);
  });

  it("never requests the full read/write `drive` scope (least-privilege)", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      const s = selectGoogleWorkspaceScopes({ write: true, tier });
      expect(s).not.toContain("https://www.googleapis.com/auth/drive");
    }
  });
});
