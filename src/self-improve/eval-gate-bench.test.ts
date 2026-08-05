/**
 * PR2 — the benchmark SURFACE. These tests pin the two pure pieces the
 * `bench` CLI leans on:
 *   - `isBenchmarkDir` / `resolveBenchmarkDir` — filesystem-only benchmark
 *     dir discovery (NEVER runs an eval — claude-native constraint);
 *   - end-to-end verdict math through the REAL `aggregate_benchmark.py`
 *     (fabricated grading files → known mean → known verdict).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isBenchmarkDir,
  resolveBenchmarkDir,
  aggregateBenchmark,
  evalVerdict,
} from "./eval-gate.js";

// The repo root that carries skills/skill-creator/scripts/aggregate_benchmark.py.
// This test file lives at <repo>/src/self-improve, so ../.. is <repo>.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Write one grading.json for eval `evalIdx`, config, run `runNo`. */
function writeGrading(
  benchDir: string,
  evalIdx: number,
  config: string,
  runNo: number,
  passRate: number,
): void {
  const runDir = join(benchDir, `eval-${evalIdx}`, config, `run-${runNo}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "grading.json"),
    JSON.stringify({
      summary: {
        pass_rate: passRate,
        passed: Math.round(passRate * 2),
        failed: 2 - Math.round(passRate * 2),
        total: 2,
      },
    }),
  );
}

describe("benchmark dir discovery (no eval ever runs)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-disc-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("recognises a dir with eval-*/ subdirs", () => {
    writeGrading(root, 0, "with_skill", 1, 1.0);
    expect(isBenchmarkDir(root)).toBe(true);
    expect(resolveBenchmarkDir(root)).toBe(root);
  });

  it("recognises the legacy runs/ layout", () => {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    writeGrading(runs, 0, "with_skill", 1, 1.0);
    expect(isBenchmarkDir(root)).toBe(true);
  });

  it("rejects a dir with no eval-*/ grading files", () => {
    mkdirSync(join(root, "not-an-eval"), { recursive: true });
    expect(isBenchmarkDir(root)).toBe(false);
    expect(resolveBenchmarkDir(root)).toBeNull();
  });

  it("picks the MOST-RECENT benchmark subdir when base holds timestamped dirs", () => {
    const older = join(root, "2026-08-01T00-00-00");
    const newer = join(root, "2026-08-05T00-00-00");
    writeGrading(older, 0, "with_skill", 1, 0.5);
    writeGrading(newer, 0, "with_skill", 1, 1.0);
    // Force newer to have a later mtime regardless of creation order.
    const future = Date.now() / 1000 + 100;
    utimesSync(newer, future, future);
    expect(resolveBenchmarkDir(root)).toBe(newer);
  });

  it("honours an explicit benchmark dir, validating it", () => {
    writeGrading(root, 0, "with_skill", 1, 1.0);
    expect(resolveBenchmarkDir("/nonexistent", root)).toBe(root);
    expect(resolveBenchmarkDir(root, "/nonexistent")).toBeNull();
  });
});

describe("verdict math end-to-end through the real aggregate_benchmark.py", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-e2e-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("PASSES when candidate hits the floor and beats baseline", () => {
    // with_skill mean = (1.0 + 1.0)/2 = 1.0 ; without_skill mean = 0.5
    writeGrading(root, 0, "with_skill", 1, 1.0);
    writeGrading(root, 0, "with_skill", 2, 1.0);
    writeGrading(root, 0, "without_skill", 1, 0.5);
    writeGrading(root, 0, "without_skill", 2, 0.5);

    const agg = aggregateBenchmark(root, REPO_ROOT);
    expect(agg.ok).toBe(true);
    const verdict = evalVerdict(agg.benchmarkJson!);
    expect(verdict.pass).toBe(true);
    if (verdict.pass) {
      expect(verdict.candidatePassRate).toBe(1.0);
      expect(verdict.baselinePassRate).toBe(0.5);
    }
  });

  it("FAILS (below floor) when the candidate does not fully pass", () => {
    // with_skill mean = 0.5 — below the default floor of 1.0.
    writeGrading(root, 0, "with_skill", 1, 0.5);
    writeGrading(root, 0, "without_skill", 1, 0.5);

    const agg = aggregateBenchmark(root, REPO_ROOT);
    expect(agg.ok).toBe(true);
    const verdict = evalVerdict(agg.benchmarkJson!);
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.reason).toMatch(/below floor/);
      expect(verdict.candidatePassRate).toBe(0.5);
    }
  });

  it("errors cleanly when the aggregator script is missing", () => {
    writeGrading(root, 0, "with_skill", 1, 1.0);
    const agg = aggregateBenchmark(root, join(root, "no-such-repo"));
    expect(agg.ok).toBe(false);
    expect(agg.error).toMatch(/aggregate_benchmark\.py not found/);
  });
});
