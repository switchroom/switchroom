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
 * Is this snapshot a COMPLETE utilization signal — did the probe actually
 * measure BOTH windows?
 *
 * `parseQuotaHeaders` (quota.ts) coalesces a MISSING window header to `0%` for
 * back-compat while recording `*UtilPresent === false`. That coalesced `0` is a
 * FILLER, not a measurement: it is indistinguishable, on the numeric field
 * alone, from a genuine 0% reading. An unset `*UtilPresent` flag means the
 * snapshot predates the flag (cached/legacy fixture) and is treated as a real
 * probe — so completeness keys strictly on `=== false`.
 *
 * A PARTIAL probe (one window absent) must never be trusted to (a) rule an
 * account eligible/servable or (b) self-heal an exhaustion mark on the window
 * it never measured. Treating the absent window's filler `0%` as healthy
 * durably re-serves a genuinely weekly-walled account off a probe that never
 * saw the weekly (7d) window — the F0 inversion this guard exists to prevent.
 * The absent window is UNKNOWN, not healthy. PURE — no I/O.
 */
export function snapshotComplete(s: QuotaSnapshot): boolean {
  return s.fiveHourUtilPresent !== false && s.sevenDayUtilPresent !== false;
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
 *  serve the account via overage billing. The lift follows the same
 *  most-recent-signal-wins rule above: a real-429 mark still blocks while it is
 *  the newest signal (newer than the latest fresh snapshot), but a fresh
 *  post-429 probe reporting `overageStatus:"allowed"` re-authorizes the
 *  account. This is intended — it is how overage resumes serving after the
 *  weekly wall's initial 429 (the wall is what wrote the mark), and it
 *  auto-stops the moment a probe reports `out_of_credits`.
 */
export function accountEligibility(opts: {
  mark?: ExhaustionMark;
  snapshot?: QuotaSnapshot;
  now: number;
  /** True when this account is in `auth.allow_overage_accounts`. Default false. */
  allowOverage?: boolean;
}): AccountEligibility {
  const { mark, snapshot, now, allowOverage = false } = opts;

  // F4b — a FRESH snapshot that POSITIVELY shows a hard wall (and is not
  // overage-lifted) is the strongest live truth there is. It must NOT be
  // discarded just because a mark carries a newer timestamp but has since
  // expired: the most-recent-signal-wins branch below skips an older-than-mark
  // snapshot, and an expired mark yields no block, so the pre-fix path ruled a
  // genuinely-walled account `unknown` (→ servable). Block on the live wall
  // directly. Overage-lifted walls fall through to the most-recent-signal-wins
  // logic so a NEWER `overageStatus:"allowed"` re-probe can still serve past
  // the wall (that is what overage exists for).
  if (
    snapshotFresh(snapshot, now) &&
    snapshotWalled(snapshot) &&
    !overageLiftsWall(snapshot, allowOverage)
  ) {
    return "blocked";
  }

  if (snapshotFresh(snapshot, now)) {
    const markedAt = mark?.marked_at ?? 0;
    if (snapshot.capturedAt >= markedAt) {
      // Live truth is the newer signal → it decides, mark ignored.
      if (snapshotWalled(snapshot)) {
        // Reachable only when overage lifts the wall (the non-lifted fresh wall
        // already returned 'blocked' above) — the account stays eligible via
        // Anthropic overage billing.
        if (overageLiftsWall(snapshot, allowOverage)) return "eligible";
        return "blocked";
      }
      // F0 — a PARTIAL probe (a window absent, coalesced to a filler 0%) is not
      // a COMPLETE health signal: it cannot prove the unmeasured window healthy,
      // so it must NOT rule the account eligible off a window it never saw (e.g.
      // clearing a weekly 7d wall on a 7d-absent probe). Defer to the mark
      // instead. A complete probe rules eligible exactly as before.
      if (snapshotComplete(snapshot)) return "eligible";
    }
  }
  // No usable live truth (or the mark is newer, or the fresh probe was partial)
  // → the mark is the only signal. Unexpired mark → blocked. No mark (or
  // expired) and no usable snapshot → unknown: ZERO positive evidence, not a
  // hard block.
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
  // F0 (#2495 folded nit B, widened) — a probe that did not measure a window is
  // NOT evidence that window is healthy: `parseQuotaHeaders` coalesces an absent
  // header to a filler 0% and `snapshotClearlyHealthy` reads that as 0% < 80% →
  // "healthy". A THIN probe (both windows absent) OR a PARTIAL probe (one window
  // absent, e.g. the real "7d missing, 5h present" case) would therefore clear a
  // genuine exhaustion mark on the window it never saw — durably re-serving a
  // weekly-walled account. Require a COMPLETE probe (both windows actually
  // measured) before self-healing a mark. (Completeness subsumes the old thin
  // check: both-absent is also not complete.)
  if (!snapshotComplete(snapshot)) return false;
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
  // F0 — only a probe that ACTUALLY measured the 7-day window can contradict a
  // weekly wall. A partial probe with the 7d header absent coalesces to a filler
  // 0% (< WALL_PCT); trusting that would clamp a legitimate gateway-parsed +7d
  // weekly mark down to 5h off a probe that never saw the weekly window. Require
  // the 7d window PRESENT before it may disprove the weekly wall; otherwise the
  // caller's proposed weekly reset is trusted (the #2218 durability path).
  const liveContradictsWeeklyWall =
    snapshotFresh(snapshot, now) &&
    snapshot.sevenDayUtilPresent !== false &&
    snapshot.sevenDayUtilizationPct < WALL_PCT;
  return liveContradictsWeeklyWall ? shortCeil : proposedUntil;
}

/* ───────────────────────── Soft-avoid tier (#3031, PR 1/4) ───────────────── */

/**
 * The 5h-window soft-avoid threshold is `pct + 3`, capped here. The 5h window
 * refills fast, so it gets a little more headroom than the weekly window
 * before we start preferring away — but never so close to WALL_PCT that the
 * preference and the hard wall collapse into the same event.
 */
export const SOFT_AVOID_FIVE_HOUR_CAP = 98;

/**
 * Hysteresis exit margin: once soft-avoided, an account only re-earns full
 * preference when utilization drops this many points BELOW the entry
 * threshold (or its window resets). Stops the preference flapping when a
 * probe oscillates around pct (e.g. 94↔96 across 10-min ticks with pct=95).
 */
export const SOFT_AVOID_EXIT_MARGIN = 5;

/** Entry thresholds for the soft-avoid tier at a given operator pct. */
export function softAvoidThresholds(pct: number): { sevenDay: number; fiveHour: number } {
  return { sevenDay: pct, fiveHour: Math.min(pct + 3, SOFT_AVOID_FIVE_HOUR_CAP) };
}

/**
 * Per-account hysteresis state the caller carries between evaluations.
 * `fiveHourResetAt` / `sevenDayResetAt` are the window-reset epochs (unix ms)
 * observed when the state was last written — an ADVANCED reset epoch on a
 * newer snapshot means the window rolled, which clears the hysteresis latch.
 */
export interface SoftAvoidState {
  softAvoided: boolean;
  /**
   * Which window(s) latched the current soft-avoid. Only a TRIGGERING
   * window's reset (or its util dropping clear of the exit threshold) may
   * release the latch — the 5h epoch advances every ≤5h, so letting ANY
   * window's reset clear a 7d-driven latch would cap the 7d hysteresis at
   * ~5h and reintroduce the flapping the latch exists to prevent.
   * Absent (legacy state written before this field) → treated as
   * both-triggered, the conservative/stickier direction.
   */
  triggeredBy?: { fiveHour: boolean; sevenDay: boolean };
  fiveHourResetAt?: number | null;
  sevenDayResetAt?: number | null;
}

/** The snapshot shape soft-avoid needs: utilization + optional reset epochs. */
export interface SoftAvoidSnapshot extends QuotaSnapshot {
  /** Unix ms of the 5h window's next reset, when the probe carried it. */
  fiveHourResetAtMs?: number | null;
  /** Unix ms of the 7d window's next reset, when the probe carried it. */
  sevenDayResetAtMs?: number | null;
}

/**
 * THE soft-avoid decision — a PREFERENCE tier between `eligible` and
 * `blocked` (#3031). An account in this tier still serves; callers merely
 * rank fully-eligible candidates ahead of it. It MUST NEVER be treated as a
 * block, and it MUST NEVER affect attribution (mark-exhausted).
 *
 * Semantics:
 *  - `pct` unset (config `auth.proactive_failover_pct` absent) → NEVER
 *    soft-avoided. This is the structural no-behavior-change guarantee.
 *  - Overage-lifted accounts (see {@link overageLiftsWall}) are NEVER
 *    soft-avoided: the operator explicitly opted them into serving past the
 *    wall, so pre-wall avoidance would be nonsense.
 *  - ENTER when a fresh snapshot shows 7d ≥ pct, or 5h ≥ min(pct+3, 98).
 *    The state records WHICH window(s) triggered ({@link SoftAvoidState}
 *    `triggeredBy`).
 *  - EXIT (hysteresis) only when EVERY triggering window has released:
 *    a triggering window releases when its utilization drops below its
 *    entry threshold minus {@link SOFT_AVOID_EXIT_MARGIN}, or when THAT
 *    window has visibly reset (its reset epoch advanced, or the snapshot's
 *    own reset time has passed → window refilled). A non-triggering
 *    window's reset never releases the latch — the 5h epoch rolls every
 *    ≤5h, which would cap a 7d-driven latch at ~5h.
 *  - No fresh snapshot → carry the previous state unchanged (no evidence to
 *    flip either way; a never-measured account is not soft-avoided).
 *
 * PURE — no I/O, no clock except the injected `now`.
 */
export function evaluateSoftAvoid(opts: {
  snapshot?: SoftAvoidSnapshot;
  now: number;
  /** `auth.proactive_failover_pct`; undefined = feature off. */
  pct?: number;
  /** True when {@link overageLiftsWall} holds for this account right now. */
  overageLifted?: boolean;
  /** Previous hysteresis state for this account, if any. */
  prev?: SoftAvoidState;
}): SoftAvoidState {
  const { snapshot, now, pct, overageLifted = false, prev } = opts;
  if (pct === undefined) return { softAvoided: false };
  if (overageLifted) return { softAvoided: false };
  if (!snapshotFresh(snapshot, now)) {
    // No usable live evidence — hold the previous verdict (latch included).
    return prev ?? { softAvoided: false };
  }
  const s = snapshot as SoftAvoidSnapshot;
  const thresholds = softAvoidThresholds(pct);

  // Refill-normalize: a window whose reset time has already passed rolled
  // after capture — its stale utilization reads as 0 (matches quota.ts's
  // refillNormalizedUtils semantics without importing the Date-based shape).
  const fiveRefilled = s.fiveHourResetAtMs != null && s.fiveHourResetAtMs <= now;
  const sevenRefilled = s.sevenDayResetAtMs != null && s.sevenDayResetAtMs <= now;
  const five = fiveRefilled ? 0 : s.fiveHourUtilizationPct;
  const seven = sevenRefilled ? 0 : s.sevenDayUtilizationPct;

  const nextState = (
    softAvoided: boolean,
    triggeredBy?: { fiveHour: boolean; sevenDay: boolean },
  ): SoftAvoidState => ({
    softAvoided,
    ...(softAvoided && triggeredBy ? { triggeredBy } : {}),
    fiveHourResetAt: s.fiveHourResetAtMs ?? prev?.fiveHourResetAt ?? null,
    sevenDayResetAt: s.sevenDayResetAtMs ?? prev?.sevenDayResetAt ?? null,
  });

  const fiveTriggered = five >= thresholds.fiveHour;
  const sevenTriggered = seven >= thresholds.sevenDay;
  if (fiveTriggered || sevenTriggered) {
    // Re-entry while already latched: UNION with the previous attribution.
    // A window that latched earlier and hasn't released must keep requiring
    // release — overwriting with only the currently-over-threshold window(s)
    // would let the OTHER window's ~5h reset clear a still-hot latch
    // (PR-1 review carry-over, #3032).
    const prevTrig = prev?.softAvoided
      ? (prev.triggeredBy ?? { fiveHour: true, sevenDay: true })
      : undefined;
    return nextState(true, {
      fiveHour: fiveTriggered || (prevTrig?.fiveHour ?? false),
      sevenDay: sevenTriggered || (prevTrig?.sevenDay ?? false),
    });
  }

  if (prev?.softAvoided) {
    // Latch is set. It clears only when EVERY window that triggered it has
    // released: released = that window's reset epoch advanced since the
    // state was written (or its refill boundary crossed), OR its util now
    // sits below entry-threshold minus the exit margin. A non-triggering
    // window's reset must NOT release the latch — the 5h epoch advances
    // every ≤5h, which would cap a 7d-driven latch at ~5h. Legacy states
    // without `triggeredBy` are treated as both-triggered (stickier).
    const trig = prev.triggeredBy ?? { fiveHour: true, sevenDay: true };
    const fiveReleased =
      !trig.fiveHour ||
      fiveRefilled ||
      (prev.fiveHourResetAt != null &&
        s.fiveHourResetAtMs != null &&
        s.fiveHourResetAtMs > prev.fiveHourResetAt) ||
      five < thresholds.fiveHour - SOFT_AVOID_EXIT_MARGIN;
    const sevenReleased =
      !trig.sevenDay ||
      sevenRefilled ||
      (prev.sevenDayResetAt != null &&
        s.sevenDayResetAtMs != null &&
        s.sevenDayResetAtMs > prev.sevenDayResetAt) ||
      seven < thresholds.sevenDay - SOFT_AVOID_EXIT_MARGIN;
    if (fiveReleased && sevenReleased) return nextState(false);
    return nextState(true, trig);
  }
  return nextState(false);
}
