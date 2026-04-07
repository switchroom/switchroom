import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { validateBotToken } from "../src/setup/telegram-api.js";
import {
  buildAccessJson,
  findExistingClaudeJson,
  copyOnboardingState,
  copyExistingCredentials,
} from "../src/setup/onboarding.js";

// ─── validateBotToken ────────────────────────────────────────────────────────

describe("validateBotToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return bot info on valid token", async () => {
    const mockResponse = {
      ok: true,
      result: {
        id: 123456,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      },
    };

    (fetch as any).mockResolvedValue({
      json: async () => mockResponse,
    });

    const result = await validateBotToken("fake-token");

    expect(result).toEqual({
      id: 123456,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botfake-token/getMe",
    );
  });

  it("should throw on invalid token", async () => {
    const mockResponse = {
      ok: false,
      description: "Unauthorized",
    };

    (fetch as any).mockResolvedValue({
      json: async () => mockResponse,
    });

    await expect(validateBotToken("bad-token")).rejects.toThrow(
      "Invalid bot token: Unauthorized",
    );
  });

  it("should throw on network error", async () => {
    (fetch as any).mockRejectedValue(new Error("Network failure"));

    await expect(validateBotToken("any-token")).rejects.toThrow(
      "Network error validating bot token: Network failure",
    );
  });
});

// ─── buildAccessJson ─────────────────────────────────────────────────────────

describe("buildAccessJson", () => {
  it("should produce valid JSON with user and chat IDs", () => {
    const json = buildAccessJson("12345", "-100987654321");
    const parsed = JSON.parse(json);

    expect(parsed.forum_chat_id).toBe("-100987654321");
    expect(parsed.allowed_users).toEqual([12345]);
    expect(parsed.allowFrom).toContain(-100987654321);
    expect(parsed.allowFrom).toContain(12345);
  });

  it("should include topic_id when provided", () => {
    const json = buildAccessJson("12345", "-100987654321", 42);
    const parsed = JSON.parse(json);

    expect(parsed.topic_id).toBe(42);
  });

  it("should not include topic_id when not provided", () => {
    const json = buildAccessJson("12345", "-100987654321");
    const parsed = JSON.parse(json);

    expect(parsed).not.toHaveProperty("topic_id");
  });
});

// ─── findExistingClaudeJson ──────────────────────────────────────────────────

describe("findExistingClaudeJson", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), "clerk-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should find .claude.json in .claude-home/", () => {
    const claudeHomeDir = join(tempDir, ".claude-home");
    mkdirSync(claudeHomeDir, { recursive: true });
    writeFileSync(
      join(claudeHomeDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(claudeHomeDir, ".claude.json"));
  });

  it("should find .claude.json in .claude/", () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(claudeDir, ".claude.json"));
  });

  it("should prefer .claude-home/ over .claude/", () => {
    const claudeHomeDir = join(tempDir, ".claude-home");
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeHomeDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeHomeDir, ".claude.json"),
      JSON.stringify({ source: "claude-home" }),
    );
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ source: "claude" }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(claudeHomeDir, ".claude.json"));
  });

  it("should return null when nothing exists", () => {
    const result = findExistingClaudeJson();
    expect(result).toBeNull();
  });
});

// ─── copyOnboardingState ─────────────────────────────────────────────────────

describe("copyOnboardingState", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "clerk-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should copy config.json to agent .claude dir", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(
      sourceFile,
      JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }),
    );

    const agentDir = join(tempDir, "agent-test");
    mkdirSync(agentDir, { recursive: true });

    copyOnboardingState(sourceFile, agentDir);

    const destPath = join(agentDir, ".claude", "config.json");
    expect(existsSync(destPath)).toBe(true);

    const content = JSON.parse(readFileSync(destPath, "utf-8"));
    expect(content.hasCompletedOnboarding).toBe(true);
    expect(content.numStartups).toBe(5);
  });

  it("should not overwrite existing config.json", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(sourceFile, JSON.stringify({ source: "new" }));

    const agentDir = join(tempDir, "agent-test");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "config.json"),
      JSON.stringify({ source: "original" }),
    );

    copyOnboardingState(sourceFile, agentDir);

    const content = JSON.parse(
      readFileSync(join(claudeDir, "config.json"), "utf-8"),
    );
    expect(content.source).toBe("original");
  });

  it("should create .claude directory if missing", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(sourceFile, JSON.stringify({ test: true }));

    const agentDir = join(tempDir, "new-agent");
    // Don't create agentDir or .claude beforehand

    copyOnboardingState(sourceFile, agentDir);

    expect(existsSync(join(agentDir, ".claude", "config.json"))).toBe(true);
  });
});

// ─── copyExistingCredentials ─────────────────────────────────────────────────

describe("copyExistingCredentials", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), "clerk-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should copy credentials from .claude-home/", () => {
    const claudeHomeDir = join(tempDir, ".claude-home");
    mkdirSync(claudeHomeDir, { recursive: true });
    writeFileSync(
      join(claudeHomeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "test" } }),
    );

    const agentDir = join(tempDir, "agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = copyExistingCredentials(agentDir);
    expect(result).toBe(true);
    expect(
      existsSync(join(agentDir, ".claude", ".credentials.json")),
    ).toBe(true);
  });

  it("should return false when no credentials exist", () => {
    const agentDir = join(tempDir, "agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = copyExistingCredentials(agentDir);
    expect(result).toBe(false);
  });

  it("should return true if credentials already exist in agent dir", () => {
    const agentDir = join(tempDir, "agent-test");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({ existing: true }),
    );

    const result = copyExistingCredentials(agentDir);
    expect(result).toBe(true);
  });
});
