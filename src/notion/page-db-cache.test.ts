/**
 * Tests for the page→DB cache — RFC §8.3 PR 3.
 */

import { describe, expect, it } from "vitest";

import { PageDbCache } from "./page-db-cache.js";

describe("PageDbCache — basic get/set", () => {
  it("returns miss when empty", () => {
    const c = new PageDbCache();
    expect(c.get("page-1").kind).toBe("miss");
    expect(c.snapshot().misses).toBe(1);
  });

  it("returns hit after set", () => {
    const c = new PageDbCache();
    c.set("page-1", "db-A");
    const r = c.get("page-1");
    expect(r).toEqual({ kind: "hit", dbId: "db-A" });
    expect(c.snapshot().hits).toBe(1);
  });

  it("stores null mapping for pages with no DB ancestor", () => {
    const c = new PageDbCache();
    c.set("page-orphan", null);
    expect(c.get("page-orphan")).toEqual({ kind: "hit", dbId: null });
  });

  it("overwrites prior mapping", () => {
    const c = new PageDbCache();
    c.set("page-1", "db-A");
    c.set("page-1", "db-B");
    expect(c.get("page-1")).toEqual({ kind: "hit", dbId: "db-B" });
  });
});

describe("PageDbCache — TTL", () => {
  it("returns stale once TTL elapses, still includes the value", () => {
    let now = 1000;
    const c = new PageDbCache({ ttlMs: 100, now: () => now });
    c.set("page-1", "db-A");
    expect(c.get("page-1").kind).toBe("hit");
    now += 200; // past TTL
    const r = c.get("page-1");
    expect(r).toEqual({ kind: "stale", dbId: "db-A" });
    expect(c.snapshot().staleHits).toBe(1);
  });

  it("set() refreshes the writtenAt timestamp", () => {
    let now = 1000;
    const c = new PageDbCache({ ttlMs: 100, now: () => now });
    c.set("page-1", "db-A");
    now += 200;
    expect(c.get("page-1").kind).toBe("stale");
    c.set("page-1", "db-A"); // refresh
    expect(c.get("page-1").kind).toBe("hit");
  });
});

describe("PageDbCache — LRU eviction", () => {
  it("evicts the oldest entry when at capacity", () => {
    const c = new PageDbCache({ maxEntries: 3 });
    c.set("a", "db-a");
    c.set("b", "db-b");
    c.set("c", "db-c");
    c.set("d", "db-d"); // 'a' should be evicted
    expect(c.get("a").kind).toBe("miss");
    expect(c.get("b").kind).toBe("hit");
    expect(c.get("c").kind).toBe("hit");
    expect(c.get("d").kind).toBe("hit");
    expect(c.snapshot().evictions).toBe(1);
  });

  it("get() bumps freshness for LRU purposes", () => {
    const c = new PageDbCache({ maxEntries: 3 });
    c.set("a", "db-a");
    c.set("b", "db-b");
    c.set("c", "db-c");
    // Touch 'a' so it's now MRU
    c.get("a");
    c.set("d", "db-d"); // 'b' (now LRU) should be evicted
    expect(c.get("a").kind).toBe("hit");
    expect(c.get("b").kind).toBe("miss");
  });
});

describe("PageDbCache — invalidate + clear", () => {
  it("invalidate removes a single entry", () => {
    const c = new PageDbCache();
    c.set("a", "db-a");
    expect(c.invalidate("a")).toBe(true);
    expect(c.get("a").kind).toBe("miss");
    expect(c.invalidate("a")).toBe(false);
  });

  it("clear drops everything", () => {
    const c = new PageDbCache();
    c.set("a", "db-a");
    c.set("b", "db-b");
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.snapshot().hits).toBe(0);
  });
});

describe("PageDbCache — snapshot", () => {
  it("hitRate computes correctly", () => {
    const c = new PageDbCache();
    c.set("a", "db-a");
    c.get("a"); // hit
    c.get("nonexistent"); // miss
    const s = c.snapshot();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe(0.5);
  });

  it("hitRate is 0 when no requests served", () => {
    const c = new PageDbCache();
    expect(c.snapshot().hitRate).toBe(0);
  });
});
