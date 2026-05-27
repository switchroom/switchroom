/**
 * Tests for the Notion rate-bucket primitive — RFC §7 PR 2.
 *
 * Pure-class tests; no broker / IPC. Wire-up tests land in PR 3.
 */

import { afterEach, describe, expect, it } from "vitest";

import { NotionRateBucket } from "./notion-rate-bucket.js";

let buckets: NotionRateBucket[] = [];
function makeBucket(...args: ConstructorParameters<typeof NotionRateBucket>) {
  const b = new NotionRateBucket(...args);
  buckets.push(b);
  return b;
}

afterEach(() => {
  for (const b of buckets) b.dispose();
  buckets = [];
});

describe("NotionRateBucket — construction validation", () => {
  it("defaults to capacity=3, refill=3 rps, wait=1000ms", () => {
    const b = makeBucket();
    expect(b.capacity).toBe(3);
    expect(b.refillRatePerSec).toBe(3);
    expect(b.maxWaitMs).toBe(1000);
  });

  it("honours custom capacity + refill", () => {
    const b = makeBucket({ capacity: 5, refillRatePerSec: 2, maxWaitMs: 500 });
    expect(b.capacity).toBe(5);
    expect(b.refillRatePerSec).toBe(2);
    expect(b.maxWaitMs).toBe(500);
  });

  it("rejects zero or negative capacity", () => {
    expect(() => new NotionRateBucket({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new NotionRateBucket({ capacity: -1 })).toThrow(/capacity/);
    expect(() => new NotionRateBucket({ capacity: Infinity })).toThrow(/capacity/);
  });

  it("rejects zero or negative refill rate", () => {
    expect(() => new NotionRateBucket({ refillRatePerSec: 0 })).toThrow(/refill/);
    expect(() => new NotionRateBucket({ refillRatePerSec: -3 })).toThrow(/refill/);
  });
});

describe("NotionRateBucket — synchronous tryAcquire", () => {
  it("grants until capacity exhausted", () => {
    const b = makeBucket({ capacity: 3, refillRatePerSec: 3 });
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
  });

  it("refills over wall time", async () => {
    const b = makeBucket({ capacity: 3, refillRatePerSec: 30 }); // 30/sec = ~1/33ms
    // Drain
    b.tryAcquire();
    b.tryAcquire();
    b.tryAcquire();
    expect(b.tryAcquire()).toBe(false);
    // Wait ~50ms for at least 1 token to refill
    await new Promise((r) => setTimeout(r, 60));
    expect(b.tryAcquire()).toBe(true);
  });

  it("snapshot reflects state", () => {
    const b = makeBucket({ capacity: 2, refillRatePerSec: 1 });
    b.tryAcquire();
    const snap = b.snapshot();
    expect(snap.totalAcquired).toBe(1);
    expect(snap.totalDenied).toBe(0);
    expect(snap.tokens).toBeLessThanOrEqual(2);
    expect(snap.tokens).toBeGreaterThanOrEqual(0);
  });
});

describe("NotionRateBucket — async acquire with waiting", () => {
  it("returns immediately when token is available", async () => {
    const b = makeBucket({ capacity: 3, refillRatePerSec: 1, maxWaitMs: 1000 });
    const start = Date.now();
    expect(await b.acquire()).toBe(true);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waits and grants when refill arrives within maxWaitMs", async () => {
    const b = makeBucket({ capacity: 1, refillRatePerSec: 50, maxWaitMs: 500 });
    expect(b.tryAcquire()).toBe(true); // drain
    const start = Date.now();
    expect(await b.acquire()).toBe(true); // waits for refill (~20ms)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(200);
  });

  it("times out and returns false when refill is slower than maxWaitMs", async () => {
    const b = makeBucket({ capacity: 1, refillRatePerSec: 1, maxWaitMs: 50 });
    expect(b.tryAcquire()).toBe(true); // drain
    const start = Date.now();
    const granted = await b.acquire();
    const elapsed = Date.now() - start;
    expect(granted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
    expect(b.snapshot().totalDenied).toBe(1);
  });
});

describe("NotionRateBucket — fairness / FIFO", () => {
  it("grants in FIFO order across concurrent acquirers", async () => {
    const b = makeBucket({ capacity: 1, refillRatePerSec: 100, maxWaitMs: 2000 });
    expect(b.tryAcquire()).toBe(true); // drain
    const order: number[] = [];
    const a = b.acquire().then((g) => {
      if (g) order.push(0);
    });
    // Small stagger so the second acquirer enqueues after the first
    await new Promise((r) => setTimeout(r, 5));
    const c = b.acquire().then((g) => {
      if (g) order.push(1);
    });
    await Promise.all([a, c]);
    expect(order).toEqual([0, 1]);
  });

  it("tracks peakQueueDepth across waiters", async () => {
    const b = makeBucket({ capacity: 1, refillRatePerSec: 30, maxWaitMs: 2000 });
    expect(b.tryAcquire()).toBe(true);
    const p1 = b.acquire();
    const p2 = b.acquire();
    const p3 = b.acquire();
    // Allow microtasks to enqueue
    await new Promise((r) => setTimeout(r, 1));
    expect(b.snapshot().peakQueueDepth).toBeGreaterThanOrEqual(2);
    await Promise.all([p1, p2, p3]);
  });
});

describe("NotionRateBucket — dispose", () => {
  it("rejects pending acquires with false", async () => {
    const b = new NotionRateBucket({ capacity: 1, refillRatePerSec: 1, maxWaitMs: 10000 });
    expect(b.tryAcquire()).toBe(true);
    const p = b.acquire();
    // Dispose mid-wait
    setTimeout(() => b.dispose(), 5);
    expect(await p).toBe(false);
  });
});
