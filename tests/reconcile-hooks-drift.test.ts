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

  it("does NOT wire the retired user-profile-refresh Stop hook, even with hindsight enabled", () => {
    // Per-agent user-profile mental models are retired in favour of dedicated
    // profile banks — the refresh Stop hook must no longer be emitted.
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig(),
      hindsightEnabled: true,
      useSwitchroomPlugin: true,
    });
    const stop = (result.Stop ?? []) as Array<{ hooks: Array<{ command: string }> }>;
    const stopCmds = stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopCmds.some((c) => c.includes("user-profile-refresh-hook.sh"))).toBe(false);
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
    const preHooks = result.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const preCmds = preHooks.flatMap(e => e.hooks.map(h => h.command));
    expect(preCmds.some(c => c.includes("secret-guard-pretool.mjs"))).toBe(true);
    expect(preCmds.some(c => c.includes("subagent-tracker-pretool.mjs"))).toBe(true);

    // secret-guard must run on every tool (no matcher); subagent-tracker must
    // be scoped to the Agent tool so it doesn't fire ~120ms/turn for nothing.
    const secretGuardEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("secret-guard-pretool.mjs")),
    );
    expect(secretGuardEntry?.matcher).toBeUndefined();
    const subagentPreEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("subagent-tracker-pretool.mjs")),
    );
    expect(subagentPreEntry?.matcher).toBe("^(Agent|Task)$");

    expect(result.PostToolUse).toBeDefined();
    const postHooks = result.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const postCmds = postHooks.flatMap(e => e.hooks.map(h => h.command));
    expect(postCmds.some(c => c.includes("subagent-tracker-posttool.mjs"))).toBe(true);
    const subagentPostEntry = postHooks.find(e =>
      e.hooks.some(h => h.command.includes("subagent-tracker-posttool.mjs")),
    );
    expect(subagentPostEntry?.matcher).toBe("^(Agent|Task)$");

    // PR #1811 / v0.13.48: repo-context-pretool must be registered AND
    // matched to the file-touching + Bash tools. Drift between the
    // scaffold list (here) and telegram-plugin/hooks/hooks.json silently
    // skips the hook — the live UAT for #1811 caught exactly this gap on
    // v0.13.48 before the v0.13.49 hotfix landed.
    expect(preCmds.some(c => c.includes("repo-context-pretool.mjs"))).toBe(true);
    const repoContextEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("repo-context-pretool.mjs")),
    );
    expect(repoContextEntry?.matcher).toBe("^(Read|Edit|Write|MultiEdit|NotebookEdit|Bash)$");
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

  it("never bakes --config into the handoff command, even when configPath is passed (#1745 supersedes #1079)", () => {
    const agentConfig = makeAgentConfig();
    const hostConfigPath = "/home/user/switchroom.yaml";
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
      configPath: hostConfigPath,
    });

    const stop = result.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
    expect(stop).toBeDefined();
    const stopCmds = (stop ?? []).flatMap(e => e.hooks.map(h => h.command));
    const handoffCmd = stopCmds.find(c => c.includes("handoff"));
    expect(handoffCmd).toBeDefined();
    // Pre-#1745 the hook baked `--config /state/config/switchroom.yaml`
    // into the command so the CLI could find the yaml inside the
    // container. But the yaml isn't bind-mounted into sandboxed
    // agents, so loadConfig() threw ConfigError on every Stop. The
    // handoff CLI now treats config-load as non-fatal, so the
    // `--config` arg is no longer needed and is no longer emitted —
    // even if a host-side caller passes `configPath`.
    expect(handoffCmd).not.toContain("--config");
    expect(handoffCmd).not.toContain(hostConfigPath);
    expect(handoffCmd).not.toContain("/state/config/switchroom.yaml");
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

describe("inject_on_change command format drift detection", () => {
  it("new env-prefix turn-pacing command is not-drift vs itself", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    const params = {
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    };
    const expected = buildSettingsHooksBlock(params);
    const { drifted } = detectHooksDrift(expected, expected);
    expect(drifted).toBe(false);
  });

  it("old printf-style turn-pacing command is detected as drift vs new env-prefix form", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    // Build the current (correct) hooks block.
    const expected = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    // Simulate a stale settings.json that still has the old printf-style command.
    // We deep-clone expected and replace the turn-pacing command with the old format.
    const stale = JSON.parse(JSON.stringify(expected)) as typeof expected;
    const ups = stale.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    for (const entry of ups) {
      for (const hook of entry.hooks) {
        if (hook.command.includes("turn-pacing-hook.sh")) {
          // Replace with old-style printf form (no env prefix).
          hook.command = hook.command.replace(
            /^bash run-hook\.sh 'hook:turn-pacing' env /,
            "bash run-hook.sh 'hook:turn-pacing' ",
          );
          // Also simulate the really old format with bare assignment.
          hook.command = "bash run-hook.sh 'hook:turn-pacing' TURN_PACING_DIRECTIVE='old directive' bash \"/opt/switchroom/bin/turn-pacing-hook.sh\"";
        }
      }
    }

    const { drifted } = detectHooksDrift(expected, stale as Record<string, unknown>);
    expect(drifted).toBe(true);
  });

  it("new env-prefix workspace-dynamic command is not-drift vs itself under inject_on_change=true", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    const params = {
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    };
    const expected = buildSettingsHooksBlock(params);
    // Check workspace-dynamic command has the env prefix.
    const ups = expected.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const wsDynCmd = ups.flatMap(e => e.hooks.map(h => h.command))
      .find(c => c.includes("workspace-dynamic-hook.sh"));
    expect(wsDynCmd).toBeDefined();
    expect(wsDynCmd).toContain("env SWITCHROOM_INJECT_ON_CHANGE=1");
    // And it must not-drift vs itself.
    const { drifted } = detectHooksDrift(expected, expected);
    expect(drifted).toBe(false);
  });

  it("old bare-assignment workspace-dynamic command is detected as drift", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    const expected = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    const stale = JSON.parse(JSON.stringify(expected)) as typeof expected;
    const ups = stale.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    for (const entry of ups) {
      for (const hook of entry.hooks) {
        if (hook.command.includes("workspace-dynamic-hook.sh")) {
          // Old broken format without `env` prefix.
          hook.command = hook.command.replace("env SWITCHROOM_INJECT_ON_CHANGE=1 bash", "SWITCHROOM_INJECT_ON_CHANGE=1 bash");
        }
      }
    }

    const { drifted } = detectHooksDrift(expected, stale as Record<string, unknown>);
    expect(drifted).toBe(true);
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
