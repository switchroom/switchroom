/**
 * The committed CommonMark differential battery for the changelog guard's
 * masker (`scripts/check-changelog-entry.mjs`).
 *
 * The cases, the reference-implementation column, and the regeneration recipe
 * all live in `tests/fixtures/commonmark-mask-cases.mjs` — read that file first.
 * This file is only the assertion half:
 *
 *   1. the guard's `parseSections` output matches the `guardH2` column exactly;
 *   2. the `agrees` flag is CONSISTENT with the two columns, so a change that
 *      closes (or opens) a divergence cannot pass silently — it reds here and
 *      forces the table to be updated deliberately;
 *   3. the battery still covers both divergence directions and both of the
 *      overlapping-closer comment forms, so nobody can neuter it by deleting
 *      the interesting rows.
 *
 * Non-vacuity: against the pre-fix masker (`s.indexOf('-->', start + 4)`) the
 * two `<!-->` / `<!--->` rows FAIL here — the guard reports `["## Unreleased"]`
 * where the reference implementation renders both headings.
 */
import { describe, expect, it } from "vitest";
import { parseSections } from "../scripts/check-changelog-entry.mjs";
import { CASES } from "./fixtures/commonmark-mask-cases.mjs";

interface MaskCase {
  name: string;
  md: string;
  commonmarkH2: string[];
  guardH2: string[];
  agrees: boolean;
  divergence?: "fail-open" | "fail-closed" | null;
  why: string;
}

const cases = CASES as MaskCase[];

describe("check-changelog-entry — CommonMark differential battery", () => {
  it.each(cases.map((c) => [c.name, c] as const))(
    "%s",
    (_name, c) => {
      const guard = parseSections(c.md).map((s) => s.heading.trim());
      expect(guard).toEqual(c.guardH2);

      // The reference column, expressed the way the guard reports headings.
      const commonmark = c.commonmarkH2.map((h) => `## ${h}`);
      if (c.agrees) {
        expect(guard).toEqual(commonmark);
        expect(c.divergence ?? null).toBeNull();
      } else {
        expect(guard).not.toEqual(commonmark);
        expect(c.divergence).toMatch(/^fail-(open|closed)$/);
        // Direction check, so a mislabelled row cannot hide a fail-OPEN behind
        // the cheaper fail-CLOSED label: losing a heading the reference renders
        // is fail-open, inventing one it does not is fail-closed.
        const lost = commonmark.filter((h) => !guard.includes(h));
        expect(c.divergence).toBe(lost.length > 0 ? "fail-open" : "fail-closed");
      }
    },
  );

  it("keeps covering both divergence directions and both overlapping closers", () => {
    // A battery whose interesting rows have been deleted proves nothing.
    expect(cases.length).toBeGreaterThanOrEqual(31);
    expect(cases.filter((c) => c.divergence === "fail-open").length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.divergence === "fail-closed").length).toBeGreaterThan(0);
    for (const form of ["<!-->", "<!--->"]) {
      const row = cases.find((c) => c.md.includes(`\n${form}\n`));
      expect(row, `no battery row for a line-start ${form}`).toBeTruthy();
      // It must be a row where the guard AGREES — that is the fixed blocker.
      expect(row?.agrees).toBe(true);
    }
  });
});
