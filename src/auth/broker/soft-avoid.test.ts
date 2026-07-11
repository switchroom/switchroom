/**
 * Soft-avoid tier (#3031, PR 1/4) — pure-layer tests for evaluateSoftAvoid.
 *
 * The tier is a PREFERENCE ranking between eligible and blocked. These tests
 * pin: entry thresholds on both windows, the 5h cap, enter/exit hysteresis
 * (no flap on 94↔96 with pct=95), window-reset latch clearing, the overage
 * exemption, stale/absent-snapshot handling, and — critically — that an unset
 * pct can never soft-avoid anything (the structural no-behavior-change
 * guarantee for fleets without `auth.proactive_failover_pct`).
 */

import { describe, expect, it } from "vitest";

import {
  evaluateSoftAvoid,
  softAvoidThresholds,
  SOFT_AVOID_EXIT_MARGIN,
  SOFT_AVOID_FIVE_HOUR_CAP,
  WALL_PCT,
  type SoftAvoidSnapshot,
  type SoftAvoidState,
} from "./account-eligibility.js";

const NOW = 1_800_000_000_000;

function snap(
  fiveHour: number,
  sevenDay: number,
  extra: Partial<SoftAvoidSnapshot> = {},
): SoftAvoidSnapshot {
  return {
    fiveHourUtilizationPct: fiveHour,
    sevenDayUtilizationPct: sevenDay,
    capturedAt: NOW - 60_000,
    ...extra,
  };
}

describe("softAvoidThresholds", () => {
  it("is pct on the 7d window and pct+3 on the 5h window", () => {
    expect(softAvoidThresholds(95)).toEqual({ sevenDay: 95, fiveHour: 98 });
    expect(softAvoidThresholds(90)).toEqual({ sevenDay: 90, fiveHour: 93 });
  });

  it("caps the 5h threshold at 98 so it never collides with the wall", () => {
    expect(softAvoidThresholds(97).fiveHour).toBe(SOFT_AVOID_FIVE_HOUR_CAP);
    expect(softAvoidThresholds(99).fiveHour).toBe(98);
    expect(SOFT_AVOID_FIVE_HOUR_CAP).toBeLessThan(WALL_PCT);
  });
});

describe("evaluateSoftAvoid — feature-off guarantee", () => {
  it("pct unset → never soft-avoided, even at 99/99", () => {
    expect(
      evaluateSoftAvoid({ snapshot: snap(99, 99), now: NOW, pct: undefined }),
    ).toEqual({ softAvoided: false });
  });

  it("pct unset → a stale latched prev cannot leak through", () => {
    const prev: SoftAvoidState = { softAvoided: true };
    expect(
      evaluateSoftAvoid({ snapshot: snap(99, 99), now: NOW, prev }),
    ).toEqual({ softAvoided: false });
  });
});

describe("evaluateSoftAvoid — entry thresholds", () => {
  it("enters on 7d ≥ pct", () => {
    expect(evaluateSoftAvoid({ snapshot: snap(0, 95), now: NOW, pct: 95 }).softAvoided).toBe(true);
    expect(evaluateSoftAvoid({ snapshot: snap(0, 94.9), now: NOW, pct: 95 }).softAvoided).toBe(false);
  });

  it("enters on 5h ≥ min(pct+3, 98)", () => {
    expect(evaluateSoftAvoid({ snapshot: snap(98, 0), now: NOW, pct: 95 }).softAvoided).toBe(true);
    expect(evaluateSoftAvoid({ snapshot: snap(97.9, 0), now: NOW, pct: 95 }).softAvoided).toBe(false);
    // pct=90 → 5h threshold 93
    expect(evaluateSoftAvoid({ snapshot: snap(93, 0), now: NOW, pct: 90 }).softAvoided).toBe(true);
    expect(evaluateSoftAvoid({ snapshot: snap(92.9, 0), now: NOW, pct: 90 }).softAvoided).toBe(false);
  });

  it("either window alone is sufficient", () => {
    expect(evaluateSoftAvoid({ snapshot: snap(98, 10), now: NOW, pct: 95 }).softAvoided).toBe(true);
    expect(evaluateSoftAvoid({ snapshot: snap(10, 96), now: NOW, pct: 95 }).softAvoided).toBe(true);
    expect(evaluateSoftAvoid({ snapshot: snap(10, 10), now: NOW, pct: 95 }).softAvoided).toBe(false);
  });
});

