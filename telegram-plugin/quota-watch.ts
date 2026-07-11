/**
 * Proactive quota threshold-tier push (#E4).
 *
 * Background: JTBD `track-plan-quota-live` anti-pattern: "Quota visible
 * only in a separate dashboard or a command. If the user has to go
 * looking, they won't, and they'll hit the wall." The existing stack
 * covers the wall (auto-fallback at 99.5%, credits-watch on fatal billing
 * transitions) but fires zero proactive signal at 80% — the point where
 * the user can still act by switching accounts. This module closes that gap.
 *
 * It is a pure decision layer. It reads the broker's cached quota state
 * for all accounts, classifies health via the same `classifyHealth`
 * three-state machine used by the /auth dashboard, compares against a
 * persisted last-notified state, and tells the gateway whether to emit
 * a Telegram message + what to say. The gateway wires the actual
 * `bot.api.sendMessage` call (via `swallowingApiCall`) — same as
 * `credits-watch.ts`.
 *
 * Edge-trigger discipline: only fires on health *transitions*
 * (healthy → throttling and throttling → healthy). Does NOT fire on
 * healthy → blocked or blocked → healthy — `credits-watch.ts` already
 * covers those via the fatal-billing path. Steady-state throttling
 * never re-notifies.
 *
 * Scope: per-account across the whole pool, not just the active one.
 * The user's natural recovery action is switching to a healthy account,
 * so they need visibility into non-active accounts too.
 *
 * Source data: broker `listState` + `probeQuota`. `listState` is a local
 * IPC call (cheap). `probeQuota` is only called on state-change (when
 * we're going to send a message anyway) to get fresh numbers for the
 * notification body. On no-change polls, only `listState` is called.
 *
 * #2495 Change 3 — the transition-to-alarm probe is `forceLive` (bypasses
 * the broker's probe-on-open TTL), so the DECISION to alarm is corroborated
 * by a TRUE live probe of the affected account, not a possibly-stale cache
 * read. The re-evaluation with fresh numbers can suppress an alarm whose
 * stale-snapshot transition no longer holds. Steady state stays cheap: a
 * no-change poll never probes. Cost is one live probe per transition edge.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AccountSnapshot } from "./auth-snapshot-format.js";
import {
  classifyHealth,
  type AccountHealth,
  THROTTLING_THRESHOLD_PCT,
  bindingWindow,
  formatRelative,
  fmtPct,
} from "./auth-snapshot-format.js";
import type { QuotaUtilization } from "./quota-check.js";
import { escapeMarkdown, codeSpanSafe } from "./card-format.js";

const STATE_FILE = "quota-watch.json";

// ─── State types ──────────────────────────────────────────────────────────────

/**
 * Per-account last-notified health. We only care about the
 * healthy ↔ throttling boundary — blocked is `credits-watch`'s domain.
 * `null` means "never notified" (treat as healthy for transition logic).
 */
export type QuotaWatchHealth = "healthy" | "throttling" | null;

export interface QuotaWatchAccountState {
  /** Last health we sent a notification for. null = never notified. */
  lastNotifiedHealth: QuotaWatchHealth;
  /** Wall-clock ms of the last notification. */
  lastNotifiedAt: number;
}

export type QuotaWatchState = Record<string, QuotaWatchAccountState>;

export function emptyQuotaWatchState(): QuotaWatchState {
  return {};
}

export function emptyAccountState(): QuotaWatchAccountState {
  return { lastNotifiedHealth: null, lastNotifiedAt: 0 };
}

// ─── Tuning (env knobs) ───────────────────────────────────────────────────────

/**
 * Operational tuning for the watch loop, resolved once from env by the
 * gateway. All three hardening behaviours are individually
 * kill-switchable (incident 2026-06-09: a fleet bounce released
 * days-stale recovery latches on all 11 agents at once → 26 duplicate
 * 🟢 messages in 16 minutes):
 *
 *   SWITCHROOM_QUOTA_WATCH_MAX_STALE_MS      0 disables the staleness gate
 *                                            (default 60 min)
 *   SWITCHROOM_QUOTA_WATCH_LATE_RECOVERY_MS  0 disables silent late-recovery
 *                                            reconciliation (default 6 h)
 *   SWITCHROOM_QUOTA_WATCH_FLEET_DEDUP       "0" disables the broker claim
 *                                            (every agent sends, pre-incident
 *                                            behaviour)
 *
 * When the pre-send validation probe fails, the alert is unconditionally
 * suppressed (a quota notification must never carry numbers we could not
 * verify live); the transition re-evaluates on the next poll tick.
 */
