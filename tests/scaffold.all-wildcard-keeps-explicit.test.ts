import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Regression for the 2026-06-15 klanker "re-asks the same permission forever"
// bug. An agent with `tools.allow: [all]` expands to ALL_BUILTIN_TOOLS +
// switchroom-managed MCP tokens, but DELIBERATELY excludes privileged hostd
// tools, Skill(...), and 3rd-party MCP (the leash — even an [all] admin
// approves those once). The intended "stop asking" path is a 🔁 Always tap,
// which persists the specific rule into the agent's tools.allow as
// `[all, mcp__hostd__agent_logs]`. The bug: scaffold's `[all]` branch set
// baseAllow = ALL_BUILTIN_TOOLS and DROPPED every other entry, so the
// operator-persisted rule never reached settings.json → the agent re-asked on
// the next turn, every time. Fix: when hasAllWildcard, keep the explicit
// (non-"all") entries alongside the built-ins.

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

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  };
}

function readAllow(agentDir: string): string[] {
  const settings = JSON.parse(
    readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"),
  );
  return settings.permissions.allow as string[];
}

describe("scaffold: tools.allow [all] keeps explicit additions (klanker re-ask fix)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-all-explicit-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps an operator-persisted privileged/Skill/3p-MCP rule alongside [all]", () => {
    // This is exactly what a 🔁 Always tap persists into switchroom.yaml for an
    // already-[all] admin agent: [all, <the just-approved rule>].
    const config = makeAgentConfig({
      tools: {
        allow: ["all", "mcp__hostd__agent_logs", "Skill(schedule)", "mcp__perplexity-ask__perplexity_ask"],
        deny: [],
      },
    });
    const switchroomConfig = makeSwitchroomConfig("admin-agent", config);
    const result = scaffoldAgent("admin-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const allow = readAllow(result.agentDir);

    // The explicit additions reach settings.json — the agent will NOT re-ask.
    expect(allow).toContain("mcp__hostd__agent_logs");
    expect(allow).toContain("Skill(schedule)");
    expect(allow).toContain("mcp__perplexity-ask__perplexity_ask");
    // [all] still expands to the built-ins.
    expect(allow).toContain("Bash");
    expect(allow).toContain("Read");
    // The literal "all" token is never emitted (Claude Code rejects it).
    expect(allow).not.toContain("all");
  });

  it("[all] alone still expands to built-ins (acceptEdits, no regression)", () => {
    const config = makeAgentConfig({ tools: { allow: ["all"], deny: [] } });
    const switchroomConfig = makeSwitchroomConfig("all-agent", config);
    const result = scaffoldAgent("all-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow = settings.permissions.allow as string[];

    expect(allow).toContain("Bash");
    expect(allow).toContain("Edit");
    expect(allow).not.toContain("all");
    // hasAllWildcard drives defaultMode acceptEdits.
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
  });

  it("non-[all] explicit allow is unchanged (no built-ins injected)", () => {
    const config = makeAgentConfig({ tools: { allow: ["mcp__hostd__agent_logs"], deny: [] } });
    const switchroomConfig = makeSwitchroomConfig("narrow-agent", config);
    const result = scaffoldAgent("narrow-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const allow = readAllow(result.agentDir);

    expect(allow).toContain("mcp__hostd__agent_logs");
    // Without [all], the built-ins are NOT force-added (only read-only defaults
    // when nothing was specified — here something WAS specified).
    expect(allow).not.toContain("Bash");
  });
});