describe("evaluateSoftAvoid — hysteresis", () => {
  it("does not flap on 94↔96 oscillation across probe ticks (pct=95)", () => {
    // Tick 1: 96 → enter.
    let state = evaluateSoftAvoid({ snapshot: snap(0, 96), now: NOW, pct: 95 });
    expect(state.softAvoided).toBe(true);
    // Tick 2: dips to 94 — still ≥ pct-5 (90) → stays soft-avoided.
    state = evaluateSoftAvoid({ snapshot: snap(0, 94), now: NOW, pct: 95, prev: state });
    expect(state.softAvoided).toBe(true);
    // Tick 3: back to 96 → still in.
    state = evaluateSoftAvoid({ snapshot: snap(0, 96), now: NOW, pct: 95, prev: state });
    expect(state.softAvoided).toBe(true);
    // Tick 4: 89.9 < pct-5 → exits.
    state = evaluateSoftAvoid({ snapshot: snap(0, 89.9), now: NOW, pct: 95, prev: state });
    expect(state.softAvoided).toBe(false);
  });

  it("exit requires BOTH windows below their exit thresholds", () => {
    const prev: SoftAvoidState = { softAvoided: true };
    // 7d dropped clear but 5h sits above (98-5)=93 → stays in.
    expect(
      evaluateSoftAvoid({ snapshot: snap(94, 10), now: NOW, pct: 95, prev }).softAvoided,
    ).toBe(true);
    // Both clear → out.
    expect(
      evaluateSoftAvoid({ snapshot: snap(92.9, 10), now: NOW, pct: 95, prev }).softAvoided,
    ).toBe(false);
    expect(SOFT_AVOID_EXIT_MARGIN).toBe(5);
  });

  it("without a latched prev, sub-threshold utilization is simply not soft-avoided", () => {
    expect(evaluateSoftAvoid({ snapshot: snap(0, 94), now: NOW, pct: 95 }).softAvoided).toBe(false);
  });
});

describe("evaluateSoftAvoid — window reset clears the latch", () => {
  it("an advanced reset epoch on a newer snapshot exits soft-avoid", () => {
    const entered = evaluateSoftAvoid({
      snapshot: snap(0, 96, { sevenDayResetAtMs: NOW + 86_400_000 }),
      now: NOW,
      pct: 95,
    });
    expect(entered.softAvoided).toBe(true);
    // Next probe: util still latch-zone (93), but the 7d reset epoch advanced
    // — the window rolled, so the latch clears.
    const after = evaluateSoftAvoid({
      snapshot: snap(0, 93, { sevenDayResetAtMs: NOW + 8 * 86_400_000 }),
      now: NOW,
      pct: 95,
      prev: entered,
    });
    expect(after.softAvoided).toBe(false);
  });

  it("a snapshot whose reset time has passed reads that window as refilled (0%)", () => {
    // 7d shows 96 but its reset was an hour ago → treated as 0 → no entry.
    const state = evaluateSoftAvoid({
      snapshot: snap(0, 96, { sevenDayResetAtMs: NOW - 3_600_000 }),
      now: NOW,
      pct: 95,
    });
    expect(state.softAvoided).toBe(false);
  });
});

describe("evaluateSoftAvoid — overage exemption", () => {
  it("an overage-lifted account is NEVER soft-avoided, at any utilization", () => {
    expect(
      evaluateSoftAvoid({
        snapshot: snap(99, 99),
        now: NOW,
        pct: 95,
        overageLifted: true,
      }).softAvoided,
    ).toBe(false);
  });

  it("overage lift also releases an existing latch", () => {
    const prev: SoftAvoidState = { softAvoided: true };
    expect(
      evaluateSoftAvoid({
        snapshot: snap(99, 99),
        now: NOW,
        pct: 95,
        overageLifted: true,
        prev,
      }).softAvoided,
    ).toBe(false);
  });
});

describe("evaluateSoftAvoid — snapshot freshness", () => {
  it("no snapshot → not soft-avoided (an unmeasured account is not avoided)", () => {
    expect(evaluateSoftAvoid({ now: NOW, pct: 95 }).softAvoided).toBe(false);
  });

  it("no snapshot but latched prev → holds the previous verdict", () => {
    const prev: SoftAvoidState = { softAvoided: true };
    expect(evaluateSoftAvoid({ now: NOW, pct: 95, prev }).softAvoided).toBe(true);
  });

  it("a stale (>24h) snapshot is not usable evidence — prev carries", () => {
    const stale = snap(99, 99, { capturedAt: NOW - 25 * 3_600_000 });
    expect(
      evaluateSoftAvoid({ snapshot: stale, now: NOW, pct: 95 }).softAvoided,
    ).toBe(false);
    const prev: SoftAvoidState = { softAvoided: true };
    expect(
      evaluateSoftAvoid({ snapshot: stale, now: NOW, pct: 95, prev }).softAvoided,
    ).toBe(true);
  });
});
