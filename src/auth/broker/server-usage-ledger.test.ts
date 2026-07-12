/**
 * #3185 — end-to-end: the rate-limit headers the broker ALREADY receives each
 * fleet tick (haiku standard probe + #3176 flagship canary) must land in a
 * durable per-(account, tier) usage ledger, surface via `list-state`, survive a
 * restart, and feed the premium-failover selector as a headroom PREFERENCE —
 * all WITHOUT adding any request (the harness fetcher is the only traffic; the
 * ledger is pure harvest).
 *
 * Asserts OUTCOMES (headers in → ledger state → list-state / selection out),
 * not code paths. Tmpdir-isolated.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import { AuthBrokerClient } from "./client.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { FetchQuotaOptions, QuotaResult } from "../quota.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-usage-ledger-"));
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

function makeConfig(h: Harness, active: string, fallback: string[]): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: { rider: {} },
    auth: { active, fallback_order: fallback },
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

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/** haiku standard probe: 5h/7d utilization, healthy. */
function haiku(five: number, seven: number): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: five,
    sevenDayUtilizationPct: seven,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
  } };
}

/** flagship canary 200: allowed, with a given 7d_oi utilization. */
function fableAllowed(oiUtil: number): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 1,
    sevenDayUtilizationPct: 5,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
    unifiedStatus: "allowed",
    sevenDayOiStatus: "allowed",
    sevenDayOiUtilizationPct: oiUtil,
    sevenDayOiResetAt: null,
    sevenDayOiPresent: true,
  } };
}

/** flagship canary 429: 7d_oi rejected (a wall). */
function fableWalled(resetMs: number): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 0,
    sevenDayUtilizationPct: 0,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: "seven_day_overage_included",
    overageStatus: null,
    overageDisabledReason: null,
    unifiedStatus: "rejected",
    sevenDayOiStatus: "rejected",
    sevenDayOiUtilizationPct: 100,
    sevenDayOiResetAt: new Date(resetMs),
    sevenDayOiPresent: true,
  } };
}

/** Build a fetcher: haiku for the default probe, per-account flagship result. */
function fetcher(
  haikuByAccount: Record<string, () => QuotaResult>,
  tierByAccount: Record<string, () => QuotaResult>,
): (opts: FetchQuotaOptions) => Promise<QuotaResult> {
  return async ({ accessToken, model }: FetchQuotaOptions) => {
    const label = accessToken.replace(/^at-/, "");
    if (model && model !== HAIKU_MODEL) {
      return (tierByAccount[label] ?? (() => fableAllowed(10)))();
    }
    return (haikuByAccount[label] ?? (() => haiku(1, 5)))();
  };
}

