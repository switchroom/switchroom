import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

describe("Memory prompt guidance", () => {
  let tmpDir: string;
  let telegramConfig: TelegramConfig;
  let switchroomConfig: SwitchroomConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scaffold-memory-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    telegramConfig = {
      bot_token: "test-token",
      forum_chat_id: "test-chat",
    };

    switchroomConfig = {
      agents: {},
      memory: {
        backend: "hindsight",
        config: { url: "http://localhost:18888/mcp/" },
      },
      telegram: telegramConfig,
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes memory guidance block when using switchroom telegram plugin", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "switchroom",
        },
      },
      memory: {
        collection: "test-agent",
      },
    };

    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const startSh = readFileSync(startShPath, "utf-8");

    expect(startSh).toContain("## Memory — proactive, conversational");
    expect(startSh).toContain("### Retain proactively");
    expect(startSh).toContain("### Correct proactively");
    expect(startSh).toContain("### Forget proactively");
    expect(startSh).toContain("### Inspect proactively");
    expect(startSh).toContain("mcp__hindsight__sync_retain");
    expect(startSh).toContain("mcp__hindsight__delete_memory");
    expect(startSh).toContain("mcp__hindsight__recall");
    expect(startSh).toContain("mcp__hindsight__reflect");
  });

  it("does NOT include memory guidance when using official telegram plugin", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "official",
        },
      },
    };

    const noMemoryConfig: SwitchroomConfig = {
      agents: {},
      telegram: telegramConfig,
    };

    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, noMemoryConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const startSh = readFileSync(startShPath, "utf-8");

    expect(startSh).not.toContain("## Memory — proactive, conversational");
  });

  it("memory guidance appears AFTER progress_update block", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "switchroom",
        },
      },
      memory: {
        collection: "test-agent",
      },
    };

    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const startSh = readFileSync(startShPath, "utf-8");

    const progressIdx = startSh.indexOf("## Progress updates (human-style check-ins)");
    const memoryIdx = startSh.indexOf("## Memory — proactive, conversational");

    expect(progressIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(progressIdx);
  });

  it("reconcileAgent emits identical memory guidance as scaffoldAgent", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "switchroom",
        },
      },
      memory: {
        collection: "test-agent",
      },
    };

    // First scaffold
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const scaffoldStartSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");

    // Then reconcile
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const reconcileStartSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");

    // Extract the APPEND_PROMPT sections
    const extractAppend = (content: string) => {
      const match = content.match(/APPEND_PROMPT='([^']+)'/s);
      return match ? match[1] : "";
    };

    const scaffoldAppend = extractAppend(scaffoldStartSh);
    const reconcileAppend = extractAppend(reconcileStartSh);

    expect(scaffoldAppend).toBe(reconcileAppend);
    expect(scaffoldAppend).toContain("## Memory — proactive, conversational");
  });

  it("includes all four sub-sections in correct order", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "switchroom",
        },
      },
      memory: {
        collection: "test-agent",
      },
    };

    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const startSh = readFileSync(startShPath, "utf-8");

    const retainIdx = startSh.indexOf("### Retain proactively");
    const correctIdx = startSh.indexOf("### Correct proactively");
    const forgetIdx = startSh.indexOf("### Forget proactively");
    const inspectIdx = startSh.indexOf("### Inspect proactively");

    expect(retainIdx).toBeGreaterThan(-1);
    expect(correctIdx).toBeGreaterThan(retainIdx);
    expect(forgetIdx).toBeGreaterThan(correctIdx);
    expect(inspectIdx).toBeGreaterThan(forgetIdx);
  });
});
