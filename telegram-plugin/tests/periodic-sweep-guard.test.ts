import { describe, it, expect } from "vitest";
import { createPeriodicSweepGuard } from "../gateway/periodic-sweep-guard.js";

/**
 * Single-flight guard for the interval-driven mid-session card reaper.
 *
 * Pre-fix the interval dispatched `void runMidSessionCardReaper()` directly, so
 * a pass that parked behind a flood-wait (this gateway took a 62-minute flood
 * ban on 2026-07-25) let EVERY subsequent tick start another concurrent pass —
 * unbounded fan-out racing the same store rows and firing duplicate unpins into
 * the rate limit that caused the stall. These assert the observable outcome:
 * the number of times `run` actually started.
 */
describe("createPeriodicSweepGuard", () => {
  /** A pass we can hold open, counting starts and completions. */
  function heldRun() {
    let release!: () => void;
    let gate = new Promise<void>((r) => {
      release = r;
    });
    let starts = 0;
    let finishes = 0;
    const run = async () => {
      starts += 1;
      await gate;
      finishes += 1;
    };
    return {
      run,
      starts: () => starts,
      finishes: () => finishes,
      release: () => {
        release();
        // Re-arm so a later pass can be held again.
        gate = new Promise<void>((r) => {
          release = r;
        });
      },
    };
  }

  it("runs the pass when idle", async () => {
    let ran = 0;
    const g = createPeriodicSweepGuard({
      run: async () => {
        ran += 1;
      },
    });
    await g.tick();
    expect(ran).toBe(1);
    expect(g.isRunning()).toBe(false);
    expect(g.skipped()).toBe(0);
  });

  it("SKIPS every tick that arrives while a pass is still in flight (the fan-out fix)", async () => {
    const h = heldRun();
    const skips: number[] = [];
    const g = createPeriodicSweepGuard({ run: h.run, onSkip: () => skips.push(1) });

    const inFlight = g.tick();
    await Promise.resolve();
    expect(g.isRunning()).toBe(true);
    expect(h.starts()).toBe(1);

    // Ten more interval ticks land during the stall. Pre-fix these were ten
    // more concurrent passes; now they are dropped.
    await Promise.all([
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
      g.tick(),
    ]);
    expect(h.starts()).toBe(1); // still exactly ONE pass ever started
    expect(g.skipped()).toBe(10);
    expect(skips).toHaveLength(10);

    h.release();
    await inFlight;
    expect(h.finishes()).toBe(1);
    expect(g.isRunning()).toBe(false);
  });

  it("re-arms after the in-flight pass settles, so the sweep is not disabled forever", async () => {
    const h = heldRun();
    const g = createPeriodicSweepGuard({ run: h.run });
    const first = g.tick();
    await Promise.resolve();
    await g.tick(); // skipped
    h.release();
    await first;

    const second = g.tick();
    await Promise.resolve();
    expect(h.starts()).toBe(2); // the NEXT tick genuinely ran
    h.release();
    await second;
  });

  it("absorbs a throwing pass: tick never rejects, the guard re-arms, onError sees it", async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const g = createPeriodicSweepGuard({
      run: async () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
      onError: (e) => seen.push(e),
    });

    // A rejection escaping here reaches the gateway's `unhandledRejection`
    // handler, which CRASHES the process — a cosmetic sweep must never do that.
    await expect(g.tick()).resolves.toBeUndefined();
    expect(g.isRunning()).toBe(false);
    await expect(g.tick()).resolves.toBeUndefined();
    expect(calls).toBe(2); // a throw does not wedge the running flag
    expect(seen).toHaveLength(2);
    expect((seen[0] as Error).message).toBe("boom 1");
  });

  it("a throwing observer cannot break the guard", async () => {
    const h = heldRun();
    const g = createPeriodicSweepGuard({
      run: h.run,
      onSkip: () => {
        throw new Error("broken logger");
      },
    });
    const first = g.tick();
    await Promise.resolve();
    await expect(g.tick()).resolves.toBeUndefined();
    expect(g.skipped()).toBe(1);
    h.release();
    await first;
  });

  it("onError is optional — a throwing pass with no observer is still absorbed", async () => {
    const g = createPeriodicSweepGuard({
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(g.tick()).resolves.toBeUndefined();
    expect(g.isRunning()).toBe(false);
  });
});
