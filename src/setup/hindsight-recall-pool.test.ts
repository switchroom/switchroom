/**
 * Optional Hindsight recall/background WORKER SPLIT provisioning.
 *
 * What these tests protect, in order of how badly a regression would hurt:
 *
 *   1. **OFF by default / backward compatibility.** With no `recall_pool`
 *      config, or `enabled` anything but literal `true`, the whole feature
 *      resolves to `null` and contributes nothing — the single-container path
 *      must stay byte-for-byte unchanged. A regression here silently spawns a
 *      second container (or worse, moves the public port) on every existing
 *      deployment.
 *   2. **The connection budget can never overflow pg0.** `max_connections=250`
 *      is a hard Postgres ceiling; overflow is a mid-load `FATAL: too many
 *      clients`, not a soft degrade. The auto-sizer must fit, and an operator
 *      override that would overflow must throw at resolve/launch, not at load.
 *   3. **Port derivation is deterministic and collision-free.** The authority
 *      container moves to public+1; the pool binds the unchanged public port.
 *   4. **The pool container is stateless + host-networked.** No pg0 data
 *      volume (it reads the authority's pg0), always `--network host` (pg0 is
 *      on loopback), background poller OFF, migrations OFF, external DB URL set.
 *   5. **Allowlist membership.** The seven keys the split emits are in
 *      `HINDSIGHT_PERF_ENV_KEYS`, so `switchroom doctor`'s unmanaged-key drift
 *      check does not flag a split deployment as drift.
 */

import { describe, expect, it, vi } from "vitest";

import { HINDSIGHT_PERF_ENV_KEYS } from "./hindsight-perf-defaults.js";
import {
  HINDSIGHT_BACKGROUND_CONNECTION_BUDGET,
  HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE,
  HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE,
  HINDSIGHT_PG_MAX_CONNECTIONS,
  HINDSIGHT_RECALL_POOL_CONNECTION_BUDGET,
  HINDSIGHT_RECALL_POOL_CONTAINER,
  HINDSIGHT_RECALL_POOL_DEFAULT_WORKERS,
  HINDSIGHT_RECALL_POOL_ENV_KEYS,
  HINDSIGHT_RECALL_POOL_HEADROOM,
  HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS,
  HINDSIGHT_RECALL_POOL_PG_DSN,
  publicPortIsUnserved,
  HINDSIGHT_RECALL_POOL_WORKER_ID,
  applyRecallPoolEnvOverrides,
  assertRecallPoolConnectionBudget,
  backgroundContainerPoolEnv,
  hindsightBackgroundApiPort,
  recallPoolDbPoolSizing,
  recallPoolEnabled,
  recallPoolEnvOverrides,
  resolveHindsightLaunchPorts,
  resolveRecallPoolConfig,
  startHindsightRecallPool,
  stopHindsightRecallPool,
  waitForHindsightHealthy,
} from "./hindsight-recall-pool.js";

/** Turn a flat `["run","-d",...]` docker argv into a lookup for -e KEY=VAL. */
function envFromDockerArgs(args: string[]): Map<string, string> {
  const env = new Map<string, string>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") {
      const [k, ...rest] = args[i + 1].split("=");
      env.set(k, rest.join("="));
    }
  }
  return env;
}

/** Collect all values passed to a repeated flag (e.g. every `-v` mount). */
function valuesForFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

