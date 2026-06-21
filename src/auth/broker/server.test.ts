/**
 * auth-broker server — integration-style tests against a tmpdir.
 *
 * Strategy: socket paths live under `/tmp/auth-broker-test-<random>/...`
 * (NOT `/run/...` — those need root, and we want to run unprivileged).
 * `socketRoot` is the override knob. Identity classification still uses
 * the canonical regex (`/run/switchroom/auth-broker/<n>/sock`), so we
 * exercise classify() in peercred.test.ts and exercise listener bindings
 * here by talking to a real net.Socket directly against the broker's
 * listener using `socketPath` directly — bypassing classify by passing
 * the bound identity through the connection handler.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { AuthBrokerClient } from "./client.js";
import type { Identity } from "./peercred.js";
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-test-"));
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

/**
 * Build a SwitchroomConfig good enough for the broker. We cast — the
 * broker only reaches into `auth.*`, `agents`, and `switchroom.agents_dir`.
 */
function makeConfig(h: Harness, overrides: Partial<{
  active: string;
  fallback_order: string[];
  /** Convenience: list of agent names that should get `admin: true`
   *  set on their per-agent block. Mirrors the unified admin source
   *  of truth (per-agent flag, not a top-level list). */
  admin_agents: string[];
  consumers: Array<{ name: string; account: string; uid?: number }>;
  agents: Record<string, { auth?: { override?: string }; admin?: boolean }>;
  /** Phase 3b.2b — set to enable Google provider registration. */
  google_workspace: { google_client_id: string; google_client_secret: string };
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
    google_workspace: overrides.google_workspace,
  } as unknown) as SwitchroomConfig;
}

/** Open a UDS, send one request, read one response, close. */
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
        const line = buf.slice(0, nl);
        try { settle(decodeResponse(line)); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

/** Seed account credentials at the broker's expected location. */
function seedAccount(h: Harness, label: string, opts: { expiresAt?: number; refreshToken?: string } = {}): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: `at-${label}`,
        refreshToken: opts.refreshToken ?? `rt-${label}`,
        expiresAt: opts.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    h.home,
  );
}

/* ─── Tests ──────────────────────────────────────────────────── */

describe("AuthBroker — startup + listeners", () => {
  it("binds a listener per agent and per consumer when start() runs", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      consumers: [{ name: "hindsight", account: "default" }],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const state = broker._state();
    expect(state.listeners.sort()).toEqual([
      join(h.socketRoot, "clerk", "sock"),
      join(h.socketRoot, "hindsight", "sock"),
      join(h.socketRoot, "ziggy", "sock"),
    ]);
    broker.stop();
  });

  it("writes the healthy marker after listeners bind", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", agents: { ziggy: {} } });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const marker = join(h.stateDir, "healthy");
    expect(readFileSync(marker, "utf-8")).toMatch(/^\d+/);
    broker.stop();
  });

  // Boot fanout — without this, `switchroom update` fleets come back
  // logged-out: the new RFC-H runtime reads .credentials.json from disk,
  // refreshTick() no-ops while expiresAt is far in the future, and
  // there's no setActive() call after recreate. So the only opportunity
  // to write the per-agent mirror is at boot. fanoutAll() honours the
  // same effective-account rule (auth.override ?? auth.active) so it's
  // safe regardless of how the operator pinned accounts.
  it("writes per-agent .credentials.json mirrors at boot when auth.active is set", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const ziggyMirror = join(h.agentsDir, "ziggy", ".claude", ".credentials.json");
    const clerkMirror = join(h.agentsDir, "clerk", ".claude", ".credentials.json");
    expect(existsSync(ziggyMirror)).toBe(true);
    expect(existsSync(clerkMirror)).toBe(true);
    expect(readFileSync(ziggyMirror, "utf-8")).toContain("at-default");
    broker.stop();
  });

  it("boot fanout is a no-op when auth.active and per-agent overrides are both unset", async () => {
    const h = makeHarness();
    // No `active` set — exactly the misconfiguration this fanout guards.
    const config = makeConfig(h, { agents: { ziggy: {} } });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const ziggyMirror = join(h.agentsDir, "ziggy", ".claude", ".credentials.json");
    expect(existsSync(ziggyMirror)).toBe(false);
    broker.stop();
  });

  it("refuses to start with a consumer named like an agent", () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      consumers: [{ name: "ziggy", account: "default" }],
      agents: { ziggy: {} },
    });
    expect(() =>
      new AuthBroker(config, {
        home: h.home,
        stateDir: h.stateDir,
        socketRoot: h.socketRoot,
      }),
    ).toThrow(/CONFIG_INVALID/);
  });
});

describe("AuthBroker — get-credentials", () => {
  it("returns the agent's effective account credentials", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "1",
      op: "get-credentials",
    });
    expect(resp).toMatchObject({ ok: true, data: { account: "default" } });
    broker.stop();
  });

  it("honours per-agent override", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: { auth: { override: "secondary" } } },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "1",
      op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("secondary");
    broker.stop();
  });
});

describe("AuthBroker — consumer failover on quota exhaustion", () => {
  it("serves a consumer its pinned account while healthy", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      consumers: [{ name: "hindsight", account: "secondary" }],
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("secondary");
    broker.stop();
  });

  it("fails a consumer over to fallback_order when its pinned account is exhausted", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      consumers: [{ name: "hindsight", account: "secondary" }],
      agents: { marker: { auth: { override: "secondary" } } },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    // An agent ON the pinned account reports it exhausted (the same signal the
    // fleet already raises) → broker marks `secondary` exhausted.
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    // The consumer (pinned to secondary) now fails over to the healthy default.
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "2", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    broker.stop();
  });

  it("consumer-quota-sensor fails a consumer over with NO agent on the account (the hindsight gap)", async () => {
    // This is the gap the sensor closes: a consumer pinned to a dedicated
    // account that NO agent shares (so nobody raises mark-exhausted). The
    // broker probes it itself and marks it exhausted → serving-failover kicks.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      consumers: [{ name: "hindsight", account: "secondary" }],
      // NOTE: no agent on `secondary` — nobody to raise mark-exhausted.
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    // Injected probe: `secondary` is walled (5h at 100%), everything else fine.
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken }) =>
        accessToken.includes("secondary")
          ? { ok: true, data: {
              fiveHourUtilizationPct: 100,
              sevenDayUtilizationPct: 10,
              fiveHourResetAt: new Date(Date.now() + 60 * 60 * 1000),
              sevenDayResetAt: null,
              representativeClaim: "five_hour",
              overageStatus: null,
              overageDisabledReason: null,
            } }
          : { ok: true, data: {
              fiveHourUtilizationPct: 5,
              sevenDayUtilizationPct: 5,
              fiveHourResetAt: null,
              sevenDayResetAt: null,
              representativeClaim: null,
              overageStatus: null,
              overageDisabledReason: null,
            } },
    });
    await broker.start();

    // Before the probe: pinned account is healthy in the broker's view → served.
    const before = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(before.data.account).toBe("secondary");

    // Drive one sensor tick (the timer is disabled in tests).
    await broker.consumerQuotaProbeTick();

    // Now the consumer fails over to the healthy default — no agent needed.
    const after = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "2", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(after.data.account).toBe("default");
    broker.stop();
  });

  it("consumer-quota-sensor does NOT mark on a probe that is healthy or failed", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      consumers: [{ name: "hindsight", account: "secondary" }],
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    // Probe FAILS for secondary (transient) — must NOT fail the consumer over.
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => ({ ok: false, reason: "HTTP 503" }),
    });
    await broker.start();
    await broker.consumerQuotaProbeTick();
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    // Still served the pinned account — a transient probe error is not exhaustion.
    expect(resp.data.account).toBe("secondary");
    broker.stop();
  });

  it("keeps the pinned account when no healthy fallback exists (retry beats nothing)", async () => {
    // All three escape routes are exhausted: pinned account, every fallback_order
    // member, AND auth.active. The last-resort branch (2026-06-19 fix) correctly
    // skips auth.active because it is exhausted, so the broker returns the pinned
    // account rather than going dark.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["secondary"],
      consumers: [{ name: "hindsight", account: "secondary" }],
      agents: {
        marker: { auth: { override: "secondary" } },
        // A second agent on "default" (auth.active) so we can exhaust it too.
        marker2: {},
      },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "marker2"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    // Exhaust the pinned account (secondary) AND auth.active (default).
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    await rpc(join(h.socketRoot, "marker2", "sock"), {
      v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    // fallback_order only lists the (now-exhausted) pinned account, AND auth.active
    // is also exhausted → no healthy alternative → stay pinned rather than serve nothing.
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "3", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("secondary");
    broker.stop();
  });

  it("a consumer's mark-exhausted attributes to its PINNED account, never the failover view", async () => {
    // Invariant (schema.ts): mark-exhausted from a consumer only affects ITS
    // account. Failover must NOT leak into attribution — else a consumer being
    // SERVED a failover account could mark that healthy account exhausted and
    // cascade the fleet off it. This test fails if get-credentials' failover
    // view bleeds into mark-exhausted.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      consumers: [{ name: "hindsight", account: "secondary" }],
      agents: { marker: { auth: { override: "secondary" } } },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    // Exhaust secondary (via an agent on it) → consumer failover is now active.
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    // Confirm failover is live: the consumer is being SERVED the healthy default.
    const served = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "2", op: "get-credentials",
    }) as { data: { account: string } };
    expect(served.data.account).toBe("default");
    // The consumer reports exhaustion. It must mark its PINNED account
    // (secondary), NOT the served failover account (default).
    await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "3", op: "mark-exhausted", until: Date.now() + 120_000,
    });
    // default must remain healthy — the consumer cannot poison the failover account.
    const quota = JSON.parse(readFileSync(join(h.stateDir, "quota.json"), "utf-8"));
    expect((quota["default"]?.exhausted_until ?? 0) > Date.now()).toBe(false);
    expect(quota["secondary"].exhausted_until > Date.now()).toBe(true);
    broker.stop();
  });
});

