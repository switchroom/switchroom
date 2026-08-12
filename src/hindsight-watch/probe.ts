/**
 * The three probes, and the rule that binds them: EVERY probe failure is a
 * signal, never a default.
 *
 * Cost per pass (measured against the live host, 2026-07-25 re-measured
 * 2026-07-26): one HTTP GET of the `/metrics` body (258,741 B today), one
 * `docker inspect`, and per agent (12 today) two readdirs plus one small
 * `pending-drops.json` read. No queue ENTRY is ever opened — those carry
 * whole transcripts, p50 ~98 KB. At the recommended 15-minute cadence that
 * is 4 requests an hour against a backend whose own workers issue thousands
 * — the watchdog cannot itself become the load.
 *
 * Plus three read-only `docker exec` psql calls (measured live 2026-07-29):
 * the consolidation queue depth, the per-bank consolidation block (0.284 s for
 * a grouped aggregate over 676,720 memory units), and the HNSW canary (0.45 s
 * across all 89 indexes). None of the three writes anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  parseExposition,
  readLlmSignals,
  readRetainSignals,
  type LlmSignals,
  type RetainSignals,
} from "./metrics.js";
import { probeRecallLogs, type RecallStats } from "./recall-log.js";
import {
  DEFAULT_CONTAINER,
  DEFAULT_METRICS_URL,
  METRICS_MAX_BYTES,
  METRICS_TIMEOUT_MS,
  VECTOR_INDEX_SAMPLE_ROWS,
} from "./thresholds.js";
import type {
  BankFailureStreak,
  BankPendingConsolidation,
  BankSample,
  ConsolidationSample,
  Sample,
  VectorIndexSample,
} from "./types.js";

/**
 * A probe failed in a way that means the watchdog CANNOT SEE hindsight. It
 * is deliberately an exception rather than a "0" default: the whole point of
 * this module is that an unreachable endpoint reads as an alert, not as a
 * clean bill of health.
 */
export class ProbeError extends Error {
  constructor(
    message: string,
    readonly probe: "metrics" | "docker" | "spool",
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

/**
 * The `/metrics` body was larger than `METRICS_MAX_BYTES`.
 *
 * Its own class because it is the ONE metrics failure that is not evidence
 * hindsight is unwell — the endpoint answered, promptly and correctly; we
 * declined to buffer the answer. Treating it like an outage was a real
 * defect: `probeOnce` aborts on any `ProbeError`, and `run.ts` then reports
 * NOTHING ELSE ("a blind watchdog reports nothing else"), so a body one byte
 * over the cap silenced the recall signals too — and those are read from
 * local JSONL files that were perfectly readable. A self-imposed buffer limit
 * must not be able to blind a signal it has nothing to do with.
 *
 * So this one degrades: the metrics-derived signals (`retain-failure-rate`,
 * `llm-fallback-ineffective`) go `no-data`, which is inert and never a pass,
 * and every other signal evaluates normally. It is NOT truncate-and-parse,
 * deliberately — a truncated exposition losing the `success="false"` series
 * would read as zero failures, which is fail-OPEN and precisely the bug class
 * this whole change exists to remove.
 */
export class MetricsTooLargeError extends ProbeError {
  constructor(
    readonly bytes: number,
    readonly cap: number,
  ) {
    super(`body ${bytes}B exceeds the ${cap}B cap — metrics-derived signals degrade to no-data`, "metrics");
    this.name = "MetricsTooLargeError";
  }
}

/** The `/metrics` slice one tick consumes. */
export interface MetricsSample {
  retain: RetainSignals;
  /** null when the exposition carries no LLM-call family (see `readLlmSignals`) */
  llm: LlmSignals | null;
}

/**
 * GET `/metrics` and reduce it to the signals one tick needs. Throws on any
 * failure to fetch, read or parse — an unreachable or unparseable endpoint is
 * an alert, never a clean bill of health.
 */
export async function probeMetrics(
  url: string = DEFAULT_METRICS_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricsSample> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProbeError(`GET ${url} failed: ${(e as Error).message}`, "metrics");
  }
  if (!res.ok) throw new ProbeError(`GET ${url} returned HTTP ${res.status}`, "metrics");
  let body: string;
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (e) {
    throw new ProbeError(`reading ${url}: ${(e as Error).message}`, "metrics");
  }
  // Thrown OUTSIDE the try above so it cannot be re-wrapped into a plain
  // ProbeError — `probeOnce` distinguishes this case by class, and losing the
  // class here would silently restore the old blind-the-whole-tick behaviour.
  if (buf.byteLength > METRICS_MAX_BYTES) {
    throw new MetricsTooLargeError(buf.byteLength, METRICS_MAX_BYTES);
  }
  try {
    body = new TextDecoder().decode(buf);
  } catch (e) {
    throw new ProbeError(`reading ${url}: ${(e as Error).message}`, "metrics");
  }
  try {
    const series = parseExposition(body);
    return { retain: readRetainSignals(series), llm: readLlmSignals(series) };
  } catch (e) {
    throw new ProbeError(`parsing ${url}: ${(e as Error).message}`, "metrics");
  }
}

/** The container facts the watchdog reads. */
export interface ContainerFacts {
  restartCount: number;
  startedAt: string;
  /** `State.Health.Status`, or `"none"` when the image defines no healthcheck. */
  health: string;
}

export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "pipe", timeout: 10_000, encoding: "utf8" });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * `docker inspect` the hindsight container. Throws when docker is missing or
 * the container is absent — "I cannot tell whether it is running" is exactly
 * as alarming as "it is not running", and must not be flattened to healthy.
 */
