import { describe, it, expect, vi } from "vitest";
import { startIssuesWatcher } from "../issues-watcher.js";
import type { IssueEvent } from "../../src/issues/index.js";
import type { IssuesCardHandle } from "../issues-card.js";

function makeCard(): IssuesCardHandle & { refreshCalls: IssueEvent[][] } {
  const refreshCalls: IssueEvent[][] = [];
  return {
    refreshCalls,
    messageId: () => null,
    refresh: async (events) => {
      refreshCalls.push(events);
    },
  };
}

function makeEvent(): IssueEvent {
  return {
    ts: 1,
    agent: "k",
    severity: "warn",
    source: "s",
    code: "c",
    summary: "x",
    fingerprint: "s::c",
    occurrences: 1,
    first_seen: 1,
    last_seen: 1,
  };
}

/**
 * The watcher schedules its work via setInterval and an async tick. The
 * tests exercise the *contract* (refresh fires when mtime changes;
 * doesn't fire when it doesn't; stop is idempotent) rather than the
 * exact timer interaction — driving real timers is fragile. We expose
 * a `tick()` on the handle for deterministic stepping.
 */

describe("startIssuesWatcher", () => {
  it("calls card.refresh once with the initial state on startup", async () => {
    const card = makeCard();
    let mtime = 1000;
    const events = [makeEvent()];
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      mtimeProvider: () => mtime,
      readEvents: () => events,
      // No-op interval — we drive ticks manually.
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    // The startup tick is async (queued via void promise). Wait a microtask.
    await new Promise((r) => setImmediate(r));
    expect(card.refreshCalls).toHaveLength(1);
    expect(card.refreshCalls[0]).toBe(events);
    handle.stop();
    void mtime;
  });

  it("does not refresh again when mtime is unchanged", async () => {
    const card = makeCard();
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      mtimeProvider: () => 1000,
      readEvents: () => [makeEvent()],
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    await handle.tick(); // mtime hasn't changed
    await handle.tick();
    expect(card.refreshCalls).toHaveLength(1); // initial tick only
    handle.stop();
  });

  it("refreshes again when mtime changes", async () => {
    const card = makeCard();
    let mtime = 1000;
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      mtimeProvider: () => mtime,
      readEvents: () => [makeEvent()],
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    expect(card.refreshCalls).toHaveLength(1);
    mtime = 2000;
    await handle.tick();
    expect(card.refreshCalls).toHaveLength(2);
    handle.stop();
  });

  it("treats missing file (mtime null) as a transition", async () => {
    const card = makeCard();
    let mtime: number | null = 1000;
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      mtimeProvider: () => mtime,
      readEvents: () => (mtime == null ? [] : [makeEvent()]),
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    expect(card.refreshCalls).toHaveLength(1);
    expect(card.refreshCalls[0]).toHaveLength(1);
    mtime = null;
    await handle.tick();
    expect(card.refreshCalls).toHaveLength(2);
    expect(card.refreshCalls[1]).toHaveLength(0);
    handle.stop();
  });

  it("stop is idempotent and clears the interval", () => {
    const clearSpy = vi.fn();
    const card = makeCard();
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      mtimeProvider: () => 0,
      readEvents: () => [],
      setInterval: ((_fn: () => void) => 42 as unknown) as typeof setInterval,
      clearInterval: clearSpy as typeof clearInterval,
    });
    handle.stop();
    handle.stop();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith(42);
  });
});
