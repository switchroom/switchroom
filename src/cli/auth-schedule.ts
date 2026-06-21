/**
 * `switchroom auth schedule` — per-account quota-window schedule view.
 *
 * `auth list`/`auth show` collapse quota into a single "soonest reset"
 * column, which hides the thing that actually matters for fleet quota
 * management: each account has THREE independent windows — a 5-hour
 * rolling window and a 7-day WEEKLY window (plus an Opus weekly sub-cap
 * surfaced out-of-band) — and the weekly anchor is a fixed day-of-week
 * per subscription, DIFFERENT per account (staggered). An account
 * "exhausted" on the 5h window recovers in hours; one walled on the
 * weekly window is out for days. This view separates the two so you can
 * see, per account: 5h % + reset, weekly % + reset DAY, and which window
 * (if any) is currently walling it.
 *
 * Data: `listState()` carries the exhaustion ledger + a CACHED `last_quota`
 * (often null — the in-memory probe cache is empty after a broker restart).
 * To show live windows the view does a fresh `probe-quota` by default (the
 * same broker op the web dashboard uses; operator-initiated, one tiny
 * max_tokens:1 call per account). `--cached` skips the live probe.
 *
 * Pure helpers (buildScheduleRows / classifyState / formatters) are exported
 * via `_testing` and unit-tested directly — the broker IO is not mocked
 * (mirrors the auth-google.test.ts pattern).
 */

import type { Command } from "commander";
import chalk from "chalk";
import { brokerCall } from "./broker-call.js";
import { withConfigError } from "./helpers.js";
import type {
  ListStateData,
  AccountState,
  ProbeQuotaData,
} from "../auth/broker/client.js";
import { SERVE_BLOCKING_OVERAGE_REASONS } from "../auth/broker/account-eligibility.js";
import { refillNormalizedUtils } from "../auth/quota.js";

// ─── Pure model ──────────────────────────────────────────────────────────

export interface WindowSnapshot {
  fiveHourPct: number | null;
  fiveHourResetAt: Date | null;
  weeklyPct: number | null;
  weeklyResetAt: Date | null;
  /** Where the numbers came from: a live probe, the broker's cache, or nothing. */
  source: "live" | "cached" | "none";
  /**
   * True when the probe/cache carried a serve-blocking `overageDisabledReason`
   * (`out_of_credits`) — the account is dead even at 0% util. Discriminated on
   * the same strict allowlist the broker uses (see SERVE_BLOCKING_OVERAGE_
   * REASONS); `org_level_disabled` / null / unknown are benign → false.
   */
  overageServeBlocking: boolean;
  /**
   * #2494 Bug C — the live overage-disabled reason carried by the probe/cache,
   * when serve-blocking. Surfaced verbatim by the renderer so a billing-dead
   * account names the real reason ("out_of_credits"), not just a state word.
   */
  overageReason: string | null;
  /**
   * #2494 Bug C — true when the probe came back thin/headerless (no real
   * utilization signal). Distinct from a genuine 0% so the renderer can show
   * "unknown" rather than a confident "0%".
   */
  probeThin: boolean;
}

/** Is a probe/cache overage reason serve-blocking? Mirrors the broker's
 *  isOverageServeBlocking using the shared strict allowlist. */
function overageReasonBlocks(reason: string | null | undefined): boolean {
  return reason != null && SERVE_BLOCKING_OVERAGE_REASONS.has(reason);
}

export type AccountWindowState =
  | "out-of-credits"
  // #2494 Bug C — recoverable quota exhaustion: a util window is maxed but the
  // account comes back when that window rolls. Distinct from the terminal
  // billing-dead "out-of-credits"; carries a reset countdown.
  | "quota-exhausted"
  | "healthy"
  | "5h-walled"
  | "weekly-walled"
  | "walled"
  | "unprobed";

/** Weekly utilization at/above this is treated as walled (mirrors the broker's sensor). */
const WEEKLY_WALL_PCT = 99.5;

export interface ScheduleRow {
  label: string;
  isActive: boolean;
  /** 1-based position in fallback_order, or null when not listed. */
  fallbackRank: number | null;
  window: WindowSnapshot;
  exhausted: boolean;
  exhaustedUntil: Date | null;
  state: AccountWindowState;
}

