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
  /** Rows that carried `bank_timings` (older rows predate the field). */
  considered: number;
  /** Rows whose OWN bank hit its per-request timeout. */
  ownBankTimeouts: number;
  /** Rows whose OWN bank raised a hard (non-timeout) error. */
  ownBankErrors: number;
  /** Median `total_elapsed_ms` across rows that reported it, or null. */
  medianElapsedMs: number | null;
}

/**
 * Pure: reduce raw rows to the stats the classifier scores.
 *
 * Exported separately from `classifyRecallHealth` so the window/parse logic
 * and the threshold logic can be tested independently — the 2026-07 regression
 * was invisible partly because the two were never separable.
 */
export function summarizeRecallRows(rows: RecallLogRow[]): RecallHealthStats {
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
    considered: withTimings.length,
    ownBankTimeouts,
    ownBankErrors,
    medianElapsedMs,
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
  const { considered, ownBankTimeouts, ownBankErrors, medianElapsedMs } = stats;

  if (considered === 0) {
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
    `${degraded}/${considered} of the last recalls failed to read the agent's own bank ` +
    `(${pct}%; ${ownBankTimeouts} timed out, ${ownBankErrors} errored), median recall ${med}`;

  const fix =
    "Auto-recall is silently degraded — the agent runs with little or no memory " +
    "while looking healthy. Check hindsight server latency first " +
    "(`switchroom doctor` hindsight rows, then the recall stage trace); the " +
    "cross-encoder rerank stage dominates recall latency and is tuned by " +
    "HINDSIGHT_API_RERANKER_MAX_CANDIDATES in src/setup/hindsight.ts.";

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
): CheckResult {
  const rows = readRecallLogTail(recallLogPath(agentDir), windowRows);
  return classifyRecallHealth(agentName, summarizeRecallRows(rows));
}
