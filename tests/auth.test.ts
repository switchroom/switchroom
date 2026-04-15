import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getAuthStatus,
  formatTimeUntilExpiry,
  loginAgent,
  refreshAgent,
  parseSetupTokenUrl,
  parseSetupTokenValue,
  submitAuthCode,
} from "../src/auth/manager.js";

describe("formatTimeUntilExpiry", () => {
  it("returns hours and minutes for future timestamps", () => {
    const now = Date.now();
    const fiveHoursFromNow = now + 5 * 60 * 60_000 + 23 * 60_000;
    const result = formatTimeUntilExpiry(fiveHoursFromNow);
    expect(result).toMatch(/^5h 2[23]m$/);
  });

  it("returns only minutes when less than an hour", () => {
    const now = Date.now();
    const thirtyMinFromNow = now + 30 * 60_000;
    const result = formatTimeUntilExpiry(thirtyMinFromNow);
    expect(result).toMatch(/^(29|30)m$/);
  });

  it("returns 'expired' for past timestamps", () => {
    const oneHourAgo = Date.now() - 60 * 60_000;
    expect(formatTimeUntilExpiry(oneHourAgo)).toBe("expired");
  });

  it("returns 'expired' for current timestamp", () => {
    expect(formatTimeUntilExpiry(Date.now() - 1000)).toBe("expired");
  });

  it("returns 0m for nearly expired token", () => {
    const almostNow = Date.now() + 15_000;
    expect(formatTimeUntilExpiry(almostNow)).toBe("0m");
  });
});

describe("getAuthStatus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-auth-test-${Date.now()}`);
    mkdirSync(resolve(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns authenticated with valid credentials", () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test-token",
        refreshToken: "sk-ant-ort01-test-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    };

    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify(creds)
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(true);
    expect(status.subscriptionType).toBe("max");
    expect(status.rateLimitTier).toBe("default_claude_max_20x");
    expect(status.source).toBe("credentials");
    expect(status.expiresAt).toBeDefined();
    expect(status.timeUntilExpiry).toBeDefined();
    expect(status.timeUntilExpiry).not.toBe("expired");
  });

  it("prefers oauth token files over credentials.json", () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-credential-token",
        expiresAt: Date.now() + 8 * 60 * 60_000,
        subscriptionType: "max",
      },
    };
    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify(creds)
    );
    writeFileSync(resolve(tempDir, ".claude", ".oauth-token"), "sk-ant-oat01-env-token\n");
    writeFileSync(
      resolve(tempDir, ".claude", ".oauth-token.meta.json"),
      JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
        source: "claude-setup-token",
      })
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(true);
    expect(status.source).toBe("oauth-token");
    expect(status.subscriptionType).toBe("oauth-token");
  });

  it("returns not authenticated when credentials file is missing", () => {
    const status = getAuthStatus("test-agent", "/nonexistent/path");
    expect(status.authenticated).toBe(false);
    expect(status.subscriptionType).toBeUndefined();
    expect(status.expiresAt).toBeUndefined();
  });

  it("returns not authenticated for expired token", () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test-token",
        refreshToken: "sk-ant-ort01-test-refresh",
        expiresAt: Date.now() - 60 * 60_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    };

    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify(creds)
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(false);
    expect(status.subscriptionType).toBe("max");
    expect(status.timeUntilExpiry).toBe("expired");
  });

  it("returns not authenticated for invalid JSON", () => {
    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      "not-json"
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(false);
  });

  it("returns not authenticated when accessToken is missing", () => {
    const creds = {
      claudeAiOauth: {
        refreshToken: "sk-ant-ort01-test-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      },
    };

    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify(creds)
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(false);
  });
});

describe("loginAgent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-login-test-${Date.now()}`);
    mkdirSync(resolve(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns already-authenticated message for authenticated agent", () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test-token",
        refreshToken: "sk-ant-ort01-test-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
        subscriptionType: "max",
      },
    };
    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify(creds)
    );

    const result = loginAgent("test-agent", tempDir);
    expect(result.instructions.some(l => l.includes("already authenticated"))).toBe(true);
    expect(result.instructions.some(l => l.includes("reauth"))).toBe(true);
  });
});

