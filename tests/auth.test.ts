import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { getAuthStatus, formatTimeUntilExpiry } from "../src/auth/manager.js";

describe("formatTimeUntilExpiry", () => {
  it("returns hours and minutes for future timestamps", () => {
    const fiveHoursFromNow = Date.now() + 5 * 60 * 60_000 + 23 * 60_000;
    expect(formatTimeUntilExpiry(fiveHoursFromNow)).toBe("5h 23m");
  });

  it("returns only minutes when less than an hour", () => {
    const thirtyMinFromNow = Date.now() + 30 * 60_000;
    expect(formatTimeUntilExpiry(thirtyMinFromNow)).toBe("30m");
  });

  it("returns 'expired' for past timestamps", () => {
    const oneHourAgo = Date.now() - 60 * 60_000;
    expect(formatTimeUntilExpiry(oneHourAgo)).toBe("expired");
  });

  it("returns 'expired' for current timestamp", () => {
    // Slightly in the past to avoid race
    expect(formatTimeUntilExpiry(Date.now() - 1)).toBe("expired");
  });

  it("returns 0m for nearly expired token", () => {
    const almostNow = Date.now() + 15_000; // 15 seconds
    expect(formatTimeUntilExpiry(almostNow)).toBe("0m");
  });
});

describe("getAuthStatus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `clerk-auth-test-${Date.now()}`);
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
        expiresAt: Date.now() + 8 * 60 * 60_000, // 8 hours from now
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
    expect(status.expiresAt).toBeDefined();
    expect(status.timeUntilExpiry).toBeDefined();
    expect(status.timeUntilExpiry).not.toBe("expired");
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
        expiresAt: Date.now() - 60 * 60_000, // 1 hour ago
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

  it("returns not authenticated when claudeAiOauth key is absent", () => {
    writeFileSync(
      resolve(tempDir, ".claude", ".credentials.json"),
      JSON.stringify({ someOtherKey: {} })
    );

    const status = getAuthStatus("test-agent", tempDir);
    expect(status.authenticated).toBe(false);
  });
});
