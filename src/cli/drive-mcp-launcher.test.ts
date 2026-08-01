/**
 * Pure-core tests for `drive-mcp-launcher` (RFC G).
 *
 * Covers the unit-testable seams the launcher factors out: the seed-JSON
 * builder, the email→filename encoder (Python `quote(...,safe="@._-")`
 * semantics), the uvx-args assembler, and the child-env scrubber. The
 * I/O shell (broker calls, fs, exec) is intentionally NOT exercised here
 * — it's a thin wrapper around these pure functions.
 */

import { describe, expect, it } from "vitest";

import {
  AIOFILE_PIN,
  AIOFILE_PKG,
  buildChildEnv,
  buildMissingScopeWarning,
  buildSeedCredentials,
  buildUvxArgs,
  encodeCredentialsFilename,
  classifyRootSchema,
  findMissingWorkspaceScopes,
  requiredWorkspaceScopesForTier,
  resolveCredentialsDir,
  seedOptInCapabilities,
  CALENDAR_READONLY_SCOPE,
  sanitizeToolsListMessage,
} from "./drive-mcp-launcher.js";
import {
  GOOGLE_CALENDAR_READONLY_SCOPE,
  workspaceScopesForTier,
} from "./drive.js";
import { GOOGLE_WORKSPACE_MCP_PINNED_SHA } from "../memory/scaffold-integration.js";

describe("buildSeedCredentials — exact upstream shape", () => {
  it("produces the exact JSON shape with token + expiry null", () => {
    const seed = buildSeedCredentials({
      refreshToken: "1//rt-abc",
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret",
      scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents",
    });
    expect(seed).toEqual({
      token: null,
      refresh_token: "1//rt-abc",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "GOCSPX-secret",
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
      ],
      expiry: null,
    });
    // token/expiry MUST be literal null (the browserless trigger).
    expect(seed.token).toBeNull();
    expect(seed.expiry).toBeNull();
  });

  it("splits the scope string on whitespace and drops empties", () => {
    const seed = buildSeedCredentials({
      refreshToken: "rt",
      clientId: "cid",
      clientSecret: "sec",
      scope: "  scope.a   scope.b\tscope.c  ",
    });
    expect(seed.scopes).toEqual(["scope.a", "scope.b", "scope.c"]);
  });

  it("throws on an empty/whitespace scope string (fail loud, never seed scopeless)", () => {
    // A scopeless seed starts upstream with zero Drive scopes — every
    // tool call 403s downstream. Consistent with the other required-
    // field guards; the broker should never return an empty scope.
    expect(() =>
      buildSeedCredentials({
        refreshToken: "rt",
        clientId: "cid",
        clientSecret: "sec",
        scope: "",
      }),
    ).toThrow(/scope is required/);
    expect(() =>
      buildSeedCredentials({
        refreshToken: "rt",
        clientId: "cid",
        clientSecret: "sec",
        scope: "   \t  ",
      }),
    ).toThrow(/scope is required/);
  });

  it("injects the client secret verbatim (not from the broker schema)", () => {
    const seed = buildSeedCredentials({
      refreshToken: "rt",
      clientId: "cid",
      clientSecret: "GOCSPX-from-vault-ref",
      scope: "s",
    });
    expect(seed.client_secret).toBe("GOCSPX-from-vault-ref");
  });

  it.each([
    ["refreshToken", { refreshToken: "", clientId: "c", clientSecret: "s", scope: "x" }],
    ["clientId", { refreshToken: "r", clientId: "", clientSecret: "s", scope: "x" }],
    ["clientSecret", { refreshToken: "r", clientId: "c", clientSecret: "", scope: "x" }],
  ])("throws when %s is missing (fail loud, never seed bad creds)", (_label, input) => {
    expect(() => buildSeedCredentials(input)).toThrow();
  });
});

describe("encodeCredentialsFilename — Python quote(email, safe=\"@._-\")", () => {
  it("leaves you@example.com untouched → you@example.com.json", () => {
    expect(encodeCredentialsFilename("you@example.com")).toBe(
      "you@example.com.json",
    );
  });

  it("keeps the explicitly-safe chars @ . _ - unescaped", () => {
    expect(encodeCredentialsFilename("a.b_c-d@e.f")).toBe("a.b_c-d@e.f.json");
  });

  it("percent-encodes a char that needs escaping, uppercase %XX", () => {
    // '+' is NOT in safe="@._-" and NOT unreserved → %2B (uppercase).
    expect(encodeCredentialsFilename("user+tag@gmail.com")).toBe(
      "user%2Btag@gmail.com.json",
    );
  });

  it("encodes space as %20 (quote, not quote_plus → not '+')", () => {
    expect(encodeCredentialsFilename("a b@x.com")).toBe("a%20b@x.com.json");
  });

  it("percent-encodes non-ASCII over UTF-8 bytes", () => {
    // 'é' = U+00E9 → UTF-8 0xC3 0xA9 → %C3%A9
    expect(encodeCredentialsFilename("é@x.com")).toBe("%C3%A9@x.com.json");
  });
});

