- **hindsight: log injected directive IDs on `recall_log` rows (#4738)**

  Memory-redesign step 1 (probes/instrumentation, no behaviour change):
  `state/recall_log.jsonl` now carries `directive_ids`, the ids of the
  directives actually injected into `<active_directives>` this turn (the
  post-cap head-slice, in priority order), alongside the existing
  `directive_count`/`directives_omitted` volume fields. `null` on a cache-hit
  row, matching those two fields. Makes directive exposure — including
  "never once injected" — queryable before any change to what gets
  injected. `injected_score_min/median/max` (per-memory recall-quality
  telemetry) and the `recall.py` scores-API comment (E-24) were already
  correct on `main` — no change needed there.
