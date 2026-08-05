/**
 * Entitlement-403 probe hardening (PR2) — broker-side persistence + eligibility.
 *
 * The gap: a probe that gets a 403 saying "Your organization has disabled Claude
 * subscription access for Claude Code" used to be a silent no-op — the broker
 * served the STALE cached snapshot, so a disabled account decayed to "unknown"
 * and could masquerade as healthy (and even be selected on failover) off a stale
 * cache. These tests assert the hardened OUTCOMES:
 *
 *   - a fleet-tick entitlement-403 marks `entitlement_blocked` within one tick;
 *   - a blocked account in fallback_order is NOT selected as a roll target,
 *     even when it sits ahead of a healthy fallback in the order;
 *   - a later SUCCESSFUL probe clears the mark;
 *   - a non-entitlement 403 (bad scope) does NOT set the mark;
 *   - a marked account is SKIPPED by later fleet ticks (no wasted probes),
 *     while an explicit manual probe still runs and can clear it.
 *
 * Tmpdir-isolated (never ~/.switchroom). Drives the broker via the injected
 * `_testFetchQuota` seam and (for the manual re-probe) a real socket RPC.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import { fetchQuota } from "../quota.js";
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-entitlement-"));
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
    agents: { ziggy: {} },
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

/** A complete, healthy haiku probe (both windows measured). */
function healthy(five = 1, seven = 2): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: five,
      sevenDayUtilizationPct: seven,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      fiveHourUtilPresent: true,
      sevenDayUtilPresent: true,
    },
  };
}

/** A complete probe walled on the 7d window (real quota exhaustion). */
function exhausted(): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: 5,
      sevenDayUtilizationPct: 100,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      fiveHourUtilPresent: true,
      sevenDayUtilPresent: true,
    },
  };
}

/** The structured entitlement-403 failure `fetchQuota` now produces. */
function entitlement403(): QuotaResult {
  return {
    ok: false,
    reason: "HTTP 403 from Anthropic (no unified rate-limit headers in response (API token, not OAuth?))",
    httpStatus: 403,
    apiErrorMessage: "Your organization has disabled Claude subscription access for Claude Code",
    failureKind: "entitlement_blocked",
  };
}

/**
 * The VERBATIM deactivated / OAuth-disabled-org 403 body, run through the REAL
 * `fetchQuota` classifier (via a stubbed `fetchImpl`) — no hand-authored
 * QuotaResult. This exercises the actual classification + persistence + skip
 * chain from the exact production signature, so it fails RED without the
 * quota.ts fix (the body's prose carries no "disabled"/"claude code", so the
 * legacy matcher misses it → "other" → no mark → account stays selectable).
 */