describe("buildUvxArgs — pinned upstream + --single-user", () => {
  it("includes the shared pinned SHA and --single-user, no tier by default", () => {
    const args = buildUvxArgs();
    expect(args).toEqual([
      "--from",
      `git+https://github.com/taylorwilsdon/google_workspace_mcp.git@${GOOGLE_WORKSPACE_MCP_PINNED_SHA}`,
      // `--refresh-package aiofile` is load-bearing: AIOFILE_PIN tracks
      // a freshly-released upstream fix; without forcing uv to re-fetch
      // aiofile's index, an agent whose uv cache predates the release
      // resolves "no version of aiofile==<pin>" and the MCP never
      // starts (reproduced in-container). Targeted (not a blanket
      // --refresh) so the upstream git clone / dep tree stay cached.
      "--refresh-package",
      AIOFILE_PKG,
      // `--with aiofile==<pin>` is load-bearing: the modern
      // fastmcp→aiofile import chain raised `KeyError: 'Author'` until
      // aiofile PR #106 (>=3.10.1). Must sit BEFORE the entrypoint
      // positional (it's a uvx option).
      "--with",
      AIOFILE_PIN,
      // MUST be `workspace-mcp` — the upstream package provides only
      // `workspace-mcp` and `workspace-cli`. The original
      // `google-workspace-mcp` made uvx exit "executable not provided
      // by package workspace-mcp" (verified in-container). This is the
      // assertion that previously encoded the bug.
      "workspace-mcp",
      "--single-user",
    ]);
    expect(args).not.toContain("google-workspace-mcp");
    // Regression guard for the aiofile landmine — order matters
    // (uvx options precede the entrypoint).
    expect(args.indexOf("--with")).toBeLessThan(args.indexOf("workspace-mcp"));
    expect(
      args.indexOf("--refresh-package"),
    ).toBeLessThan(args.indexOf("workspace-mcp"));
    expect(args).toContain(AIOFILE_PIN);
    expect(args).toContain(AIOFILE_PKG);
  });

  // Floor guard (research rec #2): aiofile's `KeyError: 'Author'` was
  // fixed in commit c27fdc7e8, first released in 3.10.1. Pinning BELOW
  // that re-introduces the import crash. This fails CI on a careless
  // downgrade into the buggy range, independent of any in-container
  // smoke test.
  it("AIOFILE_PIN is at or above the first fixed release (>= 3.10.1)", () => {
    const m = AIOFILE_PIN.match(/^aiofile==(\d+)\.(\d+)\.(\d+)$/);
    expect(m, `AIOFILE_PIN must be an exact aiofile==X.Y.Z pin, got "${AIOFILE_PIN}"`).not.toBeNull();
    const [maj, min, pat] = (m as RegExpMatchArray).slice(1).map(Number);
    // >= 3.10.1
    const atLeast =
      maj > 3 ||
      (maj === 3 && min > 10) ||
      (maj === 3 && min === 10 && pat >= 1);
    expect(
      atLeast,
      `aiofile ${maj}.${min}.${pat} is below the first KeyError-fixed release 3.10.1 (aiofile PR #106 / commit c27fdc7e8)`,
    ).toBe(true);
    expect(AIOFILE_PKG).toBe("aiofile");
  });

  it("appends --tool-tier <tier> after --single-user when a tier is given", () => {
    const args = buildUvxArgs("extended");
    expect(args.slice(-2)).toEqual(["--tool-tier", "extended"]);
    expect(args).toContain("--single-user");
  });

  it("emits no --tool-tier for an empty tier string", () => {
    expect(buildUvxArgs("")).not.toContain("--tool-tier");
  });
});

