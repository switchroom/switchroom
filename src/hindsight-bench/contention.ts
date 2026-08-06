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
  const churn = `PERFORM sum(length(m.text)) FROM memory_units TABLESAMPLE SYSTEM (${pct}) m;`;
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
  stop: () => void;
}

/** An inert handle, so callers never branch on null. */
export function noContention(): ContentionHandle {
  return { profile: "off", workers: 0, stop: () => {} };
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
  "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -q -v ON_ERROR_STOP=1 -f - >/dev/null 2>&1
`;
}

/**
 * Start the load. Returns immediately; the backends run until `stop()` or the
 * in-SQL deadline, whichever comes first.
 *
 * `write` creates the scratch table up front (and only then) so a `read` run
 * cannot leave a table behind on a production database.
 */
export function startContention(opts: ContentionOptions): ContentionHandle {
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
  for (let i = 0; i < workers; i++) {
    const child = spawn("docker", ["exec", "-i", container, "sh", "-c", workerSh(readOnly)], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: false,
    });
    child.stdin?.end(script);
    // A load generator that dies is a measurement bug, not a crash — the run
    // still produces a result, and `stop()` reports how many survived.
    child.on("error", () => {});
    children.push(child);
  }

  let stopped = false;
  return {
    profile: opts.profile,
    workers,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch {
          // Already gone. Nothing to do; the terminate sweep below is the
          // authoritative stop anyway.
        }
      }
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