export interface QuotaWatchTuning {
  /** Cached snapshots older than this are treated as unknown (no opinion). 0 = off. */
  maxStaleMs: number;
  /** Recovery edges whose 🟡 warning is older than this reconcile silently. 0 = off. */
  lateRecoveryMs: number;
  /** Route sends through the broker's claim-notification dedup. */
  fleetDedup: boolean;
}

export const DEFAULT_QUOTA_WATCH_MAX_STALE_MS = 60 * 60_000;
export const DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS = 6 * 60 * 60_000;

/** Broker claim window. Must exceed one full poll cycle (15 min) plus the
 *  boot-stagger spread so every agent's observation of the SAME edge lands
 *  inside one window; an account genuinely re-crossing the same edge later
 *  than this re-notifies. */
export const QUOTA_WATCH_CLAIM_WINDOW_MS = 30 * 60_000;

export function resolveQuotaWatchTuning(
  env: Record<string, string | undefined>,
): QuotaWatchTuning {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    maxStaleMs: num(env.SWITCHROOM_QUOTA_WATCH_MAX_STALE_MS, DEFAULT_QUOTA_WATCH_MAX_STALE_MS),
    lateRecoveryMs: num(env.SWITCHROOM_QUOTA_WATCH_LATE_RECOVERY_MS, DEFAULT_QUOTA_WATCH_LATE_RECOVERY_MS),
    fleetDedup: env.SWITCHROOM_QUOTA_WATCH_FLEET_DEDUP !== "0",
  };
}

/**
 * Broker dedup-claim key for one (account, transition, chat) cell.
 * Per-CHAT keys keep the audience identical to pre-dedup behaviour:
 * every chat that any agent would have notified still receives exactly
 * one copy — from whichever agent claims it first.
 */
export function buildQuotaClaimKey(
  accountLabel: string,
  transition: string,
  chatId: string | number,
): string {
  return `quota-watch:${accountLabel}:${transition}:${chatId}`;
}

// ─── Broker-initiated fleet-roll announcement (#3031 PR 3) ───────────────────

/**
 * Reserved state-map key for the last-announced broker roll. Same reserved-key
 * trick as FLEET_ALL_EXHAUSTED_KEY: not a valid account label, so it never
 * collides with per-account entries, and the per-account loop never sees it.
 * `lastNotifiedAt` stores the roll's `at` timestamp (edge-trigger latch).
 */
export const FLEET_ROLL_ANNOUNCE_KEY = "__fleet_roll_announce__";

/**
 * Don't announce a roll older than this — a gateway booting hours after a
 * roll would otherwise resurrect stale news (mirrors the late-recovery
 * discipline). CLAMPED to the broker claim window (#3035 review, finding 1):
 * if this ceiling exceeded the claim window, a gateway with an empty
 * quota-watch.json running its boot tick after the claim expired but before
 * this ceiling (e.g. T+40m under the old 60m/30m split) would pass both the
 * latch AND the expired claim → duplicate roll card. Equal horizons close
 * that gap by construction: any roll still young enough to announce is
 * still inside the claim window that deduped the first announcement.
 */
export const FLEET_ROLL_MAX_AGE_MS = QUOTA_WATCH_CLAIM_WINDOW_MS;

/**
 * Suppress the per-account 🟡 throttling push when a roll announcement for
 * the SAME account fired this recently — the roll card already told the
 * operator that account walled and the fleet moved off it; a trailing
 * "approaching limit" push for it is noise. Matches the broker claim window
 * so the two dedup horizons agree.
 */
export const QUOTA_WATCH_ROLL_DEDUP_MS = QUOTA_WATCH_CLAIM_WINDOW_MS;

