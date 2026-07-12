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
 *  - the escalation guard: 3 hits inside the window trigger ONE live probe;
 *    a probe that corroborates a wall converts to the standard
 *    mark-exhausted + fleet roll (mirror fanout, durable promote, audit
 *    reason "throttle-escalation") — announced by the RAISING gateway from
 *    the response, NOT via `last_fleet_roll` (reactive-path doctrine, which
 *    also covers pinned-account rolls); a healthy probe leaves the account
 *    merely throttled and re-arms the counter;
 *  - the re-mark dedup: a mark within 5s of the previous hit refreshes the
 *    expiry but adds NO hit and can trigger NO probe (probe-flood bound);
 *  - a later mark-exhausted PRESERVES the throttle fields in the entry.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
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
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: q.fiveHour,
      sevenDayUtilizationPct: q.sevenDay,
      fiveHourResetAt: null,
      sevenDayResetAt: q.sevenDay >= 99.5 ? new Date(NOW + 3 * 86_400_000) : null,
      representativeClaim: q.sevenDay >= 99.5 ? "seven_day" : null,
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
  it("a re-mark within 5s refreshes the expiry but adds NO escalation hit", async () => {
    const { b } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 100 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const r1 = await markThrottled(b, NOW + 60_000, "1");
    expect(r1.data.throttled_until).toBe(NOW + 60_000);
    // Simultaneous second agent marks a slightly later reset.
    const r2 = await markThrottled(b, NOW + 90_000, "2");
    expect(r2.data.escalated).toBe(false);
    // Expiry keeps the LATER value; hit count stays 1.
    expect(r2.data.throttled_until).toBe(NOW + 90_000);
    expect(b.quota["alice"].throttle_hits).toEqual([NOW]);
  });

  it("a simultaneous 3-agent burst counts once and cannot trigger the probe", async () => {
    let probes = 0;
    const { b } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 100 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    (b as any).fetchQuotaImpl = async () => {
      probes += 1;
      return { ok: false as const, reason: "should not be probed" };
    };
    await markThrottled(b, NOW + 60_000, "1");
    await markThrottled(b, NOW + 60_000, "2");
    const r3 = await markThrottled(b, NOW + 60_000, "3");
    expect(r3.data.escalated).toBe(false);
    expect(probes).toBe(0);
    expect(b.quota["alice"].throttle_hits).toEqual([NOW]);
  });
});

describe("mark-throttled — escalation guard (3 hits / 10 min)", () => {
  it("escalates to mark-exhausted + fleet roll when the live probe corroborates a wall", async () => {
    const { b, h, clock } = makeBroker({
      accounts: ["alice", "bob"],
      // alice is genuinely weekly-walled — the probe corroborates.
      quotas: { alice: { fiveHour: 10, sevenDay: 100 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    const r1 = await markThrottled(b, NOW + 60_000, "1");
    clock.set(NOW + HIT_SPACING_MS);
    const r2 = await markThrottled(b, NOW + 60_000, "2");
    expect(r1.data.escalated).toBe(false);
    expect(r2.data.escalated).toBe(false);
    expect(mirrorToken(h, "ziggy")).toBe(null); // still no roll after 2 hits

    clock.set(NOW + 2 * HIT_SPACING_MS);
    const r3 = await markThrottled(b, NOW + 60_000 + 2 * HIT_SPACING_MS, "3");
    expect(r3.data.escalated).toBe(true);
    expect(r3.data.rolledTo).toBe("bob");

    // Standard exhaustion mechanics ran: mark with the probe's weekly reset,
    // fleet mirror fanout, durable promote.
    expect(b.quota["alice"].exhausted_until).toBe(NOW + 3 * 86_400_000);
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

    // Counter cleared after the escalation probe.
    expect(b.quota["alice"].throttle_hits).toEqual([]);
  });

  it("does NOT escalate when the live probe shows the account healthy — counter re-arms", async () => {
    const { b, h, clock } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 40, sevenDay: 30 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    await markThrottled(b, NOW + 60_000, "1");
    clock.set(NOW + HIT_SPACING_MS);
    await markThrottled(b, NOW + 60_000, "2");
    clock.set(NOW + 2 * HIT_SPACING_MS);
    const until3 = NOW + 60_000 + 2 * HIT_SPACING_MS;
    const r3 = await markThrottled(b, until3, "3");
    expect(r3.data.escalated).toBe(false);
    expect(r3.data.rolledTo).toBe(null);

    // Still merely throttled: no mark, no roll, counter cleared (one probe
    // per burst, not one per subsequent hit).
    expect(b.quota["alice"].exhausted_until).toBeUndefined();
    expect(b.quota["alice"].throttled_until).toBe(until3);
    expect(b.quota["alice"].throttle_hits).toEqual([]);
    expect(mirrorToken(h, "ziggy")).toBe(null);
    expect(auditRows(h).some((r) => r.op === "mark-exhausted")).toBe(false);
  });

  it("hits OUTSIDE the 10-min window do not count toward escalation", async () => {
    const { b, clock } = makeBroker({
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 100 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    // Two old hits, spaced past the dedup, then aged past the window.
    await markThrottled(b, NOW + 60_000, "1");
    clock.set(NOW + HIT_SPACING_MS);
    await markThrottled(b, NOW + 60_000, "2");
    const late = NOW + 12 * 60_000; // both prior hits now outside the window
    clock.set(late);
    const r3 = await markThrottled(b, late + 60_000, "3");
    expect(r3.data.escalated).toBe(false);
    expect(b.quota["alice"].throttle_hits).toEqual([late]);
  });
});
