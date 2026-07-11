/**
 * Soft-avoid tier (#3031, PR 1/4) — broker serving-path preference tests.
 *
 * Exercises the private selection paths (`accountWithFailover`,
 * `nextHealthyAccount`, `isAccountSoftAvoided`, `callerAccount`) on a real
 * AuthBroker with a tmpdir home/state (never touches `~/.switchroom`),
 * seeding the quota cache directly. Pins:
 *
 *  - config-unset ⇒ selection identical to pre-#3031 (near-wall snapshots
 *    are ignored by the preference layer);
 *  - a soft-avoided pin/active prefers the first fully-eligible
 *    fallback_order candidate;
 *  - when ALL candidates are soft-avoided: serve the least-utilized, never
 *    null (no availability loss, no roll);
 *  - hard-exhausted account still fails over to a soft-avoided fallback
 *    (preference never blocks);
 *  - the auth.active last-resort escape for exhausted pins is preserved;
 *  - attribution (`callerAccount`) NEVER follows the preference — the
 *    anti-cascade invariant;
 *  - overage-lifted accounts are never soft-avoided;
 *  - hysteresis holds across oscillating probe ticks.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";

const NOW = 1_800_000_000_000;

interface Harness {
  tmp: string;
  home: string;
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

function makeBroker(opts: {
  active: string;
  fallbackOrder?: string[];
  pct?: number;
  allowOverage?: string[];
  accounts: string[];
  consumers?: Array<{ name: string; account?: string }>;
  pinnedAgentOverride?: string;
}): { broker: AuthBroker; b: any; home: string } {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-softavoid-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  mkdirSync(agentsDir, { recursive: true });
  harnesses.push({ tmp, home });
  for (const label of opts.accounts) seedAccount(home, label);
  const agents: Record<string, object> = { ziggy: {} };
  if (opts.pinnedAgentOverride) {
    agents["pinner"] = { auth: { override: opts.pinnedAgentOverride } };
  }
  const config = {
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: {},
    agents,
    auth: {
      active: opts.active,
      fallback_order: opts.fallbackOrder,
      proactive_failover_pct: opts.pct,
      allow_overage_accounts: opts.allowOverage,
      consumers: opts.consumers,
    },
  } as unknown as SwitchroomConfig;
  // The broker mkdirs its stateDir in start(); these tests exercise private
  // selection paths without starting listeners, so create it here (the
  // rm/re-add ops persist their indexes into it).
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  mkdirSync(stateDir, { recursive: true });
  const broker = new AuthBroker(config, {
    home,
    stateDir,
    now: () => NOW,
    disableRefreshLoop: true,
    skipHealthyMarker: true,
  });
  return { broker, b: broker as any, home };
}

/** Seed a fresh quota-cache snapshot for `label`. */
function seedSnap(
  b: any,
  label: string,
  fiveHour: number,
  sevenDay: number,
  extra: Record<string, unknown> = {},
): void {
  b.lastQuotaCache[label] = {
    fiveHourUtilizationPct: fiveHour,
    sevenDayUtilizationPct: sevenDay,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
    capturedAt: NOW - 60_000,
    fiveHourUtilPresent: true,
    sevenDayUtilPresent: true,
    ...extra,
  };
}

describe("config unset — byte-identical selection to today", () => {
  it("a near-wall (96%) active is served untouched and never soft-avoided", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 10, 96);
    seedSnap(b, "bob", 0, 0);
    expect(b.isAccountSoftAvoided("alice")).toBe(false);
    expect(b.accountWithFailover("alice")).toBe("alice");
    expect(b.nextHealthyAccount("alice", ["alice", "bob"])).toBe("bob");
    // No hysteresis state is even recorded when the knob is off.
    expect(Object.keys(b.softAvoidState)).toHaveLength(0);
  });

  it("hard-wall failover still works exactly as before", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 100, 100); // walled ≥ 99.5
    seedSnap(b, "bob", 0, 0);
    expect(b.accountWithFailover("alice")).toBe("bob");
  });
});

