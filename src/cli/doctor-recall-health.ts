/**
 * Auto-recall health checks for `switchroom doctor`.
 *
 * ## Why this file exists
 *
 * Every agent's CLAUDE.md tells the agent that auto-recall "fires on every
 * inbound user message". Between 2026-06 and 2026-07 that claim was false for
 * most fires on the busiest banks, and **nothing went red for weeks**. The
 * failure is structurally silent at every layer:
 *
 *   1. `recall.py` is a direct Claude Code plugin hook (not wrapped by
 *      `bin/run-hook.sh`), and on a bank timeout it deliberately exits 0 with
 *      no `additionalContext` — blocking the user's prompt would be worse
 *      (`vendor/hindsight-memory/scripts/recall.py`, the `__main__` guard).
 *   2. Claude Code swallows hook stderr on a zero exit. `doctor-memory.ts`
 *      already records the measurement: `docker logs --tail 20000` across all
 *      12 agent containers returned ZERO `[Hindsight]` lines on 2026-07-25.
 *   3. The agent is handed an empty context and cannot tell "no relevant
 *      memories" apart from "the fact layer was unreachable".
 *
 * So the only durable operator-facing signal is the telemetry the hook writes
 * itself: `recall_log.jsonl`. This check reads it and turns a degraded recall
 * path into a red `doctor` row.
 *
 * ## What "degraded" means here
 *
 * The load-bearing field is `bank_timings[]`, one entry per bank queried, each
 * with `timed_out`. The agent's OWN bank is the one that carries its memory;
 * additional banks (a shared profile bank, say) are supplementary. A recall
 * whose own bank timed out has, in practice, no agent memory in it — even when
 * `result_count > 0`, because those results came from the smaller side banks.
 * Measured on the 2026-07-26 fleet snapshot: of 1280 rows carrying
 * `bank_timings`, 1148 (89.7%) had the own bank time out, and only 28 of those
 * (2.4%) still returned any results at all. Own-bank timeout rate is therefore
 * the metric that actually tracks "is this agent remembering anything".
 *
 * `result_count === 0` alone is NOT a failure signal — a genuinely empty match
 * is normal and common. We only count a zero-result row as degraded when it is
 * accompanied by a timeout or a hard bank error, which is exactly the
 * distinction `recall.py` already draws via `deadline_hit` / `errored`.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

/**
 * Own-bank timeout rate above which the row goes `warn`.
 *
 * A healthy fleet sits near zero: an unloaded server answers a recall in
 * 0.6-4.3s against an 8s per-bank budget, so timeouts should be rare tail
 * events, not routine. 10% means roughly one turn in ten is running with no
 * agent memory — already a user-visible quality drop, and the level at which
 * the 2026-07 regression would have been caught in its first week rather than
 * its sixth.
 */
export const RECALL_OWN_BANK_TIMEOUT_WARN_RATE = 0.1;

/**
 * Own-bank timeout rate above which the row goes `fail`.
 *
 * At a quarter of all fires the agent is effectively amnesiac often enough
 * that its behaviour changes — it re-derives standing answers, re-asks settled
 * questions, and contradicts its own directives. The 2026-07-26 snapshot had
 * overlord and klanker at 96.8% and 97.0%.
 */
export const RECALL_OWN_BANK_TIMEOUT_FAIL_RATE = 0.25;

/**
 * Minimum rows before the rate is trusted.
 *
 * Below this a single slow recall dominates the percentage and the row would
 * flap between ok and fail on an idle agent. Under the floor we report `ok`
 * with the sample size, so a quiet agent never manufactures a false alarm.
 */
export const RECALL_HEALTH_MIN_SAMPLE = 20;

/**
 * How many trailing rows are considered.
 *
 * `recall_log.jsonl` is append-only and unbounded in age (18,827 rows on the
 * 2026-07-26 snapshot, reaching back to 2026-06-05). Reading all of it would
 * average a live regression away against months of healthy history, so the
 * check is deliberately a *recent-window* one.
 */
