/**
 * Tests for `docker/hindsight-maintenance.sh` — the periodic backup /
 * autovacuum-tuning / op-retention sidecar invoked by the entrypoint
 * loop. We can't stand up the embedded postgres in a host unit test, so
 * we prove (a) it no-ops cleanly + safely when there's no pg, and (b)
 * the dangerous-to-drift SQL and guards are pinned statically.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "..", "docker", "hindsight-maintenance.sh");

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
