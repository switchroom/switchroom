/**
 * The pure evaluator: a rolling window of probe samples in, one verdict per
 * signal out. No IO, no clock, no state mutation — every threshold decision
 * in the watchdog is decided here and is therefore unit-testable against
 * hand-built windows (see `evaluate.test.ts`, which replays the shape of the
 * 2026-07 retain-failure storm).
 */

import {
  addBuckets,
  bucketDelta,
  counterDelta,
  histogramQuantile,
  largestFiniteBucket,
} from "./metrics.js";
import {
  MIN_RETAIN_SAMPLES,
  QUEUE_FLOOR,
  QUEUE_GROWTH_FRACTION,
  QUEUE_GROWTH_MIN_ABS,
  RETAIN_FAILURE_RATE,
  RETAIN_P95_SECONDS,
} from "./thresholds.js";
import type { Sample, Verdict } from "./types.js";

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

function windowRetainBuckets(ring: Sample[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (let i = 1; i < ring.length; i++) {
    addBuckets(acc, bucketDelta(ring[i - 1].retainBuckets, ring[i].retainBuckets));
  }
  return acc;
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
 * S2b — a `.dead` marker appeared: a retain retried to exhaustion, i.e. a
 * permanently lost memory. Edge-triggered on the newest interval; any
 * increase is worth one DM regardless of scale.
 *
 * A DECREASE is a re-baseline, not a breach — the operator draining/removing
 * `.dead` files by hand must not read as a fault.
 */
export function evaluateDeadRetains(ring: Sample[]): Verdict {
  const signal = "retain-dead" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to see new .dead markers" };
  }
  const prev = ring[ring.length - 2].dead;
  const last = ring[ring.length - 1].dead;
  const added = last - prev;
  if (added > 0) {
    return {
      signal,
      state: "breach",
      detail: `${added} new .dead retain marker(s) since the last check (total ${last}) — memories permanently lost`,
      measured: { added, total: last },
    };
  }
  return {
    signal,
    state: "ok",
    detail: `no new .dead retain markers (total ${last})`,
    measured: { added: 0, total: last },
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

/** S4 — retain p95 trending toward the client retain timeout. */
export function evaluateLatencyP95(ring: Sample[]): Verdict {
  const signal = "retain-latency-p95" as const;
  if (ring.length < 2) {
    return { signal, state: "no-data", detail: "only one sample so far — need two to diff the histogram" };
  }
  const buckets = windowRetainBuckets(ring);
  const q = histogramQuantile(buckets, 0.95);
  const mins = windowMinutes(ring);
  if (q.count < MIN_RETAIN_SAMPLES) {
    return {
      signal,
      state: "no-data",
      detail: `only ${q.count} retain(s) in the last ${mins}m — below the ${MIN_RETAIN_SAMPLES}-sample floor`,
      measured: { count: q.count, windowMinutes: mins },
    };
  }
  const cap = largestFiniteBucket(buckets);
  const shown = q.saturated ? `>${cap}s` : `${q.seconds.toFixed(1)}s`;
  return {
    signal,
    state: q.seconds >= RETAIN_P95_SECONDS ? "breach" : "ok",
    detail:
      `retain p95 ${shown} over ${mins}m (n=${q.count}) ` +
      `— threshold ${RETAIN_P95_SECONDS}s`,
    measured: {
      p95Seconds: q.saturated ? `>${cap}` : Number(q.seconds.toFixed(2)),
      count: q.count,
      windowMinutes: mins,
    },
  };
}

/** Evaluate every level/edge signal over the window. Order is display order. */
export function evaluateAll(ring: Sample[]): Verdict[] {
  return [
    evaluateContainer(ring),
    evaluateFailureRate(ring),
    evaluateQueueGrowth(ring),
    evaluateDeadRetains(ring),
    evaluateLatencyP95(ring),
  ];
}
