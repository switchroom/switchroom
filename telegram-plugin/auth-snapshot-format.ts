/**
 * Format 2 — health-grouped /auth snapshot + causal auto-fallback
 * announcement. Pure functions; the gateway handles the live-API probe
 * (via the broker `probe-quota` op, #1336) and the broker `listState`,
 * then hands shaped data to these formatters.
 *
 * JTBD this module serves:
 *   "Which accounts are maxed, what % I've used of limits, and when
 *    does it come back?"
 *
 * The previous "quota exhausted" wording conflated the 5-hour and
 * 7-day windows — but those have completely different recovery times
 * (hours vs days), and that's the most-asked question after a switch.
 * Every text surface here names the limit type explicitly.
 *
 * No HTML escaping at the boundary — callers pass already-trusted
 * label strings (broker-vetted account labels). If that ever changes
 * the per-line `escapeMarkdown` helper (imported from card-format) is the place to gate.
 */

import type { QuotaResult, QuotaUtilization } from './quota-check.js';
import { isProbeThin, refillNormalizedUtils } from '../src/auth/quota.js';
import type { AccountState, LastQuotaSnapshot, ListStateData } from '../src/auth/broker/client.js';
import { maskEmail } from './demo-mask.js';
import { escapeMarkdown, codeSpanSafe } from './card-format.js';

// ── shared types ─────────────────────────────────────────────────────

/** Tri-state health verdict per account, derived from live quota. */
export type AccountHealth = 'healthy' | 'throttling' | 'blocked' | 'unknown';

/**
 * Combined per-account view used by every formatter in this module.
 * Bundles the broker's persisted state with the most recent live
 * quota probe (or `null` on probe failure / no creds).
 */
export interface AccountSnapshot {
  label: string;
  /** True when this is the fleet's `auth.active`. */
  isActive: boolean;
  /** Live quota probe result; null when the probe failed (e.g. revoked
   *  creds, network error). Renderers degrade gracefully. */
  quota: QuotaUtilization | null;
  /** Reason the quota probe failed, when `quota` is null. */
  quotaError?: string;
  /** Mirrors the broker's `expiresAt` so the table can show token-life
   *  for accounts whose creds are about to expire. */
  expiresAtMs?: number;
  /** Unix ms when `quota` was captured. Set for CACHED snapshots
   *  (`buildSnapshotsFromCachedState`) so consumers can refuse to treat
   *  stale data as current; undefined for live-probe snapshots (fresh
   *  by construction). */
  capturedAtMs?: number;
}

// ── health classification ────────────────────────────────────────────

/**
 * Threshold above which an account is "throttling" (close enough to a
 * limit that we want the user to know). 80% on either window flips
 * the badge — gives a 20%-buffer warning before the wall.
 */
export const THROTTLING_THRESHOLD_PCT = 80;

/**
 * INFORMATIONAL ALLOWLIST of `overageDisabledReason` values that mean the
 * account has no overage headroom. Replicated from the broker's
 * `OVERAGE_EXHAUSTED_REASONS` (src/auth/broker/account-eligibility.ts) because
 * the plugin can't import across the package boundary — keep the two in sync.
 *
 * These are NOT serve-blocking: the fleet runs on quota, not credits. An account
 * with `out_of_credits` at low util serves fine. `org_level_disabled` → benign
 * (the live active fleet account: overage off but serving fine off subscription).
 * `null` / unknown → benign (deny-by-omission).
 *
 * MUST NEVER gate serving or failover eligibility — informational annotation
 * only (e.g. "overage off (out_of_credits) — serving from quota").
 * Do NOT key on `overageStatus` ("rejected" appears on the healthy account too).
 * The drift test (overage-allowlist-drift.test.ts) guards these two copies stay
 * in sync — update BOTH when this list changes.
 */
const OVERAGE_EXHAUSTED_REASONS = new Set<string>(['out_of_credits']);

/**
 * Decide the health verdict for one account. Binding facts (in order):
 *   - probe failure → unknown
 *   - thin/headerless probe → unknown (no real utilization signal)
 *   - 5h or 7d utilization >= 99.5% → blocked (quota wall)
 *   - either window above 80% → throttling
 *   - everything else → healthy
 *   - probe failure → unknown
 *
 * NOTE: `out_of_credits` (overageDisabledReason) is NOT a serve-block here.
 * The fleet runs on quota, not on overage credits. An account with `out_of_credits`
 * at low util (e.g. carol@example.com at 5h=0%, 7d=2%) serves fine and is a
 * valid failover target. Overage fields are informational only — surfaced as an
 * annotation on healthy/throttling rows, never as a blocked verdict.
 * Failover safety against a real 429 is preserved via the mark-exhausted path.
 */
export function classifyHealth(snap: AccountSnapshot, now: Date = new Date()): AccountHealth {
  if (!snap.quota) return 'unknown';
  const q = snap.quota;
  // #2494 Bug C — a thin/headerless probe (no real utilization signal on
  // EITHER window) must not masquerade as a confident 0% / healthy. Treat it
  // as unknown so the card surfaces a data-quality gap, not "healthy".
  if (isProbeThin(q)) return 'unknown';
  // #2494 Bug A — read utilization through the refill normalization: a window
  // whose reset has already passed has rolled since the snapshot was captured,
  // so its stale high utilization must be treated as 0%. A just-refilled
  // account self-corrects to healthy without an extra probe.
  const norm = refillNormalizedUtils(q, now);
  const max = Math.max(norm.fiveHourUtilizationPct, norm.sevenDayUtilizationPct);
  if (max >= 99.5) return 'blocked';
  if (max >= THROTTLING_THRESHOLD_PCT) return 'throttling';
  return 'healthy';
}

