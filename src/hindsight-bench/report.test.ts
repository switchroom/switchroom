import { describe, it, expect } from "vitest";
import { makeCell, makeResult } from "./fixtures.js";
import { summarize } from "./stats.js";
import {
  CONTENTION_MIN_REL_DELTA,
  DEFAULT_TOLERANCE,
  compareContention,
  compareRuns,
  duplicateCellKeys,
  formatContention,
  formatReproducibility,
  formatSummary,
  toCsv,
  ungradeableCells,
} from "./report.js";
import type { BenchResult } from "./types.js";

describe("compareRuns (AC1)", () => {
  it("passes when every cell's p95 is within tolerance", () => {
    const a = makeResult([makeCell("big", 228761, 1, 1000), makeCell("big", 228761, 4, 2000)]);
    const b = makeResult([makeCell("big", 228761, 1, 1050), makeCell("big", 228761, 4, 1900)]);
    const rep = compareRuns(a, b);
    expect(rep.pass).toBe(true);
    expect(rep.cells).toHaveLength(2);
    expect(rep.worstRelDelta).toBeCloseTo(0.05, 6);
  });

  it("FAILS when a single cell moves beyond tolerance", () => {
    // The gate's whole job. If this test passes with a broken gate the harness
    // is decorative.
    const a = makeResult([makeCell("big", 228761, 1, 1000), makeCell("big", 228761, 4, 2000)]);
    const b = makeResult([makeCell("big", 228761, 1, 1050), makeCell("big", 228761, 4, 2400)]);
    const rep = compareRuns(a, b);
    expect(rep.pass).toBe(false);
    expect(rep.worstRelDelta).toBeCloseTo(0.2, 6);
    expect(rep.cells.filter((c) => !c.within).map((c) => c.concurrency)).toEqual([4]);
  });

  it("treats the boundary as inclusive", () => {
    const a = makeResult([makeCell("big", 10, 1, 1000)]);
    const b = makeResult([makeCell("big", 10, 1, 1100)]);
    expect(compareRuns(a, b).pass).toBe(true);
    expect(compareRuns(a, makeResult([makeCell("big", 10, 1, 1101)])).pass).toBe(false);
  });

  it("normalises against run A, not the mean of the pair", () => {
    const rep = compareRuns(makeResult([makeCell("b", 10, 1, 100)]), makeResult([makeCell("b", 10, 1, 200)]));
    // |200-100|/100 = 1.0. A symmetric normalisation would report ~0.67.
    expect(rep.cells[0]?.relDelta).toBeCloseTo(1, 6);
  });

  it("fails outright when a cell exists in only one run", () => {
    const a = makeResult([makeCell("big", 10, 1, 1000), makeCell("small", 5, 1, 900)]);
    const b = makeResult([makeCell("big", 10, 1, 1000)]);
    const rep = compareRuns(a, b);
    expect(rep.pass).toBe(false);
    expect(rep.unmatched).toEqual(["small@c1"]);
  });

  it("fails on a cell present only in run B (measuring more is still a mismatch)", () => {
    const a = makeResult([makeCell("big", 10, 1, 1000)]);
    const b = makeResult([makeCell("big", 10, 1, 1000), makeCell("small", 5, 1, 900)]);
    const rep = compareRuns(a, b);
    expect(rep.pass).toBe(false);
    expect(rep.unmatched).toEqual(["small@c1"]);
  });

  it("treats an all-error reference cell as ungradeable rather than dividing by NaN", () => {
    const dead = makeCell("big", 10, 1, 1000);
    dead.samplesMs = [];
    dead.stats = { ...dead.stats, n: 0, errors: 20, p95: NaN };
    const rep = compareRuns(makeResult([dead]), makeResult([makeCell("big", 10, 1, 1000)]));
    expect(rep.pass).toBe(false);
    // "ungradeable", not "unmatched": the cell IS in both runs, the measurement
    // failed there. Reporting it as missing would send a reader looking for a
    // sweep-configuration difference that does not exist.
    expect(rep.unmatched).toEqual([]);
    expect(rep.ungradeable).toEqual(["big@c1 (no-samples, 20 errors)"]);
  });

  it("does not pass an empty comparison", () => {
    expect(compareRuns(makeResult([]), makeResult([])).pass).toBe(false);
  });

  it("honours a custom tolerance", () => {
    const a = makeResult([makeCell("b", 10, 1, 1000)]);
    const b = makeResult([makeCell("b", 10, 1, 1150)]);
    expect(compareRuns(a, b, DEFAULT_TOLERANCE).pass).toBe(false);
    expect(compareRuns(a, b, 0.2).pass).toBe(true);
  });
});

