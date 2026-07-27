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

  it("Phase 6b: retainMode is chunked (windowed retain); retain cadence defaults to 3 / 1", () => {
    const s = settingsAfterInstall();
    // Chunked retain: slice a recent window per fire instead of
    // re-consolidating the whole transcript. Depends on the paired vendor
    // retain.py divergence. Cadence defaults to the switchroom scaffold
    // values (every 3rd turn, +1 overlap turn) — raised from the historical
    // 1 / 2 so the local reasoning consolidation model doesn't run away.
    expect(s.retainMode).toBe("chunked");
    expect(s.retainEveryNTurns).toBe(3);
    expect(s.retainOverlapTurns).toBe(1);
  });

  it("retain cadence is operator-configurable via memory.retain.*", () => {
    // Fleet-wide override under defaults, plus a per-agent override that wins.
    config.defaults = { memory: { retain: { every_n_turns: 5, overlap_turns: 2 } } } as SwitchroomConfig["defaults"];
    config.agents = { probe: { memory: { retain: { every_n_turns: 1 } } } } as unknown as SwitchroomConfig["agents"];
    const s = settingsAfterInstall();
    // Per-agent every_n_turns wins; overlap_turns inherits the defaults tier.
    expect(s.retainEveryNTurns).toBe(1);
    expect(s.retainOverlapTurns).toBe(2);
  });

  it("regression: the pre-existing memory overrides still apply", () => {
    const s = settingsAfterInstall();
    expect(s.retainEveryNTurns).toBe(3);
    expect(s.recallMaxMemories).toBe(8);
    // The `recallMinOverlap` lexical gate was removed outright (no
    // replacement floor): it discarded 79.8% of post-reranker candidates
    // fleet-wide and dropped the engine's own top hit on 31.2% of replayed
    // production queries while filtering no measurable noise. Pinning it
    // absent stops a future settings override quietly reinstating it.
    expect(s.recallMinOverlap).toBeUndefined();
  });

  // #2816 tag-filter port — INTENTIONALLY DORMANT (see the decision comment in
  // renderHindsightSettingsOverrides + reference/rfcs/hindsight-synthesis-
  // layers.md). The scaffold must NOT set any recall tag filter: doing so would
  // silently scope every agent's recall to a per-bank tag taxonomy no RFC
  // specifies. The vendor defaults (empty recallTags → no-op pass-through) must
  // survive scaffold untouched. If a future RFC wires memory.recall.tags, delete
  // this guard and replace it with a positive assertion.
  it("#2816: leaves the recall tag filters at the vendor no-op defaults (dormant)", () => {
    const s = settingsAfterInstall();
    // Either absent (inherit vendor default) or explicitly the no-op empty set,
    // but never a scaffold-imposed non-empty filter.
    expect(s.recallTags === undefined || (Array.isArray(s.recallTags) && (s.recallTags as unknown[]).length === 0)).toBe(true);
    expect(s.recallTagGroups === undefined || s.recallTagGroups === null).toBe(true);
    expect(s.recallAdditionalBankFilters === undefined ||
      (typeof s.recallAdditionalBankFilters === "object" &&
        Object.keys(s.recallAdditionalBankFilters as object).length === 0)).toBe(true);
  });
});
