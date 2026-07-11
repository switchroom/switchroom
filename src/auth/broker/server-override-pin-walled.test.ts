/**
 * Serving-path regression (design review, #3031 PR 4): an agent PINNED via
 * `agents.<name>.auth.override` to an account whose FRESH live snapshot is
 * hard-walled (>= WALL_PCT 99.5) must be SERVED from `fallback_order` —
 * the pin is a routing preference, not a suicide pact.
 *
 * Also pins the anti-cascade invariant: attribution (`mark-exhausted` /
 * callerAccount) keeps following the RAW pin even while serving has failed
 * over — a pinned agent can never mismark the fallback account it happens to
 * be served from.
 *
 * Same tmpdir-isolation strategy as server.test.ts (never ~/.switchroom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { WALL_PCT } from "./account-eligibility.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { QuotaResult } from "../quota.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-pin-walled-"));
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
  agents: Record<string, { auth?: { override?: string }; admin?: boolean }>;
}> = {}): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: overrides.agents ?? {},
    auth: {
      active: overrides.active,
      fallback_order: overrides.fallback_order,
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

function healthyQuota(): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 4,
    sevenDayUtilizationPct: 12,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
  } };
}

/** Hard-walled at exactly the wall threshold (99.5) — the design-review case. */
function hardWalledQuota(): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 3,
    sevenDayUtilizationPct: WALL_PCT,
    fiveHourResetAt: null,
    sevenDayResetAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    representativeClaim: "seven_day",
    overageStatus: null,
    overageDisabledReason: null,
  } };
}

describe("AuthBroker — override-pinned agent whose pin is hard-walled (live snapshot)", () => {
  async function makeWalledPinBroker(h: Harness): Promise<AuthBroker> {
    seedAccount(h, "dedicated"); // the pin — hard-walled on live probe
    seedAccount(h, "primary");   // fleet active, healthy
    seedAccount(h, "backup");    // fallback, healthy
    const config = makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { pinned: { auth: { override: "dedicated" } } },
    });
    mkdirSync(join(h.agentsDir, "pinned"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken }) =>
        accessToken.includes("dedicated") ? hardWalledQuota() : healthyQuota(),
    });
    await broker.start();
    // Cache fresh live snapshots for every account (no exhaustion mark is
    // written for the pin: active=primary is healthy, so no roll fires — the
    // walled verdict on `dedicated` rests on the LIVE snapshot alone).
    await broker.fleetQuotaProbeTick();
    return broker;
  }

  it("serves the pinned agent from fallback_order, not the walled pin (WALL_PCT boundary)", async () => {
    const h = makeHarness();
    const broker = await makeWalledPinBroker(h);
    const resp = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    // First healthy fallback_order member, NOT the hard-walled pin.
    expect(resp.data.account).toBe("primary");
    broker.stop();
  });

  it("anti-cascade: mark-exhausted from the failed-over agent still attributes to the RAW pin", async () => {
    const h = makeHarness();
    const broker = await makeWalledPinBroker(h);
    // The agent is being SERVED primary (above), but its exhaustion signal
    // must attribute to its own pinned account — never the failover view —
    // else a pinned agent could cascade the fleet off a healthy account.
    const resp = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 60_000,
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("dedicated");
    broker.stop();
  });

  it("control: a HEALTHY pin is served as-is (no failover)", async () => {
    const h = makeHarness();
    seedAccount(h, "dedicated");
    seedAccount(h, "primary");
    const config = makeConfig(h, {
      active: "primary",
      fallback_order: ["primary"],
      agents: { pinned: { auth: { override: "dedicated" } } },
    });
    mkdirSync(join(h.agentsDir, "pinned"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => healthyQuota(),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    const resp = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("dedicated");
    broker.stop();
  });
});
