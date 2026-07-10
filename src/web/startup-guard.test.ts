import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectConfigMountFault,
  nextCrashBackoff,
  readCrashState,
  writeCrashState,
  clearCrashState,
  type CrashLoopState,
} from "./startup-guard.js";

describe("detectConfigMountFault (#2915)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "startup-guard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags a config path that resolved to a DIRECTORY (the stale single-file-bind fault)", () => {
    const p = join(dir, "switchroom.yaml");
    mkdirSync(p); // Docker auto-dir / stale directory inode
    const fault = detectConfigMountFault(p);
    expect(fault).not.toBeNull();
    expect(fault!.kind).toBe("directory-inode");
    // Message must name the real remedy: a RECREATE, not a restart.
    expect(fault!.message).toMatch(/--force-recreate/);
    expect(fault!.message).toContain(p);
  });

  it("returns null for a normal config FILE (no false positive)", () => {
    const p = join(dir, "switchroom.yaml");
    writeFileSync(p, "switchroom: {}\n");
    expect(detectConfigMountFault(p)).toBeNull();
  });

  it("returns null for a missing path (loader reports that separately)", () => {
    expect(detectConfigMountFault(join(dir, "nope.yaml"))).toBeNull();
  });
});

describe("nextCrashBackoff (#2915 crash-loop pacing)", () => {
  it("does NOT delay the first failure — fail loudly ONCE, immediately", () => {
    const { state, delayMs } = nextCrashBackoff(null, 1_000);
    expect(state.count).toBe(1);
    expect(delayMs).toBe(0);
  });

  it("backs off exponentially on consecutive rapid failures instead of hammering", () => {
    let state: CrashLoopState | null = null;
    const delays: number[] = [];
    let now = 1_000;
    // Simulate what `restart: always` would do: relaunch immediately after
    // each backoff. Without a guard this is 417 instant restarts; with it,
    // the delay must strictly grow (until the cap).
    for (let i = 0; i < 6; i++) {
      const r = nextCrashBackoff(state, now);
      state = r.state;
      delays.push(r.delayMs);
      now += r.delayMs; // next relaunch happens after the backoff sleep
    }
    // count climbs, delays are non-decreasing and become positive
    expect(state!.count).toBe(6);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(0);
    for (let i = 2; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });

  it("caps the backoff so it never grows unbounded", () => {
    let state: CrashLoopState | null = { count: 25, lastTs: 0 };
    const { delayMs } = nextCrashBackoff(state, 1000, { maxMs: 60_000 });
    expect(delayMs).toBeLessThanOrEqual(60_000);
    expect(delayMs).toBeGreaterThan(0);
  });

  it("resets the counter when the last failure was long ago (loop is broken)", () => {
    const stale: CrashLoopState = { count: 10, lastTs: 0 };
    const { state, delayMs } = nextCrashBackoff(stale, 10 * 60_000, {
      resetAfterMs: 5 * 60_000,
    });
    expect(state.count).toBe(1); // fresh loop
    expect(delayMs).toBe(0);
  });
});

describe("crash state persistence round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "startup-guard-state-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes, reads back, and clears", () => {
    const p = join(dir, "sub", ".crashloop-state.json");
    expect(readCrashState(p)).toBeNull();
    writeCrashState(p, { count: 3, lastTs: 42 });
    expect(readCrashState(p)).toEqual({ count: 3, lastTs: 42 });
    clearCrashState(p);
    expect(readCrashState(p)).toBeNull();
  });

  it("returns null on a corrupt marker rather than throwing", () => {
    const p = join(dir, ".crashloop-state.json");
    writeFileSync(p, "{not json");
    expect(readCrashState(p)).toBeNull();
  });
});
