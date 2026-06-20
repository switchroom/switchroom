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
 * the per-line `escapeHtml` helper below is the place to gate.
 */

import type { QuotaResult, QuotaUtilization } from './quota-check.js';
import type { AccountState, LastQuotaSnapshot, ListStateData } from '../src/auth/broker/client.js';

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
 * STRICT ALLOWLIST of serve-blocking `overageDisabledReason` values. Replicated
 * verbatim from the broker's `SERVE_BLOCKING_OVERAGE_REASONS`
 * (src/auth/broker/account-eligibility.ts) because the plugin can't import
 * across the package boundary cleanly — keep the two in sync.
 *
 * `out_of_credits` → blocked (the account is dead even at 0% util).
 * `org_level_disabled` → BENIGN (the live active fleet account: overage off but
 * still serving off subscription). `null` / unknown → benign (deny-by-omission).
 * Do NOT key on `overageStatus` ("rejected" appears on the healthy account too).
 * Any new reason here is production-affecting — confirm with the operator first.
 */
const SERVE_BLOCKING_OVERAGE_REASONS = new Set<string>(['out_of_credits']);

/**
 * Decide the health verdict for one account. The two "binding" facts:
 *   - overageDisabledReason is serve-blocking (out_of_credits) → blocked,
 *     even at 0% util (the account is dead until billing is fixed)
 *   - 5h or 7d utilization >= 100% (or `representativeClaim` non-null
 *     plus utilization >= 99.5%) → blocked
 *   - either window above 80%, or representativeClaim set with > 50% →
 *     throttling
 *   - everything else → healthy
 *   - probe failure → unknown
 */