/** Shape of `listState().last_fleet_roll` as the watch consumes it. */
export interface FleetRollInfo {
  from: string;
  to: string;
  at: number;
  exhausted_until?: number;
  window?: "5h" | "7d";
  pct?: number;
  /**
   * Trigger attribution (#3031 PR 2): "soft-avoid" = proactive
   * serving-preference roll off an account APPROACHING its limits;
   * "hard-exhaustion" = the probe saw a genuine quota wall. Absent on
   * pre-PR-2 brokers — rendered as hard exhaustion.
   */
  reason?: "soft-avoid" | "hard-exhaustion";
}

export type FleetRollAnnounceDecision =
  | { kind: "notify"; message: string; newState: QuotaWatchAccountState }
  | { kind: "skip"; reason: string };

/**
 * Edge-triggered decision for the broker-roll announcement. Fires at most
 * once per roll event (latched on the roll's `at` timestamp), never for
 * rolls older than `maxAgeMs`, and never re-fires in steady state.
 */
export function evaluateFleetRollAnnounce(args: {
  roll: FleetRollInfo | null | undefined;
  prev: QuotaWatchAccountState;
  now: number;
  maxAgeMs?: number;
}): FleetRollAnnounceDecision {
  const { roll, prev, now } = args;
  const maxAgeMs = args.maxAgeMs ?? FLEET_ROLL_MAX_AGE_MS;
  if (!roll) return { kind: "skip", reason: "no-roll" };
  if (prev.lastNotifiedAt >= roll.at) return { kind: "skip", reason: "already-announced" };
  if (now - roll.at > maxAgeMs) return { kind: "skip", reason: "stale-roll" };
  return {
    kind: "notify",
    message: buildFleetRollMessage(roll, now),
    newState: { lastNotifiedHealth: "healthy", lastNotifiedAt: roll.at },
  };
}

/**
 * Causal + reassuring announcement for a broker-initiated proactive roll.
 * Hard exhaustion: "Switched fleet to <new> — <window> at <pct>% on <old>
 * (resets <time>). Work continues uninterrupted."
 * Soft-avoid (#3031 PR 2 `reason`): reads as PROACTIVE — the old account is
 * approaching its limits, not walled; no mark/reset framing.
 */
export function buildFleetRollMessage(roll: FleetRollInfo, now: number): string {
  const winLabel =
    roll.window === "5h" ? "5-hour window" : roll.window === "7d" ? "7-day window" : "quota window";
  const pctPart = typeof roll.pct === "number" ? ` at ${fmtPct(roll.pct)}` : "";
  const resetPart =
    typeof roll.exhausted_until === "number" && roll.exhausted_until > now
      ? ` (resets ${formatRelative(new Date(roll.exhausted_until), new Date(now))})`
      : "";
  const softAvoid = roll.reason === "soft-avoid";
  const causeLine = softAvoid
    ? `Proactive switch — \`${codeSpanSafe(roll.from)}\` is approaching its limits (${winLabel}${pctPart})${resetPart}, so the fleet moved early instead of hitting the wall.`
    : `${winLabel}${pctPart} on \`${codeSpanSafe(roll.from)}\`${resetPart}.`;
  return [
    `🔁 **Switched fleet to \`${codeSpanSafe(roll.to)}\`**`,
    ``,
    causeLine,
    `Work continues uninterrupted — agents and scheduled jobs now serve from \`${codeSpanSafe(roll.to)}\`.`,
    ``,
    `_Automatic broker failover${softAvoid ? " (proactive, before exhaustion)" : ""}. Run /auth for fleet status; \`/auth use ${codeSpanSafe(roll.from)}\` to switch back once it ${softAvoid ? "has headroom again" : "refills"}._`,
  ].join("\n");
}

// ─── Decision logic ───────────────────────────────────────────────────────────

export type QuotaWatchTransition =
  | "entered-throttling"
  | "recovered-to-healthy";

export type QuotaWatchDecision =
  | {
      kind: "notify";
      accountLabel: string;
      message: string;
      newAccountState: QuotaWatchAccountState;
      transition: QuotaWatchTransition;
    }
  | {
      /**
       * A real transition was observed, but it is no longer NEWS — persist
       * the new state so the edge-trigger latch clears, send nothing.
       * Two producers: boot-tick recoveries (a just-booted gateway cannot
       * distinguish "just recovered" from "recovered while we were down",
       * and fleet bounces synchronize all agents' first ticks → flood) and
       * late recoveries (the matching 🟡 is hours old; an "all clear" now
       * is state reconciliation, not information).
       */
      kind: "reconcile";
      accountLabel: string;
      newAccountState: QuotaWatchAccountState;
      transition: QuotaWatchTransition;
      reason: "boot-tick-recovery" | "late-recovery" | "roll-announced";
    }
  | { kind: "skip"; accountLabel: string; reason: string };

