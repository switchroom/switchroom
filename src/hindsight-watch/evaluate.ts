/**
 * The pure evaluator: a rolling window of probe samples in, one verdict per
 * signal out. No IO, no clock, no state mutation — every threshold decision
 * in the watchdog is decided here and is therefore unit-testable against
 * hand-built windows (see `evaluate.test.ts`, which replays the shape of the
 * 2026-07 retain-failure storm).
 */

import { counterDelta } from "./metrics.js";
import {
  CONSOLIDATION_AGE_PAGE_S,
  CONSOLIDATION_AGE_WARN_S,
  CONSOLIDATION_FAILURE_STREAK_PAGE,
  CONSOLIDATION_FAILURE_STREAK_WARN,
  CONSOLIDATION_STREAK_RECENCY_S,
  LLM_FAILURE_RATE_PAGE,
  LLM_FAILURE_RATE_WARN,
  LLM_MIN_SAMPLES,
  MIN_RETAIN_SAMPLES,
  PENDING_CONSOLIDATION_FLOOR,
  PENDING_CONSOLIDATION_GROWTH_FRACTION,
  PENDING_CONSOLIDATION_GROWTH_PAGE_ABS,
  PENDING_CONSOLIDATION_GROWTH_WARN_ABS,
  QUEUE_FLOOR,
  QUEUE_GROWTH_FRACTION,
  QUEUE_GROWTH_MIN_ABS,
  RECALL_MIN_SAMPLES,
  RECALL_OWN_BANK_TIMEOUT_PAGE,
  RECALL_OWN_BANK_TIMEOUT_WARN,
  RECALL_POOL_MEDIAN_PAGE,
  RECALL_POOL_MEDIAN_WARN,
  RECALL_SCORE_P50_PAGE,
  RECALL_SCORE_P50_WARN,
  RECALL_WALL_MS,
  RECALL_ZERO_MEMORY_PAGE,
  RECALL_ZERO_MEMORY_WARN,
  RETAIN_FAILURE_RATE,
} from "./thresholds.js";
import type {
  BankFailureStreak,
  RecallSample,
  Sample,
  SignalId,
  Verdict,
} from "./types.js";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function windowMinutes(ring: Sample[]): number {
  if (ring.length < 2) return 0;
  return Math.round((ring[ring.length - 1].ts - ring[0].ts) / 60_000);
}

/**
 * Sum the per-interval deltas across the window. Summing PAIRWISE deltas
 * (rather than last-minus-first) is what makes the signal survive counter
 * resets: a restart mid-window zeroes the counters, and only the one
 * straddling interval is re-based instead of the whole window reading
 * negative.
 */
function windowRetainCounts(ring: Sample[]): { ok: number; fail: number; intervals: number } {
  let ok = 0;
  let fail = 0;
  let intervals = 0;
  for (let i = 1; i < ring.length; i++) {
    const pOk = ring[i - 1].retainOk;
    const nOk = ring[i].retainOk;
    const pFail = ring[i - 1].retainFail;
    const nFail = ring[i].retainFail;
    // Skip, do not zero-fill. A tick whose `/metrics` body was over the cap
    // carries no retain counters at all; treating the gap as 0-to-0 would
    // add a clean interval that never happened and dilute the failure rate
    // toward pass. `counterDelta(undefined, n)` would be NaN, and every
    // `NaN >= threshold` is false — the same fail-open trap by another route.
    if (
      typeof pOk !== "number" ||
      typeof nOk !== "number" ||
      typeof pFail !== "number" ||
      typeof nFail !== "number"
    ) {
      continue;
    }
    ok += counterDelta(pOk, nOk);
    fail += counterDelta(pFail, nFail);
    intervals++;
  }
  return { ok, fail, intervals };
}

/** S1 — retain failure rate over the rolling window. The storm signal. */
export function evaluateFailureRate(ring: Sample[]): Verdict {
  const signal = "retain-failure-rate" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to compute a rate" };
  }
  const { ok, fail, intervals } = windowRetainCounts(ring);
  const total = ok + fail;
  const mins = windowMinutes(ring);
  if (intervals === 0) {
    return {
      signal,
      state: "no-data",
      detail: `no tick pair in the last ${mins}m carried retain counters — /metrics was unreadable throughout`,
      measured: { windowMinutes: mins },
    };
  }
  if (total < MIN_RETAIN_SAMPLES) {
    return {
      signal,
      state: "no-data",
      detail: `only ${total} retain(s) in the last ${mins}m — below the ${MIN_RETAIN_SAMPLES}-sample floor`,
      measured: { total, windowMinutes: mins },
    };
  }
  const rate = fail / total;
  const detail =
    `retain failure rate ${pct(rate)} (${fail}/${total}) over ${mins}m ` +
    `— threshold ${pct(RETAIN_FAILURE_RATE)}`;
  return {
    signal,
    state: rate >= RETAIN_FAILURE_RATE ? "breach" : "ok",
    detail,
    measured: { rate, fail, total, windowMinutes: mins },
  };
}

