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
  GOOGLE_DOCS_READONLY_SCOPE,
  GOOGLE_SHEETS_READONLY_SCOPE,
  GOOGLE_SLIDES_READONLY_SCOPE,
  GOOGLE_SERVICES,
  parseServicesOption,
  tierDefaultServices,
  scopesForSelection,
  resolveScopeSelection,
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

// ── v1 per-account READ-ONLY scope selection ─────────────────────────────

const DRIVE_RO = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const CAL_RO = GOOGLE_CALENDAR_READONLY_SCOPE;

describe("read-only Workspace scope constants", () => {
  it("every readonly constant ends in .readonly and is not a write scope", () => {
    for (const s of [
      GOOGLE_DOCS_READONLY_SCOPE,
      GOOGLE_SHEETS_READONLY_SCOPE,
      GOOGLE_SLIDES_READONLY_SCOPE,
    ]) {
      expect(s).toMatch(/\.readonly$/);
    }
    expect(GOOGLE_DOCS_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/documents.readonly",
    );
    expect(GOOGLE_SHEETS_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    );
    expect(GOOGLE_SLIDES_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/presentations.readonly",
    );
  });
});

describe("parseServicesOption", () => {
  it("parses, de-dups, and canonicalizes order", () => {
    expect(parseServicesOption("cal,drive,cal")).toEqual(["drive", "cal"]);
    expect(parseServicesOption("slides, docs")).toEqual(["docs", "slides"]);
  });

  it("accepts 'calendar' as an alias for 'cal'", () => {
    expect(parseServicesOption("calendar")).toEqual(["cal"]);
  });

  it("rejects an unknown service naming the full vocabulary", () => {
    expect(() => parseServicesOption("gmail")).toThrow(/unknown service 'gmail'/);
    expect(() => parseServicesOption("gmail")).toThrow(/cal, drive, docs, sheets, slides|drive, docs, sheets, slides, cal/);
  });

  it("rejects an empty list", () => {
    expect(() => parseServicesOption(" , ")).toThrow(/at least one service/);
  });
});

describe("tierDefaultServices", () => {
  it("core → drive,docs,sheets; extended/complete add slides; cal NEVER default", () => {
    expect(tierDefaultServices("core")).toEqual(["drive", "docs", "sheets"]);
    expect(tierDefaultServices("extended")).toEqual([
      "drive",
      "docs",
      "sheets",
      "slides",
    ]);
    expect(tierDefaultServices("complete")).toEqual([
      "drive",
      "docs",
      "sheets",
      "slides",
    ]);
    for (const tier of ["core", "extended", "complete"] as const) {
      expect(tierDefaultServices(tier)).not.toContain("cal");
    }
  });
});

describe("scopesForSelection — the readonly-aware service→scope map", () => {
  it("readonly=true mints ZERO write scopes (exact set, full selection)", () => {
    expect(
      scopesForSelection({
        readonly: true,
        driveWrite: false,
        services: ["drive", "docs", "sheets", "slides", "cal"],
      }),
    ).toEqual([
      ...DRIVE_RO,
      GOOGLE_DOCS_READONLY_SCOPE,
      GOOGLE_SHEETS_READONLY_SCOPE,
      GOOGLE_SLIDES_READONLY_SCOPE,
      CAL_RO,
    ]);
  });

  it("readonly=true ignores driveWrite — drive.file cannot leak into a read-only grant", () => {
    const s = scopesForSelection({
      readonly: true,
      driveWrite: true,
      services: ["drive", "docs"],
    });
    expect(s).toEqual([...DRIVE_RO, GOOGLE_DOCS_READONLY_SCOPE]);
    expect(s).not.toContain(DRIVE_FILE);
  });

  it("readonly=false default selection reproduces today's scopes exactly", () => {
    expect(
      scopesForSelection({
        readonly: false,
        driveWrite: false,
        services: ["drive", "docs", "sheets"],
      }),
    ).toEqual([...DRIVE_RO, GOOGLE_DOCS_SCOPE, GOOGLE_SHEETS_SCOPE]);
  });

  it("cal alone mints ONLY calendar.readonly", () => {
    expect(
      scopesForSelection({ readonly: false, driveWrite: false, services: ["cal"] }),
    ).toEqual([CAL_RO]);
    // Even asking for write mints nothing extra — cal has no write scope.
    expect(
      scopesForSelection({ readonly: false, driveWrite: true, services: ["cal"] }),
    ).toEqual([CAL_RO]);
  });

  it("no readonly selection ever contains a write scope, for every service subset", () => {
    const writeScopes = [
      DRIVE_FILE,
      GOOGLE_DOCS_SCOPE,
      GOOGLE_SHEETS_SCOPE,
      GOOGLE_SLIDES_SCOPE,
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ];
    // All 31 non-empty subsets of the 5 services.
    for (let mask = 1; mask < 1 << GOOGLE_SERVICES.length; mask++) {
      const services = GOOGLE_SERVICES.filter((_, i) => mask & (1 << i));
      const s = scopesForSelection({
        readonly: true,
        driveWrite: true,
        services,
      });
      for (const w of writeScopes) expect(s).not.toContain(w);
    }
  });
});