// ─── 2026-06-19 incident regression: consumer follows auth.active as last resort ───
//
// Incident: hindsight (consumer pinned to a dedicated account) stalled for ~2h
// because its pinned account AND every fallback_order member were all walled, but
// the healthy fleet-active account (auth.active) was never consulted. The fix adds
// auth.active as a last-resort after fallback_order is exhausted.
describe("AuthBroker — consumer last-resort failover to auth.active (2026-06-19 fix)", () => {
  it("(a) consumer pinned to exhausted account + ALL fallback_order exhausted + healthy auth.active → returns auth.active", async () => {
    const h = makeHarness();
    // hindsight is pinned to "hindsight-acct". fallback_order has "fallback1"
    // which will also be exhausted. auth.active is "fleet-active" which is healthy.
    const config = makeConfig(h, {
      active: "fleet-active",
      fallback_order: ["fallback1"],
      consumers: [{ name: "hindsight", account: "hindsight-acct" }],
      agents: {
        marker: { auth: { override: "hindsight-acct" } },
        marker2: { auth: { override: "fallback1" } },
      },
    });
    seedAccount(h, "fleet-active");
    seedAccount(h, "hindsight-acct");
    seedAccount(h, "fallback1");
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "marker2"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();

    // Exhaust both the pinned account and the only fallback_order member.
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    await rpc(join(h.socketRoot, "marker2", "sock"), {
      v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 60_000,
    });

    // Consumer should now fall through to the healthy fleet-active account.
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "3", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("fleet-active");
    broker.stop();
  });

  it("(b) precedence: a healthy fallback_order member is chosen over auth.active", async () => {
    // fallback_order must still be tried BEFORE auth.active — we only reach
    // auth.active when fallback_order is fully exhausted.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "fleet-active",
      fallback_order: ["fallback-healthy"],
      consumers: [{ name: "hindsight", account: "hindsight-acct" }],
      agents: { marker: { auth: { override: "hindsight-acct" } } },
    });
    seedAccount(h, "fleet-active");
    seedAccount(h, "hindsight-acct");
    seedAccount(h, "fallback-healthy");
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();

    // Only exhaust the pinned account; fallback-healthy stays healthy.
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });

    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "2", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    // Must be the fallback_order member, NOT auth.active.
    expect(resp.data.account).toBe("fallback-healthy");
    broker.stop();
  });

  it("(c) no-op for an agent whose account == auth.active (strict no-op guarantee)", async () => {
    // Agents ride auth.active directly. When auth.active is walled, callerAccount()
    // for an agent is already auth.active, so account === active in the last-resort
    // branch and it is skipped. The agent must NOT be handed auth.active again
    // (it would return the exhausted account either way — the fallback_order loop
    // is the correct path for agents, same as before this fix).
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "fleet-active",
      fallback_order: ["secondary"],
      agents: { ziggy: {} },
    });
    seedAccount(h, "fleet-active");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();

    // While fleet-active is healthy, agent gets it.
    const before = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(before.ok).toBe(true);
    expect(before.data.account).toBe("fleet-active");

    // Exhaust fleet-active (as the agent itself, which rides auth.active).
    await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 60_000,
    });

    // Agent now falls to secondary (via fallback_order), not back to fleet-active.
    // The last-resort branch is a no-op because account === active.
    const after = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "3", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(after.ok).toBe(true);
    expect(after.data.account).toBe("secondary");
    broker.stop();
  });

  it("(d) when auth.active is also exhausted, still returns original account (no false positive)", async () => {
    // The last-resort must NOT fire when auth.active is itself exhausted.
    // In that case accountWithFailover falls through to `return account` as before.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "fleet-active",
      fallback_order: [],
      consumers: [{ name: "hindsight", account: "hindsight-acct" }],
      agents: {
        marker: { auth: { override: "hindsight-acct" } },
        marker2: {},  // rides fleet-active
      },
    });
    seedAccount(h, "fleet-active");
    seedAccount(h, "hindsight-acct");
    mkdirSync(join(h.agentsDir, "marker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "marker2"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();

    // Exhaust both the consumer's pinned account and fleet-active.
    await rpc(join(h.socketRoot, "marker", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    });
    await rpc(join(h.socketRoot, "marker2", "sock"), {
      v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 60_000,
    });

    // No healthy account exists at all — consumer must get its pinned account
    // back (the "retry beats nothing" invariant) rather than some undefined state.
    const resp = await rpc(join(h.socketRoot, "hindsight", "sock"), {
      v: 1, id: "3", op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("hindsight-acct");
    broker.stop();
  });
});

describe("AuthBroker — admin gating", () => {
  it("forbids set-active from a non-admin agent", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "secondary",
    });
    expect(resp).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    broker.stop();
  });

  it("permits set-active from an admin agent and fans out", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    // Seed agent dirs so fanout has somewhere to write.
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "secondary",
    }) as { ok: boolean; data: { active: string; fanned: string[] } };
    expect(resp.ok).toBe(true);
    expect(resp.data.active).toBe("secondary");
    expect(resp.data.fanned.sort()).toEqual(["clerk", "ziggy"]);
    // Verify mirror file contents
    const mirror = readFileSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"), "utf-8");
    expect(mirror).toContain("at-secondary");
    broker.stop();
  });
});

describe("AuthBroker — mark-exhausted", () => {
  it("marks the caller's account exhausted and persists quota", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      agents: { ziggy: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const until = Date.now() + 60_000;
    // ziggy is NOT an admin agent (admin_agents is unset here) — yet
    // mark-exhausted succeeds. This is the whole point of routing auto-fallback
    // through mark-exhausted instead of the admin-gated set-active: the agent
    // that just 429'd can self-heal the fleet without being admin.
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until,
    }) as { ok: boolean; data: { account: string; rolled: string[]; rolledTo: string | null } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    expect(resp.data.rolled).toContain("ziggy");
    // rolledTo names the account the fleet rolled to (next non-exhausted in
    // fallback_order) so a non-admin caller can announce an accurate swap.
    expect(resp.data.rolledTo).toBe("secondary");
    // Persisted to disk
    const quota = JSON.parse(readFileSync(join(h.stateDir, "quota.json"), "utf-8"));
    expect(quota["default"].exhausted_until).toBe(until);
    // Agent mirror now holds the secondary account creds.
    const mirror = readFileSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"), "utf-8");
    expect(mirror).toContain("at-secondary");
    broker.stop();
  });

  it("returns rolledTo=null when there is no other account to roll to", async () => {
    // fallback_order has only the (now-exhausted) active account → nowhere to
    // roll → rolledTo null, rolled empty. The gateway maps this to the
    // all-blocked announcement.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default"],
      agents: { ziggy: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
    }) as { ok: boolean; data: { account: string; rolled: string[]; rolledTo: string | null } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    expect(resp.data.rolledTo).toBeNull();
    expect(resp.data.rolled).toEqual([]);
    broker.stop();
  });
});

describe("AuthBroker — add-account / rm-account", () => {
  it("admin can add a new account; non-admin cannot", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const denied = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "add-account",
      label: "third",
      credentials: { claudeAiOauth: { accessToken: "at-third", refreshToken: "rt-third", expiresAt: Date.now() + 99_999_999 } },
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const ok = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "add-account",
      label: "third",
      credentials: { claudeAiOauth: { accessToken: "at-third", refreshToken: "rt-third", expiresAt: Date.now() + 99_999_999 } },
    });
    expect(ok).toMatchObject({ ok: true, data: { label: "third" } });
    broker.stop();
  });

  it("refuses to add an existing account without replace:true", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const denied = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "default",
      credentials: { claudeAiOauth: { accessToken: "at-x", refreshToken: "rt-x", expiresAt: Date.now() + 99_999 } },
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "ACCOUNT_ALREADY_EXISTS" } });

    const ok = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "add-account", label: "default", replace: true,
      credentials: { claudeAiOauth: { accessToken: "at-x", refreshToken: "rt-x", expiresAt: Date.now() + 99_999 } },
    });
    expect(ok).toMatchObject({ ok: true });
    broker.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 3b.1 — provider field gating
