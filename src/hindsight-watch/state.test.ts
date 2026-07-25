import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStatePath, loadState, pushSample, saveState } from "./state.js";
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
    retainBuckets: { "60.0": 1, "+Inf": 1 },
    pending: 5,
    dead: 0,
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
    expect(loadState(p)).toEqual(s);
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
