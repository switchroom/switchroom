/**
 * #3176 — the fleet quota probe tick must detect an account walled on the
 * flagship model tier (`7d_oi` / `seven_day_overage_included`) and fail the
 * fleet off it, WITHOUT waiting for an 86-request 429 storm.
 *
 * The incident: the default haiku probe reads the account 5h=1% / 7d=58% —
 * healthy — while a flagship (Fable) request 429s with 7d_oi=100% rejected.
 * The broker set the account fleet-active and every flagship agent stormed.
 *
 * These tests drive the fleet tick with a `_testFetchQuota` that returns
 * DIFFERENT results per requested model — haiku healthy, flagship walled —
 * exactly reproducing the split. They FAIL on pristine main (no canary, no
 * tier classification, no tier-scoped mark).
 *
 * Tmpdir-isolated (never ~/.switchroom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-tier-wall-"));
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

/** haiku 5h/7d healthy — what the default probe (no model) reads. */
function haikuHealthy(): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 1,
    sevenDayUtilizationPct: 58,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
  } };
}

/** flagship 429 — 7d_oi rejected (the fable wall the haiku probe cannot see). */
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

/** flagship 200 — tier allowed (a healthy canary). */
function fableAllowed(): QuotaResult {
  return { ok: true, data: {
    fiveHourUtilizationPct: 1,
    sevenDayUtilizationPct: 58,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
    unifiedStatus: "allowed",
    sevenDayOiStatus: "allowed",
    sevenDayOiUtilizationPct: 58,
    sevenDayOiResetAt: null,
    sevenDayOiPresent: true,
  } };
}

/**
 * Build a `_testFetchQuota` that branches on the requested model AND account.
 * `tierByAccount` maps account label → flagship-canary result; a request with
 * no model (the haiku probe) always reads healthy.
 */
function fetcher(
  tierByAccount: Record<string, () => QuotaResult>,
): (opts: FetchQuotaOptions) => Promise<QuotaResult> {
  return async ({ accessToken, model }: FetchQuotaOptions) => {
    const label = accessToken.replace(/^at-/, "");
    if (model && model !== "claude-haiku-4-5-20251001") {
      const fn = tierByAccount[label];
      return fn ? fn() : fableAllowed();
    }
    return haikuHealthy();
  };
}

describe("#3176 fleet tick — model-tier (7d_oi) wall detection", () => {
  it("marks the flagship-walled active account and rolls the fleet off it (tier-scoped, not exhausted)", async () => {
    const h = makeHarness();
    seedAccount(h, "walled");
    seedAccount(h, "healthy");
    const resetMs = Date.now() + 2.8 * 60 * 60 * 1000;
    const broker = new AuthBroker(makeConfig(h, "walled", ["walled", "healthy"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ walled: () => fableWalled(resetMs) }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    // The tier wall was recorded — with the real ~2.8h reset, not invisible.
    expect(st.quota["walled"]?.premium_walled_until).toBe(resetMs);
    expect(st.quota["walled"]?.premium_wall_bucket).toBe("seven_day_overage_included");
    // TIER-SCOPED: it is NOT a blanket exhaustion mark (the account still
    // serves opus/haiku fine).
    expect(st.quota["walled"]?.exhausted_until).toBeUndefined();
    // The fleet rolled off the walled account and durably promoted the target.
    expect(st.activeAccount).toBe("healthy");
    // The canary snapshot is persisted for transparency.
    expect(st.lastTierQuotaCache["walled"]?.sevenDayOiStatus).toBe("rejected");
    broker.stop();
  });

  it("does NOT select a flagship-walled fallback as the roll target; all-walled records the alert with earliest reset", async () => {
    const h = makeHarness();
    seedAccount(h, "a");
    seedAccount(h, "b");
    const resetA = Date.now() + 3 * 60 * 60 * 1000;
    const resetB = Date.now() + 1 * 60 * 60 * 1000; // earlier
    const broker = new AuthBroker(makeConfig(h, "a", ["a", "b"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({
        a: () => fableWalled(resetA),
        b: () => fableWalled(resetB),
      }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    // Both walled → no eligible target → active stays put, all-walled alert set.
    expect(st.activeAccount).toBe("a");
    expect(st.premiumTierAllWalled).not.toBeNull();
    expect(st.premiumTierAllWalled?.earliest_reset).toBe(resetB);
    expect(st.premiumTierAllWalled?.bucket).toBe("seven_day_overage_included");
    broker.stop();
  });

  it("a later canary reading the tier allowed clears a stale wall mark", async () => {
    const h = makeHarness();
    seedAccount(h, "acct");
    seedAccount(h, "spare");
    const resetMs = Date.now() + 2 * 60 * 60 * 1000;
    // Tick 1: acct walled → mark set, roll to spare.
    let walled = true;
    const broker = new AuthBroker(makeConfig(h, "acct", ["acct", "spare"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async ({ accessToken, model }: FetchQuotaOptions) => {
        const label = accessToken.replace(/^at-/, "");
        if (model && model !== "claude-haiku-4-5-20251001") {
          if (label === "acct") return walled ? fableWalled(resetMs) : fableAllowed();
          return fableAllowed();
        }
        return haikuHealthy();
      },
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    expect(broker._state().quota["acct"]?.premium_walled_until).toBe(resetMs);

    // Tick 2: acct's canary now reads allowed → the mark self-heals.
    walled = false;
    await broker.fleetQuotaProbeTick();
    expect(broker._state().quota["acct"]?.premium_walled_until).toBeUndefined();
    broker.stop();
  });
});