// Server still Anthropic-only; non-default provider rejects with INVALID_ARGS.
// ────────────────────────────────────────────────────────────────────────
describe("AuthBroker — provider field gating (Phase 3b.1)", () => {
  it("set-active rejects provider: 'google' with operator-actionable message", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "alice@example.com",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    expect(resp.error?.message).toContain("Anthropic-only");
    broker.stop();
  });

  it("refresh-account rejects provider: 'google' as not-registered (until Phase 3b.2 registers Google)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "refresh-account",
      account: "alice@example.com",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    expect(resp.error?.message).toContain("not registered");
    broker.stop();
  });

  it("add-account rejects provider: 'google' as not-registered (until Phase 3b.2 registers Google)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "add-account",
      label: "alice@example.com",
      provider: "google",
      credentials: {
        googleOauth: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: 1234,
          scope: "x",
          clientId: "cid",
          accountEmail: "alice@example.com",
          tokenType: "Bearer",
        },
      },
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    expect(resp.error?.message).toContain("not registered");
    broker.stop();
  });

  it("rejection error message lists the actually-registered providers (regression-resistant)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "rm-account",
      label: "x",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    // The message should name what IS registered ("anthropic"), so a
    // future Phase 3b.2 PR that registers Google can update the
    // expectation by adding "google" to this assertion. Pinning the
    // shape, not the literal text.
    expect(resp.error?.message).toMatch(/only .*anthropic.* available/);
    broker.stop();
  });

  it("add-account with NO provider field still works (back-compat with RFC H clients)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "add-account",
      label: "newone",
      // no provider field — defaults to "anthropic"
      credentials: {
        claudeAiOauth: {
          accessToken: "at-new",
          refreshToken: "rt-new",
          expiresAt: 5000,
        },
      },
    }) as { ok: boolean };
    expect(resp.ok).toBe(true);
    broker.stop();
  });

  it("rm-account rejects provider: 'google' as not-registered (until Phase 3b.2 registers Google)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "rm-account",
      label: "alice@example.com",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    broker.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 3b.2b — conditional GoogleProvider registration
// ────────────────────────────────────────────────────────────────────────
describe("AuthBroker — Google provider registration (Phase 3b.2b)", () => {
  it("does NOT register Google when google_workspace config is absent", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Provider:google should be rejected as unknown.
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "rm-account",
      label: "x",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain("not registered");
    expect(resp.error?.message).toMatch(/only .*anthropic.* available/);
    broker.stop();
  });

  it("registers Google when google_workspace config provides client id + secret", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "test-client-id",
        google_client_secret: "test-secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Phase 3b.2c — rm-account on a non-existent Google account
    // returns ACCOUNT_NOT_FOUND (the storage path is real now).
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "rm-account",
      label: "alice@example.com",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ACCOUNT_NOT_FOUND");
    // Importantly — NOT "not registered" anymore. Google IS registered.
    expect(resp.error?.message).not.toContain("not registered");
    broker.stop();
  });

  it("Phase 3b.2c — add-account with Google credentials writes to broker stateDir and succeeds", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "add-account",
      label: "alice@example.com",
      provider: "google",
      credentials: {
        googleOauth: {
          accessToken: "at-x",
          refreshToken: "rt-x",
          expiresAt: 99999,
          scope: "https://www.googleapis.com/auth/drive",
          clientId: "client-id-x",
          accountEmail: "alice@example.com",
          tokenType: "Bearer",
        },
      },
    }) as { ok: boolean; data?: { label: string; expiresAt?: number } };
    expect(resp.ok).toBe(true);
    expect(resp.data?.label).toBe("alice@example.com");
    expect(resp.data?.expiresAt).toBe(99999);
    // Verify the credentials.json is on disk under the broker stateDir.
    const credPath = join(
      h.stateDir,
      "google",
      "alice@example.com",
      "credentials.json",
    );
    expect(existsSync(credPath)).toBe(true);
    broker.stop();
  });

  it("Phase 3b.2c — add-account refuses duplicate without replace:true", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const validCreds = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1234,
      scope: "drive",
      clientId: "cid",
      accountEmail: "alice@example.com",
      tokenType: "Bearer" as const,
    };
    // First add succeeds.
    const r1 = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "alice@example.com",
      provider: "google", credentials: { googleOauth: validCreds },
    }) as { ok: boolean };
    expect(r1.ok).toBe(true);
    // Second without replace fails with ACCOUNT_ALREADY_EXISTS.
    const r2 = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "add-account", label: "alice@example.com",
      provider: "google", credentials: { googleOauth: validCreds },
    }) as { ok: boolean; error?: { code: string } };
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("ACCOUNT_ALREADY_EXISTS");
    // With replace:true succeeds.
    const r3 = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "3", op: "add-account", label: "alice@example.com",
      provider: "google", credentials: { googleOauth: validCreds },
      replace: true,
    }) as { ok: boolean };
    expect(r3.ok).toBe(true);
    broker.stop();
  });

  it("Phase 3b.2c — rm-account refuses to remove while agent is in google_accounts.enabled_for[]", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    // Inject a google_accounts ACL entry with the agent enabled.
    (config as unknown as Record<string, unknown>).google_accounts = {
      "alice@example.com": { enabled_for: ["klanker"] },
    };
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Add the account first.
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "alice@example.com",
      provider: "google",
      credentials: {
        googleOauth: {
          accessToken: "at", refreshToken: "rt", expiresAt: 1, scope: "x",
          clientId: "cid", accountEmail: "alice@example.com",
          tokenType: "Bearer" as const,
        },
      },
    });
    // Try to remove with agent still enabled.
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "rm-account", label: "alice@example.com",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    expect(resp.error?.message).toContain("klanker");
    expect(resp.error?.message).toContain("auth google disable");
    broker.stop();
  });

  it("Phase 3b.2c — add-account rejects path-traversal labels (defense-in-depth)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Attempt path-traversal via the label.
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "../../../etc/passwd",
      provider: "google",
      credentials: {
        googleOauth: {
          accessToken: "at", refreshToken: "rt", expiresAt: 1, scope: "x",
          clientId: "cid", accountEmail: "alice@example.com",
          tokenType: "Bearer" as const,
        },
      },
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    expect(resp.error?.message).toContain("email shape");
    // Verify nothing was written outside stateDir.
    expect(existsSync(join(h.stateDir, "..", "..", "..", "etc", "passwd"))).toBe(false);
    broker.stop();
  });

  it("Phase 3b.2c — rm-account rejects path-traversal labels", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "rm-account", label: "../escape",
      provider: "google",
    }) as { ok: boolean; error?: { code: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("INVALID_ARGS");
    broker.stop();
  });

  it("Phase 3b.4 — get-credentials with provider:google returns the stored Google creds when agent is in enabled_for[]", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { klanker: {}, clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    (config.agents.klanker as unknown as Record<string, unknown>).google_workspace = {
      account: "alice@example.com",
    };
    (config as unknown as Record<string, unknown>).google_accounts = {
      "alice@example.com": { enabled_for: ["klanker"] },
    };
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "klanker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const addedCreds = {
      googleOauth: {
        accessToken: "at-cur",
        refreshToken: "rt-cur",
        expiresAt: 88888,
        scope: "drive",
        clientId: "cid",
        accountEmail: "alice@example.com",
        tokenType: "Bearer" as const,
      },
    };
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "alice@example.com",
      provider: "google", credentials: addedCreds,
    });
    const resp = await rpc(join(h.socketRoot, "klanker", "sock"), {
      v: 1, id: "2", op: "get-credentials", provider: "google",
    }) as { ok: boolean; data?: { account: string; credentials: typeof addedCreds; expiresAt?: number } };
    expect(resp.ok).toBe(true);
    expect(resp.data?.account).toBe("alice@example.com");
    expect(resp.data?.credentials).toEqual(addedCreds);
    expect(resp.data?.expiresAt).toBe(88888);
    broker.stop();
  });

  it("Phase 3b.4 — get-credentials google returns FORBIDDEN when agent NOT in enabled_for[]", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { klanker: {}, clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    (config.agents.klanker as unknown as Record<string, unknown>).google_workspace = {
      account: "alice@example.com",
    };
    (config as unknown as Record<string, unknown>).google_accounts = {
      "alice@example.com": { enabled_for: ["gymbro"] },
    };
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "klanker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "klanker", "sock"), {
      v: 1, id: "1", op: "get-credentials", provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("FORBIDDEN");
    expect(resp.error?.message).toContain("not in google_accounts");
    expect(resp.error?.message).toContain("auth google enable");
    broker.stop();
  });

  it("Phase 3b.4 — get-credentials google returns ACCOUNT_NOT_FOUND when agent has no google_workspace.account", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { klanker: {}, clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "klanker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "klanker", "sock"), {
      v: 1, id: "1", op: "get-credentials", provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ACCOUNT_NOT_FOUND");
    expect(resp.error?.message).toContain("google_workspace.account");
    broker.stop();
  });

  it("Phase 3b.4 — get-credentials WITHOUT provider field still routes to Anthropic (back-compat)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { klanker: {}, clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "klanker"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "klanker", "sock"), {
      v: 1, id: "1", op: "get-credentials",
    }) as { ok: boolean; data?: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data?.account).toBe("default");
    broker.stop();
  });

  it("Phase 3b.2c — rm-account succeeds after add when no agents are enabled", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
      },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "alice@example.com",
      provider: "google",
      credentials: {
        googleOauth: {
          accessToken: "at", refreshToken: "rt", expiresAt: 1, scope: "x",
          clientId: "cid", accountEmail: "alice@example.com",
          tokenType: "Bearer" as const,
        },
      },
    });
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "rm-account", label: "alice@example.com",
      provider: "google",
    }) as { ok: boolean };
    expect(resp.ok).toBe(true);
    // Storage gone.
    const credPath = join(
      h.stateDir, "google", "alice@example.com", "credentials.json",
    );
    expect(existsSync(credPath)).toBe(false);
    broker.stop();
  });

  it("Google registration fails fast when client secret missing", async () => {
    // (Defensive — schema requires both, but test the broker's
    // null-check path independently.)
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    }) as unknown as Record<string, unknown>;
    // Inject a partial google_workspace block (missing secret).
    config.google_workspace = { google_client_id: "id" };
    const broker = new AuthBroker(config as unknown as SwitchroomConfig, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    await broker.start();
    // Google should NOT be registered — partial config is treated as
    // "not configured" rather than half-configured.
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "rm-account",
      label: "x",
      provider: "google",
    }) as { ok: boolean; error?: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain("not registered");
    broker.stop();
  });
});