/**
 * Why is a BLOCKED account blocked? Only one cause now: quota exhaustion.
 *   - 'quota-exhausted' — a util window is maxed but recovers when that window
 *     rolls. Show the reset countdown.
 *
 * NOTE: 'billing-dead' has been removed. `out_of_credits` accounts are now
 * healthy (not blocked) — they appear in the HEALTHY group with an informational
 * overage annotation. See classifyHealth for the rationale.
 *
 * Returns null for non-blocked accounts.
 */
export type BlockedReason = 'quota-exhausted';

export function blockedReason(snap: AccountSnapshot, now: Date = new Date()): BlockedReason | null {
  if (classifyHealth(snap, now) !== 'blocked') return null;
  return 'quota-exhausted';
}

/**
 * Which window is the user-visible "binding" one — the one that ran
 * out, or is closer to running out. Returned as a label for headers
 * ("hit 5-hour limit", "hit 7-day limit"). Falls back to whichever
 * window is currently higher.
 */
export type BindingWindow = '5h' | '7d';

export function bindingWindow(q: QuotaUtilization): BindingWindow {
  if (q.representativeClaim === 'seven_day') return '7d';
  if (q.representativeClaim === 'five_hour') return '5h';
  return q.sevenDayUtilizationPct >= q.fiveHourUtilizationPct ? '7d' : '5h';
}

// ── time/format helpers ──────────────────────────────────────────────

/**
 * Render a future Date as a friendly relative countdown ("4h 56m",
 * "in 2d 9h", "in 6m"). Returns "—" for null/past targets so callers
 * can use it inline without null guards.
 */
export function formatRelative(target: Date | null, now: Date = new Date()): string {
  if (!target) return '—';
  const deltaMs = target.getTime() - now.getTime();
  if (deltaMs <= 0) return 'now';
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * Render a Date as a friendly absolute time in the operator's
 * timezone ("Fri 3:50 PM", "Sun 8:00 PM", "Tue 5:00 AM"). The
 * weekday is included because resets often span a day boundary and
 * "5:00 AM" alone is ambiguous.
 *
 * `tz` is forwarded to `toLocaleString`. Defaults to UTC; callers
 * should pass `process.env.TZ` or the agent's configured timezone.
 */
export function formatAbsolute(
  target: Date | null,
  tz: string = 'UTC',
): string {
  if (!target) return '—';
  return target.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Render a future absolute time for the table's Status column, showing the
 * DATE only when it's not "today" in the user's timezone — all in that tz so
 * DST is handled by the tz database (never a hard-coded offset).
 *
 *   - same calendar day as `now` (user tz) → time only: `11:00 PM`
 *   - a different day, but within the next 6 days → weekday + time: `Wed 1:00 AM`
 *   - further out → weekday + day + month + time: `Wed 1 Jul 1:00 AM`
 *
 * `tz` is an IANA tz-database name (e.g. `Australia/Melbourne`); the caller
 * sources it from `SWITCHROOM_TIMEZONE` / `TZ`. Returns "—" for null.
 */
export function formatStatusTime(
  target: Date | null,
  now: Date = new Date(),
  tz: string = 'UTC',
): string {
  if (!target) return '—';
  // Compare calendar dates in the user's tz using en-CA (YYYY-MM-DD) so the
  // "is it today?" test is timezone-correct, not UTC-relative.
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const timeStr = timeFmt.format(target);
  if (dayFmt.format(target) === dayFmt.format(now)) {
    return timeStr;
  }
  // Different day — always include the weekday. Add the day-of-month + month
  // once the target falls outside the current week (≥ 7 days away), where a
  // bare weekday would be ambiguous.
  const withinWeek = target.getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000;
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    ...(withinWeek ? {} : { day: 'numeric', month: 'short' }),
  });
  return `${dateFmt.format(target)} ${timeStr}`;
}

/**
 * Render a utilization percentage for display, CLAMPED to [0, 100].
 *
 * Anthropic's unified rate-limit headers return a decimal utilization that can
 * exceed 1.0 (e.g. 1.01 → 101%) when an account is over its window cap. A
 * displayed value over 100% erodes trust ("how can I be at 101%?"), so the
 * DISPLAYED number is clamped to 100 here at the format boundary. This does NOT
 * mutate the source quota data — `classifyHealth` / `blockedReason` still read
 * the true (possibly >100) value, so the blocked/exhausted state still surfaces
 * via the Status column and the health emoji. Only the rendered number is
 * clamped.
 */
export function fmtPct(pct: number): string {
  return `${Math.min(100, Math.round(pct))}%`;
}

// ── /auth snapshot — Format 2 ────────────────────────────────────────

