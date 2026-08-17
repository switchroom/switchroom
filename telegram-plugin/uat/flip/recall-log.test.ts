/**
 * Unit suite for the recall_log.jsonl reader + directive-injection delta. Runs
 * under `bun test` (this tree is vitest-excluded) via the `uat/flip/` entry in
 * telegram-plugin/scripts/bun-test-ci.sh. Hermetic: a tmp agents dir per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRecallLog,
  recallLogPath,
  summarizeInjection,
  directiveInjectionDelta,
  partitionByFlip,
  type RecallLogRow,
} from "./recall-log.js";

let agentsDir: string;
let root: string;

function writeLog(agent: string, rows: unknown[], opts: { trailingGarbage?: boolean } = {}): void {
  const p = recallLogPath(agentsDir, agent);
  mkdirSync(join(p, ".."), { recursive: true });
  let body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (opts.trailingGarbage) body += '{"ts":"2026-08-18T00:00:05Z","directi';
  writeFileSync(p, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sr-uat-recall-log-"));
  agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readRecallLog", () => {
  it("parses rows in file order and skips a trailing partial line", () => {
    writeLog(
      "ziggy",
      [
        { ts: "2026-08-18T00:00:01Z", directive_count: 6, directive_ids: ["a", "b"] },
        { ts: "2026-08-18T00:00:02Z", directive_count: 6, directive_ids: ["a", "b"] },
      ],
      { trailingGarbage: true },
    );
    const rows = readRecallLog("ziggy", { agentsDir });
    expect(rows).toHaveLength(2);
    expect(rows[0].directive_count).toBe(6);
  });

  it("returns empty for a missing log", () => {
    expect(readRecallLog("ghost", { agentsDir })).toEqual([]);
  });

  it("honours tail", () => {
    writeLog(
      "ziggy",
      Array.from({ length: 5 }, (_, i) => ({ ts: `2026-08-18T00:00:0${i}Z`, directive_count: i })),
    );
    const rows = readRecallLog("ziggy", { agentsDir, tail: 2 });
    expect(rows.map((r) => r.directive_count)).toEqual([3, 4]);
  });
});

describe("summarizeInjection", () => {
  it("computes peak count, last count, id union, and peak omitted", () => {
    const rows: RecallLogRow[] = [
      { directive_count: 4, directives_omitted: 0, directive_ids: ["a", "b"] },
      { directive_count: 6, directives_omitted: 2, directive_ids: ["a", "c"] },
      { directive_count: 5, directives_omitted: 1, directive_ids: ["a"] },
    ];
    const s = summarizeInjection(rows);
    expect(s.rowCount).toBe(3);
    expect(s.maxDirectiveCount).toBe(6);
    expect(s.lastDirectiveCount).toBe(5);
    expect(s.everInjectedIds.sort()).toEqual(["a", "b", "c"]);
    expect(s.maxDirectivesOmitted).toBe(2);
  });

  it("treats null/absent counts as zero and empty window as null last", () => {
    expect(summarizeInjection([]).lastDirectiveCount).toBeNull();
    const s = summarizeInjection([{ directive_count: null, directive_ids: null }]);
    expect(s.maxDirectiveCount).toBe(0);
    expect(s.everInjectedIds).toEqual([]);
  });
});

describe("directiveInjectionDelta", () => {
  it("reports full suppression after the flip", () => {
    const baseline: RecallLogRow[] = [
      { directive_count: 6, directive_ids: ["a", "b", "c", "d", "e", "f"] },
    ];
    const postflip: RecallLogRow[] = [
      { directive_count: 0, directive_ids: [] },
      { directive_count: 0, directive_ids: [] },
    ];
    const d = directiveInjectionDelta(baseline, postflip);
    expect(d.volumeDelta).toBe(6);
    expect(d.postflipFullySuppressed).toBe(true);
    expect(d.residualIds).toEqual([]);
  });

  it("flags residual injection when the flip did not take", () => {
    const d = directiveInjectionDelta(
      [{ directive_count: 6, directive_ids: ["a", "b"] }],
      [{ directive_count: 2, directive_ids: ["a", "z"] }],
    );
    expect(d.postflipFullySuppressed).toBe(false);
    expect(d.residualIds.sort()).toEqual(["a", "z"]);
    expect(d.volumeDelta).toBe(4);
  });
});

describe("partitionByFlip", () => {
  it("splits rows at the flip timestamp; ts-less rows are baseline", () => {
    const rows: RecallLogRow[] = [
      { ts: "2026-08-18T00:00:00Z", directive_count: 6 },
      { directive_count: 6 }, // no ts → baseline
      { ts: "2026-08-18T01:00:00Z", directive_count: 0 },
    ];
    const { baseline, postflip } = partitionByFlip(rows, "2026-08-18T00:30:00Z");
    expect(baseline).toHaveLength(2);
    expect(postflip).toHaveLength(1);
    expect(postflip[0].directive_count).toBe(0);
  });
});
