import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { renderTemplate } from "../src/agents/templates.js";
import type { AgentConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    template: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("scaffoldAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the correct directory structure", () => {
    const config = makeAgentConfig({ topic_name: "Health" });
    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".claude"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "skills"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", ".env"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", "access.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "start.sh"))).toBe(true);
  });

  it("renders CLAUDE.md with agent name and soul", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational, direct",
        boundaries: "not a doctor",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    expect(claudeMd).toContain("# Agent: health-coach");
    expect(claudeMd).toContain("You are Coach.");
    expect(claudeMd).toContain("Style: motivational, direct");
    expect(claudeMd).toContain("Boundaries: not a doctor");
  });

  it("generates start.sh with correct env vars", () => {
    const config = makeAgentConfig({ topic_id: 42 });
    const result = scaffoldAgent("my-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("#!/bin/bash");
    expect(startSh).toContain(`CLAUDE_CONFIG_DIR="${result.agentDir}/.claude"`);
    expect(startSh).toContain(`TELEGRAM_STATE_DIR="${result.agentDir}/telegram"`);
    expect(startSh).toContain('TELEGRAM_TOPIC_ID="42"');
    expect(startSh).toContain("exec claude --channels plugin:telegram@claude-plugins-official");
  });

  it("omits TELEGRAM_TOPIC_ID when topic_id is not set", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-topic", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).not.toContain("TELEGRAM_TOPIC_ID");
  });

  it("generates telegram .env with bot token", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("bot-agent", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=123456:ABC-DEF");
  });

  it("generates access.json with topic filtering", () => {
    const config = makeAgentConfig({ topic_id: 99 });
    const result = scaffoldAgent("filtered", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );

    expect(access.forum_chat_id).toBe("-1001234567890");
    expect(access.topic_id).toBe(99);
  });

  it("generates settings.json with tool permissions", () => {
    const config = makeAgentConfig({
      tools: { allow: ["calendar", "notion"], deny: ["bash"] },
    });
    const result = scaffoldAgent("tools-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toEqual(["calendar", "notion"]);
    expect(settings.permissions.deny).toEqual(["bash"]);
  });

  it("is idempotent — running twice does not overwrite existing files", () => {
    const config = makeAgentConfig({
      soul: { name: "Coach", style: "direct" },
    });

    // First scaffold
    const result1 = scaffoldAgent("idem-agent", config, tmpDir, telegramConfig);
    expect(result1.created.length).toBeGreaterThan(0);
    expect(result1.skipped.length).toBe(0);

    // Modify a file to verify it won't be overwritten
    const claudePath = join(result1.agentDir, "CLAUDE.md");
    writeFileSync(claudePath, "# Custom content\n", "utf-8");

    // Second scaffold
    const result2 = scaffoldAgent("idem-agent", config, tmpDir, telegramConfig);
    expect(result2.created.length).toBe(0);
    expect(result2.skipped.length).toBeGreaterThan(0);

    // Verify file was not overwritten
    const content = readFileSync(claudePath, "utf-8");
    expect(content).toBe("# Custom content\n");
  });

  it("returns correct agentDir path", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("path-check", config, tmpDir, telegramConfig);

    expect(result.agentDir).toBe(join(tmpDir, "path-check"));
  });
});

describe("renderTemplate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-tpl-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders Handlebars variables", () => {
    const tplPath = join(tmpDir, "test.hbs");
    writeFileSync(tplPath, "Hello {{name}}, you are {{role}}.", "utf-8");

    const result = renderTemplate(tplPath, { name: "Alice", role: "admin" });
    expect(result).toBe("Hello Alice, you are admin.");
  });

  it("handles conditional blocks", () => {
    const tplPath = join(tmpDir, "cond.hbs");
    writeFileSync(tplPath, "{{#if active}}ON{{else}}OFF{{/if}}", "utf-8");

    expect(renderTemplate(tplPath, { active: true })).toBe("ON");
    expect(renderTemplate(tplPath, { active: false })).toBe("OFF");
  });

  it("handles each loops", () => {
    const tplPath = join(tmpDir, "loop.hbs");
    writeFileSync(tplPath, "{{#each items}}{{this}} {{/each}}", "utf-8");

    const result = renderTemplate(tplPath, { items: ["a", "b", "c"] });
    expect(result).toBe("a b c ");
  });
});