export interface SnapshotRenderOpts {
  /** Operator-local timezone for absolute reset times. Forwarded to
   *  formatAbsolute. */
  tz?: string;
  now?: Date;
  /** Refresh stamp shown in the footer; usually `Date.now()` of the
   *  most recent live probe. Omit to suppress. */
  liveProbedAtMs?: number;
  /**
   * #2495 Change 2 — the probe-on-open attempted a live refresh but it
   * FAILED, so the card is rendered off the durable cache. When set, the
   * footer shows an explicit "⚠ cached Nm ago" warning (age measured from
   * this `capturedAt`) instead of a false "Live · refreshed 0s ago" stamp.
   * Takes precedence over `liveProbedAtMs`.
   */
  staleCachedAtMs?: number;
  /**
   * Demo mode (the `/usage demo` / `/auth demo` suffix). When true, every
   * account label is run through `maskEmail` before rendering so a screen
   * recording shows stable realistic fakes instead of the operator's real
   * account emails. Off by default — normal output is unchanged. Scope is
   * the email-label PII tier only; topology/percentages/resets are untouched.
   */
  demo?: boolean;
}

/**
 * Apply demo-mode email masking to an account label when `opts.demo` is set,
 * otherwise return the label unchanged. Single helper so the three label
 * render sites stay in lockstep.
 */
function displayLabel(label: string, opts: SnapshotRenderOpts): string {
  return opts.demo ? maskEmail(label) : label;
}

/** Health → State-column emoji for the snapshot table. */
const HEALTH_EMOJI: Record<AccountHealth, string> = {
  healthy: '🟢',
  throttling: '🟡',
  blocked: '🔴',
  unknown: '⚪',
};

/**
 * One-line per-account summary inside its health group.
 *
 *   you@example.com  ● 8% / 20%
 *     5h refills 11:00 AM (in 6m)
 *     7d resets Sun 11:00 AM
 *
 * Three lines for a healthy/throttling row: the label/percent line plus
 * two reset sub-lines (each window on its own line so the 7d segment
 * doesn't wrap mid-line on a narrow phone). The blocked variant replaces
 * the sub-lines with a single recovery countdown.
 */
function renderAccountRow(
  snap: AccountSnapshot,
  opts: SnapshotRenderOpts,
): string[] {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? 'UTC';
  const lines: string[] = [];
  const marker = snap.isActive ? '● ' : '';
  const label = displayLabel(snap.label, opts);

  if (!snap.quota) {
    lines.push(
      `${marker}\`${codeSpanSafe(label)}\`  _quota probe failed_`,
    );
    if (snap.quotaError) {
      lines.push(`  _${escapeMarkdown(snap.quotaError)}_`);
    }
    return lines;
  }

  const q = snap.quota;
  // #2494 Bug C — a thin/headerless probe carries no real utilization; render
  // it as a data-quality gap, never a confident "0% / 0%".
  if (isProbeThin(q)) {
    lines.push(
      `${marker}\`${codeSpanSafe(label)}\`  _quota unknown (thin probe)_`,
    );
    return lines;
  }
  // #2494 Bug A — show refill-normalized utilization so a window that has
  // already reset reads its true post-refill 0%, not the stale capture value.
  const norm = refillNormalizedUtils(q, now);
  const fiveStr = fmtPct(norm.fiveHourUtilizationPct);
  const sevenStr = fmtPct(norm.sevenDayUtilizationPct);
  lines.push(
    `${marker}\`${codeSpanSafe(label)}\`  ${fiveStr} / ${sevenStr}`,
  );

  const health = classifyHealth(snap, now);
  if (health === 'blocked') {
    // quota-exhausted (recoverable): surface only the recovery countdown — the
    // binding window's reset is the only thing that matters until then.
    const win = bindingWindow(q);
    const reset = win === '5h' ? q.fiveHourResetAt : q.sevenDayResetAt;
    const winLabel = win === '5h' ? '5-hour' : '7-day';
    lines.push(
      reset
        ? `  _quota exhausted — back ${formatAbsolute(reset, tz)} (\`in ${formatRelative(reset, now)}\`, ${winLabel} cap)_`
        : `  _quota exhausted — ${winLabel} cap, reset time unknown_`,
    );
    return lines;
  }

  // Healthy / throttling: show whichever window is closer to refresh
  // first, then the other on the next line. Reverses the screenshot's
  // "5h then 7d" ordering when 7d is the more pressing one — the user
  // wants the imminent number first. Each window gets its own line so the
  // second segment doesn't wrap mid-line on a narrow phone screen.
  const fiveResetIn = q.fiveHourResetAt ? q.fiveHourResetAt.getTime() - now.getTime() : Infinity;
  const sevenResetIn = q.sevenDayResetAt ? q.sevenDayResetAt.getTime() - now.getTime() : Infinity;
  const fiveFirst = fiveResetIn <= sevenResetIn;
  const fiveSeg = q.fiveHourResetAt
    ? `5h refills ${formatAbsolute(q.fiveHourResetAt, tz)} (\`in ${formatRelative(q.fiveHourResetAt, now)}\`)`
    : '5h refills —';
  const sevenSeg = q.sevenDayResetAt
    ? `7d resets ${formatAbsolute(q.sevenDayResetAt, tz)} (\`in ${formatRelative(q.sevenDayResetAt, now)}\`)`
    : '7d resets —';
  lines.push(`  _${fiveFirst ? fiveSeg : sevenSeg}_`);
  lines.push(`  _${fiveFirst ? sevenSeg : fiveSeg}_`);
  // Informational overage annotation: if out_of_credits (no overage headroom),
  // surface it as a sub-line on a healthy/throttling row — NOT a blocked badge.
  if (q.overageDisabledReason != null && OVERAGE_EXHAUSTED_REASONS.has(q.overageDisabledReason)) {
    lines.push(
      `  _overage off (${escapeMarkdown(q.overageDisabledReason)}) — serving from quota_`,
    );
  }
  return lines;
}