/** Prefer a live probe result; fall back to the broker's cached snapshot. */
export function resolveWindow(
  account: AccountState,
  probe: ProbeQuotaData | undefined,
): WindowSnapshot {
  const entry = probe?.results.find((r) => r.label === account.label);
  if (entry && entry.result.ok) {
    const d = entry.result.data;
    return {
      fiveHourPct: d.fiveHourUtilizationPct,
      fiveHourResetAt: d.fiveHourResetAt, // already a Date (revived client-side)
      weeklyPct: d.sevenDayUtilizationPct,
      weeklyResetAt: d.sevenDayResetAt,
      source: "live",
      overageServeBlocking: overageReasonBlocks(d.overageDisabledReason),
      overageReason: d.overageDisabledReason ?? null,
      probeThin: isThin(d),
    };
  }
  const lq = account.last_quota;
  if (lq) {
    return {
      fiveHourPct: lq.fiveHourUtilizationPct,
      fiveHourResetAt: lq.fiveHourResetAt ? new Date(lq.fiveHourResetAt) : null,
      weeklyPct: lq.sevenDayUtilizationPct,
      weeklyResetAt: lq.sevenDayResetAt ? new Date(lq.sevenDayResetAt) : null,
      source: "cached",
      overageServeBlocking: overageReasonBlocks(lq.overageDisabledReason),
      overageReason: lq.overageDisabledReason ?? null,
      probeThin: isThin(lq),
    };
  }
  return {
    fiveHourPct: null,
    fiveHourResetAt: null,
    weeklyPct: null,
    weeklyResetAt: null,
    source: "none",
    overageServeBlocking: false,
    overageReason: null,
    probeThin: false,
  };
}

/**
 * #2494 Bug C — a probe is thin when BOTH window utilization headers were
 * explicitly absent. Markers unset (legacy snapshot / fixture) → not thin.
 */
function isThin(d: {
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
}): boolean {
  return d.fiveHourUtilPresent === false && d.sevenDayUtilPresent === false;
}

/**
 * Classify which window (if any) is currently walling the account — the
 * load-bearing distinction. When we have window reset timestamps we match
 * `exhausted_until` against them precisely; otherwise we fall back to a
 * duration heuristic (a 5h wall resets within hours, a weekly wall in days).
 */
