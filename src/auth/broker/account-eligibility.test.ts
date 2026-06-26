import { describe, it, expect } from "vitest";
import {
  isAccountBlocked,
  accountEligibility,
  hasNoOverageHeadroom,
  isOverageServeBlocking,
  snapshotShouldClearMark,
  clampMarkExpiry,
  snapshotFresh,
  snapshotWalled,
  snapshotClearlyHealthy,
  overageLiftsWall,
  OVERAGE_EXHAUSTED_REASONS,
  SERVE_BLOCKING_OVERAGE_REASONS,
  WALL_PCT,
  HEALTHY_CLEAR_PCT,
  SNAPSHOT_STALE_AGE_MS,
  type QuotaSnapshot,
  type ExhaustionMark,
} from "./account-eligibility.js";

const NOW = 1_781_000_000_000;
const FIVE_H = 5 * 60 * 60 * 1000;

const snap = (
  five: number,
  seven: number,
  ageMs = 0,
  overage?: { status?: string | null; reason?: string | null },
): QuotaSnapshot => ({
  fiveHourUtilizationPct: five,
  sevenDayUtilizationPct: seven,
  capturedAt: NOW - ageMs,
  ...(overage
    ? { overageStatus: overage.status ?? null, overageDisabledReason: overage.reason ?? null }
    : {}),
});

describe("snapshot predicates", () => {
  it("snapshotFresh respects the 24h ceiling and rejects future-dated", () => {
    expect(snapshotFresh(snap(0, 0, 0), NOW)).toBe(true);
    expect(snapshotFresh(snap(0, 0, SNAPSHOT_STALE_AGE_MS - 1), NOW)).toBe(true);
    expect(snapshotFresh(snap(0, 0, SNAPSHOT_STALE_AGE_MS + 1), NOW)).toBe(false);
    expect(snapshotFresh(undefined, NOW)).toBe(false);
    // clock-skew guard: a snapshot far in the future is not "fresh"
    expect(snapshotFresh({ ...snap(0, 0), capturedAt: NOW + 5 * 60_000 }, NOW)).toBe(false);
  });
  it("snapshotWalled fires at/above WALL_PCT on either window", () => {
    expect(snapshotWalled(snap(WALL_PCT, 10))).toBe(true);
    expect(snapshotWalled(snap(10, WALL_PCT))).toBe(true);
    expect(snapshotWalled(snap(99.4, 99.4))).toBe(false);
  });
  it("snapshotClearlyHealthy needs BOTH windows under HEALTHY_CLEAR_PCT", () => {
    expect(snapshotClearlyHealthy(snap(10, 20))).toBe(true);
    expect(snapshotClearlyHealthy(snap(HEALTHY_CLEAR_PCT, 20))).toBe(false);
    expect(snapshotClearlyHealthy(snap(10, HEALTHY_CLEAR_PCT))).toBe(false);
  });
});

describe("hasNoOverageHeadroom — informational allowlist on the DISABLED REASON", () => {
  it("out_of_credits → true (no overage headroom, informational only)", () => {
    expect(hasNoOverageHeadroom(snap(0, 0, 0, { reason: "out_of_credits" }))).toBe(true);
    // rejected status alongside it must not change the verdict (we key on reason)
    expect(
      hasNoOverageHeadroom(snap(0, 0, 0, { status: "rejected", reason: "out_of_credits" })),
    ).toBe(true);
  });
  it("org_level_disabled → false (MANDATORY non-regression: the live active fleet account)", () => {
    // This account serves fine off subscription; overage is merely off.
    expect(
      hasNoOverageHeadroom(snap(75, 40, 0, { status: "rejected", reason: "org_level_disabled" })),
    ).toBe(false);
  });
  it("null reason → false (deny-by-omission)", () => {
    expect(hasNoOverageHeadroom(snap(0, 0, 0, { reason: null }))).toBe(false);
    expect(hasNoOverageHeadroom(snap(0, 0, 0))).toBe(false); // field absent
  });
  it("unknown reason (payment_failed) → false (deny-by-omission)", () => {
    expect(hasNoOverageHeadroom(snap(0, 0, 0, { reason: "payment_failed" }))).toBe(false);
  });
  it("the allowlist contains ONLY out_of_credits", () => {
    expect([...OVERAGE_EXHAUSTED_REASONS]).toEqual(["out_of_credits"]);
  });
  it("SERVE_BLOCKING_OVERAGE_REASONS is an alias for OVERAGE_EXHAUSTED_REASONS (backwards compat)", () => {
    expect(SERVE_BLOCKING_OVERAGE_REASONS).toBe(OVERAGE_EXHAUSTED_REASONS);
  });
  it("isOverageServeBlocking is an alias for hasNoOverageHeadroom (backwards compat)", () => {
    // Both should return true for out_of_credits
    expect(isOverageServeBlocking(snap(0, 0, 0, { reason: "out_of_credits" }))).toBe(true);
    expect(isOverageServeBlocking(snap(0, 0, 0, { reason: "org_level_disabled" }))).toBe(false);
  });
});

