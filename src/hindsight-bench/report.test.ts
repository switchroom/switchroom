import { describe, it, expect } from "vitest";
import { makeCell, makeResult } from "./fixtures.js";
import {
  CONTENTION_MIN_REL_DELTA,
  DEFAULT_TOLERANCE,
  compareContention,
  compareRuns,
  formatContention,
  formatReproducibility,
  formatSummary,
  toCsv,
} from "./report.js";

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

  it("treats an all-error reference cell as unmatched rather than dividing by NaN", () => {
    const dead = makeCell("big", 10, 1, 1000);
    dead.samplesMs = [];
    dead.stats = { ...dead.stats, n: 0, errors: 20, p95: NaN };
    const rep = compareRuns(makeResult([dead]), makeResult([makeCell("big", 10, 1, 1000)]));
    expect(rep.pass).toBe(false);
    expect(rep.unmatched).toEqual(["big@c1"]);
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
