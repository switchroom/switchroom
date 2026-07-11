/**
 * Probe acts on the soft-avoid tier (#3031, PR 2/4).
 *
 * Drives `fleetQuotaProbeTick` on a real AuthBroker (tmpdir home/state,
 * `_testFetchQuota` seam, no listeners) and pins:
 *
 *  - a soft-avoided ACTIVE rolls the SERVING preference: agent mirrors get
 *    the fully-eligible fallback's creds, with NO exhaustion mark, NO
 *    durable promote of auth.active, and NO active-override.json;
 *  - NO roll when no strictly-better candidate exists (all serveable
 *    candidates soft-avoided);
 *  - a PINNED agent account (auth.override) fails over the same way —
 *    soft-avoid serving roll AND hard-exhaustion mark + fanout (the
 *    consumerQuotaProbeTick analog);
 *  - hard-wall behavior is byte-identical when proactive_failover_pct is
 *    unset (mark + roll + durable promote still fire; near-wall does nothing);
 *  - no roll ping-pong across probe ticks (enter/exit hysteresis + the
 *    roll memo — exactly ONE audited roll while the preference holds);
 *  - every soft-avoid roll leaves an audit record with reason "soft-avoid",
 *    distinguished from the probe's hard path (reason "hard-exhaustion").
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { QuotaResult } from "../quota.js";

const NOW = 1_800_000_000_000;

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

/** Per-label utilization the fake fetchQuota serves; mutate between ticks. */
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
  active: string;
  fallbackOrder: string[];
  pct?: number;
  accounts: string[];
  agents?: Record<string, { auth?: { override?: string } }>;
  quotas: QuotaTable;
}): { broker: AuthBroker; b: any; h: Harness } {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-softavoid-probe-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir };
  harnesses.push(h);
  for (const label of opts.accounts) seedAccount(home, label);
  const agents = opts.agents ?? { ziggy: {} };
  // Scaffold each agent dir so mirror fanout has somewhere to land.
  for (const name of Object.keys(agents)) {
    mkdirSync(join(agentsDir, name), { recursive: true });
  }
  const config = {
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: {},
    agents,
    auth: {
      active: opts.active,
      fallback_order: opts.fallbackOrder,
      proactive_failover_pct: opts.pct,
    },
  } as unknown as SwitchroomConfig;
  const broker = new AuthBroker(config, {
    home,
    stateDir,
    now: () => NOW,
    disableRefreshLoop: true,
    skipHealthyMarker: true,
    _testFetchQuota: async ({ accessToken }) => quotaFor(opts.quotas, accessToken),
  });
  return { broker, b: broker as any, h };
}

function mirrorToken(h: Harness, agent: string): string | null {
  const p = join(h.agentsDir, agent, ".claude", ".credentials.json");
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, "utf-8"));
  return parsed.claudeAiOauth?.accessToken ?? null;
}

function auditRows(h: Harness): Array<{ op: string; account?: string; reason?: string }> {
  const p = join(h.stateDir, "audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("fleetQuotaProbeTick — soft-avoid serving roll for the ACTIVE (pct=95)", () => {
  it("rolls agent mirrors to the eligible fallback: no mark, no promote, audited as soft-avoid", async () => {
    const { broker, b, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 96 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    await broker.fleetQuotaProbeTick();
    // SERVING preference rolled: ziggy's mirror carries bob's creds…
    expect(mirrorToken(h, "ziggy")).toBe("at-bob");
    // …but NOTHING durable moved: no exhaustion mark, active untouched,
    // no active-override.json (yaml-drift semantics preserved).
    expect(b.quota["alice"]).toBeUndefined();
    expect(b.config.auth?.active).toBe("alice");
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(false);
    // Audit record: same shape as probe rolls, reason distinguishes trigger.
    const rolls = auditRows(h).filter((r) => r.op === "proactive-roll");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ account: "alice", reason: "soft-avoid" });
    expect(auditRows(h).some((r) => r.op === "mark-exhausted")).toBe(false);
    // last_fleet_roll rides PR-3's announcement channel: same record shape
    // as the hard path, reason distinguishing the trigger. Persisted.
    expect(b.lastFleetRoll).toMatchObject({
      from: "alice",
      to: "bob",
      at: NOW,
      reason: "soft-avoid",
      window: "7d",
      pct: 96,
    });
    expect(b.lastFleetRoll.exhausted_until).toBeUndefined();
    expect(existsSync(join(h.stateDir, "last-fleet-roll.json"))).toBe(true);
  });

  it("does NOT roll when no strictly-better candidate exists (all soft-avoided)", async () => {
    const { broker, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 96 }, bob: { fiveHour: 10, sevenDay: 97 } },
    });
    await broker.fleetQuotaProbeTick();
    expect(mirrorToken(h, "ziggy")).toBe(null); // no push at all
    expect(auditRows(h).filter((r) => r.op === "proactive-roll")).toHaveLength(0);
    expect(existsSync(join(h.stateDir, "last-fleet-roll.json"))).toBe(false);
  });

  it("no ping-pong across ticks: one audited roll while the hysteresis latch holds", async () => {
    const quotas: QuotaTable = {
      alice: { fiveHour: 10, sevenDay: 96 },
      bob: { fiveHour: 5, sevenDay: 10 },
    };
    const { broker, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
      quotas,
    });
    await broker.fleetQuotaProbeTick();
    expect(mirrorToken(h, "ziggy")).toBe("at-bob");
    // Tick 2: alice dips into the hysteresis band (94 ≥ pct-5) — the latch
    // holds, the preference is unchanged, and the memo dedupes the roll:
    // no second audit record, mirror stays on bob (no roll back to alice).
    quotas.alice = { fiveHour: 10, sevenDay: 94 };
    await broker.fleetQuotaProbeTick();
    expect(mirrorToken(h, "ziggy")).toBe("at-bob");
    expect(auditRows(h).filter((r) => r.op === "proactive-roll")).toHaveLength(1);
    // Tick 3: alice drops clearly below pct-5 → tier releases. The serving
    // path reverts on the next credential read; the probe must not audit
    // any further roll.
    quotas.alice = { fiveHour: 10, sevenDay: 80 };
    await broker.fleetQuotaProbeTick();
    expect(auditRows(h).filter((r) => r.op === "proactive-roll")).toHaveLength(1);
  });

  it("re-rolls (new audit) only when the preference genuinely changes again", async () => {
    const quotas: QuotaTable = {
      alice: { fiveHour: 10, sevenDay: 96 },
      bob: { fiveHour: 5, sevenDay: 10 },
    };
    const { broker, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
      quotas,
    });
    await broker.fleetQuotaProbeTick(); // roll #1 → bob
    // alice releases (80), then later re-enters the tier (97): a NEW roll.
    quotas.alice = { fiveHour: 10, sevenDay: 80 };
    await broker.fleetQuotaProbeTick();
    quotas.alice = { fiveHour: 10, sevenDay: 97 };
    await broker.fleetQuotaProbeTick(); // roll #2 → bob again
    expect(auditRows(h).filter((r) => r.op === "proactive-roll")).toHaveLength(2);
  });
});

