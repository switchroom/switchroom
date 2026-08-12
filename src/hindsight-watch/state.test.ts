import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultStatePath,
  loadState,
  normalizeBankSample,
  normalizeConsolidationSample,
  normalizeRecallSample,
  pushSample,
  saveState,
} from "./state.js";
import { MAX_SAMPLE_AGE_MS, RING_MAX } from "./thresholds.js";
import { emptyState, type Sample } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hw-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(ts: number): Sample {
  return {
    ts,
    retainOk: 1,
    retainFail: 0,
    pending: 5,
    dead: 0,
    evicted: 0,
    drops: 0,
    restartCount: 0,
    startedAt: "2026-07-25T09:06:18Z",
    health: "healthy",
  };
}

describe("loadState", () => {
  it("returns empty state for an absent file", () => {
    expect(loadState(join(dir, "nope.json"))).toEqual(emptyState());
  });

  it("degrades to empty state on a torn/garbage file rather than throwing", () => {
    const p = join(dir, "torn.json");
    writeFileSync(p, '{"v":1,"ring":[{"ts":17');
    expect(loadState(p)).toEqual(emptyState());
  });

  it("discards a foreign schema version", () => {
    const p = join(dir, "v2.json");
    writeFileSync(p, JSON.stringify({ v: 2, ring: [sample(1)], signals: {} }));
    expect(loadState(p).ring).toEqual([]);
  });

  it("drops individual malformed samples but keeps good ones", () => {
    const p = join(dir, "mixed.json");
    writeFileSync(p, JSON.stringify({ v: 1, ring: [sample(1), { ts: "nope" }, sample(2)], signals: {} }));
    expect(loadState(p).ring.map((s) => s.ts)).toEqual([1, 2]);
  });

  it("round-trips a saved state", () => {
    const p = join(dir, "state.json");
    const s = pushSample(emptyState(), sample(42));
    s.signals["retain-failure-rate"] = { status: "firing", breaches: 3, clears: 0, firedAt: 7 };
    saveState(p, s);
    // `loadState` materializes the optional recall/consolidation blocks as
    // explicit `null` (the validated "we have no measurement" value) rather
    // than leaving them absent, so an evaluator can never read `undefined` and
    // compute a NaN comparison that silently passes.
    expect(loadState(p)).toEqual({
      ...s,
      ring: s.ring.map((r) => ({
        ...r,
        recall: null,
        consolidation: null,
        banks: null,
        vectorIndex: null,
      })),
    });
  });
});

/**
 * The fail-open shape this whole change exists to remove, applied to the
 * watchdog's OWN persisted state: `undefined / undefined` is NaN, and every
 * `NaN >= threshold` comparison is false — so a partially-written `recall`
 * block would score as a clean pass on all six recall signals.
 */