export const RECALL_HEALTH_WINDOW_ROWS = 200;

/**
 * Maximum age of a row that still counts toward the rate.
 *
 * `RECALL_HEALTH_WINDOW_ROWS` alone is a *volume* bound, not a *recency* one,
 * and on a quiet agent the two diverge badly. Measured on the 2026-08-02 host,
 * the trailing 200 rows reached back:
 *
 *   gymbro 13d · marko 10d · reggie 9d · carrie 8d · clerk 8d · finn 5d
 *
 * The fleet ran a real own-bank timeout regression that ended 2026-07-28.
 * Days later `doctor` was still scoring those agents on rows from *during* it
 * and reporting the resolved outage as current health:
 *
 *   agent     200-row window   last 72h   verdict(200-row) -> verdict(72h)
 *   carrie           23.5%       2.9%     warn -> ok
 *   marko            23.0%       0.0%     warn -> ok
 *   clerk            31.0%       0.9%     fail -> ok
 *   gymbro           36.7%       0.0%     fail -> ok
 *   reggie           37.5%        n/a     fail -> ok (under the sample floor)
 *   klanker          17.0%      15.7%     warn -> warn  (genuinely degraded)
 *   overlord         14.0%       9.5%     warn -> warn  (genuinely degraded)
 *
 * That is not a cosmetic mislabel. Those false FAILs were read as a live
 * fleet-wide outage and drove remediation work against a bug that was already
 * fixed, while the two agents that *are* degraded sat in the same undiffer-
 * entiated pile. A health check whose window predates its own subject is worse
 * than no check, because it is believed.
 *
 * 72h is the smallest window that keeps every *active* agent above
 * `RECALL_HEALTH_MIN_SAMPLE` on that host (klanker 287, overlord 317, finn
 * 133, clerk 107, marko 39, carrie 35, gymbro 33) while excluding the resolved
 * regression. An agent quieter than 20 rows / 72h falls under the sample floor
 * and reports `ok` with its count — the safe direction, and already the
 * documented behaviour for a low-traffic agent.
 *
 * The row cap still applies FIRST (it is the IO bound); this is an additional
 * filter, so a busy agent is scored on its most recent 200 rows and a quiet one
 * on however many of those are actually recent.
 */
export const RECALL_HEALTH_WINDOW_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Byte cap on the tail read, sized to comfortably contain
 * `RECALL_HEALTH_WINDOW_ROWS` rows.
 *
 * `recall_log.jsonl` is append-only and never rotated: 1.2-2.3 MB per agent on
 * 2026-07-26 and growing monotonically. Slurping every agent's whole log to
 * take its last 200 lines would make `switchroom doctor` cost hundreds of MB of
 * IO within a year — a health check that degrades the host it inspects. Rows
 * are ~700-900 bytes worst case (see the size note at
 * `vendor/hindsight-memory/scripts/recall.py`), so 1 MiB holds well over 1000.
 */
export const RECALL_HEALTH_MAX_TAIL_BYTES = 1024 * 1024;

/** One parsed `recall_log.jsonl` row, narrowed to the fields we classify on. */
export interface RecallLogRow {
  /**
   * ISO-8601 UTC stamp written by `recall.py` on every row
   * (`time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())`).
   *
   * Load-bearing since the recency window: a row we cannot date cannot be
   * proven recent, so it is excluded rather than assumed current — see
   * `filterRecentRecallRows`.
   */
  ts?: string;
  bank_id?: string;
  result_count?: number;
  total_elapsed_ms?: number;
  deadline_hit?: boolean;
  bank_timings?: Array<{
    bank_id?: string;
    elapsed_ms?: number;
    timed_out?: boolean;
    errored?: boolean;
  }>;
}