/**
 * S2 — spool depth RISING, not merely non-zero.
 *
 * The spool is a retry queue: non-zero is normal and draining is healthy.
 * We compare the newest depth against the window-start depth, so a drain is
 * silent and a turnaround is loud.
 *
 * Both thresholds are stated in the spool's post-#3610 unit — memory PARTS,
 * not memories — because that is what a queue entry is once oversized
 * retains are split. `QUEUE_FLOOR` and `QUEUE_GROWTH_MIN_ABS` carry the
 * conversion and its measurement.
 *
 * Severity is `warn`, NEVER a page — this is the correction to the 2026-08-05
 * false alarm. A rising spool is a retry backlog draining slowly, NOT memory
 * loss: the spool is DURABLE, every entry is retried until it persists, and a
 * memory only leaves it UNpersisted at the per-agent
 * `HINDSIGHT_PENDING_MAX_ENTRIES` / `MAX_BYTES` cap — which `retain-loss`
 * watches via the `pending-evicted/` sibling. So this signal must render 🟠
 * "degraded", not the 🔴 red an operator reads as "memories are being lost".
 *
 * Evidence (host `switchroom`, live, read-only, 2026-08-05): a ~2,300-part
 * fleet backlog (klanker 1,051 + overlord 860, both well under the 2,000-entry
 * per-agent cap) drained steadily with EVERY loss channel at zero — no
 * `.dead`, no evicted entry, no drop — while all 5,459 lines of that day's
 * `pending-evictions.log` were `reason=archive-count` trims of the DURABLE
 * `pending-reconciled/` archive (housekeeping of already-persisted entries,
 * capped at 500), not undrained eviction. An under-cap backlog is drain-lag;
 * only `retain-loss` may claim loss.
 */
export function evaluateQueueGrowth(ring: Sample[]): Verdict {
  const signal = "retain-queue-growth" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to see a trend" };
  }
  const first = ring[0].pending;
  const last = ring[ring.length - 1].pending;
  const mins = windowMinutes(ring);
  const growth = last - first;
  const need = Math.max(QUEUE_GROWTH_MIN_ABS, Math.ceil(QUEUE_GROWTH_FRACTION * first));
  const breach = last >= QUEUE_FLOOR && growth >= need;
  const trend = growth > 0 ? `+${growth}` : String(growth);
  const detail =
    `pending retains ${first} → ${last} (${trend}) over ${mins}m ` +
    `— backlog draining slowly, NOT loss (retries persist; memory is only ` +
    `shed at the per-agent cap, watched by retain-loss). ` +
    `Fires at ≥${QUEUE_FLOOR} deep AND +${need} growth`;
  const measured = { pending: last, growth, windowMinutes: mins, growthNeeded: need };
  if (breach) {
    return { signal, state: "breach", severity: "warn", detail, measured };
  }
  return { signal, state: "ok", detail, measured };
}

/**
 * S2b — a memory left the queue WITHOUT being persisted. Edge-triggered on
 * the newest interval; any increase is worth one DM regardless of scale.
 *
 * Three channels, because after #3599 `.dead` alone is no longer the whole
 * story:
 *
 *  - `*.json.dead` — a retain retried to `MAX_ATTEMPTS` exhaustion ON A
 *    PERMANENT failure. Still a real signal (18 markers live on this fleet
 *    today), and successively STRONGER. #3610 removed its dominant benign
 *    cause: 154 of the 629 entries in the 2026-07-25 backlog were `.dead`
 *    only because they were too big to complete inside any client deadline,
 *    and those now split and drain. The permanence gate in
 *    `pending.is_permanent_failure` removed the rest — a 5xx, a timeout or a
 *    connection error now keeps the entry queued instead of retiring it, so
 *    a flaky extraction model can no longer manufacture `.dead` markers. A
 *    marker today means the server positively REJECTED the request (a 4xx
 *    other than 408/425/429), which is close to always a genuine fault.
 *  - `pending-evicted/` — memory shed at the queue's `MAX_ENTRIES` /
 *    `MAX_BYTES` cap. Archived rather than persisted, and under a full disk
 *    `_evict_to_fit` removes outright. This is the ONLY eviction channel this
 *    signal reads. It is NOT the `pending-evictions.log` ledger, whose
 *    `reason=archive-count` lines are trims of DURABLE archives
 *    (`pending-reconciled/`, capped at 500) — housekeeping of
 *    already-persisted entries, not undrained loss. Counting those was the
 *    root of the 2026-08-05 false alarm; this signal never has.
 *  - `pending-drops.json` — `record_drop`: the retain could not be written
 *    to the queue at all. The rarest and the most final.
 *
 * They are one signal because they are one operator question ("did we lose
 * memory since the last check?") and one action. The detail line names which
 * channel moved, so the DM is still specific.
 *
 * A DECREASE is a re-baseline, not a breach — the operator clearing `.dead`
 * files by hand, or the evicted archive being trimmed by its own bound, must
 * not read as a fault. The cost of that rule is a trim that exactly cancels
 * an eviction inside one interval, which this signal cannot see; the
 * append-only `pending-evictions.log` and the `switchroom doctor` row remain
 * the authority for eviction history.
 */
