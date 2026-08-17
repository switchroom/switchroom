/**
 * Tests for `docker/hindsight-maintenance.sh` — the periodic backup /
 * autovacuum-tuning / op-retention sidecar invoked by the entrypoint
 * loop. We can't stand up the embedded postgres in a host unit test, so
 * we prove (a) it no-ops cleanly + safely when there's no pg, and (b)
 * the dangerous-to-drift SQL and guards are pinned statically.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  accessSync,
  utimesSync,
  constants as fsConstants,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = resolve(__dirname, "..", "..", "docker", "hindsight-maintenance.sh");

/**
 * Return an EXEC-capable temp dir. Some sandboxes mount os.tmpdir() noexec,
 * which would make the maintenance script's `[ -x psql ]` false and skip the
 * probe; fall back to a repo-local cache dir. CI's tmpdir is exec.
 */
function execTmpDir(prefix: string): string {
  const bases = [tmpdir(), resolve(__dirname, "..", "..", "node_modules", ".cache")];
  for (const base of bases) {
    try {
      mkdirSync(base, { recursive: true });
      const d = mkdtempSync(join(base, prefix));
      const probe = join(d, "probe.sh");
      writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      accessSync(probe, fsConstants.X_OK);
      return d;
    } catch {
      /* try next base */
    }
  }
  throw new Error("no exec-capable tmp base for fake-psql");
}