describe("resolveRecallPoolConfig — OFF by default / opt-in", () => {
  it("returns null when config is absent", () => {
    expect(resolveRecallPoolConfig(undefined)).toBeNull();
    expect(recallPoolEnabled(undefined)).toBe(false);
  });

  it("returns null when enabled is missing, false, or a truthy non-true", () => {
    expect(resolveRecallPoolConfig({})).toBeNull();
    expect(resolveRecallPoolConfig({ enabled: false })).toBeNull();
    // Guards against a loose `if (input.enabled)` — a YAML string "true"
    // must NOT silently turn the feature on; only the boolean literal does.
    expect(
      resolveRecallPoolConfig({ enabled: "true" as unknown as boolean }),
    ).toBeNull();
    expect(resolveRecallPoolConfig({ enabled: 1 as unknown as boolean })).toBeNull();
  });

  it("resolves with the default worker count when enabled with no workers", () => {
    const cfg = resolveRecallPoolConfig({ enabled: true });
    expect(cfg).not.toBeNull();
    expect(cfg!.workers).toBe(HINDSIGHT_RECALL_POOL_DEFAULT_WORKERS);
    expect(recallPoolEnabled({ enabled: true })).toBe(true);
  });

  it("honors an explicit worker count and floors a fractional one", () => {
    expect(resolveRecallPoolConfig({ enabled: true, workers: 6 })!.workers).toBe(6);
    expect(resolveRecallPoolConfig({ enabled: true, workers: 6.9 })!.workers).toBe(6);
    // A zero / negative worker count falls back to the default, never 0.
    expect(resolveRecallPoolConfig({ enabled: true, workers: 0 })!.workers).toBe(
      HINDSIGHT_RECALL_POOL_DEFAULT_WORKERS,
    );
  });

  it("lets an operator pin per-worker pool sizes explicitly", () => {
    const cfg = resolveRecallPoolConfig({
      enabled: true,
      workers: 4,
      db_pool_max_size: 10,
      read_db_pool_max_size: 15,
    });
    expect(cfg!.dbPoolMaxSize).toBe(10);
    expect(cfg!.readDbPoolMaxSize).toBe(15);
  });
});

describe("connection budget invariant", () => {
  it("the module constants are internally consistent with pg0 max_connections", () => {
    expect(HINDSIGHT_BACKGROUND_CONNECTION_BUDGET).toBe(
      HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE + HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE,
    );
    // 250 - 10 headroom = 240 enforced ceiling; - 60 background = 180 pool budget.
    expect(HINDSIGHT_RECALL_POOL_HEADROOM).toBe(10);
    expect(HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS).toBe(
      HINDSIGHT_PG_MAX_CONNECTIONS - HINDSIGHT_RECALL_POOL_HEADROOM,
    );
    expect(HINDSIGHT_RECALL_POOL_CONNECTION_BUDGET).toBe(
      HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS - HINDSIGHT_BACKGROUND_CONNECTION_BUDGET,
    );
  });

  it("auto-sizing reproduces the live-validated 4-worker and 6-worker splits", () => {
    // 4 workers → 45/worker → write 18, read 27.
    expect(recallPoolDbPoolSizing(4)).toEqual({ dbPoolMaxSize: 18, readDbPoolMaxSize: 27 });
    // 6 workers → 30/worker → write 12, read 18.
    expect(recallPoolDbPoolSizing(6)).toEqual({ dbPoolMaxSize: 12, readDbPoolMaxSize: 18 });
  });

  it("auto-sized configs always fit under the enforced ceiling (headroom preserved)", () => {
    for (let workers = 1; workers <= 20; workers++) {
      const cfg = resolveRecallPoolConfig({ enabled: true, workers });
      // resolve throws if it would overflow, so a non-null return is proof it fits.
      expect(cfg).not.toBeNull();
      const total =
        cfg!.workers * (cfg!.dbPoolMaxSize + cfg!.readDbPoolMaxSize) +
        HINDSIGHT_BACKGROUND_CONNECTION_BUDGET;
      // The invariant is the ENFORCED ceiling (max_connections - headroom),
      // not the raw 250: the 10-slot headroom (subsuming PG's superuser
      // reserve) must stay free, so assert against 240, not 250.
      expect(total).toBeLessThanOrEqual(HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS);
      expect(HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS).toBeLessThan(
        HINDSIGHT_PG_MAX_CONNECTIONS,
      );
    }
  });

  it("rejects an operator override that would overflow the ceiling", () => {
    // 4 workers × (60 + 60) = 480 + 60 background = 540 ≫ 250.
    expect(() =>
      resolveRecallPoolConfig({
        enabled: true,
        workers: 4,
        db_pool_max_size: 60,
        read_db_pool_max_size: 60,
      }),
    ).toThrow(/connection budget overflow/);
  });

  it("assertRecallPoolConnectionBudget throws on the boundary + 1", () => {
    // The boundary is the ENFORCED ceiling (240 = max_connections - headroom),
    // NOT the raw 250 — one over the enforced ceiling eats the reserved
    // headroom and throws, even though it is still < max_connections.
    const room =
      HINDSIGHT_RECALL_POOL_MAX_TOTAL_CONNECTIONS - HINDSIGHT_BACKGROUND_CONNECTION_BUDGET;
    expect(() =>
      assertRecallPoolConnectionBudget({
        workers: 1,
        dbPoolMaxSize: room,
        readDbPoolMaxSize: 0,
      }),
    ).not.toThrow();
    // room + 1 lands at 241: over the 240 enforced ceiling, still under 250 —
    // proving the assertion guards the headroom, not just raw max_connections.
    expect(room + HINDSIGHT_BACKGROUND_CONNECTION_BUDGET + 1).toBeLessThan(
      HINDSIGHT_PG_MAX_CONNECTIONS,
    );
    expect(() =>
      assertRecallPoolConnectionBudget({
        workers: 1,
        dbPoolMaxSize: room + 1,
        readDbPoolMaxSize: 0,
      }),
    ).toThrow(/connection budget overflow/);
  });
});

