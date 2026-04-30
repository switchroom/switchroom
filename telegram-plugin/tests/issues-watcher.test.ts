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
    let signature: string | null = "1000:50";
    const events = [makeEvent()];
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      signatureProvider: () => signature,
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
    void signature;
  });

  it("does not refresh again when signature is unchanged", async () => {
    const card = makeCard();
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      signatureProvider: () => "1000:50",
      readEvents: () => [makeEvent()],
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    await handle.tick(); // signature hasn't changed
    await handle.tick();
    expect(card.refreshCalls).toHaveLength(1); // initial tick only
    handle.stop();
  });

  it("refreshes again when signature changes", async () => {
    const card = makeCard();
    let signature = "1000:50";
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      signatureProvider: () => signature,
      readEvents: () => [makeEvent()],
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    expect(card.refreshCalls).toHaveLength(1);
    signature = "2000:120";
    await handle.tick();
    expect(card.refreshCalls).toHaveLength(2);
    handle.stop();
  });

  it("detects two writes within the same ms via the size component (#446)", async () => {
    // Simulates the exact scenario the issue called out: two writes
    // produce identical mtimeMs but different file sizes (the second
    // write appended a new line). Pre-fix the watcher would miss the
    // second write; post-fix the size component breaks the tie.
    const card = makeCard();
    let signature = "1714521600000.000:128";
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      signatureProvider: () => signature,
      readEvents: () => [makeEvent()],
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    expect(card.refreshCalls).toHaveLength(1);
    // Same mtime, larger size — must still register as a change.
    signature = "1714521600000.000:256";
    await handle.tick();
    expect(card.refreshCalls).toHaveLength(2);
    handle.stop();
  });

  it("treats missing file (signature null) as a transition", async () => {
    const card = makeCard();
    let signature: string | null = "1000:50";
    const handle = startIssuesWatcher({
      stateDir: "/fake",
      card,
      pollIntervalMs: 60_000,
      signatureProvider: () => signature,
      readEvents: () => (signature == null ? [] : [makeEvent()]),
      setInterval: ((_fn: () => void) => 1 as unknown) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    expect(card.refreshCalls).toHaveLength(1);
    expect(card.refreshCalls[0]).toHaveLength(1);
    signature = null;
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
      signatureProvider: () => "0:0",
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