export function classifyState(args: {
  exhausted: boolean;
  exhaustedUntil: Date | null;
  window: WindowSnapshot;
  now: Date;
}): AccountWindowState {
  const { exhausted, exhaustedUntil, window, now } = args;
  // #2494 Bug C — a serve-blocking overage (out_of_credits) means the account
  // is billing-dead even at 0% util — it wins over every util-based verdict.
  // This is genuine "out-of-credits": NOT a timer, recovers only when billing
  // is fixed. Same strict-allowlist semantics as the broker.
  if (window.overageServeBlocking) return "out-of-credits";
  // #2494 Bug C — a thin/headerless probe carries no real utilization; it must
  // not pose as a confident reading. Treat as unprobed (renders "unknown").
  if (window.probeThin) return "unprobed";
  // #2494 Bug A — read utilization through refill normalization: a window
  // whose reset has already passed has rolled since capture, so its stale high
  // util is treated as 0%. A just-refilled account self-corrects to healthy.
  const norm = refillNormalizedUtils(
    {
      fiveHourUtilizationPct: window.fiveHourPct ?? 0,
      sevenDayUtilizationPct: window.weeklyPct ?? 0,
      fiveHourResetAt: window.fiveHourResetAt,
      sevenDayResetAt: window.weeklyResetAt,
    },
    now,
  );
  const fivePct = window.fiveHourPct === null ? null : norm.fiveHourUtilizationPct;
  const weeklyPct = window.weeklyPct === null ? null : norm.sevenDayUtilizationPct;
  const hasWindowData =
    window.fiveHourPct !== null ||
    window.weeklyPct !== null ||
    window.fiveHourResetAt !== null ||
    window.weeklyResetAt !== null;
  // A maxed WEEKLY window is the binding wall, regardless of the exhaustion
  // ledger: even when `exhausted_until` points at a sooner 5h reset, once that
  // 5h window clears the weekly cap still blocks the account until its (days-
  // away) reset. So a near-100% weekly takes precedence over "5h-walled".
  // (Refill-normalized weeklyPct is already 0 once the weekly reset passes.)
  if (
    weeklyPct !== null &&
    weeklyPct >= WEEKLY_WALL_PCT &&
    window.weeklyResetAt !== null &&
    window.weeklyResetAt.getTime() > now.getTime()
  ) {
    return "weekly-walled";
  }
  // #2494 Bug C — a maxed 5h window with a future reset is recoverable quota
  // exhaustion (comes back when the window rolls), distinct from billing-dead.
  if (
    fivePct !== null &&
    fivePct >= WEEKLY_WALL_PCT &&
    window.fiveHourResetAt !== null &&
    window.fiveHourResetAt.getTime() > now.getTime()
  ) {
    return "quota-exhausted";
  }
  if (!exhausted) {
    // No exhaustion ledger AND no probe/cache data → we genuinely don't know.
    return hasWindowData || exhaustedUntil !== null ? "healthy" : "unprobed";
  }
  const until = exhaustedUntil?.getTime();
  if (until === undefined) return "walled";
  const remaining = until - now.getTime();
  if (remaining <= 0) return "healthy"; // window already passed

  const TOL_MS = 15 * 60 * 1000; // 15 min slack between mark time and reset
  const near = (d: Date | null) =>
    d !== null && Math.abs(d.getTime() - until) <= TOL_MS;
  if (near(window.weeklyResetAt)) return "weekly-walled";
  if (near(window.fiveHourResetAt)) return "5h-walled";

  // No matching reset timestamp — classify by how far out the reset is.
  if (remaining < 6 * 3_600_000) return "5h-walled";
  if (remaining >= 20 * 3_600_000) return "weekly-walled";
  return "walled";
}

export function buildScheduleRows(
  state: ListStateData,
  probe: ProbeQuotaData | undefined,
  now: Date,
): ScheduleRow[] {
  const rows = state.accounts.map((a) => {
    const window = resolveWindow(a, probe);
    const exhaustedUntil =
      typeof a.exhausted_until === "number" ? new Date(a.exhausted_until) : null;
    const exhausted = a.exhausted && (exhaustedUntil?.getTime() ?? 0) > now.getTime();
    const rank = state.fallback_order.indexOf(a.label);
    return {
      label: a.label,
      isActive: a.label === state.active,
      fallbackRank: rank === -1 ? null : rank + 1,
      window,
      exhausted,
      exhaustedUntil,
      state: classifyState({ exhausted, exhaustedUntil, window, now }),
    };
  });
  // Pool priority: active first, then fallback_order rank, then excluded.
  const key = (r: ScheduleRow) => (r.isActive ? -1 : (r.fallbackRank ?? 9999));
  return rows.sort((a, b) => key(a) - key(b) || a.label.localeCompare(b.label));
}

// ─── Formatters ──────────────────────────────────────────────────────────

const EM_DASH = "—";

/** "5d 3h" / "2h 18m" / "4m" / "now". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function tzOpts(tz?: string): { timeZone?: string } {
  return tz ? { timeZone: tz } : {};
}

/** "Sun 11:00" in the given (or host) timezone — fixed locales keep it stable. */
export function formatResetDay(d: Date, tz?: string): string {
  const opts = tzOpts(tz);
  const dow = d.toLocaleDateString("en-US", { weekday: "short", ...opts });
  const hm = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...opts,
  });
  return `${dow} ${hm}`;
}

/** 5h cell, raw (uncolored): "40% · 1h 2m", "unknown", or "—".
 *  #2494 — refill-aware (a passed reset reads 0%) and thin-aware. */
export function formatFiveHourCell(w: WindowSnapshot, now: Date): string {
  if (w.probeThin) return "unknown";
  if (w.fiveHourPct === null) return EM_DASH;
  const refilled =
    w.fiveHourResetAt !== null && w.fiveHourResetAt.getTime() <= now.getTime();
  const pct = refilled ? 0 : w.fiveHourPct;
  const reset = w.fiveHourResetAt
    ? ` · ${formatDuration(w.fiveHourResetAt.getTime() - now.getTime())}`
    : "";
  return `${Math.round(pct)}%${reset}`;
}