export function evaluateRetainLoss(ring: Sample[]): Verdict {
  const signal = "retain-loss" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to see new losses" };
  }
  const prev = ring[ring.length - 2];
  const last = ring[ring.length - 1];
  const channels: Array<[string, number]> = [
    [".dead marker", last.dead - prev.dead],
    ["evicted entry", last.evicted - prev.evicted],
    ["dropped retain", last.drops - prev.drops],
  ];
  const risen = channels.filter(([, added]) => added > 0);
  // Collapsed duplicates are NOT a loss channel — they are never added to
  // `channels` and never fire this signal. `collapse_duplicates()` MOVES a
  // byte-identical redundant entry into `pending-duplicate/`
  // (`lib/pending.py:archive_duplicate`) while the surviving copy stays
  // queued, so a large collapse pass shrinks the spool with no memory lost.
  // Surfaced in the totals only so that shrink reads as a drain WITH a cause,
  // not as unexplained loss (#3896). Absent (older sample) ⇒ omitted, not 0.
  const dup = last.duplicates;
  const dupNote =
    typeof dup === "number" && dup > 0 ? `, ${dup} collapsed-duplicate (not loss)` : "";
  const totals = `totals: ${last.dead} dead, ${last.evicted} evicted, ${last.drops} dropped${dupNote}`;
  if (risen.length > 0) {
    return {
      signal,
      state: "breach",
      detail:
        `${risen.map(([name, added]) => `${added} new ${name}(s)`).join(", ")} ` +
        `since the last check (${totals}) — memory left the queue unpersisted`,
      measured: {
        deadAdded: last.dead - prev.dead,
        evictedAdded: last.evicted - prev.evicted,
        dropsAdded: last.drops - prev.drops,
        dead: last.dead,
        evicted: last.evicted,
        drops: last.drops,
        duplicates: dup ?? 0,
      },
    };
  }
  return {
    signal,
    state: "ok",
    detail: `no new memory loss (${totals})`,
    measured: {
      deadAdded: 0,
      evictedAdded: 0,
      dropsAdded: 0,
      dead: last.dead,
      evicted: last.evicted,
      drops: last.drops,
      duplicates: dup ?? 0,
    },
  };
}