export interface RecallHealthStats {
  /**
   * Every row parsed from the window, including ones we cannot score.
   *
   * Kept alongside `considered` so the classifier can tell "this agent has
   * never fired a recall" apart from "this agent has fired recalls, but all of
   * them predate `bank_timings`". Both leave `considered` at 0 and were
   * reported identically as "no recall telemetry yet (agent idle, or plugin
   * not yet fired)" — which is simply false for the second case (kdogg on the
   * 2026-07-26 host has 12 real rows, none carrying the field) and points the
   * operator at the wrong thing.
   */
  rowsSeen: number;
  /** Rows that carried `bank_timings` (older rows predate the field). */
  considered: number;
  /** Rows whose OWN bank hit its per-request timeout. */
  ownBankTimeouts: number;
  /** Rows whose OWN bank raised a hard (non-timeout) error. */
  ownBankErrors: number;
  /** Median `total_elapsed_ms` across rows that reported it, or null. */
  medianElapsedMs: number | null;
  /**
   * Rows dropped from the window for being older than
   * `RECALL_HEALTH_WINDOW_MAX_AGE_MS` (or undateable).
   *
   * Surfaced in the detail line so the operator can see that the window is
   * narrower than the row cap. Without it, "3/107 failed" and "3/107 failed,
   * 93 older rows excluded" look identical, and the second is the one that
   * explains why yesterday's FAIL is today's ok.
   */
  staleDropped: number;
}

/**
 * Pure: reduce raw rows to the stats the classifier scores.
 *
 * Exported separately from `classifyRecallHealth` so the window/parse logic
 * and the threshold logic can be tested independently — the 2026-07 regression
 * was invisible partly because the two were never separable.
 */
/**
 * Pure: keep only rows recent enough to describe the agent's CURRENT health.
 *
 * A row is in-window iff it carries a parseable `ts` no older than `maxAgeMs`.
 * An undateable row is EXCLUDED, deliberately: the whole failure this guards
 * against is stale data being scored as current, and "keep what we cannot
 * date" reintroduces it verbatim for exactly the oldest rows. Every row
 * `recall.py` has written since the `bank_timings` schema landed carries `ts`
 * (verified: 0 of 10,627 rows across klanker/carrie/overlord/gymbro lack it on
 * the 2026-08-02 host), so in practice this drops only pre-schema rows, which
 * `summarizeRecallRows` already cannot score.
 *
 * Dropping too much is safe and dropping too little is not: an over-filtered
 * window falls under `RECALL_HEALTH_MIN_SAMPLE` and reports `ok` *with its
 * count*, which is visibly "not enough data", whereas an under-filtered one
 * reports a confident wrong verdict.
 *
 * Exported and `now`-injected so the window logic is testable without clocks.
 */
export function filterRecentRecallRows(
  rows: RecallLogRow[],
  maxAgeMs: number = RECALL_HEALTH_WINDOW_MAX_AGE_MS,
  now: number = Date.now(),
): RecallLogRow[] {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return rows;
  const cutoff = now - maxAgeMs;
  return rows.filter((r) => {
    if (typeof r.ts !== "string") return false;
    const t = Date.parse(r.ts);
    // A future-dated row (host clock skew) is kept: it is certainly not stale,
    // and silently discarding it would under-report a live degradation.
    return Number.isFinite(t) && t >= cutoff;
  });
}

export function summarizeRecallRows(
  rows: RecallLogRow[],
  staleDropped = 0,
): RecallHealthStats {
  const withTimings = rows.filter(
    (r) => Array.isArray(r.bank_timings) && r.bank_timings.length > 0,
  );
  let ownBankTimeouts = 0;
  let ownBankErrors = 0;
  const elapsed: number[] = [];

  for (const row of withTimings) {
    // The own bank is the row's `bank_id`; `recall.py` always emits it first in
    // `bank_timings`, but we match by id rather than by position so a future
    // ordering change cannot silently turn this check into a no-op.
    const own = row.bank_timings?.find((b) => b.bank_id === row.bank_id);
    if (own?.timed_out) ownBankTimeouts++;
    else if (own?.errored) ownBankErrors++;
    if (typeof row.total_elapsed_ms === "number") elapsed.push(row.total_elapsed_ms);
  }

  elapsed.sort((a, b) => a - b);
  const medianElapsedMs =
    elapsed.length > 0 ? elapsed[Math.floor(elapsed.length / 2)] : null;

  return {
    rowsSeen: rows.length,
    considered: withTimings.length,
    ownBankTimeouts,
    ownBankErrors,
    medianElapsedMs,
    staleDropped,
  };
}