/** Weekly cell, raw (uncolored): "8% · Sun 11:00 (5d 3h)", "unknown", or "—".
 *  #2494 — refill-aware and thin-aware. */
export function formatWeeklyCell(w: WindowSnapshot, now: Date, tz?: string): string {
  if (w.probeThin) return "unknown";
  if (w.weeklyPct === null && w.weeklyResetAt === null) return EM_DASH;
  const refilled =
    w.weeklyResetAt !== null && w.weeklyResetAt.getTime() <= now.getTime();
  const pct =
    w.weeklyPct === null ? EM_DASH : `${Math.round(refilled ? 0 : w.weeklyPct)}%`;
  if (!w.weeklyResetAt) return pct;
  const rel = formatDuration(w.weeklyResetAt.getTime() - now.getTime());
  return `${pct} · ${formatResetDay(w.weeklyResetAt, tz)} (${rel})`;
}

function poolLabel(row: ScheduleRow): string {
  if (row.isActive) return row.fallbackRank ? `active #${row.fallbackRank}` : "active";
  if (row.fallbackRank) return `#${row.fallbackRank}`;
  return "excluded";
}

/** State cell, raw (uncolored): "healthy" / "5h-walled · 2h 18m" / etc. */
export function formatStateCell(row: ScheduleRow, now: Date): string {
  // Show the horizon that actually matters for the classified wall — the
  // weekly reset for a weekly wall, the 5h reset for a 5h wall — not just the
  // exhaustion-ledger timestamp (which can point at the sooner 5h window).
  const horizon =
    row.state === "weekly-walled"
      ? (row.window.weeklyResetAt ?? row.exhaustedUntil)
      : row.state === "5h-walled" || row.state === "quota-exhausted"
        ? (row.window.fiveHourResetAt ?? row.exhaustedUntil)
        : row.exhaustedUntil;
  const rel = horizon ? ` · ${formatDuration(horizon.getTime() - now.getTime())}` : "";
  switch (row.state) {
    case "out-of-credits":
      // #2494 Bug C — billing-dead. No util-window reset to count down to —
      // overage is off until billing is fixed, not until a window rolls. Name
      // the real reason so it reads distinctly from a recoverable exhaustion.
      return row.window.overageReason
        ? `billing disabled (${row.window.overageReason})`
        : "billing disabled";
    case "quota-exhausted":
      // #2494 Bug C — recoverable: comes back when the 5h window rolls. Carries
      // the reset countdown, unlike the terminal billing-dead state above.
      return `quota-exhausted${rel}`;
    case "healthy":
      return "healthy";
    case "unprobed":
      return "no recent probe";
    case "5h-walled":
      return `5h-walled${rel}`;
    case "weekly-walled":
      return `weekly-walled${rel}`;
    case "walled":
      return `walled${rel}`;
  }
}

const W = { label: 30, pool: 11, five: 15, weekly: 26 };

function pad(s: string, n: number): string {
  // Truncate over-long raw cells so the column never breaks alignment.
  if (s.length > n) return s.length > 1 ? s.slice(0, n - 1) + "…" : s;
  return s.padEnd(n);
}

function glyphFor(row: ScheduleRow, color: boolean): string {
  const g = row.isActive ? "●" : row.exhausted ? "!" : row.state === "unprobed" ? "·" : "✓";
  if (!color) return g;
  return row.isActive
    ? chalk.green(g)
    : row.exhausted
      ? chalk.red(g)
      : chalk.gray(g);
}

function colorState(text: string, state: AccountWindowState, color: boolean): string {
  if (!color) return text;
  switch (state) {
    case "healthy":
      return chalk.green(text);
    case "out-of-credits":
      return chalk.red(text);
    case "weekly-walled":
      return chalk.red(text);
    case "quota-exhausted":
      // Recoverable — amber, not the terminal red of billing-dead.
      return chalk.yellow(text);
    case "5h-walled":
      return chalk.yellow(text);
    default:
      return chalk.gray(text);
  }
}