/** S3 — container unhealthy, restarted, or recreated since the last check. */
export function evaluateContainer(ring: Sample[]): Verdict {
  const signal = "container" as const;
  if (ring.length === 0) {
    return { signal, state: "no-data", detail: "no samples" };
  }
  const last = ring[ring.length - 1];
  const reasons: string[] = [];
  if (last.health !== "healthy" && last.health !== "none") {
    reasons.push(`health=${last.health}`);
  }
  if (ring.length >= 2) {
    const prev = ring[ring.length - 2];
    if (last.restartCount > prev.restartCount) {
      reasons.push(`RestartCount ${prev.restartCount} → ${last.restartCount}`);
    }
    // A recreate resets RestartCount to 0, so StartedAt is the only signal
    // that survives it — without this a crash-recreate loop reads as calm.
    if (last.startedAt !== prev.startedAt) {
      reasons.push(`restarted/recreated at ${last.startedAt}`);
    }
  }
  if (reasons.length > 0) {
    return {
      signal,
      state: "breach",
      detail: `container: ${reasons.join("; ")}`,
      measured: { health: last.health, restartCount: last.restartCount, startedAt: last.startedAt },
    };
  }
  return {
    signal,
    state: "ok",
    detail: `container healthy, RestartCount ${last.restartCount}, up since ${last.startedAt}`,
    measured: { health: last.health, restartCount: last.restartCount, startedAt: last.startedAt },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Recall — the READ half
//
// These read the NEWEST sample rather than differencing across the window,
// because each is already a statistic over a window of its own: one tick
// reduces the trailing 200 recall rows per agent (`probeRecallLogs`). Taking
// deltas of a median would be meaningless, and taking deltas of a rate would
// re-derive a rate that is already correct.
//
// A missing `recall` block is `no-data`, never a pass. That is the single
// most important line in this file: the fleet-wide silence this module exists
// to end was produced by exactly one habit — treating "I could not measure
// it" as "it is fine".
// ─────────────────────────────────────────────────────────────────────────

/** The newest sample's recall reduction, or null. */
function latestRecall(ring: Sample[]): RecallSample | null {
  if (ring.length === 0) return null;
  return ring[ring.length - 1].recall ?? null;
}

function noRecallData(signal: SignalId): Verdict {
  return {
    signal,
    state: "no-data",
    detail: "no recall telemetry in this tick — recall log unread or empty",
  };
}

/**
 * Score a rate against a warn/page pair where HIGHER is worse.
 *
 * `page >= warn` is an invariant of every pair here; the page test runs first
 * so a reading past both reports the worse of the two.
 */
function scoreHigherIsWorse(
  value: number,
  warn: number,
  page: number,
): { state: "breach" | "ok"; severity?: "warn" | "page" } {
  if (value >= page) return { state: "breach", severity: "page" };
  if (value >= warn) return { state: "breach", severity: "warn" };
  return { state: "ok" };
}

/** As above, for the two SLIs where LOWER is worse (pool depth, score). */
function scoreLowerIsWorse(
  value: number,
  warn: number,
  page: number,
): { state: "breach" | "ok"; severity?: "warn" | "page" } {
  if (value <= page) return { state: "breach", severity: "page" };
  if (value <= warn) return { state: "breach", severity: "warn" };
  return { state: "ok" };
}

/**
 * Render the modal `error` string as a DM suffix, or "" when absent.
 *
 * Purely presentational — deliberately NOT an input to any threshold, so a
 * malformed value can shorten the message but can never change a verdict. The
 * type guard matters because the string arrives from a persisted JSON blob
 * that `normalizeRecallSample` intentionally does not police (it polices only
 * the fields decisions read). Bounded to keep one pathological row from
 * blowing out a Telegram DM.
 */
function errorSuffix(r: { topError?: string | null }): string {
  if (typeof r.topError !== "string" || r.topError.trim() === "") return "";
  const text = r.topError.trim();
  return `\n  most common failure: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

/**
 * Render recall wall time as DM context, or "" when unavailable.
 *
 * There is deliberately no `recall-latency` SIGNAL — see the deletion note in
 * `thresholds.ts`, where the 8037 ms healthy p95 (right-censored at the retired
 * 8 s wall) is shown to leave no thresholdable band below the 10 s recall
 * deadline the #3759 declarative envelope resolves to ({@link RECALL_WALL_MS}).
 * The measurement is still worth SHOWING: it is what distinguishes "own-bank
 * recall failed"
 * meaning *timed out at the wall* from meaning *errored immediately*, which
 * is the first question the operator asks and the cheapest one to pre-answer.
 *
 * Presentational only, exactly like `errorSuffix` — no threshold reads it, so
 * it can never move a verdict.
 */
function latencySuffix(r: { elapsedP95Ms?: number | null; elapsedConsidered?: number }): string {
  const p95 = r.elapsedP95Ms;
  if (typeof p95 !== "number" || !Number.isFinite(p95)) return "";
  const n = typeof r.elapsedConsidered === "number" ? r.elapsedConsidered : 0;
  return `\n  recall wall time p95 ${Math.round(p95)}ms over ${n} fire(s) (not thresholded — the ${RECALL_WALL_MS}ms recall deadline leaves no healthy band below it)`;
}

/**
 * R1 — own-bank timeout rate.
 *
 * The agent's own bank is the one holding its memory. A recall that misses it
 * is amnesiac in practice even when `result_count > 0`, because whatever came
 * back came from the smaller side banks.
 */
export function evaluateRecallOwnBankTimeout(ring: Sample[]): Verdict {
  const signal = "recall-own-bank-timeout" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);
  if (r.timeoutConsidered < RECALL_MIN_SAMPLES) {
    return {
      signal,
      state: "no-data",
      detail:
        `only ${r.timeoutConsidered} recall(s) carrying bank_timings ` +
        `— below the ${RECALL_MIN_SAMPLES}-row floor`,
      measured: { considered: r.timeoutConsidered },
    };
  }
  const rate = r.ownBankDegraded / r.timeoutConsidered;
  const { state, severity } = scoreHigherIsWorse(
    rate,
    RECALL_OWN_BANK_TIMEOUT_WARN,
    RECALL_OWN_BANK_TIMEOUT_PAGE,
  );
  return {
    signal,
    state,
    severity,
    detail:
      `own-bank recall failed on ${pct(rate)} of fires ` +
      `(${r.ownBankDegraded}/${r.timeoutConsidered} across ${r.agents} agent(s)) ` +
      `— warn ${pct(RECALL_OWN_BANK_TIMEOUT_WARN)}, page ${pct(RECALL_OWN_BANK_TIMEOUT_PAGE)}` +
      errorSuffix(r) +
      latencySuffix(r),
    measured: {
      rate,
      degraded: r.ownBankDegraded,
      considered: r.timeoutConsidered,
      agents: r.agents,
    },
  };
}

/**
 * R2 — zero-memory turn rate.
 *
 * Corroboration, not the primary: an empty match is legitimately common, so
 * this only becomes evidence at a rate no ordinary query mix explains.
 */
export function evaluateRecallZeroMemory(ring: Sample[]): Verdict {
  const signal = "recall-zero-memory" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);
  if (r.zeroConsidered < RECALL_MIN_SAMPLES) {
    return {
      signal,
      state: "no-data",
      detail: `only ${r.zeroConsidered} scoreable recall(s) — below the ${RECALL_MIN_SAMPLES}-row floor`,
      measured: { considered: r.zeroConsidered },
    };
  }
  const rate = r.zeroResult / r.zeroConsidered;
  const { state, severity } = scoreHigherIsWorse(
    rate,
    RECALL_ZERO_MEMORY_WARN,
    RECALL_ZERO_MEMORY_PAGE,
  );
  return {
    signal,
    state,
    severity,
    detail:
      `${pct(rate)} of recalls injected NO memory ` +
      `(${r.zeroResult}/${r.zeroConsidered}) ` +
      `— warn ${pct(RECALL_ZERO_MEMORY_WARN)}, page ${pct(RECALL_ZERO_MEMORY_PAGE)}`,
    measured: { rate, zero: r.zeroResult, considered: r.zeroConsidered },
  };
}

/**
 * R3 — candidate-pool floor.
 *
 * One of the two signals that see a fast, successful, near-empty recall.
 * Nothing else in this repo scores it: `doctor-recall-health.ts` explicitly
 * declines to score `result_count`, the healthcheck is a TCP connect, and
 * `probeHindsight` is one MCP `initialize`.
 */
export function evaluateRecallCandidateFloor(ring: Sample[]): Verdict {
  const signal = "recall-candidate-floor" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);
  if (r.poolConsidered < RECALL_MIN_SAMPLES || r.poolMedian === null) {
    return {
      signal,
      state: "no-data",
      detail: `only ${r.poolConsidered} recall(s) reporting pre_cap_count — below the ${RECALL_MIN_SAMPLES}-row floor`,
      measured: { considered: r.poolConsidered },
    };
  }
  const { state, severity } = scoreLowerIsWorse(
    r.poolMedian,
    RECALL_POOL_MEDIAN_WARN,
    RECALL_POOL_MEDIAN_PAGE,
  );
  return {
    signal,
    state,
    severity,
    detail:
      `median candidate pool ${r.poolMedian} memories over ${r.poolConsidered} recall(s) ` +
      `— warn ≤${RECALL_POOL_MEDIAN_WARN}, page ≤${RECALL_POOL_MEDIAN_PAGE}. ` +
      `A small pool means retrieval returned almost nothing to rank, ` +
      `which no latency or timeout signal can see.`,
    measured: { poolMedian: r.poolMedian, considered: r.poolConsidered },
  };
}

/**
 * R4 — injected top-hit score.
 *
 * The other signal that sees the invisible failure, and independent of R3: a
 * healthy-sized pool of irrelevant candidates clears the floor and still
 * poisons the turn.
 */
export function evaluateRecallInjectedScore(ring: Sample[]): Verdict {
  const signal = "recall-injected-score" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);
  if (r.scoreConsidered < RECALL_MIN_SAMPLES || r.scoreP50 === null) {
    return {
      signal,
      state: "no-data",
      detail:
        `only ${r.scoreConsidered} recall(s) injected a scored memory ` +
        `— below the ${RECALL_MIN_SAMPLES}-row floor`,
      measured: { considered: r.scoreConsidered },
    };
  }
  const { state, severity } = scoreLowerIsWorse(
    r.scoreP50,
    RECALL_SCORE_P50_WARN,
    RECALL_SCORE_P50_PAGE,
  );
  return {
    signal,
    state,
    severity,
    detail:
      `p50 injected top-hit score ${r.scoreP50.toFixed(4)} over ${r.scoreConsidered} recall(s) ` +
      `— warn ≤${RECALL_SCORE_P50_WARN}, page ≤${RECALL_SCORE_P50_PAGE}. ` +
      `Half of all turns had nothing injected scoring above this.`,
    measured: { scoreP50: r.scoreP50, considered: r.scoreConsidered },
  };
}

/*
 * There is no `evaluateRecallLatency`. `total_elapsed_ms` IS summarised (into
 * `RecallSample.elapsedP95Ms`) and IS shown, via `latencySuffix` on R1 — it
 * just carries no threshold, because the only healthy p95 ever measured
 * (8037 ms) is right-censored at the retired 8 s wall, and against the 10 s
 * recall deadline the #3759 declarative envelope resolves to ({@link
 * RECALL_WALL_MS}) there is still no band left underneath it. The full
 * derivation, including the bootstrap that breaches a 6000 ms line in 100 % of
 * healthy draws, is in `thresholds.ts` where the constants would otherwise have
 * lived.
 */

/**
 * R5 — consolidation queue age.
 *
 * `docker/hindsight-maintenance.sh` already computes this every tick and
 * writes it to a container log. This is the same measurement with a
 * destination a human actually reads.
 */
export function evaluateConsolidationQueueAge(ring: Sample[]): Verdict {
  const signal = "consolidation-queue-age" as const;
  if (ring.length === 0) return { signal, state: "no-data", detail: "no samples" };
  const c = ring[ring.length - 1].consolidation ?? null;
  if (c === null) {
    return {
      signal,
      state: "no-data",
      detail:
        "consolidation queue not probed this tick (no psql client, no pg descriptor, " +
        "or the container is down) — the `container` signal covers the last of those",
    };
  }
  if (c.pending === 0) {
    return {
      signal,
      state: "ok",
      // NOT "consolidation queue empty" — that string reads as an all-clear on
      // the exact state a fully-FAILED queue produces. The failing path calls
      // `_mark_operation_failed` within milliseconds, so a bank whose
      // consolidation fails deterministically empties `status IN
      // ('pending','processing')` and lands here looking healthiest when it is
      // most broken (observed 2026-07-29: pending 0 for 2.5h while 37,711
      // memories went unconsolidated). This signal only ever sees the
      // pending/processing set; terminal failures are counted by
      // `consolidation-failure-streak`, and the detail says so (#3989).
      detail:
        "no pending/processing operations (failures are not counted here — " +
        "see consolidation-failure-streak)",
      measured: { pending: 0, oldestAgeS: 0 },
    };
  }
  const { state, severity } = scoreHigherIsWorse(
    c.oldestAgeS,
    CONSOLIDATION_AGE_WARN_S,
    CONSOLIDATION_AGE_PAGE_S,
  );
  const hours = (s: number): string => `${(s / 3600).toFixed(1)}h`;
  return {
    signal,
    state,
    severity,
    detail:
      `${c.pending} pending/processing async op(s), oldest ${hours(c.oldestAgeS)} old ` +
      `— warn ≥${hours(CONSOLIDATION_AGE_WARN_S)}, page ≥${hours(CONSOLIDATION_AGE_PAGE_S)}`,
    measured: { pending: c.pending, oldestAgeS: c.oldestAgeS },
  };
}