function deactivatedOrgLiveClassified(): () => Promise<QuotaResult> {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "permission_error",
      message: "OAuth authentication is currently not allowed for this organization.",
      details: { error_code: "oauth_not_allowed_for_organization" },
    },
    request_id: "req_deactivated",
  });
  const fetchImpl = (async () =>
    new Response(body, {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return async () => await fetchQuota({ accessToken: "tok", fetchImpl });
}

/** A non-entitlement 403 (bad token scope) — 403 but NOT a hard block. */
function badScope403(): QuotaResult {
  return {
    ok: false,
    reason: "HTTP 403 from Anthropic (no unified rate-limit headers in response (API token, not OAuth?))",
    httpStatus: 403,
    apiErrorMessage: "This credential is only authorized for use with Claude Code",
    failureKind: "other",
  };
}

/** A per-label fetcher; unmatched labels read healthy. Records call counts. */
function fetcher(
  byLabel: Record<string, () => QuotaResult>,
  calls?: Record<string, number>,
): (opts: FetchQuotaOptions) => Promise<QuotaResult> {
  return async ({ accessToken }: FetchQuotaOptions) => {
    const label = accessToken.replace(/^at-/, "");
    if (calls) calls[label] = (calls[label] ?? 0) + 1;
    const fn = byLabel[label];
    return fn ? fn() : healthy();
  };
}

describe("entitlement-403 — broker persistence + eligibility", () => {
  it("a fleet-tick entitlement-403 marks entitlement_blocked within one tick", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "disabled");
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ disabled: entitlement403 }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    expect(st.quota["disabled"]?.entitlement_blocked).toBe(true);
    expect(typeof st.quota["disabled"]?.entitlement_blocked_at).toBe("number");
    expect(st.quota["disabled"]?.entitlement_blocked_reason).toContain("disabled Claude subscription access");
    // A healthy account carries no mark.
    expect(st.quota["primary"]?.entitlement_blocked).toBeUndefined();
    broker.stop();
  });

  it("a blocked account in fallback_order is NOT the roll target, even ahead of a healthy fallback", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "disabled");
    seedAccount(h, "healthy2");
    // fallback order deliberately lists the DISABLED account BEFORE healthy2, so
    // a working eligibility gate is the only thing that skips it.
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary", "disabled", "healthy2"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ primary: exhausted, disabled: entitlement403, healthy2: () => healthy(1, 2) }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    // The disabled account was marked and the fleet rolled PAST it to healthy2.
    expect(st.quota["disabled"]?.entitlement_blocked).toBe(true);
    expect(st.activeAccount).toBe("healthy2");
    broker.stop();
  });

  it("with the blocked account as the ONLY fallback, the fleet does not roll onto it (stays put)", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "disabled");
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary", "disabled"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ primary: exhausted, disabled: entitlement403 }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    expect(st.quota["disabled"]?.entitlement_blocked).toBe(true);
    // No eligible target (the only fallback is hard-blocked) → active unchanged.
    expect(st.activeAccount).toBe("primary");
    broker.stop();
  });

  it("a later SUCCESSFUL manual probe clears the entitlement_blocked mark", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "disabled");
    let disabledResult = entitlement403;
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ disabled: () => disabledResult() }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    expect(broker._state().quota["disabled"]?.entitlement_blocked).toBe(true);

    // The org re-enabled Code access — the account now probes healthy. An
    // explicit manual re-probe (forceLive bypasses the TTL) clears the mark.
    disabledResult = () => healthy(3, 4);
    const res: any = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "probe-quota", accounts: ["disabled"], forceLive: true,
    });
    expect(res.data.results[0].result.ok).toBe(true);
    expect(broker._state().quota["disabled"]?.entitlement_blocked).toBeUndefined();
    broker.stop();
  });

  it("the VERBATIM deactivated-org 403 body → classified via real fetchQuota → marked blocked → rolled past", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "disabled");
    seedAccount(h, "healthy2");
    const classifyDeactivated = deactivatedOrgLiveClassified();
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary", "disabled", "healthy2"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: async (opts: FetchQuotaOptions) => {
        const label = opts.accessToken.replace(/^at-/, "");
        if (label === "disabled") return await classifyDeactivated();
        if (label === "primary") return exhausted();
        return healthy(1, 2);
      },
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    // The exact production body was classified entitlement_blocked end-to-end:
    // the account is marked (eligibility → blocked) and the fleet rolled past it.
    expect(st.quota["disabled"]?.entitlement_blocked).toBe(true);
    expect(st.quota["disabled"]?.entitlement_blocked_reason).toContain(
      "OAuth authentication is currently not allowed",
    );
    expect(st.activeAccount).toBe("healthy2");
    broker.stop();
  });

  it("a non-entitlement 403 (bad token scope) does NOT set entitlement_blocked", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "badscope");
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ badscope: badScope403 }),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();

    const st = broker._state();
    expect(st.quota["badscope"]?.entitlement_blocked).toBeUndefined();
    broker.stop();
  });

  it("a marked account is SKIPPED by later fleet ticks (no wasted probe)", async () => {
    const h = makeHarness();
    seedAccount(h, "primary");
    seedAccount(h, "disabled");
    const calls: Record<string, number> = {};
    const broker = new AuthBroker(makeConfig(h, "primary", ["primary"]), {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
      _testFetchQuota: fetcher({ disabled: entitlement403 }, calls),
    });
    await broker.start();
    await broker.fleetQuotaProbeTick();
    expect(broker._state().quota["disabled"]?.entitlement_blocked).toBe(true);
    const disabledCallsAfterTick1 = calls["disabled"];
    expect(disabledCallsAfterTick1).toBeGreaterThanOrEqual(1);

    // Second tick: the blocked account must be skipped entirely.
    await broker.fleetQuotaProbeTick();
    expect(calls["disabled"]).toBe(disabledCallsAfterTick1);
    // The healthy active is still probed each tick (sanity: the tick ran).
    expect(calls["primary"]).toBeGreaterThanOrEqual(2);
    broker.stop();
  });
});
