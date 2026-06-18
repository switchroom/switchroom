import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Opt-out cascade for the on-by-default recall changes (Phase 1 + 6a).
 * The synthesized `observation` tier and the trivial-turn skip are ON by
 * default for every agent (written into the plugin settings.json by
 * applyHindsightSettingsOverrides). An operator opts OUT per-agent (or
 * fleet-wide under `defaults`) via memory.recall.types /
 * memory.recall.skip_trivial — which scaffold exports into start.sh as
 * HINDSIGHT_RECALL_TYPES / HINDSIGHT_RECALL_SKIP_TRIVIAL ONLY when set,
 * and the env value wins over the settings.json default at plugin load.
 */
describe("recall opt-out cascade (Phase 1 + 6a)", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `recall-optout-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function startShFor(agentMemoryRecall: Record<string, unknown> | undefined): string {
    const config: SwitchroomConfig = {
      agents: agentMemoryRecall
        ? { probe: { memory: { recall: agentMemoryRecall } } as never }
        : {},
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as SwitchroomConfig;
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
    return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
  }

  it("default (no override) emits NEITHER env export — settings.json default stays in force", () => {
    const startSh = startShFor(undefined);
    expect(startSh).not.toMatch(/export HINDSIGHT_RECALL_TYPES=/);
    expect(startSh).not.toMatch(/export HINDSIGHT_RECALL_SKIP_TRIVIAL=/);
  });

  it("opt out of observations: memory.recall.types exports a comma-joined HINDSIGHT_RECALL_TYPES", () => {
    const startSh = startShFor({ types: ["world", "experience"] });
    expect(startSh).toMatch(/export HINDSIGHT_RECALL_TYPES="world,experience"/);
  });

  it("opt out of trivial-skip: memory.recall.skip_trivial=false exports the false env (not omitted)", () => {
    const startSh = startShFor({ skip_trivial: false });
    // The bool-false case must still emit the export — otherwise the
    // settings.json default (true) would silently win and the opt-out fail.
    expect(startSh).toMatch(/export HINDSIGHT_RECALL_SKIP_TRIVIAL=false/);
  });

  it("skip_trivial=true also exports (explicit re-affirm is harmless)", () => {
    const startSh = startShFor({ skip_trivial: true });
    expect(startSh).toMatch(/export HINDSIGHT_RECALL_SKIP_TRIVIAL=true/);
  });
});
