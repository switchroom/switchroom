import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHindsightPlugin } from "../src/agents/scaffold.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * Phase 1 + 6a (RFC reference/rfcs/hindsight-synthesis-layers.md):
 * `applyHindsightSettingsOverrides` (run inside installHindsightPlugin)
 * writes switchroom's memory-tuning overrides into each agent's copied
 * plugin settings.json. These pin:
 *   - Phase 1: `recallTypes` includes the synthesized `observation` tier
 *     (not just raw world/experience) so curated memory reaches recall.
 *   - Phase 6a: `recallSkipTrivial` is on so the recall hook skips the
 *     ~1-2s arm on plausibly-stateless trivial turns.
 * Plus the pre-existing overrides as a regression guard.
 */
describe("hindsight recall overrides — observations + trivial-skip", () => {
  let tmpDir: string;
  let config: SwitchroomConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scaffold-recall-obs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    config = {
      agents: {},
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram: { bot_token: "t", forum_chat_id: "c" },
    } as SwitchroomConfig;
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function settingsAfterInstall(): Record<string, unknown> {
    const res = installHindsightPlugin("probe", tmpDir, config);
    expect(res).not.toBeNull();
    const settingsPath = join(tmpDir, ".claude", "plugins", "hindsight-memory", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  it("Phase 1: recallTypes includes the synthesized observation tier", () => {
    const s = settingsAfterInstall();
    expect(Array.isArray(s.recallTypes)).toBe(true);
    const types = s.recallTypes as string[];
    expect(types).toContain("observation");
    // Still includes the raw tiers — observations augment, not replace.
    expect(types).toContain("world");
    expect(types).toContain("experience");
  });

  it("Phase 6a: recallSkipTrivial is enabled", () => {
    const s = settingsAfterInstall();
    expect(s.recallSkipTrivial).toBe(true);
  });

  it("regression: the pre-existing memory overrides still apply", () => {
    const s = settingsAfterInstall();
    expect(s.retainEveryNTurns).toBe(1);
    expect(s.recallMaxMemories).toBe(8);
    expect(s.recallMinOverlap).toBe(0.1);
  });
});
