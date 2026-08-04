/**
 * mark-throttled — the 429 throttle tier's broker verb.
 *
 * Drives `opMarkThrottled` on a real AuthBroker (tmpdir home/state,
 * `_testFetchQuota` seam, fake socket — no listeners) and pins the
 * OUTCOMES the tier promises:
 *
 *  - the ledger round-trip: `throttled_until` recorded + persisted to
 *    quota.json, response carries {account, throttled_until, escalated};
 *  - NO roll and NO ineligibility: agent mirrors untouched, `auth.active`
 *    untouched, the account still reads eligible / not exhausted;
 *  - the clamp: a bogus long throttle is bounded to the short ceiling;
 *  - first-hit corroboration (#failover-429-corroborate): a SINGLE mark runs
 *    ONE live probe; a probe that corroborates a wall converts to the standard
 *    mark-exhausted + fleet roll (mirror fanout, durable promote, audit
 *    reason "throttle-escalation", hit window cleared) — announced by the
 *    RAISING gateway from the response, NOT via `last_fleet_roll`
 *    (reactive-path doctrine, which also covers pinned-account rolls); a
 *    healthy probe leaves the account merely throttled with the hit window
 *    CARRIED FORWARD (not cleared);
 *  - the probe rate-bound: after a probe, a second hit >5s later but WITHIN
 *    THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS runs NO second probe; a hit past
 *    that interval probes again (≤1 probe/min/account);
 *  - the re-mark dedup: a mark within 5s of the previous hit refreshes the
 *    expiry but adds NO hit and can trigger NO probe (probe-flood bound);
 *  - a later mark-exhausted PRESERVES the throttle fields in the entry.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker, THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS } from "./server.js";
import type { Identity } from "./peercred.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { QuotaResult } from "../quota.js";

const NOW = 1_800_000_000_000;
/** Comfortably past the 5s re-mark dedup, well inside the 10-min window. */
const HIT_SPACING_MS = 30_000;
const AGENT: Identity = { kind: "agent", name: "ziggy", admin: false };

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
}

let harnesses: Harness[] = [];

afterEach(() => {
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function seedAccount(home: string, label: string): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: "at-" + label,
        refreshToken: "rt-" + label,
        expiresAt: NOW + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    home,
  );
}

type QuotaTable = Record<string, { fiveHour: number; sevenDay: number }>;

function quotaFor(table: QuotaTable, accessToken: string): QuotaResult {
  const label = accessToken.replace(/^at-/, "");
  const q = table[label];
  if (!q) return { ok: false, reason: "no fixture for " + label };
  const fiveWalled = q.fiveHour >= 99.5;
  const sevenWalled = q.sevenDay >= 99.5;
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: q.fiveHour,
      sevenDayUtilizationPct: q.sevenDay,
      // A walled 5h window resets in 3h; a walled 7d window in 3d — so a test
      // can assert the mark took the maxed window's real reset.
      fiveHourResetAt: fiveWalled ? new Date(NOW + 3 * 3_600_000) : null,
      sevenDayResetAt: sevenWalled ? new Date(NOW + 3 * 86_400_000) : null,
      representativeClaim: sevenWalled ? "seven_day" : fiveWalled ? "five_hour" : null,
      overageStatus: null,
      overageDisabledReason: null,
    },
  };
}

/** A minimal always-healthy probe result — for tests that only want to COUNT
 *  probe calls (spy on `fetchQuotaImpl`) without threading the quota table.
 *  Healthy so the first-hit corroboration stays put (no escalation). */
function healthyProbe(): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: 10,
      sevenDayUtilizationPct: 20,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
    },
  };
}

function makeBroker(opts: {
  accounts: string[];
  quotas: QuotaTable;
}): { broker: AuthBroker; b: any; h: Harness; clock: { set(ms: number): void } } {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-mark-throttled-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(agentsDir, "ziggy"), { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir };
  harnesses.push(h);
  for (const label of opts.accounts) seedAccount(home, label);
  const config = {
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: {},
    agents: { ziggy: {} },
    auth: { active: "alice", fallback_order: ["alice", "bob"] },
  } as unknown as SwitchroomConfig;
  let nowMs = NOW;
  const broker = new AuthBroker(config, {
    home,
    stateDir,
    now: () => nowMs,
    disableRefreshLoop: true,
    skipHealthyMarker: true,
    _testFetchQuota: async ({ accessToken }) => quotaFor(opts.quotas, accessToken),
  });
  return { broker, b: broker as any, h, clock: { set: (ms) => { nowMs = ms; } } };
}

/** Drive an op handler with a captured fake socket; parse the one response. */
async function markThrottled(
  b: any,
  until: number,
  id = "1",
): Promise<{ ok: boolean; data?: any; error?: any }> {
  const frames: string[] = [];
  const socket = { write: (s: string) => frames.push(s) };
  await b.opMarkThrottled(socket, id, AGENT, until);
  expect(frames).toHaveLength(1);
  return JSON.parse(frames[0]);
}

