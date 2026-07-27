/**
 * Doctor surface: per-bank HNSW partial vector indexes on `memory_units`.
 *
 * ## The defect this detects
 *
 * Hindsight creates one PARTIAL vector index per (bank, fact_type) —
 * `WHERE fact_type = ... AND bank_id = ...` — and it creates them exactly
 * once, at bank creation:
 *
 *     engine/retain/bank_utils.py:254  -> ops.create_bank_vector_indexes(...)
 *     engine/retain/fact_storage.py:163 -> same, from the other create path
 *
 * Both callsites are guarded by `if inserted:` / `if created:` on an
 * `INSERT ... ON CONFLICT (bank_id) DO NOTHING RETURNING bank_id`. So the
 * indexes are created if and only if THAT statement inserted the bank row.
 * There is no backfill and no reconciliation anywhere: a bank whose row
 * predates the feature, or whose creation raced, never gets its indexes and
 * nothing ever notices. On this fleet every bank created between 2026-04-14
 * and 2026-05-31 ran without them for roughly three months, with measured
 * recall@100 bounded at <=4%.
 *
 * It is invisible from the outside because it is not an error. Recall still
 * returns rows — just the wrong ones, from a sequential scan or the global
 * index, and only ever a truncated slice of the candidate pool. No exception,
 * no log line, no failed request.
 *
 * ## Detection only
 *
 * This module reports; it does not repair. Creating the missing indexes is an
 * upstream (Hindsight) concern and a separate piece of work — building a
 * `CREATE INDEX` into `switchroom doctor` would mean a diagnostic command
 * taking a write lock on a live production table.
 */

import { spawnSync } from "node:child_process";

/**
 * Module-local per house convention (each doctor-*.ts declares its own).
 * Includes `skip`, which this check needs: "couldn't reach the database" is
 * not a failure of the thing being checked.
 */
export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail?: string;
  fix?: string;
}

/**
 * Per-(bank, fact_type) embedding-row count at or above which a missing
 * partial index is reported as a failure.
 *
 * Picked from measured behaviour, not from taste. Below roughly 12,000 rows
 * for a (bank, fact_type) the planner stops preferring the per-bank partial
 * index anyway, so a missing index there is not yet costing recall quality;
 * above it, the absence is the difference between a real top-N and a
 * truncated slice.
 *
 * 10,000 sits deliberately BELOW that flip point so the row fires while the
 * bank is still healthy — a check that only fires once recall has already
 * degraded has told the operator something they could have measured
 * themselves. Verified against the live fleet (2026-07-27): every
 * (bank, fact_type) at or above 9,250 rows has a valid index, and the largest
 * unindexed pair is `gymbro/world` at 8,128 rows and rising. This floor
 * catches that pair on the day it crosses, ahead of the degradation.
 */
export const HNSW_INDEX_MIN_ROWS = 10_000;

/** Fact types that get a per-bank partial index, and their 4-char suffix. */
export const HNSW_FACT_TYPE_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["world", "worl"],
  ["experience", "expr"],
  ["observation", "obsv"],
];

/**
 * One (bank, fact_type) pair above the floor, and whether its index exists.
 */
export interface HnswIndexRow {
  bankId: string;
  factType: string;
  /** Embedding rows for this pair (`embedding IS NOT NULL`). */
  rows: number;
  /** The derived index name, so a report names the object to look for. */
  indexName: string;
  /** True when a matching index exists AND is `indisvalid`. */
  present: boolean;
}

export interface HnswIndexProbeResult {
  /** False when the probe could not run at all (no docker, container down). */
  ok: boolean;
  rows: HnswIndexRow[];
  /** Populated when `ok` is false. */
  error?: string;
}

