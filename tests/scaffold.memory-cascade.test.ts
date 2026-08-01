import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, installHindsightPlugin } from "../src/agents/scaffold.js";
import { resolveAgentConfig } from "../src/config/merge.js";
import type { SwitchroomConfig, AgentConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * #3914 — memory config resolution must go through the SAME cascade
 * (defaults → profile → agent) the rest of switchroom uses, not a raw read of
 * the per-agent `agents[name].memory` map entry.
 *
 * Two reads inside installHindsightPlugin bypassed it:
 *   - `auto_recall` was read RAW, so a fleet-wide `defaults.memory.auto_recall:
 *     false` or a profile-tier opt-out did NOT disable the plugin — it installed
 *     anyway, against the operator's fleet-wide intent.
 *   - the retain cadence resolver ignored the caller's already-cascaded config
 *     and re-derived, so it read a DIFFERENT object whenever the raw config the
 *     caller resolved was not literally the map entry (the divergence
 *     resolveHindsightRecallConfig's doc-comment describes).
 *
 * These assert the OUTCOME (plugin installed-or-not; the stamped cadence), so
 * each one fails on the pre-fix raw read rather than merely exercising it.
 */
const PLUGIN_REL = [".claude", "plugins", "hindsight-memory"] as const;

function baseConfig(partial: Partial<SwitchroomConfig>): SwitchroomConfig {
  return {
    memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
    telegram: { bot_token: "t", forum_chat_id: "c" },
    agents: {},
    ...partial,
  } as SwitchroomConfig;
}

/** The fully-cascaded config a production caller threads as resolvedAgentConfig. */
function cascade(config: SwitchroomConfig, name: string): AgentConfig {
  return resolveAgentConfig(config.defaults, config.profiles, config.agents[name] ?? {});
}

describe("auto_recall honours the full cascade (#3914)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `mem-cascade-ar-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a defaults-tier auto_recall:false disables the plugin (null install)", () => {
    // Raw read of agents.probe.memory.auto_recall was undefined here, so the
    // pre-fix code installed the plugin against a fleet-wide opt-out.
    const config = baseConfig({
      defaults: { memory: { auto_recall: false } },
      agents: { probe: {} },
    });
    expect(installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"))).toBeNull();
  });

  it("a profile-tier auto_recall:false disables the plugin (null install)", () => {
    const config = baseConfig({
      profiles: { silent: { memory: { auto_recall: false } } } as never,
      agents: { probe: { extends: "silent" } } as never,
    });
    expect(installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"))).toBeNull();
  });

  it("still installs when no tier opts out (control)", () => {
    const config = baseConfig({ agents: { probe: {} } });
    expect(installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"))).not.toBeNull();
  });

  it("a per-agent auto_recall:false still disables it (existing behaviour preserved)", () => {
    const config = baseConfig({
      agents: { probe: { memory: { auto_recall: false } } } as never,
    });
    expect(installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"))).toBeNull();
  });

  it("end-to-end: a defaults-tier opt-out installs no plugin AND leaves built-in memory on", () => {
    // The scaffoldAgent-side gate (settings.autoMemoryEnabled) must agree with
    // installHindsightPlugin: recall off ⇒ no plugin ⇒ do NOT disable Claude
    // Code's own auto-memory. Before the fix the plugin gate was cascaded but
    // the autoMemory gate re-read the raw map, so they split.
    const config = baseConfig({
      defaults: { memory: { auto_recall: false } },
      agents: { probe: {} },
    });
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, config.telegram, config);
    expect(existsSync(join(res.agentDir, ...PLUGIN_REL, "settings.json"))).toBe(false);
    const agentSettings = JSON.parse(
      readFileSync(join(res.agentDir, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(agentSettings.autoMemoryEnabled).not.toBe(false);
  });
});

describe("retain cadence honours the threaded cascaded config (#3914)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `mem-cascade-rt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  const settingsPath = () => join(tmpDir, ...PLUGIN_REL, "settings.json");
  const readSettings = () =>
    JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;

  it("the threaded cascaded config WINS over the raw agents[name] map entry", () => {
    // The map entry says every-2; the cascaded config the caller resolved says
    // every-9. The pre-fix resolver re-derived from the map and stamped 2,
    // ignoring the value the env-export path was built from — the two channels
    // diverge. Threading the cascaded config is what keeps them one source.
    const config = baseConfig({
      agents: { probe: { memory: { retain: { every_n_turns: 2, overlap_turns: 1 } } } } as never,
    });
    const resolved = {
      memory: { retain: { every_n_turns: 9, overlap_turns: 3 } },
    } as unknown as AgentConfig;
    installHindsightPlugin("probe", tmpDir, config, resolved);
    const s = readSettings();
    expect(s.retainEveryNTurns).toBe(9);
    expect(s.retainOverlapTurns).toBe(3);
  });

  it("end-to-end: a profile-tier retain cadence lands in the deployed settings.json", () => {
    const config = baseConfig({
      profiles: { chatty: { memory: { retain: { every_n_turns: 7, overlap_turns: 4 } } } } as never,
      agents: { probe: { extends: "chatty" } } as never,
    });
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, config.telegram, config);
    const s = JSON.parse(
      readFileSync(join(res.agentDir, ...PLUGIN_REL, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(s.retainEveryNTurns).toBe(7);
    expect(s.retainOverlapTurns).toBe(4);
  });
});