describe("AuthBroker — list-state", () => {
  it("returns active, fallback_order, accounts, agents, consumers", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      admin_agents: ["clerk"],
      consumers: [{ name: "hindsight", account: "default" }],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    seedAccount(h, "secondary", { expiresAt: 9_999_999_999_998 });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "list-state",
    }) as { ok: boolean; data: {
      active: string;
      fallback_order: string[];
      accounts: Array<{ label: string }>;
      agents: Array<{ name: string }>;
      consumers: Array<{ name: string }>;
    } };
    expect(resp.ok).toBe(true);
    expect(resp.data.active).toBe("default");
    expect(resp.data.fallback_order).toEqual(["default", "secondary"]);
    expect(resp.data.accounts.map((a) => a.label).sort()).toEqual(["default", "secondary"]);
    expect(resp.data.agents.map((a) => a.name).sort()).toEqual(["clerk", "ziggy"]);
    expect(resp.data.consumers.map((c) => c.name)).toEqual(["hindsight"]);
    broker.stop();
  });
});

describe("AuthBroker — probe-quota", () => {
  it("returns per-account quota results using stored access tokens", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    // seedAccount auto-derives accessToken as `at-${label}` (helper above).
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    seedAccount(h, "secondary", { expiresAt: 9_999_999_999_998 });

    // Stub fetch — capture the Authorization header to confirm broker
    // used the per-account token, and return synthetic rate-limit headers.
    const seenTokens: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers as Record<string, string>;
      const auth = headers["authorization"] ?? "";
      seenTokens.push(auth);
      const tok = auth.replace(/^Bearer /, "");
      const util5h = tok === "at-default" ? "0.12" : "0.85";
      const util7d = tok === "at-default" ? "0.05" : "0.40";
      return new Response("ok", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": util5h,
          "anthropic-ratelimit-unified-7d-utilization": util7d,
        },
      });
    }) as typeof fetch;

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    try {
      await broker.start();
      const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
        v: 1, id: "1", op: "probe-quota",
        accounts: ["default", "secondary"],
      }) as { ok: boolean; data: { results: Array<{ label: string; result: { ok: boolean; data?: { fiveHourUtilizationPct: number } } }> } };
      expect(resp.ok).toBe(true);
      expect(resp.data.results).toHaveLength(2);
      expect(resp.data.results[0]?.label).toBe("default");
      expect(resp.data.results[0]?.result.ok).toBe(true);
      expect(resp.data.results[0]?.result.data?.fiveHourUtilizationPct).toBeCloseTo(12, 3);
      expect(resp.data.results[1]?.label).toBe("secondary");
      expect(resp.data.results[1]?.result.data?.fiveHourUtilizationPct).toBeCloseTo(85, 3);
      // Confirm tokens were used as bearers — never leaked back to caller.
      expect(seenTokens).toContain("Bearer at-default");
      expect(seenTokens).toContain("Bearer at-secondary");
    } finally {
      globalThis.fetch = origFetch;
      broker.stop();
    }
  });

  it("AuthBrokerClient.probeQuota revives reset fields into Date (regression: /auth show target.getTime crash)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", agents: { ziggy: {} } });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });

    const reset5hEpoch = Math.floor(Date.now() / 1000) + 3600;
    const reset7dEpoch = Math.floor(Date.now() / 1000) + 86_400;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response("ok", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.20",
          "anthropic-ratelimit-unified-7d-utilization": "0.10",
          "anthropic-ratelimit-unified-5h-reset": String(reset5hEpoch),
          "anthropic-ratelimit-unified-7d-reset": String(reset7dEpoch),
        },
      });
    }) as typeof fetch;

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    const client = new AuthBrokerClient({ socket: join(h.socketRoot, "ziggy", "sock") });
    try {
      await broker.start();
      const data = await client.probeQuota(["default"]);
      const entry = data.results[0];
      expect(entry?.result.ok).toBe(true);
      if (!entry || !entry.result.ok) throw new Error("probe failed");
      // The core regression: these MUST be real Dates, not ISO strings.
      // Pre-fix the wire value survived as a string and `.getTime()` in
      // auth-snapshot-format.ts threw "target.getTime is not a function".
      expect(entry.result.data.fiveHourResetAt).toBeInstanceOf(Date);
      expect(entry.result.data.sevenDayResetAt).toBeInstanceOf(Date);
      expect(entry.result.data.fiveHourResetAt?.getTime()).toBe(reset5hEpoch * 1000);
      expect(entry.result.data.sevenDayResetAt?.getTime()).toBe(reset7dEpoch * 1000);
    } finally {
      globalThis.fetch = origFetch;
      await client.close();
      broker.stop();
    }
  });

  it("returns a per-label failure result when account has no stored credentials", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", agents: { ziggy: {} } });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    try {
      await broker.start();
      const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
        v: 1, id: "1", op: "probe-quota",
        accounts: ["nonexistent"],
      }) as { ok: boolean; data: { results: Array<{ label: string; result: { ok: boolean; reason?: string } }> } };
      expect(resp.ok).toBe(true);
      expect(resp.data.results[0]?.result.ok).toBe(false);
      expect(resp.data.results[0]?.result.reason).toMatch(/no credentials/i);
    } finally {
      broker.stop();
    }
  });

  it("probe-quota populates last_quota cache — subsequent list-state includes utilization (no re-probe needed)", async () => {
    // Regression guard for the E4 quota-watch blocker: after any probeQuota
    // call, list-state must return last_quota so the quota-watch loop can
    // classify health without making a new live Anthropic network call.
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", agents: { ziggy: {} } });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response("ok", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.82",
          "anthropic-ratelimit-unified-7d-utilization": "0.45",
        },
      });
    }) as typeof fetch;

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    const client = new AuthBrokerClient({ socket: join(h.socketRoot, "ziggy", "sock") });
    try {
      await broker.start();

      // Before any probe: list-state should have last_quota=null for "default".
      const beforeState = await client.listState();
      const beforeAccount = beforeState.accounts.find((a) => a.label === "default");
      expect(beforeAccount?.last_quota ?? null).toBeNull();

      // Run a probe.
      await client.probeQuota(["default"]);

      // After probe: list-state must now carry last_quota with cached utilization.
      const afterState = await client.listState();
      const afterAccount = afterState.accounts.find((a) => a.label === "default");
      expect(afterAccount?.last_quota).not.toBeNull();
      expect(afterAccount?.last_quota?.fiveHourUtilizationPct).toBeCloseTo(82, 1);
      expect(afterAccount?.last_quota?.sevenDayUtilizationPct).toBeCloseTo(45, 1);
      // Dates are ISO strings on the wire (not Date objects — NDJSON has no Date).
      // null because the stub response didn't include reset headers.
      expect(afterAccount?.last_quota?.fiveHourResetAt).toBeNull();
      expect(afterAccount?.last_quota?.sevenDayResetAt).toBeNull();
      expect(typeof afterAccount?.last_quota?.capturedAt).toBe("number");
    } finally {
      globalThis.fetch = origFetch;
      await client.close();
      broker.stop();
    }
  });

  it("fleetQuotaProbeTick populates last_quota for ALL accounts with no explicit probe (dashboard always-fresh quota)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    seedAccount(h, "secondary", { expiresAt: 9_999_999_999_999 });

    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => ({ ok: true, data: {
        fiveHourUtilizationPct: 33,
        sevenDayUtilizationPct: 12,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: null,
        overageStatus: null,
        overageDisabledReason: null,
      } }),
    });
    const client = new AuthBrokerClient({ socket: join(h.socketRoot, "ziggy", "sock") });
    try {
      await broker.start();
      // No probe-quota op called — just the background tick the timer would run.
      await broker.fleetQuotaProbeTick();
      const state = await client.listState();
      for (const label of ["default", "secondary"]) {
        const acct = state.accounts.find((a) => a.label === label);
        expect(acct?.last_quota, `${label} should have cached quota`).not.toBeNull();
        expect(acct?.last_quota?.fiveHourUtilizationPct).toBeCloseTo(33, 1);
        expect(acct?.last_quota?.sevenDayUtilizationPct).toBeCloseTo(12, 1);
      }
    } finally {
      await client.close();
      broker.stop();
    }
  });

  it("fleetQuotaProbeTick keeps a prior snapshot when a probe fails (no eviction)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", agents: { ziggy: {} } });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    let mode: "ok" | "fail" = "ok";
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async () => mode === "ok"
        ? { ok: true, data: { fiveHourUtilizationPct: 50, sevenDayUtilizationPct: 20, fiveHourResetAt: null, sevenDayResetAt: null, representativeClaim: null, overageStatus: null, overageDisabledReason: null } }
        : { ok: false, reason: "HTTP 503" },
    });
    const client = new AuthBrokerClient({ socket: join(h.socketRoot, "ziggy", "sock") });
    try {
      await broker.start();
      await broker.fleetQuotaProbeTick(); // ok → cached
      mode = "fail";
      await broker.fleetQuotaProbeTick(); // fail → must NOT evict
      const acct = (await client.listState()).accounts.find((a) => a.label === "default");
      expect(acct?.last_quota?.fiveHourUtilizationPct).toBeCloseTo(50, 1);
    } finally {
      await client.close();
      broker.stop();
    }
  });
});

