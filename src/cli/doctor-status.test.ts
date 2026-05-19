import { describe, it, expect, vi } from "vitest";

import { statusGlyph, type CheckStatus } from "./doctor-status.js";
import { printSection, type CheckResult } from "./doctor.js";

describe("statusGlyph", () => {
  it("returns a distinct non-empty glyph for every status (exhaustive)", () => {
    const statuses: CheckStatus[] = ["ok", "warn", "fail", "skip"];
    const glyphs = statuses.map(statusGlyph);
    for (const g of glyphs) expect(g.length).toBeGreaterThan(0);
    // All four visually distinct — skip must NOT look like warn.
    expect(new Set(glyphs).size).toBe(4);
    expect(statusGlyph("skip")).not.toBe(statusGlyph("warn"));
  });
});

describe("printSection — skip accounting", () => {
  it("counts skip separately and never folds it into warn/fail", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const results: CheckResult[] = [
        { name: "a", status: "ok" },
        { name: "b", status: "warn", fix: "do x" },
        { name: "c", status: "fail" },
        { name: "d", status: "skip", fix: "verify in-agent" },
        { name: "e", status: "skip" },
      ];
      const counts = printSection("T", results);
      expect(counts).toEqual({ oks: 1, warns: 1, fails: 1, skips: 2 });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still prints the how-to-verify line for a skip (honest, not hidden)", () => {
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => {
        lines.push(a.join(" "));
      });
    try {
      printSection("T", [
        { name: "d", status: "skip", fix: "run X to verify" },
      ]);
      expect(lines.some((l) => l.includes("run X to verify"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