/** Write a fake `psql` into an exec-capable dir; return that bin dir. */
function installFakePsql(): string {
  const binDir = execTmpDir("swr-maint-fakebin-");
  writeFileSync(
    join(binDir, "psql"),
    `#!/bin/sh
sql=""; prev=""
for a in "$@"; do
  case "$prev" in -c|-tAc) sql="$a" ;; esac
  prev="$a"
done
[ -n "\${FAKE_PSQL_LOG:-}" ] && printf '%s\\n' "$sql" >> "$FAKE_PSQL_LOG"
mode="\${FAKE_PSQL_MODE:-healthy}"
case "$sql" in
  "SELECT 1") echo 1; exit 0 ;;
  "CREATE EXTENSION"*) exit 0 ;;
  *bt_index_check*)
    if [ "$mode" = corrupt ]; then
      echo 'ERROR:  heap tuple (172,11) lacks matching index tuple within index "pk_async_operations"' >&2
      exit 1
    fi
    exit 0 ;;
  *"count(*)"*"status='processing'"*)
    if [ "$mode" = corrupt ]; then echo 4; else echo 0; fi; exit 0 ;;
  *FILTER*"status='failed'"*)
    # Dead-letter count probe (#3795): "total|fk_signature|oldest_age_s".
    # (FILTER appears in the SELECT list, before the status='failed' WHERE.)
    [ -n "\${FAKE_DL_COUNT:-}" ] && echo "\$FAKE_DL_COUNT"; exit 0 ;;
  *"status='failed'"*"ORDER BY created_at"*)
    # Requeue candidate select (#3795): "bank|operation_id" lines.
    [ -n "\${FAKE_DL_CANDS:-}" ] && printf '%s\\n' "\$FAKE_DL_CANDS"; exit 0 ;;
  *"amname='btree'"*)
    # Job 8b candidate select: "index|size_bytes" lines.
    [ -n "\${FAKE_IDX_CANDS:-}" ] && printf '%s\\n' "\$FAKE_IDX_CANDS"; exit 0 ;;
  *_ccnew*)
    # Job 8b invalid-index residue sweep: bare index names.
    [ -n "\${FAKE_IDX_INVALID:-}" ] && printf '%s\\n' "\$FAKE_IDX_INVALID"; exit 0 ;;
  *pgstatindex*)
    # Density lookup. FAKE_IDX_DENSITY is "name=NN;name2=NN".
    ix="\$(printf '%s' "\$sql" | sed "s/.*pgstatindex('\\([^']*\\)').*/\\1/")"
    for pair in \$(printf '%s' "\${FAKE_IDX_DENSITY:-}" | tr ';' ' '); do
      case "\$pair" in "\$ix="*) printf '%s\\n' "\${pair#*=}" ;; esac
    done
    exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  return binDir;
}

/**
 * Write a fake `curl` beside the fake `psql` (same bin dir). It logs the URL
 * it was POSTed to and echoes `$FAKE_CURL_CODE` (default 200) — matching how
 * the requeue calls curl with `-o /dev/null -w '%{http_code}'`.
 */
function installFakeCurl(binDir: string): void {
  writeFileSync(
    join(binDir, "curl"),
    `#!/bin/sh
url=""
for a in "$@"; do url="$a"; done
[ -n "\${FAKE_CURL_LOG:-}" ] && printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
printf '%s' "\${FAKE_CURL_CODE:-200}"
`,
    { mode: 0o755 },
  );
}

/**
 * Write a fake `vacuumdb` beside the fake `psql`. It appends its full argv to
 * `$FAKE_VACUUMDB_LOG` so a test can assert WHAT was asked of it (e.g.
 * `--analyze`, `-j N`, and never a full-rewrite flag).
 */
function installFakeVacuumdb(binDir: string): void {
  writeFileSync(
    join(binDir, "vacuumdb"),
    `#!/bin/sh
[ -n "\${FAKE_VACUUMDB_LOG:-}" ] && printf '%s\\n' "$*" >> "$FAKE_VACUUMDB_LOG"
exit "\${FAKE_VACUUMDB_EXIT:-0}"
`,
    { mode: 0o755 },
  );
}

function writePgInstance(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({ username: "hindsight", database: "hindsight", port: 5432, password: "testpw" }),
  );
}

describe("hindsight-maintenance.sh", () => {
  it("exits 0 and silently when the embedded pg descriptor is absent (host/test)", () => {
    const r = spawnSync("sh", [SCRIPT], {
      env: {
        ...process.env,
        SWITCHROOM_HINDSIGHT_PG0_INSTANCE: "/nonexistent/instance.json",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    // No backup/prune chatter and no crash leaking from the missing pg.
    expect(r.stderr).not.toMatch(/backup|pruned|Traceback|psql:/i);
  });

  it("exits 0 immediately when disabled via SWITCHROOM_HINDSIGHT_MAINTENANCE=0", () => {
    const r = spawnSync("sh", [SCRIPT], {
      env: { ...process.env, SWITCHROOM_HINDSIGHT_MAINTENANCE: "0" },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("pins the retention prune to ONLY completed terminal ops", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    // The DELETE must be scoped to status='completed' + an age cutoff.
    expect(raw).toMatch(/DELETE FROM async_operations WHERE status='completed'/);
    expect(raw).toMatch(/created_at < now\(\) - make_interval\(days => \$\{RETENTION_DAYS\}\)/);
    // It must NEVER delete failed/pending/processing rows.
    expect(raw).not.toMatch(/DELETE FROM async_operations WHERE status='(failed|pending|processing)'/);
  });

  it("pins the autovacuum tuning on the big/high-churn tables (idempotent ALTERs)", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    expect(raw).toMatch(/ALTER TABLE IF EXISTS memory_links SET \(autovacuum_vacuum_scale_factor=/);
    expect(raw).toMatch(/ALTER TABLE IF EXISTS async_operations SET \(autovacuum_vacuum_scale_factor=/);
  });

  // ── Visibility-map freshness on unit_entities / entities (#4634) ─────────
  //
  // A stale visibility map silently un-does index-only scans: measured on the
  // live fleet DB (2026-08-13) 200k index tuples cost 64,177 heap fetches on
  // `idx_unit_entities_entity_unit` and 138,465 on `pk_entities`. Only VACUUM
  // sets all-visible bits, so the fix is a vacuum that actually fires.
  //
  // This drives the script with a FAKE psql and asserts the OUTCOME — the
  // reloptions actually SENT to postgres, parsed and bounds-checked. It fails
  // if either table is dropped from the tuning, if the INSERT trigger (the one
  // that governs an append-only table like unit_entities) is left at the stock
  // 0.2, or if a scale factor is loosened past what the measurement supports.
  it("tunes unit_entities + entities so autovacuum actually fires (VM freshness)", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    try {
      const pgInstance = join(dir, "instance.json");
      const sqlLog = join(dir, "psql-sql.log");
      writePgInstance(pgInstance);
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          FAKE_PSQL_LOG: sqlLog,
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      const sql = readFileSync(sqlLog, "utf-8");

      /**
       * Parse the reloptions the script actually SET on `table`.
       *
       * `ALTER TABLE ... SET (...)` MERGES reloptions and is last-write-wins,
       * so a second ALTER appended below the first silently overrides those
       * keys in live postgres. Reading only the FIRST match would let exactly
       * that regression through green — the very merge semantic this file
       * exists to pin — so require there be exactly ONE ALTER per table.
       */
      const optsFor = (table: string): Record<string, number> => {
        const prefix = `ALTER TABLE IF EXISTS ${table} SET (`;
        const hits = sql
          .split("\n")
          .map((l, i) => ({ line: l, lineNo: i + 1 }))
          .filter((h) => h.line.startsWith(prefix));
        expect(hits.length, `no autovacuum ALTER issued for ${table}`).toBeGreaterThan(0);
        expect(
          hits.length,
          `${hits.length} autovacuum ALTERs issued for ${table} (SQL-log lines ` +
            `${hits.map((h) => h.lineNo).join(", ")}) — ALTER TABLE ... SET MERGES ` +
            `reloptions last-write-wins, so the LAST one silently overrides the ` +
            `earlier ones. Fold them into a single ALTER in ` +
            `docker/hindsight-maintenance.sh.`,
        ).toBe(1);
        const line = hits[0].line;
        const body = line.slice(line.indexOf("(") + 1, line.lastIndexOf(")"));
        return Object.fromEntries(
          body.split(",").map((kv) => {
            const [k, v] = kv.split("=");
            return [k.trim(), Number(v)];
          }),
        );
      };

      // unit_entities is append-only (25,583 inserts / 0 updates over the
      // measured 22h), so the INSERT trigger is the one that governs it. The
      // stock 0.2 needs 340,735 inserts (~2 weeks of ingest); pin it small.
      const ue = optsFor("unit_entities");
      expect(ue.autovacuum_vacuum_insert_scale_factor).toBeLessThanOrEqual(0.005);
      expect(ue.autovacuum_vacuum_insert_threshold).toBeLessThanOrEqual(1000);
      // 1000 + 0.005 * 1.74M rows ≈ 9.5k inserts — well under a day of ingest.
      const ueInsertTrigger =
        ue.autovacuum_vacuum_insert_threshold +
        ue.autovacuum_vacuum_insert_scale_factor * 1_739_740;
      expect(ueInsertTrigger).toBeLessThan(20_000);
      // ...and the dead-tuple / analyze triggers stay tightened too.
      expect(ue.autovacuum_vacuum_scale_factor).toBeLessThanOrEqual(0.01);
      expect(ue.autovacuum_analyze_scale_factor).toBeLessThanOrEqual(0.02);

      // entities is update-heavy (18,043 updates / 22h): the dead-tuple
      // trigger governs. 500 + 0.005 * 239,939 ≈ 1.7k dead — a pass somewhere
      // between ~3x/day (the 22.5h average) and roughly hourly (the 21-25
      // dead-tuples/min rate sampled live); churn is bursty, so the low end
      // is a floor. Derivation in docker/hindsight-maintenance.sh.
      const en = optsFor("entities");
      const enDeadTrigger =
        en.autovacuum_vacuum_threshold + en.autovacuum_vacuum_scale_factor * 239_939;
      expect(enDeadTrigger).toBeLessThan(2_500);
      expect(en.autovacuum_vacuum_insert_scale_factor).toBeLessThanOrEqual(0.01);

      // Both get a cost budget that lets the pass finish rather than being
      // throttled across the ingest window (the memory_links precedent).
      for (const o of [ue, en]) {
        expect(o.autovacuum_vacuum_cost_limit).toBeGreaterThanOrEqual(2000);
        expect(o.autovacuum_vacuum_cost_delay).toBeLessThanOrEqual(2);
      }

      // Tuning only — job #2 must never VACUUM/ANALYZE inline (that would run a
      // blocking full pass inside the 30-min maintenance tick).
      expect(sql).not.toMatch(/^\s*(VACUUM|ANALYZE)\b/im);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("writes backups to a separate dir + rotates, and is gated on an interval + pg readiness", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    // Rotated pg_dump in custom format to the backup dir.
    expect(raw).toMatch(/pg_dump|PG_DUMP/);
    expect(raw).toMatch(/-Fc/);
    expect(raw).toMatch(/BACKUP_DIR/);
    expect(raw).toMatch(/BACKUP_KEEP/);
    // Readiness probe before any work (skips the tick if pg isn't up yet).
    expect(raw).toMatch(/SELECT 1.*\|\| exit 0/);
    // Interval gate so it backs up at most once per window.
    expect(raw).toMatch(/-mmin "?-?\$\{BACKUP_INTERVAL_MIN\}/);
  });

  // ── Index-health + stuck-op alarm, job #5 (incident 2026-07-22) ─────────
  //
  // These drive the probe with a FAKE psql and assert the OUTCOME: a corrupt
  // pk_async_operations index AND a persistent stuck-op count each raise a
  // LOUD structured ERROR. They FAIL if job #5 is absent or downgraded to a
  // silent path, so they pin the alarm, not just the code path.
  it("job #5 ALARMS loudly on a corrupt pk_async_operations index and on stuck ops", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    try {
      const pgInstance = join(dir, "instance.json");
      const sqlLog = join(dir, "psql-sql.log");
      writePgInstance(pgInstance);
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          FAKE_PSQL_MODE: "corrupt",
          FAKE_PSQL_LOG: sqlLog,
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      // Corruption alarm (bt_index_check failed with a heap/index-tuple error).
      expect(r.stderr).toMatch(/ERROR: index health check FAILED for pk_async_operations/);
      // Stuck-op alarm (the reaper isn't clearing 'processing' ops).
      expect(r.stderr).toMatch(/ERROR: 4 async op\(s\) stuck in 'processing'/);
      // It is READ-ONLY — the probe must issue no UPDATE/DELETE/REINDEX against
      // the queue table (asserted on the ACTUAL SQL psql was called with, not
      // the alarm text — whose heal hint legitimately mentions REINDEX).
      const sql = readFileSync(sqlLog, "utf-8");
      expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|REINDEX)\b/mi);
      // ...and the probe SQL it DID issue was the index check + a count.
      expect(sql).toMatch(/bt_index_check/);
      expect(sql).toMatch(/count\(\*\)[^\n]*status='processing'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #5 stays SILENT on a healthy index with no stuck ops (no false positives)", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    try {
      const pgInstance = join(dir, "instance.json");
      writePgInstance(pgInstance);
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          FAKE_PSQL_MODE: "healthy",
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/index health check FAILED/);
      expect(r.stderr).not.toMatch(/stuck in 'processing'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #5 index-health probe is gated + read-only (static guard)", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    expect(raw).toMatch(/INDEX_HEALTH_CHECK/);
    expect(raw).toMatch(/bt_index_check\('pk_async_operations'::regclass, true\)/);
    // Stuck-op metric scoped to processing rows past the alarm window.
    expect(raw).toMatch(/status='processing' AND claimed_at < now\(\) - make_interval\(secs => \$\{STUCK_OP_WARN_S\}\)/);
    // Read-only: the probe SELECTs / checks; it must not mutate the queue.
    expect(raw).not.toMatch(/(UPDATE|DELETE)[^\n]*status='processing'/);
  });

  it("runs a queue-liveness probe that warns (read-only) when the pipeline is wedged", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    // Reads the oldest non-terminal op age — read-only (SELECT, never mutates).
    expect(raw).toMatch(/FROM async_operations WHERE status IN \('pending','processing'\)/);
    expect(raw).toMatch(/QUEUE_LAG_WARN_S/);
    // Gated (0 disables) and emits a WARNING, not a mutation.
    expect(raw).toMatch(/\$\{QUEUE_LAG_WARN_S\}.*-gt 0/);
    expect(raw).toMatch(/log "WARNING: queue may be wedged/);
    // The probe must not DELETE/UPDATE — it's visibility only.
    expect(raw).not.toMatch(/(DELETE|UPDATE).*status IN \('pending','processing'\)/);
  });

  // ── #3758: the wedge probe must EXCLUDE never-claimable batch_retain
  // parents (task_payload IS NULL). Static guard so it cannot silently
  // regress back to counting healthy in-flight parents as a wedge.
  it("job #4 wedge probe excludes payload-null parents (mirrors the partial claim index)", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    // The oldest-age SELECT must be scoped to claimable rows only.
    expect(raw).toMatch(
      /FROM async_operations WHERE status IN \('pending','processing'\) AND task_payload IS NOT NULL/,
    );
    // ...and there must be NO remaining unclaimable-inclusive wedge SELECT.
    expect(raw).not.toMatch(
      /max\(extract\(epoch[^\n]*status IN \('pending','processing'\)"\)/,
    );
  });

  // ── #3795 dead-letter visibility (job #6): a failed retain with an intact
  // payload older than the threshold WARNs LOUDLY. Driven with a fake psql
  // returning a stale count; asserts the OUTCOME, not just the code path.
  it("job #6 WARNs on stalled, recoverable failed retains (intact payload)", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    try {
      const pgInstance = join(dir, "instance.json");
      writePgInstance(pgInstance);
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          // total=5, fk-signature=3, oldest 999999s (~11.5d) > 6h default.
          FAKE_DL_COUNT: "5|3|999999",
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(
        /WARNING: 5 failed 'retain' op\(s\) with an intact payload are stalled/,
      );
      // Names the FK-race subset that is safe to requeue.
      expect(r.stderr).toMatch(/3 match the FK-race dead-letter signature/);
      expect(r.stderr).toMatch(/costs LLM spend/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #6 stays SILENT when there are no stalled dead letters", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    try {
      const pgInstance = join(dir, "instance.json");
      writePgInstance(pgInstance);
      // No FAKE_DL_COUNT → the count probe returns empty → no WARN.
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/failed 'retain' op\(s\) with an intact payload/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #6 dead-letter probe is read-only and correctly scoped (static guard)", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    // Scoped to failed retains with an INTACT payload (recoverable).
    expect(raw).toMatch(
      /operation_type='retain' AND status='failed' AND task_payload IS NOT NULL/,
    );
    // Breaks out the FK-race signature (never entered the retry ladder).
    expect(raw).toMatch(/FILTER \(WHERE retry_count=0 AND next_retry_at IS NULL\)/);
    // Visibility only — never mutates the failed set.
    expect(raw).not.toMatch(/(UPDATE|DELETE)[^\n]*status='failed'/);
  });

  // ── #3795 requeue (job #7): OFF by default, and when enabled POSTs each
  // FK-race dead letter to the engine retry endpoint via curl.
  it("job #7 requeue is OFF by default — no curl, no POST", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    installFakeCurl(binDir);
    try {
      const pgInstance = join(dir, "instance.json");
      const curlLog = join(dir, "curl.log");
      writePgInstance(pgInstance);
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          FAKE_DL_CANDS: "overlord|11111111-1111-1111-1111-111111111111",
          FAKE_CURL_LOG: curlLog,
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/dead-letter requeue/);
      // curl was never invoked (no requeue log file written).
      expect(() => readFileSync(curlLog, "utf-8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #7 requeue POSTs each FK-race dead letter to the engine retry endpoint when enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    installFakeCurl(binDir);
    try {
      const pgInstance = join(dir, "instance.json");
      const curlLog = join(dir, "curl.log");
      writePgInstance(pgInstance);
      const op = "11111111-1111-1111-1111-111111111111";
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS: "1",
          SWITCHROOM_HINDSIGHT_API_URL: "http://127.0.0.1:9077",
          FAKE_DL_CANDS: `overlord|${op}`,
          FAKE_CURL_LOG: curlLog,
          FAKE_CURL_CODE: "200",
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      // The POST targeted the documented retry endpoint for that bank+op.
      const urls = readFileSync(curlLog, "utf-8");
      expect(urls).toContain(
        `http://127.0.0.1:9077/v1/default/banks/overlord/operations/${op}/retry`,
      );
      // The requeue logged success + a summary.
      expect(r.stderr).toMatch(new RegExp(`dead-letter requeue: overlord/${op} -> HTTP 200`));
      expect(r.stderr).toMatch(/dead-letter requeue: 1 requeued, 0 failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #7 requeue aborts with a clear hint when the retry endpoint returns 401", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-hsi-maint-"));
    const binDir = installFakePsql();
    installFakeCurl(binDir);
    try {
      const pgInstance = join(dir, "instance.json");
      writePgInstance(pgInstance);
      const r = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: pgInstance,
          SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS: "1",
          FAKE_DL_CANDS: "overlord|11111111-1111-1111-1111-111111111111",
          FAKE_CURL_CODE: "401",
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/the retry endpoint needs auth; set SWITCHROOM_HINDSIGHT_API_TOKEN/);
      expect(r.stderr).toMatch(/aborted after 0 requeued/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("job #7 requeue targets the FK signature, is bounded, and hits the retry endpoint (static guard)", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    // OFF by default.
    expect(raw).toMatch(/REQUEUE_DEAD_LETTERS="\$\{SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS:-0\}"/);
    // Candidate query = the FK-race dead-letter signature, bounded by REQUEUE_MAX.
    expect(raw).toMatch(
      /operation_type='retain' AND status='failed' AND task_payload IS NOT NULL AND retry_count=0 AND next_retry_at IS NULL ORDER BY created_at LIMIT \$\{REQUEUE_MAX\}/,
    );
    // Uses the engine's own retry endpoint (not a raw SQL status flip).
    expect(raw).toMatch(/\/v1\/default\/banks\/\$\{_bank\}\/operations\/\$\{_op\}\/retry/);
    // POST, with an optional bearer token.
    expect(raw).toMatch(/-X POST/);
    expect(raw).toMatch(/Authorization: Bearer \$\{_tok\}/);
    // The requeue must NOT reach into the queue table with a raw UPDATE.
    expect(raw).not.toMatch(/UPDATE async_operations SET status='pending'/);
  });

  // ── Job 8a/8b: periodic VACUUM (ANALYZE) + conditional REINDEX ──────────
  //
  // Driven with a fake psql/vacuumdb; every assertion is on an OUTCOME — what
  // the script actually executed and logged — not on the presence of code.
  describe("job #8 vacuum + conditional reindex", () => {
    /** One maintenance tick against the fakes in `binDir`, state under `dir`. */
    function runTick(binDir: string, dir: string, env: Record<string, string>) {
      return spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SWITCHROOM_HINDSIGHT_PG0_INSTANCE: join(dir, "instance.json"),
          SWITCHROOM_HINDSIGHT_BACKUP_DIR: join(dir, "backups"),
          ...env,
        },
        encoding: "utf-8",
        timeout: 20_000,
      });
    }

    /** Fresh (dir, binDir) with a pg descriptor + fake psql/vacuumdb. */
    function setup(): { dir: string; binDir: string } {
      const dir = mkdtempSync(join(tmpdir(), "swr-hsi-vac-"));
      const binDir = installFakePsql();
      installFakeVacuumdb(binDir);
      writePgInstance(join(dir, "instance.json"));
      return { dir, binDir };
    }

    function teardown(dir: string, binDir: string): void {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }

    function lines(path: string): string[] {
      try {
        return readFileSync(path, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    }

    it("8a vacuums once per interval: throttled inside the window, permitted after it", () => {
      const { dir, binDir } = setup();
      try {
        const vlog = join(dir, "vacuumdb.log");
        const env = {
          FAKE_VACUUMDB_LOG: vlog,
          SWITCHROOM_HINDSIGHT_REINDEX: "0",
          SWITCHROOM_HINDSIGHT_VACUUM_INTERVAL_MIN: "360",
        };

        const r1 = runTick(binDir, dir, env);
        expect(r1.status).toBe(0);
        expect(r1.stderr).toMatch(/vacuum \(analyze\) completed in \d+s \(vacuumdb -j 4\)/);
        expect(lines(vlog)).toHaveLength(1);
        expect(lines(vlog)[0]).toContain("--analyze");
        expect(lines(vlog)[0]).toMatch(/-j 4\b/);

        // Second tick inside the window: the throttle must SUPPRESS it.
        const r2 = runTick(binDir, dir, env);
        expect(r2.status).toBe(0);
        expect(r2.stderr).not.toMatch(/vacuum \(analyze\) completed/);
        expect(lines(vlog)).toHaveLength(1);

        // Age the marker past the window: the next tick must vacuum again.
        const marker = join(dir, "backups", ".vacuum-last");
        const old = new Date(Date.now() - 7 * 3600_000);
        utimesSync(marker, old, old);
        const r3 = runTick(binDir, dir, env);
        expect(r3.status).toBe(0);
        expect(r3.stderr).toMatch(/vacuum \(analyze\) completed/);
        expect(lines(vlog)).toHaveLength(2);
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8a NEVER issues VACUUM FULL (it would take an ACCESS EXCLUSIVE lock)", () => {
      const { dir, binDir } = setup();
      try {
        const vlog = join(dir, "vacuumdb.log");
        const sqlLog = join(dir, "psql-sql.log");
        const r = runTick(binDir, dir, {
          FAKE_VACUUMDB_LOG: vlog,
          FAKE_PSQL_LOG: sqlLog,
          FAKE_IDX_CANDS: "idx_low|1048576",
          FAKE_IDX_DENSITY: "idx_low=60",
        });
        expect(r.status).toBe(0);
        // Nothing the script executed — via psql or vacuumdb — was a full vacuum.
        for (const l of [...lines(vlog), ...lines(sqlLog)]) {
          expect(l).not.toMatch(/VACUUM\s+FULL/i);
          expect(l).not.toMatch(/(^|\s)(-f|--full)(\s|$)/);
        }
        // ...and the source carries no full-vacuum call site at all (the only
        // permitted mention is the comment explaining why it is banned).
        const code = readFileSync(SCRIPT, "utf-8")
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("#"));
        expect(code.join("\n")).not.toMatch(/VACUUM\s+FULL/i);
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8a and 8b no-op when their master switch is 0", () => {
      const { dir, binDir } = setup();
      try {
        const vlog = join(dir, "vacuumdb.log");
        const sqlLog = join(dir, "psql-sql.log");
        const r = runTick(binDir, dir, {
          SWITCHROOM_HINDSIGHT_VACUUM: "0",
          SWITCHROOM_HINDSIGHT_REINDEX: "0",
          FAKE_VACUUMDB_LOG: vlog,
          FAKE_PSQL_LOG: sqlLog,
          FAKE_IDX_CANDS: "idx_low|1048576",
          FAKE_IDX_DENSITY: "idx_low=10",
        });
        expect(r.status).toBe(0);
        expect(lines(vlog)).toHaveLength(0);
        expect(r.stderr).not.toMatch(/vacuum \(analyze\)/);
        const sql = lines(sqlLog).join("\n");
        expect(sql).not.toMatch(/REINDEX/);
        expect(sql).not.toMatch(/VACUUM/);
        // Neither job claimed its throttle window.
        expect(lines(join(dir, "backups", ".vacuum-last"))).toHaveLength(0);
        expect(() => readFileSync(join(dir, "backups", ".reindex-last"))).toThrow();
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8a and 8b no-op (exit 0, no markers) when psql is absent", () => {
      const { dir, binDir } = setup();
      try {
        // A PATH with the fake vacuumdb but NO psql at all: the script must
        // bail at the client-resolution guard before touching anything.
        const noPsqlBin = execTmpDir("swr-maint-nopsql-");
        installFakeVacuumdb(noPsqlBin);
        const vlog = join(dir, "vacuumdb.log");
        const r = spawnSync("/bin/sh", [SCRIPT], {
          env: {
            ...process.env,
            PATH: noPsqlBin, // no psql anywhere on PATH
            SWITCHROOM_HINDSIGHT_PG0_INSTANCE: join(dir, "instance.json"),
            SWITCHROOM_HINDSIGHT_BACKUP_DIR: join(dir, "backups"),
            FAKE_VACUUMDB_LOG: vlog,
          },
          encoding: "utf-8",
          timeout: 20_000,
        });
        expect(r.status).toBe(0);
        // No maintenance log line at all — the script's own logs are prefixed.
        expect(r.stderr).not.toMatch(/switchroom-hindsight-maintenance:/);
        expect(lines(vlog)).toHaveLength(0);
        expect(() => readFileSync(join(dir, "backups", ".vacuum-last"))).toThrow();
        rmSync(noPsqlBin, { recursive: true, force: true });
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8b rebuilds ONLY the below-threshold index, always CONCURRENTLY, and clears _ccnew residue", () => {
      const { dir, binDir } = setup();
      try {
        const sqlLog = join(dir, "psql-sql.log");
        const r = runTick(binDir, dir, {
          FAKE_PSQL_LOG: sqlLog,
          // 8a would otherwise hold the ShareUpdateExclusiveLock window.
          SWITCHROOM_HINDSIGHT_VACUUM: "0",
          FAKE_IDX_CANDS: "idx_low|1048576\nidx_high|1048576",
          FAKE_IDX_DENSITY: "idx_low=60;idx_high=85",
          FAKE_IDX_INVALID: "idx_low_ccnew",
        });
        expect(r.status).toBe(0);
        const sql = lines(sqlLog);
        // The candidate query ACTUALLY SENT to postgres filters on the access
        // method — an hnsw/bm25 index can never enter the candidate set.
        const candidateSql = sql.filter((l) => /FROM pg_class c JOIN pg_am/.test(l));
        expect(candidateSql).toHaveLength(1);
        expect(candidateSql[0]).toContain("am.amname='btree'");
        // The bloated one was rebuilt; the healthy one was left alone.
        expect(r.stderr).toMatch(/reindex: rebuilt idx_low \(avg_leaf_density was 60% < 70%\)/);
        expect(r.stderr).not.toMatch(/rebuilt idx_high/);
        expect(sql).toContain("REINDEX INDEX CONCURRENTLY idx_low");
        expect(sql.join("\n")).not.toMatch(/REINDEX[^\n]*idx_high/);
        // EVERY reindex issued is CONCURRENTLY — a bare REINDEX would take an
        // exclusive lock on a live fleet-memory table.
        for (const l of sql.filter((s) => /REINDEX/.test(s))) {
          expect(l).toMatch(/^REINDEX INDEX CONCURRENTLY /);
        }
        // Residue of a cancelled CONCURRENTLY build was dropped concurrently.
        expect(sql).toContain("DROP INDEX CONCURRENTLY IF EXISTS idx_low_ccnew");
        expect(r.stderr).toMatch(/dropped leftover INVALID index idx_low_ccnew/);
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8b caps the work per tick and LOGS how many candidates it skipped", () => {
      const { dir, binDir } = setup();
      try {
        const sqlLog = join(dir, "psql-sql.log");
        const r = runTick(binDir, dir, {
          FAKE_PSQL_LOG: sqlLog,
          SWITCHROOM_HINDSIGHT_VACUUM: "0",
          FAKE_IDX_CANDS: ["a|1048576", "b|1048576", "c|1048576", "d|1048576"].join("\n"),
          FAKE_IDX_DENSITY: "a=50;b=55;c=60;d=65",
        });
        expect(r.status).toBe(0);
        const rebuilt = lines(sqlLog).filter((l) => /^REINDEX/.test(l));
        expect(rebuilt).toHaveLength(3); // default REINDEX_MAX_PER_RUN
        // Worst bloat first: a (50) / b (55) / c (60), never d (65).
        expect(rebuilt.join("\n")).not.toMatch(/\bd\b/);
        // The cap is LOUD — a silent cap reads as "did everything".
        expect(r.stderr).toMatch(
          /reindex: 1 bloated index\(es\) left for the next sweep — capped at 3\/run/,
        );
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8b skips an index when free disk is under 2x its size (CONCURRENTLY doubles it)", () => {
      const { dir, binDir } = setup();
      try {
        const sqlLog = join(dir, "psql-sql.log");
        const r = runTick(binDir, dir, {
          FAKE_PSQL_LOG: sqlLog,
          SWITCHROOM_HINDSIGHT_VACUUM: "0",
          // 1 PB index: no CI runner has 2 PB free.
          FAKE_IDX_CANDS: "idx_huge|1000000000000000",
          FAKE_IDX_DENSITY: "idx_huge=40",
        });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/reindex: SKIPPED idx_huge \(density 40%\)[^\n]*free/);
        expect(lines(sqlLog).join("\n")).not.toMatch(/REINDEX/);
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8b never runs in the same tick as 8a (lock contention), but runs on the next one", () => {
      const { dir, binDir } = setup();
      try {
        const sqlLog = join(dir, "psql-sql.log");
        const vlog = join(dir, "vacuumdb.log");
        const env = {
          FAKE_PSQL_LOG: sqlLog,
          FAKE_VACUUMDB_LOG: vlog,
          FAKE_IDX_CANDS: "idx_low|1048576",
          FAKE_IDX_DENSITY: "idx_low=60",
        };
        // Tick 1: 8a runs (fresh marker) ⇒ 8b must stand down.
        const r1 = runTick(binDir, dir, env);
        expect(r1.status).toBe(0);
        expect(lines(vlog)).toHaveLength(1);
        expect(lines(sqlLog).join("\n")).not.toMatch(/REINDEX/);
        // Tick 2: 8a is throttled ⇒ 8b gets the table to itself.
        const r2 = runTick(binDir, dir, env);
        expect(r2.status).toBe(0);
        expect(lines(vlog)).toHaveLength(1);
        expect(lines(sqlLog)).toContain("REINDEX INDEX CONCURRENTLY idx_low");
        expect(r2.stderr).toMatch(/reindex: rebuilt idx_low/);
      } finally {
        teardown(dir, binDir);
      }
    });

    it("8b candidate selection is btree-ONLY and catalog-driven (hnsw/bm25 can never be picked)", () => {
      // Comment lines are stripped: the header block legitimately DISCUSSES
      // btree/hnsw/bm25, and a guard satisfied by prose guards nothing.
      const raw = readFileSync(SCRIPT, "utf-8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n");
      // The candidate query joins pg_am and filters to btree — pgstatindex
      // ERRORS on hnsw/bm25 and rebuilding them is not a bloat fix.
      expect(raw).toMatch(/JOIN pg_am am ON am\.oid=c\.relam/);
      expect(raw).toMatch(/am\.amname='btree'/);
      // No hardcoded index list, and the size floor comes from the knob.
      expect(raw).toMatch(/pg_relation_size\(c\.oid\) > \$\{REINDEX_MIN_MB\}\*1024\*1024/);
      // Invalid-index residue is scoped to pg's own _ccnew suffix — a user
      // index that is invalid for another reason is not ours to drop.
      expect(raw).toMatch(/NOT i\.indisvalid[^\n]*relname LIKE '%\\\\_ccnew%'/);
      // Throttle markers live on the PERSISTENT backup volume, not pg data/tmp.
      expect(raw).toMatch(/_vac_marker="\$\{BACKUP_DIR\}\/\.vacuum-last"/);
      expect(raw).toMatch(/_rix_marker="\$\{BACKUP_DIR\}\/\.reindex-last"/);
    });
  });
});
