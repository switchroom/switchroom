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
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
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

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
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

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
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

    it("classifies stable workspace files as stale-till-restart", () => {
      const config = makeAgentConfig({
        soul: { name: "Bot", style: "helpful" },
        channels: {
          telegram: {
            hotReloadStable: false,
          },
        },
      });

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

      // Simulate a change to SOUL.md
      const soulMdPath = join(result.agentDir, "workspace", "SOUL.md");
      const originalContent = readFileSync(soulMdPath, "utf-8");
      writeFileSync(soulMdPath, originalContent + "\n# Extra content\n", "utf-8");

      // Reconcile
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);
      const reconcileResult = reconcileAgent("test-agent", tmpDir, switchroomConfig);

      // SOUL.md should be in staleTillRestart, not hot
      expect(reconcileResult.changesBySemantics?.staleTillRestart).toContain(soulMdPath);
      expect(reconcileResult.changesBySemantics?.hot).not.toContain(soulMdPath);
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

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
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

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
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

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
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

    it("classifies stable workspace files as hot (live on next turn)", () => {
      const config = makeAgentConfig({
        soul: { name: "Bot", style: "helpful" },
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

      // Simulate a change to SOUL.md
      const soulMdPath = join(result.agentDir, "workspace", "SOUL.md");
      const originalContent = readFileSync(soulMdPath, "utf-8");
      writeFileSync(soulMdPath, originalContent + "\n# Extra content\n", "utf-8");

      // Reconcile
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);
      const reconcileResult = reconcileAgent("test-agent", tmpDir, switchroomConfig);

      // SOUL.md should be in hot, not staleTillRestart
      expect(reconcileResult.changesBySemantics?.hot).toContain(soulMdPath);
      expect(reconcileResult.changesBySemantics?.staleTillRestart).not.toContain(soulMdPath);
    });

    it("classifies all stable workspace files as hot when enabled", () => {
      const config = makeAgentConfig({
        soul: { name: "Bot", style: "helpful" },
        channels: {
          telegram: {
            hotReloadStable: true,
          },
        },
      });

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);

      // Create/modify all stable workspace files
      const stableFiles = [
        "workspace/SOUL.md",
        "workspace/AGENTS.md",
        "workspace/USER.md",
        "workspace/IDENTITY.md",
        "workspace/TOOLS.md",
      ];

      for (const file of stableFiles) {
        const filePath = join(result.agentDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          writeFileSync(filePath, content + "\n# Modified\n", "utf-8");
        } else {
          writeFileSync(filePath, "# New file\n", "utf-8");
        }
      }

      // Reconcile
      const reconcileResult = reconcileAgent("test-agent", tmpDir, switchroomConfig);

      // All stable workspace files should be in hot
      for (const file of stableFiles) {
        const filePath = join(result.agentDir, file);
        expect(reconcileResult.changesBySemantics?.hot).toContain(filePath);
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

      const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

      // Modify CLAUDE.md
      const claudeMdPath = join(result.agentDir, "CLAUDE.md");
      const originalContent = readFileSync(claudeMdPath, "utf-8");
      writeFileSync(claudeMdPath, originalContent + "\n# Extra\n", "utf-8");

      // Reconcile
      const switchroomConfig = makeSwitchroomConfig("test-agent", config);
      const reconcileResult = reconcileAgent("test-agent", tmpDir, switchroomConfig);

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

      const result = scaffoldAgent("test-agent", configOff, tmpDir, telegramConfig);

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

      const reconcileResult = reconcileAgent("test-agent", tmpDir, switchroomConfig);

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

      const result = scaffoldAgent("test-agent", configOn, tmpDir, telegramConfig);

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

      const reconcileResult = reconcileAgent("test-agent", tmpDir, switchroomConfig);

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