/**
 * Pure: classify one agent's recall health.
 *
 * `null` is never returned — a silent skip is exactly the failure mode this
 * file exists to prevent. An agent with too little data reports `ok` and says
 * so, which is honest and visibly different from "healthy".
 */
export function classifyRecallHealth(
  agentName: string,
  stats: RecallHealthStats,
): CheckResult {
  const name = `${agentName} auto-recall`;
  const { rowsSeen, considered, ownBankTimeouts, ownBankErrors, medianElapsedMs } = stats;
  const staleDropped = stats.staleDropped ?? 0;
  const windowHours = Math.round(RECALL_HEALTH_WINDOW_MAX_AGE_MS / 3_600_000);
  // Always name the window, and name what it excluded. The 2026-08 misdiagnosis
  // happened because the detail line said "the last recalls" while meaning
  // "some of them from eight days ago".
  const windowNote =
    staleDropped > 0
      ? ` [window: last ${windowHours}h; ${staleDropped} older rows excluded]`
      : ` [window: last ${windowHours}h]`;

  if (considered === 0) {
    if (rowsSeen > 0) {
      // Recall HAS been firing — the rows just predate `bank_timings`, so we
      // cannot say anything about own-bank health. Say that, rather than
      // "agent idle", which sends the operator looking for a dead plugin that
      // is in fact running.
      return {
        name,
        status: "ok",
        detail:
          `${rowsSeen} recall rows in the window, none carrying bank_timings ` +
          "(pre-A3 telemetry schema) — own-bank health not scoreable until the " +
          "agent fires a recall on the current hook" +
          windowNote,
      };
    }
    if (staleDropped > 0) {
      // The log is not empty — every row in it is simply older than the window.
      // Saying "agent idle, or plugin not yet fired" here would send the
      // operator hunting a dead plugin on an agent that just hasn't been
      // spoken to in three days.
      return {
        name,
        status: "ok",
        detail:
          `no recall in the last ${windowHours}h (${staleDropped} older rows ` +
          "outside the window) — agent quiet, not scored",
      };
    }
    return {
      name,
      status: "ok",
      detail: "no recall telemetry yet (agent idle, or plugin not yet fired)",
    };
  }

  const degraded = ownBankTimeouts + ownBankErrors;
  const rate = degraded / considered;
  const pct = (rate * 100).toFixed(1);
  const med = medianElapsedMs === null ? "n/a" : `${medianElapsedMs}ms`;
  const detail =
    `${degraded}/${considered} recalls failed to read the agent's own bank ` +
    `(${pct}%; ${ownBankTimeouts} timed out, ${ownBankErrors} errored), median recall ${med}` +
    windowNote;

  // Diagnosis corrected 2026-08-02. This text used to send the operator at the
  // cross-encoder rerank stage. Measured against the live container that is
  // the wrong stage by an order of magnitude: over 44,342 recalls in 24h,
  // server-side recall WORK is p50 1.12s / p99 4.09s, while the wait for a
  // recall admission slot is p50 11.59s / p90 30.0s / max 74.0s — ~90% of
  // observed latency is queueing, and only 0.04% of recalls spend >9s doing
  // actual work. Rerank tuning cannot buy back a 12s queue.
  //
  // The queue is `HINDSIGHT_API_RECALL_MAX_CONCURRENT` (8 slots), shared
  // between latency-critical interactive auto-recall (10s deadline) and
  // background consolidation, which issues its own unbounded recalls
  // (13-26s per batch) while grinding five-figure backlogs. Interactive
  // recall queues behind batch work that has no deadline at all.
  //
  // Do NOT "fix" this by raising the recall deadline. That was tried on the
  // live fleet 2026-07-26/27 (16s vs 10s) and made every agent worse, not
  // better — finn 3.5% -> 65.9%, clerk 21.5% -> 83.8%, carrie 40.7% -> 55.4%
  // — which is what a fixed-slot queue does when clients become more patient.
  const fix =
    "Auto-recall is degraded — the agent runs with little or no memory. The " +
    "agent IS told (recall.py emits the #3619 DEGRADED notice), so this is a " +
    "capacity problem, not a visibility one. Measured cause is admission " +
    "queueing, not ranking cost: check the `waits: sem=` field on the " +
    "container's [RECALL ...] Complete log lines against the recall work time " +
    "on the same line. If sem-wait dominates, the lever is recall admission " +
    "capacity (HINDSIGHT_API_RECALL_MAX_CONCURRENT) and keeping background " +
    "consolidation recalls off the interactive path — NOT the rerank stage, " +
    "and NOT a longer deadline (raising it 10s->16s on 2026-07-26 made every " +
    "agent's timeout rate worse).";

  if (considered < RECALL_HEALTH_MIN_SAMPLE) {
    // Too few rows to score, but still worth surfacing the raw counts so a
    // freshly-broken agent is not indistinguishable from a freshly-started one.
    return {
      name,
      status: "ok",
      detail: `${detail} — below the ${RECALL_HEALTH_MIN_SAMPLE}-row sample floor, not scored`,
    };
  }

  if (rate >= RECALL_OWN_BANK_TIMEOUT_FAIL_RATE) {
    return { name, status: "fail", detail, fix };
  }
  if (rate >= RECALL_OWN_BANK_TIMEOUT_WARN_RATE) {
    return { name, status: "warn", detail, fix };
  }
  return { name, status: "ok", detail };
}

