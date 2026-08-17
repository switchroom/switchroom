/**
 * Outcome tests for the residue-measurement harness
 * (carve-M2.md T4, TDD-d/UAT-5 — the downstream number that sets M3's rules
 * budget).
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDirectiveTriageRows } from "../src/memory/directive-triage.js";
import type { DirectiveTriageOverride } from "../src/memory/directive-triage.js";
import {
  measureDirectiveResidue,
  writeDirectiveResidueArtifact,
} from "../src/memory/directive-residue.js";
import type { HindsightDirective } from "../src/memory/hindsight-directive-admin.js";

function directive(o: Partial<HindsightDirective> & { id: string; name: string }): HindsightDirective {
  return { priority: 0, is_active: true, tags: [], content: "text", ...o };
}

describe("measureDirectiveResidue — counts only rules-block + reflect-directive rows", () => {
  it("excludes retire / disposition / retain-as-memory rows from the residue", () => {
    const directives: HindsightDirective[] = [
      directive({ id: "1", name: "keep-guardrail", content: "A" }),
      directive({ id: "2", name: "staged-rule", content: "B" }),
      directive({ id: "3", name: "retiring", content: "C", tags: ["superseded-by:keep-guardrail"] }),
      directive({ id: "4", name: "disp", content: "D" }),
    ];
    const overrides = new Map<string, DirectiveTriageOverride>([
      ["staged-rule", { category: "rules-block", signal: "destined for rules block" }],
      ["disp", { category: "disposition", signal: "belongs in disposition config" }],
    ]);
    const rows = buildDirectiveTriageRows(directives, overrides);
    const byName = new Map(directives.map((d) => [d.name, d]));

    const measurement = measureDirectiveResidue("test-agent", rows, byName);

    expect(measurement.residueDirectiveCount).toBe(2); // keep-guardrail + staged-rule
    expect(measurement.totalDirectiveCount).toBe(4);
    expect(measurement.residueBytes).toBeGreaterThan(0);
    expect(measurement.residueTokensEstimate).toBeGreaterThan(0);
  });

  it("anti-vacuity: an all-retired set produces a ZERO residue, not a silently-passing empty measurement", () => {
    const directives: HindsightDirective[] = [
      directive({ id: "1", name: "only-one", content: "X", tags: ["superseded-by:elsewhere"] }),
    ];
    const rows = buildDirectiveTriageRows(directives);
    const byName = new Map(directives.map((d) => [d.name, d]));
    const measurement = measureDirectiveResidue("test-agent", rows, byName);
    expect(measurement.residueDirectiveCount).toBe(0);
    expect(measurement.residueBytes).toBe(0);
    expect(measurement.residueTokensEstimate).toBe(0);
  });

  it("throws rather than silently under-measuring when a row has no matching directive", () => {
    const directives: HindsightDirective[] = [directive({ id: "1", name: "a", content: "X" })];
    const rows = buildDirectiveTriageRows(directives);
    const emptyMap = new Map<string, HindsightDirective>();
    expect(() => measureDirectiveResidue("test-agent", rows, emptyMap)).toThrow();
  });
});

describe("writeDirectiveResidueArtifact — durable per-agent artifact", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the artifact with a header and appends one row per agent", () => {
    dir = mkdtempSync(join(tmpdir(), "m2-residue-"));
    const path = join(dir, "m2-residue.md");

    writeDirectiveResidueArtifact(path, {
      agent: "klanker",
      residueDirectiveCount: 20,
      totalDirectiveCount: 24,
      residueBytes: 4000,
      residueTokensEstimate: 1081,
    });
    writeDirectiveResidueArtifact(path, {
      agent: "overlord",
      residueDirectiveCount: 22,
      totalDirectiveCount: 26,
      residueBytes: 6000,
      residueTokensEstimate: 1622,
    });

    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("# M2 residue measurement");
    expect(content).toContain("| klanker | 20 | 24 | 4000 | 1081 |");
    expect(content).toContain("| overlord | 22 | 26 | 6000 | 1622 |");
    // Header written exactly once even across two calls.
    expect(content.match(/# M2 residue measurement/g)).toHaveLength(1);
  });
});