/**
 * #2495 BLOCKER fix — the corroboration probe result, as the gateway's
 * runQuotaWatch sees it from `brokerClient.probeQuota(..., forceLive=true)`.
 * Structurally a subset of `ProbeQuotaEntry` (src/auth/broker/client.ts): a
 * `result` discriminated on `ok`, plus a `served` tag the broker stamps to
 * say HOW the result was sourced.
 *
 * The trap this guards: under `forceLive`, when the upstream live probe FAILS
 * and the broker holds a prior snapshot, it returns `cachedSnapshotToResult`
 * — `result.ok === true` but `served === "cache"` (server.ts opProbeQuota).
 * A naive `result.ok` check then treats that stale cache read as a live
 * corroboration, fires the alarm, and stamps the false "Live-probe
 * corroborated (#2495)" footnote. The acceptance criterion is the opposite:
 * an alarm must be backed by a LIVE probe, not a stale cache read.
 */
export type CorroborationProbe = {
  result: { ok: true } | { ok: false };
  /**
   * How the result was sourced. `"live"` = fresh upstream probe (genuine
   * corroboration). `"cache"` = served from the durable cache (TTL-hit or
   * probe-failure fallback) — NOT corroboration. Absent on legacy responses,
   * which we treat as NOT corroborated (fail-closed: never claim a live
   * corroboration we can't prove).
   */
  served?: "live" | "cache";
};

/**
 * #2495 BLOCKER fix — decide whether a forceLive corroboration probe counts
 * as a genuine LIVE corroboration of the alarm.
 *
 * Genuine corroboration requires BOTH `result.ok` AND `served === "live"`.
 * A result that is `ok:true` but `served:"cache"` (the failed-probe
 * cache-fallback) is treated EXACTLY like a probe failure: it is NOT
 * corroboration, so the caller must DEFER — leave watch state untouched and
 * re-evaluate next tick when a true live probe can be obtained. A missing
 * entry (`undefined`) is likewise not corroboration.
 *
 * Pure + total so it can be unit-tested at the seam without standing up the
 * broker or the gateway loop.
 */
export function isLiveCorroboration(entry: CorroborationProbe | undefined): boolean {
  return entry?.result.ok === true && entry.served === "live";
}

/**
 * Evaluate one account's quota state against its last-notified health.
 *
 * Transition table (after the staleness gate — a cached snapshot older
 * than `maxStaleMs` is no opinion at all → skip "stale-snapshot"):
 *   healthy → healthy        skip (steady-state)
 *   healthy → throttling     notify (entered-throttling) — warnings are
 *                            level-state news, valid on any tick incl. boot
 *   healthy → blocked        skip (credits-watch covers this)
 *   throttling → healthy     notify (recovered-to-healthy), EXCEPT:
 *                              boot tick           → reconcile silently
 *                              warning > lateRecoveryMs old → reconcile silently
 *   throttling → throttling  skip (already notified)
 *   throttling → blocked     skip (credits-watch covers blocked)
 *   blocked → *              skip (credits-watch domain)
 *   unknown → *              skip (no quota data — don't spam)
 *   * → unknown              skip (probe failed — transient, don't alarm)
 *
 * `bootTick` / `tuning` are optional: omitted (legacy callers/tests) the
 * behaviour is exactly the pre-hardening table (no stale gate, no
 * reconciliation).
 */
