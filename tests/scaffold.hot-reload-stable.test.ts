import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent, classifyChange } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

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

function makeSwitchroomConfig(
  agentName: string,
  agentConfig: AgentConfig,
): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: {
      [agentName]: agentConfig,
    },
  };
}

describe("hot-reload stable feature", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-hotreload-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hotReloadStable: false (default)", () => {
    it("bakes stable workspace render into start.sh --append-system-prompt", () => {
      const config = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: false,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
      const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

      // Should contain the stable workspace render block
      expect(startSh).toContain('workspace render "test-agent" --stable');
      expect(startSh).toContain("_WS_STABLE");
    });

    it("does NOT wire workspace-stable-hook.sh into settings.json", () => {
      const config = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: false,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
      const settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );

      // Should NOT have workspace-stable-hook.sh in UserPromptSubmit hooks
      const userPromptSubmitHooks = settings.hooks?.UserPromptSubmit || [];
      const hasStableHook = userPromptSubmitHooks.some((entry: { hooks: { command?: string }[] }) =>
        entry.hooks?.some((hook) =>
          hook.command?.includes("workspace-stable-hook.sh"),
        ),
      );
      expect(hasStableHook).toBe(false);

      // Should still have the dynamic hook
      const hasDynamicHook = userPromptSubmitHooks.some((entry: { hooks: { command?: string }[] }) =>
        entry.hooks?.some((hook) =>
          hook.command?.includes("workspace-dynamic-hook.sh"),
        ),
      );
      expect(hasDynamicHook).toBe(true);
    });

    it("classifies SOUL.md as restart-required (soul changes need restart to take effect)", () => {
      // SOUL.md is user-owned and no longer reconcile-regenerated, so
      // this is a unit check on the classifier itself (the path-based
      // contract) rather than via reconcile's change set. Default
      // (hotReloadStable=false): soul is frozen at session launch and
      // invisible until restart, so an edit must force a restart.
      const agentDir = "/agents/test-agent";
      expect(
        classifyChange(`${agentDir}/workspace/SOUL.md`, agentDir, false),
      ).toBe("restart-required");
      expect(
        classifyChange(`${agentDir}/workspace/SOUL.custom.md`, agentDir, false),
      ).toBe("restart-required");
    });
  });

  describe("hotReloadStable: true", () => {
    it("does NOT bake stable workspace render into start.sh", () => {
      const config = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
      const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

      // Should NOT contain the stable workspace render block
      // The template wraps it in {{#unless useHotReloadStable}}
      expect(startSh).not.toContain('workspace render "test-agent" --stable');
      expect(startSh).not.toContain("_WS_STABLE");
    });

    it("wires workspace-stable-hook.sh into settings.json UserPromptSubmit", () => {
      const config = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
      const settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );

      // Should have workspace-stable-hook.sh in UserPromptSubmit hooks
      const userPromptSubmitHooks = settings.hooks?.UserPromptSubmit || [];
      const hasStableHook = userPromptSubmitHooks.some((entry: { hooks: { command?: string }[] }) =>
        entry.hooks?.some((hook) =>
          hook.command?.includes("workspace-stable-hook.sh"),
        ),
      );
      expect(hasStableHook).toBe(true);

      // Should also still have the dynamic hook
      const hasDynamicHook = userPromptSubmitHooks.some((entry: { hooks: { command?: string }[] }) =>
        entry.hooks?.some((hook) =>
          hook.command?.includes("workspace-dynamic-hook.sh"),
        ),
      );
      expect(hasDynamicHook).toBe(true);
    });

    it("places stable hook BEFORE dynamic hook (ordering matters)", () => {
      const config = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
      const settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );

      const userPromptSubmitHooks = settings.hooks?.UserPromptSubmit || [];

      // Find indices of stable and dynamic hooks
      let stableIndex = -1;
      let dynamicIndex = -1;

      userPromptSubmitHooks.forEach((entry: { hooks: { command?: string }[] }, i: number) => {
        entry.hooks?.forEach((hook) => {
          if (hook.command?.includes("workspace-stable-hook.sh")) {
            stableIndex = i;
          }
          if (hook.command?.includes("workspace-dynamic-hook.sh")) {
            dynamicIndex = i;
          }
        });
      });

      // Stable should come before dynamic
      expect(stableIndex).toBeGreaterThanOrEqual(0);
      expect(dynamicIndex).toBeGreaterThan(stableIndex);
    });

    it("classifies SOUL.md as hot when hotReloadStable is enabled", () => {
      // When hotReloadStable is true the per-turn hook re-injects the
      // stable render, so a SOUL.md edit goes live next turn without a
      // restart. Unit check on the classifier (SOUL.md is user-owned
      // and no longer reconcile-regenerated).
      const agentDir = "/agents/test-agent";
      expect(
        classifyChange(`${agentDir}/workspace/SOUL.md`, agentDir, true),
      ).toBe("hot");
      expect(
        classifyChange(`${agentDir}/workspace/SOUL.custom.md`, agentDir, true),
      ).toBe("hot");
    });

    it("flips other stable workspace files hot↔stale-till-restart with the flag", () => {
      // AGENTS/USER/IDENTITY/TOOLS + workspace/CLAUDE.md are user-owned
      // (reconcile never modifies them), but the classifier contract
      // still governs how a change would be treated: hot when the flag
      // is on, stale-till-restart when off.
      const agentDir = "/agents/test-agent";
      for (const rel of [
        "workspace/AGENTS.md",
        "workspace/USER.md",
        "workspace/IDENTITY.md",
        "workspace/TOOLS.md",
        "workspace/CLAUDE.md",
      ]) {
        expect(classifyChange(`${agentDir}/${rel}`, agentDir, true)).toBe("hot");
        expect(classifyChange(`${agentDir}/${rel}`, agentDir, false)).toBe(
          "stale-till-restart",
        );
      }
    });

    it("still classifies CLAUDE.md as stale-till-restart (not controlled by switchroom)", () => {
      const config = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

      // Force a re-composition of CLAUDE.md so it lands in `changes` and
      // flows through the classifier. Under the #1857 two-section model, an
      // edit below the "Yours" marker survives and edits above it are
      // regenerated — either way the file changes. Strip the marker to
      // simulate a legacy (pre-#1857) file: reconcile re-adds it, so the
      // composed output != on-disk and CLAUDE.md enters `changes`.
      const claudeMdPath = join(result.agentDir, "CLAUDE.md");
      const MARKER = "# --- Yours (preserved across apply) ---";
      const fresh = readFileSync(claudeMdPath, "utf-8");
      writeFileSync(claudeMdPath, fresh.slice(0, fresh.indexOf(MARKER)).trimEnd() + "\n", "utf-8");

      // Reconcile
      const reconcileResult = reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

      // CLAUDE.md should remain stale-till-restart regardless of hotReloadStable
      expect(reconcileResult.changesBySemantics?.staleTillRestart).toContain(claudeMdPath);
      expect(reconcileResult.changesBySemantics?.hot).not.toContain(claudeMdPath);
    });
  });

  describe("flag flipping (reconcile)", () => {
    it("flips start.sh and settings.json when flag changes from false to true", () => {
      // Scaffold with hotReloadStable: false
      const configOff = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: false,
          },
        },
      });
      const switchroomConfigOff = makeSwitchroomConfig("test-agent", configOff);

      const result = scaffoldAgent("test-agent", configOff, tmpDir, telegramConfig, switchroomConfigOff);

      // Verify initial state (stable in start.sh, no stable hook)
      let startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      expect(startSh).toContain("_WS_STABLE");

      let settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );
      let hasStableHook = (settings.hooks?.UserPromptSubmit || []).some(
        (entry: { hooks: { command?: string }[] }) =>
          entry.hooks?.some((hook) => hook.command?.includes("workspace-stable-hook.sh")),
      );
      expect(hasStableHook).toBe(false);

      // Reconcile with hotReloadStable: true
      const configOn = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", configOn);

      const reconcileResult = reconcileAgent("test-agent", configOn, tmpDir, telegramConfig, switchroomConfig);

      // Verify start.sh changed (no longer has _WS_STABLE)
      startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      expect(startSh).not.toContain("_WS_STABLE");
      expect(reconcileResult.changes).toContain(join(result.agentDir, "start.sh"));

      // Verify settings.json changed (now has stable hook)
      settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );
      hasStableHook = (settings.hooks?.UserPromptSubmit || []).some(
        (entry: { hooks: { command?: string }[] }) =>
          entry.hooks?.some((hook) => hook.command?.includes("workspace-stable-hook.sh")),
      );
      expect(hasStableHook).toBe(true);
      expect(reconcileResult.changes).toContain(
        join(result.agentDir, ".claude", "settings.json"),
      );
    });

    it("flips start.sh and settings.json when flag changes from true to false", () => {
      // Scaffold with hotReloadStable: true
      const configOn = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });
      const switchroomConfigOn = makeSwitchroomConfig("test-agent", configOn);

      const result = scaffoldAgent("test-agent", configOn, tmpDir, telegramConfig, switchroomConfigOn);

      // Verify initial state (no stable in start.sh, has stable hook)
      let startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      expect(startSh).not.toContain("_WS_STABLE");

      let settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );
      let hasStableHook = (settings.hooks?.UserPromptSubmit || []).some(
        (entry: { hooks: { command?: string }[] }) =>
          entry.hooks?.some((hook) => hook.command?.includes("workspace-stable-hook.sh")),
      );
      expect(hasStableHook).toBe(true);

      // Reconcile with hotReloadStable: false
      const configOff = makeAgentConfig({
        channels: {
          telegram: {
            hotReloadStable: false,
          },
        },
      });
      const switchroomConfig = makeSwitchroomConfig("test-agent", configOff);

      const reconcileResult = reconcileAgent("test-agent", configOff, tmpDir, telegramConfig, switchroomConfig);

      // Verify start.sh changed (now has _WS_STABLE)
      startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      expect(startSh).toContain("_WS_STABLE");
      expect(reconcileResult.changes).toContain(join(result.agentDir, "start.sh"));

      // Verify settings.json changed (no longer has stable hook)
      settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );
      hasStableHook = (settings.hooks?.UserPromptSubmit || []).some(
        (entry: { hooks: { command?: string }[] }) =>
          entry.hooks?.some((hook) => hook.command?.includes("workspace-stable-hook.sh")),
      );
      expect(hasStableHook).toBe(false);
      expect(reconcileResult.changes).toContain(
        join(result.agentDir, ".claude", "settings.json"),
      );
    });
  });
});