describe("AuthBroker — drift detection", () => {
  it("seeds sha-index after add-account so a subsequent boot doesn't trip", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "fresh",
      credentials: { claudeAiOauth: { accessToken: "at-f", refreshToken: "rt-f", expiresAt: Date.now() + 99_999 } },
    });
    broker.stop();
    // New broker reads sha-index; on-disk file matches, so it boots cleanly.
    const broker2 = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker2.start();
    expect(broker2._state().shaIndex["fresh"]).toMatch(/^[0-9a-f]{64}$/);
    broker2.stop();
  });

  it("detects drift when a tracked account's bytes change behind the broker", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Force a sha-index entry by add-account --replace.
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "default", replace: true,
      credentials: { claudeAiOauth: { accessToken: "at-rev", refreshToken: "rt-rev", expiresAt: Date.now() + 99_999 } },
    });
    broker.stop();
    // Corrupt the on-disk file behind the broker's back.
    const credsPath = join(h.home, ".switchroom", "accounts", "default", "credentials.json");
    writeFileSync(credsPath, '{"claudeAiOauth":{"accessToken":"tampered"}}\n');
    // Boot a new broker — we expect process.exit(1) via DRIFT_DETECTED.
    // Stub process.exit so the test can observe rather than die.
    const original = process.exit;
    let exitCode: number | null = null;
    (process as unknown as { exit: (n?: number) => never }).exit = (n?: number) => {
      exitCode = n ?? 0;
      throw new Error("test-exit");
    };
    try {
      const broker2 = new AuthBroker(config, {
        home: h.home,
        stateDir: h.stateDir,
        socketRoot: h.socketRoot,
        disableRefreshLoop: true,
        skipHealthyMarker: true,
      });
      await expect(broker2.start()).rejects.toThrow(/test-exit/);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = original;
    }
  });
});

describe("AuthBroker — refresh tick + threshold-violation", () => {
  it("refreshes a near-expiry account via the injected fetcher", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: Date.now() + 30 * 60 * 1000 }); // 30min — under threshold
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });

    let calls = 0;
    const fetcher = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "at-new",
            refresh_token: "rt-new",
            expires_in: 8 * 60 * 60,
            token_type: "Bearer",
          }),
      };
    };
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      fetcher,
      disableRefreshLoop: true,
    });
    await broker.start();
    await broker._tick();
    expect(calls).toBe(1);
    const credsAfter = readFileSync(
      join(h.home, ".switchroom", "accounts", "default", "credentials.json"),
      "utf-8",
    );
    expect(credsAfter).toContain("at-new");
    // The mirror fans out to ziggy.
    const mirror = readFileSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"), "utf-8");
    expect(mirror).toContain("at-new");
    broker.stop();
  });

  it("increments threshold-violations when on-disk expiresAt changes behind us", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: Date.now() + 30 * 60 * 1000 });
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "at-r" + calls,
            refresh_token: "rt-r" + calls,
            expires_in: 8 * 60 * 60,
            token_type: "Bearer",
          }),
      };
    };
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      fetcher,
      disableRefreshLoop: true,
    });
    await broker.start();
    await broker._tick();
    // Tamper with on-disk expiresAt to simulate claude refreshing.
    const credsPath = join(h.home, ".switchroom", "accounts", "default", "credentials.json");
    const parsed = JSON.parse(readFileSync(credsPath, "utf-8"));
    parsed.claudeAiOauth.expiresAt = parsed.claudeAiOauth.expiresAt + 1; // mutate
    writeFileSync(credsPath, JSON.stringify(parsed, null, 2) + "\n");
    await broker._tick();
    expect(broker._state().thresholdViolations["default"]).toBeGreaterThanOrEqual(1);
    broker.stop();
  });
});

describe("AuthBroker — audit-log torn-write hardening", () => {
  // Real audit rows are <300 bytes and land in a single write(2) syscall
  // to an O_APPEND fd, which Linux guarantees is atomic vs other writers
  // AND vs signal delivery (the kernel doesn't yield mid-syscall to
  // deliver SIGKILL — see write(2) man page). The size cap defends
  // against a runaway field that would push past PIPE_BUF (4096).

  it("writes a normal-sized audit row in a single syscall", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Trigger an audited op.
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "list-state",
    });
    broker.stop();
    // Audit file exists and contains a parseable JSONL row.
    const auditPath = join(h.stateDir, "audit.jsonl");
    const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const row = JSON.parse(lines[lines.length - 1]);
    expect(row.op).toBe("list-state");
    expect(row.ok).toBe(true);
    expect(row.__truncated).toBeUndefined();
    // Row well under the cap.
    expect(Buffer.byteLength(lines[lines.length - 1] + "\n", "utf-8"))
      .toBeLessThan(500);
  });

  it("structural pin: audit writer uses writeSync (single syscall), not writeFileSync (looping)", async () => {
    // SIGKILL-safety pin. writeFileSync to a fd loops on short writes,
    // could in principle issue multiple syscalls, breaks the O_APPEND
    // atomicity guarantee. writeSync issues exactly one. A refactor
    // that swaps back to writeFileSync(fd, ...) fails here first.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(path.join(here, "server.ts"), "utf-8");
    // The audit-write helper exists.
    expect(serverSrc).toMatch(/_writeAuditLineAtomic\b/);
    // And uses writeSync, not writeFileSync.
    expect(serverSrc).toMatch(/_writeAuditLineAtomic[\s\S]{0,400}writeSync\(/);
    expect(serverSrc).not.toMatch(/_writeAuditLineAtomic[\s\S]{0,400}writeFileSync\(/);
    // O_APPEND flag is set.
    expect(serverSrc).toMatch(/_writeAuditLineAtomic[\s\S]{0,400}O_APPEND/);
  });

  it("truncates an oversized audit row instead of risking a torn write", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Drive a refresh-account that we know will fail with a synthetic
    // huge error string. We don't have a clean injection point on
    // the broker's public surface; instead reach into the private
    // audit() method directly via the broker instance.
    const broker_ = broker as unknown as {
      audit: (entry: {
        op: string;
        identity: Identity;
        account?: string;
        ok: boolean;
        error?: string;
      }) => void;
    };
    const hugeError = "X".repeat(8000);
    broker_.audit({
      op: "refresh-account",
      identity: { kind: "operator" },
      account: "default",
      ok: false,
      error: hugeError,
    });
    broker.stop();
    // The row landed in audit.jsonl, truncated to fit under the cap.
    const auditPath = join(h.stateDir, "audit.jsonl");
    const text = readFileSync(auditPath, "utf-8");
    const lastLine = text.trimEnd().split("\n").pop()!;
    expect(Buffer.byteLength(lastLine + "\n", "utf-8")).toBeLessThanOrEqual(4000);
    // Truncation marker present.
    expect(lastLine).toContain('"__truncated":true');
  });
});

describe("AuthBroker — claude-compatibility", () => {
  // Claude Code (2.x) reads OAuth credentials from `<configDir>/.credentials.json`
  // (DOTFILE). The broker writes the per-agent mirror at exactly that path.
  // Pre-RFC-H, both the deleted fanoutAccountToAgents and the very first
  // cut of this broker wrote to `credentials.json` (no dot) and got away
  // with it ONLY because start.sh.hbs also exported CLAUDE_CODE_OAUTH_TOKEN
  // from the legacy .oauth-token, so claude never read the on-disk mirror.
  // RFC H §7.4 deletes that env-injection path. The mirror MUST live at
  // the dotfile path or agents lose auth on first restart.
  //
  // This test pins the dotfile contract so a future "simplify the
  // filename" refactor can't silently undo it.
  it("writes the per-agent mirror to .credentials.json (dotfile — claude reads this path)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "secondary",
    });
    const fs = await import("node:fs");
    // Dotfile path EXISTS — claude can read it.
    expect(fs.existsSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"))).toBe(true);
    // Non-dot path DOES NOT exist — the broker doesn't double-write.
    expect(fs.existsSync(join(h.agentsDir, "ziggy", ".claude", "credentials.json"))).toBe(false);
    broker.stop();
  });
});

