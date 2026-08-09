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

  // Per-bank slot reservation. The merged multi-bank set is sorted globally by
  // relevance and head-sliced, which is winner-take-all across banks: when both
  // banks return more candidates than the cap, one bank's score distribution
  // can fill every slot. These floors are the switchroom opt-in over the
  // vendor's 0/0 (pure head-slice).
  it("reserves a floor of recall slots for each bank, at the resolver-default cap", () => {
    // No `max_memories` set → resolver default 8 → own ≈ ⅓ = 3, additional ≈ ⅙ = 1.
    const s = settingsAfterInstall();
    expect(s.recallOwnBankMinSlots).toBe(3);
    expect(s.recallAdditionalBankMinSlots).toBe(1);
    // Both floors must be non-zero, or one side can still be zeroed out.
    expect(s.recallOwnBankMinSlots as number).toBeGreaterThan(0);
    expect(s.recallAdditionalBankMinSlots as number).toBeGreaterThan(0);
  });

  // REGRESSION GUARD (recall slot-floor scaling). The floors USED to be
  // hardcoded literals `2 / 1`, sized to the cap-of-6 the fleet ran in 2026-07
  // (#3755, 4f469b1d). When the fleet cap was raised 6→16 (switchroom.yaml,
  // 2026-08-03) the literals silently kept reserving 2/1 — ~19% of a 16-slot
  // budget for the agent's OWN bank — so a dense additional/profile bank could
  // crowd out the agent's own recent context. The fix DERIVES the defaults from
  // the cap (own ≈ ⅓, additional ≈ ⅙). This test parameterises over the cap and
  // asserts the floors TRACK it: it would FAIL if someone raised the cap again
  // and the floors stayed put (the exact regression), or reverted the defaults
  // to fixed literals. `defaults.memory.recall.max_memories` cascades to the
  // agent, and the SAME cap is stamped into settings.json, so the floors bind
  // against it.
  it("default slot floors SCALE with the max_memories cap (never go stale)", () => {
    // [cap, expectedOwn, expectedAdditional] — own = round(cap/3), additional = round(cap/6).
    const cases: [number, number, number][] = [
      [6, 2, 1], // preserves the historical 2/1 the #3755 literals hardcoded
      [8, 3, 1], // resolver default
      [12, 4, 2], // vendor cap
      [16, 5, 3], // the live fleet cap the literals went stale against
      [24, 8, 4],
    ];
    for (const [cap, expectedOwn, expectedAdditional] of cases) {
      config.defaults = {
        memory: { recall: { max_memories: cap } },
      } as SwitchroomConfig["defaults"];
      const s = settingsAfterInstall();
      // The stamp derives the floors from the SAME cap it stamps into settings.
      expect(s.recallMaxMemories).toBe(cap);
      expect(s.recallOwnBankMinSlots, `own floor at cap ${cap}`).toBe(expectedOwn);
      expect(
        s.recallAdditionalBankMinSlots,
        `additional floor at cap ${cap}`,
      ).toBe(expectedAdditional);
      // The two floors must never exceed recall.py's half-cap reservation budget
      // (`_reservable_slots`), or the stamped numbers would be silently clamped
      // and the composition would stop moving with the scores. own ≈ ⅓ +
      // additional ≈ ⅙ = ½, so the derived pair sits exactly at the budget.
      expect(
        (s.recallOwnBankMinSlots as number) + (s.recallAdditionalBankMinSlots as number),
        `sum within half-cap budget at cap ${cap}`,
      ).toBeLessThanOrEqual(Math.floor(cap / 2));
      // Non-zero at both ends: even the smallest cap keeps an own-bank floor.
      expect(s.recallOwnBankMinSlots as number).toBeGreaterThan(0);
      expect(s.recallAdditionalBankMinSlots as number).toBeGreaterThan(0);
    }
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