describe("#3185 usage ledger — harvest, surface, persist", () => {
  it("records standard + premium samples for every probed account and surfaces them in list-state", async () => {
    const h = makeHarness();
    seedAccount(h, "acct");
    seedAccount(h, "spare");
    const broker = new AuthBroker(makeConfig(h, "acct", ["acct", "spare"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher(
        { acct: () => haiku(2, 40), spare: () => haiku(1, 10) },
        { acct: () => fableAllowed(30), spare: () => fableAllowed(15) },
      ),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    // Standard tier harvested from the haiku probe (binding = 7d = 40).
    expect(st.usageLedger["acct"]?.standard?.samples.at(-1)?.utilizationPct).toBe(40);
    // Premium tier harvested from the flagship canary (7d_oi = 30).
    expect(st.usageLedger["acct"]?.premium?.samples.at(-1)?.utilizationPct).toBe(30);
    expect(st.usageLedger["spare"]?.premium?.samples.at(-1)?.utilizationPct).toBe(15);

    // list-state (over the real UDS wire) carries the refill-normalized
    // per-tier summary — the operator/dashboard surface.
    const client = new AuthBrokerClient({ socket: join(h.socketRoot, "rider", "sock") });
    try {
      const state = await client.listState();
      const acct = state.accounts.find((a) => a.label === "acct")!;
      expect(acct.usage_ledger?.premium?.headroomPct).toBe(70); // 100 - 30
      expect(acct.usage_ledger?.standard?.headroomPct).toBe(60); // 100 - 40
      expect(acct.usage_ledger?.premium?.observations).toBe(1);
    } finally {
      await client.close();
    }
    broker.stop();
  });

  it("persists the ledger to usage-ledger.json and reloads it across a restart", async () => {
    const h = makeHarness();
    seedAccount(h, "acct");
    const opts = {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ acct: () => haiku(3, 22) }, { acct: () => fableAllowed(44) }),
    };
    const b1 = new AuthBroker(makeConfig(h, "acct", ["acct"]), opts);
    await b1.start();
    await b1.fleetQuotaProbeTick();
    b1.stop();

    // The durable file exists.
    expect(existsSync(join(h.stateDir, "usage-ledger.json"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(h.stateDir, "usage-ledger.json"), "utf-8"));
    expect(onDisk["acct"].premium.samples.at(-1).utilizationPct).toBe(44);

    // A fresh broker reloads it — history is not lost.
    const b2 = new AuthBroker(makeConfig(h, "acct", ["acct"]), opts);
    await b2.start();
    const reloaded = b2._state().usageLedger["acct"];
    expect(reloaded?.premium?.samples.at(-1)?.utilizationPct).toBe(44);
    expect(reloaded?.standard?.samples.at(-1)?.utilizationPct).toBe(22);
    b2.stop();
  });

  it("does NOT record a premium sample for an account outside the canary set (no fabricated tier data)", async () => {
    const h = makeHarness();
    seedAccount(h, "active");
    // 'lonely' exists on disk but is NOT active / fallback / pinned → no canary.
    seedAccount(h, "lonely");
    const broker = new AuthBroker(makeConfig(h, "active", ["active"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({}, {}),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    const st = broker._state();
    // Standard tier IS probed for every account (the haiku fleet probe).
    expect(st.usageLedger["lonely"]?.standard).toBeTruthy();
    // Premium tier is NOT — the canary only hits the serving set.
    expect(st.usageLedger["lonely"]?.premium).toBeUndefined();
    broker.stop();
  });
});

describe("#3185 usage ledger — feeds the premium-failover selector", () => {
  it("rolls a flagship-walled active to the eligible fallback with the MOST premium headroom (not just ring order)", async () => {
    const h = makeHarness();
    seedAccount(h, "walled");
    seedAccount(h, "low");   // first in ring order after walled, but LESS headroom
    seedAccount(h, "high");  // later in ring order, but MORE headroom
    const resetMs = Date.now() + 2 * 60 * 60 * 1000;
    const broker = new AuthBroker(makeConfig(h, "walled", ["walled", "low", "high"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher(
        {},
        {
          walled: () => fableWalled(resetMs),
          low: () => fableAllowed(90),  // 10% headroom
          high: () => fableAllowed(20), // 80% headroom
        },
      ),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    // The walled active rolled — and it rolled to `high`, the higher-headroom
    // fallback, NOT `low` (which ring order would have picked first). This is
    // the ledger driving the selection.
    expect(st.quota["walled"]?.premium_walled_until).toBe(resetMs);
    expect(st.activeAccount).toBe("high");
    broker.stop();
  });

  it("on EQUAL premium headroom, selection is order-stable — first eligible in ring order (unchanged behavior)", async () => {
    const h = makeHarness();
    seedAccount(h, "walled");
    seedAccount(h, "first");
    seedAccount(h, "second");
    const resetMs = Date.now() + 60 * 60 * 1000;
    // Equal headroom on both fallbacks → the ledger preference has no opinion,
    // so ring order governs (the pre-#3185 behavior). This guards that the
    // headroom preference NEVER reorders when it lacks a distinguishing signal.
    const broker = new AuthBroker(makeConfig(h, "walled", ["walled", "first", "second"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher(
        {},
        {
          walled: () => fableWalled(resetMs),
          first: () => fableAllowed(50),  // equal headroom
          second: () => fableAllowed(50), // equal headroom → ring order wins
        },
      ),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    // Equal headroom → order-stable → first eligible in ring order.
    expect(broker._state().activeAccount).toBe("first");
    broker.stop();
  });
});