describe("soft-avoid serving preference (pct=95)", () => {
  it("a soft-avoided account prefers the first fully-eligible fallback", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "carol"],
      pct: 95,
      accounts: ["alice", "bob", "carol"],
    });
    seedSnap(b, "alice", 10, 96); // soft-avoid (7d ≥ 95)
    seedSnap(b, "bob", 20, 30); // fully eligible
    seedSnap(b, "carol", 0, 0);
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    expect(b.accountWithFailover("alice")).toBe("bob");
  });

  it("5h window at min(pct+3,98) also triggers the preference", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 98, 10);
    seedSnap(b, "bob", 20, 30);
    expect(b.accountWithFailover("alice")).toBe("bob");
  });

  it("pinned account soft-avoided → serving prefers fallback_order (agent pin path)", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "pin"],
      pct: 95,
      accounts: ["alice", "bob", "pin"],
      pinnedAgentOverride: "pin",
    });
    seedSnap(b, "pin", 10, 97); // the pin is soft-avoided
    seedSnap(b, "alice", 10, 10);
    seedSnap(b, "bob", 10, 10);
    // Serving for the pinned account walks fallback_order (skipping itself).
    expect(b.accountWithFailover("pin")).toBe("alice");
    // Attribution NEVER follows the preference — anti-cascade invariant.
    expect(b.callerAccount({ kind: "agent", name: "pinner", admin: false })).toBe("pin");
  });

  it("all candidates soft-avoided → serve the least-utilized, never null, no roll", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "carol"],
      pct: 95,
      accounts: ["alice", "bob", "carol"],
    });
    seedSnap(b, "alice", 10, 97); // worst window 97
    seedSnap(b, "bob", 10, 95.5); // worst window 95.5 ← least utilized
    seedSnap(b, "carol", 98.5, 40); // worst window 98.5
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    expect(b.isAccountSoftAvoided("bob")).toBe(true);
    expect(b.isAccountSoftAvoided("carol")).toBe(true);
    expect(b.accountWithFailover("alice")).toBe("bob");
  });

  it("all-soft-avoid where the account itself is least utilized → stays put", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 10, 95.1);
    seedSnap(b, "bob", 10, 98);
    expect(b.accountWithFailover("alice")).toBe("alice");
  });

  it("hard-exhausted account still fails over to a soft-avoided fallback (never blocks)", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 100, 100); // hard wall
    seedSnap(b, "bob", 10, 96); // soft-avoided but serveable
    expect(b.accountWithFailover("alice")).toBe("bob");
  });

  it("exhausted pin with soft-avoided fallbacks still reaches the auth.active escape", () => {
    // active NOT in fallback_order — the 2026-06-19 escape hatch shape.
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["pin", "bob"],
      pct: 95,
      accounts: ["alice", "bob", "pin"],
    });
    seedSnap(b, "pin", 100, 100); // exhausted pin
    seedSnap(b, "bob", 100, 100); // exhausted fallback
    seedSnap(b, "alice", 10, 10); // healthy active
    expect(b.accountWithFailover("pin")).toBe("alice");
  });
});

describe("nextHealthyAccount preference ranking", () => {
  it("skips a soft-avoided candidate when a fully-eligible one exists later in the ring", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "carol"],
      pct: 95,
      accounts: ["alice", "bob", "carol"],
    });
    seedSnap(b, "bob", 10, 96); // next in ring, but soft-avoided
    seedSnap(b, "carol", 10, 10); // fully eligible
    expect(b.nextHealthyAccount("alice", ["alice", "bob", "carol"])).toBe("carol");
  });

  it("all healthy candidates soft-avoided → returns the least-utilized (never null)", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "carol"],
      pct: 95,
      accounts: ["alice", "bob", "carol"],
    });
    seedSnap(b, "alice", 10, 97); // current wraps in as the last ring candidate
    seedSnap(b, "bob", 10, 98);
    seedSnap(b, "carol", 10, 95.2);
    expect(b.nextHealthyAccount("alice", ["alice", "bob", "carol"])).toBe("carol");
  });

  it("config unset → first non-exhausted candidate wins regardless of utilization", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob", "carol"],
      accounts: ["alice", "bob", "carol"],
    });
    seedSnap(b, "bob", 10, 98); // near-wall but NOT walled → still first pick
    seedSnap(b, "carol", 0, 0);
    expect(b.nextHealthyAccount("alice", ["alice", "bob", "carol"])).toBe("bob");
  });
});