export function probeContainer(
  container: string = DEFAULT_CONTAINER,
  run: Runner = defaultRunner,
): ContainerFacts {
  const fmt = "{{.RestartCount}}\t{{.State.StartedAt}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
  const r = run("docker", ["inspect", "--format", fmt, container]);
  if (r.status !== 0) {
    throw new ProbeError(
      `docker inspect ${container} failed (exit ${r.status}): ${r.stderr.trim() || "no stderr"}`,
      "docker",
    );
  }
  const parts = r.stdout.trim().split("\t");
  if (parts.length < 3) {
    throw new ProbeError(`docker inspect ${container}: unparseable output ${JSON.stringify(r.stdout)}`, "docker");
  }
  const restartCount = Number(parts[0]);
  if (!Number.isFinite(restartCount)) {
    throw new ProbeError(`docker inspect ${container}: non-numeric RestartCount ${JSON.stringify(parts[0])}`, "docker");
  }
  return { restartCount, startedAt: parts[1], health: parts[2] };
}

/** Fleet-wide spool depth. */
export interface SpoolDepth {
  pending: number;
  dead: number;
  /** entries in every agent's `pending-evicted/` archive (#3599) */
  evicted: number;
  /** summed `count` of every agent's `pending-drops.json` ledger (#3599) */
  drops: number;
  /**
   * entries in every agent's `pending-duplicate/` archive (#3896) — redundant
   * copies retired by `collapse_duplicates()`. NOT loss; see `Sample.duplicates`.
   */
  duplicates: number;
  /** agents whose spool dir was readable (for the operator-facing detail) */
  agents: number;
}

/** Sanity bound on `pending-drops.json`; the real ledger is ~150 B. */
const DROPS_LEDGER_MAX_BYTES = 64 * 1024;

/**
 * Read one agent's `pending-drops.json` `count`, or 0.
 *
 * The ledger is a small fixed-shape object (`{schema, count, last_*}`), so
 * this is one tiny read per agent per tick — nothing like reading the queue
 * entries themselves, which carry whole transcripts. A missing, torn or
 * foreign-shaped ledger reads as 0: `record_drop` writes it tmp+rename so a
 * torn read is a transient the next tick resolves, and inventing a loss out
 * of an unparseable file would be a false alarm on the loudest signal here.
 */