describe("compareContention (AC4)", () => {
  const idle = makeResult([
    makeCell("big", 100, 1, 1000),
    makeCell("big", 100, 4, 1500),
    makeCell("small", 10, 1, 500),
  ]);

  it("passes when contention raises p95 in a majority of cells by ≥ the threshold", () => {
    const loaded = makeResult([
      makeCell("big", 100, 1, 1400),
      makeCell("big", 100, 4, 2200),
      makeCell("small", 10, 1, 700),
    ]);
    const rep = compareContention(idle, loaded);
    expect(rep.pass).toBe(true);
    expect(rep.raised).toBe(3);
    expect(rep.medianRelDelta).toBeGreaterThan(CONTENTION_MIN_REL_DELTA);
  });

  it("FAILS when the load generator does not move p95", () => {
    // A load generator that burns CPU without touching the tail is broken, and
    // the harness must say so rather than reporting a green run.
    const loaded = makeResult([
      makeCell("big", 100, 1, 1010),
      makeCell("big", 100, 4, 1490),
      makeCell("small", 10, 1, 505),
    ]);
    expect(compareContention(idle, loaded).pass).toBe(false);
  });

  it("FAILS when only one cell moves a lot", () => {
    const loaded = makeResult([
      makeCell("big", 100, 1, 5000),
      makeCell("big", 100, 4, 1490),
      makeCell("small", 10, 1, 495),
    ]);
    const rep = compareContention(idle, loaded);
    expect(rep.raised).toBe(1);
    expect(rep.pass).toBe(false);
  });

  it("does not pass with no matched cells", () => {
    expect(compareContention(idle, makeResult([])).pass).toBe(false);
  });

  it("REFUSES to pass when a cell of the contended run died mid-sweep", () => {
    // Observed live 2026-08-07: the Hindsight container was recreated during a
    // contended sweep, so two of ten cells recorded nothing. The remaining
    // eight still cleared the threshold, and before this the verdict skipped
    // the dead cells silently and printed PASS over a sweep that had partly
    // failed. A verdict over the survivors is not a verdict over the run.
    const dead = makeCell("small", 10, 1, 700);
    dead.samplesMs = [];
    dead.stats = { ...dead.stats, n: 0, errors: 40, p95: NaN };
    const loaded = makeResult([makeCell("big", 100, 1, 1400), makeCell("big", 100, 4, 2200), dead]);
    const rep = compareContention(idle, loaded);
    expect(rep.raised).toBe(2);
    expect(rep.medianRelDelta).toBeGreaterThan(CONTENTION_MIN_REL_DELTA);
    expect(rep.ungradeable).toEqual(["small@c1 (no-samples, 40 errors)"]);
    expect(rep.pass).toBe(false);
  });

  it("REFUSES to grade a cell whose survivors are a biased subset", () => {
    // n=6 of 40 with 34 timeouts still yields a percentile — of whichever calls
    // were fast enough not to time out. Graded naively that cell reads as the
    // fastest in the run, which is the exact inverse of the truth.
    const biased = makeCell("small", 10, 1, 700);
    biased.stats = { ...biased.stats, n: 6, errors: 34 };
    const loaded = makeResult([makeCell("big", 100, 1, 1400), makeCell("big", 100, 4, 2200), biased]);
    const rep = compareContention(idle, loaded);
    expect(rep.ungradeable).toEqual(["small@c1 (error-rate 85%, n=6)"]);
    expect(rep.pass).toBe(false);
  });

  it("tolerates an error rate at the documented ceiling", () => {
    const ok = makeCell("small", 10, 1, 700);
    ok.stats = { ...ok.stats, n: 18, errors: 2 }; // 10 %, exactly at the cap
    const loaded = makeResult([makeCell("big", 100, 1, 1400), makeCell("big", 100, 4, 2200), ok]);
    const rep = compareContention(idle, loaded);
    expect(rep.ungradeable).toEqual([]);
    expect(rep.pass).toBe(true);
  });
});

