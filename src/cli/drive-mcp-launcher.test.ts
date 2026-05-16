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
  buildChildEnv,
  buildSeedCredentials,
  buildUvxArgs,
  encodeCredentialsFilename,
  resolveCredentialsDir,
} from "./drive-mcp-launcher.js";
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

  it("yields an empty scopes array for an empty scope string", () => {
    const seed = buildSeedCredentials({
      refreshToken: "rt",
      clientId: "cid",
      clientSecret: "sec",
      scope: "",
    });
    expect(seed.scopes).toEqual([]);
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
  it("leaves pixsoul@gmail.com untouched → pixsoul@gmail.com.json", () => {
    expect(encodeCredentialsFilename("pixsoul@gmail.com")).toBe(
      "pixsoul@gmail.com.json",
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
      // `--with aiofile==3.8.8` is load-bearing, not optional: without
      // it the modern fastmcp→key_value→aiofile import chain crashes
      // with `KeyError: 'Author'` and the MCP never starts (verified
      // in-container; ==1.20.4 and latest PyPI crash identically). Must
      // sit BEFORE the entrypoint positional (it's a uvx option).
      "--with",
      "aiofile==3.8.8",
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
    expect(args).toContain("aiofile==3.8.8");
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
      "pixsoul@gmail.com",
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
    const env = buildChildEnv({}, "/tmp/c", "pixsoul@gmail.com");
    expect(env.USER_GOOGLE_EMAIL).toBe("pixsoul@gmail.com");
  });

  it("overrides any inherited USER_GOOGLE_EMAIL with the seeded account", () => {
    const env = buildChildEnv(
      { USER_GOOGLE_EMAIL: "stale@example.com" },
      "/tmp/c",
      "pixsoul@gmail.com",
    );
    expect(env.USER_GOOGLE_EMAIL).toBe("pixsoul@gmail.com");
  });

  it("does not mutate the passed-in base env object", () => {
    const base = { MCP_ENABLE_OAUTH21: "1" };
    buildChildEnv(base, "/tmp/c", "pixsoul@gmail.com");
    expect(base.MCP_ENABLE_OAUTH21).toBe("1");
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
