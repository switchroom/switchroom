/**
 * Quota-bar block — a compact per-account ASCII-bar rendering of the 5-hour
 * and 7-day utilization windows, for a live-refreshing Telegram card.
 *
 * JTBD: "at a glance, how much headroom does each account have, and how far
 * through its reset window are we" — denser than the `/auth` table (Format 2,
 * `auth-snapshot-format.ts`), meant for a small always-visible strip rather
 * than a full snapshot.
 *
 * Locked output shape (operator-confirmed via live Telegram iteration —
 * do not reformat without re-confirming):
 *
 * ```
 * - **you@example.com** (active)
 * - 🟢 5h `[┃░░░░░░░░░] 0% / 4h20m left`
 * - 🟡 7d `[████┃█░░░░] 47% / 3d1h left`
 * - **alice@example.com** (exhausted)
 * - 🟢 5h `[┃░░░░░░░░░] 0% / resets now`
 * - 🔴 7d `[██████┃███] 100% / 2d16h left`
 * ```
 *
 * Rules:
 *   1. GFM `- ` bullet marker on EVERY line, including the account title
 *      line — a tight one-item-per-line list, no blank lines between rows
 *      (a no-bullet hard-break variant was tried live and rejected as
 *      "worse" — bullets are the final mechanism).
 *   2. Title line: `- **<email>** (<status>)`, status derived from data
 *      (`active` | `exhausted` | `idle` — see `accountStatus`).
 *   3. One row per window (5h, 7d): `- <dot> <window> \`[<bar>] <pct>% /
 *      <time-left>\``.
 *   4. Bar is 10 cells of `█` (filled, proportional to utilization) /
 *      `░` (empty), with a single `┃` "pace" tick marking how far through
 *      the reset window we currently are. The tick ALWAYS renders at its
 *      computed position, overriding whatever fill character is there —
 *      even at 100% utilization — since the pace signal must stay visible
 *      (operator-confirmed; see `buildBar`).
 */

import type { QuotaUtilization } from './quota-check.js';
import { refillNormalizedUtils, isProbeThin } from '../src/auth/quota.js';
import type { AccountState, ListStateData } from '../src/auth/broker/client.js';
import { reviveLastQuota, recommendation, type AccountSnapshot } from './auth-snapshot-format.js';
import { escapeMarkdown } from './card-format.js';
import { maskEmail } from './demo-mask.js';
import { formatExternalSpendBlock } from './external-spend.js';

// ── dot thresholds ───────────────────────────────────────────────────

/**
 * Per-row status dot, purely a function of THAT window's own utilization
 * percentage (not the account's overall exhausted flag — an exhausted
 * account can still show a green 5h row if that window is fresh).
 *
 *   - < 50%  → 🟢 healthy
 *   - 50-89% → 🟡 getting close
 *   - >= 90% → 🔴 at/near the wall
 */
export function pickDot(pct: number): '🟢' | '🟡' | '🔴' {
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped >= 90) return '🔴';
  if (clamped >= 50) return '🟡';
  return '🟢';
}

// ── time-left formatting ─────────────────────────────────────────────

/**
 * Compact time-left string for the quota-bar row: `4h20m left`,
 * `3d1h left`, `45m left`, or `resets now` when the reset has already
 * passed (or is unknown — no reset timestamp to count down to).
 *
 * Deliberately more compact than `formatRelative` in
 * `auth-snapshot-format.ts` (no space between the number and unit) to
 * keep the fixed-width code-span row from wrapping on a phone screen.
 */
