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
  runMs365McpLauncher,
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
    let fetchCount = 0;
    let savedRefreshCb: (() => void) | null = null;

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
        spawnSofteria: () =>
          child1 as unknown as import("node:child_process").ChildProcess,
        setTimer: ((cb: () => void, _ms: number) => {
          if (!savedRefreshCb) savedRefreshCb = cb;
          return setTimeout(() => {}, 0);
        }) as typeof setTimeout,
        log: () => {},
      },
    );

    await new Promise((r) => setImmediate(r));

    // Fire refresh — fetchCreds will throw
    savedRefreshCb!();
    await new Promise((r) => setTimeout(r, 50));

    // After refresh failure, simulate the child dying on its own
    // (e.g. network drop). The launcher MUST propagate this as
    // unexpected — if the flag leaked, the launcher would swallow
    // the exit silently.
    child1.exitCode = 137;
    child1.emit("exit", 137, null);
    const code = await promise;
    expect(code).toBe(137);
    rmSync(hbDir, { recursive: true, force: true });
    delete process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  });
});