describe("isAccountBlocked — out_of_credits is NOT serve-blocking (demoted to informational)", () => {
  it("out_of_credits at 0% util, fresh, no mark ⇒ FALSE (eligible failover target)", () => {
    // THE KEY CHANGE: out_of_credits is informational, NOT a block. An account
    // at 0% util with out_of_credits serves fine from quota. This reverses the
    // 2026-06-20 guard which was the defect.
    expect(
      isAccountBlocked({ snapshot: snap(0, 0, 30_000, { reason: "out_of_credits" }), now: NOW }),
    ).toBe(false);
  });
  it("out_of_credits at 0% util is a valid failover target (the carol@example.com scenario)", () => {
    // carol@example.com: 5h=0%, 7d=2%, out_of_credits. MUST be eligible.
    expect(
      isAccountBlocked({ snapshot: snap(0, 2, 30_000, { status: "rejected", reason: "out_of_credits" }), now: NOW }),
    ).toBe(false);
  });
  it("org_level_disabled at 75% util, fresh, no mark ⇒ FALSE (MANDATORY catastrophic-regression guard)", () => {
    // The live fleet account. Below the 99.5% wall, benign overage reason →
    // must read healthy. Marking it exhausted takes down the fleet.
    expect(
      isAccountBlocked({
        snapshot: snap(75, 40, 30_000, { status: "rejected", reason: "org_level_disabled" }),
        now: NOW,
      }),
    ).toBe(false);
  });
  it("unknown overage reason at 0% util ⇒ FALSE (deny-by-omission)", () => {
    expect(
      isAccountBlocked({ snapshot: snap(0, 0, 30_000, { reason: "payment_failed" }), now: NOW }),
    ).toBe(false);
  });
  it("out_of_credits on a STALE snapshot (>24h) ⇒ ignored, falls back to the mark", () => {
    // Stale overage data must not affect eligibility; only the mark governs.
    const staleAge = SNAPSHOT_STALE_AGE_MS + 60_000;
    expect(
      isAccountBlocked({
        snapshot: snap(0, 0, staleAge, { reason: "out_of_credits" }),
        now: NOW,
      }),
    ).toBe(false); // no mark → not blocked
    const mark: ExhaustionMark = { exhausted_until: NOW + 1000, marked_at: NOW - 1000 };
    expect(
      isAccountBlocked({
        mark,
        snapshot: snap(0, 0, staleAge, { reason: "out_of_credits" }),
        now: NOW,
      }),
    ).toBe(true); // unexpired mark governs
  });
  it("out_of_credits at HIGH util (>=99.5%) IS blocked — the util wall fires, not the credits flag", () => {
    // Still blocked when actually quota-walled. The block comes from snapshotWalled,
    // not from the out_of_credits flag.
    expect(
      isAccountBlocked({ snapshot: snap(99.6, 0, 30_000, { reason: "out_of_credits" }), now: NOW }),
    ).toBe(true);
    expect(
      isAccountBlocked({ snapshot: snap(0, 99.6, 30_000, { reason: "out_of_credits" }), now: NOW }),
    ).toBe(true);
  });
});