describe("normalizeRecallSample", () => {
  const good = {
    rows: 100,
    agents: 12,
    timeoutConsidered: 100,
    ownBankDegraded: 86,
    zeroConsidered: 100,
    zeroResult: 47,
    poolConsidered: 100,
    poolMedian: 0,
    scoreConsidered: 100,
    scoreP50: 0.001,
    elapsedConsidered: 100,
    elapsedP95Ms: 8023,
  };

  it("accepts a complete block", () => {
    expect(normalizeRecallSample(good)).toEqual(good);
  });

  it("rejects a block missing ANY count field, rather than zero-filling it", () => {
    for (const k of Object.keys(good)) {
      const partial: Record<string, unknown> = { ...good };
      delete partial[k];
      expect(`${k}:${normalizeRecallSample(partial)}`).toBe(`${k}:null`);
    }
  });

  it("rejects NaN, Infinity and negative counts", () => {
    expect(normalizeRecallSample({ ...good, rows: Number.NaN })).toBeNull();
    expect(normalizeRecallSample({ ...good, rows: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizeRecallSample({ ...good, ownBankDegraded: -1 })).toBeNull();
    expect(normalizeRecallSample({ ...good, poolMedian: Number.NaN })).toBeNull();
  });

  it("allows a null statistic (its sample was legitimately empty)", () => {
    expect(normalizeRecallSample({ ...good, poolMedian: null })).not.toBeNull();
  });

  it("tolerates an absent diagnostic error field — no threshold reads it", () => {
    expect(normalizeRecallSample({ ...good, topError: "ReadTimeout" })?.topError).toBe("ReadTimeout");
    expect(normalizeRecallSample(good)).not.toBeNull();
  });

  it("rejects a non-object", () => {
    expect(normalizeRecallSample(null)).toBeNull();
    expect(normalizeRecallSample(undefined)).toBeNull();
    expect(normalizeRecallSample(7)).toBeNull();
  });
});

describe("normalizeConsolidationSample", () => {
  it("accepts a complete block and rejects a partial one", () => {
    expect(normalizeConsolidationSample({ pending: 77, oldestAgeS: 14327 })).toEqual({
      pending: 77,
      oldestAgeS: 14327,
    });
    expect(normalizeConsolidationSample({ pending: 77 })).toBeNull();
    expect(normalizeConsolidationSample({ pending: 77, oldestAgeS: Number.NaN })).toBeNull();
  });
});

describe("normalizeBankSample — streak rows across a version upgrade", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    bank: "overlord",
    operationType: "graph_maintenance",
    streak: 19,
    newestFailureAgeS: 133_977,
    ...over,
  });

  it("KEEPS a row written before `lastCompletedAgeS` existed, without inventing one", () => {
    // Dropping the row would read as a SHORTER streak — health — on the
    // upgrade tick, which is the failure mode this whole signal exists to
    // end. Defaulting it to null would read as "never completed" and page.
    const out = normalizeBankSample({ streaks: [row()], pending: [] });
    expect(out?.streaks).toHaveLength(1);
    expect(out?.streaks[0].lastCompletedAgeS).toBeUndefined();
    expect("lastCompletedAgeS" in out!.streaks[0]).toBe(false);
  });

  it("round-trips both real states: a number and an explicit null", () => {
    expect(
      normalizeBankSample({ streaks: [row({ lastCompletedAgeS: 791_908 })], pending: [] })
        ?.streaks[0].lastCompletedAgeS,
    ).toBe(791_908);
    expect(
      normalizeBankSample({ streaks: [row({ lastCompletedAgeS: null })], pending: [] })?.streaks[0]
        .lastCompletedAgeS,
    ).toBeNull();
  });

  it("drops a row whose `lastCompletedAgeS` is garbage rather than trusting it", () => {
    for (const bad of [-1, Number.NaN, "9412", {}]) {
      expect(
        normalizeBankSample({ streaks: [row({ lastCompletedAgeS: bad })], pending: [] })?.streaks,
      ).toEqual([]);
    }
  });
});

describe("pushSample", () => {
  it("caps the ring at RING_MAX, oldest first", () => {
    let s = emptyState();
    for (let i = 0; i < RING_MAX + 5; i++) s = pushSample(s, sample(i));
    expect(s.ring).toHaveLength(RING_MAX);
    expect(s.ring[0].ts).toBe(5);
    expect(s.ring[RING_MAX - 1].ts).toBe(RING_MAX + 4);
  });

  it("drops samples older than MAX_SAMPLE_AGE_MS relative to the new one", () => {
    const now = Date.parse("2026-07-25T12:00:00Z");
    let s = emptyState();
    s = pushSample(s, sample(now - MAX_SAMPLE_AGE_MS - 1)); // just too old
    s = pushSample(s, sample(now - MAX_SAMPLE_AGE_MS + 1)); // just inside
    s = pushSample(s, sample(now));
    expect(s.ring.map((x) => x.ts)).toEqual([now - MAX_SAMPLE_AGE_MS + 1, now]);
  });

  it("drops future-dated samples (clock skew / restored state)", () => {
    const now = Date.parse("2026-07-25T12:00:00Z");
    let s = emptyState();
    s = pushSample(s, sample(now + 3_600_000));
    s = pushSample(s, sample(now));
    expect(s.ring.map((x) => x.ts)).toEqual([now]);
  });
});

describe("saveState", () => {
  it("THROWS on an unwritable path — the caller must exit loudly, not go quiet", () => {
    // A regular file where a directory must be: mkdirSync fails with
    // ENOTDIR for every uid, including root (a permission-bit test would
    // pass vacuously in the root containers this runs in).
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    expect(() => saveState(join(blocker, "state.json"), emptyState())).toThrow();
  });
});

describe("defaultStatePath", () => {
  it("lands under ~/.switchroom/hindsight-watch", () => {
    expect(defaultStatePath("/home/op")).toBe("/home/op/.switchroom/hindsight-watch/state.json");
  });
});