/**
 * Build the full Format 2 snapshot. Returns ready-to-send Telegram
 * HTML.
 *
 * Structure:
 *   🔋 Auth — fleet status
 *   <empty>
 *   <group> ...accounts grouped by health, blocked-first order...
 *   <empty>
 *   ───────────────────────────
 *   Recommendation: <one-line verdict>
 *   <i>Live · refreshed Ns ago</i>
 *
 * Caller appends an inline keyboard via the returned hint shape (see
 * `buildSnapshotKeyboard` below) — keep the formatting and the
 * keyboard in lockstep so the buttons always reflect current state.
 */
/** Relative-age stamp shared by the live + degraded footers: "0s ago",
 *  "3m ago". Measured against `now` (defaults to wall-clock) so tests with
 *  an injected clock get deterministic output. */
function formatAgeStamp(atMs: number, now: Date = new Date()): string {
  const ageSec = Math.max(0, Math.round((now.getTime() - atMs) / 1000));
  return ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
}

/**
 * Health-group rank for the table's secondary sort (after active-first):
 * problems before good news so the user scans the walled accounts at the top.
 * blocked → throttling → unknown → healthy.
 */
const TABLE_HEALTH_RANK: Record<AccountHealth, number> = {
  blocked: 0,
  throttling: 1,
  unknown: 2,
  healthy: 3,
};

/** Escape a cell value for a GFM table cell: pipes break the column grid, and
 *  newlines break the row. Emails don't normally carry either, but be safe. */
function tableCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The two percent cells (5h / 7d), refill-normalized + clamped, or a
 *  data-quality marker when the probe is missing/thin. */
function pctCells(
  snap: AccountSnapshot,
  now: Date,
): { five: string; seven: string } {
  if (!snap.quota) return { five: '—', seven: '—' };
  if (isProbeThin(snap.quota)) return { five: '?', seven: '?' };
  const norm = refillNormalizedUtils(snap.quota, now);
  return { five: fmtPct(norm.fiveHourUtilizationPct), seven: fmtPct(norm.sevenDayUtilizationPct) };
}

/**
 * The Status cell: for a blocked account, when the binding window comes back
 * (`back <when>`); for a healthy/throttling account, when the soonest window
 * refills (`refills <when>`). `<when>` is the tz-aware absolute time (date shown
 * only when not today) plus the concise relative hint in parens.
 */
function statusCell(snap: AccountSnapshot, now: Date, tz: string): string {
  if (!snap.quota) {
    return snap.quotaError ? `probe failed (${snap.quotaError})` : 'probe failed';
  }
  if (isProbeThin(snap.quota)) return 'quota unknown';
  const q = snap.quota;
  const health = classifyHealth(snap, now);
  if (health === 'blocked') {
    const win = bindingWindow(q);
    const reset = win === '5h' ? q.fiveHourResetAt : q.sevenDayResetAt;
    if (!reset) return 'back — (reset unknown)';
    return `back ${formatStatusTime(reset, now, tz)} (in ${formatRelative(reset, now)})`;
  }
  // healthy / throttling — show the soonest refill across both windows.
  const fiveIn = q.fiveHourResetAt ? q.fiveHourResetAt.getTime() - now.getTime() : Infinity;
  const sevenIn = q.sevenDayResetAt ? q.sevenDayResetAt.getTime() - now.getTime() : Infinity;
  const soonest = fiveIn <= sevenIn ? q.fiveHourResetAt : q.sevenDayResetAt;
  if (!soonest) return 'refills —';
  return `refills ${formatStatusTime(soonest, now, tz)} (in ${formatRelative(soonest, now)})`;
}