export function evaluateQuotaWatchAccount(args: {
  agentName: string;
  snap: AccountSnapshot;
  prev: QuotaWatchAccountState;
  now: number;
  /** True on the gateway's first watch tick after boot. */
  bootTick?: boolean;
  /** Staleness / late-recovery thresholds; 0 disables each. */
  tuning?: Pick<QuotaWatchTuning, "maxStaleMs" | "lateRecoveryMs">;
  /**
   * Most recent broker-initiated fleet roll, if any (#3031 PR 3). A fresh
   * roll OFF this account suppresses the 🟡 entered-throttling push — the
   * roll announcement already told the operator this account walled, so a
   * trailing "approaching limit" for it is redundant. Latched silently
   * (reconcile) so edge-trigger semantics hold: no steady-state re-notify.
   */
  lastRoll?: Pick<FleetRollInfo, "from" | "at"> | null;
}): QuotaWatchDecision {
  const { agentName, snap, prev, now } = args;
  const bootTick = args.bootTick ?? false;
  const maxStaleMs = args.tuning?.maxStaleMs ?? 0;
  const lateRecoveryMs = args.tuning?.lateRecoveryMs ?? 0;
  const label = snap.label;

  // Staleness gate: a CACHED snapshot (capturedAtMs set) past its shelf
  // life carries no opinion about the present — neither latch nor release.
  // Live-probe snapshots (capturedAtMs undefined) are fresh by construction.
  if (
    maxStaleMs > 0 &&
    snap.capturedAtMs !== undefined &&
    now - snap.capturedAtMs > maxStaleMs
  ) {
    return { kind: "skip", accountLabel: label, reason: "stale-snapshot" };
  }

  // #2494 Bug A — classify against THIS tick's clock so the refill
  // normalization uses the same `now` the rest of the decision does (the
  // default `new Date()` would diverge from a frozen test clock / a replayed
  // tick and mis-zero a still-future reset window).
  const currentHealth = classifyHealth(snap, new Date(now));

  // Unknown (probe failed) or blocked — skip entirely.
  if (currentHealth === "unknown" || currentHealth === "blocked") {
    return { kind: "skip", accountLabel: label, reason: `${currentHealth}-not-our-domain` };
  }

  // Normalise prev: null means healthy (never alerted = was healthy).
  const prevHealth: "healthy" | "throttling" = prev.lastNotifiedHealth ?? "healthy";

  // Steady-state — no change.
  if (currentHealth === prevHealth) {
    return { kind: "skip", accountLabel: label, reason: "steady-state" };
  }

  // healthy → throttling: proactive threshold push.
  if (currentHealth === "throttling" && prevHealth === "healthy") {
    const newState: QuotaWatchAccountState = {
      lastNotifiedHealth: "throttling",
      lastNotifiedAt: now,
    };
    // Roll-dedupe (#3031 PR 3): a fresh broker-roll announcement for this
    // same account already covered the news — latch silently. FIRST
    // post-roll episode only (#3035 review, finding 3): if this account's
    // watch state has already advanced SINCE the roll (prev.lastNotifiedAt
    // >= roll.at — e.g. it recovered to healthy post-roll and is now
    // re-entering throttling), that is a genuinely NEW episode the roll
    // card said nothing about, so it must notify normally.
    const lastRoll = args.lastRoll;
    if (
      lastRoll &&
      lastRoll.from === label &&
      now - lastRoll.at <= QUOTA_WATCH_ROLL_DEDUP_MS &&
      prev.lastNotifiedAt < lastRoll.at
    ) {
      return {
        kind: "reconcile",
        accountLabel: label,
        newAccountState: newState,
        transition: "entered-throttling",
        reason: "roll-announced",
      };
    }
    return {
      kind: "notify",
      accountLabel: label,
      message: buildThrottlingMessage(agentName, snap),
      newAccountState: newState,
      transition: "entered-throttling",
    };
  }

  // throttling → healthy: recovery.
  if (currentHealth === "healthy" && prevHealth === "throttling") {
    const newState: QuotaWatchAccountState = {
      lastNotifiedHealth: "healthy",
      lastNotifiedAt: now,
    };
    // A recovery observed on the first post-boot tick is not attributable
    // to "just now" — the account may have recovered any time while this
    // gateway was down, and a fleet bounce synchronizes every agent's
    // first tick (the 2026-06-09 26-message flood). Reconcile silently.
    if (bootTick) {
      return {
        kind: "reconcile",
        accountLabel: label,
        newAccountState: newState,
        transition: "recovered-to-healthy",
        reason: "boot-tick-recovery",
      };
    }
    // Recovery whose matching 🟡 warning is hours old: the "all clear" is
    // no longer actionable news (the user has long moved on; /auth shows
    // live state on demand). Clear the latch without a message.
    if (lateRecoveryMs > 0 && now - prev.lastNotifiedAt > lateRecoveryMs) {
      return {
        kind: "reconcile",
        accountLabel: label,
        newAccountState: newState,
        transition: "recovered-to-healthy",
        reason: "late-recovery",
      };
    }
    return {
      kind: "notify",
      accountLabel: label,
      message: buildRecoveryMessage(agentName, snap),
      newAccountState: newState,
      transition: "recovered-to-healthy",
    };
  }

  // Any other combination (e.g. blocked → healthy, etc.) — skip.
  return { kind: "skip", accountLabel: label, reason: "no-matching-transition" };
}

