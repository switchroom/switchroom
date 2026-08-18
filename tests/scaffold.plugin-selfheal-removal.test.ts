import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHindsightPlugin } from "../src/agents/scaffold.js";
import type { SwitchroomConfig, AgentConfig } from "../src/config/schema.js";

/**
 * #4779 root-cause fix — `installHindsightPlugin`'s memory-off early-outs used
 * to `return null` and leave whatever plugin tree was on disk UNTOUCHED. An
 * agent that once had hindsight, then had it turned off (`test-harness`:
 * `auto_recall: false`, "No Hindsight for test-harness"), therefore kept a
 * frozen pre-M4 plugin tree that `switchroom apply` refreshed for every
 * recall-ON agent but never touched here.
 *
 * The fix makes the disable path SELF-HEAL: remove the tree rather than ignore
 * it, so `apply` is a fixed point — an agent ends with the current vendored
 * plugin (recall on) or NO tree (recall off / backend none), never a stale one.
 */
const PLUGIN_REL = [".claude", "plugins", "hindsight-memory"] as const;

function hindsightConfig(agentMemory: Record<string, unknown> | undefined): SwitchroomConfig {
  return {
    agents: { probe: { memory: agentMemory } as unknown as AgentConfig },
    memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
    telegram: { bot_token: "t", forum_chat_id: "c" },
  } as unknown as SwitchroomConfig;
}

describe("installHindsightPlugin self-heals a stale tree on the memory-off path (#4779)", () => {
  let tmpDir: string;
  const pluginDir = () => join(tmpDir, ...PLUGIN_REL);

  beforeEach(() => {
    tmpDir = join(tmpdir(), `plugin-selfheal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("installs the plugin when recall is on, then REMOVES it when auto_recall flips false", () => {
    // 1. recall ON -> tree vendored in.
    const onConfig = hindsightConfig(undefined);
    expect(installHindsightPlugin("probe", tmpDir, onConfig, onConfig.agents.probe)).not.toBeNull();
    expect(existsSync(pluginDir())).toBe(true);
    expect(existsSync(join(pluginDir(), "scripts", "recall.py"))).toBe(true);

    // 2. operator turns recall off -> apply must self-heal the tree away.
    const offConfig = hindsightConfig({ auto_recall: false });
    expect(installHindsightPlugin("probe", tmpDir, offConfig, offConfig.agents.probe)).toBeNull();
    expect(existsSync(pluginDir())).toBe(false);
  });

  it("removes a hand-copied stale tree when the backend is not hindsight", () => {
    // Simulate a stale tree left by a prior hindsight-enabled config.
    mkdirSync(join(pluginDir(), "scripts"), { recursive: true });
    expect(existsSync(pluginDir())).toBe(true);

    const noneConfig = {
      agents: { probe: {} },
      memory: { backend: "none" },
      telegram: { bot_token: "t", forum_chat_id: "c" },
    } as unknown as SwitchroomConfig;

    expect(installHindsightPlugin("probe", tmpDir, noneConfig, noneConfig.agents.probe)).toBeNull();
    expect(existsSync(pluginDir())).toBe(false);
  });

  it("removal is idempotent — a memory-off agent with no tree stays a clean no-op", () => {
    const offConfig = hindsightConfig({ auto_recall: false });
    expect(existsSync(pluginDir())).toBe(false);
    expect(installHindsightPlugin("probe", tmpDir, offConfig, offConfig.agents.probe)).toBeNull();
    expect(existsSync(pluginDir())).toBe(false);
  });
});