describe("isAccountBlocked — real 429 → mark-exhausted path remains the safety net", () => {
  it("an active mark blocks the account regardless of out_of_credits (mark is the safety net)", () => {
    // A real 429 raises mark-exhausted. That mark blocks until expiry.
    // out_of_credits alone does not block, but the MARK does.
    const mark: ExhaustionMark = { exhausted_until: NOW + FIVE_H, marked_at: NOW - 1000 };
    expect(
      isAccountBlocked({
        mark,
        snapshot: snap(0, 0, 30_000, { reason: "out_of_credits" }),
        now: NOW,
      }),
    ).toBe(true); // mark governs when mark is newer than snapshot
  });
  it("a mark NEWER than the snapshot wins (a just-seen 429 beats an older probe)", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + FIVE_H, marked_at: NOW - 1_000 };
    // snapshot captured 10min ago showed healthy, but the 429 mark is newer
    expect(isAccountBlocked({ mark, snapshot: snap(10, 10, 10 * 60_000), now: NOW })).toBe(true);
  });
});

describe("isAccountBlocked — live truth is authoritative over the mark", () => {
  it("INCIDENT A (healthy primary): bogus future mark, but fresh healthy probe → NOT blocked", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(isAccountBlocked({ mark, snapshot: snap(4, 20, 30_000), now: NOW })).toBe(false);
  });
  it("INCIDENT B (walled secondary): stale PAST mark, but fresh walled probe → blocked", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW - 60_000, marked_at: NOW - 3 * 60 * 60 * 1000 };
    expect(isAccountBlocked({ mark, snapshot: snap(100, 27, 30_000), now: NOW })).toBe(true);
  });
  it("legacy mark (no marked_at) is overridden by any fresh probe", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000 };
    expect(isAccountBlocked({ mark, snapshot: snap(4, 20, 0), now: NOW })).toBe(false);
  });
  it("no snapshot → falls back to the mark", () => {
    expect(isAccountBlocked({ mark: { exhausted_until: NOW + 1000 }, now: NOW })).toBe(true);
    expect(isAccountBlocked({ mark: { exhausted_until: NOW - 1000 }, now: NOW })).toBe(false);
    expect(isAccountBlocked({ now: NOW })).toBe(false);
  });
  it("STALE snapshot (>24h) is ignored → mark wins", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 1000, marked_at: NOW - 1000 };
    // even a healthy-looking but 25h-old snapshot must not un-block a live mark
    expect(isAccountBlocked({ mark, snapshot: snap(4, 20, SNAPSHOT_STALE_AGE_MS + 60_000), now: NOW })).toBe(true);
  });
});

describe("accountEligibility — tri-state distinguishes unknown from blocked (Bug 1)", () => {
  it("no snapshot AND no mark → 'unknown' (never probed — NOT a hard block)", () => {
    // The Bug-1 case: a not-yet-probed secondary. Pre-fix it was lumped in with
    // blocked; tri-state surfaces it as unknown so the selector force-probes it.
    expect(accountEligibility({ now: NOW })).toBe("unknown");
  });
  it("expired mark, no snapshot → 'unknown' (stale evidence is no evidence)", () => {
    expect(accountEligibility({ mark: { exhausted_until: NOW - 1000 }, now: NOW })).toBe("unknown");
  });
  it("unexpired mark, no fresh snapshot → 'blocked' (positive evidence)", () => {
    expect(accountEligibility({ mark: { exhausted_until: NOW + 60_000 }, now: NOW })).toBe("blocked");
  });
  it("fresh healthy snapshot → 'eligible'", () => {
    expect(accountEligibility({ snapshot: snap(4, 20, 30_000), now: NOW })).toBe("eligible");
  });
  it("fresh over-wall snapshot → 'blocked'", () => {
    expect(accountEligibility({ snapshot: snap(100, 27, 30_000), now: NOW })).toBe("blocked");
  });
  it("fresh healthy probe overrides an unexpired bogus future mark → 'eligible'", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(accountEligibility({ mark, snapshot: snap(4, 20, 30_000), now: NOW })).toBe("eligible");
  });
  it("stale (>24h) healthy snapshot does NOT rescue from unknown when no mark", () => {
    // The snapshot is too old to be truth, and there's no mark → unknown, not eligible.
    expect(
      accountEligibility({ snapshot: snap(4, 20, SNAPSHOT_STALE_AGE_MS + 60_000), now: NOW }),
    ).toBe("unknown");
  });
  it("isAccountBlocked is exactly accountEligibility === 'blocked'", () => {
    const cases = [
      { now: NOW },
      { mark: { exhausted_until: NOW + 1000 }, now: NOW },
      { mark: { exhausted_until: NOW - 1000 }, now: NOW },
      { snapshot: snap(4, 20, 0), now: NOW },
      { snapshot: snap(100, 5, 0), now: NOW },
    ];
    for (const c of cases) {
      expect(isAccountBlocked(c)).toBe(accountEligibility(c) === "blocked");
    }
  });
});