// ─── Fleet-level: all accounts exhausted ───────────────────────────────────────

/**
 * Reserved key under which the fleet-wide "all accounts exhausted" alert state
 * is stored in the same quota-watch.json map. Not a valid account label (emails
 * can't contain this), so it never collides with a per-account entry, and the
 * per-account loop (which iterates account snapshots, not state-map keys) never
 * sees it. Encoded as a QuotaWatchAccountState so the existing load validator
 * accepts it: lastNotifiedHealth "throttling" = currently alerting all-exhausted,
 * "healthy"/null = not. Backward-compatible — old files simply lack the key.
 */
export const FLEET_ALL_EXHAUSTED_KEY = "__fleet_all_exhausted__";

export type FleetAllExhaustedDecision =
  | { kind: "notify"; message: string; newState: QuotaWatchAccountState; transition: "entered" | "recovered" }
  | { kind: "skip"; reason: string };

/**
 * Fleet-wide all-exhausted alert (edge-triggered).
 *
 * Fires ONCE when every account enters the broker's exhausted state (no healthy
 * account to fail over to — agents go quiet, crons defer, consumers/hindsight
 * silently serve an exhausted account), and ONCE on recovery. This catches the
 * cases the trigger-based interactive all-blocked card misses: a quiet period
 * (no agent happens to 429 into the wall) and the consumer/cron paths.
 *
 * Source: the broker's per-account `exhausted` flag (set by mark-exhausted via
 * failover + the consumer sensor). That flag is NOT purely live — `isAccountBlocked`
 * (src/auth/broker/account-eligibility.ts) falls back to the persisted
 * `exhausted_until` mark whenever there is no fresh live snapshot. During a
 * broker-unreachable / probe-timeout blackout, short-lived auto-fallback marks
 * can make `every(a.exhausted)` momentarily true with ZERO live corroboration
 * (#2478, klanker 2026-06-20). So the `entered` alert requires POSITIVE LIVE
 * CORROBORATION: an account counts toward "all exhausted" only when its
 * `exhausted` flag is backed by a FRESH live snapshot (last_quota.capturedAt
 * within `maxStaleMs`). If ANY account's exhaustion rests solely on a
 * stale/absent-probe mark we are
 * probe-blind and return `skip: "probe-blind"` — no false fleet alert. The
 * guarantee is "no false alarm off stale marks during a probe blackout", NOT
 * blanket probe-failure immunity. The `recovered` transition is unguarded so a
 * legitimately-fired alert is never stranded. Requires at least one account; an
 * empty fleet never alerts.
 */
export function evaluateFleetAllExhausted(args: {
  accounts: Array<{
    label: string;
    exhausted: boolean;
    exhausted_until?: number;
    /** Most-recent live probe snapshot, used to corroborate `exhausted`. */
    last_quota?: {
      capturedAt: number;
      overageDisabledReason?: string | null;
    } | null;
  }>;
  prev: QuotaWatchAccountState;
  now: number;
  /** Staleness ceiling for "fresh probe"; 0 disables the gate (legacy callers/tests). */
  tuning?: Pick<QuotaWatchTuning, "maxStaleMs">;
}): FleetAllExhaustedDecision {
  const { accounts, prev, now } = args;
  const maxStaleMs = args.tuning?.maxStaleMs ?? 0;
  const allExhausted = accounts.length > 0 && accounts.every((a) => a.exhausted);
  // "throttling" doubles as the "currently alerting all-exhausted" marker.
  const wasAlerting = prev.lastNotifiedHealth === "throttling";

  if (allExhausted && !wasAlerting) {
    // Probe-blind guard (#2478): only fire `entered` if EVERY account's
    // exhaustion is backed by live evidence — a fresh snapshot. An account
    // exhausted solely on a stale/absent mark means we have no live
    // corroboration → skip rather than false-alarm.
    if (maxStaleMs > 0) {
      const allLiveCorroborated = accounts.every((a) =>
        exhaustionLiveCorroborated(a, now, maxStaleMs),
      );
      if (!allLiveCorroborated) {
        return { kind: "skip", reason: "probe-blind" };
      }
    }
    return {
      kind: "notify",
      message: buildAllExhaustedMessage(accounts, now),
      newState: { lastNotifiedHealth: "throttling", lastNotifiedAt: now },
      transition: "entered",
    };
  }
  if (!allExhausted && wasAlerting) {
    return {
      kind: "notify",
      message: buildFleetRecoveredMessage(accounts),
      newState: { lastNotifiedHealth: "healthy", lastNotifiedAt: now },
      transition: "recovered",
    };
  }
  return { kind: "skip", reason: allExhausted ? "still-all-exhausted" : "not-all-exhausted" };
}