describe("buildChildEnv — strips --single-user-incompatible knobs", () => {
  it("sets WORKSPACE_MCP_CREDENTIALS_DIR and deletes the incompatible env", () => {
    const env = buildChildEnv(
      {
        PATH: "/usr/bin",
        MCP_ENABLE_OAUTH21: "1",
        WORKSPACE_MCP_STATELESS_MODE: "1",
        GOOGLE_APPLICATION_CREDENTIALS: "/sa.json",
        WORKSPACE_MCP_SERVICE_ACCOUNT_FILE: "/sa2.json",
      },
      "/state/agent/google-workspace-mcp/credentials",
      "you@example.com",
    );
    expect(env.WORKSPACE_MCP_CREDENTIALS_DIR).toBe(
      "/state/agent/google-workspace-mcp/credentials",
    );
    expect(env.MCP_ENABLE_OAUTH21).toBeUndefined();
    expect(env.WORKSPACE_MCP_STATELESS_MODE).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.WORKSPACE_MCP_SERVICE_ACCOUNT_FILE).toBeUndefined();
    // Unrelated env is preserved.
    expect(env.PATH).toBe("/usr/bin");
  });

  it("pins USER_GOOGLE_EMAIL to the seeded account (single-user identity)", () => {
    // Load-bearing: upstream single-user refuses to fall back to the
    // seed when the agent's per-call user_google_email doesn't match;
    // USER_GOOGLE_EMAIL makes core.server treat this address as THE
    // single user. MUST equal the value writeSeedFile used.
    const env = buildChildEnv({}, "/tmp/c", "you@example.com");
    expect(env.USER_GOOGLE_EMAIL).toBe("you@example.com");
  });

  it("overrides any inherited USER_GOOGLE_EMAIL with the seeded account", () => {
    const env = buildChildEnv(
      { USER_GOOGLE_EMAIL: "stale@example.com" },
      "/tmp/c",
      "you@example.com",
    );
    expect(env.USER_GOOGLE_EMAIL).toBe("you@example.com");
  });

  it("does not mutate the passed-in base env object", () => {
    const base = { MCP_ENABLE_OAUTH21: "1" };
    buildChildEnv(base, "/tmp/c", "you@example.com");
    expect(base.MCP_ENABLE_OAUTH21).toBe("1");
  });

  it("moves WORKSPACE_MCP_PORT off 8000 to neutralize the doomed fallback (#1663)", () => {
    const env = buildChildEnv({}, "/tmp/c", "you@example.com");
    expect(env.WORKSPACE_MCP_PORT).toBe("8631");
    expect(env.WORKSPACE_MCP_PORT).not.toBe("8000");
  });

  it("honours SWITCHROOM_GDRIVE_MCP_PORT override", () => {
    const env = buildChildEnv(
      { SWITCHROOM_GDRIVE_MCP_PORT: "9123" },
      "/tmp/c",
      "you@example.com",
    );
    expect(env.WORKSPACE_MCP_PORT).toBe("9123");
  });

  it("does not clobber an explicitly-set WORKSPACE_MCP_PORT", () => {
    const env = buildChildEnv(
      { WORKSPACE_MCP_PORT: "8042" },
      "/tmp/c",
      "you@example.com",
    );
    expect(env.WORKSPACE_MCP_PORT).toBe("8042");
  });
});

describe("requiredWorkspaceScopesForTier — stays in sync with drive.ts (#1663)", () => {
  it("matches workspaceScopesForTier for every tier", () => {
    for (const tier of ["core", "extended", "complete"] as const) {
      expect(requiredWorkspaceScopesForTier(tier)).toEqual(
        workspaceScopesForTier(tier),
      );
    }
  });

  it("undefined tier behaves as core", () => {
    expect(requiredWorkspaceScopesForTier(undefined)).toEqual(
      workspaceScopesForTier("core"),
    );
  });
});

describe("findMissingWorkspaceScopes — scope↔tier preflight (#1663)", () => {
  const DOCS = "https://www.googleapis.com/auth/documents";
  const SHEETS = "https://www.googleapis.com/auth/spreadsheets";
  const SLIDES = "https://www.googleapis.com/auth/presentations";

  it("seed with all core scopes → nothing missing for core", () => {
    const seed = `https://www.googleapis.com/auth/drive.readonly ${DOCS} ${SHEETS}`;
    expect(findMissingWorkspaceScopes(seed, "core")).toEqual([]);
  });

  it("Drive-only seed (pre-#1663 token) → core flags Docs + Sheets missing", () => {
    const seed = "https://www.googleapis.com/auth/drive.readonly";
    expect(findMissingWorkspaceScopes(seed, "core")).toEqual([DOCS, SHEETS]);
  });

  it("core-scoped seed on an extended tier → flags Slides missing", () => {
    const seed = `${DOCS} ${SHEETS}`;
    expect(findMissingWorkspaceScopes(seed, "extended")).toEqual([SLIDES]);
  });

  it("full extended seed → nothing missing for extended", () => {
    const seed = `${DOCS} ${SHEETS} ${SLIDES}`;
    expect(findMissingWorkspaceScopes(seed, "extended")).toEqual([]);
  });

  it("empty seed scope string → all tier scopes missing", () => {
    expect(findMissingWorkspaceScopes("", "extended")).toEqual([
      DOCS,
      SHEETS,
      SLIDES,
    ]);
  });
});