/**
 * R6 — CONSECUTIVE terminal consolidation failures for one bank.
 *
 * The signal above, `consolidation-queue-age`, structurally cannot raise on
 * this. Its only SQL is `... WHERE status IN ('pending','processing')` and the
 * failing path calls `_mark_operation_failed` within milliseconds, so a
 * deterministically failing bank empties that set and reads OK (its detail no
 * longer claims "consolidation queue empty" — #3989 — but it still cannot
 * raise here). On 2026-07-29 the API reported
 * `pending_operations: 0, failed_operations: 96, pending_consolidation: 37711`
 * at the same instant, for 2.5 h, with every watchdog signal green.
 *
 * This reads the set nothing else in this module reads — `status='failed'` —
 * and scores its CONSECUTIVENESS rather than its rate. Consecutiveness is what
 * separates "a flake" from "this will fail again the same way", and it covers
 * the whole class of deterministic non-retryable consolidation faults rather
 * than one error string.
 *
 * `no-data` when the block is missing, never a pass — the same rule the recall
 * signals live by.
 */
export function evaluateConsolidationFailureStreak(ring: Sample[]): Verdict {
  const signal = "consolidation-failure-streak" as const;
  if (ring.length === 0) return { signal, state: "no-data", detail: "no samples" };
  const banks = ring[ring.length - 1].banks ?? null;
  if (banks === null) {
    return {
      signal,
      state: "no-data",
      detail:
        "per-bank consolidation not probed this tick (no psql client, no pg descriptor, " +
        "or the container is down) — the `container` signal covers the last of those",
    };
  }
  // A streak whose newest failure is old is not evidence of an ONGOING fault:
  // a streak is defined relative to the last COMPLETED op, so a fixed-but-idle
  // bank would otherwise hold its historical streak — and alert on it — for
  // ever.
  const live = banks.streaks.filter((s) => s.newestFailureAgeS <= CONSOLIDATION_STREAK_RECENCY_S);
  let worst: BankFailureStreak | null = null;
  for (const s of live) if (worst === null || s.streak > worst.streak) worst = s;
  if (worst === null || worst.streak < CONSOLIDATION_FAILURE_STREAK_WARN) {
    const observed = worst?.streak ?? 0;
    return {
      signal,
      state: "ok",
      detail:
        `longest live consolidation-failure streak ${observed} across ` +
        `${banks.streaks.length} bank/op pair(s) — warn ≥${CONSOLIDATION_FAILURE_STREAK_WARN}, ` +
        `page ≥${CONSOLIDATION_FAILURE_STREAK_PAGE}`,
      measured: { streak: observed, pairs: banks.streaks.length },
    };
  }
  const { state, severity } = scoreHigherIsWorse(
    worst.streak,
    CONSOLIDATION_FAILURE_STREAK_WARN,
    CONSOLIDATION_FAILURE_STREAK_PAGE,
  );
  const breaching = live.filter((s) => s.streak >= CONSOLIDATION_FAILURE_STREAK_WARN);
  const others = breaching
    .filter((s) => s !== worst)
    .map((s) => `${s.bank}/${s.operationType}×${s.streak}`);
  return {
    signal,
    state,
    severity,
    detail:
      `bank "${worst.bank}": ${worst.streak} consecutive FAILED ${worst.operationType} ` +
      `operation(s) with no completion in between, newest ` +
      `${Math.round(worst.newestFailureAgeS / 60)}m ago — ` +
      `warn ≥${CONSOLIDATION_FAILURE_STREAK_WARN}, page ≥${CONSOLIDATION_FAILURE_STREAK_PAGE}. ` +
      "The pending/processing queue reads EMPTY while this holds, so " +
      "`consolidation-queue-age` cannot see it." +
      (others.length > 0 ? `\n  also breaching: ${others.join(", ")}` : ""),
    measured: {
      streak: worst.streak,
      bank: worst.bank,
      operationType: worst.operationType,
      newestFailureAgeS: worst.newestFailureAgeS,
      breachingPairs: breaching.length,
    },
  };
}