describe("port derivation", () => {
  it("moves the authority container to public+1, leaving the public port for the pool", () => {
    expect(hindsightBackgroundApiPort(18888)).toBe(18889);
    // Non-default public port still gets a deterministic collision-free background port.
    expect(hindsightBackgroundApiPort(20000)).toBe(20001);
  });

  it("anchors the public port on config, ignoring the parked authority's public+1", () => {
    // Split ON, --recreate: getRunningHindsightPorts() reports the AUTHORITY,
    // which sits at public+1 (18889). memory.config.url still holds the public
    // port (18888) the launcher persisted. The public port MUST come from
    // config, not from the parked authority — else it creeps +1.
    const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
      recallEnabled: true,
      configUrlPort: 18888,
      reuseApiPort: 18889, // parked authority
      uiPort: 9999,
      defaultApiPort: 18888,
    });
    expect(publicApiPort).toBe(18888);
    expect(basePorts.apiPort).toBe(18889); // authority re-parks at public+1
  });

  it("falls back to the reused port when no url is persisted (no auto-migrate)", () => {
    // Fresh-ish --recreate of a single container on a non-default port, url
    // unset: keep the live port rather than silently migrating to the default.
    const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
      recallEnabled: false,
      configUrlPort: undefined,
      reuseApiPort: 9100,
      uiPort: 9101,
      defaultApiPort: 18888,
    });
    expect(publicApiPort).toBe(9100);
    expect(basePorts.apiPort).toBe(9100); // sole container binds the public port directly
  });

  it("uses the scaffolding default on a fresh host (nothing running or persisted)", () => {
    const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
      recallEnabled: false,
      configUrlPort: undefined,
      reuseApiPort: undefined,
      uiPort: 9999,
      defaultApiPort: 18888,
    });
    expect(publicApiPort).toBe(18888);
    expect(basePorts.apiPort).toBe(18888);
  });

  it(
    "keeps the public port and memory.config.url fixed across enabled true→false→true recreates",
    () => {
      // Regression for M1: toggling hindsight.recall_pool.enabled across
      // --recreate cycles must NOT creep the public port. We simulate the
      // launcher's recreate loop as a state machine:
      //   - persistedUrlPort: what memory.config.url holds (launcher persists
      //     publicApiPort after every launch — memory.ts line ~1246/1298).
      //   - runningAuthorityPort: what getRunningHindsightPorts() would report
      //     next time, i.e. the port the (authority|sole) container binds.
      const DEFAULT = 18888;
      const UI = 9999;

      // Fresh first launch, split ON.
      let persistedUrlPort: number | undefined = undefined;
      let runningAuthorityPort: number | undefined = undefined;

      const publicPortsSeen: number[] = [];
      const persistedUrlsSeen: number[] = [];

      // true (fresh) → true → false → true → false ... exercise both toggles
      // several times to catch any per-cycle drift, not just a single flip.
      const toggleSequence = [true, false, true, false, true, false, true];

      for (const enabled of toggleSequence) {
        const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
          recallEnabled: enabled,
          configUrlPort: persistedUrlPort,
          reuseApiPort: runningAuthorityPort, // --recreate reuse
          uiPort: UI,
          defaultApiPort: DEFAULT,
        });

        publicPortsSeen.push(publicApiPort);

        // The launcher persists the PUBLIC port to memory.config.url every run.
        persistedUrlPort = publicApiPort;
        persistedUrlsSeen.push(persistedUrlPort);

        // Next --recreate's getRunningHindsightPorts() reports the
        // (authority|sole) container's bound api port.
        runningAuthorityPort = basePorts.apiPort;
      }

      // The public port never moved off the default across any toggle.
      expect(publicPortsSeen).toEqual(toggleSequence.map(() => DEFAULT));
      // memory.config.url is pinned to the public port every cycle — never the
      // authority's public+1.
      expect(persistedUrlsSeen).toEqual(toggleSequence.map(() => DEFAULT));
      expect(persistedUrlsSeen).not.toContain(DEFAULT + 1);
    },
  );

  it("honors an operator-pinned non-default public port across toggles", () => {
    // Operator pinned memory.config.url to :20000. Both split states must keep
    // the public port at 20000 and never persist the +1 background port.
    const PIN = 20000;
    let persistedUrlPort: number | undefined = PIN;
    let runningAuthorityPort: number | undefined = undefined;
    for (const enabled of [true, false, true]) {
      const { publicApiPort, basePorts } = resolveHindsightLaunchPorts({
        recallEnabled: enabled,
        configUrlPort: persistedUrlPort,
        reuseApiPort: runningAuthorityPort,
        uiPort: 9999,
        defaultApiPort: 18888,
      });
      expect(publicApiPort).toBe(PIN);
      persistedUrlPort = publicApiPort;
      runningAuthorityPort = basePorts.apiPort;
    }
  });
});

