/**
 * First-run `switchroom setup` must PROVISION the recall/background split when
 * `hindsight.recall_pool.enabled` is set — not just `switchroom memory setup`.
 * A knob honoured on one launch path but silently ignored on the other is the
 * exact divergence class this topology work exists to close, so these tests
 * pin the wiring outcomes:
 *
 *   1. Fresh host, split enabled  → authority on public+1, pool on the public
 *      port, health-gated in order.
 *   2. Authority up but pool dead → the pool is RESTORED (authority not
 *      restarted). This is the `switchroom apply` / crash-recovery path.
 *   3. Split disabled             → single container, the pool seam is never
 *      touched (strict opt-in preserved).
 *
 * Every docker / health / broker collaborator is injected, so no real
 * container is created and no real `docker` command runs against the host.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SwitchroomConfig } from "../config/schema.js";
import type { DockerProbe } from "../setup/hindsight.js";
import { stepMemoryBackend, type MemoryBackendDeps } from "./setup-memory-backend.js";

/** A writable switchroom.yaml so `ensureHindsightConsumer` has a file to edit. */
function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sr-setup-pool-"));
  const path = join(dir, "switchroom.yaml");
  writeFileSync(path, "agents: {}\n", "utf-8");
  return path;
}

/**
 * A docker probe that reports the daemon healthy and the AUTHORITY container's
 * running state from a mutable flag (so a `startContainer` mock can flip it to
 * simulate the container coming up). The recall-pool sibling's state is driven
 * by the injected `recallPoolRunningProbe`, not this probe.
 */
function makeDockerProbe(state: { authorityUp: boolean }): DockerProbe {
  return (args: string[]): string | null => {
    if (args.includes("--version")) return "Docker version 24.0.0";
    // `probeDockerAvailability` daemon check.
    if (args.length === 2 && args[0] === "ps" && args[1] === "--quiet") return "";
    // Container-exists check (`ps -a`): no stopped container to clean up.
    if (args.includes("-a")) return "";
    // `isHindsightRunning`: exact-name match on the authority container.
    if (args.includes("--filter") && args.includes("name=switchroom-hindsight")) {
      return state.authorityUp ? "switchroom-hindsight\n" : "";
    }
    return "";
  };
}

const SPLIT_ENABLED = {
  hindsight: { recall_pool: { enabled: true, workers: 4 } },
  memory: { config: { url: "http://127.0.0.1:18888/mcp/" } },
} as unknown as SwitchroomConfig;