/**
 * Build the SQL the probe runs.
 *
 * Split out and pure so the DERIVATION is testable without a database. The
 * index name is derived exactly as the engine derives it
 * (`engine/retain/bank_utils.py:_bank_index_name`,
 * `engine/db/ops_postgresql.py:create_bank_vector_indexes`):
 *
 *     uid = str(internal_id).replace("-", "")[:16]
 *     idx = f"idx_mu_emb_{suffix}_{uid}"
 *
 * Note the order: hyphens are stripped FIRST, then the first 16 characters are
 * taken. Truncating the raw UUID text to 16 characters instead would keep two
 * hyphens and yield a different, wrong name — which would make this check
 * report every bank as broken. Deriving rather than hardcoding is what keeps
 * the check correct when a bank is added, and asserting the derivation is what
 * keeps it honest.
 *
 * `indisvalid` is checked, not merely existence: a `CREATE INDEX CONCURRENTLY`
 * that failed part-way leaves an INVALID index behind, which the planner will
 * not use. Such an index is present in `pg_class` and useless, so treating
 * existence as sufficient would report the exact broken state as healthy.
 */
export function buildHnswIndexQuery(minRows: number = HNSW_INDEX_MIN_ROWS): string {
  const suffixCase =
    "CASE mu.fact_type " +
    HNSW_FACT_TYPE_SUFFIXES.map(([ft, sfx]) => `WHEN '${ft}' THEN '${sfx}'`).join(" ") +
    " END";
  const derivedName =
    `concat('idx_mu_emb_', ${suffixCase}, '_', ` +
    `substr(replace(b.internal_id::text, '-', ''), 1, 16))`;
  return (
    `SELECT b.bank_id, mu.fact_type, count(*)::text, ${derivedName}, ` +
    `(EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid ` +
    `WHERE c.relname = ${derivedName} AND i.indisvalid))::text ` +
    `FROM memory_units mu JOIN banks b ON b.bank_id = mu.bank_id ` +
    `WHERE mu.embedding IS NOT NULL ` +
    `AND mu.fact_type IN (${HNSW_FACT_TYPE_SUFFIXES.map(([ft]) => `'${ft}'`).join(", ")}) ` +
    `GROUP BY b.bank_id, mu.fact_type, b.internal_id ` +
    `HAVING count(*) >= ${minRows} ` +
    `ORDER BY count(*) DESC`
  );
}

/**
 * Parse the psql `-At -F'|'` output into rows.
 *
 * Pure, and tolerant of the noise a `docker exec` wrapper can prepend: any
 * line that is not exactly five pipe-separated fields with a numeric count is
 * skipped rather than throwing. A doctor check must never crash the command it
 * runs in.
 */
export function parseHnswIndexOutput(stdout: string): HnswIndexRow[] {
  const out: HnswIndexRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length !== 5) continue;
    const [bankId, factType, rowsRaw, indexName, presentRaw] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    const rows = Number.parseInt(rowsRaw, 10);
    if (!Number.isFinite(rows) || bankId === "" || indexName === "") continue;
    // psql renders a boolean as `t`/`f` in -At mode, but an explicit
    // `::text` cast renders it as `true`/`false`. Both spellings are accepted
    // because getting this wrong is silent and total: a live run against the
    // fleet reported all 17 healthy banks as unindexed purely because the
    // parser only knew `t`. Anything else is treated as NOT present, so an
    // unrecognised value fails safe (reports a problem) rather than quietly
    // clearing a real one.
    const present = presentRaw === "t" || presentRaw === "true";
    out.push({ bankId, factType, rows, indexName, present });
  }
  return out;
}

/**
 * Run the query inside the hindsight container.
 *
 * pg0 embeds postgres in the container and keeps the superuser password in
 * `instances/<name>/instance.json`, so the password is read there and passed
 * via `PGPASSWORD` in the container's own environment. It is never printed,
 * never returned, and never reaches a doctor row.
 *
 * @internal exported so the check can be tested with an injected probe
 */