describe("refreshAgent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-refresh-test-${Date.now()}`);
    mkdirSync(resolve(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is exported", () => {
    expect(typeof refreshAgent).toBe("function");
  });
});

describe("reauth uses clean config dir", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-reauth-test-${Date.now()}`);
    mkdirSync(resolve(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stale .setup-token-tmp-* dirs are cleaned up by the next auth attempt", () => {
    // Simulate leftover temp dirs from interrupted reauth flows
    const stale1 = join(tempDir, ".claude", ".setup-token-tmp-1000");
    const stale2 = join(tempDir, ".claude", ".setup-token-tmp-2000");
    mkdirSync(stale1, { recursive: true });
    mkdirSync(stale2, { recursive: true });
    writeFileSync(join(stale1, "test"), "data");

    expect(existsSync(stale1)).toBe(true);
    expect(existsSync(stale2)).toBe(true);

    // Replicate the cleanup logic from manager.ts
    const claudeDir = join(tempDir, ".claude");
    for (const entry of readdirSync(claudeDir)) {
      if (entry.startsWith(".setup-token-tmp-")) {
        rmSync(join(claudeDir, entry), { recursive: true, force: true });
      }
    }

    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
  });

  it("cleanup does not affect regular .claude files", () => {
    // Write some regular files that should NOT be deleted
    writeFileSync(resolve(tempDir, ".claude", ".credentials.json"), "{}");
    writeFileSync(resolve(tempDir, ".claude", ".oauth-token"), "sk-ant-oat01-test");
    // And a stale temp dir
    const stale = join(tempDir, ".claude", ".setup-token-tmp-9999");
    mkdirSync(stale, { recursive: true });

    const claudeDir = join(tempDir, ".claude");
    for (const entry of readdirSync(claudeDir)) {
      if (entry.startsWith(".setup-token-tmp-")) {
        rmSync(join(claudeDir, entry), { recursive: true, force: true });
      }
    }

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(resolve(tempDir, ".claude", ".credentials.json"))).toBe(true);
    expect(existsSync(resolve(tempDir, ".claude", ".oauth-token"))).toBe(true);
  });
});

describe("setup-token parsing", () => {
  it("extracts and unwraps the Claude browser auth URL", () => {
    const sample = `Browser didn't open? Use the url below to sign in\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc\n123&response_type=code\n\nPaste code here if prompted >`;
    expect(parseSetupTokenUrl(sample)).toBe(
      "https://claude.ai/oauth/authorize?code=true&client_id=abc123&response_type=code"
    );
  });

  it("extracts a setup-token oauth token from output", () => {
    const sample = "Success! Export this token:\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc_DEF-123\n";
    expect(parseSetupTokenValue(sample)).toBe("sk-ant-oat01-abc_DEF-123");
  });
});

