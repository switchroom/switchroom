/**
 * #2495 — auth-broker quota state durability + realtime probe-on-open.
 *
 * Covers:
 *   - Change 1: durable quota cache (write → reload → identical incl. markers).
 *   - Change 2: probe-on-open TTL (a fresh cache hit serves cache, skips the
 *     upstream probe) + single-flight (two concurrent probe-quota → one call)
 *     + stale-fallback labeling (a failed probe is served `cache`, not `live`).
 *   - Change 2/3: forceLive bypasses the TTL gate (the quota-watch
 *     corroboration probe is a TRUE live probe).
 *
 * Strategy mirrors server.test.ts: a tmpdir broker reachable over a real UDS,
 * probes injected via `_testFetchQuota`. Never touches `~/.switchroom`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-quota-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try { rmSync(h.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  harnesses = [];
});

function makeConfig(h: Harness, active: string): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: { ziggy: {} },
    auth: { active },
    google_workspace: undefined,
  } as unknown) as SwitchroomConfig;
}

function seedAccount(h: Harness, label: string): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: `at-${label}`,
        refreshToken: `rt-${label}`,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    h.home,
  );
}

async function rpc(socketPath: string, req: object): Promise<any> {
  return await new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* ignore */ }
      if (err) rejectP(err); else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try { settle(decodeResponse(buf.slice(0, nl))); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

const okProbe = (five: number, seven: number) => ({
  ok: true as const,
  data: {
    fiveHourUtilizationPct: five,
    sevenDayUtilizationPct: seven,
    fiveHourResetAt: new Date(Date.now() + 60 * 60 * 1000),
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
    fiveHourUtilPresent: true,
    sevenDayUtilPresent: true,
  },
});

describe("#2495 Change 1 — durable quota cache", () => {
  it("write → reload → identical snapshot incl. presence markers", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => okProbe(42, 7),
    });
    await broker.start();
    // A live probe populates AND persists the cache.
    await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "probe-quota", accounts: ["default"],
    });
    const before = broker._state().lastQuotaCache["default"];
    expect(before?.fiveHourUtilizationPct).toBe(42);
    expect(before?.fiveHourUtilPresent).toBe(true);
    expect(before?.sevenDayUtilPresent).toBe(true);
    expect(typeof before?.capturedAt).toBe("number");
    // The durable file exists on disk.
    expect(existsSync(join(h.stateDir, "last-quota.json"))).toBe(true);
    broker.stop();

    // A FRESH broker reloads it — serving last-known instead of blank.
    const broker2 = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => okProbe(99, 99), // would differ if it re-probed
    });
    await broker2.start();
    const reloaded = broker2._state().lastQuotaCache["default"];
    expect(reloaded).toEqual(before); // identical, markers and capturedAt included
    broker2.stop();
  });

  it("on-disk file matches the in-memory cache byte-for-byte", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => okProbe(12, 34),
    });
    await broker.start();
    await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "probe-quota", accounts: ["default"],
    });
    const onDisk = JSON.parse(readFileSync(join(h.stateDir, "last-quota.json"), "utf-8"));
    expect(onDisk["default"]).toEqual(broker._state().lastQuotaCache["default"]);
    broker.stop();
  });
});

describe("#2495 Change 2 — probe-on-open TTL + single-flight", () => {
  it("a fresh cache hit serves cache and skips the upstream probe (TTL gate)", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    let calls = 0;
    const broker = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => { calls++; return okProbe(50, 5); },
    });
    await broker.start();
    // First probe goes live.
    const r1: any = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "probe-quota", accounts: ["default"],
    });
    expect(calls).toBe(1);
    expect(r1.data.results[0].served).toBe("live");
    // Second probe within the TTL serves cache — no new upstream call.
    const r2: any = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "2", op: "probe-quota", accounts: ["default"],
    });
    expect(calls).toBe(1);
    expect(r2.data.results[0].served).toBe("cache");
    expect(typeof r2.data.results[0].capturedAt).toBe("number");
    broker.stop();
  });

  it("single-flight: two concurrent probes (cold cache) trigger ONE upstream call", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const broker = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      // TTL disabled so both requests reach the single-flight layer (cold cache).
      _testFetchQuota: async () => { calls++; await gate; return okProbe(60, 6); },
    });
    process.env.SWITCHROOM_QUOTA_PROBE_TTL_MS = "0";
    await broker.start();
    const sock = join(h.socketRoot, "ziggy", "sock");
    const p1 = rpc(sock, { v: 1, id: "1", op: "probe-quota", accounts: ["default"] });
    const p2 = rpc(sock, { v: 1, id: "2", op: "probe-quota", accounts: ["default"] });
    // Let both requests reach the in-flight coalescer before the probe resolves.
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b]: any[] = await Promise.all([p1, p2]);
    expect(calls).toBe(1); // coalesced
    expect(a.data.results[0].result.ok).toBe(true);
    expect(b.data.results[0].result.ok).toBe(true);
    delete process.env.SWITCHROOM_QUOTA_PROBE_TTL_MS;
    broker.stop();
  });

  it("stale-fallback labeling: a failed probe is served from cache, tagged `cache`", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    let mode: "ok" | "fail" = "ok";
    const broker = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => (mode === "ok" ? okProbe(33, 3) : { ok: false as const, reason: "HTTP 503" }),
    });
    process.env.SWITCHROOM_QUOTA_PROBE_TTL_MS = "0"; // force live attempt every time
    await broker.start();
    const sock = join(h.socketRoot, "ziggy", "sock");
    // Seed the cache with a good snapshot.
    await rpc(sock, { v: 1, id: "1", op: "probe-quota", accounts: ["default"] });
    // Now the live probe fails — we must fall back to the cached snapshot,
    // tagged `cache` so the card stamps "⚠ cached Nm ago".
    mode = "fail";
    const r: any = await rpc(sock, { v: 1, id: "2", op: "probe-quota", accounts: ["default"] });
    expect(r.data.results[0].served).toBe("cache");
    expect(r.data.results[0].result.ok).toBe(true); // served the prior good data
    expect(r.data.results[0].result.data.fiveHourUtilizationPct).toBe(33);
    delete process.env.SWITCHROOM_QUOTA_PROBE_TTL_MS;
    broker.stop();
  });

  it("forceLive bypasses the TTL gate (quota-watch corroboration goes live)", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    let calls = 0;
    const broker = new AuthBroker(makeConfig(h, "default"), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => { calls++; return okProbe(70, 7); },
    });
    await broker.start();
    const sock = join(h.socketRoot, "ziggy", "sock");
    await rpc(sock, { v: 1, id: "1", op: "probe-quota", accounts: ["default"] });
    expect(calls).toBe(1);
    // A normal probe within TTL would serve cache (calls stays 1)...
    await rpc(sock, { v: 1, id: "2", op: "probe-quota", accounts: ["default"] });
    expect(calls).toBe(1);
    // ...but forceLive must hit the upstream regardless of the fresh cache.
    const r: any = await rpc(sock, { v: 1, id: "3", op: "probe-quota", accounts: ["default"], forceLive: true });
    expect(calls).toBe(2);
    expect(r.data.results[0].served).toBe("live");
    broker.stop();
  });
});
