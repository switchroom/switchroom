/**
 * Release watcher unit tests (#1743).
 *
 * Exercises the pull-based release detection state machine with
 * stubbed check / apply / restart functions — no docker, no
 * switchroom CLI, no network.
 */

import { describe, it, expect, vi } from "vitest";
import { ReleaseWatcher, type ReleaseWatcherEvent } from "../../src/host-control/release-watcher.js";

function collect() {
  const events: ReleaseWatcherEvent[] = [];
  return {
    events,
    onEvent: (e: ReleaseWatcherEvent) => { events.push(e); },
  };
}

describe("ReleaseWatcher", () => {
  it("does nothing when no release is available", async () => {
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const restartFn = vi.fn().mockResolvedValue(undefined);
    const sink = collect();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: false }),
      applyFn,
      restartFn,
      applyOnDetect: true,
      onEvent: sink.onEvent,
    });
    await w.tick();
    expect(applyFn).not.toHaveBeenCalled();
    expect(restartFn).not.toHaveBeenCalled();
    expect(sink.events).toEqual([]);
  });

  it("on detect: emits release_detected → apply_* → restart_* → fleet_caught_up", async () => {
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const restartFn = vi.fn().mockResolvedValue(undefined);
    const sink = collect();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true, version: "sha256:abc" }),
      applyFn,
      restartFn,
      applyOnDetect: true,
      onEvent: sink.onEvent,
    });
    await w.tick();
    expect(applyFn).toHaveBeenCalledOnce();
    expect(restartFn).toHaveBeenCalledOnce();
    const kinds = sink.events.map((e) => e.kind);
    expect(kinds).toEqual([
      "release_detected",
      "apply_started",
      "apply_succeeded",
      "restart_started",
      "fleet_caught_up",
    ]);
    const caughtUp = sink.events.find((e) => e.kind === "fleet_caught_up")!;
    expect(caughtUp.version).toBe("sha256:abc");
    expect(typeof caughtUp.duration_ms).toBe("number");
  });

  it("apply_on_detect=false: emits release_detected, stops there", async () => {
    const applyFn = vi.fn();
    const restartFn = vi.fn();
    const sink = collect();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true, version: "sha256:abc" }),
      applyFn,
      restartFn,
      applyOnDetect: false,
      onEvent: sink.onEvent,
    });
    await w.tick();
    expect(applyFn).not.toHaveBeenCalled();
    expect(restartFn).not.toHaveBeenCalled();
    expect(sink.events.map((e) => e.kind)).toEqual(["release_detected"]);
  });

  it("apply failure: emits apply_failed, does NOT call restart, does NOT retry within the tick", async () => {
    const applyFn = vi.fn().mockRejectedValue(new Error("pull denied"));
    const restartFn = vi.fn();
    const sink = collect();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true }),
      applyFn,
      restartFn,
      applyOnDetect: true,
      onEvent: sink.onEvent,
    });
    await w.tick();
    expect(applyFn).toHaveBeenCalledOnce();
    expect(restartFn).not.toHaveBeenCalled();
    const failed = sink.events.find((e) => e.kind === "apply_failed")!;
    expect(failed).toBeDefined();
    expect(failed.error).toContain("pull denied");
  });

  it("check failure: emits check_failed, does NOT call apply / restart", async () => {
    const applyFn = vi.fn();
    const restartFn = vi.fn();
    const sink = collect();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => { throw new Error("network unreachable"); },
      applyFn,
      restartFn,
      applyOnDetect: true,
      onEvent: sink.onEvent,
    });
    await w.tick();
    expect(applyFn).not.toHaveBeenCalled();
    expect(restartFn).not.toHaveBeenCalled();
    expect(sink.events.map((e) => e.kind)).toEqual(["check_failed"]);
  });

  it("overlapping ticks: second tick is dropped while the first is in flight", async () => {
    let resolveApply: (() => void) | null = null;
    const applyFn = vi.fn(() => new Promise<void>((res) => { resolveApply = res; }));
    const restartFn = vi.fn().mockResolvedValue(undefined);
    const sink = collect();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true }),
      applyFn,
      restartFn,
      applyOnDetect: true,
      onEvent: sink.onEvent,
    });
    const first = w.tick();
    // While first is hung in applyFn, fire a second tick
    await w.tick();
    // The second tick should have returned early — applyFn must
    // still have been called exactly once.
    expect(applyFn).toHaveBeenCalledTimes(1);
    // Release the first apply so the test can complete
    resolveApply!();
    await first;
    expect(restartFn).toHaveBeenCalledTimes(1);
  });

  it("stop() prevents further work", async () => {
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const restartFn = vi.fn().mockResolvedValue(undefined);
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true }),
      applyFn,
      restartFn,
      applyOnDetect: true,
    });
    w.start();
    w.stop();
    await w.tick();
    expect(applyFn).not.toHaveBeenCalled();
    expect(restartFn).not.toHaveBeenCalled();
  });

  it("start() before stop() does NOT spawn an immediate tick (setInterval semantics)", () => {
    const applyFn = vi.fn();
    const restartFn = vi.fn();
    const checkFn = vi.fn().mockResolvedValue({ available: false });
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn,
      applyFn,
      restartFn,
      applyOnDetect: true,
    });
    w.start();
    // No tick yet (interval is 1000s out)
    expect(checkFn).not.toHaveBeenCalled();
    w.stop();
  });

  // KEN-129 — notifyFn hook (update-check drift card).

  it("calls notifyFn with the release id when applyOnDetect=false", async () => {
    const applyFn = vi.fn();
    const restartFn = vi.fn();
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true, version: "sha256:abc" }),
      applyFn,
      restartFn,
      applyOnDetect: false,
      notifyFn,
    });
    await w.tick();
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(notifyFn).toHaveBeenCalledWith("sha256:abc");
    expect(applyFn).not.toHaveBeenCalled();
    expect(restartFn).not.toHaveBeenCalled();
  });

  it("does NOT call notifyFn when no release is available", async () => {
    const notifyFn = vi.fn();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: false }),
      applyFn: vi.fn(),
      restartFn: vi.fn(),
      applyOnDetect: false,
      notifyFn,
    });
    await w.tick();
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("does NOT call notifyFn when applyOnDetect=true (auto-apply supersedes notify)", async () => {
    const notifyFn = vi.fn();
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true, version: "sha256:abc" }),
      applyFn: vi.fn().mockResolvedValue(undefined),
      restartFn: vi.fn().mockResolvedValue(undefined),
      applyOnDetect: true,
      notifyFn,
    });
    await w.tick();
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("a throwing notifyFn is logged and does not break the tick (next tick still runs)", async () => {
    const notifyFn = vi.fn().mockRejectedValue(new Error("card exploded"));
    const logs: string[] = [];
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true, version: "sha256:abc" }),
      applyFn: vi.fn(),
      restartFn: vi.fn(),
      applyOnDetect: false,
      notifyFn,
      log: (m) => logs.push(m),
    });
    await w.tick();
    await w.tick();
    expect(notifyFn).toHaveBeenCalledTimes(2);
    expect(
      logs.some((m) => m.includes("notify_failed") && m.includes("card exploded")),
    ).toBe(true);
  });
});

describe("ReleaseWatcher — applyFn receives the check's version (KEN-131)", () => {
  it("passes the detected version through so the auto-update path can pin the rollout", async () => {
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true, version: "v1.2.3" }),
      applyFn,
      restartFn: vi.fn().mockResolvedValue(undefined),
      applyOnDetect: true,
    });
    await w.tick();
    expect(applyFn).toHaveBeenCalledWith("v1.2.3");
  });

  it("passes undefined when the check reports no version (legacy digest path unchanged)", async () => {
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const w = new ReleaseWatcher({
      intervalMs: 1_000_000,
      checkFn: async () => ({ available: true }),
      applyFn,
      restartFn: vi.fn().mockResolvedValue(undefined),
      applyOnDetect: true,
    });
    await w.tick();
    expect(applyFn).toHaveBeenCalledWith(undefined);
  });
});