export function renderAuthSnapshotFormat2(
  snapshots: AccountSnapshot[],
  opts: SnapshotRenderOpts = {},
): string {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? 'UTC';
  const lines: string[] = [];
  lines.push('🔋 **Auth — fleet status**');

  // Single sorted table: the ACTIVE account always sorts to the top row,
  // regardless of its health group. Remaining rows order by health so
  // problems are visible — blocked → throttling → unknown → healthy — then
  // stable/alpha on label for a deterministic order.
  const ordered = [...snapshots].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const r = TABLE_HEALTH_RANK[classifyHealth(a, now)] - TABLE_HEALTH_RANK[classifyHealth(b, now)];
    if (r !== 0) return r;
    return a.label.localeCompare(b.label);
  });

  if (ordered.length > 0) {
    lines.push('');
    lines.push('| State | Account | 5h | 7d | Status |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const s of ordered) {
      const emoji = HEALTH_EMOJI[classifyHealth(s, now)];
      // Account cell: FULL email, never truncated; active gets a (active) suffix.
      // The black-dot active marker is intentionally removed — the suffix reads.
      const label = displayLabel(s.label, opts);
      // #2701 — the account label is an identifier (email / slug) that can
      // contain markdown-active chars (`_ * ~` etc.). `tableCell` only guards
      // the table grid (`\ | \n`), NOT inline formatting, so a raw label like
      // `ken_max` was parsed as emphasis and corrupted the row. Render it in a
      // code span (backtick content is literal) exactly like renderAccountRow
      // does, defusing embedded backticks via codeSpanSafe. The wrapping
      // backticks still need pipe/newline guarding for the grid, hence the
      // tableCell wrap around the finished span.
      const accountCell = `\`${codeSpanSafe(s.isActive ? `${label} (active)` : label)}\``;
      const { five, seven } = pctCells(s, now);
      const status = statusCell(s, now, tz);
      lines.push(
        `| ${emoji} | ${tableCell(accountCell)} | ${five} | ${seven} | ${tableCell(status)} |`,
      );
    }
  }

  lines.push('');
  lines.push(`_${recommendation(snapshots, now, opts.demo ?? false)}_`);
  // #2495 Change 2 — a failed probe-on-open renders an explicit "cached Nm
  // ago" warning, never a false live stamp. The degraded variant takes
  // precedence over the live stamp.
  if (opts.staleCachedAtMs != null) {
    lines.push(`_⚠ cached ${formatAgeStamp(opts.staleCachedAtMs, now)}_`);
  } else if (opts.liveProbedAtMs != null) {
    lines.push(`_Live · refreshed ${formatAgeStamp(opts.liveProbedAtMs, now)}_`);
  } else {
    lines.push('_Live_');
  }
  return lines.join('\n');
}

/**
 * One-sentence verdict for the snapshot footer. Format C's
 * "recommendation engine" in a minimal form — answers "what should I
 * do?" without hiding the table above.
 *
 * Shapes:
 *   "Stay on <active> — healthy."
 *   "Active <active> is throttling. Best alternative: <healthy>."
 *   "Active <active> is BLOCKED. Switch to <healthy> now."
 *   "All accounts blocked. Earliest recovery: <label> in <eta>."
 */
export function recommendation(
  snapshots: AccountSnapshot[],
  now: Date = new Date(),
  demo = false,
): string {
  const active = snapshots.find((s) => s.isActive);
  if (!active) return 'No active account set.';
  const activeHealth = classifyHealth(active, now);
  const others = snapshots.filter((s) => !s.isActive);
  const healthyAlt = others.find((s) => classifyHealth(s, now) === 'healthy');
  // Demo mode masks the email labels that appear in the recommendation
  // sentence, in lockstep with the per-account rows above.
  const lbl = (s: AccountSnapshot) => (demo ? maskEmail(s.label) : s.label);
  const activeLabel = lbl(active);

  if (activeHealth === 'healthy') {
    return `Recommendation: stay on ${activeLabel}.`;
  }

  if (activeHealth === 'throttling') {
    if (healthyAlt) {
      return `Recommendation: active ${activeLabel} is throttling. Switch to ${lbl(healthyAlt)} for headroom.`;
    }
    return `Recommendation: active ${activeLabel} is throttling; no healthy alternative — wait for refill.`;
  }

  if (activeHealth === 'blocked') {
    if (healthyAlt) {
      return `Recommendation: active ${activeLabel} is BLOCKED — switch to ${lbl(healthyAlt)} now.`;
    }
    // #2494 Bug B — no healthy alternative. Do NOT collapse to "All accounts
    // blocked": that's only honest when EVERY account is truly walled with no
    // usable or imminently-refilling slot. Distinguish the buckets first.
    return summarizeNoHealthyAlt(snapshots, now, demo);
  }

  // unknown
  return `Active ${activeLabel}: quota probe failed; broker last_seen unknown.`;
}

/**
 * #2494 Bug B — honest fleet summary when the active account is blocked and no
 * fully-healthy alternative exists. Buckets every account so the summary never
 * claims "all blocked" while a throttling / imminently-refilling / usable slot
 * exists. Surfaces the soonest refill ETA across the fleet.
 */
function summarizeNoHealthyAlt(snapshots: AccountSnapshot[], now: Date, demo = false): string {
  const mask = (label: string) => (demo ? maskEmail(label) : label);
  let throttlingLabel: string | null = null;
  let allTrulyBlocked = true;
  for (const s of snapshots) {
    const h = classifyHealth(s, now);
    if (h === 'throttling') {
      // A throttling account is still usable.
      if (!throttlingLabel) throttlingLabel = s.label;
      allTrulyBlocked = false;
    } else if (h === 'healthy' || h === 'unknown') {
      // Healthy is handled by the caller; unknown is not provably blocked.
      allTrulyBlocked = false;
    } else if (h === 'blocked' && blockedReason(s, now) === 'quota-exhausted') {
      // Quota-exhausted recovers WHEN its window rolls — but only counts as
      // "refilling" (not terminal) if it actually carries a future reset on the
      // binding window. A maxed window with no reset timestamp has no imminent
      // recovery and stays in the truly-blocked bucket (Bug B: "blocked = ≥99.5%
      // AND no imminent reset").
      if (s.quota) {
        const win = bindingWindow(s.quota);
        const at = win === '5h' ? s.quota.fiveHourResetAt : s.quota.sevenDayResetAt;
        if (at && at.getTime() > now.getTime()) allTrulyBlocked = false;
      }
    }
  }

  const earliestRecovery = pickEarliestRecovery(snapshots, now);

  if (throttlingLabel) {
    // A usable (throttling) slot exists — recommend it, with the soonest refill.
    const eta = earliestRecovery
      ? ` Soonest full refill: ${mask(earliestRecovery.label)} in ${formatRelative(earliestRecovery.at, now)}.`
      : '';
    return `No fully-healthy account; ${mask(throttlingLabel)} is throttling but still usable.${eta}`;
  }

  if (!allTrulyBlocked) {
    // No usable slot now, but at least one account is refilling — not all dead.
    if (earliestRecovery) {
      return `All accounts at capacity; soonest refill: ${mask(earliestRecovery.label)} in ${formatRelative(earliestRecovery.at, now)}.`;
    }
    return `All accounts at capacity — waiting on a window refill.`;
  }

  // Genuinely all blocked (quota-exhausted with no upcoming reset, or no data).
  if (earliestRecovery) {
    return `All accounts blocked. Earliest recovery: ${mask(earliestRecovery.label)} in ${formatRelative(earliestRecovery.at, now)}.`;
  }
  return `All accounts blocked. Run /auth add to attach another subscription.`;
}

