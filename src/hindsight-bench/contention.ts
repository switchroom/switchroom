/**
 * The synthetic contention generator (#4475 item 5, AC4).
 *
 * ## What it reproduces, and what it deliberately does not
 *
 * Epic #4474 attributes a ~9.1 s/call recall spike on 2026-08-06 to a
 * retain/consolidation LLM write storm saturating the box. That attribution is
 * a **recorded claim, not a measurement** — the container logs for the window
 * rotated out before anyone could replay them, and the epic says so explicitly
 * under "Recorded claims not re-verified this pass". So this module reproduces
 * the contention SYNTHETICALLY and never cites the incident as evidence.
 *
 * It reproduces the two box-level mechanisms that a retain/consolidation storm
 * imposes on the recall read path:
 *
 *  - **Buffer-pool eviction.** The epic's decisive axis is working-set-vs-pool
 *    arithmetic. `read` churns `memory_units` pages through `shared_buffers`
 *    with randomised block sampling, which is what actually pushes the recall
 *    working set out of cache.
 *  - **Write pressure.** `write` adds insert/update/delete cycles that generate
 *    WAL, dirty buffers, checkpoint and autovacuum work — the resource shape a
 *    retain storm imposes — against a table this harness owns outright.
 *
 * It does **not** reproduce the LLM half of a consolidation storm, and no
 * amount of tuning here will. Driving real model calls to manufacture load
 * would burn the operator's subscription quota to produce a benchmark number,
 * which the repo's subscription-honest constraint forbids
 * (`CLAUDE.md` § "Hard constraint"). A result measured under this generator is
 * therefore a LOWER bound on a real storm's effect, and the report says so.
 *
 * ## Blast radius
 *
 * This runs against the **live production database**. `read` is SELECT-only but
 * still evicts other queries' pages, so every agent's recall gets slower while
 * it runs. `write` additionally sustains WAL and autovacuum load. Defaults are
 * deliberately conservative (2 workers, 2 % block sample) and every knob is a
 * flag. Two independent stops bound an orphan: an absolute in-SQL deadline
 * computed at start, and a `pg_terminate_backend` sweep keyed on a dedicated
 * `application_name`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_CONTAINER, sql, type Runner, type SqlOptions } from "./db.js";
import type { ContentionProfile } from "./types.js";

/**
 * `application_name` every contention backend carries.
 *
 * Load-bearing, not cosmetic: it is what `stop()` uses to terminate backends
 * deterministically, and what an operator greps for in `pg_stat_activity` if
 * this harness is ever killed mid-run. Never reuse it for a measurement session.
 */
export const CONTENTION_APP_NAME = "hindsight-bench-contention";

/** The harness-owned scratch table. Never a bank table, never `memory_units`. */
export const SCRATCH_TABLE = "hindsight_bench_scratch";

export interface ContentionOptions {
  profile: ContentionProfile;
  /** Concurrent load backends. Default 2 — this runs against production. */
  workers: number;
  /**
   * `TABLESAMPLE SYSTEM (pct)` block-sample percentage for the churn scan.
   * Higher evicts more per iteration. Clamped to [0.1, 100].
   */
  scanPct: number;
  /**
   * Absolute upper bound, in seconds, on how long a load backend may run
   * measured from `start()`. The SECOND of the two orphan guards: even if this
   * process is SIGKILLed and never runs `stop()`, every backend exits by then.
   */
  maxSeconds: number;
  container?: string;
  run?: Runner;
}

export const DEFAULT_CONTENTION: Omit<ContentionOptions, "profile"> = {
  workers: 2,
  scanPct: 2,
  maxSeconds: 900,
};