/**
 * Path of an agent's recall telemetry inside its host-side scaffold.
 *
 * The hook runs in the agent container but `$HOME/.claude` is bind-mounted
 * from `~/.switchroom/agents/<name>/`, so the operator host can read this
 * without `docker exec` — which matters because the check must still work when
 * the container is down (a crash-looping agent is precisely when you want to
 * know whether its recall was already failing).
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
 * Read the trailing window of an agent's recall log.
 *
 * Best-effort by construction: an unreadable, absent, or partly-corrupt log
 * yields the rows we could parse rather than throwing, because a broken
 * telemetry file must not take `switchroom doctor` itself down.
 */
export function readRecallLogTail(
  path: string,
  windowRows: number = RECALL_HEALTH_WINDOW_ROWS,
): RecallLogRow[] {
  if (!existsSync(path)) return [];
  let text: string;
  let truncatedHead = false;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - RECALL_HEALTH_MAX_TAIL_BYTES);
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
  const tail = lines.slice(-windowRows);
  const rows: RecallLogRow[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as RecallLogRow;
      if (parsed && typeof parsed === "object") rows.push(parsed);
    } catch {
      // A torn final line is normal for an append-only log being written
      // concurrently; skip it rather than failing the whole check.
    }
  }
  return rows;
}

/**
 * Full per-agent check: read the log tail, summarize, classify.
 */
export function checkAgentRecallHealth(
  agentName: string,
  agentDir: string,
  windowRows: number = RECALL_HEALTH_WINDOW_ROWS,
  maxAgeMs: number = RECALL_HEALTH_WINDOW_MAX_AGE_MS,
  now: number = Date.now(),
): CheckResult {
  // Two bounds, applied in this order and for different reasons: `windowRows`
  // caps IO cost, `maxAgeMs` makes the verdict about the present. Only the
  // second was missing, and its absence is what let a resolved regression keep
  // reporting as a live one for days.
  const rows = readRecallLogTail(recallLogPath(agentDir), windowRows);
  const recent = filterRecentRecallRows(rows, maxAgeMs, now);
  return classifyRecallHealth(
    agentName,
    summarizeRecallRows(recent, rows.length - recent.length),
  );
}
