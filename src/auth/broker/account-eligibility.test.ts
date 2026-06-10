import { describe, it, expect } from "vitest";
import {
  isAccountBlocked,
  snapshotShouldClearMark,
  clampMarkExpiry,
  snapshotFresh,
  snapshotWalled,
  snapshotClearlyHealthy,
  WALL_PCT,
  HEALTHY_CLEAR_PCT,
  SNAPSHOT_STALE_AGE_MS,
  type QuotaSnapshot,
  type ExhaustionMark,
} from "./account-eligibility.js";

const NOW = 1_781_000_000_000;
const FIVE_H = 5 * 60 * 60 * 1000;

const snap = (five: number, seven: number, ageMs = 0): QuotaSnapshot => ({
  fiveHourUtilizationPct: five,
  sevenDayUtilizationPct: seven,
  capturedAt: NOW - ageMs,
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

describe("isAccountBlocked — live truth is authoritative over the mark", () => {
  it("INCIDENT A (pixsoul): bogus future mark, but fresh healthy probe → NOT blocked", () => {
    const mark: ExhaustionMark = { exhausted_until: NOW + 7 * 24 * 60 * 60 * 1000, marked_at: NOW - 60_000 };
    expect(isAccountBlocked({ mark, snapshot: snap(4, 20, 30_000), now: NOW })).toBe(false);
  });
  it("INCIDENT B (outlook): stale PAST mark, but fresh walled probe → blocked", () => {
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
});

describe("clampMarkExpiry — only override a long mark the live data DISPROVES", () => {
  it("clamps a >5h mark when a fresh probe CONTRADICTS the weekly wall (7d healthy)", () => {
    // The pixsoul misfire shape: a +7d mark proposed while live 7d=20%.
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
