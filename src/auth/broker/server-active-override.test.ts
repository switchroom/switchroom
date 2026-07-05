/**
 * Persisted fleet-active override + proactive fleet failover
 * (2026-07-05 incident: every broker recreate reloaded the stale yaml
 * `auth.active` and re-poisoned the fleet with a quota-walled account;
 * the wall was only re-handled after an agent crashed into it mid-turn).
 *
 * Pins:
 *   1. `set-active` persists — a new broker over the same state dir boots
 *      with the swapped active even though yaml still says the old one.
 *   2. `mark-exhausted` with a successful roll AUTO-PROMOTES the roll
 *      target to `auth.active` and persists it across a restart.
 *   3. A hand-edited yaml (changed since the override was written) WINS —
 *      the override is dropped and its file deleted.
 *   4. An override pointing at a since-removed account is ignored.
 *   5. `fleetQuotaProbeTick` proactively fails the fleet over when the
 *      ACTIVE account's fresh probe shows exhaustion — no agent 429 needed.
 *
 * Same tmpdir-isolation strategy as server.test.ts (never ~/.switchroom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-active-override-"));
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

function walledQuota(): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 3,
    sevenDayUtilizationPct: 100,
    fiveHourResetAt: null,
    sevenDayResetAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    representativeClaim: "seven_day",
    overageStatus: null,
    overageDisabledReason: null,
  } };
}

async function listState(h: Harness, agent: string): Promise<{ active: string }> {
  const resp = await rpc(join(h.socketRoot, agent, "sock"), {
    v: 1, id: "ls", op: "list-state",
  }) as { ok: boolean; data: { active: string } };
  expect(resp.ok).toBe(true);
  return resp.data;
}

describe("AuthBroker — persisted active override", () => {
  it("set-active survives a broker restart even though yaml still says the old active", async () => {
    const h = makeHarness();
    seedAccount(h, "old");
    seedAccount(h, "new");
    const config = makeConfig(h, { active: "old", admin_agents: ["adm"] });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-active", account: "new",
    }) as { ok: boolean };
    expect(resp.ok).toBe(true);
    broker.stop();

    // Recreate: same state dir, yaml (config) still says "old".
    const broker2 = new AuthBroker(makeConfig(h, { active: "old", admin_agents: ["adm"] }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker2.start();
    expect((await listState(h, "adm")).active).toBe("new");
    broker2.stop();
  });

  it("mark-exhausted roll auto-promotes the target to auth.active and persists it", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "backup");
    const config = makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { marker: {} },
    });
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      // primary genuinely walled on live probe (corroborates the durable
      // promote); backup healthy (the roll target).
      _testFetchQuota: async ({ accessToken }) =>
        accessToken.includes("primary") ? walledQuota() : healthyQuota(),
    });
    await broker.start();
    // Prime the live corroboration: a probe-quota caches a FRESH walled
    // snapshot for primary — the promote gate requires live evidence, so an
    // uncorroborated (possibly bogus) mark never durably swaps the fleet.
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "0", op: "probe-quota", accounts: ["primary"],
    });
    const resp = await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    }) as { ok: boolean; data: { rolledTo: string | null } };
    expect(resp.ok).toBe(true);
    expect(resp.data.rolledTo).toBe("backup");
    // Promoted in the running broker…
    expect((await listState(h, "marker")).active).toBe("backup");
    broker.stop();

    // …and across a recreate with the stale yaml.
    const broker2 = new AuthBroker(makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { marker: {} },
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker2.start();
    expect((await listState(h, "marker")).active).toBe("backup");
    broker2.stop();
  });

  it("an UNCORROBORATED mark-exhausted rolls the window but does NOT durably promote", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "backup");
    const config = makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { marker: {} },
    });
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => healthyQuota(),
    });
    await broker.start();
    // No live snapshot for primary exists → the mark is uncorroborated
    // (possibly bogus — the 2026-06-10 incident shape). The roll still
    // happens (window failover), but nominal active must NOT move.
    const resp = await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    }) as { ok: boolean; data: { rolledTo: string | null } };
    expect(resp.ok).toBe(true);
    expect(resp.data.rolledTo).toBe("backup");
    expect((await listState(h, "marker")).active).toBe("primary");
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(false);
    broker.stop();
  });

  it("a hand-edited yaml active wins over the override, which is dropped", async () => {
    const h = makeHarness();
    seedAccount(h, "old");
    seedAccount(h, "new");
    seedAccount(h, "hand-edited");
    const broker = new AuthBroker(makeConfig(h, { active: "old", admin_agents: ["adm"] }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-active", account: "new",
    });
    broker.stop();
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(true);

    // Operator hand-edits yaml active old → hand-edited, then the broker
    // recreates: yaml wins, override file removed.
    const broker2 = new AuthBroker(makeConfig(h, { active: "hand-edited", admin_agents: ["adm"] }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker2.start();
    expect((await listState(h, "adm")).active).toBe("hand-edited");
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(false);
    broker2.stop();
  });

  it("an override naming a since-removed account is ignored (yaml active kept)", async () => {
    const h = makeHarness();
    seedAccount(h, "old");
    seedAccount(h, "gone");
    const broker = new AuthBroker(makeConfig(h, { active: "old", admin_agents: ["adm"] }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "adm", "sock"), {
      v: 1, id: "1", op: "set-active", account: "gone",
    });
    broker.stop();
    // The account disappears from disk between restarts.
    rmSync(join(h.home, ".switchroom", "accounts", "gone"), { recursive: true, force: true });

    const broker2 = new AuthBroker(makeConfig(h, { active: "old", admin_agents: ["adm"] }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker2.start();
    expect((await listState(h, "adm")).active).toBe("old");
    broker2.stop();
  });
});

describe("AuthBroker — proactive fleet failover (fleet-quota-probe)", () => {
  it("a walled ACTIVE account is rolled + promoted by the probe tick with no agent trigger", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "backup");
    const config = makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { worker: {} },
    });
    mkdirSync(join(h.agentsDir, "worker"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken }) =>
        accessToken.includes("primary") ? walledQuota() : healthyQuota(),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    // Fleet promoted off the walled active — durable, no 429 needed.
    expect((await listState(h, "worker")).active).toBe("backup");
    // The walled account carries a persisted exhaustion mark.
    const marker = await rpc(join(h.socketRoot, "worker", "sock"), {
      v: 1, id: "2", op: "list-state",
    }) as { ok: boolean; data: { accounts: Array<{ label: string; exhausted: boolean }> } };
    const primary = marker.data.accounts.find((a) => a.label === "primary");
    expect(primary?.exhausted).toBe(true);
    broker.stop();
  });

  it("a healthy ACTIVE account is left alone by the probe tick", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "backup");
    const broker = new AuthBroker(makeConfig(h, {
      active: "primary",
      fallback_order: ["primary", "backup"],
      agents: { worker: {} },
    }), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => healthyQuota(),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    expect((await listState(h, "worker")).active).toBe("primary");
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(false);
    broker.stop();
  });
});