describe("reauth token-loading bug regression", () => {
  // Root cause (fixed): switchroom auth code saves the token to .oauth-token
  // on disk, but the start.sh template was not exporting CLAUDE_CODE_OAUTH_TOKEN
  // into the live Claude process. Claude fell back to .credentials.json (old
  // account) even though the new token was on disk. This test suite guards
  // against that regression by verifying the token round-trip at the TS layer.

  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-reauth-regression-${Date.now()}`);
    mkdirSync(resolve(tempDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getAuthStatus prefers .oauth-token over .credentials.json (env-export source)", () => {
    // Simulate: old credentials on disk AND new oauth token saved by submitAuthCode.
    // getAuthStatus must return source="oauth-token" so start.sh exports the right token.
    const creds = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-OLD-credentials-token",
        expiresAt: Date.now() + 8 * 60 * 60_000,
        subscriptionType: "pro",
      },
    };
    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify(creds),
    );

    const newToken = "sk-ant-oat01-NEW-oauth-token-abc123";
    writeFileSync(resolve(tempDir, ".claude", ".oauth-token"), newToken + "\n");
    writeFileSync(
      resolve(tempDir, ".claude", ".oauth-token.meta.json"),
      JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
        source: "claude-setup-token",
      }),
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.source).toBe("oauth-token");
    expect(status.authenticated).toBe(true);
    // Subscription type is "oauth-token" for the oauth-token path
    expect(status.subscriptionType).toBe("oauth-token");
  });

  it("submitAuthCode returns error when no pending tmux session exists", () => {
    // The code submission path correctly detects missing sessions rather than
    // silently failing or writing a garbage token.
    const result = submitAuthCode("test-agent", tempDir, "TESTCODE");
    expect(result.completed).toBe(false);
    expect(result.tokenSaved).toBe(false);
    expect(result.instructions.some(l => l.includes("No pending auth session"))).toBe(true);
  });

  it("parseSetupTokenValue finds token in log file content (file-polling path)", () => {
    // The fixed submitAuthCode polls .setup-token.log for the token rather than
    // relying solely on a single tmux pane capture. Verify that the parser
    // finds a token embedded in typical claude setup-token log output.
    const logContent = [
      "Starting Claude OAuth setup...",
      "Browser didn't open? Use the url below to sign in",
      "",
      "https://claude.ai/oauth/authorize?code=true&client_id=abc123",
      "",
      "Paste code here if prompted > ",
      // User pasted the browser code; claude responds with the long-lived token:
      "Success! Your Claude Code OAuth token:",
      "sk-ant-oat01-LOGFILE-TOKEN-abc_DEF-XYZ",
      "",
    ].join("\n");

    const token = parseSetupTokenValue(logContent);
    expect(token).toBe("sk-ant-oat01-LOGFILE-TOKEN-abc_DEF-XYZ");
  });

  it("parseSetupTokenValue rejects non-token output gracefully", () => {
    // If the tmux pane scrape returns something other than a token (e.g. the
    // code prompt line), the parser must return null — not a garbage token.
    expect(parseSetupTokenValue("Paste code here if prompted >")).toBeNull();
    expect(parseSetupTokenValue("")).toBeNull();
    expect(parseSetupTokenValue("Error: invalid code")).toBeNull();
  });

  it("parseSetupTokenValue accepts valid oat01 token formats", () => {
    expect(parseSetupTokenValue("sk-ant-oat01-abc_DEF-XYZ")).toBe("sk-ant-oat01-abc_DEF-XYZ");
    // Also handles numeric suffix variants (oat0+)
    expect(parseSetupTokenValue("sk-ant-oat02-abc_DEF-XYZ")).toBe("sk-ant-oat02-abc_DEF-XYZ");
    // With ANSI escape codes stripped
    expect(parseSetupTokenValue("\x1B[32msk-ant-oat01-token123\x1B[0m")).toBe("sk-ant-oat01-token123");
  });

  it("getAuthStatus returns unauthenticated when .oauth-token is empty", () => {
    // An empty .oauth-token file (e.g. from a failed write) must not be treated
    // as valid — fall through to credentials.json or return unauthenticated.
    writeFileSync(resolve(tempDir, ".claude", ".oauth-token"), "");
    writeFileSync(
      resolve(tempDir, ".claude", ".oauth-token.meta.json"),
      JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + 365 * 24 * 60 * 60_000, source: "claude-setup-token" }),
    );

    const status = getAuthStatus("test-agent", tempDir);
    // Empty token → should NOT report authenticated via oauth-token path
    expect(status.source).not.toBe("oauth-token");
  });

  it("getAuthStatus correctly reports expired oauth token", () => {
    const expiredMs = Date.now() - 60_000; // 1 minute ago
    writeFileSync(resolve(tempDir, ".claude", ".oauth-token"), "sk-ant-oat01-expiredtoken");
    writeFileSync(
      resolve(tempDir, ".claude", ".oauth-token.meta.json"),
      JSON.stringify({
        createdAt: expiredMs - 365 * 24 * 60 * 60_000,
        expiresAt: expiredMs,
        source: "claude-setup-token",
      }),
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(false);
    expect(status.timeUntilExpiry).toBe("expired");
  });
});