async function listState(b: any): Promise<any> {
  const frames: string[] = [];
  const socket = { write: (s: string) => frames.push(s) };
  await b.opListState(socket, "ls", AGENT);
  return JSON.parse(frames[0]).data;
}

function auditRows(h: Harness): Array<{ op: string; account?: string; reason?: string }> {
  const p = join(h.stateDir, "audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function mirrorToken(h: Harness, agent: string): string | null {
  const p = join(h.agentsDir, agent, ".claude", ".credentials.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")).claudeAiOauth?.accessToken ?? null;
}

describe("mark-throttled — ledger round-trip, no roll, no ineligibility", () => {
  it("records throttled_until, persists it, and does NOT roll or block the account", async () => {
    const { b, h } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const until = NOW + 90_000;
    const resp = await markThrottled(b, until);
    expect(resp.ok).toBe(true);
    expect(resp.data).toMatchObject({
      account: "alice",
      throttled_until: until,
      escalated: false,
      rolledTo: null,
    });

    // Ledger: throttle recorded WITHOUT an exhaustion mark, and persisted.
    expect(b.quota["alice"]).toMatchObject({ throttled_until: until });
    expect(b.quota["alice"].exhausted_until).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(h.stateDir, "quota.json"), "utf-8"));
    expect(onDisk["alice"]).toMatchObject({ throttled_until: until });

    // NO roll: no mirror fanout, active untouched, no override persisted.
    expect(mirrorToken(h, "ziggy")).toBe(null);
    expect(b.config.auth?.active).toBe("alice");
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(false);

    // NO ineligibility: the account still serves and reads healthy.
    expect(b.isAccountExhausted("alice")).toBe(false);
    const state = await listState(b);
    const alice = state.accounts.find((a: any) => a.label === "alice");
    expect(alice.exhausted).toBe(false);
    expect(alice.throttled_until).toBe(until);

    // Audited under its own op name; no mark-exhausted row.
    expect(auditRows(h).some((r) => r.op === "mark-throttled" && r.account === "alice")).toBe(true);
    expect(auditRows(h).some((r) => r.op === "mark-exhausted")).toBe(false);
  });

  it("clamps a bogus long throttle to the short ceiling (30 min)", async () => {
    const { b } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const resp = await markThrottled(b, NOW + 7 * 24 * 60 * 60 * 1000);
    expect(resp.data.throttled_until).toBe(NOW + 30 * 60 * 1000);
  });

  it("a later mark-exhausted PRESERVES the throttle fields in the same entry", async () => {
    const { b } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const until = NOW + 90_000;
    await markThrottled(b, until);
    await b.markExhaustedAndRoll("alice", NOW + 60 * 60 * 1000, AGENT);
    expect(b.quota["alice"]).toMatchObject({
      throttled_until: until,
      exhausted_until: NOW + 60 * 60 * 1000,
      marked_at: NOW,
    });
  });
});

