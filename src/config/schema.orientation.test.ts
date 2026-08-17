import { describe, it, expect } from "vitest";
import {
  AgentMemorySchema,
  AgentSchema,
  AgentDefaultsSchema,
  ProfileSchema,
} from "./schema.js";
import { resolveAgentConfig } from "./merge.js";
import { resolveHindsightOrientationSettings } from "../agents/scaffold.js";

/**
 * Memory v2 M5 (Surface B: orientation-at-boot) — schema + resolver contract.
 *
 * These pin the OUTCOMES the dark kill switch depends on, not the mere presence
 * of a key:
 *  - the three keys are `.optional()` (no Zod default) — a hard default would
 *    shadow the per-agent value in the cascade the way it does every other
 *    memory knob (the reflect_budget/directive_capture_nudge pattern). The
 *    EFFECTIVE defaults (off / 0 / 48) live in the scaffold resolver.
 *  - fail-safe resolution: an un-flipped agent resolves enabled=false (dark),
 *    reinject=0, cadence=48 — byte-identical to pre-M5, on the cheaper tier.
 *  - per-agent-ONLY enablement: `orientation` and `orientation_reinject_turns`
 *    set at the defaults/profile tier are STRIPPED (never fleet-seeded), so a
 *    single defaults-tier value can never flip injection on across the fleet —
 *    the M4 "flips fleet-wide at merge" footgun, closed by construction.
 *  - `orientation_cadence_hours` IS mirrored at the defaults tier (a safe cost/
 *    tiering knob) and cascades into an agent that omits it.
 */
describe("M5 orientation schema — optional, no cascade-shadowing default", () => {
  it("per-agent parse leaves all three keys undefined (optional, no Zod default)", () => {
    const m = AgentMemorySchema.parse({ collection: "b" })!;
    expect(m.orientation).toBeUndefined();
    expect(m.orientation_reinject_turns).toBeUndefined();
    expect(m.orientation_cadence_hours).toBeUndefined();
  });

  it("rejects a negative reinject and a zero/negative cadence", () => {
    // collection is present so the throw is specifically the field constraint,
    // not the required-collection error.
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", orientation_reinject_turns: -1 }),
    ).toThrow();
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", orientation_cadence_hours: 0 }),
    ).toThrow();
  });

  it("accepts explicit valid per-agent values", () => {
    const m = AgentMemorySchema.parse({
      collection: "b",
      orientation: true,
      orientation_reinject_turns: 20,
      orientation_cadence_hours: 24,
    })!;
    expect(m.orientation).toBe(true);
    expect(m.orientation_reinject_turns).toBe(20);
    expect(m.orientation_cadence_hours).toBe(24);
  });
});

describe("M5 orientation resolver — fail-safe effective defaults", () => {
  it("a bare agent resolves dark: enabled=false, reinject=0, cadence=48", () => {
    const agent = AgentSchema.parse({ topic_name: "ops", memory: { collection: "b" } });
    const s = resolveHindsightOrientationSettings(undefined, "ops", agent);
    expect(s.enabled).toBe(false);
    expect(s.reinjectTurns).toBe(0);
    expect(s.cadenceHours).toBe(48);
    expect(s.model).toBe("orientation");
  });

  it("per-agent orientation:true resolves enabled=true", () => {
    const agent = AgentSchema.parse({
      topic_name: "ops",
      memory: { collection: "b", orientation: true, orientation_cadence_hours: 24 },
    });
    const s = resolveHindsightOrientationSettings(undefined, "ops", agent);
    expect(s.enabled).toBe(true);
    expect(s.cadenceHours).toBe(24);
  });
});

describe("M5 orientation schema — per-agent-only enablement (darkness safeguard)", () => {
  it("defaults tier STRIPS orientation (never fleet-seeded)", () => {
    const d = AgentDefaultsSchema.parse({ memory: { orientation: true } });
    expect((d!.memory as Record<string, unknown>).orientation).toBeUndefined();
  });

  it("defaults tier STRIPS orientation_reinject_turns (never fleet-seeded)", () => {
    const d = AgentDefaultsSchema.parse({ memory: { orientation_reinject_turns: 5 } });
    expect(
      (d!.memory as Record<string, unknown>).orientation_reinject_turns,
    ).toBeUndefined();
  });

  it("profile tier STRIPS orientation too", () => {
    const p = ProfileSchema.parse({ memory: { orientation: true } });
    expect((p.memory as Record<string, unknown> | undefined)?.orientation).toBeUndefined();
  });

  it("even with defaults-tier orientation:true, a bare agent resolves dark", () => {
    // End-to-end: the cascade can never hand an un-flipped agent an enabled
    // orientation from the fleet default (the stripped key is not in `defaults`
    // to cascade, and the resolver's effective default is false).
    const defaults = AgentDefaultsSchema.parse({ memory: { orientation: true } });
    const agent = AgentSchema.parse({ topic_name: "ops", memory: { collection: "b" } });
    const resolved = resolveAgentConfig(defaults, undefined, agent);
    expect(resolved.memory?.orientation).not.toBe(true);
    const s = resolveHindsightOrientationSettings(undefined, "ops", resolved);
    expect(s.enabled).toBe(false);
  });
});

describe("M5 orientation schema — cadence mirrors + cascades", () => {
  it("defaults tier ACCEPTS orientation_cadence_hours and it cascades to a bare agent", () => {
    const defaults = AgentDefaultsSchema.parse({
      memory: { orientation_cadence_hours: 24 },
    });
    expect(defaults!.memory!.orientation_cadence_hours).toBe(24);
    const agent = AgentSchema.parse({ topic_name: "ops", memory: { collection: "b" } });
    const resolved = resolveAgentConfig(defaults, undefined, agent);
    expect(resolved.memory?.orientation_cadence_hours).toBe(24);
    const s = resolveHindsightOrientationSettings(undefined, "ops", resolved);
    expect(s.cadenceHours).toBe(24);
  });

  it("per-agent cadence overrides the fleet default", () => {
    const defaults = AgentDefaultsSchema.parse({
      memory: { orientation_cadence_hours: 48 },
    });
    const agent = AgentSchema.parse({
      topic_name: "ops",
      memory: { collection: "b", orientation_cadence_hours: 24 },
    });
    const resolved = resolveAgentConfig(defaults, undefined, agent);
    expect(resolved.memory?.orientation_cadence_hours).toBe(24);
  });
});
