# Operator runbook — Hindsight memory: backups, restore, maintenance

The `switchroom-hindsight` container holds the entire fleet's long-term
memory in an embedded PostgreSQL (`pg0`) on the
`switchroom-hindsight-data` volume. This runbook covers keeping it
backed up, restoring it, and the automatic self-maintenance switchroom
runs.

## Automatic backups

The entrypoint's background loop runs `hindsight-maintenance.sh`, which
takes a **rotated `pg_dump`** to the **`switchroom-hindsight-backups`
volume** — deliberately *separate* from the data volume, so a
data-volume loss or corruption is recoverable.

- Cadence: at most once per `SWITCHROOM_HINDSIGHT_BACKUP_INTERVAL_MIN`
  (default `1440` = daily).
- Retention: keeps the newest `SWITCHROOM_HINDSIGHT_BACKUP_KEEP`
  (default `7`); older dumps are rotated out.
- Format: `pg_dump -Fc` (custom/compressed, restored with `pg_restore`).
- Best-effort: a failed dump is logged (`switchroom-hindsight-maintenance:`
  on stderr) and retried next tick; it never wedges the container.

These backups live on the same host. **For real disaster recovery,
periodically copy the volume off-host** (cron on the host):

```bash
# Copy the newest dumps off the box (adjust destination).
docker run --rm -v switchroom-hindsight-backups:/b -v "$PWD":/out alpine \
  sh -c 'cp /b/hindsight-*.dump /out/' && rsync ./hindsight-*.dump backup-host:/backups/
```

## On-demand backup

```bash
docker exec switchroom-hindsight sh -lc '
  PW=$(python3 -c "import json;print(json.load(open(\"/home/hindsight/.pg0/instances/hindsight/instance.json\"))[\"password\"])")
  PGPASSWORD="$PW" /home/hindsight/.pg0/installation/*/bin/pg_dump \
    -U hindsight -h /tmp -d hindsight -Fc --no-owner --no-privileges
' > ~/.switchroom/backups/hindsight-$(date -u +%Y%m%d-%H%M%S).dump
```

Verify a dump is restorable before trusting it:

```bash
docker exec -i switchroom-hindsight /home/hindsight/.pg0/installation/*/bin/pg_restore -l \
  < ~/.switchroom/backups/hindsight-<TS>.dump | head
```

## Restore

Restoring overwrites live memory — stop dependent traffic first.

```bash
# 1. Copy the dump into the container.
docker cp ~/.switchroom/backups/hindsight-<TS>.dump switchroom-hindsight:/tmp/restore.dump

# 2. Restore into the running pg (drops + recreates objects).
docker exec switchroom-hindsight sh -lc '
  PW=$(python3 -c "import json;print(json.load(open(\"/home/hindsight/.pg0/instances/hindsight/instance.json\"))[\"password\"])")
  PGPASSWORD="$PW" /home/hindsight/.pg0/installation/*/bin/pg_restore \
    -U hindsight -h /tmp -d hindsight --clean --if-exists --no-owner /tmp/restore.dump
'

# 3. Bounce hindsight so the worker re-reads cleanly.
switchroom agent restart test-harness --wait --force   # or: docker restart switchroom-hindsight
```

## Self-maintenance (autovacuum + op retention)

The same maintenance loop also, every tick (best-effort, idempotent):

- **Pins per-table autovacuum** on the large / high-churn tables
  (`memory_links`, `async_operations`, `entity_cooccurrences`,
  `unit_entities`). The upstream pg default scale factor (`0.2`) means a
  multi-million-row table won't autovacuum until >1M dead tuples — so
  these tables bloat and their planner stats go stale (mis-estimating
  the worker's queue table by ~80×, degrading queue-poll plans).
- **Prunes completed `async_operations`** older than
  `SWITCHROOM_HINDSIGHT_RETENTION_DAYS` (default `30`). These are
  terminal queue records the worker never reads again; `failed` /
  `pending` / `processing` rows are never touched.

Plain `VACUUM` returns dead space to the free-space map but does not
shrink the data files. To reclaim disk after a large prune, run a
`VACUUM (FULL, ANALYZE)` or `pg_repack` **in a maintenance window** (it
takes an exclusive lock).

## Env knobs

| Var | Default | Effect |
|-----|---------|--------|
| `SWITCHROOM_HINDSIGHT_MAINTENANCE` | `1` | master switch (`0` disables all three jobs) |
| `SWITCHROOM_HINDSIGHT_BACKUP_INTERVAL_MIN` | `1440` | min minutes between backups |
| `SWITCHROOM_HINDSIGHT_BACKUP_KEEP` | `7` | rotated backups retained |
| `SWITCHROOM_HINDSIGHT_RETENTION_DAYS` | `30` | completed-op prune age |

## Health

The container now carries a Docker **healthcheck** (`/health` via
`python3`), so a wedged or never-booted API reports `unhealthy` and is
restarted under `restart: unless-stopped`. Check it with:

```bash
docker inspect switchroom-hindsight --format '{{.State.Health.Status}}'
```

Note: the healthcheck proves the API + DB are reachable, **not** that the
consolidation queue is advancing — watch for a stuck queue separately
(see the stale-claim reaper in `hindsight-entrypoint.sh` and the
`async_operations` `processing`/`pending` counts).
