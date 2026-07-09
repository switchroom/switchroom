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
import { reviveLastQuota, type AccountSnapshot } from './auth-snapshot-format.js';
import { escapeMarkdown } from './card-format.js';

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
  if (deltaMs <= 0) return 'resets now';
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
  if (timeLeftMs <= 0) return 0;
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
): string[] {
  const status = accountStatus(isActive, exhausted);
  // Title line wraps `label` in GFM `**bold**`, NOT a code span — so this
  // needs `escapeMarkdown` (backslash-escapes *, _, [, ], etc.), not
  // `codeSpanSafe` (which only defuses backticks and is only correct
  // inside literal `code spans` — see format.ts). Using codeSpanSafe here
  // was a bug: a label containing e.g. `**` or `[x](url)` would break the
  // bold run or inject a markdown link into the card.
  const lines: string[] = [`- **${escapeMarkdown(label)}** (${status})`];
  if (!quota || isProbeThin(quota)) {
    // Data-quality gap: still emit the two rows so the block stays
    // shape-stable, but at 0%/unknown-reset rather than fabricating numbers.
    lines.push(formatWindowRow('5h', 0, null, now));
    lines.push(formatWindowRow('7d', 0, null, now));
    return lines;
  }
  const norm = refillNormalizedUtils(quota, now);
  lines.push(formatWindowRow('5h', norm.fiveHourUtilizationPct, quota.fiveHourResetAt, now));
  lines.push(formatWindowRow('7d', norm.sevenDayUtilizationPct, quota.sevenDayResetAt, now));
  return lines;
}

export interface QuotaBarRenderOpts {
  now?: Date;
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
  const lines: string[] = [];
  for (const snap of snapshots) {
    const exhausted = exhaustedByLabel.get(snap.label) ?? false;
    lines.push(...renderQuotaBarAccount(snap.label, snap.isActive, exhausted, snap.quota, now));
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
