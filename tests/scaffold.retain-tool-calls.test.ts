import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, installHindsightPlugin } from "../src/agents/scaffold.js";
import { resolveAgentConfig } from "../src/config/merge.js";
import type { SwitchroomConfig, AgentConfig } from "../src/config/schema.js";

/**
 * RFC memory-redesign P4 — `memory.retain.tool_calls` setter.
 *
 * `retainToolCalls` (whether auto-retain stores tool_use inputs + tool_result
 * content) had a vendor DEFAULTS entry of true but NO scaffold stamp and no
 * config surface, so an operator could not reach it. P4 exposes it as a
 * cascading knob stamped into the deployed settings.json, mirroring
 * `every_n_turns` / `overlap_turns`.
 *
 * Critical invariant: the DEFAULT IS UNCHANGED. Absent any operator override
 * the stamped value is `true`, byte-identical to the fleet's prior behaviour.
 * This is the setter only — no agent is turned off here.
 *
 * These assert the OUTCOME (the stamped settings.json value), so each fails on
 * a missing stamp or a wrong default rather than merely exercising the path.
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

describe("retainToolCalls setter is stamped, defaults true, cascades (RFC P4)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `mem-tool-calls-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  const settingsPath = () => join(tmpDir, ...PLUGIN_REL, "settings.json");
  const readSettings = () =>
    JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;

  it("DEFAULT UNCHANGED: no operator override stamps retainToolCalls === true", () => {
    // The headline P4 invariant. If this ever stamps anything other than true
    // on an un-configured agent, the setter has silently changed fleet
    // behaviour — the one thing this PR must not do.
    const config = baseConfig({ agents: { probe: {} } });
    installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"));
    const s = readSettings();
    expect(s.retainToolCalls).toBe(true);
  });

  it("a per-agent tool_calls:false lands in the deployed settings.json", () => {
    const config = baseConfig({
      agents: { probe: { memory: { retain: { tool_calls: false } } } } as never,
    });
    installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"));
    const s = readSettings();
    expect(s.retainToolCalls).toBe(false);
  });

  it("the threaded cascaded config WINS over the raw agents[name] map entry", () => {
    // The map entry says false; the cascaded config the caller resolved says
    // true. Threading the cascaded config keeps this stamp and the env-export
    // path one source (mirrors the every_n_turns cascade guard, #3914).
    const config = baseConfig({
      agents: { probe: { memory: { retain: { tool_calls: false } } } } as never,
    });
    const resolved = {
      memory: { retain: { tool_calls: true } },
    } as unknown as AgentConfig;
    installHindsightPlugin("probe", tmpDir, config, resolved);
    expect(readSettings().retainToolCalls).toBe(true);
  });

  it("cascade: a defaults-tier tool_calls:false reaches an agent with no own value", () => {
    const config = baseConfig({
      defaults: { memory: { retain: { tool_calls: false } } },
      agents: { probe: {} },
    });
    installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"));
    expect(readSettings().retainToolCalls).toBe(false);
  });

  it("cascade: a per-agent value overrides the defaults tier (agent wins)", () => {
    const config = baseConfig({
      defaults: { memory: { retain: { tool_calls: false } } },
      agents: { probe: { memory: { retain: { tool_calls: true } } } } as never,
    });
    installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"));
    expect(readSettings().retainToolCalls).toBe(true);
  });

  it("cascade: a profile-tier tool_calls:false lands via extends", () => {
    const config = baseConfig({
      profiles: { quiet: { memory: { retain: { tool_calls: false } } } } as never,
      agents: { probe: { extends: "quiet" } } as never,
    });
    installHindsightPlugin("probe", tmpDir, config, cascade(config, "probe"));
    expect(readSettings().retainToolCalls).toBe(false);
  });

  it("end-to-end: default scaffold stamps retainToolCalls true in the deployed settings.json", () => {
    const config = baseConfig({ agents: { probe: {} } });
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, config.telegram, config);
    const s = JSON.parse(
      readFileSync(join(res.agentDir, ...PLUGIN_REL, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(s.retainToolCalls).toBe(true);
  });
});
