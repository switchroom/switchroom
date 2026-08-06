import { describe, it, expect } from "vitest";
import { BOOTSTRAP_REPS, bootstrapP95Ci, percentile, round, summarize } from "./stats.js";

describe("percentile", () => {
  it("is nearest-rank, not interpolated", () => {
    const v = [10, 20, 30, 40];
    // Interpolated p50 would be 25; nearest-rank picks the ceil(0.5*4)=2nd value.
    expect(percentile(v, 0.5)).toBe(20);
    expect(percentile(v, 0.95)).toBe(40);
    expect(percentile(v, 1)).toBe(40);
  });

  it("returns an observed value for every p on a 100-sample set", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
    expect(percentile(v, 0.99)).toBe(99);
  });

  it("does not depend on input order", () => {
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(percentile([10, 20, 30, 40], 0.95));
  });

  it("does not mutate the caller's array", () => {
    const v = [3, 1, 2];
    percentile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });

  it("returns NaN for an empty set rather than 0", () => {
    // 0 ms would render as the fastest cell on the chart; NaN is a gap.
    expect(percentile([], 0.95)).toBeNaN();
  });

  it("rejects an out-of-range p", () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
  });
});

describe("summarize", () => {
  it("computes percentiles and dispersion over successful samples only", () => {
    const s = summarize([100, 100, 100, 100], 3);
    expect(s.n).toBe(4);
    expect(s.errors).toBe(3);
    expect(s.p50).toBe(100);
    expect(s.p95).toBe(100);
    expect(s.stddev).toBe(0);
    expect(s.cv).toBe(0);
  });

  it("reports a non-zero cv for a dispersed cell", () => {
    const s = summarize([10, 20, 30, 40, 50], 0);
    expect(s.mean).toBe(30);
    expect(s.cv).toBeGreaterThan(0);
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
  });

  it("never folds errors into the percentiles", () => {
    // Same samples, different error counts => identical percentiles.
    const a = summarize([5, 6, 7], 0);
    const b = summarize([5, 6, 7], 99);
    expect(b.p95).toBe(a.p95);
    expect(b.n).toBe(a.n);
    expect(b.errors).toBe(99);
  });

  it("yields a non-finite p95 when every call errored", () => {
    const s = summarize([], 12);
    expect(s.n).toBe(0);
    expect(s.errors).toBe(12);
    expect(Number.isFinite(s.p95)).toBe(false);
  });
});

describe("round", () => {
  it("rounds to the requested decimal places", () => {
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.25, 1)).toBe(1.3);
  });

  it("passes non-finite values through instead of producing 0", () => {
    expect(Number.isNaN(round(NaN, 2))).toBe(true);
  });
});

describe("bootstrapP95Ci", () => {
  const spread = Array.from({ length: 40 }, (_, i) => 100 + i * 50);

  it("is deterministic: the same samples always yield the same interval", () => {
    // A random interval would make a result file irreproducible and turn
    // `--compare` into a coin flip on the RNG rather than on the database.
    expect(bootstrapP95Ci(spread)).toEqual(bootstrapP95Ci([...spread]));
    expect(bootstrapP95Ci(spread)).toEqual(bootstrapP95Ci(spread.slice().reverse()));
  });

  it("brackets the point estimate", () => {
    const [lo, hi] = bootstrapP95Ci(spread);
    const point = percentile(spread, 0.95);
    expect(lo).toBeLessThanOrEqual(point);
    expect(hi).toBeGreaterThanOrEqual(point);
  });

  it("collapses to zero width when every sample is identical", () => {
    expect(bootstrapP95Ci(Array(40).fill(700))).toEqual([700, 700]);
  });

  it("is wider for a heavy-tailed cell than for a tight one", () => {
    // This is the property the AC1 report leans on: a cell whose p95 is one
    // lucky order statistic must ANNOUNCE that it cannot resolve 10%.
    const tight = Array.from({ length: 40 }, (_, i) => 1000 + (i % 3));
    const heavy = [...Array(38).fill(1000), 9000, 20000];
    const w = ([lo, hi]: [number, number]): number => hi - lo;
    expect(w(bootstrapP95Ci(heavy))).toBeGreaterThan(w(bootstrapP95Ci(tight)));
  });

  it("returns NaN for no data and the sole value for one sample", () => {
    expect(bootstrapP95Ci([])).toEqual([NaN, NaN]);
    expect(bootstrapP95Ci([42])).toEqual([42, 42]);
  });

  it("draws BOOTSTRAP_REPS resamples by default", () => {
    expect(BOOTSTRAP_REPS).toBe(2000);
  });
});

describe("summarize + bootstrap", () => {
  it("carries the p95 interval into every cell", () => {
    const st = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0);
    expect(st.p95CiLow).toBeLessThanOrEqual(st.p95);
    expect(st.p95CiHigh).toBeGreaterThanOrEqual(st.p95);
  });

  it("reports NaN bounds for an all-error cell rather than a clean zero", () => {
    const st = summarize([], 7);
    expect(st.p95CiLow).toBeNaN();
    expect(st.p95CiHigh).toBeNaN();
  });
});
