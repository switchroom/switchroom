/**
 * Tests for OverlayDocSchema (switchroom #1163, Phase B).
 *
 * Covers:
 *   - valid overlay shape with `schedule` array
 *   - rejection of unknown top-level keys
 *   - reuse of ScheduleEntrySchema for entry validation
 */
import { describe, expect, it } from "vitest";
import { OverlayDocSchema } from "./overlay-schema.js";

describe("OverlayDocSchema", () => {
  it("accepts a valid overlay with a schedule array", () => {
    const parsed = OverlayDocSchema.parse({
      schedule: [
        { cron: "0 8 * * *", prompt: "morning brief" },
      ],
    });
    expect(parsed.schedule).toHaveLength(1);
    // ScheduleEntrySchema defaults secrets to [] — confirms we reused it.
    expect(parsed.schedule?.[0].secrets).toEqual([]);
  });

  it("accepts an empty overlay (both keys omitted)", () => {
    expect(() => OverlayDocSchema.parse({})).not.toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      OverlayDocSchema.parse({
        schedule: [],
        // Typo / injection of a real config field — must NOT silently merge.
        agents: { evil: {} },
      }),
    ).toThrow();
  });

  it("rejects when schedule entry is missing required fields (reuses ScheduleEntrySchema)", () => {
    expect(() =>
      OverlayDocSchema.parse({
        schedule: [{ cron: "0 8 * * *" /* missing prompt */ }],
      }),
    ).toThrow();
  });

  it("accepts skills:[] as a reserved-but-typed key", () => {
    const parsed = OverlayDocSchema.parse({ skills: ["my-skill"] });
    expect(parsed.skills).toEqual(["my-skill"]);
  });
});