describe("stepMemoryBackend — recall-pool provisioning wiring", () => {
  it("restores the pool when the authority is up but the pool is dead (apply/crash recovery)", async () => {
    const startContainer = vi.fn();
    const startRecallPool = vi.fn();
    const waitForHealthy = vi.fn((_port: number) => Promise.resolve(true));
    const stopRecallPool = vi.fn();

    const deps: MemoryBackendDeps = {
      dockerProbe: makeDockerProbe({ authorityUp: true }),
      recallPoolRunningProbe: () => false, // pool sibling is dead
      startContainer,
      startRecallPool,
      waitForHealthy,
      stopRecallPool,
    };

    const outcome = await stepMemoryBackend(SPLIT_ENABLED, true, tempConfigPath(), deps);

    expect(outcome).toEqual({ hindsightExpected: true, optedOut: false });
    // The authority is already up — it must NOT be restarted.
    expect(startContainer).not.toHaveBeenCalled();
    // The pool is (re)launched on the PUBLIC port (18888), not public+1.
    expect(startRecallPool).toHaveBeenCalledTimes(1);
    const poolArgs = startRecallPool.mock.calls[0][0];
    expect(poolArgs.poolPort).toBe(18888);
    expect(poolArgs.cfg.workers).toBe(4);
    // Ordering gate: authority (public+1 = 18889) healthy first, then pool (18888).
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889, 18888]);
  });

  it("threads the consumer's mirror_dir into the pool (#2578 creds parity)", async () => {
    // The pool serves reflect, which spends the consumer's OAuth credentials.
    // Dropped here, the pool mounts a private tmpfs and keeps serving reflect
    // on credentials up to a pull-interval stale after a broker failover,
    // while the authority beside it has the pushed ones.
    const startRecallPool = vi.fn();
    const config = {
      ...SPLIT_ENABLED,
      auth: { consumers: [{ name: "hindsight", mirror_dir: "/srv/creds/hindsight" }] },
    } as unknown as SwitchroomConfig;

    await stepMemoryBackend(config, true, tempConfigPath(), {
      dockerProbe: makeDockerProbe({ authorityUp: true }),
      recallPoolRunningProbe: () => false,
      startContainer: vi.fn(),
      startRecallPool,
      waitForHealthy: vi.fn(() => Promise.resolve(true)),
      stopRecallPool: vi.fn(),
    });

    expect(startRecallPool).toHaveBeenCalledTimes(1);
    expect(startRecallPool.mock.calls[0][0].mirrorDir).toBe("/srv/creds/hindsight");
  });

  it("builds the full split on a fresh host with the split enabled", async () => {
    const state = { authorityUp: false };
    // startContainer brings the authority "up" for the subsequent ready-check.
    const startContainer = vi.fn<NonNullable<MemoryBackendDeps["startContainer"]>>(() => {
      state.authorityUp = true;
    });
    const startRecallPool = vi.fn();
    const waitForHealthy = vi.fn((_port: number) => Promise.resolve(true));
    const stopRecallPool = vi.fn();

    const deps: MemoryBackendDeps = {
      dockerProbe: makeDockerProbe(state),
      recallPoolRunningProbe: () => false,
      startContainer,
      startRecallPool,
      waitForHealthy,
      stopRecallPool,
      readyRetries: 1,
      sleep: async () => {},
      // Deterministic port allocation — never bind a real OS socket (this host
      // may already run Hindsight on 18888/18889). Default pair is free.
      pickPorts: async () => ({ apiPort: 18888, uiPort: 19999 }),
      preflightPorts: async () => null,
    };

    const outcome = await stepMemoryBackend(SPLIT_ENABLED, true, tempConfigPath(), deps);

    expect(outcome).toEqual({ hindsightExpected: true, optedOut: false });
    // Authority started on public+1 (18889); the config url anchors the public
    // port at 18888 regardless of which free port pickHindsightPorts chose.
    expect(startContainer).toHaveBeenCalledTimes(1);
    expect(startContainer.mock.calls[0][0]).toEqual(
      expect.objectContaining({ apiPort: 18889 }),
    );
    // Pool on the public port.
    expect(startRecallPool).toHaveBeenCalledTimes(1);
    expect(startRecallPool.mock.calls[0][0].poolPort).toBe(18888);
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889, 18888]);
  });

  it("degrades to a single container on the public port when the pool never becomes healthy", async () => {
    // The outage finding: on a fresh split build the authority comes up on
    // public+1 but the pool never becomes healthy, so NOTHING is bound on the
    // public port that memory.config.url points at. The step must DEGRADE — stop
    // the parked authority and relaunch a sole container on the PUBLIC port —
    // and report success over a served endpoint, NOT throw into an outage.
    const state = { authorityUp: false };
    const startContainer = vi.fn<NonNullable<MemoryBackendDeps["startContainer"]>>(() => {
      state.authorityUp = true;
    });
    const startRecallPool = vi.fn();
    const stopRecallPool = vi.fn();
    const stopContainer = vi.fn();
    // authority(18889) healthy; pool(18888) never healthy; the single-container
    // fallback re-probed on the public port (18888) is healthy.
    const health = new Map<number, boolean[]>([
      [18889, [true]],
      [18888, [false, true]],
    ]);
    const waitForHealthy = vi.fn((port: number) =>
      Promise.resolve(health.get(port)!.shift() ?? true),
    );

    const deps: MemoryBackendDeps = {
      dockerProbe: makeDockerProbe(state),
      recallPoolRunningProbe: () => false,
      startContainer,
      stopContainer,
      startRecallPool,
      waitForHealthy,
      stopRecallPool,
      readyRetries: 1,
      sleep: async () => {},
      pickPorts: async () => ({ apiPort: 18888, uiPort: 19999 }),
      preflightPorts: async () => null,
    };

    const outcome = await stepMemoryBackend(SPLIT_ENABLED, true, tempConfigPath(), deps);

    // Success over a served public port — not a throw.
    expect(outcome).toEqual({ hindsightExpected: true, optedOut: false });
    // startContainer twice: authority on public+1 (18889), then the sole
    // fallback container on the PUBLIC port (18888).
    expect(startContainer).toHaveBeenCalledTimes(2);
    expect(startContainer.mock.calls[0][0]).toEqual(expect.objectContaining({ apiPort: 18889 }));
    expect(startContainer.mock.calls[1][0]).toEqual(expect.objectContaining({ apiPort: 18888 }));
    // The parked authority is stopped before the sole container relaunches.
    expect(stopContainer).toHaveBeenCalledTimes(1);
    // The pool was attempted once; the health gate ran authority, pool (fail),
    // then the single-container fallback on the public port.
    expect(startRecallPool).toHaveBeenCalledTimes(1);
    expect(waitForHealthy.mock.calls.map((c) => c[0])).toEqual([18889, 18888, 18888]);
  });

  it("REFUSES success when the authority is parked off the public port with no pool", async () => {
    // The production outage shape: the split was turned on (authority moved to
    // 18889), then the pool was removed / `enabled` set back to false WITHOUT
    // `--recreate`. The authority survives reboots on `--restart always`, so
    // `isHindsightRunning()` says yes forever while NOTHING is bound on 18888
    // and every agent's memory.config.url refuses. This step used to print
    // "already running" and return success over that.
    const startContainer = vi.fn();
    const startRecallPool = vi.fn();

    const splitDisabled = {
      memory: { config: { url: "http://127.0.0.1:18888/mcp/" } },
    } as unknown as SwitchroomConfig;

    const deps: MemoryBackendDeps = {
      dockerProbe: makeDockerProbe({ authorityUp: true }),
      recallPoolRunningProbe: () => false,
      // The live authority is bound to the split's background port, not 18888.
      runningPortsProbe: () => ({ apiPort: 18889, uiPort: 19999 }),
      startContainer,
      startRecallPool,
    };

    await expect(
      stepMemoryBackend(splitDisabled, true, tempConfigPath(), deps),
    ).rejects.toThrow(/Memory backend setup failed:.*running on port 18889.*points at 18888/s);
    // It must not paper over the outage by launching anything either.
    expect(startContainer).not.toHaveBeenCalled();
    expect(startRecallPool).not.toHaveBeenCalled();
  });

  it("accepts a correct split: authority off the public port BUT the pool serving it", async () => {
    // Same port mismatch as above; the difference is the pool is bound on
    // 18888. This is the intended topology — the guard must not fire, or every
    // split deployment fails its own setup step.
    const deps: MemoryBackendDeps = {
      dockerProbe: makeDockerProbe({ authorityUp: true }),
      recallPoolRunningProbe: () => true,
      runningPortsProbe: () => ({ apiPort: 18889, uiPort: 19999 }),
      startContainer: vi.fn(),
      startRecallPool: vi.fn(),
    };

    await expect(
      stepMemoryBackend(SPLIT_ENABLED, true, tempConfigPath(), deps),
    ).resolves.toEqual({ hindsightExpected: true, optedOut: false });
  });

  it("does not touch the pool seam when the split is disabled (strict opt-in)", async () => {
    const state = { authorityUp: false };
    const startContainer = vi.fn<NonNullable<MemoryBackendDeps["startContainer"]>>(() => {
      state.authorityUp = true;
    });
    const startRecallPool = vi.fn();
    const waitForHealthy = vi.fn((_port: number) => Promise.resolve(true));
    const stopRecallPool = vi.fn();

    const singleContainer = {
      memory: { config: { url: "http://127.0.0.1:18888/mcp/" } },
    } as unknown as SwitchroomConfig;

    const deps: MemoryBackendDeps = {
      dockerProbe: makeDockerProbe(state),
      startContainer,
      startRecallPool,
      waitForHealthy,
      stopRecallPool,
      readyRetries: 1,
      sleep: async () => {},
      // Deterministic port allocation — never bind a real OS socket (this host
      // may already run Hindsight on 18888/18889). Default pair is free.
      pickPorts: async () => ({ apiPort: 18888, uiPort: 19999 }),
      preflightPorts: async () => null,
    };

    const outcome = await stepMemoryBackend(singleContainer, true, tempConfigPath(), deps);

    expect(outcome).toEqual({ hindsightExpected: true, optedOut: false });
    // Single container binds the public port directly; no pool, no health-gate.
    expect(startContainer).toHaveBeenCalledTimes(1);
    expect(startContainer.mock.calls[0][0]).toEqual(
      expect.objectContaining({ apiPort: 18888 }),
    );
    expect(startRecallPool).not.toHaveBeenCalled();
    expect(waitForHealthy).not.toHaveBeenCalled();
  });
});
