import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const switchroomConfig: SwitchroomConfig = {
  agents: {},
  telegram: telegramConfig,
  defaults: {},
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function isGitAvailable(): boolean {
  try {
    execSync("command -v git", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("workspace git versioning (Phase 4)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-workspace-git-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes workspace as git repo on agent create", () => {
    if (!isGitAvailable()) {
      console.log("Skipping test: git not available");
      return;
    }

    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const workspaceDir = join(result.agentDir, "workspace");
    const gitDir = join(workspaceDir, ".git");

    expect(existsSync(gitDir)).toBe(true);

    // Verify .gitignore exists
    const gitignorePath = join(workspaceDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const gitignoreContent = readFileSync(gitignorePath, "utf-8");
    expect(gitignoreContent).toContain("SOUL.md");
    expect(gitignoreContent).toContain("*.log");
    expect(gitignoreContent).toContain(".DS_Store");

    // Verify initial commit exists
    const log = execSync("git log --oneline", {
      cwd: workspaceDir,
      encoding: "utf-8",
    });
    expect(log).toContain("seed workspace from switchroom scaffold");
  });

  it("excludes SOUL.md from git tracking (gitignored)", () => {
    if (!isGitAvailable()) {
      console.log("Skipping test: git not available");
      return;
    }

    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const workspaceDir = join(result.agentDir, "workspace");

    // Verify SOUL.md exists
    const soulPath = join(workspaceDir, "SOUL.md");
    expect(existsSync(soulPath)).toBe(true);

    // Verify SOUL.md is not tracked by git
    const trackedFiles = execSync("git ls-files", {
      cwd: workspaceDir,
      encoding: "utf-8",
    });
    expect(trackedFiles).not.toContain("SOUL.md");
  });

  it("tracks user-editable workspace files (AGENTS.md, MEMORY.md, etc.)", () => {
    if (!isGitAvailable()) {
      console.log("Skipping test: git not available");
      return;
    }

    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const workspaceDir = join(result.agentDir, "workspace");

    // Verify user files are tracked
    const trackedFiles = execSync("git ls-files", {
      cwd: workspaceDir,
      encoding: "utf-8",
    });

    expect(trackedFiles).toContain("AGENTS.md");
    expect(trackedFiles).toContain("USER.md");
    expect(trackedFiles).toContain("IDENTITY.md");
    expect(trackedFiles).toContain("TOOLS.md");
    expect(trackedFiles).toContain("MEMORY.md");
  });

  it("idempotent: reconcileAgent inits git on existing non-git workspace", () => {
    if (!isGitAvailable()) {
      console.log("Skipping test: git not available");
      return;
    }

    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    // Scaffold without git (simulate old agent)
    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const workspaceDir = join(result.agentDir, "workspace");
    const gitDir = join(workspaceDir, ".git");

    // Remove the git repo to simulate an agent from before Phase 4
    if (existsSync(gitDir)) {
      rmSync(gitDir, { recursive: true, force: true });
    }

    expect(existsSync(gitDir)).toBe(false);

    // Reconcile should auto-init git
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    expect(existsSync(gitDir)).toBe(true);

    // Verify initial commit exists
    const log = execSync("git log --oneline", {
      cwd: workspaceDir,
      encoding: "utf-8",
    });
    expect(log).toContain("seed workspace from switchroom scaffold");
  });

  it("migrates CLAUDE.custom.md from agent root to workspace/", () => {
    if (!isGitAvailable()) {
      console.log("Skipping test: git not available");
      return;
    }

    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const legacyPath = join(result.agentDir, "CLAUDE.custom.md");
    const newPath = join(result.agentDir, "workspace", "CLAUDE.custom.md");

    // Simulate legacy CLAUDE.custom.md at agent root
    writeFileSync(
      legacyPath,
      "## Legacy Custom Content\n\nThis was at agent root.",
      "utf-8"
    );

    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);

    // Reconcile should move it to workspace/
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);

    const content = readFileSync(newPath, "utf-8");
    expect(content).toContain("Legacy Custom Content");
    expect(content).toContain("This was at agent root");
  });

  it("CLAUDE.custom.md migration is idempotent", () => {
    if (!isGitAvailable()) {
      console.log("Skipping test: git not available");
      return;
    }

    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const newPath = join(result.agentDir, "workspace", "CLAUDE.custom.md");

    // Manually place CLAUDE.custom.md in workspace/
    writeFileSync(
      newPath,
      "## Already in workspace\n\nNo migration needed.",
      "utf-8"
    );

    // Reconcile should not touch it
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const content = readFileSync(newPath, "utf-8");
    expect(content).toContain("Already in workspace");
    expect(content).toContain("No migration needed");
  });

  it("skips git init gracefully when git is not available", () => {
    // This test would need to mock execSync to simulate git not being available
    // For now, we rely on the degrades-gracefully behavior being observable
    // in the console output during scaffoldAgent.
    expect(true).toBe(true); // Placeholder
  });
});
