import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

describe("reconcileAgent — persona (Phase 3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-reconcile-persona-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("regenerates workspace/SOUL.md when config changes", () => {
    const config1 = makeAgentConfig({
      soul: { name: "Coach", style: "motivational" },
    });

    const result = scaffoldAgent("test-agent", config1, tmpDir, telegramConfig);
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");

    const soulBefore = readFileSync(workspaceSoulPath, "utf-8");
    expect(soulBefore).toContain("Coach");
    expect(soulBefore).toContain("motivational");

    // Change config
    const config2 = makeAgentConfig({
      soul: { name: "Assistant", style: "concise, technical" },
    });

    reconcileAgent("test-agent", config2, tmpDir, telegramConfig, switchroomConfig);

    const soulAfter = readFileSync(workspaceSoulPath, "utf-8");
    expect(soulAfter).toContain("Assistant");
    expect(soulAfter).toContain("concise, technical");
    expect(soulAfter).not.toContain("Coach");
    expect(soulAfter).not.toContain("motivational");
  });

  it("appends SOUL.custom.md sidecar if present", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");
    const customSoulPath = join(result.agentDir, "workspace", "SOUL.custom.md");

    // Add custom sidecar
    writeFileSync(
      customSoulPath,
      "## Custom Section\n\nThis is my personal addition.",
      "utf-8"
    );

    // Reconcile should append the custom content
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const soulMd = readFileSync(workspaceSoulPath, "utf-8");
    expect(soulMd).toContain("---");
    expect(soulMd).toContain("## Custom Section");
    expect(soulMd).toContain("This is my personal addition");
  });

  it("regenerates CLAUDE.md by default when template changes", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");

    const original = readFileSync(claudeMdPath, "utf-8");

    // Reconcile regenerates CLAUDE.md deterministically
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const afterReconcile = readFileSync(claudeMdPath, "utf-8");
    expect(afterReconcile).toBe(original); // Idempotent when template is the same
  });

  it("appends CLAUDE.custom.md sidecar if present", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");
    const claudeCustomPath = join(result.agentDir, "CLAUDE.custom.md");

    // Add custom sidecar
    writeFileSync(
      claudeCustomPath,
      "## Custom Instructions\n\nThis is my personal addition.",
      "utf-8"
    );

    // Reconcile should append the custom content
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    expect(claudeMd).toContain("---");
    expect(claudeMd).toContain("## Custom Instructions");
    expect(claudeMd).toContain("This is my personal addition");
  });

  it("preserves CLAUDE.md when --preserve-claude-md is set", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");

    // User edits CLAUDE.md
    const original = readFileSync(claudeMdPath, "utf-8");
    const edited = original + "\n\n## My Custom Section\n\nUser-added content.";
    writeFileSync(claudeMdPath, edited, "utf-8");

    // Reconcile with --preserve-claude-md
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig, undefined, {
      preserveClaudeMd: true,
    });

    const afterReconcile = readFileSync(claudeMdPath, "utf-8");
    expect(afterReconcile).toContain("## My Custom Section");
    expect(afterReconcile).toContain("User-added content");
  });

  it("aborts reconcile with warning when CLAUDE.md has hand-edits and no sidecar exists", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");

    // User edits CLAUDE.md (simulating hand-edits)
    const original = readFileSync(claudeMdPath, "utf-8");
    const edited = original + "\n\n## My Custom Section\n\nUser-added content.";
    writeFileSync(claudeMdPath, edited, "utf-8");

    // Reconcile should abort with exit(1)
    expect(() => {
      reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    }).toThrow(); // process.exit(1) will throw in test environment
  });
});