export interface FormatOpts {
  /** Timezone for reset days; omit for host-local. Tests pin it. */
  tz?: string;
  /** Emit ANSI colour. Default true; tests pass false. */
  color?: boolean;
}

/**
 * Render the schedule as an array of lines (no trailing blank). The
 * glyph and state cells carry colour (applied last, never padEnd'd); the
 * label/pool/5h/weekly cells are raw text padded to fixed widths — so the
 * header (built with a blank glyph + raw titles) aligns exactly.
 */
export function formatScheduleRows(
  rows: ScheduleRow[],
  now: Date,
  opts: FormatOpts = {},
): string[] {
  const color = opts.color ?? true;
  const line = (glyph: string, label: string, p: string, five: string, weekly: string, state: string) =>
    `  ${glyph} ${pad(label, W.label)} ${pad(p, W.pool)} ${pad(five, W.five)} ${pad(weekly, W.weekly)} ${state}`;

  const header = line(" ", "ACCOUNT", "POOL", "5H WINDOW", "WEEKLY WINDOW", "STATE");
  const out = [color ? chalk.bold(header) : header];
  for (const row of rows) {
    out.push(
      line(
        glyphFor(row, color),
        row.label,
        poolLabel(row),
        formatFiveHourCell(row.window, now),
        formatWeeklyCell(row.window, now, opts.tz),
        colorState(formatStateCell(row, now), row.state, color),
      ),
    );
  }
  return out;
}

/** The freshness/legend footer lines. */
export function formatFooter(
  rows: ScheduleRow[],
  opts: { liveRequested: boolean; probedLive: boolean },
  now: Date,
  tz?: string,
): string[] {
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = formatResetDay(now, tz);
  const src = opts.probedLive
    ? `probed live · ${at} ${zone}`
    : opts.liveRequested
      ? `live probe unavailable — showing cached snapshot · times in ${zone}`
      : `cached snapshot (run without --cached for a live probe) · times in ${zone}`;
  const anyUnprobed = rows.some((r) => r.window.source === "none");
  const lines = [src];
  if (!opts.probedLive && anyUnprobed) {
    lines.push(
      opts.liveRequested
        ? "some accounts have no quota data — the broker may not have served a probe"
        : "some accounts have no cached probe yet — run without --cached to populate",
    );
  }
  return lines;
}

// ─── CLI wiring ──────────────────────────────────────────────────────────

export function registerAuthScheduleSubcommands(
  _program: Command,
  authParent: Command,
): void {
  authParent
    .command("schedule")
    .description(
      "Per-account quota schedule — 5h vs WEEKLY window, % used, and reset day (live probe by default)",
    )
    .option("--cached", "Use the broker's cached snapshot; skip the live probe")
    .option("--json", "Output JSON")
    .action(
      withConfigError(async (opts: { cached?: boolean; json?: boolean }) => {
        const live = !opts.cached;
        const { state, probe } = await brokerCall(async (client) => {
          const s = await client.listState();
          let p: ProbeQuotaData | undefined;
          if (live) {
            const labels = s.accounts.map((a) => a.label);
            p =
              labels.length > 0
                ? await client.probeQuota(labels).catch(() => undefined)
                : undefined;
          }
          return { state: s, probe: p };
        });

        if (opts.json) {
          console.log(JSON.stringify({ ...state, probe: probe ?? null }, null, 2));
          return;
        }

        const now = new Date();
        const rows = buildScheduleRows(state, probe, now);
        const probedLive = live && probe !== undefined;
        console.log();
        for (const l of formatScheduleRows(rows, now)) console.log(l);
        console.log();
        for (const l of formatFooter(rows, { liveRequested: live, probedLive }, now)) {
          console.log(chalk.gray("  " + l));
        }
        console.log();
      }),
    );
}

export const _testing = {
  resolveWindow,
  classifyState,
  buildScheduleRows,
  formatDuration,
  formatResetDay,
  formatFiveHourCell,
  formatWeeklyCell,
  formatStateCell,
  formatScheduleRows,
  formatFooter,
};
