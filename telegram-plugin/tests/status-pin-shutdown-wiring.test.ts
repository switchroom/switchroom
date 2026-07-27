/**
 * Status-pin SHUTDOWN + REAPER-DISPATCH wiring fence.
 *
 * Both defects here are wiring defects, and gateway.ts cannot be instantiated
 * in-process (module-eval side effects), so — same pattern as
 * `boot-pin-sweep-wiring.test.ts` and `silence-liveness-wiring.test.ts` — these
 * are structural assertions over the source. The BEHAVIOUR they make apply to
 * the gateway is proven in `status-pin-retarget.test.ts`,
 * `periodic-sweep-guard.test.ts` and `status-pin.test.ts`.
 *
 * D2: `shutdown()` never unpinned. `sweepBeforeSelfRestart()` covered the
 *     gateway's own restart verbs, but SIGTERM/SIGINT — `docker restart`,
 *     `switchroom agent restart`, a compose bounce, a host reboot — reached
 *     `process.exit(0)` with every live pin still pinned (empirically: overlord
 *     logged `status-pin: cleared 1/1 orphaned pin(s) from a prior session` on
 *     a routine 2026-07-27 restart, i.e. the NEXT boot had to clean it up).
 *
 * D3: the mid-session reaper interval dispatched `void runMidSessionCardReaper()`
 *     with no single-flight guard, while the pass awaits flood-wait-prone
 *     Telegram calls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const gatewaySrc = readFileSync(resolve(__dirname, "..", "gateway", "gateway.ts"), "utf-8");

/** Body of `async function shutdown(...)` up to the next top-level `\nasync function`/`\nfunction`. */
function shutdownBody(): string {
  const start = gatewaySrc.indexOf("async function shutdown(signal: string)");
  expect(start).toBeGreaterThan(-1);
  const rest = gatewaySrc.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("status-pin shutdown wiring (D2)", () => {
  it("shutdown() unpins the live status pins before exiting", () => {
    expect(shutdownBody()).toContain("unpinAllStatusPins()");
  });

  it("the shutdown unpin is guarded, so a throw cannot skip the rest of shutdown", () => {
    const body = shutdownBody();
    const idx = body.indexOf("unpinAllStatusPins()");
    // The nearest preceding statement must open a try — the sweep is
    // best-effort and must never abort the drain/cleanup that follows it.
    expect(body.slice(0, idx)).toMatch(/try\s*\{\s*\n\s*await withDeadline\($/);
  });

  it("the sweep is deadline-bounded, so it cannot push shutdown into force-exit", () => {
    // forceExitTimer fires at budget+5s and deliberately SKIPS
    // releaseStartupLock; an unbounded flood-wait-parked unpin here would turn
    // a clean restart into a stale-lock recovery on the next boot.
    expect(shutdownBody()).toMatch(/await withDeadline\(unpinAllStatusPins\(\), \d[\d_]*,/);
  });

  it("runs AFTER the drain and BEFORE the coalescer reset (bot.api still usable)", () => {
    const body = shutdownBody();
    const drain = body.indexOf("drainShutdown");
    const unpin = body.indexOf("unpinAllStatusPins()");
    const reset = body.indexOf("\n  inboundCoalescer.reset()"); // the statement, not the comment above it
    expect(drain).toBeGreaterThan(-1);
    expect(unpin).toBeGreaterThan(drain);
    expect(reset).toBeGreaterThan(unpin);
  });
});

describe("mid-session card reaper dispatch wiring (D3)", () => {
  it("the interval never calls runMidSessionCardReaper() directly", () => {
    // The pre-fix shape, verbatim: `void runMidSessionCardReaper()` on a timer.
    // Only the declaration and the guard's `run:` reference may name it.
    const invocations =
      gatewaySrc.match(/(?<!function\s)(?<![.\w])runMidSessionCardReaper\s*\(/g) ?? [];
    expect(invocations).toEqual([]);
  });

  it("dispatches through the single-flight guard instead", () => {
    expect(gatewaySrc).toContain("createPeriodicSweepGuard({");
    expect(gatewaySrc).toContain("run: runMidSessionCardReaper,");
    expect(gatewaySrc).toContain("void midSessionReaperGuard.tick()");
  });
});

describe("status-pin reconcile wiring (D1)", () => {
  it("reconcileStatusPinInner delegates to the retarget-aware orchestrator", () => {
    const start = gatewaySrc.indexOf("async function reconcileStatusPinInner(");
    expect(start).toBeGreaterThan(-1);
    const body = gatewaySrc.slice(start, gatewaySrc.indexOf("\n}", start));
    // A single-leg `reconcileAndPersistStatusPin(...)` call here is exactly the
    // shape that dropped the pin leg of a retarget on the floor.
    expect(body).toContain("await runStatusPinReconcile({");
    expect(body).not.toContain("reconcileAndPersistStatusPin({");
  });
});
