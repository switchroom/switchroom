/**
 * Account eligibility — the pure decision layer for "is this account blocked
 * from serving / failover right now?".
 *
 * The 2026-06-10 outage was a stale-data-over-live-truth inversion: the broker
 * judged an account healthy-or-not PURELY by a persisted `exhausted_until`
 * mark, never consulting the live quota probe sitting beside it in
 * `lastQuotaCache`. One misfired +7d mark on the healthy primary account
 * (live 7d=20%) therefore stranded the whole fleet, and a stale *past* mark on
 * a live-walled secondary account (live 5h=100%) made it look eligible — both
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

/**
 * STRICT ALLOWLIST of `overageDisabledReason` values that mean the account
 * cannot serve right now and must be treated as exhausted / blocked —
 * regardless of utilization %.
 *
 * The 2026-06-20 lesson: the broker captured Anthropic's overage headers per
 * account but no failover/exhaustion/health decision consulted them, so an
 * idle-but-unusable account (`overageDisabledReason:"out_of_credits"` at 0%
 * util) read healthy, got picked as a failover target, 429'd, and the
 * live-probe self-heal cleared any exhaustion mark on it.
 *
 * CRITICAL — discriminate on the DISABLED REASON, never on `overageStatus`:
 *  - `"out_of_credits"`  → SERVE-BLOCKING (account is dead; treat as exhausted).
 *  - `"org_level_disabled"` → BENIGN. This is the LIVE, ACTIVE, WORKING fleet
 *    account: overage is merely switched off org-wide, but it serves fine off
 *    the subscription. Marking it exhausted takes down the fleet. NOT here.
 *  - `null` / unknown / any unseen value → BENIGN (deny-by-omission).
 *
 * Keying on `overageStatus === "rejected"` is WRONG — the active, healthy
 * account reports `rejected` too. Only the disabled-reason discriminates.
 *
 * Any NEW reason added here is a production-affecting change: confirm with the
 * operator (which serve state Anthropic actually means by it) before adding.
 */
export const SERVE_BLOCKING_OVERAGE_REASONS = new Set<string>(["out_of_credits"]);

/** The minimal live-snapshot shape the eligibility decision needs. */
export interface QuotaSnapshot {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  /** Unix ms when this snapshot was captured by a live probe. */
  capturedAt: number;
  /** Anthropic's `anthropic-ratelimit-unified-overage-status` header, when the
   *  probe carried it. Captured for transparency; NOT the discriminator (see
   *  SERVE_BLOCKING_OVERAGE_REASONS) — the active healthy account reports
   *  `rejected` here too. */
  overageStatus?: string | null;
  /** Anthropic's `anthropic-ratelimit-unified-overage-disabled-reason` header.
   *  THIS is the serve-blocking discriminator: `out_of_credits` is dead,
   *  `org_level_disabled` is benign. See SERVE_BLOCKING_OVERAGE_REASONS. */
  overageDisabledReason?: string | null;
}

/**
 * Is this snapshot's overage state serve-blocking? True only when the live
 * `overageDisabledReason` is on the strict allowlist (`out_of_credits`). An
 * account at 0% util that is out of credits is unusable and must be treated as
 * exhausted; `org_level_disabled` / null / unknown are benign (deny-by-
 * omission). PURE — no I/O.
 */
export function isOverageServeBlocking(snapshot: QuotaSnapshot): boolean {
  const reason = snapshot.overageDisabledReason;
  return reason != null && SERVE_BLOCKING_OVERAGE_REASONS.has(reason);
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
      // Live truth is the newer signal → it decides, mark ignored. Walled on
      // util OR serve-blocked by overage (out_of_credits at any util) → blocked.
      return snapshotWalled(snapshot) || isOverageServeBlocking(snapshot);
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
  // A serve-blocking overage (out_of_credits) is an exhaustion in its own
  // right — never let a 0%-util-but-credits-dead probe self-heal a mark off
  // such an account (that's exactly the live-probe re-clear the 2026-06-20
  // bug exploited). Util being low does NOT make it "clearly healthy".
  if (isOverageServeBlocking(snapshot)) return false;
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
