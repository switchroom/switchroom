import { describe, it, expect } from "vitest";
import { SWITCHROOM_MODELS, configuredModel } from "../../src/web/hermes-adapter.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

/**
 * Regression coverage for the Hermes model picker (goal #2757, gap 3).
 *
 * The picker must offer the family ALIASES the claude CLI resolves itself
 * (fable/opus/sonnet/haiku) — never pinned concrete ids. The pinned id
 * `claude-fable-5` was retired server-side and 4xx'd the fleet on 2026-06-13
 * (see telegram-plugin/gateway/model-command.ts MODEL_ALIASES); injecting a
 * pinned id via `/model` reproduces that incident from the desktop UI.
 *
 * model.info must report the agent's configured model from switchroom.yaml,
 * not a hardcoded constant.
 */

describe("SWITCHROOM_MODELS — family aliases only", () => {
  it("lists exactly the CLI-resolvable family aliases", () => {
    expect(SWITCHROOM_MODELS).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });

  it("contains no pinned concrete model ids (the 2026-06-13 fable-5 incident class)", () => {
    for (const m of SWITCHROOM_MODELS) {
      expect(m).not.toMatch(/^claude-/);
      expect(m).not.toMatch(/\d/);
    }
  });
});

describe("configuredModel — model.info source", () => {
  const cfg = (overrides: Partial<SwitchroomConfig>): SwitchroomConfig =>
    overrides as SwitchroomConfig;

  it("prefers the per-agent model override", () => {
    const config = cfg({
      defaults: { model: "opus" },
      agents: { overlord: { model: "fable" } },
    } as Partial<SwitchroomConfig>);
    expect(configuredModel(config, "overlord")).toBe("fable");
  });

  it("falls back to defaults.model when the agent has no override", () => {
    const config = cfg({
      defaults: { model: "opus" },
      agents: { overlord: {} },
    } as Partial<SwitchroomConfig>);
    expect(configuredModel(config, "overlord")).toBe("opus");
  });

  it("falls back to the sonnet family alias when nothing is configured", () => {
    expect(configuredModel(cfg({}))).toBe("sonnet");
    expect(configuredModel(cfg({}), "unknown-agent")).toBe("sonnet");
  });

  it("uses defaults.model when no agent name is given (HTTP /api/model/info)", () => {
    const config = cfg({ defaults: { model: "haiku" } } as Partial<SwitchroomConfig>);
    expect(configuredModel(config)).toBe("haiku");
  });
});
