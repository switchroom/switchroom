/**
 * The harness's read-only window onto the Hindsight database.
 *
 * Two jobs: capture the `DbState` block that makes a result self-describing
 * (#4475 item 7), and enforce the AC5 read-only gate.
 *
 * **Why `docker exec` and not a pg client.** Same reason
 * `hindsight-watch/probe.ts` does it: the embedded pg0 instance listens on a
 * unix socket inside the container and its credentials live in a descriptor
 * only the container can read. Copying the descriptor out would put a live
 * database password on the host filesystem. The bootstrap below is deliberately
 * a near-copy of `probe.ts`'s `PSQL_BOOTSTRAP_SH` so the watchdog and the
 * harness cannot end up reading two different databases.
 *
 * **Why SQL arrives on stdin.** `psql -f -` sidesteps the three-layer quoting
 * (`docker exec` argv → `sh -c` → psql `-c`) that makes an inline statement a
 * source of silent truncation. Nothing here interpolates caller input into SQL
 * at all: the only variable that reaches a statement is a clamped integer.
 */

import { spawnSync } from "node:child_process";
import type { DbState, IndexFact } from "./types.js";

/** Default container, matching `hindsight-watch/thresholds.ts`. */
export const DEFAULT_CONTAINER = "switchroom-hindsight";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process runner, so every path here is unit-testable. */
export type Runner = (cmd: string, args: string[], stdin?: string) => RunResult;