/**
 * Earliest refill ETA across the fleet. #2494 Bug A/B — only counts a future
 * reset on the binding window; a window whose reset has already passed has
 * refilled (handled by refill normalization) and is not "recovery pending".
 */
function pickEarliestRecovery(
  snapshots: AccountSnapshot[],
  now: Date,
): { label: string; at: Date } | null {
  let best: { label: string; at: Date } | null = null;
  for (const s of snapshots) {
    if (!s.quota) continue;
    if (isProbeThin(s.quota)) continue;
    const win = bindingWindow(s.quota);
    const at = win === '5h' ? s.quota.fiveHourResetAt : s.quota.sevenDayResetAt;
    if (!at || at.getTime() <= now.getTime()) continue;
    if (!best || at.getTime() < best.at.getTime()) {
      best = { label: s.label, at };
    }
  }
  return best;
}

// ── auto-fallback announcement (causal) ──────────────────────────────

export interface FallbackAnnouncementInput {
  /** Account that just hit a limit. */
  oldLabel: string;
  /** Quota snapshot for the old account *at the moment of failure*.
   *  Used to name the limit type and recovery time. */
  oldQuota: QuotaUtilization | null;
  /** Account we just switched to. Null when no fallback was possible. */
  newLabel: string | null;
  /** Quota snapshot for the new account, for headroom messaging. */
  newQuota: QuotaUtilization | null;
  /** Agent that triggered the fallback (for context — fleet swap
   *  affects all agents but the user wants to know which one tripped). */
  triggerAgent: string;
  /**
   * Bug 3 — the full per-account fleet snapshot, threaded in so the all-blocked
   * card can enumerate EVERY account (5h%/7d% + recovery ETA), not just the one
   * triggering account. Built by `buildSnapshotsFromState` one frame up in
   * `runFleetAutoFallback`. Optional/back-compat: when absent (or empty), the
   * all-blocked branch falls back to the old single-account shape.
   *
   * ONLY consumed on the all-blocked branch. The successful-swap branch already
   * shows the target's headroom and is unchanged.
   */
  fleetSnapshots?: AccountSnapshot[];
  tz?: string;
  now?: Date;
}

/**
 * Render the causal-shape fallback announcement.
 *
 *   ✓ Switched fleet · 5-hour limit on alice
 *
 *   alice@example → you@example.com
 *   Triggered by: agent carrie
 *
 *   alice recovers Fri 3:50 PM (in 4h 56m)
 *   you now: 8% of 5h · 20% of 7d (plenty of headroom)
 *
 * Falls back to a different shape when no eligible target was found
 * (`newLabel === null`) — see "all-blocked" branch.
 */
