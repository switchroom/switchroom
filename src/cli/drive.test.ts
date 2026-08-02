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
  GOOGLE_CALENDAR_READONLY_SCOPE,
  capabilitiesFromScopeString,
  resolveReconsentCapabilities,
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

  it("SECURITY: not_operator_verified cleans up, exits 1, and does not blame the broker", async () => {
    // #3598 provenance gate: waitForApproval refuses a granted-but-
    // agent-origin decision. The CLI must say so accurately rather than
    // reporting a generic broker fault, and must still fail closed.
    const { deps, exit, writes, errOut } = makeDeps({
      waitForApproval: vi.fn(
        async () =>
          ({ kind: "error", reason: "not_operator_verified" }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4); // EXIT_ERROR — fails closed
    expect(writes.deletes).toBe(1);
    const msg = errOut.join("\n");
    expect(msg).toContain("not operator-verified");
    expect(msg).toContain("SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE=1");
    expect(msg).not.toContain("Broker error");
  });

  it("other broker errors still report as a broker fault", async () => {
    const { deps, exit, errOut } = makeDeps({
      waitForApproval: vi.fn(
        async () =>
          ({ kind: "error", reason: "missing_decision" }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
    expect(errOut.join("\n")).toContain("Broker error: missing_decision");
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


// ── Calendar read-only, opt-in (gdrive list_calendars / get_events) ──────

describe("GOOGLE_CALENDAR_READONLY_SCOPE", () => {
  it("is the READ-ONLY calendar scope, never the read/write ones", () => {
    expect(GOOGLE_CALENDAR_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    // Guards against a careless "just drop .readonly" edit: the
    // read/write `calendar` and `calendar.events` scopes are deliberately
    // never offered by any switchroom code path.
    expect(GOOGLE_CALENDAR_READONLY_SCOPE).not.toBe(
      "https://www.googleapis.com/auth/calendar",
    );
    expect(GOOGLE_CALENDAR_READONLY_SCOPE).toMatch(/\.readonly$/);
  });
});

describe("selectGoogleWorkspaceScopes — --calendar is opt-in", () => {
  const cal = GOOGLE_CALENDAR_READONLY_SCOPE;

  // The full flag matrix, asserting the EXACT emitted scope set — not
  // just "contains", so an accidental extra scope fails too.
  const drive = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  ];
  const driveFile = "https://www.googleapis.com/auth/drive.file";
  const docs = [GOOGLE_DOCS_SCOPE, GOOGLE_SHEETS_SCOPE];

  it("write=false calendar=false → Drive read + Docs/Sheets only", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: false, calendar: false, tier: "core" }),
    ).toEqual([...drive, ...docs]);
  });

  it("write=false calendar=true → adds ONLY calendar.readonly", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: false, calendar: true, tier: "core" }),
    ).toEqual([...drive, ...docs, cal]);
  });

  it("write=true calendar=false → adds ONLY drive.file", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: true, calendar: false, tier: "core" }),
    ).toEqual([...drive, driveFile, ...docs]);
  });

  it("write=true calendar=true → both opt-ins, nothing else", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: true, calendar: true, tier: "core" }),
    ).toEqual([...drive, driveFile, ...docs, cal]);
  });

  it("omitting `calendar` behaves exactly as calendar:false (no silent widening)", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      for (const write of [false, true]) {
        expect(selectGoogleWorkspaceScopes({ write, tier })).toEqual(
          selectGoogleWorkspaceScopes({ write, calendar: false, tier }),
        );
      }
    }
  });

  it("NO tier grants calendar by default — the whole point of opt-in", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      for (const write of [false, true]) {
        expect(
          selectGoogleWorkspaceScopes({ write, calendar: false, tier }),
        ).not.toContain(cal);
      }
    }
  });

  it("--calendar never implies --write, and vice versa", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: false, calendar: true, tier: "complete" }),
    ).not.toContain(driveFile);
    expect(
      selectGoogleWorkspaceScopes({ write: true, calendar: false, tier: "complete" }),
    ).not.toContain(cal);
  });

  it("--calendar never pulls in a calendar WRITE scope", () => {
    const s = selectGoogleWorkspaceScopes({
      write: true,
      calendar: true,
      tier: "complete",
    });
    expect(s).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(s).not.toContain("https://www.googleapis.com/auth/calendar.events");
    expect(s.filter((x) => x.includes("calendar"))).toEqual([cal]);
  });

  it("emits no duplicates with every flag on", () => {
    const s = selectGoogleWorkspaceScopes({
      write: true,
      calendar: true,
      tier: "extended",
    });
    expect(new Set(s).size).toBe(s.length);
  });
});