describe("overage exemption", () => {
  it("an overage-lifted account is never soft-avoided even past pct", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      allowOverage: ["alice"],
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 10, 97, { overageStatus: "allowed" });
    seedSnap(b, "bob", 0, 0);
    expect(b.isAccountSoftAvoided("alice")).toBe(false);
    expect(b.accountWithFailover("alice")).toBe("alice");
  });

  it("out_of_credits kills the exemption (overage no longer lifts)", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      allowOverage: ["alice"],
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "alice", 10, 97, {
      overageStatus: "allowed",
      overageDisabledReason: "out_of_credits",
    });
    seedSnap(b, "bob", 0, 0);
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    expect(b.accountWithFailover("alice")).toBe("bob");
  });
});

describe("stale-snapshot latched accounts in the tie-break", () => {
  it("a latched-then-stale account LOSES the all-soft-avoid tie-break to a fresh one", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    // alice latches on fresh evidence…
    seedSnap(b, "alice", 10, 96);
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    // …then her snapshot goes stale (>24h) — the latch carries (no fresh
    // evidence to flip it) but her util score must now be WORST, not best.
    seedSnap(b, "alice", 10, 96, { capturedAt: NOW - 25 * 3_600_000 });
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    // bob is freshly measured and soft-avoided at 97.
    seedSnap(b, "bob", 10, 97);
    expect(b.isAccountSoftAvoided("bob")).toBe(true);
    // All-soft-avoid tie-break: freshly-measured bob (97) must beat
    // stale-latched alice (unknown headroom), in BOTH selectors.
    expect(b.accountWithFailover("alice")).toBe("bob");
    expect(b.nextHealthyAccount("alice", ["alice", "bob"])).toBe("bob");
  });

  it("all soft-avoided candidates stale → still never null (first candidate wins)", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    for (const label of ["alice", "bob"]) {
      seedSnap(b, label, 10, 96);
      expect(b.isAccountSoftAvoided(label)).toBe(true);
      seedSnap(b, label, 10, 96, { capturedAt: NOW - 25 * 3_600_000 });
    }
    expect(b.nextHealthyAccount("alice", ["alice", "bob"])).toBe("bob");
    expect(b.accountWithFailover("alice")).toBe("alice");
  });
});

describe("soft-avoid state lifecycle (rm / re-add)", () => {
  const operator = { kind: "operator" } as const;
  const fakeSocket = () => ({ write: () => true }) as any;

  it("rm-account prunes the label's soft-avoid hysteresis state", async () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "bob", 10, 96);
    expect(b.isAccountSoftAvoided("bob")).toBe(true);
    expect(b.softAvoidState["bob"]).toBeDefined();
    await b.opRmAccount(fakeSocket(), "req-1", operator, "bob");
    expect(b.softAvoidState["bob"]).toBeUndefined();
  });

  it("re-adding a label starts with a fresh latch (no ghost soft-avoid)", async () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "bob", 10, 96);
    expect(b.isAccountSoftAvoided("bob")).toBe(true);
    await b.opAddAccount(
      fakeSocket(),
      "req-2",
      operator,
      "bob",
      {
        claudeAiOauth: {
          accessToken: "at-" + "bob2",
          refreshToken: "rt-" + "bob2",
          expiresAt: NOW + 24 * 60 * 60 * 1000,
          scopes: ["user:inference"],
          subscriptionType: "max",
        },
      },
      true, // replace
    );
    expect(b.softAvoidState["bob"]).toBeUndefined();
    // With the stale latch gone and no fresh over-threshold snapshot for the
    // new credentials, the label is not soft-avoided until re-measured hot.
    delete b.lastQuotaCache["bob"];
    expect(b.isAccountSoftAvoided("bob")).toBe(false);
  });
});

