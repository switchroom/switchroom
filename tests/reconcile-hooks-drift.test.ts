import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSettingsHooksBlock, detectHooksDrift } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig } from "../src/config/schema.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("buildSettingsHooksBlock", () => {
  it("with no user hooks returns only switchroom-owned hooks", () => {
    const agentConfig = makeAgentConfig();
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    // Must have UserPromptSubmit (always present)
    expect(result.UserPromptSubmit).toBeDefined();
    expect(Array.isArray(result.UserPromptSubmit)).toBe(true);

    // workspace-dynamic and timezone hooks must be present
    const ups = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = ups.flatMap(entry => entry.hooks.map(h => h.command));
    expect(commands.some(c => c.includes("workspace-dynamic-hook.sh"))).toBe(true);
    expect(commands.some(c => c.includes("timezone-hook.sh"))).toBe(true);

    // Without telegram plugin: no PreToolUse or PostToolUse
    expect(result.PreToolUse).toBeUndefined();
    expect(result.PostToolUse).toBeUndefined();
  });

  it("with telegram plugin adds PreToolUse and PostToolUse hooks", () => {
    const agentConfig = makeAgentConfig({
      plugin: "switchroom-telegram",
    });
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: true,
    });

    expect(result.PreToolUse).toBeDefined();
    expect(Array.isArray(result.PreToolUse)).toBe(true);
    const preHooks = result.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    const preCmds = preHooks.flatMap(e => e.hooks.map(h => h.command));
    expect(preCmds.some(c => c.includes("secret-guard-pretool.mjs"))).toBe(true);
    expect(preCmds.some(c => c.includes("subagent-tracker-pretool.mjs"))).toBe(true);

    expect(result.PostToolUse).toBeDefined();
    const postHooks = result.PostToolUse as Array<{ hooks: Array<{ command: string }> }>;
    const postCmds = postHooks.flatMap(e => e.hooks.map(h => h.command));
    expect(postCmds.some(c => c.includes("subagent-tracker-posttool.mjs"))).toBe(true);
  });

  it("with user hooks declared merges them with switchroom-owned hooks", () => {
    const agentConfig = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [
          { type: "command", command: "echo user-hook" },
        ],
      },
    });

    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    const ups = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = ups.flatMap(entry => entry.hooks.map(h => h.command));

    // User hook must appear
    expect(commands.some(c => c.includes("echo user-hook"))).toBe(true);
    // Switchroom-owned hooks must also appear
    expect(commands.some(c => c.includes("workspace-dynamic-hook.sh"))).toBe(true);
    expect(commands.some(c => c.includes("timezone-hook.sh"))).toBe(true);
  });

  it("is idempotent — calling twice with same input produces deeply equal output", () => {
    const agentConfig = makeAgentConfig({
      plugin: "switchroom-telegram",
      hooks: {
        Stop: [{ type: "command", command: "echo my-stop" }],
      },
    });
    const params = {
      agentName: "idempotent-agent",
      agentConfig,
      hindsightEnabled: true,
      useSwitchroomPlugin: true,
    };

    const first = buildSettingsHooksBlock(params);
    const second = buildSettingsHooksBlock(params);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("includes --config flag in handoff command when configPath is provided", () => {
    const agentConfig = makeAgentConfig();
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
      configPath: "/home/user/switchroom.yaml",
    });

    const stop = result.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
    expect(stop).toBeDefined();
    const stopCmds = (stop ?? []).flatMap(e => e.hooks.map(h => h.command));
    expect(stopCmds.some(c => c.includes("--config") && c.includes("switchroom.yaml"))).toBe(true);
  });

  it("handoff command has no --config flag when configPath is omitted", () => {
    const agentConfig = makeAgentConfig();
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    const stop = result.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
    expect(stop).toBeDefined();
    const stopCmds = (stop ?? []).flatMap(e => e.hooks.map(h => h.command));
    const handoffCmd = stopCmds.find(c => c.includes("handoff"));
    expect(handoffCmd).toBeDefined();
    expect(handoffCmd).not.toContain("--config");
  });
});

describe("detectHooksDrift", () => {
  it("returns drifted=false when hooks are identical", () => {
    const hooks = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
    };
    const result = detectHooksDrift(hooks, hooks);
    expect(result.drifted).toBe(false);
    expect(result.summary).toBe("in sync");
  });

  it("returns drifted=false when hooks are equal but key order differs", () => {
    const expected = { UserPromptSubmit: [{ hooks: [{ timeout: 5, command: "echo hi", type: "command" }] }] };
    const actual   = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }] };
    const result = detectHooksDrift(expected, actual);
    expect(result.drifted).toBe(false);
  });

  it("returns drifted=true when hooks differ", () => {
    const expected = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo new", timeout: 5 }] }] };
    const actual   = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo old", timeout: 5 }] }] };
    const result = detectHooksDrift(expected, actual);
    expect(result.drifted).toBe(true);
    expect(result.summary).toContain("DRIFTED");
    expect(result.summary).toContain("UserPromptSubmit");
  });

  it("drift fixture: stale settings.json detected as drifted", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "switchroom-drift-test-"));
    try {
      const claudeDir = join(tmpDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, "settings.json");

      // Write a stale settings.json with an outdated hooks block
      const staleSettings = {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo stale-hook", timeout: 5 }] },
          ],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(staleSettings, null, 2), "utf-8");
      expect(existsSync(settingsPath)).toBe(true);

      // Compute what the current config would produce
      const agentConfig = makeAgentConfig();
      const expected = buildSettingsHooksBlock({
        agentName: "my-agent",
        agentConfig,
        hindsightEnabled: false,
        useSwitchroomPlugin: false,
      });

      const actual = (staleSettings.hooks as Record<string, unknown>);
      const { drifted, summary } = detectHooksDrift(expected, actual);
      expect(drifted).toBe(true);
      expect(summary).toContain("DRIFTED");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