describe("seedOptInCapabilities — opt-in flags read off the seed token", () => {
  const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
  const CAL = "https://www.googleapis.com/auth/calendar.readonly";

  it("mirrors GOOGLE_CALENDAR_READONLY_SCOPE from drive.ts (no drift)", () => {
    expect(CALENDAR_READONLY_SCOPE).toBe(GOOGLE_CALENDAR_READONLY_SCOPE);
  });

  it("read-only Drive seed → neither capability", () => {
    expect(
      seedOptInCapabilities("https://www.googleapis.com/auth/drive.readonly"),
    ).toEqual({ write: false, calendar: false });
  });

  it("detects drive.file and calendar.readonly independently", () => {
    expect(seedOptInCapabilities(DRIVE_FILE)).toEqual({
      write: true,
      calendar: false,
    });
    expect(seedOptInCapabilities(CAL)).toEqual({
      write: false,
      calendar: true,
    });
    expect(seedOptInCapabilities(`${DRIVE_FILE} ${CAL}`)).toEqual({
      write: true,
      calendar: true,
    });
  });

  it("does NOT treat a Calendar WRITE scope as calendar read capability", () => {
    // switchroom never mints these; if one ever appears the warning must
    // not print `--calendar` as though it round-trips (it wouldn't).
    expect(
      seedOptInCapabilities("https://www.googleapis.com/auth/calendar"),
    ).toEqual({ write: false, calendar: false });
  });
});