export function formatTimeLeft(target: Date | null, now: Date = new Date()): string {
  if (!target) return 'resets now';
  const deltaMs = target.getTime() - now.getTime();
  // A malformed reset timestamp (invalid Date → NaN delta) must not leak a
  // `"NaNm left"` string; treat a non-finite delta as "resets now".
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 'resets now';
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 60) return `${totalMin}m left`;
  const totalHours = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (totalHours < 24) return `${totalHours}h${m}m left`;
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d${h}h left` : `${d}d left`;
}

// ── pace (elapsed-through-window) fraction ───────────────────────────

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far through the reset window we currently are, as a 0..1 fraction,
 * derived from the time LEFT to reset and the window's nominal duration
 * (we're never told the window's start time, only its end/reset — so this
 * is an approximation, not an exact elapsed-time read).
 *
 *   - no reset timestamp, or reset already passed → 0 (treat as a freshly
 *     started window rather than claiming we're at the very end of one we
 *     have no data for)
 *   - otherwise → `1 - timeLeftMs / windowDurationMs`, clamped to [0, 1]
 */
export function elapsedFraction(
  target: Date | null,
  windowDurationMs: number,
  now: Date = new Date(),
): number {
  if (!target) return 0;
  const timeLeftMs = target.getTime() - now.getTime();
  // A malformed reset timestamp (invalid Date → NaN delta) must not corrupt
  // the tick placement; treat a non-finite delta as a freshly-started window.
  if (!Number.isFinite(timeLeftMs) || timeLeftMs <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - timeLeftMs / windowDurationMs));
}

// ── bar rendering ─────────────────────────────────────────────────────

const BAR_WIDTH = 10;

/**
 * Build the 10-cell `[█…░…]` bar body (no surrounding brackets — callers
 * add those) for one window row.
 *
 *   - `fillCount = round(pct / 100 * 10)` cells are `█` from the left.
 *   - a single `┃` pace tick is placed at
 *     `round(elapsedFrac * (width - 1))`, and ALWAYS overwrites whatever
 *     cell is there — including a filled `█` cell, even at 100% utilization
 *     (rule 4 above; the pace signal must always be visible).
 */
export function buildBar(pct: number, elapsedFrac: number): string {
  const clampedPct = Math.max(0, Math.min(100, pct));
  const fillCount = Math.round((clampedPct / 100) * BAR_WIDTH);
  const cells: string[] = new Array(BAR_WIDTH).fill('░');
  for (let i = 0; i < fillCount; i++) cells[i] = '█';
  const tickIndex = Math.max(
    0,
    Math.min(BAR_WIDTH - 1, Math.round(elapsedFrac * (BAR_WIDTH - 1))),
  );
  cells[tickIndex] = '┃';
  return cells.join('');
}

// ── account status (title-line suffix) ───────────────────────────────

export type QuotaBarAccountStatus = 'active' | 'exhausted' | 'idle';

/**
 * Title-line status word. `active` wins over `exhausted` (the fleet's
 * pinned account is reported as active even if the broker also flags it
 * exhausted — matches the locked example where the operator wants to know
 * WHICH account is live first, and its health second, from the two window
 * rows underneath). Otherwise: `exhausted` if the broker's own flag says
 * so, else `idle` (present, healthy, just not the current pick).
 */
export function accountStatus(isActive: boolean, exhausted: boolean): QuotaBarAccountStatus {
  if (isActive) return 'active';
  if (exhausted) return 'exhausted';
  return 'idle';
}

// ── row / block assembly ─────────────────────────────────────────────

/** One `- <dot> <window> \`[<bar>] <pct>% / <time-left>\`` line. */
export function formatWindowRow(
  window: '5h' | '7d',
  pct: number,
  resetAt: Date | null,
  now: Date = new Date(),
): string {
  const windowMs = window === '5h' ? FIVE_HOUR_MS : SEVEN_DAY_MS;
  const dot = pickDot(pct);
  const bar = buildBar(pct, elapsedFraction(resetAt, windowMs, now));
  const pctStr = `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
  const timeLeft = formatTimeLeft(resetAt, now);
  return `- ${dot} ${window} \`[${bar}] ${pctStr} / ${timeLeft}\``;
}

