import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  getAuthStatus,
  formatTimeUntilExpiry,
  loginAgent,
  refreshAgent,
  parseSetupTokenUrl,
  parseSetupTokenValue,
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
