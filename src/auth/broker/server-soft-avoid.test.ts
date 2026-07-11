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
  const broker = new AuthBroker(config, {
    home,
    stateDir: join(home, ".switchroom", "state", "auth-broker"),
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
