import { describe, it, expect } from "vitest";
import { SwrCache } from "./cache.js";

/**
 * A controllable clock so the TTL is driven deterministically (no real
 * timers). `set`/`advance` move it; the cache reads it via the injected
 * `now`.
 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A deferred promise we can resolve/reject from the test, to control a
 *  producer's timing precisely (for single-flight assertions). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SwrCache", () => {
  it("cold read awaits the producer, stores it, returns fresh", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);
    let calls = 0;
    const r = await cache.get("k", 1000, async () => {
      calls++;
      return { hi: 1 };
    });
    expect(calls).toBe(1);
    expect(r.value).toEqual({ hi: 1 });
    expect(r.stale).toBe(false);
    expect(r.dataAsOf).toBe(clock.now());
  });

  it("fresh hit returns cached value WITHOUT calling the producer again", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);
    let calls = 0;
    const producer = async () => {
      calls++;
      return calls; // distinct value per call, to detect a re-call
    };

    const first = await cache.get("k", 1000, producer);
    expect(first.value).toBe(1);
    expect(calls).toBe(1);

    // Within TTL — must serve cache, producer untouched.
    clock.advance(500);
    const second = await cache.get("k", 1000, producer);
    expect(second.value).toBe(1);
    expect(second.stale).toBe(false);
    expect(second.dataAsOf).toBe(first.dataAsOf); // unchanged stamp
    expect(calls).toBe(1);
  });

  it("stale read serves last-good immediately and refreshes in the background", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);
    let calls = 0;
    const producer = async () => {
      calls++;
      return calls;
    };

    const cold = await cache.get("k", 1000, producer);
    expect(cold.value).toBe(1);

    // Cross the TTL boundary (age >= ttlMs).
    clock.advance(1000);
    const staleRead = await cache.get("k", 1000, producer);
    // Served the OLD value immediately, flagged stale.
    expect(staleRead.value).toBe(1);
    expect(staleRead.stale).toBe(true);
    expect(staleRead.dataAsOf).toBe(cold.dataAsOf);
    // A background refresh was kicked.
    expect(calls).toBe(2);

    // Let the background refresh settle, then advance past TTL again so the
    // NEXT read re-evaluates freshness against the refreshed entry.
    await Promise.resolve();
    await Promise.resolve();
    const afterRefresh = await cache.get("k", 1000, producer);
    // The refreshed value (2) is now fresh — no further producer call.
    expect(afterRefresh.value).toBe(2);
    expect(afterRefresh.stale).toBe(false);
    expect(calls).toBe(2);
  });

  it("background-refresh error keeps last-good and lets a later read retry", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);
    let calls = 0;
    const producer = async () => {
      calls++;
      if (calls === 2) throw new Error("refresh boom");
      return calls;
    };

    const cold = await cache.get("k", 1000, producer);
    expect(cold.value).toBe(1);

    // Stale read #1 → serves last-good, kicks a refresh that THROWS.
    clock.advance(1000);
    const stale1 = await cache.get("k", 1000, producer);
    expect(stale1.value).toBe(1); // never throws
    expect(stale1.stale).toBe(true);
    expect(calls).toBe(2);

    // Let the failing refresh reject + clear the guard.
    await Promise.resolve();
    await Promise.resolve();

    // Stale read #2 → still last-good (1), but the guard cleared so it
    // retries the refresh (call #3 succeeds with value 3).
    const stale2 = await cache.get("k", 1000, producer);
    expect(stale2.value).toBe(1); // last-good preserved through the failure
    expect(stale2.stale).toBe(true);
    expect(calls).toBe(3);

    await Promise.resolve();
    await Promise.resolve();
    const recovered = await cache.get("k", 1000, producer);
    expect(recovered.value).toBe(3); // recovered to the successful refresh
    expect(recovered.stale).toBe(false);
  });

  it("single-flight: concurrent stale reads trigger exactly ONE producer refresh", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);

    // First producer call resolves immediately (cold seed). The refresh
    // call is a deferred we hold open so both concurrent reads observe the
    // SAME in-flight refresh.
    let calls = 0;
    const refreshGate = deferred<number>();
    const producer = async () => {
      calls++;
      if (calls === 1) return 1; // cold
      return refreshGate.promise; // the (single) background refresh
    };

    await cache.get("k", 1000, producer);
    expect(calls).toBe(1);

    clock.advance(1000); // now stale

    // Fire several stale reads "simultaneously" before the refresh settles.
    const reads = await Promise.all([
      cache.get("k", 1000, producer),
      cache.get("k", 1000, producer),
      cache.get("k", 1000, producer),
    ]);
    // All served last-good, all stale.
    for (const r of reads) {
      expect(r.value).toBe(1);
      expect(r.stale).toBe(true);
    }
    // Exactly ONE refresh kicked despite three concurrent stale reads.
    expect(calls).toBe(2);

    // Settle the held refresh; a later read sees the fresh value.
    refreshGate.resolve(42);
    await Promise.resolve();
    await Promise.resolve();
    const after = await cache.get("k", 1000, producer);
    expect(after.value).toBe(42);
    expect(after.stale).toBe(false);
    expect(calls).toBe(2);
  });

  it("uses the injected clock for freshness (no real time dependence)", async () => {
    const clock = fakeClock(5_000);
    const cache = new SwrCache(clock.now);
    let calls = 0;
    const producer = async () => {
      calls++;
      return calls;
    };

    const cold = await cache.get("k", 100, producer);
    expect(cold.dataAsOf).toBe(5_000);

    // Move the clock to exactly the TTL boundary — age == ttl ⇒ stale.
    clock.set(5_100);
    const r = await cache.get("k", 100, producer);
    expect(r.stale).toBe(true);
    expect(calls).toBe(2);
  });

  it("clear() drops entries so the next read is cold again", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);
    let calls = 0;
    const producer = async () => {
      calls++;
      return calls;
    };
    await cache.get("k", 1000, producer);
    expect(calls).toBe(1);
    cache.clear();
    // Cold again → producer re-runs even within what was the TTL.
    const r = await cache.get("k", 1000, producer);
    expect(r.value).toBe(2);
    expect(r.stale).toBe(false);
    expect(calls).toBe(2);
  });

  it("keys are independent", async () => {
    const clock = fakeClock();
    const cache = new SwrCache(clock.now);
    const a = await cache.get("a", 1000, async () => "A");
    const b = await cache.get("b", 1000, async () => "B");
    expect(a.value).toBe("A");
    expect(b.value).toBe("B");
  });
});