describe("selectGoogleWorkspaceScopes — readonly + services (v1)", () => {
  it("readonly + write is a hard error", () => {
    expect(() =>
      selectGoogleWorkspaceScopes({ write: true, readonly: true, tier: "core" }),
    ).toThrow(/mutually exclusive/);
  });

  it("services: ['cal'] mints ONLY calendar.readonly", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: false, services: ["cal"], tier: "core" }),
    ).toEqual([CAL_RO]);
  });

  it("readonly core default mints exactly the readonly variants", () => {
    expect(
      selectGoogleWorkspaceScopes({ write: false, readonly: true, tier: "core" }),
    ).toEqual([
      ...DRIVE_RO,
      GOOGLE_DOCS_READONLY_SCOPE,
      GOOGLE_SHEETS_READONLY_SCOPE,
    ]);
  });

  it("omitting readonly/services is byte-identical to the pre-v1 behaviour", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      for (const write of [false, true]) {
        for (const calendar of [false, true]) {
          expect(
            selectGoogleWorkspaceScopes({ write, calendar, tier }),
          ).toEqual(
            selectGoogleWorkspaceScopes({
              write,
              calendar,
              tier,
              readonly: false,
              services: calendar
                ? [...tierDefaultServices(tier), "cal"]
                : tierDefaultServices(tier),
            }),
          );
        }
      }
    }
  });

  it("input service order does not change the emitted set (canonical order)", () => {
    expect(
      selectGoogleWorkspaceScopes({
        write: false,
        services: ["cal", "sheets", "drive"],
        tier: "core",
      }),
    ).toEqual(
      selectGoogleWorkspaceScopes({
        write: false,
        services: ["drive", "sheets", "cal"],
        tier: "core",
      }),
    );
  });
});