describe("ungradeableCells", () => {
  it("blocks an AC1 pass when either run has a dead cell", () => {
    const dead = makeCell("big", 10, 1, 1000);
    dead.samplesMs = [];
    dead.stats = { ...dead.stats, n: 0, errors: 20, p95: NaN };
    const rep = compareRuns(
      makeResult([makeCell("big", 10, 1, 1000), makeCell("small", 5, 1, 900)]),
      makeResult([dead, makeCell("small", 5, 1, 900)]),
    );
    expect(rep.ungradeable).toEqual(["big@c1 (no-samples, 20 errors)"]);
    // the surviving cell is identical in both runs, so without the gate this
    // comparison would have reported a clean PASS.
    expect(rep.cells.map((c) => c.relDelta)).toEqual([0]);
    expect(rep.pass).toBe(false);
  });

  it("names both failure modes on a real-shaped result", () => {
    const dead = makeCell("a", 10, 1, 100);
    dead.samplesMs = [];
    dead.stats = { ...dead.stats, n: 0, errors: 40, p95: NaN };
    const biased = makeCell("b", 10, 4, 100);
    biased.stats = { ...biased.stats, n: 6, errors: 34 };
    expect(ungradeableCells(makeResult([dead, biased, makeCell("c", 10, 1, 100)]))).toEqual([
      "a@c1 (no-samples, 40 errors)",
      "b@c4 (error-rate 85%, n=6)",
    ]);
  });
});

describe("rendering", () => {
  const r = makeResult([makeCell("big", 228761, 1, 1000), makeCell("small", 12, 1, 200)]);

  it("summary states the db context a number was measured against", () => {
    const out = formatSummary(r);
    expect(out).toContain("shared_buffers");
    expect(out).toContain("working set / shared_buffers");
    // The `null` stats_reset caveat must be visible, not silently rendered blank.
    expect(out).toContain("NEVER");
    expect(out).toContain("big");
    expect(out).toContain("228761");
  });

  it("summary renders a non-finite percentile as '-' rather than 0", () => {
    const dead = makeCell("big", 10, 1, 1000);
    dead.stats = { ...dead.stats, n: 0, errors: 5, p50: NaN, p95: NaN, p99: NaN, max: NaN, cv: NaN };
    const out = formatSummary(makeResult([dead]));
    expect(out).not.toMatch(/\b0\s+0\s+0\b/);
    expect(out).toContain("-");
  });

  it("summary calls out a cell whose recalls returned nothing", () => {
    const empty = makeCell("big", 100, 1, 50);
    empty.meanResults = 0;
    empty.zeroResultCalls = 20;
    const out = formatSummary(makeResult([empty]));
    expect(out).toContain("zero-result recalls");
    expect(out).toContain("20/20 empty");
  });

  it("summary says nothing about zero-result cells when there are none", () => {
    expect(formatSummary(r)).not.toContain("zero-result recalls");
  });

  it("csv has one header plus one row per cell and is diffable", () => {
    const lines = toCsv(r).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("p95_ms");
    expect(lines[1]).toContain("big,228761,1");
    expect(toCsv(r)).toBe(toCsv(r));
  });

  it("verdict renderings state PASS/FAIL explicitly", () => {
    const good = formatReproducibility(compareRuns(r, r));
    expect(good).toContain("PASS");
    const bad = formatReproducibility(compareRuns(r, makeResult([makeCell("big", 228761, 1, 9999)])));
    expect(bad).toContain("FAIL");
    expect(formatContention(compareContention(r, r))).toContain("FAIL");
  });
});

