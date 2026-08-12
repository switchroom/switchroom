/**
 * Recall telemetry: reading `recall_log.jsonl` and reducing it to the SLIs
 * the watchdog alerts on.
 *
 * ## Why this exists
 *
 * The fleet's auto-recall ran ~86 % broken for six weeks and **no alert
 * fired**, because every armed watchdog watched *retain* and *liveness*, and
 * every layer of the recall path fails open:
 *
 *  - `recall.py` exits 0 on a bank timeout (blocking the user's prompt would
 *    be worse), so the hook looks successful.
 *  - Claude Code swallows hook stderr on a zero exit, so the `[Hindsight]`
 *    warning reaches nobody.
 *  - The agent is handed an empty context and cannot distinguish "no relevant
 *    memories" from "the fact layer was unreachable".
 *  - `probeHindsight` is one MCP `initialize` — a recall path that answers
 *    fast and empty passes it.
 *  - The hindsight healthcheck is `GET /health` + a TCP connect. Same.
 *
 * So the ONLY durable evidence is the telemetry the hook writes itself. This
 * module turns that file into signals. `src/cli/doctor-recall-health.ts` is
 * the pull-only sibling (an operator has to run `doctor`); this is the push
 * side, on a cron, that DMs a human.
 *
 * ## The two signals that matter most
 *
 * `doctor-recall-health.ts` deliberately does NOT score `result_count`
 * (its header says so), because an empty match is legitimately common. That
 * leaves one failure shape completely invisible: a recall that is **fast,
 * successful, and near-empty** — the reranker returns, nothing times out, and
 * the agent still gets nothing worth having. `candidate-pool-floor` and
 * `injected-score` are the two signals that see it, and they are the reason
 * this module is not just "the doctor check on a timer".
 *
 * ## Fail-closed reduction
 *
 * Every SLI carries its OWN denominator. A row that does not carry a field is
 * excluded from that SLI rather than counted as healthy — the fail-open
 * default ("field missing ⇒ 0 ⇒ fine") is precisely the bug class this
 * module exists to catch. An SLI whose denominator is under its sample floor
 * reports `no-data`, which neither fires nor resolves.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One `recall_log.jsonl` row, narrowed to the fields the SLIs classify on.
 *
 * Every field here was verified present in the live logs on 2026-07-27 and in
 * the emitting `_write_recall_log` call
 * (`vendor/hindsight-memory/scripts/recall.py`). Optionality is real, not
 * defensive: rows predating a field genuinely exist in the append-only log
 * (e.g. `injected_score_max` arrived with #3541), and topic-filtered rows
 * carry no `bank_timings` at all.
 */
export interface RecallLogRow {
  ts?: string;
  bank_id?: string;
  result_count?: number;
  total_elapsed_ms?: number;
  deadline_hit?: boolean;
  /**
   * The wait the parallel fan-out was ACTUALLY granted, in ms: the configured
   * `recallParallelDeadlineSeconds` budget minus whatever the pre-fan-out work
   * (mission-ensure, transcript read) already spent
   * (`recall.py:2184-2194`). Read rather than assumed because it is the only
   * per-row statement of the wall `total_elapsed_ms` is being measured
   * against — the CONFIGURED budget rides along as `deadline_budget_ms`, and
   * the two differ by 5-15 ms on this fleet.
   *
   * Absent on rows written before the field shipped and on the
   * `recallParallel: false` path, which logs both deadline fields as `null`.
   */
  deadline_effective_ms?: number | null;
  /** post-overlap-gate, pre-cap candidate count */
  pre_cap_count?: number;
  /** candidates the overlap gate removed */
  overlap_dropped?: number;
  /** max `scores.final` over the INJECTED set; null when nothing was injected */
  injected_score_max?: number | null;
  cache_hit?: boolean;
  /**
   * Why the recall degraded, as a human-readable string. Added by this change
   * — before it, the log carried booleans only (`deadline_hit`, per-bank
   * `timed_out` / `errored`), so "what actually failed" was unanswerable from
   * the log. Absent on healthy rows and on every row written before the field
   * shipped.
   */
  error?: string | null;
  bank_timings?: Array<{
    bank_id?: string;
    elapsed_ms?: number;
    timed_out?: boolean;
    errored?: boolean;
  }>;
}