describe("snapshotShouldClearMark — self-heal", () => {
  it("clears a stale mark when a newer clearly-healthy probe lands", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(snapshotShouldClearMark(snap(4, 20, 0), mark, NOW)).toBe(true);
  });
  it("never clears a genuine weekly wall (7d still high)", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 3 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(snapshotShouldClearMark(snap(2, 99.6, 0), mark, NOW)).toBe(false);
  });
  it("does not clear when there is no mark, or snapshot is older than the mark", () => {
    expect(snapshotShouldClearMark(snap(4, 20, 0), undefined, NOW)).toBe(false);
    const mark: ExhaustionMark = { exhausted_until: NOW + 1000, marked_at: NOW };
    expect(snapshotShouldClearMark(snap(4, 20, 10 * 60_000), mark, NOW)).toBe(false);
  });
  it("#2495 nit B — NEVER clears a mark on a THIN probe (no util headers)", () => {
    // A headerless probe coalesces both windows to 0% — which reads as
    // "clearly healthy" but is NOT evidence of health. Refuse to self-heal a
    // real exhaustion mark off it.
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    const thin: QuotaSnapshot = {
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 0,
      capturedAt: NOW,
      fiveHourUtilPresent: false,
      sevenDayUtilPresent: false,
    };
    expect(snapshotShouldClearMark(thin, mark, NOW)).toBe(false);
    // Contrast: a probe that ACTUALLY measured 0% on both (markers present)
    // is real health → DOES clear (regression anchor).
    const real: QuotaSnapshot = {
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 0,
      capturedAt: NOW,
      fiveHourUtilPresent: true,
      sevenDayUtilPresent: true,
    };
    expect(snapshotShouldClearMark(real, mark, NOW)).toBe(true);
    // And a partial probe (5h present, 7d absent) is NOT thin → clears.
    const partial: QuotaSnapshot = {
      fiveHourUtilizationPct: 4,
      sevenDayUtilizationPct: 0,
      capturedAt: NOW,
      fiveHourUtilPresent: true,
      sevenDayUtilPresent: false,
    };
    expect(snapshotShouldClearMark(partial, mark, NOW)).toBe(true);
  });
  it("out_of_credits at 0% util DOES clear a mark — a healthy low-util probe self-heals normally", () => {
    // THE KEY CHANGE from the 2026-06-20 guard: out_of_credits is informational.
    // A 0%-util probe is genuinely healthy; it should clear a misfired mark.
    // The real safety net for a dead account is mark-exhausted via 429, not here.
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(
      snapshotShouldClearMark(snap(2, 5, 0, { reason: "out_of_credits" }), mark, NOW),
    ).toBe(true); // CHANGED: was false, now true — healthy util self-heals
    // Same behavior as null reason (regression anchor — should be identical now)
    expect(snapshotShouldClearMark(snap(2, 5, 0, { reason: null }), mark, NOW)).toBe(true);
    // org_level_disabled is still benign → also clears.
    expect(
      snapshotShouldClearMark(snap(2, 5, 0, { reason: "org_level_disabled" }), mark, NOW),
    ).toBe(true);
  });
  it("out_of_credits at HIGH util does NOT clear (the util wall prevents it)", () => {
    // Even though out_of_credits is now informational, a walled util still blocks
    // clearing. The snapshotClearlyHealthy check (both windows < 80%) prevents it.
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(
      snapshotShouldClearMark(snap(85, 20, 0, { reason: "out_of_credits" }), mark, NOW),
    ).toBe(false); // 85% >= 80% → not clearly healthy → no clear
  });
});

