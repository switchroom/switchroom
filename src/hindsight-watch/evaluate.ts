/**
 * The pure evaluator: a rolling window of probe samples in, one verdict per
 * signal out. No IO, no clock, no state mutation — every threshold decision
 * in the watchdog is decided here and is therefore unit-testable against
 * hand-built windows (see `evaluate.test.ts`, which replays the shape of the
 * 2026-07 retain-failure storm).
 */

import { baselineFor, fractionalDrop } from "./baseline.js";
import { counterDelta } from "./metrics.js";
import {
  CONSOLIDATION_AGE_PAGE_S,
  CONSOLIDATION_AGE_WARN_S,
  CONSOLIDATION_FAILURE_STREAK_PAGE,
  CONSOLIDATION_FAILURE_STREAK_WARN,
  CONSOLIDATION_STREAK_NO_SUCCESS_S,
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
  RECALL_BASELINE_DAYS,
  RECALL_BASELINE_MIN_DAYS,
  RECALL_DEADLINE_HIT_PAGE,
  RECALL_DEADLINE_HIT_WARN,
  RECALL_MIN_SAMPLES,
  RECALL_OWN_BANK_TIMEOUT_PAGE,
  RECALL_OWN_BANK_TIMEOUT_WARN,
  RECALL_P95_PAGE_MS,
  RECALL_P95_WARN_MS,
  RECALL_POOL_MEDIAN_PAGE,
  RECALL_POOL_MEDIAN_WARN,
  RECALL_QUALITY_DROP_PAGE,
  RECALL_QUALITY_DROP_WARN,
  RECALL_SCORE_P50_PAGE,
  RECALL_SCORE_P50_WARN,
  RECALL_WALL_MS,
  RECALL_ZERO_MEMORY_PAGE,
  RECALL_ZERO_MEMORY_WARN,
  RETAIN_FAILURE_RATE,
} from "./thresholds.js";
import type {
  BankFailureStreak,
  RecallBaseline,
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
 * Still presentational HERE, exactly like `errorSuffix` — this suffix moves no
 * verdict. Latency now also carries its own threshold in
 * `evaluateRecallLatency` below, but on R1 the number answers a different
 * question: whether "own-bank recall failed" means *timed out at the wall* or
 * *errored immediately*. That is the first thing the operator asks and the
 * cheapest one to pre-answer, so it stays inline on R1 rather than making the
 * reader correlate two DMs.
 */
function latencySuffix(r: { elapsedP95Ms?: number | null; elapsedConsidered?: number }): string {
  const p95 = r.elapsedP95Ms;
  if (typeof p95 !== "number" || !Number.isFinite(p95)) return "";
  const n = typeof r.elapsedConsidered === "number" ? r.elapsedConsidered : 0;
  return `\n  recall wall time p95 ${Math.round(p95)}ms over ${n} fire(s) (against the ${RECALL_WALL_MS}ms recall deadline)`;
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

/**
 * R4a — recall wall-time p95.
 *
 * This signal was drafted and deleted twice, both times correctly: the only
 * healthy population then available was itself running at the wall, so no line
 * below the wall could separate healthy from sick. It is restored here because
 * the precondition the deletion named has been met — see `RECALL_P95_WARN_MS`
 * in `thresholds.ts` for the re-baseline against the repaired fleet.
 *
 * Distinct from R4c below: this one says recall is SLOW. R4c says recall is
 * being CUT OFF. Both can be true, and when both fire the pinning one is the
 * actionable half.
 */
export function evaluateRecallLatency(ring: Sample[]): Verdict {
  const signal = "recall-latency" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);
  if (r.elapsedConsidered < RECALL_MIN_SAMPLES || r.elapsedP95Ms === null) {
    return {
      signal,
      state: "no-data",
      detail:
        `only ${r.elapsedConsidered} recall(s) carrying a wall time ` +
        `— below the ${RECALL_MIN_SAMPLES}-row floor`,
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
      `recall wall time p95 ${Math.round(r.elapsedP95Ms)}ms over ${r.elapsedConsidered} recall(s) ` +
      `— warn ≥${RECALL_P95_WARN_MS}ms, page ≥${RECALL_P95_PAGE_MS}ms ` +
      `(deadline ${RECALL_WALL_MS}ms). ` +
      `Slow recall delays every turn it fires on, and approaches the deadline ` +
      `past which memory is silently truncated.`,
    measured: { elapsedP95Ms: r.elapsedP95Ms, considered: r.elapsedConsidered },
  };
}

/**
 * R4b — recall quality against its OWN trailing baseline.
 *
 * The only non-absolute signal in the file, and the one built for the
 * 2026-08-01 → 08-07 degradation that all fourteen floors slept through: top-hit
 * score fell ~5× while staying 9× above its absolute warn line.
 *
 * Two arms, OR'd, each gated on its own absolute-warn constant. The gate is
 * what keeps this from double-reporting a collapse: once the BASELINE itself is
 * at or below the floor, the fleet is not regressing, it is broken, and R3/R4
 * own that. Below the gate this arm reports `no-data` — inert, per the
 * `no-data` contract, so it neither fires nor resolves a live alert.
 */
export function evaluateRecallQualityRegression(
  ring: Sample[],
  baseline: RecallBaseline | undefined,
  now: number,
): Verdict {
  const signal = "recall-quality-regression" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);

  const base = baselineFor(baseline, now);

  // Each arm carries its own denominator and its own gate, evaluated
  // independently: a tick that can score the pool but not the score reports on
  // the pool rather than reporting nothing.
  const arms: {
    label: string;
    observed: number | null;
    considered: number;
    series: { value: number | null; days: number };
    gate: number;
    format: (x: number) => string;
  }[] = [
    {
      label: "p50 injected top-hit score",
      observed: r.scoreConsidered >= RECALL_MIN_SAMPLES ? r.scoreP50 : null,
      considered: r.scoreConsidered,
      series: base.score,
      gate: RECALL_SCORE_P50_WARN,
      format: (x) => x.toFixed(4),
    },
    {
      label: "median candidate pool",
      observed: r.poolConsidered >= RECALL_MIN_SAMPLES ? r.poolMedian : null,
      considered: r.poolConsidered,
      series: base.pool,
      gate: RECALL_POOL_MEDIAN_WARN,
      format: (x) => `${Math.round(x)}`,
    },
  ];

  const scored = arms
    .map((arm) => {
      if (arm.series.value === null || arm.series.value <= arm.gate) return null;
      const drop = fractionalDrop(arm.observed, arm.series.value);
      if (drop === null) return null;
      return { ...arm, baseline: arm.series.value, drop };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  if (scored.length === 0) {
    return {
      signal,
      state: "no-data",
      detail:
        `no comparable trailing baseline yet ` +
        `(score: ${base.score.days} day(s), pool: ${base.pool.days} day(s); ` +
        `needs ${RECALL_BASELINE_MIN_DAYS} completed day(s) above the absolute floors)`,
      measured: { scoreDays: base.score.days, poolDays: base.pool.days },
    };
  }

  // Report the WORST arm. Both are shown in the detail line so the operator
  // can see whether one moved or both did — during the 08-01 incident the pool
  // GREW while the score collapsed, and that divergence is itself the clue.
  const worst = scored.reduce((a, b) => (b.drop > a.drop ? b : a));
  const { state, severity } = scoreHigherIsWorse(
    worst.drop,
    RECALL_QUALITY_DROP_WARN,
    RECALL_QUALITY_DROP_PAGE,
  );
  const lines = scored
    .map(
      (a) =>
        `\n  ${a.label} ${a.format(a.observed as number)} vs ${a.format(a.baseline)} baseline ` +
        `over ${a.series.days} day(s) — ${pct(a.drop)} below`,
    )
    .join("");
  return {
    signal,
    state,
    severity,
    detail:
      `recall quality is ${pct(worst.drop)} below its own trailing ` +
      `${RECALL_BASELINE_DAYS}-day baseline (worst arm: ${worst.label}) ` +
      `— warn ≥${pct(RECALL_QUALITY_DROP_WARN)}, page ≥${pct(RECALL_QUALITY_DROP_PAGE)}.` +
      // Only claim the floors are blind when they actually are. On an `ok`
      // verdict this line still shows up in `--dry-run` output, and a status
      // listing that asserts a problem it just decided there isn't teaches the
      // operator to skim it.
      (state === "breach"
        ? ` Absolute floors cannot see this: the readings are still well above them.`
        : "") +
      lines,
    measured: { drop: worst.drop, baseline: worst.baseline, considered: worst.considered },
  };
}

/**
 * R4c — recall pinned against its deadline.
 *
 * A p95 sitting on the wall is not the same failure as a p95 that is merely
 * high: it means an unknown share of recalls never finished, and the agent was
 * handed whatever had arrived when the deadline cut them off. Truncated memory
 * looks exactly like sparse memory from inside the turn, which is why this is
 * worth its own signal rather than a higher latency page.
 *
 * Scored on the rate at which rows REPORT being cut off, not on
 * `p95 / deadline_effective_ms`. That fraction compared two independent config
 * knobs (`parallel_deadline_seconds` against the per-request
 * `request_timeout_seconds`) and was blind to the 07-20 → 07-26 week, where
 * 84-95 % of recalls hit the deadline and it scored 0.81; see
 * {@link RECALL_DEADLINE_HIT_WARN} for the replay. The rate reads no deadline
 * value at all, so retuning either knob cannot move the verdict.
 *
 * Rows carrying no boolean `deadline_hit` are excluded rather than counted as
 * completions, and a window holding fewer than {@link RECALL_MIN_SAMPLES} of
 * them is `no-data`, not `ok`.
 */
export function evaluateRecallDeadlinePinning(ring: Sample[]): Verdict {
  const signal = "recall-deadline-pinning" as const;
  const r = latestRecall(ring);
  if (r === null) return noRecallData(signal);

  // Validated HERE rather than in `normalizeRecallSample`, which tolerates
  // both fields as optional so a sample persisted by an older build stays
  // usable. Tolerance must not become trust: a garbled `deadlineHitConsidered`
  // would sail past a bare sample floor (`"x" < 30` is false), make `rate`
  // NaN, and every `NaN >= threshold` is false — the fail-OPEN trap this file
  // guards against everywhere else. Rejected to `no-data`, never zero-filled.
  const considered = r.deadlineHitConsidered;
  const hits = r.deadlineHitRows;
  const usable =
    typeof considered === "number" &&
    typeof hits === "number" &&
    Number.isInteger(considered) &&
    Number.isInteger(hits) &&
    hits >= 0 &&
    hits <= considered &&
    considered >= RECALL_MIN_SAMPLES;
  if (!usable) {
    const shown = typeof considered === "number" && Number.isFinite(considered) ? considered : 0;
    return {
      signal,
      state: "no-data",
      detail:
        `cannot measure truncation this tick ` +
        `(${shown} row(s) carry a usable deadline_hit flag, need ${RECALL_MIN_SAMPLES} ` +
        `— samples persisted by builds before this signal carry none at all)`,
      measured: { deadlineHitConsidered: shown },
    };
  }

  const rate = hits / considered;
  const state = rate >= RECALL_DEADLINE_HIT_WARN ? "breach" : "ok";
  const severity = rate >= RECALL_DEADLINE_HIT_PAGE ? "page" : "warn";
  // Reported, never thresholded: these two say WHERE the cut-off lands, which
  // is the difference between "raise the deadline" and "the per-request
  // timeout is sitting below the deadline". A garbled value cannot move the
  // verdict, only the prose.
  const deadline = r.deadlineEffectiveMedianMs ?? null;
  const wall =
    deadline !== null && deadline > 0 && r.elapsedP95Ms !== null
      ? ` p95 was ${Math.round(r.elapsedP95Ms)}ms against a ${Math.round(deadline)}ms effective deadline.`
      : "";
  return {
    signal,
    state,
    severity: state === "breach" ? severity : undefined,
    detail:
      `${hits}/${considered} recall(s) (${pct(rate)}) were CUT OFF at the deadline ` +
      `— threshold ${pct(RECALL_DEADLINE_HIT_WARN)} warn / ${pct(RECALL_DEADLINE_HIT_PAGE)} page.` +
      wall +
      (state === "breach"
        ? ` Those turns were handed truncated memory, which looks identical to ` +
          `sparse memory from inside the turn.`
        : ""),
    measured: {
      rate,
      deadlineHits: hits,
      deadlineHitConsidered: considered,
      ...(r.elapsedP95Ms !== null ? { elapsedP95Ms: r.elapsedP95Ms } : {}),
      ...(deadline !== null ? { deadlineMs: deadline } : {}),
    },
  };
}

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
 * Is this streak evidence of an ONGOING fault, or a historical one?
 *
 * A streak is defined relative to the pair's last COMPLETED op, so without
 * some liveness test a bank that was fixed but has had no demand since keeps
 * its historical streak — and alerts on it — for ever. Two arms, because one
 * question does not cover both cadences:
 *
 *  - **Recent failure** (the original arm, unchanged). A DENSE operation type
 *    that is still broken keeps producing failures: `consolidation` failed
 *    every 87 s through the 2026-07-29 incident, so "newest failure inside
 *    `CONSOLIDATION_STREAK_RECENCY_S`" tracks it exactly.
 *
 *  - **No success in a long time** (the arm added in #4618). A SPARSE,
 *    demand-driven type produces no new failures while it is broken, because
 *    it only runs when work is enqueued — so arm one structurally cannot hold
 *    its streak. Measured live 2026-08-12: `overlord/graph_maintenance` held a
 *    streak of 19 whose newest failure was 37 h old and `klanker/graph_maintenance`
 *    a streak of 9 at 91 h; both failed the 2 h window, the candidate list
 *    emptied, and the signal reported `{"status":"ok","breaches":0}` while the
 *    job was 100 % broken. Both pairs had gone 220 h with no successful op.
 *
 * The second arm asks the honest question — "has anything SUCCEEDED lately?"
 * — instead of the proxy, and is conjoined with
 * `CONSOLIDATION_FAILURE_STREAK_WARN` so it is only ever asked about a pair
 * that has already failed ≥3 times in a row. It resolves the moment a
 * completion lands, which is the property the recency guard existed to
 * protect.
 *
 * **The second arm is NOT scoped to sparse types** — nothing here can tell
 * them apart, and inventing a classifier would be a second thing to get
 * wrong. A `consolidation` pair with ≥3 failures and no completion for
 * `CONSOLIDATION_STREAK_NO_SUCCESS_S` therefore breaches where it previously
 * read `ok`. That is intended: it is the same fault shape, just slower.
 *
 * Two non-obvious readings of the field, both load-bearing:
 *
 *  - `undefined` means the row predates the field (an old persisted state
 *    file), NOT that the pair never completed. The sparse arm abstains rather
 *    than guess, leaving the row on the pre-existing behaviour until the next
 *    probe fills the field in.
 *  - `null` means "no `completed` row for this pair IS VISIBLE", which is NOT
 *    the same as "never completed". `docker/hindsight-maintenance.sh:136`
 *    deletes `status='completed'` rows older than
 *    `SWITCHROOM_HINDSIGHT_RETENTION_DAYS` (default 30, unset in the fleet) —
 *    and, per that script's own header at line 23, **never touches
 *    failed/pending/processing rows**. So the two halves of a streak age
 *    differently: successes are swept, the failures that define the streak are
 *    immortal. `null` can therefore mean "the successes were deleted while the
 *    failures were kept", and the streak query's `coalesce(…, '-infinity')`
 *    then counts failures that predate a completion which no longer exists.
 *
 *    The null arm carries the same age evidence the numeric arm does rather
 *    than firing on absence alone, which covers the honest cases — a new pair,
 *    or a pair still actively retrying. It does NOT cover the asymmetry: those
 *    retained failures are ancient by construction, so an age guard cannot
 *    discriminate them. The residual is a bank that still exists and has been
 *    idle on one op type past the retention window; a deleted bank takes its
 *    rows with it via the cascade-delete migration. It is latent — no such pair
 *    exists on the production bank — and closing it belongs in the streak
 *    query, by bounding the failure scan to the retention horizon, not here.
 */
function lastSuccessPhrase(lastCompletedAgeS: number | null | undefined): string {
  if (lastCompletedAgeS === undefined) return "unknown (state predates the field)";
  if (lastCompletedAgeS === null) return "NEVER";
  return `${(lastCompletedAgeS / 3600).toFixed(1)}h ago`;
}

function isLiveStreak(s: BankFailureStreak): boolean {
  if (s.newestFailureAgeS <= CONSOLIDATION_STREAK_RECENCY_S) return true;
  if (s.streak < CONSOLIDATION_FAILURE_STREAK_WARN) return false;
  // `undefined` (a row persisted before the field existed) satisfies NEITHER
  // disjunct and so abstains — which is only true while the null check stays
  // STRICT. Loosening it to `== null`, or restructuring this as a negated
  // "recent enough" test, silently promotes unknown to "never completed" and
  // pages on hydration alone.
  const last = s.lastCompletedAgeS;
  // No visible completion: fall back to the only clock left, the streak's own
  // age. Firing on absence alone would page a pair whose successes were swept
  // by the 30-day retention delete, or one still actively retrying, rather
  // than on evidence. (See the doc block for the case this does NOT cover.)
  if (last === null) return s.newestFailureAgeS > CONSOLIDATION_STREAK_NO_SUCCESS_S;
  return typeof last === "number" && last > CONSOLIDATION_STREAK_NO_SUCCESS_S;
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
 *
 * Liveness is decided by `isLiveStreak` below, on TWO arms — one for dense
 * operation types and one for sparse ones. See its doc block.
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
  const live = banks.streaks.filter(isLiveStreak);
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
      `${Math.round(worst.newestFailureAgeS / 60)}m ago, last SUCCESS ` +
      `${lastSuccessPhrase(worst.lastCompletedAgeS)} — ` +
      `warn ≥${CONSOLIDATION_FAILURE_STREAK_WARN}, page ≥${CONSOLIDATION_FAILURE_STREAK_PAGE}. ` +
      "The pending/processing queue reads EMPTY while this holds, so " +
      "`consolidation-queue-age` cannot see it." +
      (others.length > 0 ? `\n  also breaching: ${others.join(", ")}` : ""),
    measured: {
      streak: worst.streak,
      bank: worst.bank,
      operationType: worst.operationType,
      newestFailureAgeS: worst.newestFailureAgeS,
      // `"never"` = the pair has never completed an op; the key is absent
      // altogether when the row predates the field, so a reader can tell
      // "no success ever" from "we did not read it".
      ...(worst.lastCompletedAgeS !== undefined
        ? { lastCompletedAgeS: worst.lastCompletedAgeS ?? "never" }
        : {}),
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

/**
 * Evaluate every level/edge signal over the window. Order is display order.
 *
 * `baseline` and `now` are OPTIONAL so that every existing call site — tests,
 * and any caller that only wants the fourteen window-local signals — keeps
 * compiling and keeps meaning what it meant. Omitting them does not make
 * `recall-quality-regression` pass: with no baseline it reports `no-data`,
 * which is inert. `now` defaults to the clock only when the caller declines to
 * supply one; `run.ts` passes the tick's own timestamp so the evaluator stays
 * a pure function of its arguments there.
 */
export function evaluateAll(
  ring: Sample[],
  baseline?: RecallBaseline,
  now: number = Date.now(),
): Verdict[] {
  return [
    evaluateContainer(ring),
    evaluateFailureRate(ring),
    evaluateQueueGrowth(ring),
    evaluateRetainLoss(ring),
    evaluateRecallOwnBankTimeout(ring),
    evaluateRecallCandidateFloor(ring),
    evaluateRecallInjectedScore(ring),
    evaluateRecallLatency(ring),
    evaluateRecallQualityRegression(ring, baseline, now),
    evaluateRecallDeadlinePinning(ring),
    evaluateRecallZeroMemory(ring),
    evaluateConsolidationQueueAge(ring),
    evaluateConsolidationFailureStreak(ring),
    evaluatePendingConsolidationDepth(ring),
    evaluateVectorIndexCorruption(ring),
    evaluateLlmFallback(ring),
  ];
}
