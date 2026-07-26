/**
 * The pure evaluator: a rolling window of probe samples in, one verdict per
 * signal out. No IO, no clock, no state mutation — every threshold decision
 * in the watchdog is decided here and is therefore unit-testable against
 * hand-built windows (see `evaluate.test.ts`, which replays the shape of the
 * 2026-07 retain-failure storm).
 */

import { counterDelta } from "./metrics.js";
import {
  MIN_RETAIN_SAMPLES,
  QUEUE_FLOOR,
  QUEUE_GROWTH_FRACTION,
  QUEUE_GROWTH_MIN_ABS,
  RETAIN_FAILURE_RATE,
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

/** Evaluate every level/edge signal over the window. Order is display order. */
export function evaluateAll(ring: Sample[]): Verdict[] {
  return [
    evaluateContainer(ring),
    evaluateFailureRate(ring),
    evaluateQueueGrowth(ring),
    evaluateRetainLoss(ring),
  ];
}
