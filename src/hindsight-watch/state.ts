/**
 * Durable state for the hindsight watchdog: the rolling sample window plus
 * the per-signal hysteresis counters.
 *
 * Lives at `~/.switchroom/hindsight-watch/state.json` (tmp+rename, 0600).
 * Two properties it must hold:
 *
 *  - A torn/absent/garbage file degrades to an EMPTY state, never a throw.
 *    The watchdog then reports `no-data` for a window and re-baselines —
 *    which is honest, and strictly better than a crashed cron.
 *  - A write failure is NOT swallowed: `saveState` throws, and the caller
 *    turns that into a loud non-zero exit. A watchdog that silently cannot
 *    persist its window would re-fire the same alert forever (or never
 *    accumulate the breaches to fire at all).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  MAX_SAMPLE_AGE_MS,
  RECALL_BASELINE_DAYS,
  RECALL_BASELINE_MAX_OBS_PER_DAY,
  RING_MAX,
} from "./thresholds.js";
import {
  emptyState,
  type BankFailureStreak,
  type BankPendingConsolidation,
  type RecallBaseline,
  type RecallBaselineDay,
  type Sample,
  type WatchState,
} from "./types.js";

/** Default state-file path, honouring `SWITCHROOM_HOME` like the rest of the CLI. */
export function defaultStatePath(
  home: string = process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
): string {
  return resolve(home, ".switchroom", "hindsight-watch", "state.json");
}

/** Read state, degrading to empty on absent/torn/foreign-version files. */
export function loadState(path: string): WatchState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyState();
  const s = parsed as Partial<WatchState>;
  if (s.v !== 1 || !Array.isArray(s.ring)) return emptyState();
  const ring = s.ring
    .filter(isSample)
    .map((sample) => ({
      ...sample,
      recall: normalizeRecallSample(sample.recall),
      consolidation: normalizeConsolidationSample(sample.consolidation),
      banks: normalizeBankSample(sample.banks),
      vectorIndex: normalizeVectorIndexSample(sample.vectorIndex),
    }))
    .slice(-RING_MAX);
  const signals = typeof s.signals === "object" && s.signals !== null ? s.signals : {};
  const baseline = normalizeBaseline(s.baseline);
  return baseline === null ? { v: 1, ring, signals } : { v: 1, ring, signals, baseline };
}

/**
 * Validate the persisted trailing baseline, or drop it to `null`.
 *
 * Same fail-closed contract as the sample validators, and it matters MORE here
 * because this block is the denominator of `recall-quality-regression`: a
 * garbage observation would propagate into a median and then into a division,
 * and the resulting NaN would compare false against both thresholds — the
 * fail-open shape the rest of this file exists to prevent. So the filtering is
 * per-value, not per-block: a day keeps the observations that are real numbers
 * and drops the rest, and a day left with nothing is dropped entirely.
 *
 * The per-day cap is re-applied on LOAD as well as on fold. A hand-edited or
 * downgraded-then-upgraded state file could otherwise carry an unbounded array
 * into memory, and this structure's whole licence to exist is that it is
 * bounded.
 */