describe("buildMissingScopeWarning — actionable re-mint guidance (#1663)", () => {
  const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
  const CAL = "https://www.googleapis.com/auth/calendar.readonly";
  const PRESENTATIONS = "https://www.googleapis.com/auth/presentations";
  const NONE = { write: false, calendar: false };

  it("names the account, the tier, and the exact recovery command", () => {
    const msg = buildMissingScopeWarning(
      [PRESENTATIONS],
      "extended",
      "you@example.com",
      NONE,
    );
    expect(msg).toContain("you@example.com");
    expect(msg).toContain("extended");
    expect(msg).toContain("presentations");
    expect(msg).toContain(
      "switchroom auth google account add you@example.com --replace",
    );
  });

  it("appends --write when the EXISTING token already carries drive.file", () => {
    // findMissingWorkspaceScopes never returns drive.file — the --write
    // suffix must be driven by the existing token's scopes, not by the
    // missing set. A write-capable token's recovery command MUST keep
    // --write or running it verbatim silently downgrades to read-only.
    const missing = findMissingWorkspaceScopes(DRIVE_FILE, "core");
    expect(missing).toEqual([
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
    expect(missing).not.toContain(DRIVE_FILE);
    const msg = buildMissingScopeWarning(
      missing,
      "core",
      "a@b.com",
      seedOptInCapabilities(DRIVE_FILE),
    );
    expect(msg).toContain("--replace --write");
  });

  it("omits --write when the existing token has no drive.file scope", () => {
    // A read-only token: the recovery command must NOT add --write, so
    // the re-minted token stays read-only and capability isn't widened
    // beyond what the operator originally consented to.
    const missing = findMissingWorkspaceScopes("", "core");
    const msg = buildMissingScopeWarning(missing, "core", "a@b.com", NONE);
    expect(msg).toContain("--replace\n");
    expect(msg).not.toContain("--write");
  });

  it("appends --calendar when the EXISTING token already carries calendar.readonly", () => {
    // Same downgrade hazard as --write: calendar.readonly is never in
    // `missing` (no tier requires it), so running the printed command
    // without --calendar would silently revoke Calendar read.
    const missing = findMissingWorkspaceScopes(CAL, "core");
    expect(missing).not.toContain(CAL);
    const msg = buildMissingScopeWarning(
      missing,
      "core",
      "a@b.com",
      seedOptInCapabilities(CAL),
    );
    expect(msg).toContain("--replace --calendar");
    expect(msg).toContain("Calendar read capability");
  });

  it("omits --calendar for a token without the calendar scope", () => {
    const missing = findMissingWorkspaceScopes(DRIVE_FILE, "core");
    const msg = buildMissingScopeWarning(
      missing,
      "core",
      "a@b.com",
      seedOptInCapabilities(DRIVE_FILE),
    );
    expect(msg).not.toContain("--calendar");
  });

  it("carries BOTH opt-ins forward, in flag order", () => {
    const msg = buildMissingScopeWarning(
      [PRESENTATIONS],
      "extended",
      "a@b.com",
      seedOptInCapabilities(`${DRIVE_FILE} ${CAL}`),
    );
    expect(msg).toContain("--replace --write --calendar");
  });
});

describe("classifyRootSchema — drop unless root is {type:\"object\",...}", () => {
  it("returns ok for a well-formed {type:object, properties:...} schema", () => {
    expect(
      classifyRootSchema({ type: "object", properties: { foo: { type: "string" } } }),
    ).toBe("ok");
  });

  it("returns drop for a root anyOf schema (no wrap — see docstring)", () => {
    expect(
      classifyRootSchema({ anyOf: [{ type: "string" }, { type: "null" }] }),
    ).toBe("drop");
  });

  it("returns drop for a root oneOf schema", () => {
    expect(
      classifyRootSchema({ oneOf: [{ type: "string" }, { type: "integer" }] }),
    ).toBe("drop");
  });

  it("returns drop for a root allOf schema", () => {
    expect(
      classifyRootSchema({ allOf: [{ type: "object" }, { properties: {} }] }),
    ).toBe("drop");
  });

  it("returns drop for null / undefined / non-object schemas", () => {
    expect(classifyRootSchema(null)).toBe("drop");
    expect(classifyRootSchema(undefined)).toBe("drop");
    expect(classifyRootSchema("string")).toBe("drop");
    expect(classifyRootSchema(42)).toBe("drop");
    expect(classifyRootSchema([])).toBe("drop");
  });

  it("does NOT recurse — a top-level object with nested anyOf is ok", () => {
    // Nested anyOf inside properties.<x> is fine — Anthropic's
    // validator only rejects ROOT-level anyOf/oneOf/allOf.
    expect(
      classifyRootSchema({
        type: "object",
        properties: { foo: { anyOf: [{ type: "string" }, { type: "null" }] } },
      }),
    ).toBe("ok");
  });
});

describe("sanitizeToolsListMessage — drops tools with bad root schemas", () => {
  it("keeps good tools untouched and drops tools with root anyOf", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "good_tool",
            inputSchema: { type: "object", properties: { x: { type: "string" } } },
          },
          {
            name: "bad_tool",
            inputSchema: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        ],
      },
    };
    const drops: { name: string; reason: string }[] = [];
    const out = sanitizeToolsListMessage(msg, (name, reason) =>
      drops.push({ name, reason }),
    ) as typeof msg;
    expect(out.result.tools.length).toBe(1);
    expect(out.result.tools[0].name).toBe("good_tool");
    expect(out.result.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
    expect(drops.length).toBe(1);
    expect(drops[0].name).toBe("bad_tool");
    expect(drops[0].reason).toMatch(/anyOf\/oneOf\/allOf/);
  });

  it("drops a tool with missing inputSchema (logged accordingly)", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "no_schema" }] },
    };
    const drops: string[] = [];
    const out = sanitizeToolsListMessage(msg, (n) => drops.push(n)) as typeof msg;
    expect(out.result.tools).toEqual([]);
    expect(drops).toEqual(["no_schema"]);
  });

  it("passes through messages that are not tools/list responses", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: {} };
    expect(sanitizeToolsListMessage(msg, () => {})).toEqual(msg);
  });
});

describe("resolveCredentialsDir — per-agent, env override honoured", () => {
  it("honours an explicit WORKSPACE_MCP_CREDENTIALS_DIR", () => {
    expect(
      resolveCredentialsDir({ WORKSPACE_MCP_CREDENTIALS_DIR: "/custom/dir" }),
    ).toBe("/custom/dir");
  });

  it("defaults under /state/agent inside a container (per-agent, UID-owned)", () => {
    expect(resolveCredentialsDir({ SWITCHROOM_CONTAINER: "1" })).toBe(
      "/state/agent/google-workspace-mcp/credentials",
    );
  });

  it("falls back to HOME outside a container", () => {
    expect(resolveCredentialsDir({ HOME: "/home/dev" })).toBe(
      "/home/dev/google-workspace-mcp/credentials",
    );
  });
});
