/**
 * Unpinned consumers follow the fleet active (consumer-unpin change).
 *
 * `auth.consumers[].account` is now optional. A consumer WITHOUT a pin
 * rides `auth.active` exactly like an override-less agent: same swaps
 * (set-active / auto-promote), same exhaustion failover, and its
 * mark-exhausted attributes to the active (agent parity). Pinned
 * consumers keep the pre-change isolation semantics — the pinned paths
 * are pinned by server.test.ts and stay untouched here.
 *
 * Same tmpdir-isolation strategy as server.test.ts (never ~/.switchroom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { fetchQuota } from "../quota.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-follow-active-"));
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

function makeConfig(h: Harness, overrides: Partial<{
  active: string;
  fallback_order: string[];
  admin_agents: string[];
  agents: Record<string, { auth?: { override?: string }; admin?: boolean }>;
  consumers: Array<{ name: string; account?: string; uid?: number; mirror_dir?: string }>;
}> = {}): SwitchroomConfig {
  const agents = { ...(overrides.agents ?? {}) } as Record<
    string,
    { auth?: { override?: string }; admin?: boolean }
  >;
  for (const name of overrides.admin_agents ?? []) {
    agents[name] = { ...(agents[name] ?? {}), admin: true };
  }
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents,
    auth: {
      active: overrides.active,
      fallback_order: overrides.fallback_order,
      consumers: overrides.consumers,
    },
  } as unknown) as SwitchroomConfig;
}

async function rpc(socketPath: string, req: object): Promise<unknown> {
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

/**
 * Offline quota-probe seam — MANDATORY for every broker in this file.
 *
 * `mark-exhausted` awaits a LIVE quota probe inside the request path:
 * `markExhaustedAndRoll` → `nextHealthyAccountLive` → `probeAndCacheOne` →
 * `fetchQuota`, which force-probes every fallback candidate whose eligibility
 * is still `unknown`. `fetchQuota`'s default abort is 10s (src/auth/quota.ts),
 * i.e. more than 3x the `rpc()` deadline above, so an un-injected broker makes
 * these tests latency-bound on api.anthropic.com — they fail with
 * `Error: rpc timeout` whenever the runner's egress is slow (observed on CI:
 * PR #3609 run 30152401449, vitest-shard 2).
 *
 * Returning a probe FAILURE keeps the exact selection semantics these tests
 * have always exercised: the seeded tokens are fakes, so a real probe could
 * only ever fail too — the candidate stays `unknown` and the selector takes it
 * as the last-resort roll target.
 */
function offlineQuotaProbe(): { impl: typeof fetchQuota; calls: () => number } {
  let calls = 0;
  const impl: typeof fetchQuota = async () => {
    calls += 1;
    return { ok: false, reason: "test: offline quota probe (never calls api.anthropic.com)" };
  };
  return { impl, calls: () => calls };
}

describe("AuthBroker — unpinned consumer follows the fleet active", () => {
  it("get-credentials serves the fleet active when the consumer has no pin", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = new AuthBroker(makeConfig(h, {
      active: "default",
      consumers: [{ name: "hindsight" }],
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: offlineQuotaProbe().impl,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    broker.stop();
  });

  it("set-active moves an unpinned consumer (and pushes its mirror) with the fleet", async () => {
    const h = makeHarness();
    seedAccount(h, "old");
    seedAccount(h, "new");
    const mirrorDir = join(h.tmp, "consumer-mirror");
    mkdirSync(mirrorDir, { recursive: true });
    const broker = new AuthBroker(makeConfig(h, {
      active: "old",
      admin_agents: ["adm"],
      consumers: [{ name: "hindsight", mirror_dir: mirrorDir }],
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: offlineQuotaProbe().impl,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-active", account: "new",
    });
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "2", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.data.account).toBe("new");
    // Mirror pushed by set-active's fanoutAllConsumers — no pull-tick wait.
    expect(readFileSync(join(mirrorDir, ".credentials.json"), "utf-8")).toContain("at-new");
    broker.stop();
  });

  it("an exhausted active fails an unpinned consumer over like an agent", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const probe = offlineQuotaProbe();
    const broker = new AuthBroker(makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      agents: { marker: {} },
      consumers: [{ name: "hindsight" }],
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: probe.impl,
    });
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    await broker.start();
    // An agent on the active reports it exhausted (uncorroborated → window
    // failover semantics; nominal active does not move).
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "2", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.data.account).toBe("secondary");
    // The roll's live candidate probe went through the injected seam, not the
    // network. A zero here means someone dropped `_testFetchQuota` and this
    // test is back to being latency-bound on api.anthropic.com.
    expect(probe.calls()).toBeGreaterThan(0);
    broker.stop();
  });

  it("mark-exhausted from an unpinned consumer attributes to the fleet active (agent parity)", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const probe = offlineQuotaProbe();
    const broker = new AuthBroker(makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      consumers: [{ name: "hindsight" }],
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: probe.impl,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    // Same guard as above — the roll probed through the seam, never the wire.
    expect(probe.calls()).toBeGreaterThan(0);
    broker.stop();
  });

  it("list-state reports the bound (active) account for an unpinned consumer", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = new AuthBroker(makeConfig(h, {
      active: "default",
      consumers: [{ name: "hindsight" }],
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: offlineQuotaProbe().impl,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "1", op: "list-state",
    }) as { ok: boolean; data: { consumers: Array<{ name: string; account: string }> } };
    expect(resp.data.consumers).toEqual([
      expect.objectContaining({ name: "hindsight", account: "default" }),
    ]);
    broker.stop();
  });

  it("consumer-quota-sensor skips unpinned consumers (no dedicated account to probe)", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const probed: string[] = [];
    const broker = new AuthBroker(makeConfig(h, {
      active: "default",
      consumers: [{ name: "hindsight" }],
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken }) => {
        probed.push(accessToken);
        return { ok: true, data: {
          fiveHourUtilizationPct: 1, sevenDayUtilizationPct: 1,
          fiveHourResetAt: null, sevenDayResetAt: null,
          representativeClaim: null, overageStatus: null, overageDisabledReason: null,
        } };
      },
    });
    await broker.start();
    await broker.consumerQuotaProbeTick();
    expect(probed).toEqual([]);
    broker.stop();
  });
});