/** One account's title line + its two window rows (5h then 7d). */
export function renderQuotaBarAccount(
  label: string,
  isActive: boolean,
  exhausted: boolean,
  quota: QuotaUtilization | null,
  now: Date = new Date(),
  demo = false,
): string[] {
  const status = accountStatus(isActive, exhausted);
  // Title line wraps `label` in GFM `**bold**`, NOT a code span — so this
  // needs `escapeMarkdown` (backslash-escapes *, _, [, ], etc.), not
  // `codeSpanSafe` (which only defuses backticks and is only correct
  // inside literal `code spans` — see format.ts). Using codeSpanSafe here
  // was a bug: a label containing e.g. `**` or `[x](url)` would break the
  // bold run or inject a markdown link into the card.
  const displayLabel = demo ? maskEmail(label) : label;
  const lines: string[] = [`- **${escapeMarkdown(displayLabel)}** (${status})`];
  if (!quota || isProbeThin(quota)) {
    // Data-quality gap. A failed / thin probe carries NO real utilization
    // signal, so it must NOT render as a healthy 🟢 0% bar — that's
    // indistinguishable from a fresh account with full headroom, which was
    // the #2959 review's blocking bug. Emit a distinct ⚠️ warning row per
    // window with a "no data" label (thin vs failed) instead of a fake bar,
    // keeping two rows so the block stays shape-stable.
    const reason = !quota ? 'no data — probe failed' : 'no data — thin probe';
    lines.push(`- ⚠️ 5h \`${reason}\``);
    lines.push(`- ⚠️ 7d \`${reason}\``);
    return lines;
  }
  const norm = refillNormalizedUtils(quota, now);
  lines.push(formatWindowRow('5h', norm.fiveHourUtilizationPct, quota.fiveHourResetAt, now));
  lines.push(formatWindowRow('7d', norm.sevenDayUtilizationPct, quota.sevenDayResetAt, now));
  return lines;
}

export interface QuotaBarRenderOpts {
  now?: Date;
  /** Demo mode (the `/usage demo` suffix) — masks account-email labels. */
  demo?: boolean;
}

/**
 * Relative-age stamp for the freshness footer: "0s ago", "3m ago". Measured
 * against `now` so tests with an injected clock get deterministic output.
 * (Mirrors `formatAgeStamp` in auth-snapshot-format.ts, which is not exported.)
 */
function formatAgeStamp(atMs: number, now: Date = new Date()): string {
  const ageSec = Math.max(0, Math.round((now.getTime() - atMs) / 1000));
  return ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
}

export interface UsageCardRenderOpts extends QuotaBarRenderOpts {
  /**
   * The probe-on-open attempted a live refresh but it FAILED (or hit the TTL),
   * so the card is served off the durable cache. When set, the footer shows an
   * explicit "⚠ cached Nm ago" warning (age from this `capturedAt`) instead of
   * a false live stamp. Takes precedence over `liveProbedAtMs`. Restores the
   * signal `renderAuthSnapshotFormat2` carried before /usage went bar-only.
   */
  staleCachedAtMs?: number;
  /** Timestamp of the most recent live probe; renders "Live · refreshed Nm
   *  ago" when no stale-cache marker applies. Omit to render a bare "Live".
   *  Do NOT set this when the probe failed and no live data was obtained —
   *  set `probeFailed: true` instead so the footer doesn't claim "Live". */
  liveProbedAtMs?: number;
  /**
   * True when the live probe returned no usable data for ANY account (the
   * probe threw / timed out / returned zero rows, AND nothing was served
   * from cache either). The footer then renders an explicit `⚠ probe failed
   * — no live data` instead of a false "Live" stamp. Subscription-honesty:
   * the /usage card exists to tell the operator the truth about quota state,
   * so a footer that says "Live" while every row shows "⚠️ no data" is the
   * exact lie this flag closes. Takes precedence over `liveProbedAtMs`;
   * `staleCachedAtMs` (cache-served data) still takes precedence over this
   * because in that case there IS real data, just stale.
   */
  probeFailed?: boolean;
  /**
   * Optional External (OpenRouter / non-Claude cash) spend block — layout B
   * (operator-locked 2026-07-19). When null/undefined the block is omitted
   * entirely (no error rows). When present (including $0.00), bullets land
   * after the recommendation and before the freshness footer.
   */
  externalSpend?: {
    day24hUsd: number;
    day7dUsd: number;
    top: Array<{ label: string; usd: number }>;
  } | null;
}

/**
 * Render the full multi-account quota-bar block from `AccountSnapshot[]`
 * (the same shape `auth-snapshot-format.ts` builds — reuse
 * `buildSnapshotsFromCachedState` / `buildSnapshotsFromState` /
 * `quotaBarSnapshotsFromListState` to get one).
 *
 * Additionally needs each account's `exhausted` flag (not carried on
 * `AccountSnapshot`), passed as a parallel lookup keyed by label.
 */
export function renderQuotaBarBlock(
  snapshots: AccountSnapshot[],
  exhaustedByLabel: ReadonlyMap<string, boolean>,
  opts: QuotaBarRenderOpts = {},
): string {
  const now = opts.now ?? new Date();
  const demo = opts.demo ?? false;
  const lines: string[] = [];
  for (const snap of snapshots) {
    const exhausted = exhaustedByLabel.get(snap.label) ?? false;
    lines.push(
      ...renderQuotaBarAccount(snap.label, snap.isActive, exhausted, snap.quota, now, demo),
    );
  }
  return lines.join('\n');
}