export function normalizeBaseline(x: unknown): RecallBaseline | null {
  if (x === null || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  if (!Array.isArray(b.days)) return null;
  const days: RecallBaselineDay[] = [];
  for (const raw of b.days) {
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as Record<string, unknown>;
    // `YYYY-MM-DD` exactly: the day key is compared with `<` and `localeCompare`
    // throughout `baseline.ts`, and both are only meaningful on a fixed-width
    // lexicographically-sortable string.
    if (typeof d.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue;
    const scoreObs = numbers(d.scoreObs);
    const poolObs = numbers(d.poolObs);
    if (scoreObs.length === 0 && poolObs.length === 0) continue;
    days.push({ day: d.day, scoreObs, poolObs });
  }
  if (days.length === 0) return null;
  days.sort((a, b2) => a.day.localeCompare(b2.day));
  return { days: days.slice(-(RECALL_BASELINE_DAYS + 1)) };
}

/** Finite, non-negative observations only, capped, keeping the NEWEST. */
function numbers(x: unknown): number[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
    .slice(-RECALL_BASELINE_MAX_OBS_PER_DAY);
}

/**
 * A count field is valid when it is a finite, non-negative number.
 *
 * Load-bearing rather than pedantic. If a persisted `recall` block carried
 * `undefined` for a field — an older build, a hand-edited file, a partial
 * write — the evaluators would compute `undefined / undefined = NaN`, and
 * every `NaN >= threshold` comparison is FALSE. A corrupt block would
 * therefore evaluate as a clean pass on all six recall signals: the exact
 * fail-open shape this whole change exists to remove. Validating here drops a
 * bad block to `null`, which the evaluators report as `no-data` — inert,
 * visible, and never a silent all-clear.
 */
function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/** A statistic that is legitimately absent when its sample was empty. */
function isNullableStat(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isFinite(x));
}

/**
 * Validate a persisted `recall` block, or drop it to `null`.
 *
 * All-or-nothing: a block missing ANY field is rejected wholesale rather than
 * patched with zeroes, because a zero here is indistinguishable from a real
 * measurement of zero and would score as either a perfect pass or a false
 * page depending on the SLI.
 */
export function normalizeRecallSample(x: unknown): Sample["recall"] {
  if (x === null || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const counts = [
    "rows",
    "agents",
    "timeoutConsidered",
    "ownBankDegraded",
    "zeroConsidered",
    "zeroResult",
    "poolConsidered",
    "scoreConsidered",
    "elapsedConsidered",
  ];
  if (!counts.every((k) => isCount(r[k]))) return null;
  if (!isNullableStat(r.poolMedian)) return null;
  if (!isNullableStat(r.scoreP50)) return null;
  if (!isNullableStat(r.elapsedP95Ms)) return null;
  return x as Sample["recall"];
}

/** Validate a persisted `consolidation` block, or drop it to `null`. */
export function normalizeConsolidationSample(x: unknown): Sample["consolidation"] {
  if (x === null || typeof x !== "object") return null;
  const c = x as Record<string, unknown>;
  if (!isCount(c.pending) || !isCount(c.oldestAgeS)) return null;
  return x as Sample["consolidation"];
}

/**
 * Validate a persisted per-bank consolidation block, or drop it to `null`.
 *
 * All-or-nothing per ROW, wholesale for the block: a row missing a field is
 * dropped, but only after the block's two arrays are confirmed to be arrays.
 * A partially-parsed block is still honest — every row it keeps was fully
 * validated — and dropping the whole block because one row was malformed
 * would turn a cosmetic defect into blindness on the signal that exists to
 * end blindness.
 */
export function normalizeBankSample(x: unknown): Sample["banks"] {
  if (x === null || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  if (!Array.isArray(b.streaks) || !Array.isArray(b.pending)) return null;
  const streaks = b.streaks.filter((r): r is BankFailureStreak => {
    if (typeof r !== "object" || r === null) return false;
    const s = r as Record<string, unknown>;
    return (
      typeof s.bank === "string" &&
      typeof s.operationType === "string" &&
      isCount(s.streak) &&
      isCount(s.newestFailureAgeS)
    );
  });
  const pending = b.pending.filter((r): r is BankPendingConsolidation => {
    if (typeof r !== "object" || r === null) return false;
    const p = r as Record<string, unknown>;
    return typeof p.bank === "string" && isCount(p.pending);
  });
  return { streaks, pending };
}

/** Validate a persisted HNSW canary block, or drop it to `null`. */
export function normalizeVectorIndexSample(x: unknown): Sample["vectorIndex"] {
  if (x === null || typeof x !== "object") return null;
  const v = x as Record<string, unknown>;
  if (!isCount(v.probed)) return null;
  if (!Array.isArray(v.corrupt) || !v.corrupt.every((s) => typeof s === "string")) return null;
  return { probed: v.probed, corrupt: v.corrupt as string[] };
}

function isSample(x: unknown): x is Sample {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Partial<Sample>;
  return (
    typeof s.ts === "number" &&
    Number.isFinite(s.ts) &&
    // `retainOk`/`retainFail` are deliberately NOT required: a tick whose
    // `/metrics` body was over the cap persists without them, and discarding
    // that sample would also discard its recall block, which was fine. They
    // are type-checked only when present — `evaluateFailureRate` skips any
    // interval missing them rather than zero-filling.
    (s.retainOk === undefined || typeof s.retainOk === "number") &&
    (s.retainFail === undefined || typeof s.retainFail === "number") &&
    typeof s.pending === "number" &&
    typeof s.dead === "number" &&
    typeof s.evicted === "number" &&
    typeof s.drops === "number" &&
    typeof s.restartCount === "number" &&
    typeof s.startedAt === "string" &&
    typeof s.health === "string"
  );
}

/**
 * Append a sample, keeping the window at `RING_MAX` AND dropping anything
 * older than `MAX_SAMPLE_AGE_MS` relative to the new sample.
 *
 * The age prune is the guard against a stopped cron: without it, a watchdog
 * that was down for a day would come back and compute its first verdict
 * across a day-wide window (see `MAX_SAMPLE_AGE_MS`). Samples dated in the
 * future (clock skew / a restored backup) are dropped for the same reason.
 */
export function pushSample(state: WatchState, sample: Sample): WatchState {
  const floor = sample.ts - MAX_SAMPLE_AGE_MS;
  const kept = state.ring.filter((s) => s.ts >= floor && s.ts <= sample.ts);
  return { ...state, ring: [...kept, sample].slice(-RING_MAX) };
}

/** Atomic write. Throws on failure — the caller must exit loudly. */
export function saveState(path: string, state: WatchState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // pid-scoped tmp name: two concurrent ticks (a hand-run alongside the cron)
  // must not rename each other's half-written file into place.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
