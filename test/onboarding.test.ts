import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildAccessJson,
  saveUserConfig,
  loadUserConfig,
  preTrustWorkspace,
  createMinimalClaudeConfig,
  findExistingClaudeJson,
} from "../src/setup/onboarding.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-test-onboarding");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  cleanup();
});

// ─── buildAccessJson ────────────────────────────────────────────────────────

describe("buildAccessJson", () => {
  it("includes userId in allowFrom and groups allowFrom", () => {
    const json = buildAccessJson("123456", "-100999", 42);
    const parsed = JSON.parse(json);

    expect(parsed.dmPolicy).toBe("allowlist");
    expect(parsed.allowFrom).toEqual(["123456"]);
    expect(parsed.groups["-100999"].allowFrom).toEqual([]);
    expect(parsed.groups["-100999"].requireMention).toBe(false);
  });

  it("sets allowFrom with the provided userId", () => {
    const json = buildAccessJson("789", "-100111");
    const parsed = JSON.parse(json);

    expect(parsed.allowFrom).toEqual(["789"]);
  });
});

// ─── saveUserConfig / loadUserConfig ────────────────────────────────────────

describe("saveUserConfig / loadUserConfig", () => {
  const origHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = TEST_DIR;
  });

  afterEach(() => {
    process.env.HOME = origHome;
  });

  it("round-trips userId and username", () => {
    saveUserConfig("12345", "testuser");
    const config = loadUserConfig();

    expect(config).not.toBeNull();
    expect(config!.userId).toBe("12345");
    expect(config!.username).toBe("testuser");
  });

  it("saves without username", () => {
    saveUserConfig("99999");
    const config = loadUserConfig();

    expect(config).not.toBeNull();
    expect(config!.userId).toBe("99999");
    expect(config!.username).toBeUndefined();
  });

  it("returns null when no file exists", () => {
    const config = loadUserConfig();
    expect(config).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const switchroomDir = join(TEST_DIR, ".switchroom");
    mkdirSync(switchroomDir, { recursive: true });
    writeFileSync(join(switchroomDir, "user.json"), "not json", "utf-8");

    const config = loadUserConfig();
    expect(config).toBeNull();
  });
});

// ─── preTrustWorkspace ──────────────────────────────────────────────────────

describe("preTrustWorkspace", () => {
  it("adds the agent directory to projects with trust accepted", () => {
    const agentDir = join(TEST_DIR, "agent-a");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, numStartups: 1 }),
      "utf-8"
    );

    preTrustWorkspace(agentDir);

    const config = JSON.parse(readFileSync(join(claudeDir, ".claude.json"), "utf-8"));
    const absDir = resolve(agentDir);
    expect(config.projects).toBeDefined();
    expect(config.projects[absDir]).toBeDefined();
    expect(config.projects[absDir].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[absDir].allowedTools).toEqual([]);
  });

  it("does not overwrite existing project trust entry", () => {
    const agentDir = join(TEST_DIR, "agent-b");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const absDir = resolve(agentDir);
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [absDir]: { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } },
      }),
      "utf-8"
    );

    preTrustWorkspace(agentDir);

    const config = JSON.parse(readFileSync(join(claudeDir, ".claude.json"), "utf-8"));
    // Should preserve the existing entry with "Bash" tool
    expect(config.projects[absDir].allowedTools).toEqual(["Bash"]);
  });

  it("does nothing if config.json is missing", () => {
    const agentDir = join(TEST_DIR, "agent-c");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });

    // Should not throw
    preTrustWorkspace(agentDir);

    // No config.json should be created
    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(false);
  });
});

// ─── createMinimalClaudeConfig ──────────────────────────────────────────────

describe("createMinimalClaudeConfig", () => {
  it("creates a minimal config when none exists", () => {
    const agentDir = join(TEST_DIR, "agent-d");

    createMinimalClaudeConfig(agentDir);

    const configPath = join(agentDir, ".claude", ".claude.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.hasCompletedOnboarding).toBe(false);
    expect(config.numStartups).toBe(0);
  });

  it("does not overwrite existing config", () => {
    const agentDir = join(TEST_DIR, "agent-e");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }),
      "utf-8"
    );

    createMinimalClaudeConfig(agentDir);

    const config = JSON.parse(readFileSync(join(claudeDir, ".claude.json"), "utf-8"));
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.numStartups).toBe(5);
  });
});
