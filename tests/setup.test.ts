import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { createServer } from "node:net";
import { validateBotToken } from "../src/setup/telegram-api.js";
import {
  buildAccessJson,
  findExistingClaudeJson,
  copyOnboardingState,
  copyExistingCredentials,
} from "../src/setup/onboarding.js";
import {
  isPortFree,
  findFreePort,
  pickHindsightPorts,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
} from "../src/setup/hindsight.js";

// ─── validateBotToken ────────────────────────────────────────────────────────

describe("validateBotToken", () => {
  // Bun's vitest compat doesn't support vi.stubGlobal(). Assign the
  // mock directly on globalThis and restore the original after.
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
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
  it("should produce valid JSON with dmPolicy and groups", () => {
    const json = buildAccessJson("12345", "-100987654321");
    const parsed = JSON.parse(json);

    expect(parsed.dmPolicy).toBe("allowlist");
    expect(parsed.allowFrom).toEqual(["12345"]);
    expect(parsed.groups).toBeDefined();
    expect(parsed.groups["-100987654321"]).toBeDefined();
    expect(parsed.groups["-100987654321"].requireMention).toBe(false);
    expect(parsed.groups["-100987654321"].allowFrom).toEqual([]);
  });

  it("should produce consistent format regardless of topic_id", () => {
    const json = buildAccessJson("12345", "-100987654321", 42);
    const parsed = JSON.parse(json);

    // Topic ID is not needed in access.json — each bot only responds
    // to the group it's configured for
    expect(parsed.dmPolicy).toBe("allowlist");
    expect(parsed.groups["-100987654321"]).toBeDefined();
  });

  it("should not include topic_id (not needed for one-bot-per-agent)", () => {
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

    const destPath = join(agentDir, ".claude", ".claude.json");
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
      join(claudeDir, ".claude.json"),
      JSON.stringify({ source: "original" }),
    );

    copyOnboardingState(sourceFile, agentDir);

    const content = JSON.parse(
      readFileSync(join(claudeDir, ".claude.json"), "utf-8"),
    );
    expect(content.source).toBe("original");
  });

  it("should create .claude directory if missing", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(sourceFile, JSON.stringify({ test: true }));

    const agentDir = join(tempDir, "new-agent");
    // Don't create agentDir or .claude beforehand

    copyOnboardingState(sourceFile, agentDir);

    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(true);
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

// ─── Hindsight port detection ────────────────────────────────────────────────

/**
 * Open a TCP listener on 127.0.0.1:port and return the server so the test
 * can close it. Used to simulate "port already in use".
 */
function bindPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(port, "127.0.0.1");
  });
}

describe("isPortFree / findFreePort", () => {
  it("returns true for a free port", async () => {
    // Use a high port unlikely to be bound
    const free = await isPortFree(45123);
    expect(free).toBe(true);
  });

  it("returns false when something is listening on the port", async () => {
    const server = await bindPort(45124);
    try {
      const free = await isPortFree(45124);
      expect(free).toBe(false);
    } finally {
      server.close();
    }
  });

  it("findFreePort skips occupied ports and returns the next free one", async () => {
    const server = await bindPort(45125);
    try {
      const port = await findFreePort(45125, 5);
      expect(port).not.toBeNull();
      expect(port).toBeGreaterThan(45125);
    } finally {
      server.close();
    }
  });

  it("findFreePort returns null when all attempts are taken", async () => {
    // Bind a contiguous range of 3 ports
    const a = await bindPort(45200);
    const b = await bindPort(45201);
    const c = await bindPort(45202);
    try {
      const port = await findFreePort(45200, 3);
      expect(port).toBeNull();
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});

describe("pickHindsightPorts", () => {
  it("uses upstream defaults when both are free", async () => {
    // If something on the test host happens to be using 8888/9999, skip.
    const apiFree = await isPortFree(HINDSIGHT_DEFAULT_API_PORT);
    const uiFree = await isPortFree(HINDSIGHT_DEFAULT_UI_PORT);
    if (!apiFree || !uiFree) {
      // Test host has 8888/9999 occupied — skip the assertion that depends
      // on them being free, but the pickHindsightPorts call should still
      // succeed by falling back.
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).toBeGreaterThanOrEqual(1024);
      expect(ports.uiPort).toBeGreaterThanOrEqual(1024);
      return;
    }

    const ports = await pickHindsightPorts();
    expect(ports.apiPort).toBe(HINDSIGHT_DEFAULT_API_PORT);
    expect(ports.uiPort).toBe(HINDSIGHT_DEFAULT_UI_PORT);
  });

  it("falls back to alternative ports when 8888 is taken", async () => {
    const apiFree = await isPortFree(HINDSIGHT_DEFAULT_API_PORT);
    if (!apiFree) {
      // Already taken on this host; the fallback path is already exercised
      // by the test above. Skip the bind step.
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).not.toBe(HINDSIGHT_DEFAULT_API_PORT);
      return;
    }

    const blocker = await bindPort(HINDSIGHT_DEFAULT_API_PORT);
    try {
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).not.toBe(HINDSIGHT_DEFAULT_API_PORT);
      expect(ports.apiPort).toBeGreaterThanOrEqual(18888);
    } finally {
      blocker.close();
    }
  });
});