/**
 * Convenience one-shot: build the quota-bar block directly from the shape
 * `switchroom auth list --json` prints (`ListStateData`), using each
 * account's cached `last_quota` (no live probe — same cache path
 * `buildSnapshotsFromCachedState` uses). This is what the CLI script
 * entrypoint (`scripts/print-quota-bar.ts`) calls.
 */
export function renderQuotaBarBlockFromListState(
  state: ListStateData,
  opts: QuotaBarRenderOpts = {},
): string {
  const now = opts.now ?? new Date();
  const exhaustedByLabel = new Map<string, boolean>(
    state.accounts.map((a: AccountState) => [a.label, a.exhausted]),
  );
  const snapshots: AccountSnapshot[] = state.accounts.map((acc: AccountState) => ({
    label: acc.label,
    isActive: acc.label === state.active,
    quota: reviveLastQuota(acc.last_quota ?? null),
    quotaError: acc.last_quota ? undefined : 'no cached quota (no probe since broker start)',
    expiresAtMs: acc.expiresAt,
    capturedAtMs: acc.last_quota?.capturedAt,
  }));
  return renderQuotaBarBlock(snapshots, exhaustedByLabel, { now });
}

/**
 * The live `/usage` card — the compact quota-bar block, and ONLY the bar
 * block. `/usage` used to append the full Format 2 health-grouped table
 * (`renderAuthSnapshotFormat2`) underneath; the operator asked for the bar
 * card alone (2026-07-10) since the two views were redundant and the table
 * doubled the message length. Every field the table carried per-account
 * (5h/7d utilization + reset) has an equivalent in the bar rows — the `pct%
 * / <time-left>` segment of each window row is the reset info, just
 * relative instead of absolute. `opts.now` is shared with the bar block;
 * `opts.demo` masks account-email labels in the title line the same way the
 * table used to.
 *
 * Footer: after the bar rows, two footer lines are appended —
 *   1. the synthesized cross-account "switch now" verdict (`recommendation`,
 *      shared with the /auth snapshot) — the single most actionable line,
 *      dropped when /usage went bar-only and restored here (#2959 review).
 *   2. a freshness marker — `⚠ cached Nm ago` when the data was served stale
 *      from cache (`staleCachedAtMs`), else `Live · refreshed Nm ago` /
 *      `Live` — so a cache-served card is never mistaken for a live one.
 */
export function renderUsageCard(
  snapshots: AccountSnapshot[],
  exhaustedByLabel: ReadonlyMap<string, boolean>,
  opts: UsageCardRenderOpts = {},
): string {
  const now = opts.now ?? new Date();
  const demo = opts.demo ?? false;
  const bar = renderQuotaBarBlock(snapshots, exhaustedByLabel, { now, demo });
  const lines = [bar];
  // Actionable cross-account verdict — restored from renderAuthSnapshotFormat2.
  lines.push(`_${recommendation(snapshots, now, demo)}_`);
  // External cash spend (OpenRouter / non-Claude) — layout B. Omitted when
  // the caller could not fetch a summary (no admin key, timeout, etc.).
  if (opts.externalSpend) {
    lines.push(...formatExternalSpendBlock(opts.externalSpend));
  }
  // Freshness signal: stale-cache warning takes precedence over a live stamp,
  // which takes precedence over an explicit probe-failed marker (no live data
  // AND no cache — the card is showing "⚠️ no data" rows, so "Live" would be
  // a lie). The probeFailed branch is the honesty backstop: without it, a
  // total probe failure rendered a bare `_Live_` footer next to no-data rows.
  if (opts.staleCachedAtMs != null) {
    lines.push(`_⚠ cached ${formatAgeStamp(opts.staleCachedAtMs, now)}_`);
  } else if (opts.liveProbedAtMs != null) {
    lines.push(`_Live · refreshed ${formatAgeStamp(opts.liveProbedAtMs, now)}_`);
  } else if (opts.probeFailed) {
    lines.push('_⚠ probe failed — no live data_');
  } else {
    lines.push('_Live_');
  }
  return lines.join('\n');
}