function readDropCount(hindsightDir: string): number {
  const path = resolve(hindsightDir, "pending-drops.json");
  let parsed: unknown;
  try {
    // The real ledger is a few hundred bytes. Refusing anything larger keeps
    // a corrupt or wrongly-named file from being slurped into memory on
    // every tick — this runs unattended on a cron.
    if (statSync(path).size > DROPS_LEDGER_MAX_BYTES) return 0;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null) return 0;
  const n = Number((parsed as { count?: unknown }).count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Count `*.json` / `*.json.dead` across every agent's spool, plus the two
 * loss channels #3599 added beside it — `pending-evicted/` and
 * `pending-drops.json`, both siblings of `pending-retains/`
 * (`lib/pending.py:_sibling`), so neither can be mistaken for a live entry.
 *
 * Reads the HOST scaffold path (`~/.switchroom/agents/<a>/home/.hindsight/
 * pending-retains`), which is the same directory the agent container sees at
 * `/state/agent/home/.hindsight/pending-retains` — verified live: the
 * compose mount is `~/.switchroom/agents/<name>` → `/state/agent`. That
 * makes this a plain readdir instead of the N `docker exec` round-trips
 * `switchroom doctor` pays (src/cli/doctor.ts, `probePendingRetainsQueue`),
 * which matters for something running every 15 minutes.
 *
 * NOTE the distinction from doctor's comment about a host scan being
 * "always empty": that refers to the OPERATOR's own `$HOME/.hindsight`,
 * which really is empty. The per-agent scaffold path used here is not.
 */
/**
 * The agents scaffold dir, honouring `SWITCHROOM_HOME` like the rest of the
 * CLI. Shared by the spool and recall-log probes so the two can never read
 * different fleets.
 */
export function resolveAgentsDir(explicit?: string): string {
  return (
    explicit ??
    resolve(process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(), ".switchroom", "agents")
  );
}

export function probeSpool(agentsDir: string = resolveAgentsDir()): SpoolDepth {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch (e) {
    throw new ProbeError(`reading ${agentsDir}: ${(e as Error).message}`, "spool");
  }
  let pending = 0;
  let dead = 0;
  let evicted = 0;
  let drops = 0;
  let duplicates = 0;
  let agents = 0;
  for (const name of names) {
    const hindsightDir = resolve(agentsDir, name, "home", ".hindsight");
    let entries: string[] | null = null;
    try {
      entries = readdirSync(resolve(hindsightDir, "pending-retains"));
    } catch {
      // No spool dir for this agent (never spooled, or not an agent dir at
      // all). Absence is not a fault — a missing queue is an empty queue.
      // NOTE we deliberately do NOT `continue` here: the two loss channels
      // are SIBLINGS of the queue dir, not children of it, so an operator
      // who deletes `pending-retains` must not thereby make this agent's
      // eviction/drop history invisible (it would read as a decrease, and a
      // decrease is a silent re-baseline).
    }
    if (entries !== null) {
      agents++;
      for (const f of entries) {
        if (f.endsWith(".json.dead")) dead++;
        else if (f.endsWith(".json")) pending++;
        // Anything else (notably the `.tmp` files a torn tmp+rename leaves
        // behind — 8 of them live on this fleet) is not a queue entry.
      }
    }
    try {
      for (const f of readdirSync(resolve(hindsightDir, "pending-evicted"))) {
        if (f.endsWith(".json")) evicted++;
      }
    } catch {
      // Nothing has ever been evicted for this agent. Not a fault.
    }
    // `.dead` markers used to be written INSIDE `pending-retains`; they are
    // now retired into the `pending-dead/` sibling so that no janitor glob
    // over the live queue can match a memory. Both locations are counted:
    // if only the in-queue form were counted, the relocation would read as
    // `dead` dropping to zero, i.e. a silent loss of the loss signal.
    try {
      for (const f of readdirSync(resolve(hindsightDir, "pending-dead"))) {
        if (f.endsWith(".dead")) dead++;
      }
    } catch {
      // Nothing has ever been retired for this agent. Not a fault.
    }
    // `pending-duplicate/` is the archive `collapse_duplicates()` moves a
    // redundant, byte-identical entry into (`lib/pending.py:duplicate_dir`) —
    // another sibling of `pending-retains`, never inside it, so it cannot be
    // mistaken for a live entry. Counted so a collapse pass reads as an
    // explained drain rather than as loss (#3896); it is NOT summed into any
    // loss channel.
    try {
      for (const f of readdirSync(resolve(hindsightDir, "pending-duplicate"))) {
        if (f.endsWith(".json")) duplicates++;
      }
    } catch {
      // Nothing has ever been collapsed for this agent. Not a fault.
    }
    drops += readDropCount(hindsightDir);
  }
  return { pending, dead, evicted, drops, duplicates, agents };
}

export interface ProbeOptions {
  metricsUrl?: string;
  container?: string;
  agentsDir?: string;
  fetchImpl?: typeof fetch;
  run?: Runner;
  now?: () => number;
}

/**
 * Shell run inside the hindsight container to read the consolidation queue.
 *
 * Deliberately a near-copy of `docker/hindsight-maintenance.sh`'s `_sql`
 * bootstrap (glob the pg0 install for `psql`, read the instance descriptor for
 * the credentials) rather than a new connection convention, so the watchdog
 * and the maintenance loop cannot end up reading two different databases.
 *
 * Prints `<pending>|<oldest_age_seconds>` on success and nothing on any
 * missing precondition. The password is passed via `PGPASSWORD` in the
 * container's own environment and never crosses back out — the only thing
 * this returns is two integers.
 */
const PSQL_BOOTSTRAP_SH = `
set -e
B="$(ls -d /home/hindsight/.pg0/installation/*/bin 2>/dev/null | head -1)"
PSQL="$(command -v psql 2>/dev/null || echo "\${B:-/nonexistent}/psql")"
[ -x "$PSQL" ] || exit 0
D=/home/hindsight/.pg0/instances/hindsight/instance.json
[ -r "$D" ] || exit 0

# shlex.quote every field before eval. The descriptor is local and not
# attacker-controlled, but a password containing a shell metacharacter would
# otherwise either break the eval (silently degrading this signal to no-data
# forever) or execute part of itself. Quoting removes the class outright.
eval "$(python3 -c 'import json,shlex,sys
d=json.load(open(sys.argv[1]))
q=lambda k,dflt: shlex.quote(str(d.get(k) or dflt))
print("U=%s DB=%s P=%s PW=%s"%(q("username","hindsight"),q("database","hindsight"),q("port",5432),q("password","")))' "$D")"
[ -n "$PW" ] || exit 0
`;

const CONSOLIDATION_QUEUE_SH = `${PSQL_BOOTSTRAP_SH}
PGPASSWORD="$PW" "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -tAc \\
  "SELECT count(*)||'|'||coalesce(max(extract(epoch from (now()-created_at)))::bigint,0) FROM async_operations WHERE status IN ('pending','processing')"
`;

/**
 * Per-bank consolidation facts: terminal-failure STREAKS and unconsolidated
 * DEPTH, in one psql pass.
 *
 * Two tagged sections on stdout, so one round trip answers both signals:
 *
 *   `S|<bank>|<operation_type>|<streak>|<newest_failure_age_seconds>|<last_completed_age_seconds>`
 *   `P|<bank>|<pending_consolidation>`
 *
 * The sixth field is EMPTY when the pair has never completed an op. The
 * five-field row is the pre-#4618 shape and is still parsed, as unknown.
 *
 * ### The streak query
 *
 * A streak is the `status='failed'` rows NEWER than that
 * `(bank_id, operation_type)` pair's most recent `status='completed'` row.
 * Three properties, each load-bearing:
 *
 *  - **`completed` breaks a streak; `pending`/`processing` do not.** A row
 *    that has not reached a terminal state is not evidence the fault is over,
 *    and letting an in-flight attempt clear the streak would blind the signal
 *    for exactly as long as the next attempt takes to fail.
 *  - **Grouped by the PAIR, not the bank.** During the incident `overlord`
 *    completed 3,753 retains while its consolidation failed 112 times; a
 *    bank-wide streak would have been reset by every one of them.
 *  - **`-infinity` for a pair that has never completed, FLOORED at the
 *    retention horizon.** `coalesce` to a fixed finite date would silently
 *    window the count, and a pair whose very first op failed must still
 *    register a streak — which is why the fallback is `-infinity` and not a
 *    constant. But an UNBOUNDED fallback counts failures that predate a
 *    completion which has since been swept: `docker/hindsight-maintenance.sh`
 *    deletes `status='completed'` rows older than the retention horizon and,
 *    per its own header, NEVER touches failed rows. So a pair that succeeded
 *    35 days ago and failed 40 days ago reads as "112 consecutive failures,
 *    never completed" — a page nothing can ever clear, because nothing is
 *    left to complete (#4620). `greatest(…, now() - retention)` bounds the
 *    scan to the window in which the two halves of a streak are still
 *    comparable. See {@link bankConsolidationQuery} for where the horizon
 *    comes from and what it does and does not close.
 *
 * The row also carries the age of the pair's most recent `completed` op —
 * EMPTY when the pair has never completed one. That is the field that lets
 * the evaluator ask "has anything succeeded lately?" instead of only "is the
 * newest failure recent?"; the latter cannot hold the streak of a sparse,
 * demand-driven operation type whose failures are legitimately hours or days
 * old while the job is 100 % broken. It reuses the same correlated-subselect
 * SHAPE the streak definition already uses, but it is a SECOND correlated
 * subselect and does cost a second `SubPlan` over `async_operations` — the
 * measured price on the production database is the whole statement at 20.3 ms
 * (`EXPLAIN (ANALYZE, TIMING OFF)`), against a 5 s probe budget, so it is
 * affordable rather than free.
 *
 * ### The depth query
 *
 * `count(*) FILTER (WHERE consolidated_at IS NULL AND fact_type IN
 * ('experience','world'))` per bank — the same predicate the API's
 * `get_bank_freshness` uses for the `pending_consolidation` field it
 * publishes on `/v1/default/banks/{bank}/stats`. Computed here rather than
 * fetched over N HTTP calls: measured 0.284 s for the whole fleet, against
 * ~1.4-2.1 s PER BANK for the `/stats` endpoint.
 */
/**
 * The streak + depth statement, with the retention floor left as a SQL
 * expression the caller supplies.
 *
 * ### Why the floor is a parameter, and where the value comes from
 *
 * The floor closes #4620 only if it is the SAME horizon the pruner uses.
 * `docker/hindsight-maintenance.sh:63` reads
 * `SWITCHROOM_HINDSIGHT_RETENTION_DAYS` (default 30) from its own process
 * environment, and that script runs INSIDE the hindsight container
 * (`docker/hindsight-entrypoint.sh:82`). This probe reaches the same table
 * through `docker exec` on the same container, and `docker exec` inherits the
 * container's environment — verified live: `HINDSIGHT_API_PORT` reads back
 * `18888` through `docker exec`, and `SWITCHROOM_HINDSIGHT_RETENTION_DAYS`
 * reads back unset, which is exactly what the fleet has and why the pruner is
 * on its 30-day default.
 *
 * So the shell expands the knob itself rather than this module hard-coding a
 * number. A hard-coded 30 would be silently wrong on precisely the deployment
 * that tuned the knob: at `RETENTION_DAYS=7`, completions in the 7–30 day band
 * are already deleted while failures in that band would still be swept into
 * the streak, and #4620 survives in miniature. Deriving it costs one `case`
 * statement and cannot drift.
 *
 * Two guards on the expansion, because it is spliced into SQL:
 *
 *  - **Non-numeric → 30.** The value is `case`-matched against `*[!0-9]*` and
 *    replaced with the documented default. This is what makes the splice safe
 *    rather than an injection point; it is also the pruner's own behaviour, in
 *    the sense that `make_interval(days => garbage)` fails there too and the
 *    prune silently no-ops.
 *  - **Clamped to ≥ 1 day.** `RETENTION_DAYS=0` prunes every completion on
 *    sight; a 0-day floor would be `now()`, which would empty the candidate
 *    list and DELETE this signal. One day is the tightest floor that still
 *    lets a genuinely live streak register.
 *
 * ### What the floor closes, and what it does not
 *
 * It closes the unbounded case: a pair whose failures are ALL older than the
 * horizon drops out of the candidate list entirely (no row, streak 0), so a
 * retired pair cannot page for ever off failures whose matching completions
 * were swept.
 *
 * It does NOT make a pre-sweep streak invisible while those failures are still
 * inside the window. A pair that last succeeded 35 days ago and failed 20 days
 * ago still reports 20-day-old failures with no visible completion, and the
 * evaluator's null arm still pages on it. That page is now BOUNDED — it clears
 * when the failures themselves cross the horizon — instead of permanent, which
 * is the whole of the defect. Making it invisible sooner would need the
 * evaluator to distinguish "swept success" from "never succeeded", and the two
 * are indistinguishable by construction once the row is gone.
 */
export function bankConsolidationQuery(retentionDaysSql: string): string {
  return `SELECT 'S|'||a.bank_id||'|'||a.operation_type||'|'||count(*)||'|'||extract(epoch from (now()-max(a.created_at)))::bigint
          ||'|'||coalesce(extract(epoch from (now()-(SELECT max(c.created_at) FROM async_operations c
                                                      WHERE c.bank_id = a.bank_id
                                                        AND c.operation_type = a.operation_type
                                                        AND c.status = 'completed')))::bigint::text, '')
     FROM async_operations a
    WHERE a.status = 'failed'
      AND a.created_at > greatest(coalesce((SELECT max(b.created_at) FROM async_operations b
                                             WHERE b.bank_id = a.bank_id
                                               AND b.operation_type = a.operation_type
                                               AND b.status = 'completed'), '-infinity'::timestamptz),
                                  now() - make_interval(days => ${retentionDaysSql}))
    GROUP BY a.bank_id, a.operation_type
    UNION ALL
   SELECT 'P|'||m.bank_id||'|'||count(*) FILTER (WHERE m.consolidated_at IS NULL AND m.fact_type IN ('experience','world'))
     FROM memory_units m
    GROUP BY m.bank_id`;
}

/**
 * Resolve `$RD`, the retention horizon in days, from the SAME environment
 * variable the pruner reads — see {@link bankConsolidationQuery} for why it is
 * derived rather than hard-coded, and for the two guards below.
 *
 * Exported so its behaviour can be tested by running it, rather than by
 * reading it: it is three lines of `sh` and the interesting cases (garbage, 0,
 * unset) are exactly the ones a static assertion would get wrong.
 */
export const RETENTION_DAYS_SH = `RD="\${SWITCHROOM_HINDSIGHT_RETENTION_DAYS:-30}"
case "$RD" in ''|*[!0-9]*) RD=30 ;; esac
[ "$RD" -ge 1 ] 2>/dev/null || RD=1`;

export const BANK_CONSOLIDATION_SH = `${PSQL_BOOTSTRAP_SH}
${RETENTION_DAYS_SH}
PGPASSWORD="$PW" "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -tAc \\
  "${bankConsolidationQuery("$RD")}"
`;

/**
 * The HNSW nearest-neighbour canary.
 *
 * ### Why a NN probe is the only option
 *
 * `amcheck` has no HNSW support, so there is no verifier for these indexes
 * short of scanning one. A corrupt index raises `different vector dimensions
 * 384 and 0` when the scan reaches the damaged node — and nothing else in the
 * system notices, because `memory_units.embedding` is `vector(384)` and the
 * table itself is clean (0 rows with `vector_dims(embedding) <> 384`).
 *
 * ### THE GOTCHA — `count(nn)`, never `count(*)`
 *
 * The probe aggregates over the correlated subquery's RESULT. Aggregate over
 * `*` instead and the planner elides the subquery entirely: the probe then
 * costs nothing, touches no index, raises nothing, and PASSES. Verified live
 * on the production database, same statement both ways:
 *
 *   count(nn) → `Index Scan using idx_mu_emb_obsv_81cef5f6a42e4b4d`,
 *               `SubPlan 1`, 9.6 ms
 *   count(*)  → bare `Aggregate`, no `SubPlan`, no index scan, 0.8 ms
 *
 * `probeVectorIndexes` re-asserts this on the SQL text before running it, so
 * the elision cannot be reintroduced by an edit that still type-checks.
 *
 * ### Why the predicate is spliced verbatim
 *
 * The per-bank partial indexes are `WHERE fact_type = '…' AND bank_id = '…'`.
 * The planner will only choose a partial index when it can prove the
 * predicate, which it cannot do against a correlated column reference — the
 * first draft of this probe correlated `m2.bank_id = s.bank_id` and the
 * planner silently fell back to the single global index, leaving all 88
 * partial ones unprobed. Splicing `pg_get_expr(indpred, indrelid)` — the
 * predicate Postgres itself stores — is what makes the probe hit the index it
 * names. It is not user input: it comes out of the catalog.
 *
 * ### Why a DO block
 *
 * One subtransaction per index, each with its own `EXCEPTION` handler, so a
 * corrupt index is REPORTED BY NAME and the sweep continues to the next one
 * instead of aborting at the first fault. The result comes back as a single
 * `RAISE NOTICE` (psql writes notices to stderr, so the call redirects
 * `2>&1`) because a `DO` block cannot return rows.
 *
 * Prints one `VECIDX|<probed>|<corrupt_count>|<name=err;…>` line.
 */
function vectorIndexSh(sampleRows: number): string {
  // The only caller-controlled value that reaches the SQL text. Clamped to a
  // positive integer so it can only ever be a `LIMIT` operand — the index
  // names and predicates around it come from the catalog, not from input.
  const limit = Math.max(1, Math.floor(Number.isFinite(sampleRows) ? sampleRows : 1));
  return `${PSQL_BOOTSTRAP_SH}
PGPASSWORD="$PW" PGOPTIONS='-c client_min_messages=notice' \\
  "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -tAc "
DO \\$\\$
DECLARE r record; bad text := ''; n int := 0; probed int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS idx,
           i.indrelid::regclass::text AS tbl,
           coalesce(pg_get_expr(i.indpred, i.indrelid), 'true') AS pred
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
     WHERE am.amname = 'hnsw'
     ORDER BY c.relname
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT count(nn) FROM (SELECT (SELECT m2.ctid FROM %1\\$s m2 WHERE %2\\$s ORDER BY m2.embedding <=> s.embedding LIMIT 1) AS nn FROM (SELECT embedding FROM %1\\$s s0 WHERE %2\\$s AND embedding IS NOT NULL LIMIT %3\\$s) s) t',
        r.tbl, r.pred, ${limit});
      probed := probed + 1;
    EXCEPTION WHEN others THEN
      n := n + 1;
      -- Both delimiters are stripped from the message BEFORE it is appended.
      -- ';' separates entries and a newline would split the NOTICE line, so an
      -- SQLERRM containing either would desynchronise the parsed list from n,
      -- and probeVectorIndexes rejects a mismatched block as unreadable —
      -- turning a real corruption into a silent no-data.
      bad := bad || r.idx || '=' || translate(SQLERRM, ';' || chr(10) || chr(13), ',  ') || ';';
    END;
  END LOOP;
  RAISE NOTICE 'VECIDX|%|%|%', probed, n, bad;
END \\$\\$;" 2>&1
`;
}

/**
 * Read the `async_operations` backlog, or null when it cannot be read.
 *
 * **Soft-fails on purpose**, unlike the three probes above. Those three throw
 * because their absence means the watchdog cannot see the thing it exists to
 * watch. This one needs a psql client and a pg descriptor that legitimately
 * do not exist off-host (CI, a dev laptop), so throwing would make the whole
 * watchdog unrunnable anywhere but production. Null degrades exactly ONE
 * signal to `no-data` — visibly, in the printed output — and the container
 * being down is already covered by the `container` signal.
 */
export function probeConsolidationQueue(
  container: string = DEFAULT_CONTAINER,
  run: Runner = defaultRunner,
): ConsolidationSample | null {
  const r = run("docker", ["exec", container, "sh", "-c", CONSOLIDATION_QUEUE_SH]);
  if (r.status !== 0) return null;
  const [pendingRaw, ageRaw] = r.stdout.trim().split("|");
  const pending = Number(pendingRaw);
  const oldestAgeS = Number(ageRaw);
  if (!Number.isFinite(pending) || !Number.isFinite(oldestAgeS)) return null;
  if (pending < 0 || oldestAgeS < 0) return null;
  return { pending, oldestAgeS };
}

/**
 * Read the per-bank consolidation block, or null when it cannot be read.
 *
 * Soft-fails for the same reason `probeConsolidationQueue` does: psql and the
 * pg descriptor legitimately do not exist off-host, and throwing would make
 * the whole watchdog unrunnable in CI or on a laptop. Null degrades exactly
 * the two per-bank signals to `no-data` — inert, visible, never a pass.
 *
 * A single unparseable LINE is skipped rather than nulling the block: a
 * bank id containing a `|` would otherwise take the whole signal down. A
 * block with NO parseable line at all is null, because "the query returned
 * nothing we understood" is not the same as "the fleet is clean".
 */
export function probeBankConsolidation(
  container: string = DEFAULT_CONTAINER,
  run: Runner = defaultRunner,
): BankSample | null {
  const r = run("docker", ["exec", container, "sh", "-c", BANK_CONSOLIDATION_SH]);
  if (r.status !== 0) return null;
  const streaks: BankFailureStreak[] = [];
  const pending: BankPendingConsolidation[] = [];
  let parsedAny = false;
  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const f = t.split("|");
    // Exactly 6 fields is the current row; exactly 5 is the pre-#4618 shape,
    // accepted for the same reason a garbled sixth field does not drop the
    // row — a dropped streak reads as HEALTH. Any OTHER arity is a row we did
    // not understand (a bank id containing a `|`, a changed query) and is
    // skipped, so the arity is pinned at both ends rather than open-ended.
    if (f[0] === "S" && (f.length === 6 || f.length === 5)) {
      const streak = Number(f[3]);
      const age = Number(f[4]);
      if (!Number.isFinite(streak) || !Number.isFinite(age) || streak < 0 || age < 0) continue;
      // Three states, and the tie-break matters more than it looks. EMPTY is
      // a real reading — the pair has never completed an op. A GARBLED value
      // is not: it becomes `undefined`, on which the evaluator's sparse arm
      // abstains, so the STREAK still counts on the pre-existing recency
      // behaviour. Dropping the whole row instead would delete a streak of 19
      // from the sample, and a missing streak reads as HEALTH — the exact
      // failure mode this signal exists to end, and the same tie-break
      // `normalizeBankSample` makes for a row that lacks the field.
      let lastCompletedAgeS: number | null | undefined;
      if (f.length === 5) {
        lastCompletedAgeS = undefined; // pre-#4618 row: unknown, not "never"
      } else if (f[5] === "") {
        lastCompletedAgeS = null;
      } else {
        const completedAge = Number(f[5]);
        if (Number.isFinite(completedAge) && completedAge >= 0) lastCompletedAgeS = completedAge;
      }
      streaks.push({
        bank: f[1],
        operationType: f[2],
        streak,
        newestFailureAgeS: age,
        ...(lastCompletedAgeS !== undefined ? { lastCompletedAgeS } : {}),
      });
      parsedAny = true;
    } else if (f[0] === "P" && f.length === 3) {
      const n = Number(f[2]);
      if (!Number.isFinite(n) || n < 0) continue;
      pending.push({ bank: f[1], pending: n });
      parsedAny = true;
    }
  }
  // A live fleet always has at least one bank, so zero parseable rows means
  // the query did not run the way we think it did — report blindness, not
  // health.
  if (!parsedAny) return null;
  return { streaks, pending };
}

/**
 * Scan every HNSW index with a nearest-neighbour probe. Null when it could
 * not run — soft-fail, exactly like the two probes above.
 *
 * The `count(nn)` assertion below is a DETERMINISTIC guard, not a comment: an
 * edit that switches the aggregate back to `count(*)` makes the planner elide
 * the correlated subquery, and the probe would then pass on a corrupt index
 * forever with no observable difference. Refusing to run at all is loud;
 * running and silently checking nothing is the failure mode this whole PR
 * exists to remove.
 */
export function probeVectorIndexes(
  container: string = DEFAULT_CONTAINER,
  run: Runner = defaultRunner,
  sampleRows: number = VECTOR_INDEX_SAMPLE_ROWS,
): VectorIndexSample | null {
  const sh = vectorIndexSh(sampleRows);
  if (!sh.includes("count(nn)")) return null;
  const r = run("docker", ["exec", container, "sh", "-c", sh]);
  if (r.status !== 0) return null;
  const line = r.stdout.split("\n").find((l) => l.includes("VECIDX|"));
  if (line === undefined) return null;
  const f = line.slice(line.indexOf("VECIDX|")).trim().split("|");
  if (f.length < 4) return null;
  const probed = Number(f[1]);
  const count = Number(f[2]);
  if (!Number.isFinite(probed) || !Number.isFinite(count) || probed < 0 || count < 0) return null;
  // Re-join the tail: an SQLERRM can itself contain `|`.
  const corrupt = f
    .slice(3)
    .join("|")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  // The reported count and the parsed list must agree, or we do not know what
  // we are looking at. Trust the COUNT — it is what the database said — and
  // treat a mismatch as unreadable rather than under-reporting corruption.
  if (corrupt.length !== count) return null;
  return { probed, corrupt };
}

/** Run every probe into one sample. A core-probe failure throws a ProbeError. */
export async function probeOnce(
  opts: ProbeOptions = {},
): Promise<{ sample: Sample; spool: SpoolDepth; recall: RecallStats }> {
  const now = opts.now ?? Date.now;
  const ts = now();
  // Only an over-cap body degrades. Every OTHER metrics failure — unreachable,
  // non-200, unparseable — still throws and still blinds the tick, because
  // those genuinely mean the watchdog cannot see hindsight.
  let metrics: MetricsSample | null;
  try {
    metrics = await probeMetrics(opts.metricsUrl, opts.fetchImpl);
  } catch (e) {
    if (!(e instanceof MetricsTooLargeError)) throw e;
    metrics = null;
  }
  const container = probeContainer(opts.container, opts.run);
  const spool = probeSpool(opts.agentsDir);
  // `probeSpool` above already threw if the agents dir is unreadable, so this
  // cannot be reached with a bad dir today. Wrapped anyway: if the two probes
  // are ever reordered, an unreadable dir must still surface as a probe
  // failure rather than as a `recall` block full of confident zeroes.
  let recall: RecallStats;
  try {
    recall = probeRecallLogs(resolveAgentsDir(opts.agentsDir), ts);
  } catch (e) {
    throw new ProbeError(`reading recall logs: ${(e as Error).message}`, "spool");
  }
  const consolidation = probeConsolidationQueue(opts.container, opts.run);
  const banks = probeBankConsolidation(opts.container, opts.run);
  const vectorIndex = probeVectorIndexes(opts.container, opts.run);
  return {
    sample: {
      ts,
      // Absent — not zero — when the exposition could not be buffered. A zero
      // here would read as "no retains and no failures", which passes.
      retainOk: metrics?.retain.ok,
      retainFail: metrics?.retain.fail,
      llmOk: metrics?.llm?.ok,
      llmFail: metrics?.llm?.fail,
      pending: spool.pending,
      dead: spool.dead,
      evicted: spool.evicted,
      drops: spool.drops,
      duplicates: spool.duplicates,
      restartCount: container.restartCount,
      startedAt: container.startedAt,
      health: container.health,
      recall,
      consolidation,
      banks,
      vectorIndex,
    },
    spool,
    recall,
  };
}