/**
 * R7 — per-bank unconsolidated depth RISING.
 *
 * The corroborating signal, and the one that catches the failure mode R6
 * cannot: a consolidator that never ENQUEUES anything produces no failed
 * operations at all, so there is no streak to count — but the memories still
 * pile up unconsolidated and recall against that bank degrades identically.
 *
 * Growth, not absolute depth, for the same reason `retain-queue-growth` is
 * growth: some banks legitimately run deep (`klanker` holds 202,549 units), so
 * an absolute line is either noise or useless. Deliberately the same
 * "deep AND rising" conjunction as `evaluateQueueGrowth`, applied per bank.
 *
 * The window ends are the oldest and newest samples that CARRY a bank block,
 * not the ends of the ring: a tick whose psql probe was unavailable must not
 * silently shorten the comparison to two samples minutes apart, which would
 * read almost any real growth as flat.
 */
export function evaluatePendingConsolidationDepth(ring: Sample[]): Verdict {
  const signal = "pending-consolidation-depth" as const;
  const withBanks = ring.filter((s) => (s.banks ?? null) !== null);
  if (withBanks.length < 2) {
    return {
      signal,
      state: "no-data",
      detail: `only ${withBanks.length} tick(s) carried a per-bank block — need two to see a trend`,
      measured: { samples: withBanks.length },
    };
  }
  const first = new Map(withBanks[0].banks!.pending.map((p) => [p.bank, p.pending]));
  const last = withBanks[withBanks.length - 1].banks!.pending;
  const mins = windowMinutes(withBanks);
  let worst: { bank: string; from: number; to: number; growth: number; need: number } | null = null;
  for (const p of last) {
    const from = first.get(p.bank);
    // A bank absent at the window start has no trend — a brand-new bank's
    // first thousand memories are ingest, not a stall.
    if (from === undefined) continue;
    const growth = p.pending - from;
    const need = Math.max(
      PENDING_CONSOLIDATION_GROWTH_WARN_ABS,
      Math.ceil(PENDING_CONSOLIDATION_GROWTH_FRACTION * from),
    );
    if (p.pending < PENDING_CONSOLIDATION_FLOOR || growth < need) continue;
    if (worst === null || growth > worst.growth) {
      worst = { bank: p.bank, from, to: p.pending, growth, need };
    }
  }
  if (worst === null) {
    return {
      signal,
      state: "ok",
      detail:
        `no bank's unconsolidated depth is both ≥${PENDING_CONSOLIDATION_FLOOR} and rising ` +
        `over ${mins}m (${last.length} bank(s))`,
      measured: { banks: last.length, windowMinutes: mins },
    };
  }
  const { state, severity } = scoreHigherIsWorse(
    worst.growth,
    PENDING_CONSOLIDATION_GROWTH_WARN_ABS,
    PENDING_CONSOLIDATION_GROWTH_PAGE_ABS,
  );
  const perHour = mins > 0 ? Math.round((worst.growth * 60) / mins) : worst.growth;
  return {
    signal,
    state,
    severity,
    detail:
      `bank "${worst.bank}": unconsolidated memories ${worst.from} → ${worst.to} ` +
      `(+${worst.growth}, ≈${perHour}/h) over ${mins}m — fires at ` +
      `≥${PENDING_CONSOLIDATION_FLOOR} deep AND +${worst.need} growth, pages at ` +
      `+${PENDING_CONSOLIDATION_GROWTH_PAGE_ABS}. Rising depth with no failed operations ` +
      `means consolidation is not being attempted at all.`,
    measured: {
      bank: worst.bank,
      pending: worst.to,
      growth: worst.growth,
      growthPerHour: perHour,
      growthNeeded: worst.need,
      windowMinutes: mins,
    },
  };
}

