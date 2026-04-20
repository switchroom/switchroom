import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("scaffoldAgent — persona (Phase 2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-persona-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits workspace/SOUL.md with rendered persona content", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        emoji: "💪",
        style: "motivational, direct",
        boundaries: "not a doctor",
        expertise: "fitness and nutrition",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");

    expect(existsSync(workspaceSoulPath)).toBe(true);
    const soulMd = readFileSync(workspaceSoulPath, "utf-8");

    // Verify persona structure
    expect(soulMd).toContain("# Coach");
    expect(soulMd).toContain("💪");
    expect(soulMd).toContain("motivational, direct");
    expect(soulMd).toContain("not a doctor");
    expect(soulMd).toContain("fitness and nutrition");
  });

  it("creates symlink from <agentDir>/SOUL.md → workspace/SOUL.md", () => {
    const config = makeAgentConfig({
      soul: { name: "Test", style: "concise" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const agentSoulPath = join(result.agentDir, "SOUL.md");
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");

    expect(existsSync(agentSoulPath)).toBe(true);
    expect(existsSync(workspaceSoulPath)).toBe(true);

    const stat = lstatSync(agentSoulPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = readlinkSync(agentSoulPath);
    expect(target).toBe("workspace/SOUL.md");
  });

  it("CLAUDE.md references SOUL.md instead of containing persona block", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    // Should reference SOUL.md
    expect(claudeMd).toContain("SOUL.md");
    expect(claudeMd).toContain("persona source of truth");

    // Should NOT contain persona block
    expect(claudeMd).not.toContain("## Persona");
    expect(claudeMd).not.toContain("You are **Coach**");
    expect(claudeMd).not.toContain("motivational");
  });

  it("CLAUDE.md is slim (target <3KB)", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational, direct, no fluff",
        boundaries: "not a doctor, not a therapist, stay in lane",
        expertise: "fitness, nutrition, habit formation, accountability",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    // CLAUDE.md should be significantly smaller without persona block
    expect(claudeMd.length).toBeLessThan(5000); // generous cap, target is 3KB
  });
});