describe("mark-throttled — re-mark dedup (probe-flood bound)", () => {
  it("a re-mark within 5s refreshes the expiry, adds NO hit, and runs NO extra probe", async () => {
    let probes = 0;
    const { b } = makeBroker({
      accounts: ["alice", "bob"],
      // Healthy account: the first-hit probe stays put, so this isolates the
      // 5s dedup from escalation.
      quotas: { alice: { fiveHour: 10, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    (b as any).fetchQuotaImpl = async () => {
      probes += 1;
      return healthyProbe();
    };
    const r1 = await markThrottled(b, NOW + 60_000, "1");
    expect(r1.data.throttled_until).toBe(NOW + 60_000);
    // First hit corroborates (healthy → stay put): exactly one probe.
    expect(probes).toBe(1);
    // Simultaneous second agent marks a slightly later reset, within 5s.
    const r2 = await markThrottled(b, NOW + 90_000, "2");
    expect(r2.data.escalated).toBe(false);
    // Expiry keeps the LATER value; hit count stays 1; NO second probe.
    expect(r2.data.throttled_until).toBe(NOW + 90_000);
    expect(b.quota["alice"].throttle_hits).toEqual([NOW]);
    expect(probes).toBe(1);
  });

  it("a simultaneous 3-agent burst shares ONE hit and ONE probe (the first)", async () => {
    let probes = 0;
    const { b } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    (b as any).fetchQuotaImpl = async () => {
      probes += 1;
      return healthyProbe();
    };
    await markThrottled(b, NOW + 60_000, "1");
    await markThrottled(b, NOW + 60_000, "2");
    const r3 = await markThrottled(b, NOW + 60_000, "3");
    expect(r3.data.escalated).toBe(false);
    // The first hit probes; the 2nd/3rd land within 5s and dedup — one probe,
    // one recorded hit, for the whole burst.
    expect(probes).toBe(1);
    expect(b.quota["alice"].throttle_hits).toEqual([NOW]);
  });
});

describe("mark-throttled — first-hit corroboration + probe rate-bound", () => {
  it("escalates on a SINGLE hit when the live probe corroborates a wall", async () => {
    const { b, h } = makeBroker({
      accounts: ["alice", "bob"],
      // alice is genuinely 5h-walled — the FIRST-hit probe corroborates it,
      // no 3-hit staging required.
      quotas: { alice: { fiveHour: 100, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const r1 = await markThrottled(b, NOW + 60_000, "1");
    expect(r1.data.escalated).toBe(true);
    expect(r1.data.rolledTo).toBe("bob");

    // Standard exhaustion mechanics ran off the probe's 5h reset (NOW + 3h):
    // mark, fleet mirror fanout, durable promote.
    expect(b.quota["alice"].exhausted_until).toBe(NOW + 3 * 3_600_000);
    expect(mirrorToken(h, "ziggy")).toBe("at-bob");
    expect(b.config.auth?.active).toBe("bob");
    expect(b.isAccountExhausted("alice")).toBe(true);

    // Escalation is attributed in the audit.
    expect(
      auditRows(h).some(
        (r) => r.op === "mark-exhausted" && r.reason === "throttle-escalation",
      ),
    ).toBe(true);

    // Reactive-path doctrine: NO last_fleet_roll record — the RAISING gateway
    // announces from this op's response ({escalated, rolledTo}), which also
    // covers pinned (non-fleet-active) rolls the fleet channel would skip.
    expect(b.lastFleetRoll).toBe(null);

    // Hit window cleared after the corroborated escalation.
    expect(b.quota["alice"].throttle_hits).toEqual([]);
  });

  it("a healthy first-hit probe stays throttled and CARRIES the hit window forward", async () => {
    const { b, h } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 40, sevenDay: 30 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const until = NOW + 60_000;
    const r1 = await markThrottled(b, until, "1");
    expect(r1.data.escalated).toBe(false);
    expect(r1.data.rolledTo).toBe(null);

    // Still merely throttled: throttle recorded, no exhaustion mark, no roll.
    expect(b.quota["alice"].throttled_until).toBe(until);
    expect(b.quota["alice"].exhausted_until).toBeUndefined();
    expect(mirrorToken(h, "ziggy")).toBe(null);
    expect(b.config.auth?.active).toBe("alice");
    expect(b.isAccountExhausted("alice")).toBe(false);
    expect(auditRows(h).some((r) => r.op === "mark-exhausted")).toBe(false);

    // The pruned window is CARRIED FORWARD (not cleared) — a healthy probe does
    // not reset the observability ledger. This is the core NEW-model contrast
    // with an escalation, which clears it to [].
    expect(b.quota["alice"].throttle_hits).toEqual([NOW]);
  });

  it("rate-bounds the probe to at most one per THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS", async () => {
    let probes = 0;
    const { b, clock } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 40, sevenDay: 30 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    (b as any).fetchQuotaImpl = async () => {
      probes += 1;
      return healthyProbe();
    };

    // First hit probes.
    await markThrottled(b, NOW + 60_000, "1");
    expect(probes).toBe(1);

    // Second hit >5s later (clears the re-mark dedup) but WITHIN the rate-bound
    // interval of the last probe → NO second probe; account stays throttled.
    const t2 = NOW + HIT_SPACING_MS; // +30s: past the 5s dedup, inside 60s
    clock.set(t2);
    const r2 = await markThrottled(b, t2 + 60_000, "2");
    expect(probes).toBe(1);
    expect(r2.data.escalated).toBe(false);
    expect(b.quota["alice"].throttled_until).toBe(t2 + 60_000);

    // Advance PAST the rate-bound interval → the next hit probes again.
    const t3 = NOW + THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS + 1;
    clock.set(t3);
    await markThrottled(b, t3 + 60_000, "3");
    expect(probes).toBe(2);
  });

  it("prunes hits aged past the 10-min window from the observability ledger", async () => {
    const { b, clock } = makeBroker({
      accounts: ["alice", "bob"],
      // Healthy — no escalation; this test is about window pruning only.
      quotas: { alice: { fiveHour: 10, sevenDay: 20 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    // Two hits, spaced past the dedup, then a third after both age out.
    await markThrottled(b, NOW + 60_000, "1");
    clock.set(NOW + HIT_SPACING_MS);
    await markThrottled(b, NOW + 60_000, "2");
    const late = NOW + 12 * 60_000; // both prior hits now outside the 10-min window
    clock.set(late);
    const r3 = await markThrottled(b, late + 60_000, "3");
    expect(r3.data.escalated).toBe(false);
    // The window is pruned to just the fresh hit — THROTTLE_ESCALATION_HITS /
    // _WINDOW are bookkeeping now, they no longer gate escalation.
    expect(b.quota["alice"].throttle_hits).toEqual([late]);
  });
});
