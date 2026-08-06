/**
 * Runtime enforcement for per-agent pin hardening:
 *
 *   `agents.<name>.auth.strict`    — the pin is a hard binding: the broker
 *                                    NEVER serves this agent from another
 *                                    account, even while the pin is walled.
 *   `agents.<name>.auth.exclusive` — the pinned account belongs to this
 *                                    agent alone: never served to another
 *                                    agent/consumer, never promotable to
 *                                    fleet active, never pinnable elsewhere.
 *
 * Yaml that routes an exclusive account elsewhere is rejected at load
 * (src/config/auth-strict-exclusive-schema.test.ts); this file pins the
 * broker's guards for HOT-MUTATED state (set-active / set-override) and the
 * serving/fanout paths, where the config object can drift from the yaml.
 *
 * Same tmpdir-isolation strategy as server-override-pin-walled.test.ts
 * (never ~/.switchroom).
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-strict-exclusive-"));
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

type AgentAuth = { override?: string; strict?: boolean; exclusive?: boolean };

function makeConfig(h: Harness, overrides: Partial<{
  active: string;
  fallback_order: string[];
  agents: Record<string, { auth?: AgentAuth; admin?: boolean }>;
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

describe("AuthBroker — strict pin (never borrow another account)", () => {
  async function makeStrictPinBroker(h: Harness, opts: { strict: boolean }): Promise<AuthBroker> {
    seedAccount(h, "dedicated"); // the pin — hard-walled on live probe
    seedAccount(h, "primary");   // fleet active, healthy
    seedAccount(h, "backup");    // fallback, healthy
    const config = makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { pinned: { auth: { override: "dedicated", strict: opts.strict } } },
    });
    mkdirSync(join(h.agentsDir, "pinned"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken }) =>
        accessToken.includes("dedicated") ? hardWalledQuota() : healthyQuota(),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    return broker;
  }

  it("strict: serves the WALLED pin itself — no failover to fallback_order", async () => {
    const h = makeHarness();
    const broker = await makeStrictPinBroker(h, { strict: true });
    const resp = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("dedicated");
    broker.stop();
  });

  it("control: the same walled pin WITHOUT strict fails over (existing #3031 behavior)", async () => {
    const h = makeHarness();
    const broker = await makeStrictPinBroker(h, { strict: false });
    const resp = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("primary");
    broker.stop();
  });

  it("strict: mark-exhausted on the pin does NOT roll the pinned agent's mirror", async () => {
    const h = makeHarness();
    const broker = await makeStrictPinBroker(h, { strict: true });
    const resp = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 60_000,
    }) as { ok: boolean; data: { account: string; rolled: string[] } };
    expect(resp.ok).toBe(true);
    // Attribution stays on the pin…
    expect(resp.data.account).toBe("dedicated");
    // …and the strict agent is NOT in the rolled set (its mirror keeps the pin).
    expect(resp.data.rolled).not.toContain("pinned");
    // Serving path agrees: still the pin, even mid-exhaustion-window.
    const serve = await rpc(join(h.socketRoot, "pinned", "sock"), {
      v: 1, id: "3", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(serve.ok).toBe(true);
    expect(serve.data.account).toBe("dedicated");
    broker.stop();
  });
});

describe("AuthBroker — exclusive pin (account is unroutable to anyone else)", () => {
  async function makeExclusiveBroker(h: Harness, opts?: {
    fallbackIncludesWork?: boolean;
  }): Promise<AuthBroker> {
    seedAccount(h, "work");     // exclusive to `workbot`
    seedAccount(h, "primary");  // fleet active
    const config = makeConfig(h, {
      active: "primary",
      // Schema validation forbids an exclusive account in fallback_order;
      // the misconfigured variant exercises the broker's runtime guard for
      // state that bypassed the loader (hot mutation / stale persisted state).
      fallback_order: opts?.fallbackIncludesWork ? ["primary", "work"] : ["primary"],
      agents: {
        workbot: { auth: { override: "work", strict: true, exclusive: true } },
        other: {},
        adm: { admin: true },
      },
    });
    mkdirSync(join(h.agentsDir, "workbot"), { recursive: true });
    mkdirSync(join(h.agentsDir, "other"), { recursive: true });
    mkdirSync(join(h.agentsDir, "adm"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken }) =>
        accessToken.includes("primary") ? hardWalledQuota() : healthyQuota(),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    return broker;
  }

  it("a non-owner agent whose account is walled is NEVER failed over onto the exclusive account (even when misconfigured into fallback_order)", async () => {
    const h = makeHarness();
    const broker = await makeExclusiveBroker(h, { fallbackIncludesWork: true });
    // `other` rides auth.active=primary, which is hard-walled; the only
    // fallback candidate with credentials is `work` — exclusive to workbot.
    // Serving must retry the walled primary rather than leak work's creds.
    const resp = await rpc(join(h.socketRoot, "other", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("primary");
    broker.stop();
  });

  it("the owner is still served its own exclusive account", async () => {
    const h = makeHarness();
    const broker = await makeExclusiveBroker(h);
    const resp = await rpc(join(h.socketRoot, "workbot", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("work");
    broker.stop();
  });

  it("set-active onto an exclusive account is refused (FORBIDDEN names the owner)", async () => {
    const h = makeHarness();
    const broker = await makeExclusiveBroker(h);
    const resp = await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-active", account: "work",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("FORBIDDEN");
    expect(resp.error?.message).toContain("exclusive to agent 'workbot'");
    broker.stop();
  });

  it("set-override pinning ANOTHER agent to the exclusive account is refused", async () => {
    const h = makeHarness();
    const broker = await makeExclusiveBroker(h);
    const resp = await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-override", agent: "other", account: "work",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("FORBIDDEN");
    expect(resp.error?.message).toContain("exclusive to agent 'workbot'");
    broker.stop();
  });

  it("set-override re-pinning the OWNER to its own exclusive account is allowed (idempotent)", async () => {
    const h = makeHarness();
    const broker = await makeExclusiveBroker(h);
    const resp = await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-override", agent: "workbot", account: "work",
    }) as { ok: boolean; data: { agent: string; account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("work");
    broker.stop();
  });
});
