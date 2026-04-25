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
