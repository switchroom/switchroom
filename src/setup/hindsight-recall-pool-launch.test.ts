/**
 * The shared split-launch orchestrator {@link launchRecallPoolHealthGated} owns
 * the load-bearing decision both launch paths (`switchroom memory setup` in
 * src/cli/memory.ts AND first-run `switchroom setup` in setup-memory-backend.ts)
 * funnel through: health-gate the authority, start the pool, health-gate the
 * pool, and — critically — DEGRADE to a single container on the PUBLIC port when
 * the pool never becomes healthy, instead of exiting into a fleet-wide memory
 * outage (the authority is parked on public+1, so nothing serves the public
 * port that every agent's memory.config.url points at).
 *
 * These tests pin the OUTCOMES, not the code path: pool failure ends with the
 * degrade closure invoked and a healthy public port; an already-healthy
 * authority + pool never touches the degrade path (the "authority up, pool dead"
 * repair the no-recreate memory-setup path relies on); an unhealthy authority
 * never starts the pool; and a fallback that also fails is reported loud.
 *
 * Every docker/health side effect is an injected closure, so no real container
 * is created and no `docker` command runs against the host.
 */

import { describe, expect, it, vi } from "vitest";

import { launchRecallPoolHealthGated } from "./hindsight-recall-pool.js";

/**
 * A `waitForHealthy` whose verdict is scripted per-port as a queue, so a test
 * can say e.g. "pool is unhealthy the first time, healthy the second (after the
 * single-container fallback relaunched on the public port)". Exhausting a port's
 * queue is a test-authoring bug, surfaced loudly rather than defaulting.
 */
function scriptedHealth(script: Record<number, boolean[]>) {
  const queues = new Map<number, boolean[]>(
    Object.entries(script).map(([p, v]) => [Number(p), [...v]]),
  );
  return vi.fn((port: number): Promise<boolean> => {
    const q = queues.get(port);
    if (!q || q.length === 0) {
      throw new Error(`scriptedHealth: no scripted verdict left for port ${port}`);
    }
    return Promise.resolve(q.shift()!);
  });
}

describe("launchRecallPoolHealthGated — split launch + pool-failure fallback", () => {
  it("degrades to a single container on the PUBLIC port when the pool never becomes healthy", async () => {
    const startPool = vi.fn();
    const stopPool = vi.fn();
    const degradeToSingleContainer = vi.fn();
    // Authority healthy on public+1; pool never healthy on the public port;
    // after the degrade relaunches a sole container, the public port is healthy.
    const waitForHealthy = scriptedHealth({ 18889: [true], 18888: [false, true] });

    const result = await launchRecallPoolHealthGated({
      publicApiPort: 18888,
      authorityApiPort: 18889,
      workers: 4,
      waitForHealthy,
      stopPool,
      startPool,
      degradeToSingleContainer,
    });

    // The outcome is the DEGRADE, not an exit — a healthy container ends on the
    // public port, so memory.config.url resolves.
    expect(result).toEqual({
      outcome: "degraded-single-container",
      reason: expect.stringContaining("18888"),
    });
    expect(startPool).toHaveBeenCalledTimes(1);
    expect(degradeToSingleContainer).toHaveBeenCalledTimes(1);
    // Health-gate order: authority (18889), pool (18888, fails), then the
    // single-container fallback re-probed on the PUBLIC port (18888).
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889, 18888, 18888]);
  });

  it("returns split — pool restored without touching the authority (the apply/crash repair)", async () => {
    // Authority already healthy + pool comes up healthy: this is exactly the
    // "authority up, pool dead → restore just the pool" repair. The orchestrator
    // never starts OR stops the authority itself, so the running authority is
    // untouched; the degrade path is never entered.
    const startPool = vi.fn();
    const degradeToSingleContainer = vi.fn();
    const waitForHealthy = vi.fn((_port: number) => Promise.resolve(true));

    const result = await launchRecallPoolHealthGated({
      publicApiPort: 18888,
      authorityApiPort: 18889,
      workers: 6,
      waitForHealthy,
      stopPool: vi.fn(),
      startPool,
      degradeToSingleContainer,
    });

    expect(result).toEqual({ outcome: "split" });
    expect(startPool).toHaveBeenCalledTimes(1);
    expect(degradeToSingleContainer).not.toHaveBeenCalled();
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889, 18888]);
  });

  it("fails loud (authority-unhealthy) and never starts the pool when the authority is not healthy", async () => {
    // A single container shares the same pg0, so there is nothing to fall back
    // to: the orchestrator must NOT start the pool or degrade.
    const startPool = vi.fn();
    const degradeToSingleContainer = vi.fn();
    const waitForHealthy = scriptedHealth({ 18889: [false] });

    const result = await launchRecallPoolHealthGated({
      publicApiPort: 18888,
      authorityApiPort: 18889,
      workers: 4,
      waitForHealthy,
      stopPool: vi.fn(),
      startPool,
      degradeToSingleContainer,
    });

    expect(result).toEqual({ outcome: "authority-unhealthy" });
    expect(startPool).not.toHaveBeenCalled();
    expect(degradeToSingleContainer).not.toHaveBeenCalled();
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889]);
  });

  it("returns degrade-failed when the pool AND the single-container fallback both fail", async () => {
    // The honest fail-loud: pool never healthy, and even the sole container
    // could not bind the public port. Nothing serves it — the caller exits.
    const degradeToSingleContainer = vi.fn();
    const waitForHealthy = scriptedHealth({ 18889: [true], 18888: [false, false] });

    const result = await launchRecallPoolHealthGated({
      publicApiPort: 18888,
      authorityApiPort: 18889,
      workers: 4,
      waitForHealthy,
      stopPool: vi.fn(),
      startPool: vi.fn(),
      degradeToSingleContainer,
    });

    expect(result).toEqual({
      outcome: "degrade-failed",
      reason: expect.stringContaining("18888"),
    });
    expect(degradeToSingleContainer).toHaveBeenCalledTimes(1);
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889, 18888, 18888]);
  });
});