describe("accountWithFailover edge cases", () => {
  it("empty-string account returns null (deliberate change from returning '')", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice"],
      accounts: ["alice"],
    });
    expect(b.accountWithFailover("")).toBe(null);
    expect(b.accountWithFailover(null)).toBe(null);
    expect(b.accountWithFailover(undefined)).toBe(null);
  });
});

describe("live-wins interplay with exhaustion marks (most-recent-signal-wins)", () => {
  it("unexpired mark + FRESHER 95% snapshot → eligible AND soft-avoided simultaneously", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    // Mark says exhausted until tomorrow, written 2h ago…
    b.quota["alice"] = { exhausted_until: NOW + 24 * 3_600_000, marked_at: NOW - 2 * 3_600_000 };
    // …but a FRESHER live probe (60s ago) shows 95% — below the wall.
    seedSnap(b, "alice", 10, 95);
    seedSnap(b, "bob", 10, 10);
    // Live wins: not blocked (eligible to serve)…
    expect(b.isAccountExhausted("alice")).toBe(false);
    expect(b.accountEligibilityOf("alice")).toBe("eligible");
    // …AND simultaneously in the soft-avoid preference tier (95 ≥ pct).
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    // Net effect: serveable but out-ranked by the fully-eligible fallback.
    expect(b.accountWithFailover("alice")).toBe("bob");
  });
});

describe("7d latch vs advancing 5h reset epoch (server-level)", () => {
  it("holds a 7d-driven latch across a real fiveHourResetAt roll", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "bob", 0, 0);
    // Enter on 7d=96 with real ISO reset stamps on both windows.
    seedSnap(b, "alice", 10, 96, {
      fiveHourResetAt: new Date(NOW + 3_600_000).toISOString(),
      sevenDayResetAt: new Date(NOW + 86_400_000).toISOString(),
    });
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    // Next probe: 7d dips into the hysteresis band (93) and the 5h reset
    // epoch ADVANCED (the 5h window rolled). The 7d-driven latch must hold.
    seedSnap(b, "alice", 10, 93, {
      fiveHourResetAt: new Date(NOW + 5 * 3_600_000).toISOString(),
      sevenDayResetAt: new Date(NOW + 86_400_000).toISOString(),
    });
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    expect(b.accountWithFailover("alice")).toBe("bob");
    // Only the 7d window's own reset releases it.
    seedSnap(b, "alice", 10, 93, {
      fiveHourResetAt: new Date(NOW + 5 * 3_600_000).toISOString(),
      sevenDayResetAt: new Date(NOW + 8 * 86_400_000).toISOString(),
    });
    expect(b.isAccountSoftAvoided("alice")).toBe(false);
    expect(b.accountWithFailover("alice")).toBe("alice");
  });
});

describe("hysteresis across probe ticks", () => {
  it("94↔96 oscillation does not flip the preference (pct=95)", () => {
    const { b } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
    });
    seedSnap(b, "bob", 0, 0);
    seedSnap(b, "alice", 10, 96);
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    expect(b.accountWithFailover("alice")).toBe("bob");
    // Next tick: dips to 94 — hysteresis holds the preference.
    seedSnap(b, "alice", 10, 94);
    expect(b.isAccountSoftAvoided("alice")).toBe(true);
    expect(b.accountWithFailover("alice")).toBe("bob");
    // Drops clearly below pct-5 → preference releases, alice serves again.
    seedSnap(b, "alice", 10, 89);
    expect(b.isAccountSoftAvoided("alice")).toBe(false);
    expect(b.accountWithFailover("alice")).toBe("alice");
  });
});
