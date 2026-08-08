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