describe("AuthBroker — historical-bug regressions (2026-05-14 fanout incident)", () => {
  // Both bugs lived in the deleted account-refresh.ts:fanoutAccountToAgents
  // path. They surfaced when an operator flipped the fleet's primary Claude
  // account: `auth promote` EACCESed under user-mode (Bug 1), the operator
  // re-ran under sudo (which wrote root-owned files), then
  // `auth refresh-accounts` iterated every label and last-write-wins
  // overwrote the primary mirror (Bug 2). Net effect: agents silently
  // locked themselves out at next restart. The broker architecture closes
  // both vectors structurally — these tests pin that closure.

  it("Bug 1: per-agent mirror is chowned to the per-agent UID, never left as root", async () => {
    // The broker container runs as root and writes per-agent credentials.json.
    // Without an explicit chown, the file would land as root:root 0600 and
    // the agent (running as 10001–10999) couldn't read it. server.ts:953-956
    // calls `chownSync(targetPath, uid, uid)` where uid = allocateAgentUid().
    // We can't run as root in the test (so chownSync is a best-effort no-op
    // under dev — see the catch block), but we CAN verify the call is made
    // and reaches the right UID by spying on chownSync indirectly:
    // statSync(targetPath).uid will equal the test runner's UID in dev mode
    // (broker tried to chown to per-agent UID but lacked CAP_CHOWN). In
    // production with CAP_CHOWN, it would equal allocateAgentUid("ziggy").
    //
    // The pin: read the broker's source to confirm the chown call exists
    // with the right argument shape — a structural assertion that survives
    // a future "just remove the chown, it's a no-op in dev" refactor.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(path.join(here, "server.ts"), "utf-8");
    // Must chown the mirror file to allocateAgentUid(agentName), not leave
    // it root-owned. The exact pattern (a chownSync call against the
    // freshly-written .credentials.json path inside mirrorAccountToAgent)
    // is what closes Bug 1.
    // Budget bumped from 1600 → 3000 when mirror-time enrichment
    // landed (enrichMirrorContent call + load-bearing inline comments
    // about the .credentials.json dotfile invariant). The pin is still
    // meaningful — it asserts the chown call is *inside* the function,
    // not extracted to a remote helper that could regress silently.
    expect(serverSrc).toMatch(/mirrorAccountToAgent[\s\S]{0,3000}allocateAgentUid/);
    expect(serverSrc).toMatch(/mirrorAccountToAgent[\s\S]{0,3000}chownSync\(targetPath/);
  });

  it("Bug 2: refresh tick writes ONLY the agent's effective account, not last-iterated label", async () => {
    // Pre-broker, refreshAllAccounts iterated every enabled account and
    // fanned each one out to every agent — last-write wins, alphabetic
    // sort destroys the YAML primary. Post-broker, fanoutForAgent computes
    // `agent.auth.override ?? auth.active` and writes EXACTLY THAT.
    // Iteration order doesn't exist as a concept.
    //
    // Setup: three accounts, alice < bob < you (the exact alphabetic
    // order that caused the original incident — you sorted last).
    // Two agents, one on fleet active (= "alice"), one with override = "bob".
    // Run a full refresh tick. Verify each agent's mirror is its own
    // declared account, not you's.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "alice@example.com",
      fallback_order: [
        "alice@example.com",
        "bob@example.com",
        "you@example.com",
      ],
      agents: {
        ziggy: {}, // inherits fleet active = alice
        lawgpt: { auth: { override: "bob@example.com" } },
      },
    });
    // Seed all three accounts with near-expiry creds so the tick attempts
    // a refresh against each. The exact alphabetic ordering of the labels
    // is what triggered the original last-write-wins. With you iterating
    // last, the pre-broker code would have ended with you's creds in
    // every agent. The broker MUST write alice to ziggy and bob to lawgpt.
    const nearExpiry = Date.now() + 30 * 60 * 1000; // 30 min — under threshold
    seedAccount(h, "alice@example.com", { expiresAt: nearExpiry });
    seedAccount(h, "bob@example.com", { expiresAt: nearExpiry });
    seedAccount(h, "you@example.com", { expiresAt: nearExpiry });
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "lawgpt"), { recursive: true });
    // Stub fetcher that returns predictable per-label access tokens. The
    // body matters: each agent's mirror should contain the token of the
    // RIGHT account, not the last-iterated one.
    const fetcher = async (_url: unknown, init: unknown) => {
      // Body is application/json; refresh_token field carries
      // "rt-<label>" (set by seedAccount). Parse to recover the label.
      const body = (init as { body?: string })?.body ?? "{}";
      const parsed = JSON.parse(body) as { refresh_token?: string };
      const rt = parsed.refresh_token ?? "";
      const label = rt.replace(/^rt-/, "");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: `at-refreshed-${label}`,
            refresh_token: `rt-rotated-${label}`,
            expires_in: 8 * 60 * 60,
            token_type: "Bearer",
          }),
      };
    };
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      fetcher: fetcher as never,
      disableRefreshLoop: true,
    });
    await broker.start();
    await broker._tick();

    const ziggyMirror = readFileSync(
      join(h.agentsDir, "ziggy", ".claude", ".credentials.json"),
      "utf-8",
    );
    const lawgptMirror = readFileSync(
      join(h.agentsDir, "lawgpt", ".claude", ".credentials.json"),
      "utf-8",
    );

    // ziggy should have alice's refreshed token (fleet active).
    expect(ziggyMirror).toContain("at-refreshed-alice@example.com");
    expect(ziggyMirror).not.toContain("at-refreshed-you@example.com");
    expect(ziggyMirror).not.toContain("at-refreshed-bob@example.com");

    // lawgpt should have bob's refreshed token (override).
    expect(lawgptMirror).toContain("at-refreshed-bob@example.com");
    expect(lawgptMirror).not.toContain("at-refreshed-you@example.com");
    expect(lawgptMirror).not.toContain("at-refreshed-alice@example.com");

    broker.stop();
  });
});

