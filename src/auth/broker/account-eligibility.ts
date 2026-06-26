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

import { isProbeThin } from "../quota.js";

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
 * INFORMATIONAL ALLOWLIST of `overageDisabledReason` values that mean the
 * account has no overage headroom (credits balance is zero or disabled). These
 * are **NOT serve-blocking** for a Claude Pro Max subscription fleet: the fleet
 * runs on quota, not on overage credits. An account whose quota utilization is
 * low (e.g. 5h=0%, 7d=2%) serves perfectly fine even when `out_of_credits` is
 * set — that flag describes overage-past-quota availability only.
 *
 * DESIGN RATIONALE (Jun 2026 incident reversal):
 *   The 2026-06-20 incident (#2455) added `out_of_credits` as a serve-block to
 *   guard against an idle-but-429ing account. That guard was structurally wrong:
 *   it confused overage (credits past the subscription quota) with quota itself.
 *   An account at 0% util is NOT 429ing due to `out_of_credits` — it 429s only
 *   when its quota window is actually walled (≥99.5%). Failover safety is
 *   preserved via the EXISTING `mark-exhausted` path: agents raise mark-
 *   exhausted on a real 429, which blocks that account until the mark expires.
 *   We do NOT need to proxy the credits flag for this.
 *
 *   The structurally identical `org_level_disabled` (also overage-off, also
 *   reports `overageStatus:"rejected"`) was always treated as benign/healthy.
 *   Both are "overage off" — the asymmetric treatment of `out_of_credits` was
 *   the defect.
 *
 * USAGE — call `hasNoOverageHeadroom(snapshot)` to detect this informational
 * condition. MUST NEVER gate serving or failover eligibility. May be surfaced
 * as an informational annotation (e.g. "overage off (out_of_credits) — serving
 * from quota") alongside a healthy/throttling display row.
 *
 * CRITICAL — discriminate on the DISABLED REASON, never on `overageStatus`:
 *  - `"out_of_credits"`  → informational "no overage headroom". Does NOT block.
 *  - `"org_level_disabled"` → BENIGN (identical to out_of_credits semantically
 *    for a subscription fleet). Already treated correctly.
 *  - `null` / unknown / any unseen value → benign (deny-by-omission).
 *
 * Keying on `overageStatus === "rejected"` is WRONG — the active, healthy
 * account reports `rejected` too. Only the disabled-reason discriminates.
 *
 * Any NEW reason added here is informational only. Adding it does NOT gate
 * serving — that is an explicit design constraint, not an accident.
 */
export const OVERAGE_EXHAUSTED_REASONS = new Set<string>(["out_of_credits"]);

/**
 * @deprecated Use OVERAGE_EXHAUSTED_REASONS. This alias exists so callers that
 * imported the old name still compile; it will be removed in a future cleanup.
 * The semantics changed: these reasons are INFORMATIONAL (no overage headroom),
 * NOT serve-blocking. See OVERAGE_EXHAUSTED_REASONS doc comment.
 */
export const SERVE_BLOCKING_OVERAGE_REASONS = OVERAGE_EXHAUSTED_REASONS;

/** The minimal live-snapshot shape the eligibility decision needs. */
export interface QuotaSnapshot {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  /** Unix ms when this snapshot was captured by a live probe. */
  capturedAt: number;
  /** Anthropic's `anthropic-ratelimit-unified-overage-status` header, when the
   *  probe carried it. Captured for transparency; NOT a serving discriminator —
   *  the active healthy account reports `rejected` here too. See
   *  OVERAGE_EXHAUSTED_REASONS for the informational disabled-reason list. */
  overageStatus?: string | null;
  /** Anthropic's `anthropic-ratelimit-unified-overage-disabled-reason` header.
   *  Informational only: `out_of_credits` means no overage headroom, NOT that
   *  the account cannot serve from quota. `org_level_disabled` is benign.
   *  See OVERAGE_EXHAUSTED_REASONS. MUST NOT gate serving or failover. */
  overageDisabledReason?: string | null;
  /** #2494 Bug C — which util windows the probe actually carried. A probe
   *  with BOTH false is "thin" (no real signal, 0%-coalesced) and must NOT be
   *  trusted to self-heal a real exhaustion mark (#2495 folded nit B). Unset
   *  means "predates the flag" → treated as a real probe. */
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
}

/**
 * Does this snapshot indicate the account has no overage headroom? True when
 * `overageDisabledReason` is on the informational allowlist (`out_of_credits`).
 * This is a display/annotation flag ONLY — it MUST NOT gate serving or failover
 * eligibility. An account with `out_of_credits` at low util serves fine from
 * quota. `org_level_disabled` / null / unknown are benign (deny-by-omission).
 * PURE — no I/O.
 */
export function hasNoOverageHeadroom(snapshot: QuotaSnapshot): boolean {
  const reason = snapshot.overageDisabledReason;
  return reason != null && OVERAGE_EXHAUSTED_REASONS.has(reason);
}

/**
 * @deprecated Use hasNoOverageHeadroom. The semantics changed: this no longer
 * implies serve-blocking. Kept for callers that import the old name.
 */
export function isOverageServeBlocking(snapshot: QuotaSnapshot): boolean {
  return hasNoOverageHeadroom(snapshot);
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

/**
 * Is this account allowed to be served past the utilization wall via Anthropic
 * overage billing? True when ALL of:
 *   1. The account is in the operator's `allow_overage_accounts` opt-in list.
 *   2. The snapshot reports `overageStatus === "allowed"` (Anthropic will
 *      bill overage for this account).
 *   3. `overageDisabledReason` is NOT in `OVERAGE_EXHAUSTED_REASONS`
 *      (i.e. not "out_of_credits" — overage credit is not yet exhausted).
 *
 * This ONLY lifts the utilization wall. It cannot override an exhaustion mark
 * written by a real 429 (`mark-exhausted`). PURE — no I/O.
 */
export function overageLiftsWall(snapshot: QuotaSnapshot, inAllowList: boolean): boolean {
  if (!inAllowList) return false;
  if (snapshot.overageStatus !== "allowed") return false;
  const reason = snapshot.overageDisabledReason;
  if (reason != null && OVERAGE_EXHAUSTED_REASONS.has(reason)) return false;
  return true;
}

/** A live snapshot is clearly healthy on BOTH windows (safe to clear a mark). */
export function snapshotClearlyHealthy(s: QuotaSnapshot): boolean {
  return (
    s.fiveHourUtilizationPct < HEALTHY_CLEAR_PCT &&
    s.sevenDayUtilizationPct < HEALTHY_CLEAR_PCT
  );
}

/**
 * Tri-state eligibility verdict for a failover/serving candidate.
 *
 *  - `'blocked'`  — POSITIVE exhaustion evidence: a fresh over-wall snapshot,
 *                   or an unexpired `exhausted_until` mark with no fresher
 *                   contradicting snapshot. Skip this account.
 *  - `'eligible'` — fresh live snapshot proves it healthy (below the wall).
 *                   Prefer this account.
 *  - `'unknown'`  — NO usable live snapshot AND no unexpired mark. We have no
 *                   positive evidence either way. This is the case Bug 1 hinged
 *                   on: a not-yet-probed (or transiently-failed) secondary used
 *                   to be lumped in with `blocked`, so the fleet declared
 *                   "all blocked" while an account that was actually fine had
 *                   simply never been probed. It MUST NOT be treated as a hard
 *                   block — it is a candidate-of-last-resort that the caller
 *                   should force-probe before ruling out.
 */
export type AccountEligibility = "blocked" | "eligible" | "unknown";

/**
 * THE eligibility decision, tri-state. Distinguishes `unknown` (no evidence)
 * from `blocked` (positive exhaustion evidence) — see `AccountEligibility`.
 *
 * Most-recent-signal-wins:
 *  - A fresh live snapshot (≤24h) that is NEWER than the mark is authoritative:
 *      walled → blocked (kills the live-walled-but-stale-past-mark hop);
 *      healthy → eligible (kills the bogus-future-mark stranding).
 *  - Otherwise the persisted mark governs: unexpired → blocked.
 *  - With neither a usable live snapshot NOR an unexpired mark → unknown.
 *
 * Overage lift (opt-in):
 *  When `allowOverage` is true AND the snapshot satisfies `overageLiftsWall()`,
 *  a utilization wall (≥99.5%) is NOT treated as a block — Anthropic will
 *  serve the account via overage billing. The lift applies ONLY to the
 *  snapshot-driven wall; an active exhaustion mark written by a real 429
 *  (`mark-exhausted`) still blocks unconditionally.
 */
export function accountEligibility(opts: {
  mark?: ExhaustionMark;
  snapshot?: QuotaSnapshot;
  now: number;
  /** True when this account is in `auth.allow_overage_accounts`. Default false. */
  allowOverage?: boolean;
}): AccountEligibility {
  const { mark, snapshot, now, allowOverage = false } = opts;
  if (snapshotFresh(snapshot, now)) {
    const markedAt = mark?.marked_at ?? 0;
    if (snapshot.capturedAt >= markedAt) {
      // Live truth is the newer signal → it decides, mark ignored. Walled on
      // util → blocked, UNLESS overage is active for this account (opt-in).
      if (snapshotWalled(snapshot)) {
        if (overageLiftsWall(snapshot, allowOverage)) {
          // The util wall fires but overage is available — account stays eligible.
          return "eligible";
        }
        return "blocked";
      }
      return "eligible";
    }
  }
  // No usable live truth (or the mark is newer) → the mark is the only signal.
  // Unexpired mark → blocked. No mark (or expired) and no fresh snapshot →
  // unknown: we have ZERO positive evidence, so this is not a hard block.
  if (mark !== undefined && mark.exhausted_until > now) return "blocked";
  return "unknown";
}

/**
 * THE eligibility decision: is `account` blocked from serving / failover now?
 *
 * Boolean view over {@link accountEligibility} — TRUE only on POSITIVE
 * exhaustion evidence (`'blocked'`). `'unknown'` (no snapshot, no unexpired
 * mark) is NOT a block here: an account we've never probed is not provably
 * exhausted. Serving callers (`servingAccount` / `accountWithFailover`) still
 * fail an `unknown` account over to a better-known one when one exists, and
 * fall back to the account itself when none does — so this softening cannot
 * strand serving.
 *
 * Most-recent-signal-wins semantics are unchanged from before; only the
 * never-probed case moved from `true` to `false`.
 */
export function isAccountBlocked(opts: {
  mark?: ExhaustionMark;
  snapshot?: QuotaSnapshot;
  now: number;
  /** True when this account is in `auth.allow_overage_accounts`. Default false. */
  allowOverage?: boolean;
}): boolean {
  return accountEligibility(opts) === "blocked";
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
  // #2495 folded nit B — a THIN probe (no util headers, both windows coalesced
  // to 0) is NOT evidence of health: `snapshotClearlyHealthy` reads it as 0%/0%
  // and would clear a real exhaustion mark off a headerless response. Refuse to
  // self-heal a mark on a thin probe; require a probe that actually measured at
  // least one window before clearing.
  if (isProbeThin(snapshot)) return false;
  // out_of_credits is informational (no overage headroom), NOT a serve-block.
  // A 0%-util account with out_of_credits is healthy from a quota standpoint and
  // SHOULD self-heal a misfired mark. The 2026-06-20 guard here was the defect:
  // it prevented a healthy account from being restored to the failover pool.
  // Failover safety is preserved via mark-exhausted on a real 429, not here.
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