describe("duplicateCellKeys", () => {
  it("returns nothing for a well-formed sweep", () => {
    const cells = [
      { bank: "a", concurrency: 1 },
      { bank: "a", concurrency: 4 },
      { bank: "b", concurrency: 1 },
    ];
    expect(duplicateCellKeys(cells)).toEqual([]);
  });

  it("names each repeated (bank, concurrency) pair exactly once", () => {
    // Without this guard the verdict's Map keeps only the LAST occurrence and
    // still prints a confident PASS/FAIL over a pairing that is not the cell
    // the operator thinks they are reading.
    const cells = [
      { bank: "a", concurrency: 1 },
      { bank: "a", concurrency: 1 },
      { bank: "a", concurrency: 1 },
      { bank: "b", concurrency: 4 },
    ];
    expect(duplicateCellKeys(cells)).toEqual(["a@c1"]);
  });

  it("does not confuse a bank name with a concurrency level", () => {
    // `${bank}@c${conc}` must not collide for e.g. ("a@c1", 2) vs ("a", 12).
    const cells = [
      { bank: "a", concurrency: 12 },
      { bank: "a@c1", concurrency: 2 },
    ];
    expect(duplicateCellKeys(cells)).toEqual([]);
  });
});

describe("compareRuns noise floor", () => {
  /** A one-cell run whose stats are reduced from an explicit sample set. */
  const runWith = (samples: number[], label: string): BenchResult => {
    const cell = makeCell("a", 1000, 1, 0);
    cell.samplesMs = [...samples];
    cell.stats = summarize(samples, 0);
    return makeResult([cell], { label });
  };

  it("reports a wide noise floor for a heavy-tailed cell and flags the delta as luck", () => {
    // p95 here is one lucky order statistic; a 20% run-to-run move is NOT
    // evidence the system changed, and the report must say so rather than
    // printing a bare OUT that reads as a regression.
    const heavy = [...Array(37).fill(1000), 5000, 9000, 20000];
    const heavy2 = [...Array(37).fill(1000), 6000, 9000, 15000];
    const rep = compareRuns(runWith(heavy, "A"), runWith(heavy2, "B"));
    expect(rep.cells[0]!.noiseFloor).toBeGreaterThan(DEFAULT_TOLERANCE);
    expect(rep.cells[0]!.explainedByNoise).toBe(true);
  });

  it("does NOT relax the gate: a cell inside the noise still fails the tolerance", () => {
    // The tolerance is the acceptance criterion. Widening it to whatever the
    // noise happens to be is how a measurement gets tuned until it flatters
    // itself, which is exactly what this harness exists to prevent.
    const heavy = [...Array(37).fill(1000), 5000, 9000, 20000];
    const heavy2 = [...Array(37).fill(1000), 6000, 9000, 15000];
    const rep = compareRuns(runWith(heavy, "A"), runWith(heavy2, "B"));
    expect(rep.cells[0]!.within).toBe(false);
    expect(rep.pass).toBe(false);
  });

  it("reports a near-zero noise floor for a tight cell", () => {
    const tight = Array.from({ length: 40 }, () => 1000);
    const rep = compareRuns(runWith(tight, "A"), runWith(tight, "B"));
    expect(rep.cells[0]!.noiseFloor).toBe(0);
    expect(rep.cells[0]!.explainedByNoise).toBe(true);
    expect(rep.pass).toBe(true);
  });

  it("warns in the printed report when the noise floor exceeds the gate", () => {
    const heavy = [...Array(37).fill(1000), 5000, 9000, 20000];
    const heavy2 = [...Array(37).fill(1000), 6000, 9000, 15000];
    const out = formatReproducibility(compareRuns(runWith(heavy, "A"), runWith(heavy2, "B")));
    expect(out).toMatch(/median ±noise/);
    expect(out).toMatch(/NOTE: the median noise floor EXCEEDS/);
    expect(out).toMatch(/do not widen the tolerance to fit/);
  });
});