describe("resolveScopeSelection — deterministic carry-forward (v1)", () => {
  const NONE = { write: false, calendar: false };
  const noFlags = {
    readonly: false,
    write: false,
    calendar: false,
    services: undefined,
  };

  it("readonly + write flags are a hard error", () => {
    expect(() =>
      resolveScopeSelection({
        flags: { ...noFlags, readonly: true, write: true },
        existing: NONE,
        tier: "core",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("fresh add, no flags → tier default selection, nothing persisted", () => {
    const plan = resolveScopeSelection({
      flags: noFlags,
      existing: NONE,
      tier: "core",
    });
    expect(plan.selection).toEqual({
      readonly: false,
      services: ["drive", "docs", "sheets"],
      driveWrite: false,
    });
    expect(plan.persist).toBeNull();
    expect(plan.dropped).toEqual([]);
  });

  it("--replace with NO flags re-reads the persisted selection and does NOT re-widen", () => {
    // The design's headline outcome: a read-only, service-narrowed
    // account re-consented for an unrelated reason keeps its exact
    // selection — the minted scope set carries zero write scopes.
    const plan = resolveScopeSelection({
      flags: noFlags,
      persisted: { readonly: true, services: ["drive", "cal"] },
      existing: NONE,
      tier: "extended", // tier bump must NOT re-widen the selection
      });
    expect(plan.selection).toEqual({
      readonly: true,
      services: ["drive", "cal"],
      driveWrite: false,
    });
    expect(plan.persist).toEqual({ readonly: true, services: ["drive", "cal"] });
    expect(scopesForSelection(plan.selection)).toEqual([...DRIVE_RO, CAL_RO]);
  });

  it("--readonly on a token that carries drive.file DROPS write, loudly", () => {
    const plan = resolveScopeSelection({
      flags: { ...noFlags, readonly: true },
      existing: { write: true, calendar: false },
      tier: "core",
    });
    expect(plan.selection.readonly).toBe(true);
    expect(plan.selection.driveWrite).toBe(false);
    expect(plan.dropped.some((d) => d.includes("drive.file"))).toBe(true);
    expect(scopesForSelection(plan.selection)).not.toContain(DRIVE_FILE);
  });

  it("--write on a persisted read-only record flips readonly off, loudly", () => {
    const plan = resolveScopeSelection({
      flags: { ...noFlags, write: true },
      persisted: { readonly: true, services: ["drive", "docs"] },
      existing: { write: true, calendar: false },
      tier: "core",
    });
    expect(plan.selection.readonly).toBe(false);
    expect(plan.selection.driveWrite).toBe(true);
    expect(plan.dropped.some((d) => d.includes("read-only"))).toBe(true);
  });

  it("explicit --services narrows and announces every dropped service", () => {
    const plan = resolveScopeSelection({
      flags: { ...noFlags, services: ["drive"] },
      persisted: { readonly: false, services: ["drive", "docs", "cal"] },
      existing: NONE,
      tier: "core",
    });
    expect(plan.selection.services).toEqual(["drive"]);
    expect(plan.dropped.some((d) => d.includes("'docs'"))).toBe(true);
    expect(plan.dropped.some((d) => d.includes("'cal'"))).toBe(true);
  });

  it("legacy token with calendar capability, no persisted record → cal carried, nothing persisted... unless flags say otherwise", () => {
    const plan = resolveScopeSelection({
      flags: noFlags,
      existing: { write: false, calendar: true },
      tier: "core",
    });
    expect(plan.selection.services).toEqual(["drive", "docs", "sheets", "cal"]);
    expect(plan.persist).toBeNull();
  });

  it("--calendar alongside explicit --services unions cal in (no drop notice)", () => {
    const plan = resolveScopeSelection({
      flags: { ...noFlags, calendar: true, services: ["drive"] },
      existing: NONE,
      tier: "core",
    });
    expect(plan.selection.services).toEqual(["drive", "cal"]);
    expect(plan.dropped.filter((d) => d.includes("'cal'"))).toEqual([]);
  });

  it("--services on a fresh add persists the selection", () => {
    const plan = resolveScopeSelection({
      flags: { ...noFlags, readonly: true, services: ["cal"] },
      existing: NONE,
      tier: "core",
    });
    expect(plan.selection).toEqual({
      readonly: true,
      services: ["cal"],
      driveWrite: false,
    });
    expect(plan.persist).toEqual({ readonly: true, services: ["cal"] });
  });

  it("nothing widens: no flags + no persisted + no existing capability never mints cal or drive.file", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      const plan = resolveScopeSelection({
        flags: noFlags,
        existing: NONE,
        tier,
      });
      const scopes = scopesForSelection(plan.selection);
      expect(scopes).not.toContain(CAL_RO);
      expect(scopes).not.toContain(DRIVE_FILE);
    }
  });
});

describe("GOOGLE_SERVICES ↔ GoogleServiceTokenSchema sync pin", () => {
  it("the config enum and the CLI vocabulary are the same set", async () => {
    const { GoogleServiceTokenSchema } = await import("../config/schema.js");
    expect([...GoogleServiceTokenSchema.options].sort()).toEqual(
      [...GOOGLE_SERVICES].sort(),
    );
  });
});