describe("fleetQuotaProbeTick — PINNED agent accounts (auth.override)", () => {
  it("a soft-avoided pin rolls the pinned agent's mirror to an eligible fallback", async () => {
    const { broker, b, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "pin"],
      pct: 95,
      accounts: ["alice", "bob", "pin"],
      agents: { ziggy: {}, pinner: { auth: { override: "pin" } } },
      quotas: {
        alice: { fiveHour: 5, sevenDay: 10 },
        bob: { fiveHour: 5, sevenDay: 12 },
        pin: { fiveHour: 10, sevenDay: 97 },
      },
    });
    await broker.fleetQuotaProbeTick();
    // The pinned agent fails over (pin is a PRIMARY, not a hard pin)…
    expect(mirrorToken(h, "pinner")).toBe("at-alice");
    // …the fleet-active rider is untouched by the pin's roll…
    expect(mirrorToken(h, "ziggy")).toBe(null);
    // …and nothing durable moved: no mark, attribution stays on the pin.
    expect(b.quota["pin"]).toBeUndefined();
    expect(b.callerAccount({ kind: "agent", name: "pinner", admin: false })).toBe("pin");
    const rolls = auditRows(h).filter((r) => r.op === "proactive-roll");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ account: "pin", reason: "soft-avoid" });
    // A pinned-only roll is not a FLEET roll — it must not claim the
    // last_fleet_roll announcement slot.
    expect(b.lastFleetRoll).toBe(null);
  });

  it("a hard-walled pin is marked + fanned out (consumer-sensor analog), active NOT promoted", async () => {
    const { broker, b, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "pin"],
      pct: 95,
      accounts: ["alice", "bob", "pin"],
      agents: { pinner: { auth: { override: "pin" } } },
      quotas: {
        alice: { fiveHour: 5, sevenDay: 10 },
        bob: { fiveHour: 5, sevenDay: 12 },
        pin: { fiveHour: 3, sevenDay: 100 },
      },
    });
    await broker.fleetQuotaProbeTick();
    // Marked exhausted (durable) and the pinned agent got failover creds.
    expect(b.quota["pin"]?.exhausted_until).toBeGreaterThan(NOW);
    expect(mirrorToken(h, "pinner")).toBe("at-alice");
    // The fleet active is NOT promoted off by a pinned-only wall.
    expect(b.config.auth?.active).toBe("alice");
    expect(existsSync(join(h.stateDir, "active-override.json"))).toBe(false);
    const marks = auditRows(h).filter((r) => r.op === "mark-exhausted");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ account: "pin", reason: "hard-exhaustion" });
  });
});

describe("fleetQuotaProbeTick — proactive_failover_pct unset (no behavior change)", () => {
  it("a near-wall (96%) active is left completely alone", async () => {
    const { broker, b, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 96 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    await broker.fleetQuotaProbeTick();
    expect(mirrorToken(h, "ziggy")).toBe(null);
    expect(b.quota["alice"]).toBeUndefined();
    expect(b.config.auth?.active).toBe("alice");
    expect(auditRows(h).filter((r) => r.op === "proactive-roll")).toHaveLength(0);
    expect(Object.keys(b.softAvoidState)).toHaveLength(0);
  });

  it("hard-wall path unchanged: mark + roll + durable promote still fire", async () => {
    const { broker, b, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 3, sevenDay: 100 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    await broker.fleetQuotaProbeTick();
    expect(b.quota["alice"]?.exhausted_until).toBeGreaterThan(NOW);
    expect(mirrorToken(h, "ziggy")).toBe("at-bob");
    // Durable promote (live-corroborated wall) — the pre-PR-2 semantics.
    expect(b.config.auth?.active).toBe("bob");
    const marks = auditRows(h).filter((r) => r.op === "mark-exhausted");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ account: "alice", reason: "hard-exhaustion" });
    expect(auditRows(h).some((r) => r.op === "auto-promote-active")).toBe(true);
    expect(auditRows(h).filter((r) => r.op === "proactive-roll")).toHaveLength(0);
    // The hard fleet roll claims the announcement slot with its own reason.
    expect(b.lastFleetRoll).toMatchObject({
      from: "alice",
      to: "bob",
      reason: "hard-exhaustion",
      window: "7d",
      pct: 100,
    });
    expect(b.lastFleetRoll.exhausted_until).toBeGreaterThan(NOW);
  });
});