/**
 * Trailing rows read per agent per tick.
 *
 * Matches `RECALL_HEALTH_WINDOW_ROWS` in `doctor-recall-health.ts` so the
 * push and pull views of the same file cannot disagree about what "recent"
 * means — an operator who runs `doctor` after getting a DM must see the same
 * numbers.
 */
export const RECALL_WINDOW_ROWS = 200;

/**
 * Byte cap on the tail read, per agent.
 *
 * `recall_log.jsonl` is append-only and never rotated — 1.2-2.5 MB per agent
 * on 2026-07-27 and growing monotonically. Slurping every log whole, every
 * 15 minutes, would make the watchdog a load source on the host it watches.
 * Rows are ~700-900 B worst case, so 1 MiB holds well over 1000.
 */
export const RECALL_MAX_TAIL_BYTES = 1024 * 1024;

/**
 * Rows older than this are dropped from the window.
 *
 * Without it a fleet whose recall stopped firing entirely would keep paging
 * off a frozen log forever — the loudest possible false positive, and one
 * that trains an operator to ignore the alert. An agent whose recent rows all
 * age out contributes NOTHING (not a healthy zero), so it degrades to
 * `no-data` rather than to a pass. Set to 24 h so a low-traffic agent still
 * has a scoreable window while a genuinely stopped hook falls out within a
 * day.
 */
export const RECALL_MAX_ROW_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Path of an agent's recall telemetry inside its host-side scaffold.
 *
 * The hook runs in the agent container, but `$HOME/.claude` is bind-mounted
 * from `~/.switchroom/agents/<name>/`, so the host reads it without a
 * `docker exec` — which matters because the check must still work when the
 * container is down. A crash-looping agent is exactly when you want to know
 * whether its recall was already failing.
 */
export function recallLogPath(agentDir: string): string {
  return join(
    agentDir,
    ".claude",
    "plugins",
    "data",
    "hindsight-memory-inline",
    "state",
    "recall_log.jsonl",
  );
}

/**
 * Read the trailing window of one agent's recall log.
 *
 * Best-effort by construction: an absent, unreadable, or partly-corrupt log
 * yields the rows we could parse rather than throwing, because broken
 * telemetry for ONE agent must not blind the watchdog for the other eleven.
 * The resulting shortfall is visible as a smaller denominator, and the sample
 * floors turn a small enough denominator into `no-data`.
 */
export function readRecallLogTail(
  path: string,
  windowRows: number = RECALL_WINDOW_ROWS,
): RecallLogRow[] {
  if (!existsSync(path)) return [];
  let text: string;
  let truncatedHead = false;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - RECALL_MAX_TAIL_BYTES);
    truncatedHead = start > 0;
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = openSync(path, "r");
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    text = buf.subarray(0, read).toString("utf8");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  // A byte-offset read almost certainly starts mid-row; drop that partial
  // first line rather than letting it become a silent parse failure.
  if (truncatedHead) lines.shift();
  const rows: RecallLogRow[] = [];
  for (const line of lines.slice(-windowRows)) {
    try {
      const parsed = JSON.parse(line) as RecallLogRow;
      if (parsed && typeof parsed === "object") rows.push(parsed);
    } catch {
      // A torn final line is normal for an append-only log being written
      // concurrently; skip it rather than failing the whole read.
    }
  }
  return rows;
}

