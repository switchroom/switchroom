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
  LLM_FAILURE_RATE_PAGE,
  LLM_FAILURE_RATE_WARN,
  LLM_MIN_SAMPLES,
  MIN_RETAIN_SAMPLES,
  QUEUE_FLOOR,
  QUEUE_GROWTH_FRACTION,
  QUEUE_GROWTH_MIN_ABS,
  RECALL_MIN_SAMPLES,
  RECALL_OWN_BANK_TIMEOUT_PAGE,
  RECALL_OWN_BANK_TIMEOUT_WARN,
  RECALL_P95_PAGE_MS,
  RECALL_P95_WARN_MS,
  RECALL_POOL_MEDIAN_PAGE,
  RECALL_POOL_MEDIAN_WARN,
  RECALL_SCORE_P50_PAGE,
  RECALL_SCORE_P50_WARN,
  RECALL_ZERO_MEMORY_PAGE,
  RECALL_ZERO_MEMORY_WARN,
  RETAIN_FAILURE_RATE,
} from "./thresholds.js";
import type { RecallSample, Sample, SignalId, Verdict } from "./types.js";

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
function windowRetainCounts(ring: Sample[]): { ok: number; fail: number } {
  let ok = 0;
  let fail = 0;
  for (let i = 1; i < ring.length; i++) {
    ok += counterDelta(ring[i - 1].retainOk, ring[i].retainOk);
    fail += counterDelta(ring[i - 1].retainFail, ring[i].retainFail);
  }
  return { ok, fail };
}

/** S1 — retain failure rate over the rolling window. The storm signal. */
export function evaluateFailureRate(ring: Sample[]): Verdict {
  const signal = "retain-failure-rate" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to compute a rate" };
  }
  const { ok, fail } = windowRetainCounts(ring);
  const total = ok + fail;
  const mins = windowMinutes(ring);
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
  return {
    signal,
    state: breach ? "breach" : "ok",
    detail:
      `pending retains ${first} → ${last} (${trend}) over ${mins}m ` +
      `— fires at ≥${QUEUE_FLOOR} deep AND +${need} growth`,
    measured: { pending: last, growth, windowMinutes: mins, growthNeeded: need },
  };
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
 *    `_evict_to_fit` removes outright.
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
  const totals = `totals: ${last.dead} dead, ${last.evicted} evicted, ${last.drops} dropped`;
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
      errorSuffix(r),
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

/**
 * R5 — recall p95 wall time.
 *
 * The early warning for R1: latency drifts through the 4-6 s band for days
 * before enough requests cross the 8 s per-bank wall to move the timeout rate.
 */
export function evaluateRecallLatency(ring: Sample[]): Verdict {
  const signal = "recall-latency" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);
  if (r.elapsedConsidered < RECALL_MIN_SAMPLES || r.elapsedP95Ms === null) {
    return {
      signal,
      state: "no-data",
      detail: `only ${r.elapsedConsidered} recall(s) reporting elapsed time — below the ${RECALL_MIN_SAMPLES}-row floor`,
      measured: { considered: r.elapsedConsidered },
    };
  }
  const { state, severity } = scoreHigherIsWorse(
    r.elapsedP95Ms,
    RECALL_P95_WARN_MS,
    RECALL_P95_PAGE_MS,
  );
  return {
    signal,
    state,
    severity,
    detail:
      `recall p95 ${r.elapsedP95Ms}ms over ${r.elapsedConsidered} fire(s) ` +
      `— warn ≥${RECALL_P95_WARN_MS}ms, page ≥${RECALL_P95_PAGE_MS}ms ` +
      `(the per-bank budget is 8000ms; a p95 at the budget means timing out, not slowness)`,
    measured: { p95Ms: r.elapsedP95Ms, considered: r.elapsedConsidered },
  };
}

/**
 * R6 — consolidation queue age.
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
      detail: "consolidation queue empty",
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
    evaluateRecallLatency(ring),
    evaluateConsolidationQueueAge(ring),
    evaluateLlmFallback(ring),
  ];
}