export function probeHnswIndexes(
  minRows: number = HNSW_INDEX_MIN_ROWS,
): HnswIndexProbeResult {
  const sql = buildHnswIndexQuery(minRows).replace(/"/g, '\\"');
  const script =
    `set -e; ` +
    `META=/home/hindsight/.pg0/instances/hindsight/instance.json; ` +
    `[ -f "$META" ] || { echo "no pg0 instance metadata" >&2; exit 3; }; ` +
    `PGPASSWORD=$(python3 -c "import json,sys;print(json.load(open('$META'))['password'])"); ` +
    `export PGPASSWORD; ` +
    `PSQL=$(ls -d /home/hindsight/.pg0/installation/*/bin/psql 2>/dev/null | head -1); ` +
    `[ -n "$PSQL" ] || { echo "psql not found" >&2; exit 3; }; ` +
    `"$PSQL" -U hindsight -d hindsight -At -F'|' -c "${sql}"`;

  const r = spawnSync("docker", ["exec", "switchroom-hindsight", "sh", "-c", script], {
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      rows: [],
      error: (r.stderr || r.error?.message || `exit ${r.status}`).toString().trim(),
    };
  }
  return { ok: true, rows: parseHnswIndexOutput(r.stdout ?? "") };
}

/**
 * Doctor row: every sufficiently-large (bank, fact_type) has a valid partial
 * vector index.
 *
 * SKIP — not FAIL — when the probe cannot run. A dockerless or remote-backend
 * host has nothing to say here, and a check that fails on "couldn't look"
 * teaches operators to ignore it.
 */
export function checkHnswPartialIndexes(opts?: {
  probe?: (minRows: number) => HnswIndexProbeResult;
  minRows?: number;
}): CheckResult {
  const minRows = opts?.minRows ?? HNSW_INDEX_MIN_ROWS;
  const probe = opts?.probe ?? probeHnswIndexes;
  const result = probe(minRows);

  if (!result.ok) {
    return {
      name: "hindsight vector indexes",
      status: "skip",
      detail: `couldn't query the hindsight database (${result.error ?? "unknown"})`,
    };
  }

  // Re-apply the floor here even though the query already filters on it. The
  // floor is the judgement call in this check — "how big is big enough that a
  // missing index is actually costing recall" — and a judgement call should be
  // enforced in one place that can be tested without a database, not left to
  // live only inside a SQL string. It also means a looser probe can never
  // produce a false FAIL on a small bank.
  const eligible = result.rows.filter((r) => r.rows >= minRows);
  const missing = eligible.filter((r) => !r.present);
  if (missing.length === 0) {
    return {
      name: "hindsight vector indexes",
      status: "ok",
      detail:
        result.rows.length === 0
          ? `no (bank, fact_type) pair has reached ${minRows.toLocaleString()} embedding rows yet`
          : `all ${eligible.length} pair(s) at or above ${minRows.toLocaleString()} rows have a valid partial index`,
    };
  }

  const worst = missing
    .map((m) => `${m.bankId}/${m.factType} (${m.rows.toLocaleString()} rows, ${m.indexName})`)
    .join("; ");
  return {
    name: "hindsight vector indexes",
    status: "fail",
    detail:
      `${missing.length} (bank, fact_type) pair(s) at or above ${minRows.toLocaleString()} ` +
      `embedding rows have no valid per-bank partial vector index, so recall on them ` +
      `scans instead of searching and returns a truncated candidate pool: ${worst}`,
    fix:
      "Hindsight creates these once at bank creation and never backfills " +
      "(engine/retain/bank_utils.py, guarded by `if created:`), so an existing " +
      "bank cannot repair itself. Create each missing index against the " +
      "hindsight database, ideally CONCURRENTLY so recall keeps serving, " +
      "matching the engine's own definition: a partial index on memory_units " +
      "over the embedding column WHERE fact_type = <type> AND bank_id = <bank>. " +
      "Verify with `indisvalid` afterwards — a CONCURRENTLY build that fails " +
      "part-way leaves an INVALID index the planner will not use.",
  };
}