export function classifyHealth(snap: AccountSnapshot): AccountHealth {
  if (!snap.quota) return 'unknown';
  const q = snap.quota;
  // A serve-blocking overage reason wins over the util gate: a credits-dead
  // account reads 0% util but 429s on every call, so it must show 'blocked'
  // (drives the display, quota-watch, and the auto-fallback idempotency guard).
  if (q.overageDisabledReason != null && SERVE_BLOCKING_OVERAGE_REASONS.has(q.overageDisabledReason)) {
    return 'blocked';
  }
  const max = Math.max(q.fiveHourUtilizationPct, q.sevenDayUtilizationPct);
  if (max >= 99.5) return 'blocked';
  if (max >= THROTTLING_THRESHOLD_PCT) return 'throttling';
  return 'healthy';
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

/** Round-trim percentage to 1 dp (more precision is noise on a UX). */
export function fmtPct(pct: number): string {
  return `${Math.round(pct)}%`;
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
}

/**
 * Header line shape: emoji + group title + count.
 *
 *   🟢 HEALTHY (4)
 *   🟡 ACTIVE — REFRESHING SOON (1)
 *   🔴 BLOCKED (1)
 *   ⚪ UNKNOWN (1)
 */
function groupHeader(health: AccountHealth, count: number): string {
  const emoji = HEALTH_EMOJI[health];
  const title = HEALTH_TITLE[health];
  return `${emoji} <b>${title}</b> (${count})`;
}

const HEALTH_EMOJI: Record<AccountHealth, string> = {
  healthy: '🟢',
  throttling: '🟡',
  blocked: '🔴',
  unknown: '⚪',
};

const HEALTH_TITLE: Record<AccountHealth, string> = {
  healthy: 'HEALTHY',
  throttling: 'THROTTLING',
  blocked: 'BLOCKED',
  unknown: 'UNKNOWN',
};

/**
 * One-line per-account summary inside its health group.
 *
 *   you@example.com  ● 8% / 20%
 *     5h refills 11:00 AM (in 6m)  ·  7d resets Sun 11:00 AM
 *
 * Two lines actually: the label/percent line and a sub-line with the
 * reset details. The blocked variant replaces the sub-line with the
 * recovery countdown.
 */
function renderAccountRow(
  snap: AccountSnapshot,
  opts: SnapshotRenderOpts,
): string[] {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? 'UTC';
  const lines: string[] = [];
  const marker = snap.isActive ? '● ' : '';

  if (!snap.quota) {
    lines.push(
      `${marker}<code>${escapeHtml(snap.label)}</code>  <i>quota probe failed</i>`,
    );
    if (snap.quotaError) {
      lines.push(`  <i>${escapeHtml(snap.quotaError)}</i>`);
    }
    return lines;
  }

  const q = snap.quota;
  const fiveStr = fmtPct(q.fiveHourUtilizationPct);
  const sevenStr = fmtPct(q.sevenDayUtilizationPct);
  lines.push(
    `${marker}<code>${escapeHtml(snap.label)}</code>  ${fiveStr} / ${sevenStr}`,
  );

  const health = classifyHealth(snap);
  if (health === 'blocked') {
    // Surface only the recovery countdown — the binding window's reset
    // is the only thing that matters until then.
    const win = bindingWindow(q);
    const reset = win === '5h' ? q.fiveHourResetAt : q.sevenDayResetAt;
    const winLabel = win === '5h' ? '5-hour' : '7-day';
    lines.push(
      `  <i>back ${formatAbsolute(reset, tz)} (in ${formatRelative(reset, now)}, ${winLabel} cap)</i>`,
    );
    return lines;
  }

  // Healthy / throttling: show whichever window is closer to refresh
  // first, then the other on the same line. Reverses the screenshot's
  // "5h then 7d" ordering when 7d is the more pressing one — the user
  // wants the imminent number first.
  const fiveResetIn = q.fiveHourResetAt ? q.fiveHourResetAt.getTime() - now.getTime() : Infinity;
  const sevenResetIn = q.sevenDayResetAt ? q.sevenDayResetAt.getTime() - now.getTime() : Infinity;
  const fiveFirst = fiveResetIn <= sevenResetIn;
  const fiveSeg = q.fiveHourResetAt
    ? `5h refills ${formatAbsolute(q.fiveHourResetAt, tz)} (in ${formatRelative(q.fiveHourResetAt, now)})`
    : '5h refills —';
  const sevenSeg = q.sevenDayResetAt
    ? `7d resets ${formatAbsolute(q.sevenDayResetAt, tz)} (in ${formatRelative(q.sevenDayResetAt, now)})`
    : '7d resets —';
  lines.push(`  <i>${fiveFirst ? fiveSeg : sevenSeg}  ·  ${fiveFirst ? sevenSeg : fiveSeg}</i>`);
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
export function renderAuthSnapshotFormat2(
  snapshots: AccountSnapshot[],
  opts: SnapshotRenderOpts = {},
): string {
  const now = opts.now ?? new Date();
  const lines: string[] = [];
  lines.push('🔋 <b>Auth — fleet status</b>');

  // Group by health. Render BLOCKED first (it's the urgent action),
  // then THROTTLING (potential next problem), then HEALTHY (good
  // news), then UNKNOWN (data quality issue). The active account
  // floats to the top of its group regardless.
  const order: AccountHealth[] = ['blocked', 'throttling', 'healthy', 'unknown'];
  const grouped = new Map<AccountHealth, AccountSnapshot[]>();
  for (const s of snapshots) {
    const h = classifyHealth(s);
    if (!grouped.has(h)) grouped.set(h, []);
    grouped.get(h)!.push(s);
  }
  // Within each group, active first.
  for (const arr of grouped.values()) {
    arr.sort((a, b) => Number(b.isActive) - Number(a.isActive));
  }

  for (const h of order) {
    const arr = grouped.get(h);
    if (!arr || arr.length === 0) continue;
    lines.push('');
    lines.push(groupHeader(h, arr.length));
    for (const s of arr) {
      for (const ln of renderAccountRow(s, opts)) lines.push(ln);
    }
  }

  lines.push('');
  lines.push('────────────────────────────');
  lines.push(`<i>${recommendation(snapshots, now)}</i>`);
  if (opts.liveProbedAtMs != null) {
    const ageSec = Math.max(0, Math.round((Date.now() - opts.liveProbedAtMs) / 1000));
    const ageStr = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
    lines.push(`<i>Live · refreshed ${ageStr}</i>`);
  } else {
    lines.push('<i>Live</i>');
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
export function recommendation(snapshots: AccountSnapshot[], now: Date = new Date()): string {
  const active = snapshots.find((s) => s.isActive);
  if (!active) return 'No active account set.';
  const activeHealth = classifyHealth(active);
  const others = snapshots.filter((s) => !s.isActive);
  const healthyAlt = others.find((s) => classifyHealth(s) === 'healthy');

  if (activeHealth === 'healthy') {
    return `Recommendation: stay on ${active.label}.`;
  }

  if (activeHealth === 'throttling') {
    if (healthyAlt) {
      return `Recommendation: active ${active.label} is throttling. Switch to ${healthyAlt.label} for headroom.`;
    }
    return `Recommendation: active ${active.label} is throttling; no healthy alternative — wait for refill.`;
  }

  if (activeHealth === 'blocked') {
    if (healthyAlt) {
      return `Recommendation: active ${active.label} is BLOCKED — switch to ${healthyAlt.label} now.`;
    }
    // No healthy alternative; surface the earliest recovery time.
    const earliestRecovery = pickEarliestRecovery(snapshots, now);
    if (earliestRecovery) {
      return `All accounts blocked. Earliest recovery: ${earliestRecovery.label} in ${formatRelative(earliestRecovery.at, now)}.`;
    }
    return `All accounts blocked. Run /auth add to attach another subscription.`;
  }

  // unknown
  return `Active ${active.label}: quota probe failed; broker last_seen unknown.`;
}

function pickEarliestRecovery(
  snapshots: AccountSnapshot[],
  now: Date,
): { label: string; at: Date } | null {
  let best: { label: string; at: Date } | null = null;
  for (const s of snapshots) {
    if (!s.quota) continue;
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
    // All-blocked path — no swap occurred. Tell user what's broken
    // and when the earliest reset is.
    lines.push(
      `🔴 <b>All accounts blocked · ${headerLimit} on ${escapeHtml(input.oldLabel)}</b>`,
    );
    lines.push('');
    lines.push(`Triggered by: agent <b>${escapeHtml(input.triggerAgent)}</b>`);
    if (input.oldQuota) {
      const recovery = recoveryAtFor(input.oldQuota);
      if (recovery) {
        lines.push(
          `${escapeHtml(input.oldLabel)} recovers ${formatAbsolute(recovery, tz)} ` +
            `(in ${formatRelative(recovery, now)})`,
        );
      }
    }
    lines.push('');
    lines.push(
      `Run <code>/auth add &lt;label&gt;</code> to attach another subscription, ` +
        `or <code>/auth refresh</code> to re-probe.`,
    );
    return lines.join('\n');
  }

  // Successful swap.
  lines.push(
    `✓ <b>Switched fleet · ${headerLimit} on ${escapeHtml(input.oldLabel)}</b>`,
  );
  lines.push('');
  lines.push(
    `<code>${escapeHtml(input.oldLabel)}</code> → <code>${escapeHtml(input.newLabel)}</code>`,
  );
  lines.push(`Triggered by: agent <b>${escapeHtml(input.triggerAgent)}</b>`);
  lines.push('');

  if (input.oldQuota) {
    const recovery = recoveryAtFor(input.oldQuota);
    if (recovery) {
      lines.push(
        `<code>${escapeHtml(input.oldLabel)}</code> recovers ` +
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
    const headroomStr = hasHeadroom ? '<i>(plenty of headroom)</i>' : '<i>(near limit — watch this)</i>';
    lines.push(
      `<code>${escapeHtml(input.newLabel)}</code> now: ${fiveStr} of 5h · ${sevenStr} of 7d ${headroomStr}`,
    );
  } else {
    lines.push(
      `<i>(quota probe for new account is pending — will reflect on next /auth)</i>`,
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
  const rows: KeyboardRow[] = [];

  // Switch buttons — healthy non-active first, then throttling
  // non-active. Skip blocked entirely.
  const switchTargets = snapshots
    .filter((s) => !s.isActive)
    .sort((a, b) => switchPriority(a) - switchPriority(b))
    .filter((s) => classifyHealth(s) !== 'blocked' && classifyHealth(s) !== 'unknown')
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
function switchPriority(s: AccountSnapshot): number {
  const h = classifyHealth(s);
  if (h === 'healthy') return 0;
  if (h === 'throttling') return 1;
  if (h === 'unknown') return 2;
  return 3; // blocked
}

// ── shared HTML escape ───────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