describe("AuthBroker — agent serving-failover (Layer 2, #2218 weekly-wall durability)", () => {
  // Fleet: active=default, fallback default→secondary, one agent (clerk). The
  // auto-fallback path (mark-exhausted) marks the active account's quota +
  // mirrors the fallback ONCE but never rewrites auth.active, so the
  // exhaustion-BLIND refresh-tick fanout used to silently re-mirror the walled
  // account back onto the fleet within ~1h. These pin that the serving + fanout
  // reads now honour the exhaustion window. (Models the real clerk incident,
  // 2026-06-07, with neutral account labels.)
  function failoverHarness(opts: { now?: () => number } = {}) {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      now: opts.now,
    });
    return {
      h,
      broker,
      clerkSock: join(h.socketRoot, "clerk", "sock"),
      mirror: join(h.agentsDir, "clerk", ".claude", ".credentials.json"),
    };
  }

  it("serves an agent its healthy fallback while auth.active is walled", async () => {
    const { broker, clerkSock } = failoverHarness();
    await broker.start();
    let resp = (await rpc(clerkSock, { v: 1, id: "1", op: "get-credentials" })) as {
      ok: boolean; data: { account: string };
    };
    expect(resp.data.account).toBe("default"); // healthy
    // clerk hits the weekly wall → mark-exhausted(default) with a weekly until.
    await rpc(clerkSock, { v: 1, id: "2", op: "mark-exhausted", until: Date.now() + 7 * 24 * 3600_000 });
    resp = (await rpc(clerkSock, { v: 1, id: "3", op: "get-credentials" })) as {
      ok: boolean; data: { account: string };
    };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("secondary"); // NOT the walled active
    broker.stop();
  });

  it("a refresh-tick fanout during exhaustion never re-mirrors the walled account (the rollback guard)", async () => {
    const { broker, clerkSock, mirror } = failoverHarness();
    await broker.start();
    expect(readFileSync(mirror, "utf-8")).toContain("at-default"); // boot mirror
    await rpc(clerkSock, { v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 7 * 24 * 3600_000 });
    expect(readFileSync(mirror, "utf-8")).toContain("at-secondary"); // failover fanout
    // The exhaustion-BLIND refresh-tick fanout fires. auth.active is STILL the
    // walled account (mark-exhausted never rewrote it), so pre-fix fanoutForAgent
    // re-mirrored its refreshed-but-walled creds here → the rollback. Must hold.
    broker._fanoutAll();
    const after = readFileSync(mirror, "utf-8");
    expect(after).toContain("at-secondary");
    expect(after).not.toContain("at-default");
    broker.stop();
  });

  // ── Live-quota-authoritative eligibility (2026-06-10 stale-mark outage) ──
  // A quota fetch seam that returns per-account utilization keyed by the
  // `at-<label>` token seedAccount writes, so a fleetQuotaProbeTick populates
  // lastQuotaCache with a chosen live snapshot per account.
  function liveQuota(
    util: Record<string, { five: number; seven: number; overageStatus?: string | null; overageReason?: string | null }>,
  ) {
    return async ({ accessToken }: { accessToken: string }) => {
      const label = accessToken.replace(/^at-/, "");
      const u = util[label] ?? { five: 0, seven: 0 };
      return { ok: true as const, data: {
        fiveHourUtilizationPct: u.five, sevenDayUtilizationPct: u.seven,
        fiveHourResetAt: null, sevenDayResetAt: null,
        representativeClaim: null,
        overageStatus: u.overageStatus ?? null,
        overageDisabledReason: u.overageReason ?? null,
      } };
    };
  }

  it("INCIDENT A: a bogus future mark on a LIVE-HEALTHY account is ignored AND self-healed", async () => {
    let clock = Date.UTC(2026, 5, 10, 7, 0, 0);
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", fallback_order: ["default", "secondary"], agents: { clerk: {} } });
    seedAccount(h, "default"); seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      now: () => clock,
      _testFetchQuota: liveQuota({ default: { five: 4, seven: 20 }, secondary: { five: 5, seven: 10 } }),
    });
    const clerkSock = join(h.socketRoot, "clerk", "sock");
    try {
      await broker.start();
      // Stamp the bogus +7d mark on the healthy primary (the incident shape).
      await rpc(clerkSock, { v: 1, id: "1", op: "mark-exhausted", until: clock + 7 * 24 * 3600_000 });
      // No live data yet → eligibility falls back to the mark → would fail over.
      // Now a live probe lands showing default healthy (5h=4 / 7d=20).
      await broker.fleetQuotaProbeTick();
      // Serving must IGNORE the stale mark and keep default (live-authoritative).
      const resp = (await rpc(clerkSock, { v: 1, id: "2", op: "get-credentials" })) as { data: { account: string } };
      expect(resp.data.account).toBe("default");
      // …and the healthy probe must have SELF-HEALED the mark off disk.
      const acct = (await new AuthBrokerClient({ socket: clerkSock }).listState()).accounts.find((a) => a.label === "default");
      expect(acct?.exhausted).toBe(false);
      expect(acct?.exhausted_until).toBeUndefined();
    } finally { broker.stop(); }
  });

  it("INCIDENT B: failover SKIPS a candidate whose mark is past but whose LIVE quota is walled", async () => {
    let clock = Date.UTC(2026, 5, 10, 7, 0, 0);
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", fallback_order: ["default", "secondary", "tertiary"], agents: { clerk: {} } });
    seedAccount(h, "default"); seedAccount(h, "secondary"); seedAccount(h, "tertiary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      now: () => clock,
      // default genuinely walled; secondary LIVE-walled (5h=100) despite no mark;
      // tertiary healthy. Failover must hop over secondary to tertiary.
      _testFetchQuota: liveQuota({ default: { five: 100, seven: 30 }, secondary: { five: 100, seven: 27 }, tertiary: { five: 3, seven: 8 } }),
    });
    const clerkSock = join(h.socketRoot, "clerk", "sock");
    try {
      await broker.start();
      await broker.fleetQuotaProbeTick(); // live snapshots populate
      // default walls → mark-exhausted; live shows secondary walled too.
      await rpc(clerkSock, { v: 1, id: "1", op: "mark-exhausted", until: clock + 3600_000 });
      const resp = (await rpc(clerkSock, { v: 1, id: "2", op: "get-credentials" })) as { data: { account: string } };
      expect(resp.data.account).toBe("tertiary"); // NOT secondary (live-walled)
    } finally { broker.stop(); }
  });

  it("a weekly until holds past markExhausted's ~5h default, then auto-reverts", async () => {
    let clock = Date.UTC(2026, 5, 7, 0, 0, 0);
    const { broker, clerkSock } = failoverHarness({ now: () => clock });
    await broker.start();
    const weeklyUntil = clock + 7 * 24 * 3600_000;
    await rpc(clerkSock, { v: 1, id: "1", op: "mark-exhausted", until: weeklyUntil });
    // 6h in — PAST the ~5h MARK_EXHAUSTED_DEFAULT_MS. Pre-RC#2 a weekly wall got
    // that ~5h default and would have un-exhausted + rolled back right here.
    clock = Date.UTC(2026, 5, 7, 6, 0, 0);
    let resp = (await rpc(clerkSock, { v: 1, id: "2", op: "get-credentials" })) as {
      ok: boolean; data: { account: string };
    };
    expect(resp.data.account).toBe("secondary");
    // Past the weekly window → auto-revert to the active account.
    clock = weeklyUntil + 1;
    resp = (await rpc(clerkSock, { v: 1, id: "3", op: "get-credentials" })) as {
      ok: boolean; data: { account: string };
    };
    expect(resp.data.account).toBe("default");
    broker.stop();
  });

  it("keeps serving the walled active when EVERY fallback is also exhausted (retry beats dark)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      agents: { clerk: {}, gymbro: { auth: { override: "secondary" } } },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    mkdirSync(join(h.agentsDir, "gymbro"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    const until = Date.now() + 7 * 24 * 3600_000;
    await rpc(join(h.socketRoot, "clerk", "sock"), { v: 1, id: "1", op: "mark-exhausted", until }); // marks default
    await rpc(join(h.socketRoot, "gymbro", "sock"), { v: 1, id: "2", op: "mark-exhausted", until }); // marks secondary
    // clerk on default (walled); its only fallback secondary is walled too → no
    // healthy alternative → serve the pinned/active default (retry) not nothing.
    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "3", op: "get-credentials",
    })) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    broker.stop();
  });

  // ── out_of_credits is INFORMATIONAL (fix/out-of-credits-serve-block) ────────
  it("(a) out_of_credits active @0% ⇒ list-state exhausted:false AND still served (NOT a serve-block)", async () => {
    // NEW CONTRACT: out_of_credits is demoted to informational. An account at
    // 0% util with out_of_credits is classified HEALTHY by isAccountBlocked →
    // exhausted:false in list-state, and get-credentials keeps serving it.
    // Failover safety is preserved via mark-exhausted on a real 429 (not here).
    let clock = Date.UTC(2026, 5, 20, 7, 0, 0);
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", fallback_order: ["default", "secondary"], agents: { clerk: {} } });
    seedAccount(h, "default"); seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      now: () => clock,
      // default: 0% util + out_of_credits (informational only); secondary healthy.
      _testFetchQuota: liveQuota({
        default: { five: 0, seven: 0, overageStatus: "rejected", overageReason: "out_of_credits" },
        secondary: { five: 5, seven: 10 },
      }),
    });
    const clerkSock = join(h.socketRoot, "clerk", "sock");
    try {
      await broker.start();
      await broker.fleetQuotaProbeTick();
      // list-state: default is NOT exhausted — out_of_credits is informational only.
      const acct = (await new AuthBrokerClient({ socket: clerkSock }).listState()).accounts.find((a) => a.label === "default");
      expect(acct?.exhausted).toBe(false);
      // get-credentials must keep serving default — no spurious failover.
      const resp = (await rpc(clerkSock, { v: 1, id: "1", op: "get-credentials" })) as { data: { account: string } };
      expect(resp.data.account).toBe("default");
    } finally { broker.stop(); }
  });

  it("(b) org_level_disabled active @75% ⇒ exhausted:false AND still served (MANDATORY end-to-end catastrophic guard)", async () => {
    let clock = Date.UTC(2026, 5, 20, 7, 0, 0);
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", fallback_order: ["default", "secondary"], agents: { clerk: {} } });
    seedAccount(h, "default"); seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      now: () => clock,
      // The LIVE fleet account: 75% util, overage org-disabled + status rejected,
      // but serving fine off subscription. Must NOT be marked exhausted.
      _testFetchQuota: liveQuota({
        default: { five: 75, seven: 40, overageStatus: "rejected", overageReason: "org_level_disabled" },
        secondary: { five: 5, seven: 10 },
      }),
    });
    const clerkSock = join(h.socketRoot, "clerk", "sock");
    try {
      await broker.start();
      await broker.fleetQuotaProbeTick();
      const acct = (await new AuthBrokerClient({ socket: clerkSock }).listState()).accounts.find((a) => a.label === "default");
      expect(acct?.exhausted).toBe(false);
      // get-credentials must KEEP serving default (no spurious failover).
      const resp = (await rpc(clerkSock, { v: 1, id: "1", op: "get-credentials" })) as { data: { account: string } };
      expect(resp.data.account).toBe("default");
    } finally { broker.stop(); }
  });

  it("(c) a pre-seeded mark IS self-healed by a fresh 0%/out_of_credits probe (informational, not blocking); 0%/null also clears it", async () => {
    // NEW CONTRACT (fix/out-of-credits-serve-block): out_of_credits does NOT
    // prevent snapshotShouldClearMark from clearing a misfired mark.
    // A genuinely healthy (0% util) probe DOES clear the mark regardless of the
    // out_of_credits flag. Failover safety is via mark-exhausted on a real 429.
    let clock = Date.UTC(2026, 5, 20, 7, 0, 0);
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", fallback_order: ["default", "secondary"], agents: { clerk: {} } });
    seedAccount(h, "default"); seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      now: () => clock,
      _testFetchQuota: liveQuota({
        default: { five: 0, seven: 0, overageStatus: "rejected", overageReason: "out_of_credits" },
        secondary: { five: 5, seven: 10 },
      }),
    });
    const clerkSock = join(h.socketRoot, "clerk", "sock");
    try {
      await broker.start();
      await rpc(clerkSock, { v: 1, id: "1", op: "mark-exhausted", until: clock + 3600_000 });
      await broker.fleetQuotaProbeTick(); // 0% probe with out_of_credits → DOES self-heal
      const acct = (await new AuthBrokerClient({ socket: clerkSock }).listState()).accounts.find((a) => a.label === "default");
      // Mark IS cleared: out_of_credits is informational, 0% util = genuinely healthy.
      expect(acct?.exhausted).toBe(false);
      expect(acct?.exhausted_until).toBeUndefined();
    } finally { broker.stop(); }

    // Same behavior with NULL overage reason — both clear the mark (regression anchor).
    let clock2 = Date.UTC(2026, 5, 20, 7, 0, 0);
    const h2 = makeHarness();
    const config2 = makeConfig(h2, { active: "default", fallback_order: ["default", "secondary"], agents: { clerk: {} } });
    seedAccount(h2, "default"); seedAccount(h2, "secondary");
    mkdirSync(join(h2.agentsDir, "clerk"), { recursive: true });
    const broker2 = new AuthBroker(config2, {
      home: h2.home, stateDir: h2.stateDir, socketRoot: h2.socketRoot, disableRefreshLoop: true,
      now: () => clock2,
      _testFetchQuota: liveQuota({ default: { five: 0, seven: 0 }, secondary: { five: 5, seven: 10 } }),
    });
    const clerkSock2 = join(h2.socketRoot, "clerk", "sock");
    try {
      await broker2.start();
      await rpc(clerkSock2, { v: 1, id: "1", op: "mark-exhausted", until: clock2 + 3600_000 });
      await broker2.fleetQuotaProbeTick(); // 0% + null reason → clears (unchanged behavior)
      const acct = (await new AuthBrokerClient({ socket: clerkSock2 }).listState()).accounts.find((a) => a.label === "default");
      expect(acct?.exhausted).toBe(false);
      expect(acct?.exhausted_until).toBeUndefined();
    } finally { broker2.stop(); }
  });

  it("(d) cold-start with no snapshot is NOT pre-blocked by overage (deny-by-omission)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", fallback_order: ["default", "secondary"], agents: { clerk: {} } });
    seedAccount(h, "default"); seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    const clerkSock = join(h.socketRoot, "clerk", "sock");
    try {
      await broker.start();
      // No fleetQuotaProbeTick — no snapshot at all. Must serve default normally.
      const resp = (await rpc(clerkSock, { v: 1, id: "1", op: "get-credentials" })) as { data: { account: string } };
      expect(resp.data.account).toBe("default");
      const acct = (await new AuthBrokerClient({ socket: clerkSock }).listState()).accounts.find((a) => a.label === "default");
      expect(acct?.exhausted).toBe(false);
    } finally { broker.stop(); }
  });
});