/**
 * R8 — an HNSW index raises on a nearest-neighbour probe.
 *
 * The root-cause canary under R6/R7: on 2026-07-29 every failed consolidation
 * carried `different vector dimensions 384 and 0`, raised out of an index
 * scan. `amcheck` has no HNSW support, so scanning one IS the verifier — there
 * is no cheaper check and no data-level check at all (the column is
 * `vector(384)` and the table held zero off-dimension rows throughout).
 *
 * Always `page`, and edge-triggered in `run.ts`. Index corruption does not
 * flap, does not resolve itself, and fails every write path that touches the
 * index — there is no "degraded" reading of it.
 */
export function evaluateVectorIndexCorruption(ring: Sample[]): Verdict {
  const signal = "vector-index-corruption" as const;
  if (ring.length === 0) return { signal, state: "no-data", detail: "no samples" };
  const v = ring[ring.length - 1].vectorIndex ?? null;
  if (v === null) {
    return {
      signal,
      state: "no-data",
      detail:
        "vector-index canary did not run this tick (no psql client, no pg descriptor, " +
        "or the container is down) — the `container` signal covers the last of those",
    };
  }
  if (v.corrupt.length === 0) {
    return {
      signal,
      state: "ok",
      detail: `${v.probed} HNSW index(es) answered a nearest-neighbour probe cleanly`,
      measured: { probed: v.probed, corrupt: 0 },
    };
  }
  const shown = v.corrupt.slice(0, 5).join("\n  ");
  const more = v.corrupt.length > 5 ? `\n  …and ${v.corrupt.length - 5} more` : "";
  return {
    signal,
    state: "breach",
    severity: "page",
    detail:
      `${v.corrupt.length} of ${v.probed + v.corrupt.length} HNSW index(es) RAISED on a ` +
      `nearest-neighbour probe — the index is corrupt, and every consolidation or recall ` +
      `that touches it fails:\n  ${shown}${more}\n` +
      `Fix: REINDEX the named index(es). amcheck cannot verify HNSW, so this probe is the ` +
      `only detector.`,
    measured: { probed: v.probed, corrupt: v.corrupt.length, first: v.corrupt[0] },
  };
}