export const defaultRunner: Runner = (cmd, args, stdin) => {
  const r = spawnSync(cmd, args, {
    stdio: "pipe",
    input: stdin,
    timeout: 120_000,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Locate psql + the pg0 instance descriptor, then exec psql reading SQL from
 * stdin. Verbatim in shape from `hindsight-watch/probe.ts:PSQL_BOOTSTRAP_SH`;
 * the password never leaves the container.
 *
 * `$RO` is spliced by the caller as either `on` or `off` — it is never derived
 * from user input, and `sqlSession` is the only function that writes it.
 */
function bootstrapSh(readOnly: boolean): string {
  return `
set -e
B="$(ls -d /home/hindsight/.pg0/installation/*/bin 2>/dev/null | head -1)"
PSQL="$(command -v psql 2>/dev/null || echo "\${B:-/nonexistent}/psql")"
[ -x "$PSQL" ] || { echo "hindsight-bench: no psql in container" >&2; exit 3; }
D=/home/hindsight/.pg0/instances/hindsight/instance.json
[ -r "$D" ] || { echo "hindsight-bench: no pg0 instance descriptor" >&2; exit 3; }
eval "$(python3 -c 'import json,shlex,sys
d=json.load(open(sys.argv[1]))
q=lambda k,dflt: shlex.quote(str(d.get(k) or dflt))
print("U=%s DB=%s P=%s PW=%s"%(q("username","hindsight"),q("database","hindsight"),q("port",5432),q("password","")))' "$D")"
[ -n "$PW" ] || { echo "hindsight-bench: pg0 descriptor carries no password" >&2; exit 3; }
PGPASSWORD="$PW" PGOPTIONS='-c default_transaction_read_only=${readOnly ? "on" : "off"}' \\
  "$PSQL" -U "$U" -h /tmp -p "$P" -d "$DB" -v ON_ERROR_STOP=1 -tAF'|' -f -
`;
}

export interface SqlOptions {
  container?: string;
  run?: Runner;
  /**
   * Lift the read-only clamp. ONLY the contention write generator passes true,
   * and only after `assertReadOnlyOrWritesAllowed` has seen `--allow-writes`.
   */
  writable?: boolean;
}

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}

/**
 * Run one SQL script inside the container and return raw `-tA` rows.
 *
 * Fields are `|`-separated (psql `-F'|'`), which is why every query below
 * selects scalars or already-`|`-free text. Throws on any non-zero exit: this
 * is a measurement instrument, and a silently-empty catalog read would produce
 * a result file that confidently describes the wrong database.
 */
export function sql(script: string, opts: SqlOptions = {}): string[] {
  const run = opts.run ?? defaultRunner;
  const container = opts.container ?? DEFAULT_CONTAINER;
  // Read-only unless the caller explicitly opted out. Defaulting the OTHER way
  // (or, as an earlier revision did, passing `writable` straight into a
  // `readOnly` parameter) silently unclamps every session and makes the AC5
  // gate vacuous — which is what `db.test.ts` "clamps the session read-only
  // unless explicitly writable" exists to catch.
  const r = run("docker", ["exec", "-i", container, "sh", "-c", bootstrapSh(opts.writable !== true)], script);
  if (r.status !== 0) {
    throw new SqlError(`psql in ${container} exited ${r.status}: ${r.stderr.trim() || "no stderr"}`);
  }
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * AC5: refuse to run unless the harness's own database sessions are provably
 * read-only, or the operator explicitly authorised writes.
 *
 * The production connection is of course writable — it is the application's own
 * superuser role — so a literal "is this role able to write?" check would refuse
 * every run and the harness would be unusable. What is actually assertable, and
 * what actually protects the data, is that the SESSION the harness holds cannot
 * write: `bootstrapSh` sets `default_transaction_read_only=on` via `PGOPTIONS`,
 * and this function proves it took effect by (a) reading back
 * `transaction_read_only` and (b) attempting a real write and requiring it to
 * be rejected. A clamp that is set but not enforced is exactly the failure mode
 * a "we set the flag" check would miss.
 *
 * Under `--allow-writes` the check still RUNS and still reports, but a writable
 * session is permitted — because contention profile `write` needs one for its
 * scratch table.
 */
export function assertReadOnlyOrWritesAllowed(allowWrites: boolean, opts: SqlOptions = {}): void {
  // `CREATE TEMP TABLE` is the probe because PostgreSQL rejects it outright in
  // a read-only transaction (`cannot execute CREATE TABLE in a read-only
  // transaction` — verified live against the fleet's PG 18 instance both ways),
  // while succeeding harmlessly in a writable one: a temp relation dies with
  // the session and touches no bank. A `SHOW transaction_read_only` alone would
  // only prove the flag was SET, not that the server enforces it.
  //
  // The `DO`/`EXCEPTION` wrapper exists because `psql -v ON_ERROR_STOP=1` would
  // otherwise abort the script on the read-only rejection, which is the
  // expected outcome of the check.
  const rows = sql(
    `DO $$
     BEGIN
       CREATE TEMP TABLE hindsight_bench_ro_probe(x int);
     EXCEPTION WHEN others THEN
       NULL;
     END $$;
     SELECT current_setting('transaction_read_only') || '|' ||
            (to_regclass('pg_temp.hindsight_bench_ro_probe') IS NOT NULL)::text;`,
    opts,
  );
  // psql echoes the `DO` command tag on stdout, so the verdict is the LAST row.
  const [declared, landed] = (rows[rows.length - 1] ?? "").split("|");
  const declaredReadOnly = declared === "on";
  const writeLanded = landed === "t";
  const writable = !declaredReadOnly || writeLanded;
  if (writable && !allowWrites) {
    throw new SqlError(
      "refusing to run: the harness's database session is WRITABLE " +
        `(transaction_read_only=${declared ?? "?"}, temp-table write ${writeLanded ? "succeeded" : "failed"}). ` +
        "This harness measures a read path and must not be able to mutate a bank. " +
        "Pass --allow-writes only if you genuinely intend a writable session " +
        "(contention profile `write` needs one for its own scratch table).",
    );
  }
}

/** `pg_stat_reset()`. Never a side effect of a default run — see the CLI flag. */
export function resetStats(opts: SqlOptions = {}): void {
  // pg_stat_reset() is a write to the stats collector, not to any relation, but
  // it is still refused inside a read-only transaction, so this one call runs
  // with the clamp lifted. It is reachable ONLY from `--reset-stats`.
  sql("SELECT pg_stat_reset();", { ...opts, writable: true });
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Capture everything the result file needs to describe itself.
 *
 * Deliberately ONE round trip per logical block rather than one big query: the
 * blocks have different row shapes, and `-tA` gives no way to tell them apart
 * without tagging, which is how `probe.ts`'s two-section query earns its
 * complexity. Here the reads are cheap (catalog + one grouped count) and run
 * once per invocation, so separate calls are the simpler correct thing.
 */
export function readDbState(opts: SqlOptions = {}): DbState {
  const settings = sql(
    `SELECT
       (SELECT setting::bigint * 8192 FROM pg_settings WHERE name = 'shared_buffers'),
       (SELECT setting::bigint * 8192 FROM pg_settings WHERE name = 'effective_cache_size'),
       (SELECT setting FROM pg_settings WHERE name = 'hnsw.ef_search'),
       pg_total_relation_size('memory_units'),
       pg_table_size('memory_units'),
       pg_indexes_size('memory_units'),
       (SELECT stats_reset::text FROM pg_stat_database WHERE datname = current_database()),
       (SELECT CASE WHEN heap_blks_hit + heap_blks_read = 0 THEN NULL
                    ELSE heap_blks_hit::float8 / (heap_blks_hit + heap_blks_read) END
          FROM pg_statio_user_tables WHERE relname = 'memory_units'),
       version();`,
    opts,
  );
  const f = (settings[0] ?? "").split("|");
  if (f.length < 9) {
    throw new SqlError(`unexpected settings row shape: ${JSON.stringify(settings[0] ?? "")}`);
  }

  const bankRows = sql(`SELECT bank_id, count(*) FROM memory_units GROUP BY bank_id ORDER BY 2 DESC;`, opts)
    .map((l) => {
      const [bank, rows] = l.split("|");
      return { bank: bank ?? "", rows: num(rows) };
    })
    .filter((b) => b.bank !== "" && Number.isFinite(b.rows));

  const largestIndexes: IndexFact[] = sql(
    `SELECT c.relname, pg_relation_size(c.oid), coalesce(s.idx_scan, 0)
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
      WHERE i.indrelid = 'memory_units'::regclass
      ORDER BY pg_relation_size(c.oid) DESC
      LIMIT 8;`,
    opts,
  )
    .map((l) => {
      const [name, bytes, scans] = l.split("|");
      return { name: name ?? "", bytes: num(bytes), scans: num(scans) };
    })
    .filter((x) => x.name !== "");

  const efRaw = f[2] ?? "";
  return {
    sharedBuffersBytes: num(f[0]),
    effectiveCacheSizeBytes: num(f[1]),
    hnswEfSearch: efRaw === "" ? null : num(efRaw),
    memoryUnitsTotalBytes: num(f[3]),
    memoryUnitsHeapBytes: num(f[4]),
    memoryUnitsIndexBytes: num(f[5]),
    bankRows,
    largestIndexes,
    statsResetAt: (f[6] ?? "") === "" ? null : (f[6] as string),
    heapHitRatio: (f[7] ?? "") === "" ? null : num(f[7]),
    serverVersion: f.slice(8).join("|"),
  };
}
