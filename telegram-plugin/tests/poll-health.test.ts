/**
 * Tests for telegram-plugin/gateway/poll-health.ts (issue #56).
 */

import { describe, it, expect, vi } from "vitest";
import { createPollHealthCheck } from "../gateway/poll-health.js";

describe("createPollHealthCheck", () => {
  it("does not call onStall on success", async () => {
    const onStall = vi.fn().mockResolvedValue(undefined);
    let tickFn: () => void = () => {};
    const hc = createPollHealthCheck({
      ping: async () => undefined,
      onStall,
      failureThreshold: 3,
      setIntervalFn: (fn) => { tickFn = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
      log: () => {},
    });
    hc.start();
    for (let i = 0; i < 5; i++) {
      tickFn();
      await Promise.resolve();
    }
    expect(onStall).not.toHaveBeenCalled();
    expect(hc.consecutiveFailures()).toBe(0);
    hc.stop();
  });

  it("counts consecutive failures and fires onStall at threshold", async () => {
    const onStall = vi.fn().mockResolvedValue(undefined);
    let tickFn: () => void = () => {};
    const hc = createPollHealthCheck({
      ping: async () => { throw new Error("network down"); },
      onStall,
      failureThreshold: 3,
      setIntervalFn: (fn) => { tickFn = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
      log: () => {},
    });
    hc.start();
    tickFn(); await Promise.resolve();
    tickFn(); await Promise.resolve();
    tickFn(); await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("resets failure count on a successful ping", async () => {
    let pingShouldFail = true;
    let tickFn: () => void = () => {};
    const hc = createPollHealthCheck({
      ping: async () => { if (pingShouldFail) throw new Error("oops"); },
      onStall: async () => {},
      failureThreshold: 3,
      setIntervalFn: (fn) => { tickFn = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
      log: () => {},
    });
    hc.start();
    tickFn(); await Promise.resolve();
    tickFn(); await Promise.resolve();
    expect(hc.consecutiveFailures()).toBeGreaterThan(0);
    pingShouldFail = false;
    tickFn(); await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(hc.consecutiveFailures()).toBe(0);
    hc.stop();
  });

  it("detects stall when getMe passes but getUpdates heartbeat is stale", async () => {
    // Simulates the 2026-06-30 incident: one getUpdates TimeoutError left the
    // grammy runner loop frozen. getMe kept succeeding so the original
    // getMe-only health check never fired. Fleet was deaf for 2 h.
    // The fix: ping() also checks lastGetUpdatesHeartbeatMs; if stale, throws
    // so the failure counter increments and stall recovery fires.
    const onStall = vi.fn().mockResolvedValue(undefined);
    let tickFn: () => void = () => {};
    let lastGetUpdatesMs = Date.now() - 999_999; // very stale
    const staleThresholdMs = 180_000; // 3 min (threshold × interval)

    const hc = createPollHealthCheck({
      ping: async () => {
        // getMe succeeds (network fine):
        // (no throw from network layer)
        // heartbeat stale check (mirrors gateway.ts logic):
        const staleMs = Date.now() - lastGetUpdatesMs;
        if (staleMs > staleThresholdMs) {
          throw new Error(
            `getUpdates heartbeat stale: last seen ${Math.round(staleMs / 1000)}s ago — runner loop frozen`,
          );
        }
      },
      onStall,
      failureThreshold: 3,
      setIntervalFn: (fn) => { tickFn = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
      log: () => {},
    });
    hc.start();
    tickFn(); await Promise.resolve();
    tickFn(); await Promise.resolve();
    tickFn(); await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("does NOT stall when getUpdates heartbeat is fresh", async () => {
    const onStall = vi.fn().mockResolvedValue(undefined);
    let tickFn: () => void = () => {};
    let lastGetUpdatesMs = Date.now(); // fresh
    const staleThresholdMs = 180_000;

    const hc = createPollHealthCheck({
      ping: async () => {
        const staleMs = Date.now() - lastGetUpdatesMs;
        if (staleMs > staleThresholdMs) {
          throw new Error("getUpdates heartbeat stale");
        }
      },
      onStall,
      failureThreshold: 3,
      setIntervalFn: (fn) => { tickFn = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
      log: () => {},
    });
    hc.start();
    for (let i = 0; i < 5; i++) {
      tickFn(); await Promise.resolve();
    }
    expect(onStall).not.toHaveBeenCalled();
    hc.stop();
  });

  it("stop() cancels the interval", () => {
    const onStall = vi.fn();
    let cleared = false;
    const hc = createPollHealthCheck({
      ping: async () => { throw new Error("x"); },
      onStall,
      failureThreshold: 1,
      setIntervalFn: () => 99 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: (id) => { if (id === 99) cleared = true; },
      log: () => {},
    });
    hc.start();
    hc.stop();
    expect(cleared).toBe(true);
  });
});
