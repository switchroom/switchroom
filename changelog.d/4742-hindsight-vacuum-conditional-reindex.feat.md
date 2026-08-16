- **hindsight: periodic `VACUUM (ANALYZE)` and measured conditional `REINDEX` (#4742)**

  The hindsight maintenance loop now runs a throttled whole-database
  `VACUUM (ANALYZE)` (default every 6h, `vacuumdb -j 4 --analyze` where
  available) and a weekly, measurement-gated
  `REINDEX INDEX CONCURRENTLY` sweep. Postgres' cumulative stats do not
  survive a container recreate on this deployment — `stats_reset` is NULL
  and `last_autovacuum` empty for every table minutes after a roll — so
  autovacuum's dead-tuple trigger keeps restarting from zero and can go
  unfired for long stretches. The payoff is the visibility map, not disk:
  three hot tables measured 35.1% / 25.2% / 86.3% all-visible before a
  manual vacuum and 99.0% / 100% / 99.2% after a 25-second run, and a low
  all-visible fraction forces heap fetches instead of index-only scans.
  The reindex rebuilds only btree indexes whose measured
  `avg_leaf_density` is below 70% (hnsw/bm25 indexes are excluded from
  the catalog query — `pgstatindex` errors on them and a rebuild is not a
  bloat fix), always CONCURRENTLY, guarded on free disk, capped at 3 per
  tick with the skipped count logged, and never in the same tick as the
  vacuum. `VACUUM FULL` is never issued. Off-switchable with
  `SWITCHROOM_HINDSIGHT_VACUUM=0` / `SWITCHROOM_HINDSIGHT_REINDEX=0`.