describe("clampMarkExpiry — only override a long mark the live data DISPROVES", () => {
  it("clamps a >5h mark when a fresh probe CONTRADICTS the weekly wall (7d healthy)", () => {
    // The healthy-primary misfire shape: a +7d mark proposed while live 7d=20%.
    const proposed = NOW + 7 * 24 * 60 * 60 * 1000;
    expect(clampMarkExpiry({ proposedUntil: proposed, now: NOW, shortMs: FIVE_H, snapshot: snap(4, 20, 0) }))
      .toBe(NOW + FIVE_H);
  });
  it("preserves a long mark when a fresh probe confirms the 7d wall", () => {
    const proposed = NOW + 6 * 24 * 60 * 60 * 1000;
    expect(clampMarkExpiry({ proposedUntil: proposed, now: NOW, shortMs: FIVE_H, snapshot: snap(10, 99.7, 0) }))
      .toBe(proposed);
  });
  it("TRUSTS a long mark when there is NO live evidence (legit gateway-parsed weekly reset)", () => {
    // #2218 weekly-durability: a real weekly until with no snapshot must HOLD.
    const proposed = NOW + 6 * 24 * 60 * 60 * 1000;
    expect(clampMarkExpiry({ proposedUntil: proposed, now: NOW, shortMs: FIVE_H })).toBe(proposed);
  });
  it("TRUSTS a long mark when the only snapshot is stale (>24h)", () => {
    const proposed = NOW + 6 * 24 * 60 * 60 * 1000;
    expect(clampMarkExpiry({ proposedUntil: proposed, now: NOW, shortMs: FIVE_H, snapshot: snap(4, 20, SNAPSHOT_STALE_AGE_MS + 1) }))
      .toBe(proposed);
  });
  it("leaves a short (<=5h) mark untouched regardless of snapshot", () => {
    const proposed = NOW + 2 * 60 * 60 * 1000;
    expect(clampMarkExpiry({ proposedUntil: proposed, now: NOW, shortMs: FIVE_H })).toBe(proposed);
    expect(clampMarkExpiry({ proposedUntil: proposed, now: NOW, shortMs: FIVE_H, snapshot: snap(4, 20, 0) })).toBe(proposed);
  });
});

// ─── allow_overage feature tests ───────────────────────────────────────────

describe("overageLiftsWall — predicate for opt-in overage lift", () => {
  it("true when flagged + overageStatus allowed + no disabling reason (the alice case)", () => {
    expect(overageLiftsWall(snap(100, 100, 0, { status: "allowed", reason: null }), true)).toBe(true);
  });
  it("false when NOT in allow list (opt-in; default unchanged)", () => {
    expect(overageLiftsWall(snap(100, 100, 0, { status: "allowed", reason: null }), false)).toBe(false);
  });
  it("false when overageStatus is not 'allowed' (rejected)", () => {
    expect(overageLiftsWall(snap(100, 100, 0, { status: "rejected", reason: null }), true)).toBe(false);
  });
  it("false when overageDisabledReason is out_of_credits (credit exhausted)", () => {
    expect(overageLiftsWall(snap(100, 100, 0, { status: "allowed", reason: "out_of_credits" }), true)).toBe(false);
  });
  it("false when overageStatus is absent", () => {
    expect(overageLiftsWall(snap(100, 100, 0), true)).toBe(false);
  });
});