/**
 * F1 — the LLM lane's fallback is not absorbing local failures.
 *
 * Stated positively on purpose. LiteLLM's fallback runs INSIDE the client
 * request, so hindsight records the model it asked for and a `success=false`
 * means the primary failed AND the OpenRouter hop did not save it. A fallback
 * that never fires can therefore no longer read as clean — see
 * `LLM_FAILURE_RATE_WARN` for the full derivation.
 */
export function evaluateLlmFallback(ring: Sample[]): Verdict {
  const signal = "llm-fallback-ineffective" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to compute a rate" };
  }
  let ok = 0;
  let fail = 0;
  for (let i = 1; i < ring.length; i++) {
    const pOk = ring[i - 1].llmOk;
    const nOk = ring[i].llmOk;
    const pFail = ring[i - 1].llmFail;
    const nFail = ring[i].llmFail;
    // A sample from a build that did not carry these counters contributes
    // nothing rather than a spurious delta against `undefined`.
    if (typeof pOk === "number" && typeof nOk === "number") ok += counterDelta(pOk, nOk);
    if (typeof pFail === "number" && typeof nFail === "number") fail += counterDelta(pFail, nFail);
  }
  const total = ok + fail;
  const mins = windowMinutes(ring);
  if (total < LLM_MIN_SAMPLES) {
    return {
      signal,
      state: "no-data",
      detail: `only ${total} hindsight LLM call(s) in the last ${mins}m — below the ${LLM_MIN_SAMPLES}-call floor`,
      measured: { total, windowMinutes: mins },
    };
  }
  const rate = fail / total;
  const { state, severity } = scoreHigherIsWorse(rate, LLM_FAILURE_RATE_WARN, LLM_FAILURE_RATE_PAGE);
  return {
    signal,
    state,
    severity,
    detail:
      `${pct(rate)} of hindsight LLM calls failed outright (${fail}/${total}) over ${mins}m ` +
      `— warn ${pct(LLM_FAILURE_RATE_WARN)}, page ${pct(LLM_FAILURE_RATE_PAGE)}. ` +
      `LiteLLM's fallback runs inside the request, so a failure here means the ` +
      `OpenRouter hop did not absorb a local failure.`,
    measured: { rate, fail, total, windowMinutes: mins },
  };
}

/** Evaluate every level/edge signal over the window. Order is display order. */
export function evaluateAll(ring: Sample[]): Verdict[] {
  return [
    evaluateContainer(ring),
    evaluateFailureRate(ring),
    evaluateQueueGrowth(ring),
    evaluateRetainLoss(ring),
    evaluateRecallOwnBankTimeout(ring),
    evaluateRecallCandidateFloor(ring),
    evaluateRecallInjectedScore(ring),
    evaluateRecallZeroMemory(ring),
    evaluateConsolidationQueueAge(ring),
    evaluateConsolidationFailureStreak(ring),
    evaluatePendingConsolidationDepth(ring),
    evaluateVectorIndexCorruption(ring),
    evaluateLlmFallback(ring),
  ];
}
