import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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

  it("wires the working-state-reload SessionStart hook scoped to matcher 'compact'", () => {
    // The working-state file is re-injected into context after compaction via
    // a SessionStart hook. matcher "compact" is load-bearing: it scopes the
    // hook to compaction ONLY, so the file is NOT re-injected on every
    // startup/resume/clear/fork boot. SessionStart stdout is added to the
    // model's context by Claude Code (unlike PreCompact). Default for every
    // agent — present with or without the telegram plugin.
    for (const useSwitchroomPlugin of [false, true]) {
      const result = buildSettingsHooksBlock({
        agentName: "test-agent",
        agentConfig: makeAgentConfig(),
        hindsightEnabled: false,
        useSwitchroomPlugin,
      });
      const sessionStart = (result.SessionStart ?? []) as Array<{
        matcher?: string;
        hooks: Array<{ command: string; timeout?: number }>;
      }>;
      const reloadEntry = sessionStart.find((e) =>
        e.hooks.some((h) => h.command.includes("working-state-reload-hook.sh")),
      );
      expect(reloadEntry, `plugin=${useSwitchroomPlugin}`).toBeDefined();
      // MUST carry matcher "compact" — a bare/absent matcher would fire on
      // every SessionStart source and re-inject working state on every boot.
      expect(reloadEntry?.matcher).toBe("compact");
    }
  });

  it("emits the recovery block on source=compact even with NO working-state file", () => {
    // The unconditional post-compaction recovery/orientation block is the
    // load-bearing default: it must fire for EVERY agent, whether or not it
    // maintains a working-state file. Invoke the real hook script with
    // {"source":"compact"} on stdin and an empty state dir (no
    // .working-state.md) and assert the <compact-recovery> delimiter is
    // present on stdout.
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const emptyStateDir = mkdtempSync(join(tmpdir(), "ws-recovery-"));
    try {
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"compact"}',
        encoding: "utf8",
        env: { ...process.env, TELEGRAM_STATE_DIR: emptyStateDir },
      });
      // Recovery block emitted despite the absent working-state file.
      expect(stdout).toContain("<compact-recovery");
      // And no working-state append, since the file is absent.
      expect(stdout).not.toContain("<working-state");
    } finally {
      rmSync(emptyStateDir, { recursive: true, force: true });
    }
  });

  it("emits NOTHING on a non-compact source (e.g. startup)", () => {
    // The source guard scopes the hook to compaction only; a startup boot
    // must be a silent no-op even when a working-state file exists.
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "ws-startup-"));
    try {
      writeFileSync(join(stateDir, ".working-state.md"), "should not appear\n");
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"startup"}',
        encoding: "utf8",
        env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
      });
      expect(stdout).toBe("");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
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

  it("wires the agent self-improvement Stop gate when the telegram plugin is on", () => {
    // RFC reference/rfcs/agent-self-improvement.md slice 1: the turn-end
    // gate attaches as a switchroom-owned async Stop hook, alongside
    // handoff / secret-scrub / tool-label. Gated on useSwitchroomPlugin
    // because it needs the gateway socket to inject the forked review.
    const withPlugin = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig(),
      hindsightEnabled: false,
      useSwitchroomPlugin: true,
    });
    const stopWith = (withPlugin.Stop ?? []) as Array<{
      hooks: Array<{ command: string; async?: boolean }>;
    }>;
    const selfImprove = stopWith
      .flatMap((e) => e.hooks)
      .find((h) => h.command.includes("self-improve-stop.mjs"));
    expect(selfImprove).toBeDefined();
    expect(selfImprove?.async).toBe(true);

    // Without the plugin, no gateway socket → the gate is not wired.
    const noPlugin = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig(),
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });
    const stopNo = (noPlugin.Stop ?? []) as Array<{ hooks: Array<{ command: string }> }>;
    const stopNoCmds = stopNo.flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopNoCmds.some((c) => c.includes("self-improve-stop.mjs"))).toBe(false);
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

    // RFC agent-self-improvement slice 2: the deterministic apply-guard
    // PreToolUse hook is registered and scoped to the file-write tools (it
    // no-ops unless a self-improve review marker is present).
    expect(preCmds.some(c => c.includes("self-improve-apply-guard-pretool.mjs"))).toBe(true);
    const applyGuardEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("self-improve-apply-guard-pretool.mjs")),
    );
    expect(applyGuardEntry?.matcher).toBe("^(Write|Edit|MultiEdit)$");

    // #2974: the mental-model write redirect PreToolUse hook is registered
    // and scoped to hindsight tools; it denies the four write tools and
    // passes reads through.
    expect(preCmds.some(c => c.includes("hindsight-mental-model-pretool.mjs"))).toBe(true);
    const mmEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("hindsight-mental-model-pretool.mjs")),
    );
    expect(mmEntry?.matcher).toBe("^mcp__hindsight__");

    // Foreground turn-hog gate: registered and scoped to Bash; it denies
    // effectively-unbounded foreground shapes (tail -f, watch, sleep > 30s,
    // sleep-loops, gh --watch, log followers) with an instructive
    // "re-run with run_in_background: true" message.
    expect(preCmds.some(c => c.includes("foreground-hog-pretool.mjs"))).toBe(true);
    const fgHogEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("foreground-hog-pretool.mjs")),
    );
    expect(fgHogEntry?.matcher).toBe("^Bash$");
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

  it("default workspace-dynamic command carries no inject-on-change env and is not-drift vs itself", () => {
    // inject-on-change is the unconditional hook default now, so the
    // scaffolded command threads no SWITCHROOM_INJECT_ON_CHANGE env.
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
    const ups = expected.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const wsDynCmd = ups.flatMap(e => e.hooks.map(h => h.command))
      .find(c => c.includes("workspace-dynamic-hook.sh"));
    expect(wsDynCmd).toBeDefined();
    expect(wsDynCmd).not.toContain("SWITCHROOM_INJECT_ON_CHANGE");
    // And it must not-drift vs itself.
    const { drifted } = detectHooksDrift(expected, expected);
    expect(drifted).toBe(false);
  });

  it("opt-out (inject_on_change=false) threads env=0 and drifts vs the default form", () => {
    const optOut = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig({
        channels: { telegram: { inject_on_change: false } },
      }),
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });
    const ups = optOut.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const wsDynCmd = ups.flatMap(e => e.hooks.map(h => h.command))
      .find(c => c.includes("workspace-dynamic-hook.sh"));
    expect(wsDynCmd).toBeDefined();
    expect(wsDynCmd).toContain("env SWITCHROOM_INJECT_ON_CHANGE=0");

    // Default (no opt-out) form is the drift baseline: the opt-out command
    // differs, so drift detection must fire against it.
    const dflt = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig({
        channels: { telegram: { inject_on_change: true } },
      }),
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });
    const { drifted } = detectHooksDrift(dflt, optOut as Record<string, unknown>);
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