/** Clamp to a positive finite integer — the only caller value reaching SQL. */
function clampInt(v: number, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function clampFloat(v: number, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The SQL one load backend runs.
 *
 * Exported for the unit tests, which assert the two properties that make this
 * generator safe rather than merely present: it must carry an absolute
 * `clock_timestamp()` deadline, and the `write` arm must never name
 * `memory_units` or `reflections` as a write target.
 */
export function contentionSql(profile: ContentionProfile, scanPct: number, maxSeconds: number): string {
  const pct = clampFloat(scanPct, 0.1, 100, DEFAULT_CONTENTION.scanPct);
  const secs = clampInt(maxSeconds, 1, 3600, DEFAULT_CONTENTION.maxSeconds);
  // `sum(length(m.text))` rather than `count(*)`: the same elision trap
  // `hindsight-watch/probe.ts` documents for its HNSW canary. An aggregate the
  // planner can satisfy without visiting the tuples churns no pages, and the
  // generator would then silently do nothing while looking busy.
  // The alias goes BEFORE `TABLESAMPLE`, not after: `FROM t TABLESAMPLE SYSTEM
  // (n) alias` is a syntax error, and because every worker's stderr used to be
  // discarded, the original ordering made this generator a silent no-op — it
  // reported "N backends" while all N had already died. `contentionSql`'s test
  // now pins the ordering, and `startContention` proves the backends exist.
  const churn = `PERFORM sum(length(m.text)) FROM memory_units m TABLESAMPLE SYSTEM (${pct});`;
  const writes =
    profile === "write"
      ? `
    INSERT INTO ${SCRATCH_TABLE} (payload)
      SELECT repeat('x', 2048) FROM generate_series(1, 2000);
    UPDATE ${SCRATCH_TABLE} SET payload = payload || 'y' WHERE id % 3 = 0;
    DELETE FROM ${SCRATCH_TABLE}
     WHERE id < (SELECT coalesce(max(id), 0) - 20000 FROM ${SCRATCH_TABLE});`
      : "";
  return `
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '${secs} seconds';
BEGIN
  WHILE clock_timestamp() < deadline LOOP
    ${churn}${writes}
  END LOOP;
END $$;
`;
}

/**
 * A running load. `stop()` is idempotent and safe to call from a `finally`.
 */
export interface ContentionHandle {
  profile: ContentionProfile;
  workers: number;
  /**
   * Backends observed in `pg_stat_activity` carrying `CONTENTION_APP_NAME`
   * after start — the load that DEMONSTRABLY exists, not the load that was
   * requested. `off` reports 0.
   */
  liveBackends: number;
  stop: () => void;
}

/** An inert handle, so callers never branch on null. */
export function noContention(): ContentionHandle {
  return { profile: "off", workers: 0, liveBackends: 0, stop: () => {} };
}

/**
 * How many load backends are actually attached right now.
 *
 * The generator's honesty check. A worker that dies on a SQL error exits
 * instantly and silently — which is exactly what happened while the churn
 * statement carried a misplaced `TABLESAMPLE` alias: the harness printed
 * "contention running with 8 backend(s)" for a run under no load at all, and
 * the resulting numbers said contention does nothing. Counting the backends is
 * the only claim about load that is not self-reported.
 */
export function countContentionBackends(opts: SqlOptions = {}): number {
  const rows = sql(
    `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${CONTENTION_APP_NAME}';`,
    opts,
  );
  const n = Number(rows[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Same bootstrap as `db.ts`, but exec'd asynchronously and tagged with
 * `CONTENTION_APP_NAME` so `stop()` can find the backends. Writable is decided
 * by the profile: `read` keeps the read-only clamp, so a bug in the churn SQL
 * physically cannot mutate anything.
 */
function workerSh(readOnly: boolean): string {
  return `
set -e
B="$(ls -d /home/hindsight/.pg0/installation/*/bin 2>/dev/null | head -1)"
PSQL="$(command -v psql 2>/dev/null || echo "\${B:-/nonexistent}/psql")"
[ -x "$PSQL" ] || exit 3
D=/home/hindsight/.pg0/instances/hindsight/instance.json
[ -r "$D" ] || exit 3
eval "$(python3 -c 'import json,shlex,sys
d=json.load(open(sys.argv[1]))
q=lambda k,dflt: shlex.quote(str(d.get(k) or dflt))
print("U=%s DB=%s P=%s PW=%s"%(q("username","hindsight"),q("database","hindsight"),q("port",5432),q("password","")))' "$D")"
PGPASSWORD="$PW" PGAPPNAME='${CONTENTION_APP_NAME}' \\
  PGOPTIONS='-c default_transaction_read_only=${readOnly ? "on" : "off"}' \\
  "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -q -v ON_ERROR_STOP=1 -f - >/dev/null
`;
}

/** Raised when the load generator cannot be shown to be running. */
export class ContentionError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start the load and PROVE it started.
 *
 * The backends run until `stop()` or the in-SQL deadline, whichever comes
 * first. Before returning, this polls `pg_stat_activity` until at least one
 * backend carrying `CONTENTION_APP_NAME` is attached, and throws if none ever
 * appears — carrying whatever the workers wrote to stderr.
 *
 * That check is not defensive padding; it is the difference between a
 * contention measurement and a fiction. A worker whose SQL fails to parse exits
 * in milliseconds, so without it the harness reports "running with N
 * backend(s)", measures an idle system, and produces a table that says
 * contention has no effect.
 *
 * `write` creates the scratch table up front (and only then) so a `read` run
 * cannot leave a table behind on a production database.
 */
export async function startContention(opts: ContentionOptions): Promise<ContentionHandle> {
  if (opts.profile === "off") return noContention();
  const container = opts.container ?? DEFAULT_CONTAINER;
  const sqlOpts: SqlOptions = { container, run: opts.run };
  const workers = clampInt(opts.workers, 1, 64, DEFAULT_CONTENTION.workers);
  const readOnly = opts.profile !== "write";

  if (opts.profile === "write") {
    sql(
      `CREATE TABLE IF NOT EXISTS ${SCRATCH_TABLE} (id bigserial PRIMARY KEY, payload text);
       TRUNCATE ${SCRATCH_TABLE};`,
      { ...sqlOpts, writable: true },
    );
  }

  const script = contentionSql(opts.profile, opts.scanPct, opts.maxSeconds);
  const children: ChildProcess[] = [];
  let workerStderr = "";
  for (let i = 0; i < workers; i++) {
    const child = spawn("docker", ["exec", "-i", container, "sh", "-c", workerSh(readOnly)], {
      // stderr is PIPED, never discarded: it is the only place a worker's SQL
      // error can surface, and discarding it is what let a broken generator
      // look healthy.
      stdio: ["pipe", "ignore", "pipe"],
      detached: false,
    });
    child.stdin?.end(script);
    child.stderr?.on("data", (d: Buffer) => {
      if (workerStderr.length < 4000) workerStderr += d.toString();
    });
    // A worker that dies is a measurement bug, not a crash: the liveness check
    // below is what turns it into a loud failure.
    child.on("error", (e) => {
      workerStderr += `${e.message}\n`;
    });
    children.push(child);
  }

  let stopped = false;
  const killAll = (): void => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };

  // Poll rather than sleep-once: backend registration is not instant, and a
  // fixed sleep would either be flaky or waste time on every contended run.
  let liveBackends = 0;
  for (let attempt = 0; attempt < 10 && liveBackends === 0; attempt++) {
    await sleep(500);
    liveBackends = countContentionBackends(sqlOpts);
  }
  if (liveBackends === 0) {
    killAll();
    throw new ContentionError(
      `contention profile "${opts.profile}" started ${workers} worker(s) but none attached to ` +
        `PostgreSQL within 5s — the measurement would be of an IDLE system. ` +
        `worker stderr: ${workerStderr.trim() || "(none)"}`,
    );
  }

  return {
    profile: opts.profile,
    workers,
    liveBackends,
    stop: () => {
      if (stopped) return;
      stopped = true;
      killAll();
      // THE authoritative stop. Killing the `docker exec` client does not
      // reliably kill the server-side backend, so an orphaned churn loop could
      // otherwise keep hammering production after the harness exits. Keyed on
      // `application_name` so it can only ever hit this harness's own load
      // backends, never an agent's recall and never the API's pool.
      try {
        sql(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = '${CONTENTION_APP_NAME}' AND pid <> pg_backend_pid();`,
          sqlOpts,
        );
      } catch {
        // Best effort: the in-SQL deadline is the backstop.
      }
      if (opts.profile === "write") {
        try {
          sql(`DROP TABLE IF EXISTS ${SCRATCH_TABLE};`, { ...sqlOpts, writable: true });
        } catch {
          // Leaving the scratch table behind is untidy, not dangerous — it is
          // outside every bank. The next `write` run TRUNCATEs it.
        }
      }
    },
  };
}
