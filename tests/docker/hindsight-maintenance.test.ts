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
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  return binDir;
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
});
