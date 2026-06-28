/**
 * Unit tests for cron introspection — self-describing list rows + the
 * read-only doctor report. Covers the gymbro double-fire scenario:
 * two overlay entries sharing a cron expression must be cross-linked
 * (`duplicate_of`) and flagged by the doctor.
 */
import { describe, it, expect } from "vitest";
import { buildCronList, cronDoctor, normalizeCronExpr } from "./cron-introspect.js";
import { OVERLAY_SOURCE, OVERLAY_TITLE } from "../config/overlay-loader.js";

/** Forge an overlay-stamped entry the way the loader does (non-enumerable Symbols). */
function overlayEntry(
  fields: Record<string, unknown>,
  title?: string,
): Record<string, unknown> {
  const e = { ...fields };
  Object.defineProperty(e, OVERLAY_SOURCE, { value: true, enumerable: false });
  if (title !== undefined) {
    Object.defineProperty(e, OVERLAY_TITLE, { value: title, enumerable: false });
  }
  return e;
}

const FLAG = { cheapCronEnabled: true };

describe("normalizeCronExpr", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeCronExpr("  0   20  *  *  0 ")).toBe("0 20 * * 0");
  });
  it("returns null for non-strings / empty", () => {
    expect(normalizeCronExpr(undefined)).toBeNull();
    expect(normalizeCronExpr("   ")).toBeNull();
    expect(normalizeCronExpr(42)).toBeNull();
  });
});

describe("buildCronList — source labelling", () => {
  it("labels base-config and overlay entries with file + source", () => {
    const rows = buildCronList(
      [
        { cron: "0 8 * * *", prompt: "morning" },
        overlayEntry({ cron: "0 20 * * 0", prompt: "review" }, "weekly-review"),
      ],
      FLAG,
    );
    expect(rows[0]).toMatchObject({
      source: "base-config",
      file: "switchroom.yaml",
      cron: "0 8 * * *",
    });
    expect(rows[1]).toMatchObject({
      source: "overlay",
      file: "schedule.d/weekly-review.yaml",
      name: "weekly-review",
    });
  });

  it("preserves the original entry fields (backward compat)", () => {
    const rows = buildCronList([{ cron: "0 8 * * *", prompt: "p", kind: "prompt" }], FLAG);
    expect(rows[0].cron).toBe("0 8 * * *");
    expect(rows[0].prompt).toBe("p");
    expect(rows[0].kind).toBe("prompt");
  });

  it("resolves tier/context from the routing FSM", () => {
    const rows = buildCronList(
      [
        { cron: "0 8 * * *", prompt: "p", model: "sonnet" }, // cheap → fresh
        { cron: "0 9 * * *", prompt: "p" }, // default → main/agent
      ],
      FLAG,
    );
    expect(rows[0]).toMatchObject({ tier: "cheap", context: "fresh" });
    expect(rows[1]).toMatchObject({ tier: "main", context: "agent" });
  });
});

describe("buildCronList — duplicate cross-linking", () => {
  it("cross-links two entries sharing a cron expression (the double-fire)", () => {
    const rows = buildCronList(
      [
        overlayEntry({ cron: "0 20 * * 0", prompt: "review v1" }, "weekly-review"),
        overlayEntry({ cron: "0 20 * * 0", prompt: "review v2" }, "weekly-review-2"),
      ],
      FLAG,
    );
    expect(rows[0].duplicate_of).toEqual([
      { name: "weekly-review-2", file: "schedule.d/weekly-review-2.yaml" },
    ]);
    expect(rows[1].duplicate_of).toEqual([
      { name: "weekly-review", file: "schedule.d/weekly-review.yaml" },
    ]);
  });

  it("leaves duplicate_of unset for a unique cron expression", () => {
    const rows = buildCronList(
      [
        { cron: "0 8 * * *", prompt: "a" },
        { cron: "0 9 * * *", prompt: "b" },
      ],
      FLAG,
    );
    expect(rows[0].duplicate_of).toBeUndefined();
    expect(rows[1].duplicate_of).toBeUndefined();
  });

  it("treats whitespace-different exprs as the same cron", () => {
    const rows = buildCronList(
      [
        { cron: "0 20 * * 0", prompt: "a" },
        { cron: "0  20  *  *  0", prompt: "b" },
      ],
      FLAG,
    );
    expect(rows[0].duplicate_of).toHaveLength(1);
  });
});

describe("cronDoctor", () => {
  it("reports healthy for a clean schedule", () => {
    const r = cronDoctor("gymbro", [{ cron: "0 8 * * *", prompt: "p" }], FLAG);
    expect(r.healthy).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.entry_count).toBe(1);
  });

  it("flags duplicate cron expressions as an error", () => {
    const r = cronDoctor(
      "gymbro",
      [
        overlayEntry({ cron: "0 20 * * 0", prompt: "v1" }, "weekly-review"),
        overlayEntry({ cron: "0 20 * * 0", prompt: "v2" }, "weekly-review-2"),
      ],
      FLAG,
    );
    expect(r.healthy).toBe(false);
    const dup = r.findings.find((f) => f.kind === "duplicate_cron");
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe("error");
    expect(dup!.cron).toBe("0 20 * * 0");
    expect(dup!.entries).toHaveLength(2);
  });

  it("flags a base-vs-overlay name conflict as a warning", () => {
    const r = cronDoctor(
      "gymbro",
      [
        { cron: "0 8 * * *", prompt: "p", name: "digest" },
        overlayEntry({ cron: "0 9 * * *", prompt: "p" }, "digest"),
      ],
      FLAG,
    );
    const conflict = r.findings.find((f) => f.kind === "name_conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe("warn");
    expect(conflict!.conflicting_name).toBe("digest");
  });

  it("flags an entry with no valid cron expression as missing_tier", () => {
    const r = cronDoctor("gymbro", [{ prompt: "p", name: "broken" }], FLAG);
    const miss = r.findings.find((f) => f.kind === "missing_tier");
    expect(miss).toBeDefined();
    expect(miss!.entries[0]!.name).toBe("broken");
  });
});