describe("accountEligibility — allow_overage matrix (the alice case and safety guards)", () => {
  it("flagged + util 100% + overageStatus allowed + reason null → ELIGIBLE (alice case)", () => {
    // alice@example.com: 7d=100%, overageStatus:'allowed', no disabled reason
    // With allow_overage opt-in, the util wall must NOT block.
    expect(
      accountEligibility({
        snapshot: snap(0, 100, 30_000, { status: "allowed", reason: null }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("eligible");
  });

  it("flagged + util 100% + overageStatus allowed + reason out_of_credits → BLOCKED (credit exhausted — stop spending)", () => {
    // Overage credit is exhausted — must block even when flagged.
    expect(
      accountEligibility({
        snapshot: snap(0, 100, 30_000, { status: "allowed", reason: "out_of_credits" }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("blocked");
  });

  it("flagged + util 100% + overageStatus rejected → BLOCKED", () => {
    // Anthropic says overage is rejected — must block.
    expect(
      accountEligibility({
        snapshot: snap(0, 100, 30_000, { status: "rejected", reason: null }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("blocked");
  });

  it("NOT flagged + util 100% + overageStatus allowed → BLOCKED (opt-in; default unchanged)", () => {
    // Without the flag, the util wall must behave exactly as before.
    expect(
      accountEligibility({
        snapshot: snap(0, 100, 30_000, { status: "allowed", reason: null }),
        now: NOW,
        allowOverage: false,
      }),
    ).toBe("blocked");
  });

  it("flagged + util 50% → ELIGIBLE (normal, no overage needed)", () => {
    // Below the wall — eligible regardless of overage flag.
    expect(
      accountEligibility({
        snapshot: snap(10, 50, 30_000, { status: "rejected", reason: "org_level_disabled" }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("eligible");
  });

  it("flagged + util 100% + allowOverage + NEWER exhaustion MARK → BLOCKED (fresh 429 wins)", () => {
    // Most-recent-signal-wins: a real-429 mark NEWER than the latest probe is
    // the freshest refusal, so it blocks even with overage allowed.
    const mark: ExhaustionMark = { exhausted_until: NOW + FIVE_H, marked_at: NOW - 500 };
    // Mark (NOW - 500) is newer than snapshot (capturedAt: NOW - 30_000), so mark governs.
    expect(
      accountEligibility({
        mark,
        snapshot: snap(0, 100, 30_000, { status: "allowed", reason: null }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("blocked");
  });

  it("flagged + util 100% + allowOverage + OLDER mark + fresh allowed probe → ELIGIBLE (re-probe after 429 re-authorizes overage)", () => {
    // The intended weekly-wall flow: hitting the wall writes the 429 mark, then
    // the broker re-probes (~10min) and Anthropic reports overageStatus:allowed.
    // That newer snapshot re-authorizes overage — most-recent-signal-wins. This
    // is why option A (mark blocks unconditionally) was rejected: it would make
    // overage inert at exactly the wall it exists to serve past.
    const mark: ExhaustionMark = { exhausted_until: NOW + FIVE_H, marked_at: NOW - 30_000 };
    // Snapshot (capturedAt: NOW - 500) is newer than mark (NOW - 30_000), so the probe governs.
    expect(
      accountEligibility({
        mark,
        snapshot: snap(0, 100, 500, { status: "allowed", reason: null }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("eligible");
  });

  it("flagged + OLDER mark + fresh probe shows out_of_credits → BLOCKED (overage auto-stop wins even past the mark)", () => {
    // Even when the probe is newer than the mark, out_of_credits removes the lift.
    const mark: ExhaustionMark = { exhausted_until: NOW + FIVE_H, marked_at: NOW - 30_000 };
    expect(
      accountEligibility({
        mark,
        snapshot: snap(0, 100, 500, { status: "allowed", reason: "out_of_credits" }),
        now: NOW,
        allowOverage: true,
      }),
    ).toBe("blocked");
  });

  it("isAccountBlocked mirrors accountEligibility === 'blocked' for the allow_overage cases", () => {
    const cases: Array<Parameters<typeof accountEligibility>[0]> = [
      { snapshot: snap(0, 100, 30_000, { status: "allowed", reason: null }), now: NOW, allowOverage: true },
      { snapshot: snap(0, 100, 30_000, { status: "allowed", reason: "out_of_credits" }), now: NOW, allowOverage: true },
      { snapshot: snap(0, 100, 30_000, { status: "rejected", reason: null }), now: NOW, allowOverage: true },
      { snapshot: snap(0, 100, 30_000, { status: "allowed", reason: null }), now: NOW, allowOverage: false },
    ];
    for (const c of cases) {
      expect(isAccountBlocked(c)).toBe(accountEligibility(c) === "blocked");
    }
  });
});