export function renderFallbackAnnouncement(input: FallbackAnnouncementInput): string {
  const now = input.now ?? new Date();
  const tz = input.tz ?? 'UTC';
  const lines: string[] = [];

  const limitWord = input.oldQuota ? limitWordFor(input.oldQuota) : 'quota';
  const headerLimit = limitWord === 'quota' ? 'quota cap' : `${limitWord} limit`;

  if (!input.newLabel) {
    // All-blocked path — no swap occurred. Tell user what's broken and, so they
    // can VERIFY the fleet is truly exhausted, enumerate EVERY account's 5h%/7d%
    // + recovery ETA (Bug 3) — not just the one triggering account. Reuses the
    // same per-account row + earliest-recovery helpers the /auth table uses so
    // the formatting stays consistent with the rest of the auth surface.
    lines.push(
      `🔴 **All accounts blocked · ${headerLimit} on ${escapeMarkdown(input.oldLabel)}**`,
    );
    lines.push('');
    lines.push(`Triggered by: agent **${escapeMarkdown(input.triggerAgent)}**`);

    const fleet = input.fleetSnapshots ?? [];
    if (fleet.length > 0) {
      lines.push('');
      const rowOpts: SnapshotRenderOpts = { now, tz };
      // Blocked-first ordering mirrors renderAuthSnapshotFormat2 — the user
      // scans the walled accounts (and their recovery times) at the top, with
      // the active account floating first within its group.
      const healthOrder: AccountHealth[] = ['blocked', 'throttling', 'healthy', 'unknown'];
      const rank = (s: AccountSnapshot): number => healthOrder.indexOf(classifyHealth(s, now));
      const ordered = [...fleet].sort(
        (a, b) => rank(a) - rank(b) || Number(b.isActive) - Number(a.isActive),
      );
      for (const snap of ordered) {
        for (const ln of renderAccountRow(snap, rowOpts)) lines.push(ln);
      }
      const earliest = pickEarliestRecovery(fleet, now);
      if (earliest) {
        lines.push('');
        lines.push(
          `Earliest recovery: \`${codeSpanSafe(earliest.label)}\` ` +
            `${formatAbsolute(earliest.at, tz)} (in ${formatRelative(earliest.at, now)})`,
        );
      }
    } else if (input.oldQuota) {
      // Back-compat: no fleet snapshot supplied → old single-account shape.
      const recovery = recoveryAtFor(input.oldQuota);
      if (recovery) {
        lines.push(
          `${escapeMarkdown(input.oldLabel)} recovers ${formatAbsolute(recovery, tz)} ` +
            `(in ${formatRelative(recovery, now)})`,
        );
      }
    }
    lines.push('');
    lines.push(
      `Run \`/auth add <label>\` to attach another subscription, ` +
        `or \`/auth refresh\` to re-probe.`,
    );
    return lines.join('\n');
  }

  // Successful swap.
  lines.push(
    `✓ **Switched fleet · ${headerLimit} on ${escapeMarkdown(input.oldLabel)}**`,
  );
  lines.push('');
  lines.push(
    `\`${codeSpanSafe(input.oldLabel)}\` → \`${codeSpanSafe(input.newLabel)}\``,
  );
  lines.push(`Triggered by: agent **${escapeMarkdown(input.triggerAgent)}**`);
  lines.push('');

  if (input.oldQuota) {
    const recovery = recoveryAtFor(input.oldQuota);
    if (recovery) {
      lines.push(
        `\`${codeSpanSafe(input.oldLabel)}\` recovers ` +
          `${formatAbsolute(recovery, tz)} (in ${formatRelative(recovery, now)})`,
      );
    }
  }

  if (input.newQuota) {
    const fiveStr = fmtPct(input.newQuota.fiveHourUtilizationPct);
    const sevenStr = fmtPct(input.newQuota.sevenDayUtilizationPct);
    const hasHeadroom =
      input.newQuota.fiveHourUtilizationPct < THROTTLING_THRESHOLD_PCT &&
      input.newQuota.sevenDayUtilizationPct < THROTTLING_THRESHOLD_PCT;
    const headroomStr = hasHeadroom ? '_(plenty of headroom)_' : '_(near limit — watch this)_';
    lines.push(
      `\`${codeSpanSafe(input.newLabel)}\` now: ${fiveStr} of 5h · ${sevenStr} of 7d ${headroomStr}`,
    );
  } else {
    lines.push(
      `_(quota probe for new account is pending — will reflect on next /auth)_`,
    );
  }

  return lines.join('\n');
}

/** Pick which window to name in the headline. */
function limitWordFor(q: QuotaUtilization): '5-hour' | '7-day' | 'quota' {
  // If a representative-claim is present and the named window is
  // actually maxed, name it. Otherwise pick by which window is
  // higher.
  if (q.representativeClaim === 'seven_day' && q.sevenDayUtilizationPct >= 99) return '7-day';
  if (q.representativeClaim === 'five_hour' && q.fiveHourUtilizationPct >= 99) return '5-hour';
  if (q.sevenDayUtilizationPct >= 99) return '7-day';
  if (q.fiveHourUtilizationPct >= 99) return '5-hour';
  // Throttling case (called pre-emptively): prefer the higher one.
  return q.sevenDayUtilizationPct >= q.fiveHourUtilizationPct ? '7-day' : '5-hour';
}

function recoveryAtFor(q: QuotaUtilization): Date | null {
  const word = limitWordFor(q);
  if (word === '7-day') return q.sevenDayResetAt;
  if (word === '5-hour') return q.fiveHourResetAt;
  // Both windows healthy (called pre-emptively under explicit trigger):
  // earliest reset wins.
  if (!q.fiveHourResetAt) return q.sevenDayResetAt;
  if (!q.sevenDayResetAt) return q.fiveHourResetAt;
  return q.fiveHourResetAt.getTime() < q.sevenDayResetAt.getTime()
    ? q.fiveHourResetAt
    : q.sevenDayResetAt;
}

// ── inline keyboard hints ────────────────────────────────────────────

export interface KeyboardButton {
  text: string;
  /** Either a callback_data string (tap-to-action) or a switch_inline
   *  hint. We model both as a discriminated union so the gateway can
   *  trivially translate to grammy's keyboard builder. */
  callbackData?: string;
  /** Convenience for buttons that paste a slash-command into the input. */
  insertText?: string;
}

export type KeyboardRow = KeyboardButton[];

export interface SnapshotKeyboardOpts {
  /** Limit how many "Switch → X" buttons we render. Beyond this, the
   *  user can drill in via /usage. Default 3. */
  maxSwitchButtons?: number;
  /** #2495 folded nit A — clock for health classification, threaded so the
   *  keyboard agrees with the card body instead of defaulting to a second
   *  `new Date()`. Defaults to wall-clock. */
  now?: Date;
}