/** Parse a row's `ts` (`%Y-%m-%dT%H:%M:%SZ`) to epoch ms, or null. */
export function rowTimeMs(row: RecallLogRow): number | null {
  if (typeof row.ts !== "string" || row.ts === "") return null;
  const t = Date.parse(row.ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * Drop rows outside the age window.
 *
 * A row with an unparseable/absent `ts` is KEPT: `ts` has been emitted since
 * the log's first version, so an unparseable one means a torn write rather
 * than an old row, and dropping it would quietly shrink the denominator of
 * every SLI. Rows dated in the future (clock skew) are dropped, matching
 * `pushSample`'s rule for the sample ring.
 */
export function withinWindow(
  rows: RecallLogRow[],
  now: number,
  maxAgeMs: number = RECALL_MAX_ROW_AGE_MS,
): RecallLogRow[] {
  const floor = now - maxAgeMs;
  return rows.filter((r) => {
    const t = rowTimeMs(r);
    if (t === null) return true;
    return t >= floor && t <= now;
  });
}

/**
 * The recall slice of one tick, as the evaluators consume it.
 *
 * Each SLI carries its own numerator AND denominator. That separation is
 * load-bearing: `zeroConsidered` is much larger than `timeoutConsidered` on
 * this fleet (topic-filtered rows carry `result_count` but no `bank_timings`),
 * and collapsing them onto one denominator would silently dilute whichever
 * rate is computed second.
 */
export interface RecallStats {
  /** rows read across all agents, before any field filtering */
  rows: number;
  /** agents that contributed at least one in-window row */
  agents: number;

  /** rows carrying `bank_timings` — the own-bank-timeout denominator */
  timeoutConsidered: number;
  /** of those, rows whose OWN bank timed out or hard-errored */
  ownBankDegraded: number;

  /** rows carrying `result_count` — the zero-memory denominator */
  zeroConsidered: number;
  /** of those, rows that injected nothing */
  zeroResult: number;

  /** rows carrying `pre_cap_count` — the candidate-pool denominator */
  poolConsidered: number;
  /** median of `pre_cap_count + overlap_dropped`, or null under the floor */
  poolMedian: number | null;

  /** rows carrying a numeric `injected_score_max` */
  scoreConsidered: number;
  /** median (p50) of `injected_score_max`, or null */
  scoreP50: number | null;

  /** rows carrying `total_elapsed_ms` */
  elapsedConsidered: number;
  /** p95 of `total_elapsed_ms` in ms, or null */
  elapsedP95Ms: number | null;

  /** rows carrying a numeric `deadline_effective_ms` */
  deadlineConsidered: number;
  /**
   * Median of `deadline_effective_ms` over the window, or null.
   *
   * The median rather than the max: the value drifts by a few ms per row (it
   * is the budget minus that row's pre-fan-out spend), and `recall-deadline-
   * pinning` divides by it, so the central value is what the ratio should be
   * read against. Never substituted with a constant — a fleet running an
   * operator-overridden `recallParallelDeadlineSeconds` must be scored against
   * ITS wall, not the stock one.
   */
  deadlineEffectiveMedianMs: number | null;
  /**
   * Rows whose `deadline_hit` was true — any bank (or the directives slot)
   * missed the shared fan-out deadline.
   *
   * Diagnostic ONLY, like `topError`: it goes into the DM so the operator can
   * see how much of the window was actually cut off, but no threshold reads
   * it, so a missing or garbled value can never move a verdict.
   */
  deadlineHitRows: number;

  /** rows carrying a non-empty `error` string */
  errorRows: number;
  /**
   * The most frequent `error` string in the window, or null.
   *
   * Diagnostic ONLY — no threshold reads it, so a missing or garbled value can
   * never change a verdict. Its job is to put the reason INTO the DM: an alert
   * saying "own-bank degraded 86%" sends an operator to the logs, whereas one
   * saying "…— ReadTimeout: HTTPConnectionPool… read timed out" names the fix.
   * Null on every window whose rows predate the `error` field.
   */
  topError: string | null;
}

/** Nearest-rank quantile over a pre-sorted ascending array. */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

function median(sorted: number[]): number | null {
  return quantile(sorted, 0.5);
}

export const emptyRecallStats = (): RecallStats => ({
  rows: 0,
  agents: 0,
  timeoutConsidered: 0,
  ownBankDegraded: 0,
  zeroConsidered: 0,
  zeroResult: 0,
  poolConsidered: 0,
  poolMedian: null,
  scoreConsidered: 0,
  scoreP50: null,
  elapsedConsidered: 0,
  elapsedP95Ms: null,
  deadlineConsidered: 0,
  deadlineEffectiveMedianMs: null,
  deadlineHitRows: 0,
  errorRows: 0,
  topError: null,
});

/**
 * Pure: reduce raw rows to the SLI stats. No IO, no clock — so every
 * threshold decision is testable against a hand-built or captured log.
 *
 * Cache hits are excluded wholesale. A cache hit writes a row with
 * `result_count: null` and no timings (`recall.py`'s early-return write), so
 * counting it would inflate the *denominators* of every SLI with rows that
 * carry no measurement — quietly deflating each rate exactly when the cache
 * is doing its job.
 */
export function summarizeRecallRows(rows: RecallLogRow[]): RecallStats {
  const out = emptyRecallStats();
  const pool: number[] = [];
  const scores: number[] = [];
  const elapsed: number[] = [];
  const deadlines: number[] = [];
  const errorCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.cache_hit === true) continue;
    out.rows++;

    if (typeof row.error === "string" && row.error.trim() !== "") {
      const reason = row.error.trim();
      out.errorRows++;
      errorCounts.set(reason, (errorCounts.get(reason) ?? 0) + 1);
    }

    if (Array.isArray(row.bank_timings) && row.bank_timings.length > 0) {
      out.timeoutConsidered++;
      // Match the own bank by id rather than by position. `recall.py` emits it
      // first today, but a future ordering change must not silently turn this
      // into a no-op that reads as 0 % degraded.
      const own = row.bank_timings.find((b) => b.bank_id === row.bank_id);
      if (own?.timed_out || own?.errored) out.ownBankDegraded++;
    }

    if (typeof row.result_count === "number") {
      out.zeroConsidered++;
      if (row.result_count === 0) out.zeroResult++;
    }

    if (typeof row.pre_cap_count === "number") {
      // `pre_cap_count` is post-overlap-gate, so adding back what the gate
      // dropped is what recovers the true CANDIDATE pool. Scoring
      // `pre_cap_count` alone would read an aggressive overlap gate as an
      // empty index — the opposite diagnosis, pointing at the wrong fix.
      const dropped = typeof row.overlap_dropped === "number" ? row.overlap_dropped : 0;
      pool.push(row.pre_cap_count + dropped);
      out.poolConsidered++;
    }

    if (typeof row.injected_score_max === "number") {
      scores.push(row.injected_score_max);
      out.scoreConsidered++;
    }

    if (typeof row.total_elapsed_ms === "number") {
      elapsed.push(row.total_elapsed_ms);
      out.elapsedConsidered++;
    }

    // Guarded on `> 0` and not merely on `typeof number`: the non-parallel
    // path logs `null`, and a zero would become the denominator of the
    // pinning ratio. A wall of zero is not a measurement.
    if (typeof row.deadline_effective_ms === "number" && row.deadline_effective_ms > 0) {
      deadlines.push(row.deadline_effective_ms);
      out.deadlineConsidered++;
    }
    if (row.deadline_hit === true) out.deadlineHitRows++;
  }

  pool.sort((a, b) => a - b);
  scores.sort((a, b) => a - b);
  elapsed.sort((a, b) => a - b);
  deadlines.sort((a, b) => a - b);
  out.poolMedian = median(pool);
  out.scoreP50 = median(scores);
  out.elapsedP95Ms = quantile(elapsed, 0.95);
  out.deadlineEffectiveMedianMs = median(deadlines);

  // Modal reason, ties broken by the lexicographically smaller string so the
  // DM text is deterministic for a given window (Map iteration order is
  // insertion order, which depends on which agent's log was read first).
  let best: string | null = null;
  let bestN = 0;
  for (const [reason, n] of errorCounts) {
    if (n > bestN || (n === bestN && best !== null && reason < best)) {
      best = reason;
      bestN = n;
    }
  }
  out.topError = best;
  return out;
}

/**
 * Read every agent's recall log and reduce the fleet to one `RecallStats`.
 *
 * Fleet-wide rather than per-agent on purpose: the watchdog's job is to page
 * a human when the FLEET's memory is broken, and a per-agent signal set would
 * be 12 × 6 signals with 12 × the hysteresis state and 12 × the DM volume.
 * `switchroom doctor` already renders the per-agent breakdown, and the DM
 * points at it.
 *
 * Throws only when the agents dir itself is unreadable — that is a probe
 * failure ("I cannot see the fleet"), not a measurement of zero.
 */
export function probeRecallLogs(
  agentsDir: string,
  now: number,
  windowRows: number = RECALL_WINDOW_ROWS,
  maxAgeMs: number = RECALL_MAX_ROW_AGE_MS,
): RecallStats {
  const names = readdirSync(agentsDir);
  const all: RecallLogRow[] = [];
  let agents = 0;
  for (const name of names) {
    const rows = withinWindow(
      readRecallLogTail(recallLogPath(join(agentsDir, name)), windowRows),
      now,
      maxAgeMs,
    );
    if (rows.length > 0) agents++;
    all.push(...rows);
  }
  const stats = summarizeRecallRows(all);
  stats.agents = agents;
  return stats;
}
