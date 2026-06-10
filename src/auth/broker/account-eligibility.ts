/**
 * Account eligibility — the pure decision layer for "is this account blocked
 * from serving / failover right now?".
 *
 * The 2026-06-10 outage was a stale-data-over-live-truth inversion: the broker
 * judged an account healthy-or-not PURELY by a persisted `exhausted_until`
 * mark, never consulting the live quota probe sitting beside it in
 * `lastQuotaCache`. One misfired +7d mark on the healthy primary (pixsoul,
 * live 7d=20%) therefore stranded the whole fleet, and a stale *past* mark on
 * a live-walled account (outlook, live 5h=100%) made it look eligible — both
 * failover paths picked wrong because they trusted a timestamp over the truth.
 *
 * Principle (operator directive): rely on accurate LIVE status, never stale
 * JSON — especially older than 24h. Encoded here as MOST-RECENT-SIGNAL-WINS:
 * a live snapshot that is fresher than the mark (and within the 24h staleness
 * ceiling) is authoritative; otherwise the mark is the best signal we have.
 *
 * PURE — no I/O, no clock except the injected `now`. Fully unit-tested.
 */

/**
 * Utilization at/above this on either window is a hard wall. Matches
 * `EXHAUSTION_PCT` in consumer-quota-sensor.ts and `classifyHealth`'s
 * 'blocked' threshold so the sensor, the /auth health view, and this
 * eligibility decision all agree on what "exhausted" means.
 */
export const WALL_PCT = 99.5;

/**
 * Both windows must be below this for a probe to "clearly healthy" — the bar
 * for self-healing (clearing) a stale exhaustion mark. Deliberately well under
 * the wall so a genuine weekly wall (7d >= 99.5%) is never mistaken for
 * healthy and never has its mark cleared.
 */
export const HEALTHY_CLEAR_PCT = 80;

/**
 * Snapshots older than this are STALE — treated as unknown, never used as
 * truth (the operator's "never trust JSON >24h old"). Beyond it, eligibility
 * falls back to the persisted mark.
 */
export const SNAPSHOT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

/** The minimal live-snapshot shape the eligibility decision needs. */
export interface QuotaSnapshot {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  /** Unix ms when this snapshot was captured by a live probe. */
  capturedAt: number;
}

/** A persisted exhaustion mark. `markedAt` is when it was written (added
 *  2026-06-10 so live-vs-mark recency can be compared; legacy marks without
 *  it are treated as oldest, so any fresh probe overrides them — the safe
 *  direction, since that's how a bogus legacy mark gets ignored). */
export interface ExhaustionMark {
  exhausted_until: number;
  marked_at?: number;
}

/** A live snapshot is within the staleness ceiling (still usable as truth). */
export function snapshotFresh(
  s: QuotaSnapshot | undefined,
  now: number,
  maxAgeMs = SNAPSHOT_STALE_AGE_MS,
): s is QuotaSnapshot {
  return !!s && now - s.capturedAt <= maxAgeMs && s.capturedAt <= now + 60_000;
}

/** A live snapshot shows a hard wall on either window. */
export function snapshotWalled(s: QuotaSnapshot): boolean {
  return s.fiveHourUtilizationPct >= WALL_PCT || s.sevenDayUtilizationPct >= WALL_PCT;
}

/** A live snapshot is clearly healthy on BOTH windows (safe to clear a mark). */
export function snapshotClearlyHealthy(s: QuotaSnapshot): boolean {
  return (
    s.fiveHourUtilizationPct < HEALTHY_CLEAR_PCT &&
    s.sevenDayUtilizationPct < HEALTHY_CLEAR_PCT
  );
}

/**
 * THE eligibility decision: is `account` blocked from serving / failover now?
 *
 * Most-recent-signal-wins:
 *  - A fresh live snapshot (≤24h) that is NEWER than the mark is authoritative:
 *      walled → blocked (kills the live-walled-but-stale-past-mark hop);
 *      healthy → NOT blocked (kills the bogus-future-mark stranding).
 *  - Otherwise (no snapshot, snapshot >24h stale, or mark is newer than the
 *    snapshot) the persisted mark is the best signal: blocked iff unexpired.
 */
export function isAccountBlocked(opts: {
  mark?: ExhaustionMark;
  snapshot?: QuotaSnapshot;
  now: number;
}): boolean {
  const { mark, snapshot, now } = opts;
  if (snapshotFresh(snapshot, now)) {
    const markedAt = mark?.marked_at ?? 0;
    if (snapshot.capturedAt >= markedAt) {
      // Live truth is the newer signal → it decides, mark ignored.
      return snapshotWalled(snapshot);
    }
  }
  // No usable live truth (or the mark is newer) → trust the mark.
  return mark !== undefined && mark.exhausted_until > now;
}

/**
 * Should a freshly-captured snapshot self-heal (clear) an existing mark?
 * True when the snapshot is newer than the mark and clearly healthy on BOTH
 * windows — so a misfired/expired mark stops lingering on disk, while a real
 * weekly wall (7d >= 99.5%) is never cleared.
 */
export function snapshotShouldClearMark(
  snapshot: QuotaSnapshot,
  mark: ExhaustionMark | undefined,
  now: number,
): boolean {
  if (!mark) return false;
  if (!snapshotFresh(snapshot, now)) return false;
  if (snapshot.capturedAt < (mark.marked_at ?? 0)) return false;
  return snapshotClearlyHealthy(snapshot);
}

/**
 * Clamp a proposed exhaustion-mark expiry. A mark longer than the short
 * default (5h) is the misfire-prone case (the +7d weekly default that landed
 * on the healthy primary on 2026-06-10).
 *
 * Clamp to `now + shortMs` ONLY when a fresh live probe POSITIVELY CONTRADICTS
 * the weekly wall (the account's 7-day window is below the wall right now). In
 * the absence of live evidence — no snapshot, or a stale one — the caller's
 * reset is TRUSTED (a genuine gateway-parsed weekly reset must hold; the legit
 * #2218 weekly-durability path passes exactly such an until). This is the
 * "don't fight a real mark, only override one the live data disproves"
 * direction — bogus marks written without contradicting evidence are instead
 * neutralised within one probe cycle by the live-authoritative eligibility +
 * self-heal (isAccountBlocked / snapshotShouldClearMark), not by clamping here.
 */
export function clampMarkExpiry(opts: {
  proposedUntil: number;
  now: number;
  shortMs: number;
  snapshot?: QuotaSnapshot;
}): number {
  const { proposedUntil, now, shortMs, snapshot } = opts;
  const shortCeil = now + shortMs;
  if (proposedUntil <= shortCeil) return proposedUntil;
  const liveContradictsWeeklyWall =
    snapshotFresh(snapshot, now) && snapshot.sevenDayUtilizationPct < WALL_PCT;
  return liveContradictsWeeklyWall ? shortCeil : proposedUntil;
}
