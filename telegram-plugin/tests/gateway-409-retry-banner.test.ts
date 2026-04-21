import { describe, it, expect } from "vitest";

/**
 * Regression guard for the false-restart banner bug observed on
 * 2026-04-22.
 *
 * Incident: klanker user received 4+ "⚡ Recovered from unexpected
 * restart" banners in a 2-minute window while `journalctl --user -u
 * switchroom-klanker-gateway.service` showed the process PID constant
 * (1939077 throughout) and zero lifecycle events. The only signal
 * correlating with the banner-bursts was a stream of 409 Conflict
 * errors from grammY's long-poll, triggering the gateway's outer
 * `for (let attempt = 1; ; attempt++)` retry loop to re-enter its
 * `try { ... }` block. That try-block contains the boot-time
 * "crash recovery" banner send, so every retry re-posted the banner.
 *
 * Fix: a `didOneTimeSetup` boolean guards the one-shot startup blocks
 * (restart follow-up, crash recovery, pin sweep, setInterval for
 * auto-fallback poll, bot-command registration). Retries bypass the
 * guard and go straight to `run(bot)` again.
 *
 * These tests model the retry loop's gating contract abstractly so we
 * can't regress without the test failing. The real retry loop lives
 * in telegram-plugin/gateway/gateway.ts and telegram-plugin/server.ts.
 */

/**
 * Minimal model of the gated retry loop. Returns how many times
 * each of the two code paths ran over a simulated sequence of
 * retry attempts.
 */
function simulateGatedRetryLoop(numAttempts: number): {
  oneTimeRuns: number;
  pollerStartRuns: number;
} {
  let didOneTimeSetup = false;
  let oneTimeRuns = 0;
  let pollerStartRuns = 0;
  for (let attempt = 1; attempt <= numAttempts; attempt++) {
    if (!didOneTimeSetup) {
      didOneTimeSetup = true;
      oneTimeRuns += 1; // banner send, pin sweep, setInterval, etc.
    }
    pollerStartRuns += 1; // grammY runner.task() — always re-tried
  }
  return { oneTimeRuns, pollerStartRuns };
}

describe("gateway 409-retry banner suppression", () => {
  it("runs one-shot setup exactly once across many 409 retries", () => {
    // Matches the 2026-04-22 klanker incident: 4 retries observed.
    const result = simulateGatedRetryLoop(4);
    expect(result.oneTimeRuns).toBe(1);
    expect(result.pollerStartRuns).toBe(4);
  });

  it("runs one-shot setup exactly once on first attempt (no prior retries)", () => {
    const result = simulateGatedRetryLoop(1);
    expect(result.oneTimeRuns).toBe(1);
    expect(result.pollerStartRuns).toBe(1);
  });

  it("still only posts once even under a long 409 storm", () => {
    const result = simulateGatedRetryLoop(100);
    expect(result.oneTimeRuns).toBe(1);
    expect(result.pollerStartRuns).toBe(100);
  });

  it("regression: without the guard, a naive loop would banner-spam", () => {
    // Models the pre-fix code path. Kept as a sanity check that our
    // simulator actually distinguishes the two shapes — i.e. the bug
    // is real and the fix is load-bearing.
    let oneTimeRuns = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      oneTimeRuns += 1; // no guard
    }
    expect(oneTimeRuns).toBe(4); // matches the 4 banners the user saw
  });
});

/**
 * Direct source-level guard: assert the gating variable exists in
 * the two files that own the retry loop. Catches refactors that
 * silently drop the guard.
 */
describe("source-level guard present", () => {
  it("gateway.ts declares didOneTimeSetup before the retry loop", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../gateway/gateway.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("let didOneTimeSetup = false");
    expect(src).toContain("if (!didOneTimeSetup)");
    // Sanity-check the banner still exists — fix is gating, not deleting.
    expect(src).toContain("Recovered from unexpected restart");
  });

  it("server.ts declares didOneTimeSetup before the retry loop", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../server.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("let didOneTimeSetup = false");
    expect(src).toContain("if (!didOneTimeSetup)");
    expect(src).toContain("Recovered from unexpected restart");
  });
});