describe("env overrides", () => {
  it("backgroundContainerPoolEnv caps the authority pools at the reserved budget", () => {
    expect(backgroundContainerPoolEnv()).toEqual({
      HINDSIGHT_API_DB_POOL_MAX_SIZE: String(HINDSIGHT_BACKGROUND_DB_POOL_MAX_SIZE),
      HINDSIGHT_API_READ_DB_POOL_MAX_SIZE: String(HINDSIGHT_BACKGROUND_READ_DB_POOL_MAX_SIZE),
    });
  });

  it("recallPoolEnvOverrides sets external DB, poller off, migrations off, N workers", () => {
    const cfg = resolveRecallPoolConfig({ enabled: true, workers: 4 })!;
    const ov = new Map(recallPoolEnvOverrides(cfg, 18888));
    expect(ov.get("HINDSIGHT_API_DATABASE_URL")).toBe(HINDSIGHT_RECALL_POOL_PG_DSN);
    expect(ov.get("HINDSIGHT_API_DB_URL")).toBe(HINDSIGHT_RECALL_POOL_PG_DSN);
    expect(ov.get("HINDSIGHT_API_WORKER_ENABLED")).toBe("false");
    expect(ov.get("HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP")).toBe("false");
    expect(ov.get("HINDSIGHT_ENABLE_CP")).toBe("false");
    expect(ov.get("HINDSIGHT_API_WORKERS")).toBe("4");
    expect(ov.get("HINDSIGHT_API_PORT")).toBe("18888");
    expect(ov.get("HINDSIGHT_API_WORKER_ID")).toBe(HINDSIGHT_RECALL_POOL_WORKER_ID);
    expect(ov.get("HINDSIGHT_API_DB_POOL_MAX_SIZE")).toBe(String(cfg.dbPoolMaxSize));
    expect(ov.get("HINDSIGHT_API_READ_DB_POOL_MAX_SIZE")).toBe(String(cfg.readDbPoolMaxSize));
  });

  it("applyRecallPoolEnvOverrides replaces in place and appends new keys once", () => {
    const base: Array<[string, string]> = [
      ["HINDSIGHT_API_PORT", "18889"],
      ["HINDSIGHT_API_WORKER_ENABLED", "true"],
      ["KEEP_ME", "1"],
    ];
    const merged = applyRecallPoolEnvOverrides(base, [
      ["HINDSIGHT_API_PORT", "18888"],
      ["HINDSIGHT_API_WORKER_ENABLED", "false"],
      ["HINDSIGHT_API_DATABASE_URL", HINDSIGHT_RECALL_POOL_PG_DSN],
    ]);
    // No key appears twice — docker last-wins would work, but drift tooling wants one entry.
    const keys = merged.map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
    const m = new Map(merged);
    expect(m.get("HINDSIGHT_API_PORT")).toBe("18888"); // replaced in place
    expect(m.get("HINDSIGHT_API_WORKER_ENABLED")).toBe("false"); // replaced in place
    expect(m.get("KEEP_ME")).toBe("1"); // untouched
    expect(m.get("HINDSIGHT_API_DATABASE_URL")).toBe(HINDSIGHT_RECALL_POOL_PG_DSN); // appended
  });
});