/**
 * Is an account's `exhausted` flag backed by live evidence (#2478)?
 *
 * True when the most-recent live probe is FRESH (`capturedAt` within
 * `maxStaleMs`) — that fresh probe is what set/upholds the broker's blocked
 * verdict. False when there is no `last_quota` at all, or the snapshot is
 * stale: the `exhausted` flag then rests solely on a persisted mark with no
 * live backing, which is exactly the probe-blind condition that false-fires
 * the fleet alert.
 *
 * NOTE: `out_of_credits` is NOT treated as corroboration here. Per
 * fix/out-of-credits-serve-block, out_of_credits is INFORMATIONAL — it is
 * not exhaustion in its own right at any util. Corroboration requires a
 * genuinely fresh quota snapshot (real 429 / util-wall path).
 *
 * Mirrors `snapshotFresh` in src/auth/broker/account-eligibility.ts (the
 * serving-side authority); kept as a local check so the decision layer
 * carries no broker dependency.
 */
function exhaustionLiveCorroborated(
  account: {
    last_quota?: { capturedAt: number; overageDisabledReason?: string | null } | null;
  },
  now: number,
  maxStaleMs: number,
): boolean {
  const lq = account.last_quota;
  if (!lq) return false;
  // Mirror `snapshotFresh`'s clock-skew guard: a future-dated `capturedAt`
  // makes `now - capturedAt` negative and would slip past the staleness gate,
  // so a skewed snapshot reads as fresh. Reject snapshots dated more than the
  // broker's 60_000 ms tolerance ahead of `now` (matches the inline literal in
  // `snapshotFresh`, src/auth/broker/account-eligibility.ts).
  return now - lq.capturedAt <= maxStaleMs && lq.capturedAt <= now + 60_000;
}

function buildAllExhaustedMessage(
  accounts: Array<{ label: string; exhausted_until?: number }>,
  now: number,
): string {
  const resets = accounts
    .map((a) => a.exhausted_until)
    .filter((x): x is number => typeof x === "number" && x > now);
  const earliest = resets.length > 0 ? Math.min(...resets) : null;
  const resetLine = earliest
    ? `Earliest reset: ${formatRelative(new Date(earliest), new Date(now))}.`
    : `Reset time unknown (no window data).`;
  return [
    `🔴 **All accounts exhausted**`,
    ``,
    `Every Anthropic account (${accounts.length}) is quota-walled — there is no healthy account to fail over to.`,
    resetLine,
    ``,
    `_This is self-healing: agents resume and deferred scheduled jobs run automatically once a window resets. Nothing is lost. Add headroom with \`/auth add\` if this recurs._`,
  ].join("\n");
}

function buildFleetRecoveredMessage(
  accounts: Array<{ label: string; exhausted: boolean }>,
): string {
  const healthy = accounts.filter((a) => !a.exhausted).map((a) => a.label);
  const which = healthy.length > 0 ? ` (\`${codeSpanSafe(healthy[0]!)}\`)` : "";
  return [
    `🟢 **Fleet recovered** — at least one account is healthy again${which}.`,
    ``,
    `_Agents are back; any deferred scheduled jobs will run on their next occurrence._`,
  ].join("\n");
}

// ─── Message builders ─────────────────────────────────────────────────────────