describe("capabilitiesFromScopeString", () => {
  const cal = GOOGLE_CALENDAR_READONLY_SCOPE;
  const driveFile = "https://www.googleapis.com/auth/drive.file";

  it("reads both opt-ins off a real broker scope string", () => {
    expect(
      capabilitiesFromScopeString(
        `https://www.googleapis.com/auth/drive.readonly ${driveFile} ${cal}`,
      ),
    ).toEqual({ write: true, calendar: true });
  });

  it("read-only token → no capabilities", () => {
    expect(
      capabilitiesFromScopeString(
        "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents",
      ),
    ).toEqual({ write: false, calendar: false });
  });

  it("empty / whitespace scope string → no capabilities (no crash)", () => {
    expect(capabilitiesFromScopeString("")).toEqual({
      write: false,
      calendar: false,
    });
    expect(capabilitiesFromScopeString("   \n  ")).toEqual({
      write: false,
      calendar: false,
    });
  });

  it("a calendar WRITE scope does not count as calendar read capability", () => {
    expect(
      capabilitiesFromScopeString("https://www.googleapis.com/auth/calendar"),
    ).toEqual({ write: false, calendar: false });
  });
});

describe("resolveReconsentCapabilities — no drop, no silent widening", () => {
  const cal = GOOGLE_CALENDAR_READONLY_SCOPE;
  const driveFile = "https://www.googleapis.com/auth/drive.file";
  const READ_ONLY = "https://www.googleapis.com/auth/drive.readonly";

  it("fresh account (no existing token) → flags used verbatim", () => {
    expect(
      resolveReconsentCapabilities({ write: false, calendar: true }),
    ).toEqual({
      effective: { write: false, calendar: true },
      carried: [],
      added: [],
    });
  });

  it("re-consent with --calendar keeps an existing write grant (no drop)", () => {
    // The regression this guards: `--replace --calendar` on a
    // write-capable account used to mint a token WITHOUT drive.file,
    // silently revoking doc creation that previously worked.
    const plan = resolveReconsentCapabilities(
      { write: false, calendar: true },
      capabilitiesFromScopeString(`${READ_ONLY} ${driveFile}`),
    );
    expect(plan.effective).toEqual({ write: true, calendar: true });
    expect(plan.carried).toEqual(["write"]);
    expect(plan.added).toEqual(["calendar"]);
  });

  it("carried capability reaches the emitted scope set, not just the plan", () => {
    // End-to-end on the two pure functions the CLI actually composes —
    // a plan that says "write" but a scope set that omits drive.file
    // would still ship the bug.
    const plan = resolveReconsentCapabilities(
      { write: false, calendar: true },
      capabilitiesFromScopeString(`${READ_ONLY} ${driveFile}`),
    );
    const scopes = selectGoogleWorkspaceScopes({
      write: plan.effective.write,
      calendar: plan.effective.calendar,
      tier: "core",
    });
    expect(scopes).toContain(driveFile);
    expect(scopes).toContain(cal);
  });

  it("re-consent with NO flags on a fully-capable token drops nothing", () => {
    const plan = resolveReconsentCapabilities(
      { write: false, calendar: false },
      capabilitiesFromScopeString(`${driveFile} ${cal}`),
    );
    expect(plan.effective).toEqual({ write: true, calendar: true });
    expect(plan.carried).toEqual(["write", "calendar"]);
    expect(plan.added).toEqual([]);
  });

  it("does NOT widen: a read-only token re-consented with no flags stays read-only", () => {
    const plan = resolveReconsentCapabilities(
      { write: false, calendar: false },
      capabilitiesFromScopeString(READ_ONLY),
    );
    expect(plan.effective).toEqual({ write: false, calendar: false });
    expect(plan.carried).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(
      selectGoogleWorkspaceScopes({ ...plan.effective, tier: "complete" }),
    ).not.toContain(cal);
  });

  it("does NOT widen: --calendar on a read-only token adds calendar only", () => {
    const plan = resolveReconsentCapabilities(
      { write: false, calendar: true },
      capabilitiesFromScopeString(READ_ONLY),
    );
    expect(plan.effective).toEqual({ write: false, calendar: true });
    expect(plan.added).toEqual(["calendar"]);
    expect(
      selectGoogleWorkspaceScopes({ ...plan.effective, tier: "core" }),
    ).not.toContain(driveFile);
  });

  it("re-requesting a capability already held is not reported as added", () => {
    // `added` drives the "you need --replace" error; an operator who
    // re-passes a flag they already hold must not be told to re-consent.
    const plan = resolveReconsentCapabilities(
      { write: true, calendar: true },
      capabilitiesFromScopeString(`${driveFile} ${cal}`),
    );
    expect(plan.added).toEqual([]);
    expect(plan.carried).toEqual([]);
  });
});
