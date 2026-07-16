/**
 * Tests for m365-mcp-launcher — RFC #1873 PR 3.
 *
 * Pure-function tests for the launcher's testable surface: arg
 * construction, env construction, refresh-delay calculation, heartbeat
 * file path, and a full run-loop integration test against an injected
 * stub broker + fake child process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";

import {
  buildSofteriaArgs,
  buildSofteriaEnv,
  computeRefreshDelayMs,
  DEFAULT_REFRESH_LEAD_MS,
  heartbeatPath,
  MAX_REFRESH_INTERVAL_MS,
  computeRestartBackoffMs,
  runMs365McpLauncher,
  SOFTERIA_RESTART_BASE_MS,
  SOFTERIA_RESTART_MAX_MS,
  SOFTERIA_MAX_RESTARTS,
  SOFTERIA_TOKEN_ENV,
  writeRefreshHeartbeat,
} from "./m365-mcp-launcher.js";

import {
  MICROSOFT_WORKSPACE_MCP_PACKAGE,
  MICROSOFT_WORKSPACE_MCP_PINNED_VERSION,
} from "../memory/scaffold-integration.js";

// ────────────────────────────────────────────────────────────────────────
// buildSofteriaArgs
// ────────────────────────────────────────────────────────────────────────

describe("buildSofteriaArgs", () => {
  it("pins package + version via npx -y", () => {
    const args = buildSofteriaArgs();
    expect(args[0]).toBe("-y");
    expect(args[1]).toBe(
      `${MICROSOFT_WORKSPACE_MCP_PACKAGE}@${MICROSOFT_WORKSPACE_MCP_PINNED_VERSION}`,
    );
  });

  it("omits --org-mode by default", () => {
    expect(buildSofteriaArgs()).not.toContain("--org-mode");
    expect(buildSofteriaArgs({ orgMode: false })).not.toContain("--org-mode");
  });

  it("appends --org-mode when requested", () => {
    expect(buildSofteriaArgs({ orgMode: true })).toContain("--org-mode");
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildSofteriaEnv
// ────────────────────────────────────────────────────────────────────────

describe("buildSofteriaEnv", () => {
  it("sets the softeria token env var on the merged env", () => {
    const env = buildSofteriaEnv("at-xyz", { FOO: "bar" });
    expect(env[SOFTERIA_TOKEN_ENV]).toBe("at-xyz");
    expect(env.FOO).toBe("bar");
  });

  it("overwrites an existing MS365_MCP_OAUTH_TOKEN", () => {
    const env = buildSofteriaEnv("new", {
      [SOFTERIA_TOKEN_ENV]: "old",
      OTHER: "x",
    });
    expect(env[SOFTERIA_TOKEN_ENV]).toBe("new");
    expect(env.OTHER).toBe("x");
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeRefreshDelayMs
// ────────────────────────────────────────────────────────────────────────

describe("computeRefreshDelayMs", () => {
  it("returns expires - now - lead when within range", () => {
    const now = 1_000_000;
    const expiresAt = now + 60 * 60 * 1000; // +1h
    const delay = computeRefreshDelayMs(expiresAt, now);
    expect(delay).toBe(60 * 60 * 1000 - DEFAULT_REFRESH_LEAD_MS);
  });

  it("returns 0 when already past the lead threshold", () => {
    const now = 1_000_000;
    const expiresAt = now + 2 * 60 * 1000; // +2min, lead is 5min
    expect(computeRefreshDelayMs(expiresAt, now)).toBe(0);
  });

  it("caps at MAX_REFRESH_INTERVAL_MS for long expiries", () => {
    const now = 1_000_000;
    const expiresAt = now + 24 * 60 * 60 * 1000; // +24h
    expect(computeRefreshDelayMs(expiresAt, now)).toBe(MAX_REFRESH_INTERVAL_MS);
  });

  it("respects custom lead time", () => {
    const now = 1_000_000;
    const expiresAt = now + 30 * 60 * 1000; // +30min
    const lead = 10 * 60 * 1000;
    expect(computeRefreshDelayMs(expiresAt, now, lead)).toBe(20 * 60 * 1000);
  });

  it("returns 0 when expires is in the past", () => {
    const now = 1_000_000;
    expect(computeRefreshDelayMs(now - 1000, now)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// heartbeat
// ────────────────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  const agent = "test-agent-hb";
  let hbDir: string;
  let path: string;

  beforeEach(() => {
    hbDir = `/tmp/m365-hb-test-${process.pid}-${Date.now()}-${Math.random()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    path = heartbeatPath(agent);
  });

  afterEach(() => {
    if (existsSync(hbDir)) rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });

  it("writes a heartbeat file at the canonical path", () => {
    writeRefreshHeartbeat(agent, {
      lastRefreshMs: 1_000,
      nextRefreshMs: 2_000,
      expiresAtMs: 3_000,
    });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.lastRefreshMs).toBe(1_000);
    expect(parsed.nextRefreshMs).toBe(2_000);
    expect(parsed.expiresAtMs).toBe(3_000);
  });

  it("default heartbeatPath is /state/agent/ (in-container, host-readable via bind mount)", () => {
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
    const p = heartbeatPath("alice");
    expect(p).toBe("/state/agent/m365-launcher.heartbeat.json");
  });

  it("SWITCHROOM_M365_HEARTBEAT_DIR override works for tests", () => {
    expect(heartbeatPath("alice")).toContain(hbDir);
    expect(heartbeatPath("alice")).toContain("m365-launcher-alice.heartbeat.json");
  });

  it("write failure does not throw (observability-only)", () => {
    // Pass a name that can't be written (the function swallows errors).
    expect(() =>
      writeRefreshHeartbeat("\0invalid\0", {
        lastRefreshMs: 0,
        nextRefreshMs: 0,
        expiresAtMs: 0,
      }),
    ).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────
// runMs365McpLauncher — integration with stub broker + fake child
// ────────────────────────────────────────────────────────────────────────

function makeFakeChild(): EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: string) => boolean;
  exitCode: number | null;
  signalCode: string | null;
} {
  const ee = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => boolean;
    exitCode: number | null;
    signalCode: string | null;
  };
  ee.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  ee.stdout = new Readable({ read() {} });
  ee.stderr = new Readable({ read() {} });
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = (signal?: string) => {
    setImmediate(() => {
      ee.exitCode = 0;
      ee.signalCode = signal ?? "SIGTERM";
      ee.emit("exit", 0, signal ?? "SIGTERM");
    });
    return true;
  };
  return ee;
}

describe("runMs365McpLauncher", () => {
  it("acquires creds + spawns softeria with token env var set", async () => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const child = makeFakeChild();
    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => ({
          accessToken: "at-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
        spawnSofteria: (env) => {
          spawnedEnv = env;
          return child as unknown as ReturnType<typeof makeFakeChild> &
            import("node:child_process").ChildProcess;
        },
        log: () => {},
      },
    );

    // Let microtasks resolve so spawnSofteria fires.
    await new Promise((r) => setImmediate(r));
    expect(spawnedEnv?.[SOFTERIA_TOKEN_ENV]).toBe("at-1");

    // Simulate the child dying so the launcher returns.
    child.exitCode = 0;
    child.emit("exit", 0, null);
    const code = await promise;
    expect(code).toBe(0);
  });

  it("returns 1 when initial broker call fails", async () => {
    const code = await runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => {
          throw new Error("broker unreachable");
        },
        spawnSofteria: () =>
          ({}) as unknown as import("node:child_process").ChildProcess,
        log: () => {},
      },
    );
    expect(code).toBe(1);
  });

  it("schedules a refresh timer based on token expiry", async () => {
    let scheduledMs: number | undefined;
    const child = makeFakeChild();
    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => ({
          accessToken: "at-1",
          expiresAt: Date.now() + 30 * 60 * 1000, // +30min
        }),
        spawnSofteria: () =>
          child as unknown as import("node:child_process").ChildProcess,
        setTimer: ((cb: () => void, ms: number) => {
          scheduledMs = ms;
          return setTimeout(() => {}, 0); // never actually fire
        }) as typeof setTimeout,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));
    // Should schedule for ~25min (30 - 5 lead)
    expect(scheduledMs).toBeGreaterThan(20 * 60 * 1000);
    expect(scheduledMs).toBeLessThan(30 * 60 * 1000);

    // Cleanup
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await promise;
  });

  it("writes a heartbeat after scheduling refresh", async () => {
    const hbDir = `/tmp/m365-test-hb-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_AGENT_NAME = "test-launcher-heartbeat";
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const child = makeFakeChild();
    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => ({
          accessToken: "at-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
        spawnSofteria: () =>
          child as unknown as import("node:child_process").ChildProcess,
        setTimer: ((_cb: () => void, _ms: number) =>
          setTimeout(() => {}, 0)) as typeof setTimeout,
        log: () => {},
      },
    );
    await new Promise((r) => setImmediate(r));
    const path = heartbeatPath("test-launcher-heartbeat");
    expect(existsSync(path)).toBe(true);
    rmSync(hbDir, { recursive: true, force: true });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await promise;
    delete process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });

  it("refresh-tick callback fires: kills old child, spawns new with fresh token", async () => {
    const hbDir = `/tmp/m365-test-refresh-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    let spawnCount = 0;
    const spawnedTokens: string[] = [];
    let savedRefreshCb: (() => void) | null = null;

    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => ({
          accessToken: `at-${++spawnCount}`,
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
        spawnSofteria: (env) => {
          spawnedTokens.push(env[SOFTERIA_TOKEN_ENV] as string);
          return spawnCount === 1
            ? (child1 as unknown as import("node:child_process").ChildProcess)
            : (child2 as unknown as import("node:child_process").ChildProcess);
        },
        setTimer: ((cb: () => void, _ms: number) => {
          // Capture the first call's callback (the refresh tick); leave
          // any later setTimer calls as no-ops.
          if (!savedRefreshCb) savedRefreshCb = cb;
          return setTimeout(() => {}, 0);
        }) as typeof setTimeout,
        log: () => {},
      },
    );

    // Wait for initial spawn + scheduling
    await new Promise((r) => setImmediate(r));
    expect(spawnedTokens[0]).toBe("at-1");
    expect(savedRefreshCb).not.toBeNull();

    // Fire the refresh tick. This will:
    //   1. mint at-2 from fetchCreds
    //   2. await killChild(child1) — child1.kill() schedules an exit event
    //   3. spawn child2 with at-2
    savedRefreshCb!();
    // Let kill + respawn complete
    await new Promise((r) => setTimeout(r, 50));

    expect(spawnedTokens.length).toBe(2);
    expect(spawnedTokens[1]).toBe("at-2");

    // Cleanup — child2 dies "unexpectedly" so the launcher resolves
    child2.exitCode = 0;
    child2.emit("exit", 0, null);
    const code = await promise;
    expect(code).toBe(0);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });

  it("refresh failure does NOT leak restartingForRefresh flag (PR3 R1 bug)", async () => {
    const hbDir = `/tmp/m365-test-leak-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    let fetchCount = 0;
    let spawnCount = 0;
    let savedRefreshCb: (() => void) | null = null;
    const backoffCbs: Array<() => void> = [];

    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => {
          fetchCount++;
          if (fetchCount === 1) {
            return { accessToken: "at-1", expiresAt: Date.now() + 60 * 60 * 1000 };
          }
          // Second call (refresh tick) fails
          throw new Error("broker transient failure");
        },
        spawnSofteria: () => {
          spawnCount++;
          return (spawnCount === 1 ? child1 : child2) as unknown as
            import("node:child_process").ChildProcess;
        },
        setTimer: ((cb: () => void, _ms: number) => {
          if (!savedRefreshCb) savedRefreshCb = cb;
          else backoffCbs.push(cb);
          return setTimeout(() => {}, 0);
        }) as typeof setTimeout,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));

    // Fire refresh — fetchCreds will throw
    savedRefreshCb!();
    await new Promise((r) => setTimeout(r, 50));

    // After refresh failure, simulate the child crashing on its own
    // (e.g. network drop, exit 137). The launcher MUST act on this exit —
    // if restartingForRefresh had leaked, the exit would be swallowed
    // silently. With the token still valid, the correct action is a
    // crash-loop backoff re-spawn (issue #2586), NOT a launcher exit.
    child1.exitCode = 137;
    child1.emit("exit", 137, null);
    await new Promise((r) => setImmediate(r));

    // A backoff timer was scheduled (the exit was acted on, not swallowed).
    expect(backoffCbs.length).toBeGreaterThanOrEqual(1);
    // Fire it — softeria re-spawns in-process with the SAME cached token and
    // no extra broker fetch.
    backoffCbs[backoffCbs.length - 1]!();
    await new Promise((r) => setImmediate(r));
    expect(spawnCount).toBe(2);

    // Cleanup — child2 exits cleanly so the launcher resolves.
    child2.exitCode = 0;
    child2.emit("exit", 0, null);
    const code = await promise;
    expect(code).toBe(0);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeRestartBackoffMs — issue #2586
// ────────────────────────────────────────────────────────────────────────

describe("computeRestartBackoffMs", () => {
  it("starts at the base delay for attempt 0", () => {
    expect(computeRestartBackoffMs(0)).toBe(SOFTERIA_RESTART_BASE_MS);
  });

  it("doubles per attempt (exponential backoff)", () => {
    expect(computeRestartBackoffMs(1)).toBe(SOFTERIA_RESTART_BASE_MS * 2);
    expect(computeRestartBackoffMs(2)).toBe(SOFTERIA_RESTART_BASE_MS * 4);
    expect(computeRestartBackoffMs(3)).toBe(SOFTERIA_RESTART_BASE_MS * 8);
  });

  it("caps at SOFTERIA_RESTART_MAX_MS", () => {
    expect(computeRestartBackoffMs(100)).toBe(SOFTERIA_RESTART_MAX_MS);
  });

  it("treats negative attempts as attempt 0", () => {
    expect(computeRestartBackoffMs(-5)).toBe(SOFTERIA_RESTART_BASE_MS);
  });
});

// ────────────────────────────────────────────────────────────────────────
// crash-loop backoff — issue #2586 (get-credentials retry-storm)
// ────────────────────────────────────────────────────────────────────────

describe("runMs365McpLauncher — crash-loop backoff (#2586)", () => {
  it("re-spawns softeria on crash WITHOUT a fresh broker fetch while token is valid", async () => {
    const hbDir = `/tmp/m365-test-storm-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const children = [makeFakeChild(), makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    let fetchCount = 0;
    let savedRefreshCb: (() => void) | null = null;
    const backoffCbs: Array<() => void> = [];

    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => {
          fetchCount++;
          return { accessToken: "at-1", expiresAt: Date.now() + 60 * 60 * 1000 };
        },
        spawnSofteria: () => {
          const c = children[spawnCount++];
          return c as unknown as import("node:child_process").ChildProcess;
        },
        setTimer: ((cb: () => void, _ms: number) => {
          if (!savedRefreshCb) savedRefreshCb = cb;
          else backoffCbs.push(cb);
          return setTimeout(() => {}, 0);
        }) as typeof setTimeout,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));
    expect(spawnCount).toBe(1);
    expect(fetchCount).toBe(1);

    // softeria crashes (exit 137) twice — each time the launcher must
    // re-spawn with the cached token and MUST NOT call fetchCreds again.
    for (let i = 0; i < 2; i++) {
      children[i].exitCode = 137;
      children[i].emit("exit", 137, null);
      await new Promise((r) => setImmediate(r));
      backoffCbs[backoffCbs.length - 1]!();
      await new Promise((r) => setImmediate(r));
    }

    expect(spawnCount).toBe(3); // initial + 2 re-spawns
    expect(fetchCount).toBe(1); // NO extra broker fetch — storm defused

    // Cleanup — clean exit resolves the launcher.
    children[2].exitCode = 0;
    children[2].emit("exit", 0, null);
    const code = await promise;
    expect(code).toBe(0);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });

  it("propagates exit (no backoff) when the cached token has already expired", async () => {
    const hbDir = `/tmp/m365-test-exp-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const child = makeFakeChild();
    let clock = 1_000_000;
    const promise = runMs365McpLauncher(
      {},
      {
        // Token valid for only 10ms of virtual time.
        fetchCreds: async () => ({ accessToken: "at-1", expiresAt: clock + 10 }),
        spawnSofteria: () =>
          child as unknown as import("node:child_process").ChildProcess,
        setTimer: ((_cb: () => void, _ms: number) =>
          setTimeout(() => {}, 0)) as typeof setTimeout,
        now: () => clock,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));
    // Advance virtual clock past expiry, then crash.
    clock += 1000;
    child.exitCode = 137;
    child.emit("exit", 137, null);
    const code = await promise;
    // Token expired → launcher exits (defers to fresh-creds respawn), no
    // in-process backoff loop.
    expect(code).toBe(137);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });

  it("gives up after SOFTERIA_MAX_RESTARTS consecutive rapid crashes", async () => {
    const hbDir = `/tmp/m365-test-giveup-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    // Enough children for the initial spawn + MAX_RESTARTS re-spawns.
    const children = Array.from({ length: SOFTERIA_MAX_RESTARTS + 2 }, () =>
      makeFakeChild(),
    );
    let spawnCount = 0;
    const clock = 5_000_000;
    let savedRefreshCb: (() => void) | null = null;
    const backoffCbs: Array<() => void> = [];

    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => ({
          accessToken: "at-1",
          expiresAt: clock + 60 * 60 * 1000,
        }),
        spawnSofteria: () =>
          children[spawnCount++] as unknown as
            import("node:child_process").ChildProcess,
        setTimer: ((cb: () => void, _ms: number) => {
          if (!savedRefreshCb) savedRefreshCb = cb;
          else backoffCbs.push(cb);
          return setTimeout(() => {}, 0);
        }) as typeof setTimeout,
        // Pin the clock so every crash counts as "rapid" (never stable).
        now: () => clock,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));

    // Crash repeatedly with no stable window between restarts.
    let code: number | undefined;
    let done = false;
    promise.then((c) => {
      code = c;
      done = true;
    });
    for (let i = 0; i < SOFTERIA_MAX_RESTARTS + 1 && !done; i++) {
      children[i].exitCode = 1;
      children[i].emit("exit", 1, null);
      await new Promise((r) => setImmediate(r));
      if (backoffCbs.length > 0 && !done) {
        backoffCbs[backoffCbs.length - 1]!();
        await new Promise((r) => setImmediate(r));
      }
    }

    await promise;
    // After the restart budget is exhausted the launcher exits rather than
    // spinning forever.
    expect(code).toBe(1);
    expect(spawnCount).toBeLessThanOrEqual(SOFTERIA_MAX_RESTARTS + 1);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });

  it("refresh firing during a pending crash-backoff does NOT double-spawn (#2997 review blocker)", async () => {
    const hbDir = `/tmp/m365-test-dblspawn-${process.pid}-${Date.now()}`;
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const children = [makeFakeChild(), makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    let fetchCount = 0;

    // Timer registry that models real cancellation: a cleared timer must not
    // fire. This is what lets the test prove the refresh path cancels the
    // pending backoff timer (fix #1) rather than the harness silently allowing
    // a second spawn.
    interface FakeTimer {
      cb: () => void;
      cancelled: boolean;
    }
    const timers: FakeTimer[] = [];
    const fire = (t: FakeTimer): void => {
      if (!t.cancelled) t.cb();
    };

    const promise = runMs365McpLauncher(
      {},
      {
        fetchCreds: async () => {
          fetchCount++;
          return {
            accessToken: `at-${fetchCount}`,
            expiresAt: Date.now() + 60 * 60 * 1000,
          };
        },
        spawnSofteria: () =>
          children[spawnCount++] as unknown as
            import("node:child_process").ChildProcess,
        setTimer: ((cb: () => void, _ms: number) => {
          const t: FakeTimer = { cb, cancelled: false };
          timers.push(t);
          return t as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimer: ((h: unknown) => {
          if (h) (h as FakeTimer).cancelled = true;
        }) as typeof clearTimeout,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));
    expect(spawnCount).toBe(1);
    const refreshTimer = timers[0]; // first schedule = refresh tick

    // softeria crashes → a backoff re-spawn timer is scheduled and the dead
    // child is nulled out (fix #2).
    children[0].exitCode = 137;
    children[0].emit("exit", 137, null);
    await new Promise((r) => setImmediate(r));
    const backoffTimer = timers[1];
    expect(backoffTimer).toBeDefined();
    expect(backoffTimer.cancelled).toBe(false);

    // The refresh tick now fires WHILE the backoff timer is still pending.
    // It must cancel that backoff timer (fix #1) and spawn exactly one fresh
    // child — not race the backoff into a second parallel softeria.
    fire(refreshTimer);
    await new Promise((r) => setTimeout(r, 30)); // let async fetch/kill settle

    expect(backoffTimer.cancelled).toBe(true); // fix #1 — backoff cancelled
    expect(spawnCount).toBe(2); // exactly one respawn (fresh-creds child)
    expect(fetchCount).toBe(2); // the refresh fetched; backoff would not have

    // Belt-and-suspenders: even if some stale reference tried to fire the
    // cancelled backoff timer, it is a no-op — still exactly one live child.
    fire(backoffTimer);
    await new Promise((r) => setImmediate(r));
    expect(spawnCount).toBe(2);

    // Cleanup — the one live child exits cleanly, launcher resolves.
    children[1].exitCode = 0;
    children[1].emit("exit", 0, null);
    const code = await promise;
    expect(code).toBe(0);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });
});

// ────────────────────────────────────────────────────────────────────────
// Multi-account per agent — enabled-tools + per-slug heartbeat isolation
// ────────────────────────────────────────────────────────────────────────

describe("buildSofteriaArgs — --enabled-tools (per-account tool scope)", () => {
  it("appends --enabled-tools when a pattern is given", () => {
    const args = buildSofteriaArgs({ enabledTools: "list-mail-messages|get-mail-message" });
    const i = args.indexOf("--enabled-tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("list-mail-messages|get-mail-message");
  });

  it("omits --enabled-tools when absent (all tools)", () => {
    expect(buildSofteriaArgs()).not.toContain("--enabled-tools");
    expect(buildSofteriaArgs({ orgMode: true })).not.toContain("--enabled-tools");
  });
});

describe("heartbeatPath — per-slug isolation for N launchers", () => {
  const hbDir = `/tmp/m365-multi-hb-${process.pid}-${Date.now()}`;
  beforeEach(() => {
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
  });
  afterEach(() => {
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
    rmSync(hbDir, { recursive: true, force: true });
  });

  it("two accounts on one agent get DISTINCT heartbeat files (no clobber)", () => {
    const a = heartbeatPath("marko", "alice@example.com");
    const b = heartbeatPath("marko", "bob@example.com");
    expect(a).not.toBe(b);
    // both are per-slug, not the bare single-account path
    expect(a).not.toContain("m365-launcher-marko.heartbeat.json");
    expect(b).not.toContain("m365-launcher-marko.heartbeat.json");
  });

  it("no account (single-account) keeps the bare per-agent path", () => {
    const p = heartbeatPath("marko");
    expect(p).toContain("m365-launcher-marko.heartbeat.json");
  });

  it("writing two accounts' heartbeats leaves both files intact", () => {
    writeRefreshHeartbeat("marko", { lastRefreshMs: 1, nextRefreshMs: 2, expiresAtMs: 3 }, "alice@example.com");
    writeRefreshHeartbeat("marko", { lastRefreshMs: 4, nextRefreshMs: 5, expiresAtMs: 6 }, "bob@example.com");
    const a = heartbeatPath("marko", "alice@example.com");
    const b = heartbeatPath("marko", "bob@example.com");
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(JSON.parse(readFileSync(a, "utf-8")).lastRefreshMs).toBe(1);
    expect(JSON.parse(readFileSync(b, "utf-8")).lastRefreshMs).toBe(4);
  });
});

describe("runMs365McpLauncher — per-account (multi) writes a per-slug heartbeat", () => {
  const hbDir = `/tmp/m365-run-multi-hb-${process.pid}-${Date.now()}`;
  afterEach(() => {
    delete process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
    rmSync(hbDir, { recursive: true, force: true });
  });

  it("keys the heartbeat by the --account slug and threads that account's token", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "marko";
    process.env.SWITCHROOM_M365_HEARTBEAT_DIR = hbDir;
    const account = "bob@example.com";
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const child = makeFakeChild();
    const promise = runMs365McpLauncher(
      { account },
      {
        fetchCreds: async () => ({ accessToken: "at-mail", expiresAt: Date.now() + 60 * 60 * 1000 }),
        spawnSofteria: (env) => {
          spawnedEnv = env;
          return child as unknown as import("node:child_process").ChildProcess;
        },
        setTimer: ((_cb: () => void, _ms: number) => setTimeout(() => {}, 0)) as typeof setTimeout,
        log: () => {},
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(spawnedEnv?.[SOFTERIA_TOKEN_ENV]).toBe("at-mail");
    // heartbeat lands at the per-slug path, NOT the bare single-account path.
    expect(existsSync(heartbeatPath("marko", account))).toBe(true);
    expect(existsSync(heartbeatPath("marko"))).toBe(false);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await promise;
  });
});
