import { describe, it, expect } from "vitest";
import {
  isAccountBlocked,
  isOverageServeBlocking,
  snapshotShouldClearMark,
  clampMarkExpiry,
  snapshotFresh,
  snapshotWalled,
  snapshotClearlyHealthy,
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

describe("isOverageServeBlocking — strict allowlist on the DISABLED REASON", () => {
  it("out_of_credits → true (the credits-dead account)", () => {
    expect(isOverageServeBlocking(snap(0, 0, 0, { reason: "out_of_credits" }))).toBe(true);
    // rejected status alongside it must not change the verdict (we key on reason)
    expect(
      isOverageServeBlocking(snap(0, 0, 0, { status: "rejected", reason: "out_of_credits" })),
    ).toBe(true);
  });
  it("org_level_disabled → false (MANDATORY non-regression: the live active fleet account)", () => {
    // This account serves fine off subscription; overage is merely off. It even
    // reports overageStatus:"rejected" — must STILL be benign.
    expect(
      isOverageServeBlocking(snap(75, 40, 0, { status: "rejected", reason: "org_level_disabled" })),
    ).toBe(false);
  });
  it("null reason → false (deny-by-omission)", () => {
    expect(isOverageServeBlocking(snap(0, 0, 0, { reason: null }))).toBe(false);
    expect(isOverageServeBlocking(snap(0, 0, 0))).toBe(false); // field absent
  });
  it("unknown reason (payment_failed) → false (deny-by-omission)", () => {
    expect(isOverageServeBlocking(snap(0, 0, 0, { reason: "payment_failed" }))).toBe(false);
  });
  it("the allowlist contains ONLY out_of_credits", () => {
    expect([...SERVE_BLOCKING_OVERAGE_REASONS]).toEqual(["out_of_credits"]);
  });
});

describe("isAccountBlocked — overage serve-blocking is exhaustion too", () => {
  it("out_of_credits at 0% util, fresh, no mark ⇒ TRUE (idle-but-unusable)", () => {
    expect(
      isAccountBlocked({ snapshot: snap(0, 0, 30_000, { reason: "out_of_credits" }), now: NOW }),
    ).toBe(true);
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
    // Stale overage data must not block on its own; only the mark governs.
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
  it("a mark NEWER than the snapshot wins (a just-seen 429 beats an older probe)", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + FIVE_H, marked_at: NOW - 1_000 };
    // snapshot captured 10min ago showed healthy, but the 429 mark is newer
    expect(isAccountBlocked({ mark, snapshot: snap(10, 10, 10 * 60_000), now: NOW })).toBe(true);
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
  it("NEVER clears a mark off an out_of_credits account, even at 0% util", () => {
    // The 2026-06-20 self-heal bug: a fresh low-util probe must NOT un-exhaust a
    // credits-dead account. Low util ≠ healthy when overage is serve-blocking.
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(
      snapshotShouldClearMark(snap(2, 5, 0, { reason: "out_of_credits" }), mark, NOW),
    ).toBe(false);
    // Contrast: the SAME util with a null reason DOES clear (regression anchor).
    expect(snapshotShouldClearMark(snap(2, 5, 0, { reason: null }), mark, NOW)).toBe(true);
    // And org_level_disabled at low util is benign → also clears.
    expect(
      snapshotShouldClearMark(snap(2, 5, 0, { reason: "org_level_disabled" }), mark, NOW),
    ).toBe(true);
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