describe("AuthBroker — claim-notification (fleet notification dedup)", () => {
  function makeClaimBroker(h: Harness, fakeNow: () => number): AuthBroker {
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {}, klanker: {} },
    });
    seedAccount(h, "default");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "klanker"), { recursive: true });
    return new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      now: fakeNow,
    });
  }

  it("grants the first claimant and denies the second inside the window — across agents", async () => {
    const h = makeHarness();
    let t = 1_000_000;
    const broker = makeClaimBroker(h, () => t);
    await broker.start();
    const key = "quota-watch:acct@example.com:recovered-to-healthy:12345";
    // ziggy (non-admin) claims first → granted. No ACL on this op.
    const first = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(first.ok).toBe(true);
    expect(first.data.granted).toBe(true);
    // klanker claims the SAME key 5 minutes later → denied.
    t += 5 * 60_000;
    const second = await rpc(join(h.socketRoot, "klanker", "sock"), {
      v: 1, id: "2", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(second.ok).toBe(true);
    expect(second.data.granted).toBe(false);
    broker.stop();
  });

  it("a different key (other chat / other transition) is independent", async () => {
    const h = makeHarness();
    const broker = makeClaimBroker(h, () => 1_000_000);
    await broker.start();
    const sock = join(h.socketRoot, "ziggy", "sock");
    const a = await rpc(sock, {
      v: 1, id: "1", op: "claim-notification",
      key: "quota-watch:acct@example.com:recovered-to-healthy:111", windowMs: 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    const b = await rpc(sock, {
      v: 1, id: "2", op: "claim-notification",
      key: "quota-watch:acct@example.com:recovered-to-healthy:222", windowMs: 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    const c = await rpc(sock, {
      v: 1, id: "3", op: "claim-notification",
      key: "quota-watch:acct@example.com:entered-throttling:111", windowMs: 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(a.data.granted).toBe(true);
    expect(b.data.granted).toBe(true); // other chat
    expect(c.data.granted).toBe(true); // other edge direction
    broker.stop();
  });

  it("re-grants the same key after the window expires", async () => {
    const h = makeHarness();
    let t = 1_000_000;
    const broker = makeClaimBroker(h, () => t);
    await broker.start();
    const sock = join(h.socketRoot, "ziggy", "sock");
    const key = "quota-watch:acct@example.com:entered-throttling:12345";
    const first = await rpc(sock, {
      v: 1, id: "1", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(first.data.granted).toBe(true);
    // 29 min later: still inside the window → denied.
    t += 29 * 60_000;
    const inside = await rpc(sock, {
      v: 1, id: "2", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(inside.data.granted).toBe(false);
    // Another 2 min (31 total since grant): window expired → granted again
    // (a genuine re-crossing of the same edge re-notifies).
    t += 2 * 60_000;
    const after = await rpc(sock, {
      v: 1, id: "3", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(after.data.granted).toBe(true);
    broker.stop();
  });

  it("claims persist across a broker restart (window survives the bounce)", async () => {
    const h = makeHarness();
    let t = 1_000_000;
    const broker1 = makeClaimBroker(h, () => t);
    await broker1.start();
    const key = "quota-watch:acct@example.com:recovered-to-healthy:12345";
    const first = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(first.data.granted).toBe(true);
    broker1.stop();
    // On-disk file exists with the key.
    const onDisk = JSON.parse(readFileSync(join(h.stateDir, "notification-claims.json"), "utf-8"));
    expect(onDisk[key]).toBe(1_000_000);
    // New broker process, 5 min later (fleet bounce mid-window): still denied.
    t += 5 * 60_000;
    const broker2 = makeClaimBroker(h, () => t);
    await broker2.start();
    const second = await rpc(join(h.socketRoot, "klanker", "sock"), {
      v: 1, id: "2", op: "claim-notification", key, windowMs: 30 * 60_000,
    }) as { ok: boolean; data: { granted: boolean } };
    expect(second.data.granted).toBe(false);
    broker2.stop();
  });

  it("prunes entries older than 24h on the next grant (file stays bounded)", async () => {
    const h = makeHarness();
    let t = 1_000_000;
    const broker = makeClaimBroker(h, () => t);
    await broker.start();
    const sock = join(h.socketRoot, "ziggy", "sock");
    const oldKey = "quota-watch:acct@example.com:entered-throttling:111";
    await rpc(sock, { v: 1, id: "1", op: "claim-notification", key: oldKey, windowMs: 60_000 });
    // 25 hours later, a new grant triggers the prune sweep.
    t += 25 * 60 * 60_000;
    await rpc(sock, {
      v: 1, id: "2", op: "claim-notification",
      key: "quota-watch:acct@example.com:entered-throttling:222", windowMs: 60_000,
    });
    const onDisk = JSON.parse(readFileSync(join(h.stateDir, "notification-claims.json"), "utf-8"));
    expect(onDisk[oldKey]).toBeUndefined();
    expect(Object.keys(onDisk)).toHaveLength(1);
    broker.stop();
  });

  it("two concurrent claims for the same key yield exactly one grant", async () => {
    const h = makeHarness();
    const broker = makeClaimBroker(h, () => 1_000_000);
    await broker.start();
    const key = "quota-watch:acct@example.com:recovered-to-healthy:999";
    const [a, b] = await Promise.all([
      rpc(join(h.socketRoot, "ziggy", "sock"), {
        v: 1, id: "1", op: "claim-notification", key, windowMs: 60_000,
      }),
      rpc(join(h.socketRoot, "klanker", "sock"), {
        v: 1, id: "2", op: "claim-notification", key, windowMs: 60_000,
      }),
    ]) as Array<{ ok: boolean; data: { granted: boolean } }>;
    const grants = [a, b].filter((r) => r.data.granted).length;
    expect(grants).toBe(1);
    broker.stop();
  });
});