/**
 * Build the inline keyboard for the /auth snapshot.
 *
 * Smart-hide rules (per JTBD — never tempt the user to switch into a
 * blocked account):
 *   - Switch buttons render only for HEALTHY non-active accounts.
 *   - If active is healthy, switch buttons are still shown but
 *     deprioritized (the recommendation footer says "stay").
 *   - "Refresh" always present (forces fresh quota probes).
 *   - Bottom row: /usage, + Add (admin shows full menu).
 */
export function buildSnapshotKeyboard(
  snapshots: AccountSnapshot[],
  opts: SnapshotKeyboardOpts = {},
): KeyboardRow[] {
  const max = opts.maxSwitchButtons ?? 3;
  const now = opts.now ?? new Date();
  const rows: KeyboardRow[] = [];

  // Switch buttons — healthy non-active first, then throttling
  // non-active. Skip blocked entirely.
  const switchTargets = snapshots
    .filter((s) => !s.isActive)
    .sort((a, b) => switchPriority(a, now) - switchPriority(b, now))
    .filter((s) => classifyHealth(s, now) !== 'blocked' && classifyHealth(s, now) !== 'unknown')
    .slice(0, max);

  for (const t of switchTargets) {
    rows.push([
      {
        text: `Switch fleet → ${t.label}`,
        callbackData: `auth:use:${t.label}`,
      },
    ]);
  }

  rows.push([
    { text: '↻ Refresh', callbackData: 'auth:refresh' },
    { text: '/usage', insertText: '/usage' },
    { text: '+ Add', insertText: '/auth add ' },
  ]);

  return rows;
}

/** Lower number = higher priority for "switch to me" button. */
function switchPriority(s: AccountSnapshot, now: Date = new Date()): number {
  const h = classifyHealth(s, now);
  if (h === 'healthy') return 0;
  if (h === 'throttling') return 1;
  if (h === 'unknown') return 2;
  return 3; // blocked
}

// ── shared HTML escape ───────────────────────────────────────────────

// ── snapshot assembly helper ─────────────────────────────────────────

/**
 * Given the broker's `listState` data + a parallel array of live quota
 * results (same length, same order), return the AccountSnapshot[] the
 * formatters need.
 *
 * The gateway calls this after probing quota via the broker
 * `probe-quota` op (#1336) — both arrays are caller-provided, this
 * is just a zip + classify.
 */
export function buildSnapshotsFromState(
  state: ListStateData,
  quotas: QuotaResult[],
): AccountSnapshot[] {
  const out: AccountSnapshot[] = [];
  for (let i = 0; i < state.accounts.length; i++) {
    const acc: AccountState = state.accounts[i]!;
    const q = quotas[i];
    out.push({
      label: acc.label,
      isActive: acc.label === state.active,
      quota: q && q.ok ? q.data : null,
      quotaError: q && !q.ok ? q.reason : undefined,
      expiresAtMs: acc.expiresAt,
    });
  }
  return out;
}

/**
 * Convert a broker-side `LastQuotaSnapshot` (dates as ISO strings) into a
 * `QuotaUtilization` (dates as `Date | null`). Returns null when the
 * input snapshot is absent or null (no probe has run since broker start).
 *
 * Used by the quota-watch loop to build `AccountSnapshot[]` from cached
 * broker state without triggering a live Anthropic network call.
 */
export function reviveLastQuota(snap: LastQuotaSnapshot | null | undefined): QuotaUtilization | null {
  if (!snap) return null;
  return {
    fiveHourUtilizationPct: snap.fiveHourUtilizationPct,
    sevenDayUtilizationPct: snap.sevenDayUtilizationPct,
    fiveHourResetAt: snap.fiveHourResetAt ? new Date(snap.fiveHourResetAt) : null,
    sevenDayResetAt: snap.sevenDayResetAt ? new Date(snap.sevenDayResetAt) : null,
    representativeClaim: snap.representativeClaim,
    overageStatus: snap.overageStatus,
    overageDisabledReason: snap.overageDisabledReason,
    // #2494 Bug C — forward the header-presence markers so a cached thin probe
    // still renders as `unknown`, not a confident 0%.
    fiveHourUtilPresent: snap.fiveHourUtilPresent,
    sevenDayUtilPresent: snap.sevenDayUtilPresent,
  };
}

/**
 * Build AccountSnapshot[] from broker listState using only the
 * broker's in-memory last_quota cache — no live Anthropic probe.
 * Accounts with no cached snapshot will have `quota: null`, causing
 * `classifyHealth` to return 'unknown' and the quota-watch loop to skip them.
 *
 * This is the cheap classification path for the 15-minute poll loop.
 * The live probeQuota path (`buildSnapshotsFromState`) is reserved for
 * user-initiated /auth commands and notification body enrichment.
 */
export function buildSnapshotsFromCachedState(
  state: ListStateData,
): AccountSnapshot[] {
  return state.accounts.map((acc) => {
    const lq = acc.last_quota ?? null;
    return {
      label: acc.label,
      isActive: acc.label === state.active,
      quota: reviveLastQuota(lq),
      quotaError: lq ? undefined : 'no cached quota (no probe since broker start)',
      expiresAtMs: acc.expiresAt,
      // Surface the cache age so quota-watch can refuse to classify off
      // stale data (the 2026-06-09 incident: a recovery latched days
      // earlier only surfaced — and notified — at the next fleet bounce).
      capturedAtMs: lq?.capturedAt,
    };
  });
}