describe("startHindsightRecallPool — docker argv", () => {
  function runArgs(
    overrides: Partial<Parameters<typeof startHindsightRecallPool>[0]> = {},
  ) {
    const cfg = resolveRecallPoolConfig({ enabled: true, workers: 4 })!;
    const exec = vi.fn();
    startHindsightRecallPool({ cfg, poolPort: 18888, exec, ...overrides });
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("docker");
    return args as string[];
  }

  it("names the sibling container and runs it detached with restart=always", () => {
    const args = runArgs();
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(valuesForFlag(args, "--name")).toContain(HINDSIGHT_RECALL_POOL_CONTAINER);
    expect(valuesForFlag(args, "--restart")).toContain("always");
  });

  it("always uses --network host (pg0 + LiteLLM are on host loopback)", () => {
    expect(valuesForFlag(runArgs(), "--network")).toContain("host");
  });

  it("mounts NO pg0 data or backups volume — the pool is stateless", () => {
    const mounts = valuesForFlag(runArgs(), "-v");
    // The only volume is the auth-broker socket; no host path : /var/lib/... data volume.
    for (const m of mounts) {
      expect(m).not.toMatch(/pg0|pgdata|backups|\/data/i);
    }
  });

  it("health-cmd targets the pool's own port, not the image default 8888", () => {
    const args = runArgs();
    const healthCmd = valuesForFlag(args, "--health-cmd").join(" ");
    expect(healthCmd).toContain("localhost:18888");
    // The image default probe (localhost:8888) must be retargeted, not left in.
    expect(healthCmd).not.toContain("localhost:8888");
  });

  it("passes --gpus all only when gpu is enabled", () => {
    expect(valuesForFlag(runArgs({ gpu: true }), "--gpus")).toContain("all");
    expect(valuesForFlag(runArgs({ gpu: false }), "--gpus")).toHaveLength(0);
  });

  it("emits the recall-pool env (poller off, external DB, worker id) into -e flags", () => {
    const env = envFromDockerArgs(runArgs());
    expect(env.get("HINDSIGHT_API_WORKER_ENABLED")).toBe("false");
    expect(env.get("HINDSIGHT_API_DATABASE_URL")).toBe(HINDSIGHT_RECALL_POOL_PG_DSN);
    expect(env.get("HINDSIGHT_API_WORKER_ID")).toBe(HINDSIGHT_RECALL_POOL_WORKER_ID);
    expect(env.get("HINDSIGHT_API_WORKERS")).toBe("4");
    expect(env.get("HINDSIGHT_API_PORT")).toBe("18888");
  });

  it("re-proves the budget at the launch site (hand-built overflow config throws)", () => {
    const exec = vi.fn();
    expect(() =>
      startHindsightRecallPool({
        cfg: { workers: 10, dbPoolMaxSize: 60, readDbPoolMaxSize: 60 },
        poolPort: 18888,
        exec,
      }),
    ).toThrow(/connection budget overflow/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("stopHindsightRecallPool", () => {
  it("disables restart, stops, and force-removes the sibling — idempotent per step", () => {
    const calls: string[][] = [];
    stopHindsightRecallPool((_cmd, args) => {
      calls.push(args);
    });
    expect(calls).toContainEqual(["update", "--restart=no", HINDSIGHT_RECALL_POOL_CONTAINER]);
    expect(calls).toContainEqual(["stop", HINDSIGHT_RECALL_POOL_CONTAINER]);
    expect(calls).toContainEqual(["rm", "-f", HINDSIGHT_RECALL_POOL_CONTAINER]);
  });

  it("swallows a docker error at every step (container already gone)", () => {
    expect(() =>
      stopHindsightRecallPool(() => {
        throw new Error("No such container");
      }),
    ).not.toThrow();
  });
});

describe("waitForHindsightHealthy", () => {
  it("returns true as soon as /health answers 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const ok = await waitForHindsightHealthy(18889, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:18889/health",
      expect.anything(),
    );
  });

  it("keeps polling through connection-refused, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    const ok = await waitForHindsightHealthy(18888, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns false once the deadline passes", async () => {
    let t = 0;
    const now = () => t;
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const ok = await waitForHindsightHealthy(18888, {
      timeoutMs: 10,
      intervalMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // Each poll advances the clock past the deadline.
      sleep: async () => {
        t += 20;
      },
      now,
    });
    expect(ok).toBe(false);
  });
});

describe("env allowlist membership", () => {
  it("every key the split emits is in the perf env allowlist (no doctor drift)", () => {
    for (const k of HINDSIGHT_RECALL_POOL_ENV_KEYS) {
      expect(HINDSIGHT_PERF_ENV_KEYS.has(k)).toBe(true);
    }
  });

  it("the override keys the pool actually sets are all allowlisted", () => {
    const cfg = resolveRecallPoolConfig({ enabled: true, workers: 4 })!;
    for (const [k] of recallPoolEnvOverrides(cfg, 18888)) {
      // ENABLE_CP + API_HOST are base-container keys already emitted on the
      // single-container path; the seven NEW keys must be allowlisted.
      if (HINDSIGHT_RECALL_POOL_ENV_KEYS.includes(k)) {
        expect(HINDSIGHT_PERF_ENV_KEYS.has(k)).toBe(true);
      }
    }
  });
});

describe("publicPortIsUnserved — the half-built-topology outage guard", () => {
  // The production shape (2026-08): the split was applied by hand, the pool was
  // later removed, and `switchroom-hindsight` stayed parked on 18889 with
  // `--restart always` while every agent's memory.config.url pointed at 18888.
  // Nothing was bound on 18888 for weeks and every "is hindsight running?"
  // check said yes.
  it("fires when the authority is parked off the public port with no pool", () => {
    expect(
      publicPortIsUnserved({
        configUrlPort: 18888,
        authorityApiPort: 18889,
        poolRunning: false,
      }),
    ).toBe(true);
  });

  it("does NOT fire on a correct split — the pool owns the public port", () => {
    // Same port mismatch, but the pool IS bound on 18888. This is the intended
    // topology, not an outage; flagging it would break every split deployment.
    expect(
      publicPortIsUnserved({
        configUrlPort: 18888,
        authorityApiPort: 18889,
        poolRunning: true,
      }),
    ).toBe(false);
  });

  it("does NOT fire on a healthy single container", () => {
    expect(
      publicPortIsUnserved({
        configUrlPort: 18888,
        authorityApiPort: 18888,
        poolRunning: false,
      }),
    ).toBe(false);
  });

  it("stays silent with no declared public port (no memory.config.url pin)", () => {
    // Positive evidence only: with nothing declaring the public port there is
    // no port to be unserved, so a non-default authority port is legitimate.
    expect(
      publicPortIsUnserved({
        configUrlPort: undefined,
        authorityApiPort: 18889,
        poolRunning: false,
      }),
    ).toBe(false);
  });

  it("stays silent when the authority's port is unreadable", () => {
    // `docker port` / `docker inspect` unreadable ⇒ we cannot tell where it is
    // bound. Must never manufacture a refusal out of not knowing.
    expect(
      publicPortIsUnserved({
        configUrlPort: 18888,
        authorityApiPort: undefined,
        poolRunning: false,
      }),
    ).toBe(false);
  });
});