export function buildThrottlingMessage(agentName: string, snap: AccountSnapshot): string {
  const q = snap.quota!; // classifyHealth returned throttling, so quota is non-null
  const fiveStr = fmtPct(q.fiveHourUtilizationPct);
  const sevenStr = fmtPct(q.sevenDayUtilizationPct);
  const max = Math.max(q.fiveHourUtilizationPct, q.sevenDayUtilizationPct);
  const win = max === q.fiveHourUtilizationPct ? "5h" : "7d";
  const winLabel = win === "5h" ? "5-hour" : "7-day";
  const resetAt = win === "5h" ? q.fiveHourResetAt : q.sevenDayResetAt;
  const resetStr = resetAt
    ? ` · refills in ${formatRelative(resetAt, new Date())}`
    : "";

  const activeNote = snap.isActive
    ? ""
    : `\nThis is a non-active account. Consider \`/auth use ${codeSpanSafe(snap.label)}\` to switch, or keep it as a fallback reserve.`;

  // Early warning, not an incident (#3031 PR 3): say what happens NEXT so
  // the operator knows no action is required — if utilization keeps climbing
  // to the failover threshold, the broker rolls the fleet to another account
  // automatically and announces the switch.
  const altNote = snap.isActive
    ? `\nNo action needed: if usage keeps climbing, the fleet will prefer another account once this reaches the failover threshold (you'll get a switch announcement). Or switch early with \`/auth use <other-account>\`, or wait for the ${winLabel} window to refill${resetStr}.`
    : "";

  return [
    `🟡 **Quota approaching limit** — \`${codeSpanSafe(snap.label)}\``,
    ``,
    `${fiveStr} of 5h  ·  ${sevenStr} of 7d`,
    `Binding window: ${winLabel}${resetStr}`,
    `${activeNote}${altNote}`,
    ``,
    `_Threshold: ${THROTTLING_THRESHOLD_PCT}% on either window. Live-probe corroborated (#2495)._`,
    `_Run /auth for full fleet status or /usage for the active account._`,
  ]
    .join("\n")
    .replace(/\n\n\n+/g, "\n\n")
    .trim();
}

export function buildRecoveryMessage(agentName: string, snap: AccountSnapshot): string {
  const q = snap.quota;
  const utilLine = q
    ? `Current: ${fmtPct(q.fiveHourUtilizationPct)} of 5h  ·  ${fmtPct(q.sevenDayUtilizationPct)} of 7d`
    : "Current quota data unavailable.";

  return [
    `🟢 **Quota back in healthy range** — \`${codeSpanSafe(snap.label)}\``,
    ``,
    utilLine,
    ``,
    `_Below ${THROTTLING_THRESHOLD_PCT}% on both windows._`,
  ].join("\n");
}

// ─── State persistence ────────────────────────────────────────────────────────

export function loadQuotaWatchState(stateDir: string): QuotaWatchState {
  const path = join(stateDir, STATE_FILE);
  if (!existsSync(path)) return emptyQuotaWatchState();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyQuotaWatchState();
    }
    // Validate each entry — drop malformed ones rather than failing the whole file.
    const result: QuotaWatchState = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        (
          (val as Record<string, unknown>).lastNotifiedHealth === null ||
          (val as Record<string, unknown>).lastNotifiedHealth === "healthy" ||
          (val as Record<string, unknown>).lastNotifiedHealth === "throttling"
        ) &&
        typeof (val as Record<string, unknown>).lastNotifiedAt === "number" &&
        Number.isFinite((val as Record<string, unknown>).lastNotifiedAt as number)
      ) {
        result[key] = val as QuotaWatchAccountState;
      }
    }
    return result;
  } catch {
    return emptyQuotaWatchState();
  }
}

export function saveQuotaWatchState(stateDir: string, state: QuotaWatchState): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Merge one account's updated state into a full `QuotaWatchState` map.
 * Callers use this after each `evaluateQuotaWatchAccount` that returns
 * `kind: "notify"` to produce the new map to persist.
 */
export function patchQuotaWatchState(
  current: QuotaWatchState,
  accountLabel: string,
  accountState: QuotaWatchAccountState,
): QuotaWatchState {
  return { ...current, [accountLabel]: accountState };
}
