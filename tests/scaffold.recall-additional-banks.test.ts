import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHindsightPlugin } from "../src/agents/scaffold.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * Ship-B (RFC reference/rfcs/per-speaker-memory-routing.md): an agent's
 * `memory.recall.additional_banks` flows into the copied plugin
 * settings.json as `recallAdditionalBanks`, so the recall hook merges those
 * extra (shared / profile) banks into the agent's own bank results. This is
 * the static foundation for per-user memory routing.
 */
describe("hindsight recall — additional_banks → recallAdditionalBanks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `scaffold-addl-banks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function settingsFor(agentMemory: unknown): Record<string, unknown> {
    const config = {
      agents: { probe: { memory: agentMemory } },
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram: { bot_token: "t", forum_chat_id: "c" },
    } as unknown as SwitchroomConfig;
    const res = installHindsightPlugin("probe", tmpDir, config);
    expect(res).not.toBeNull();
    const p = join(tmpDir, ".claude", "plugins", "hindsight-memory", "settings.json");
    expect(existsSync(p)).toBe(true);
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  it("writes recallAdditionalBanks when memory.recall.additional_banks is set", () => {
    const s = settingsFor({ recall: { additional_banks: ["operator-profile", "household"] } });
    expect(s.recallAdditionalBanks).toEqual(["operator-profile", "household"]);
  });

  it("leaves recallAdditionalBanks at the vendor default when unset (no extra banks)", () => {
    const s = settingsFor({});
    // switchroom doesn't write the key when there are no extra banks; the
    // vendor's settings.json default ([]) stands.
    expect(s.recallAdditionalBanks ?? []).toEqual([]);
  });

  it("does not write the key for an empty additional_banks array", () => {
    const s = settingsFor({ recall: { additional_banks: [] } });
    expect(s.recallAdditionalBanks ?? []).toEqual([]);
  });

  it("regression: the Phase 1/6a recall overrides still apply alongside", () => {
    const s = settingsFor({ recall: { additional_banks: ["operator-profile"] } });
    expect(s.recallAdditionalBanks).toEqual(["operator-profile"]);
    expect(s.recallTypes).toContain("observation");
    expect(s.recallSkipTrivial).toBe(true);
    expect(s.recallMaxMemories).toBe(8);
  });
});
