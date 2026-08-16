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

# 4. MANDATORY: rebuild per-bank vector index coverage.
#    A restored bank arrives populated, so it never hits the create-time index
#    path — recall silently under-returns until this runs. See "Vector index
#    coverage" below.
switchroom memory repair --all
```

## Rolling the base image FORWARD: the rollout gate

`scripts/hindsight-rollout-gate/` decides go/no-go for a Hindsight **server**
bump by measuring whether recall result sets and latency changed across the
restart. Read its `README.md` before the window; the essentials are here.

### Capture the baseline LIVE, minutes before the window

```sh
cd scripts/hindsight-rollout-gate
export HINDSIGHT_API_URL=http://127.0.0.1:18888

./rollout_gate.sh pre        # MINUTES before the maintenance window
# ... perform the upgrade ...
./rollout_gate.sh post       # captures, compares, prints the verdict
```

`post` reuses the run directory, API URL and pinned recency anchor recorded by
`pre`, so they cannot drift between the two halves.

> **Do not gate on an old frozen baseline.** The result-set comparison is
> meaningful in exactly one configuration: live-before vs live-after, same
> running instance, baseline captured minutes beforehand. WP6
> (switchroom#4533) proved the alternative empirically — comparing a captured
> baseline against **the same code** on a fresh restore of that instance's own
> dump flagged **30/30 cells at Jaccard 0.36–0.75** on completely healthy data.
> The number is dominated by physical row order (ties in `LIMIT`-ed retrieval
> arms have no deterministic tiebreaker), not by the code under test.
>
> The gate now enforces this rather than trusting it: each capture records the
> Postgres cluster identity (`pg_controldata`, read-only) and its capture time,
> and the comparator **refuses** a cross-instance or stale (>4h) baseline.

### Reading the verdict

| exit | meaning | what to do |
|---|---|---|
| `0` | **GATE PASS** | proceed; declared expected shifts are listed, check them |
| `1` | **GATE FAIL** | a verdict about the upgrade — investigate / roll back |
| `2` | **GATE MISUSE** | *not* a verdict. The two captures are not comparable (different instance, stale baseline, mismatched recency anchor). Fix the inputs and re-run. |

Exit 2 is deliberately distinct from exit 1. A red board that turns out to mean
"you used the gate wrong" trains you to ignore red.

`--allow-cross-instance` / `--allow-stale-baseline` downgrade those refusals to
warnings and stamp the report **ADVISORY ONLY**. They are for post-hoc
investigation, never for a rollout decision.

### Expected shifts

`expected_shifts.json` pre-declares cells known to move for an understood,
non-defect reason. A declared cell reports as `expected-shift` instead of
failing — but it is still printed with its measured Jaccard, in its own report
section, and it still FAILS if it drops below the declared band or if its
result count moves. If the declared shift does **not** occur, that is reported
too (`expected-shift-not-observed`): a declaration that has stopped matching
reality is stale and must be visible.

For 0.8.6 → 0.9.0 there is exactly one: **`temporal-relative`, band 0.60–0.85**.
`_select_with_temporal_coverage` (0.9.0 `retrieval.py:428`) stable-sorts on
similarity with no tiebreaker, so equal-similarity ties inherit SQL row order
and the temporal arm's entry points reshuffle. WP6 measured 0.688–0.793 on
byte-identical data, reproducible across restarts and a full
downgrade/re-upgrade cycle, count-neutral and latency-neutral. Declarations are
version-scoped, so this one retires itself once the fleet is past 0.9.0.

### Soak numbers

Latency medians/p90 are robust to organic ingest, so they still come from the
WP0 frozen window rather than a fresh capture:

```sh
./soak_measure.py --json soak-metrics-<date>.json           # pre
./soak_measure.py --since <rollout ts> --json <out>.json    # post-flight
```

## Rolling the base image BACK (schema first, then the digest)

`docker/Dockerfile.hindsight` pins upstream Hindsight by digest, and a bump
runs alembic migrations against the persisted `switchroom-hindsight-data`
volume. **Rolling forward is one step; rolling back is two, in this order.**

> **Reverting the pinned digest alone is not a rollback.** The older image
> boots fine and then fails at runtime. Alembic's startup path upgrades to
> `heads`, and when the database is at a revision the older code has never
> heard of it logs `Database is at a newer migration revision than this code
> version knows about … Skipping migrations` and carries on
> (`hindsight_api/migrations.py`). So nothing stops you at boot; the damage
> surfaces later, on whichever code path depends on a column the newer
> schema dropped.

### The order

1. **Downgrade the schema first, while the newer image is still running.**
   The newer image is the only one that has the down-revisions; the older one
   cannot reverse migrations it does not ship.
2. **Then repoint the digest** in `docker/Dockerfile.hindsight`, rebuild /
   pull, and recreate the container.
3. Take a `pg_dump` first (see "On-demand backup" above). A downgrade is not
   guaranteed to be lossless — see the caveat below.

### v0.9.0 → v0.8.6, concretely

**Do the alembic downgrade.** Rolling back properly here is a *full* repair —
nothing is left degraded — and skipping it costs you an entity-resolution
latency cliff that nothing alarms on. That asymmetry is the whole reason this
entry exists.

0.9.0 advances the head `c7d1e9a4b3f2` → `b3e8d1c6f4a9` over **five**
migrations, in this order (verified from
`hindsight-api-slim/hindsight_api/alembic/versions/`, `down_revision` chain
read revision by revision):

| # | Revision | Forward op | Downgrade restores |
|---|----------|-----------|--------------------|
| 1 | `a1c9e7f3b2d8` | `DROP CONSTRAINT IF EXISTS observation_history_observation_id_fkey` | DELETEs `observation_history` rows whose `observation_id` has no live `memory_units` row, then re-adds the FK |
| 2 | `a9b8c7d6e5f4` | `CREATE TABLE IF NOT EXISTS knowledge_pages` + 2 indexes | drops the table and its indexes |
| 3 | `e4a7c1b9d2f6` | `DROP COLUMN IF EXISTS access_count` on `memory_units` + `invalidated_memory_units` | re-adds the column `NOT NULL DEFAULT 0` and `idx_memory_units_access_count` (values are gone; nothing reads them) |
| 4 | `f2a6d8c4b1e9` | `DROP INDEX IF EXISTS idx_memory_units_embedding` (under `SET LOCAL lock_timeout='10s'`) | **deliberate no-op** — see "no vector cliff" below |
| 5 | `b3e8d1c6f4a9` | adds `entities.entity_kind` + CHECK, backfills it, builds the partial trgm index `entities_canonical_name_lower_trgm_nonlabel_idx` CONCURRENTLY, then drops the old full index | rebuilds the old full index CONCURRENTLY *first*, then drops the column (which takes the partial index and CHECK with it) |

The head to downgrade *to* is `c7d1e9a4b3f2` — 0.8.6's own head, i.e. the
`down_revision` of migration 1 above.

#### Step 1 — downgrade, while the 0.9.0 image is still running

```bash
docker exec switchroom-hindsight /app/api/.venv/bin/python - <<'PY'
from pathlib import Path
from alembic import command
from alembic.config import Config
import hindsight_api
from hindsight_api.migrations import _set_alembic_main_option
cfg = Config()
_set_alembic_main_option(
    cfg, "script_location", str(Path(hindsight_api.__file__).parent / "alembic"))
_set_alembic_main_option(cfg, "sqlalchemy.url", "<the libpq URL for pg0>")
command.downgrade(cfg, "c7d1e9a4b3f2")   # 0.8.6's head
PY
```

Confirm before moving on:

```bash
docker exec switchroom-hindsight sh -lc '
  PW=$(python3 -c "import json;print(json.load(open(\"/home/hindsight/.pg0/instances/hindsight/instance.json\"))[\"password\"])")
  PGPASSWORD="$PW" /home/hindsight/.pg0/installation/*/bin/psql -U hindsight -h /tmp -d hindsight -c \
    "SELECT version_num FROM alembic_version" -c \
    "SELECT indexname FROM pg_indexes WHERE tablename = '"'"'entities'"'"' AND indexname LIKE '"'"'%trgm%'"'"'"
'
```

Expect `c7d1e9a4b3f2`, `entities_canonical_name_lower_trgm_idx` **present**,
and `…_nonlabel_idx` **gone**.

#### Step 2 — then repoint the digest

Set `docker/Dockerfile.hindsight`'s digest and its
`# switchroom:hindsight-api-version=` marker back to 0.8.6, revert the
marker-coupled changes that shipped with the bump
(`HINDSIGHT_MIN_API_VERSION` in `src/memory/hindsight-tools.ts` and the
`tests/fixtures/hindsight-tools-list.snapshot.json` re-capture), rebuild/pull,
and recreate the container.

#### Why a proper downgrade here is a *full* repair

The one thing worth losing sleep over — 0.8.6's fuzzy entity resolution
losing its trigram index — is explicitly handled by the migration itself.
`b3e8d1c6f4a9`'s PG downgrade rebuilds the **exact original index**

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS entities_canonical_name_lower_trgm_idx
  ON entities USING GIN (LOWER(canonical_name) gin_trgm_ops)
```

inside an `autocommit_block`, and only *afterwards* runs
`ALTER TABLE entities DROP COLUMN IF EXISTS entity_kind` — which is what
removes the partial index. Coverage never lapses in either direction; the
comment in the source says so in as many words ("Restore the full index before
dropping the partial one so fuzzy probes keep index coverage throughout"). The
rebuild is CONCURRENTLY, so it does not lock `entities`, but it is not free —
budget tens of seconds at fleet scale (~226k entity rows / ~77 MB) and do not
kill it midway (a cancelled CONCURRENTLY build leaves an INVALID index behind).

The only fidelity loss in the whole chain is cosmetic: `access_count` values
(nothing in switchroom reads them) and `knowledge_pages` rows (the table
arrives inert — we do not use Knowledge Pages).

#### Naive rollback (digest repoint, no downgrade): one cliff, and only one

It does **not** explode. 0.8.6 boots against a 0.9.0 database: its startup
migration runner catches the revision-resolution error and logs
`Database is at a newer migration revision than this code version knows about.
This is expected during rolling deployments. Skipping migrations.`
(v0.8.6 `hindsight_api/migrations.py`, the `ResolutionError` / `CommandError`
handler around the `command.upgrade(cfg, "heads")` call). The server then
serves normally.

What you get instead is a **silent entity-resolution latency cliff, and
nothing else**:

- `entity_kind` still exists (you didn't downgrade), so the surviving trigram
  index is the partial one, `WHERE entity_kind != 'label'`.
- 0.8.6's candidate query has no `entity_kind` predicate — it is just
  `e.bank_id = $1 AND LOWER(e.canonical_name) % LOWER(q.query_text)`
  (`engine/entity_resolver.py`, the trigram candidate fetch). The planner
  cannot prove that query implies the partial index's predicate, so it will
  not use the index.
- Result: every fuzzy entity probe sequential-scans `entities` (~77 MB).
  Recall still returns correct results — just slowly, with no error anywhere.

Detection: entity-resolution stage latency in recall timings, plus
`pg_stat_user_tables.seq_scan` climbing on `entities`.

Repair without re-upgrading — recreate the old index by hand (CONCURRENTLY, so
it is safe on a live table):

```bash
docker exec switchroom-hindsight sh -lc '
  PW=$(python3 -c "import json;print(json.load(open(\"/home/hindsight/.pg0/instances/hindsight/instance.json\"))[\"password\"])")
  PGPASSWORD="$PW" /home/hindsight/.pg0/installation/*/bin/psql -U hindsight -h /tmp -d hindsight -c \
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS entities_canonical_name_lower_trgm_idx ON entities USING GIN (LOWER(canonical_name) gin_trgm_ops)"
'
```

#### There is NO vector-index cliff on this fleet

Say it plainly, because an early draft of the upgrade plan claimed there was
one and it was wrong: migration `f2a6d8c4b1e9` drops
`idx_memory_units_embedding`, **and that index does not exist on our
deployment**. Vector search here is served by 45 bank-scoped *partial* indexes
(`idx_mu_emb_{expr,obsv,worl}_<hash>`, the ones `switchroom memory repair`
maintains — see "Vector index coverage" below), which `f2a6d8c4b1e9` does not
touch. So the forward migration is a `DROP INDEX IF EXISTS` against nothing —
a clean no-op — and its downgrade is a deliberate `pass` ("recreating a
potentially multi-GB vector index that no query uses is not a safe downgrade
action"). **Neither direction, proper or naive, degrades vector recall.** Do
not add a vector-index step to this procedure, and do not let the `f2a6` no-op
downgrade look like a gap that needs filling.

Confirm for yourself in ten seconds if you are mid-incident and want the fact
rather than the claim:

```bash
docker exec switchroom-hindsight sh -lc '
  PW=$(python3 -c "import json;print(json.load(open(\"/home/hindsight/.pg0/instances/hindsight/instance.json\"))[\"password\"])")
  PGPASSWORD="$PW" /home/hindsight/.pg0/installation/*/bin/psql -U hindsight -h /tmp -d hindsight -c \
    "SELECT indexname FROM pg_indexes WHERE tablename = '"'"'memory_units'"'"' AND indexname LIKE '"'"'%emb%'"'"'"
'
```

If `idx_memory_units_embedding` is absent from that list (it is), the vector
question is settled.

### v0.8.6 → v0.8.5, concretely

**This one is safe to roll back by repointing the digest alone** — and that is
a statement about this single revision, not a relaxation of the rule above.

0.8.6 advances the head `d7b2f8a1c934` → `c7d1e9a4b3f2`
(`c7d1e9a4b3f2_add_archive_causal_links`) over exactly one migration, which
does

```sql
ALTER TABLE invalidated_memory_units
  ADD COLUMN causal_links JSONB NOT NULL DEFAULT '[]'
```

Three properties make the rollback clean, all of them checked rather than
assumed:

- **It is additive.** Nothing is dropped or retyped, so no column 0.8.5 needs
  goes missing — the inverse of the `search_vector` situation below.
- **0.8.5 never sees the new column.** Its archive round-trip builds the column
  list by introspecting `memory_units` (`_memory_unit_columns`,
  `engine/memory_engine.py:6638-6652`), and the new column is on
  `invalidated_memory_units` — the archive table — only.
- **The migration is metadata-only on PG 11+** (a non-volatile default is not a
  table rewrite), so the forward step is cheap: measured at **5.5 ms** on a
  fleet-sized bank.

The alembic `downgrade` is a clean `DROP COLUMN` if you want the schema back at
0.8.5's head exactly; it drops archived causal-link data, which 0.8.5 cannot
read anyway.

> **Do NOT generalise this.** It happens to be true of
> `c7d1e9a4b3f2` because that revision is additive and archive-scoped. The
> next bump's revision has to be read on its own terms — the ordered,
> schema-first procedure above remains the default.

### v0.8.5 → v0.8.4, concretely

0.8.5 advances the head `b57a7c9e0d13` → `d7b2f8a1c934` over four
migrations. The one that matters for a rollback is
`e7c3a9f1b2d5_drop_archive_search_vector_column`, which does

```sql
ALTER TABLE invalidated_memory_units DROP COLUMN IF EXISTS search_vector
```

**0.8.4 requires that column.** Its archive round-trip builds the column list
from `memory_units` and excludes only `"embedding"`
(`engine/memory_engine.py:6579`), where 0.8.5 excludes `"embedding"` *and*
`"search_vector"`. 0.8.4 has no special-casing for it at all
(`grep -c search_vector` on 0.8.4's `memory_engine.py` → 0), so on 0.8.4
against a 0.8.5 schema **every `invalidate_memory`, and every revert of an
invalidated memory, fails with `column "search_vector" does not exist`.**

Downgrade the whole 0.8.5 chain back to 0.8.4's head *before* repointing the
digest:

```bash
docker exec switchroom-hindsight /app/api/.venv/bin/python - <<'PY'
from pathlib import Path
from alembic import command
from alembic.config import Config
import hindsight_api
from hindsight_api.migrations import _set_alembic_main_option
cfg = Config()
_set_alembic_main_option(
    cfg, "script_location", str(Path(hindsight_api.__file__).parent / "alembic"))
_set_alembic_main_option(cfg, "sqlalchemy.url", "<the libpq URL for pg0>")
command.downgrade(cfg, "b57a7c9e0d13")   # 0.8.4's head
PY
```

The other three down-revisions in the chain only drop indexes and maintenance
routines that 0.8.4 does not use, so the full downgrade is the clean target
rather than a partial one.

If you would rather not run alembic, the single statement that unblocks 0.8.4
is the migration's own `_pg_downgrade` body, verbatim and idempotent:

```bash
docker exec switchroom-hindsight sh -lc '
  PW=$(python3 -c "import json;print(json.load(open(\"/home/hindsight/.pg0/instances/hindsight/instance.json\"))[\"password\"])")
  PGPASSWORD="$PW" /home/hindsight/.pg0/installation/*/bin/psql -U hindsight -h /tmp -d hindsight -c \
    "ALTER TABLE invalidated_memory_units ADD COLUMN IF NOT EXISTS search_vector tsvector"
'
```

That leaves `alembic_version` reading a revision 0.8.4 does not know, which
0.8.4 tolerates (the skip above) — acceptable as an emergency unblock, but the
alembic downgrade is the state you actually want.

### The caveat: a correct rollback still loses BM25 coverage

**The re-added column comes back empty.** Upstream says so in the migration
itself — *"Re-added as the original tsvector creation type; comes back empty
regardless"* — and nothing backfills it. Every memory archived while the fleet
ran on 0.8.5 therefore has `search_vector IS NULL` after the downgrade. On
0.8.4 those rows still round-trip, but when one is reverted out of the archive
it lands back in `memory_units` with a NULL `search_vector`, i.e. **silently
absent from the BM25 arm of recall** until something re-indexes it. Semantic
and graph recall are unaffected.

So: the ordered rollback restores *function*, not *fidelity*. If those
archived memories matter, restore from a pre-upgrade `pg_dump` instead of
downgrading in place.

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

## LLM model selection (`hindsight.llm`)

The shared hindsight container runs its LLM operations (retain / reflect /
consolidation — recall is local-only, no LLM) through whatever model the
top-level `hindsight.llm` block selects. For how this routing keeps Claude
traffic subscription-native and where the per-op routing gaps are, see
[`docs/model-routing.md`](../model-routing.md). The flat form sets a **global
default** for every op:

```yaml
hindsight:
  llm:
    provider: claude-code               # global default provider
    model: openrouter/z-ai/glm-5.2      # global default model
```

Each op can be overridden individually with an optional `retain` / `reflect`
/ `consolidation` sub-block. Any field you omit inherits the global (that is
the engine's own fallback — switchroom emits only the vars you set, so an
absent op sends nothing):

```yaml
hindsight:
  llm:
    provider: claude-code
    model: openrouter/z-ai/glm-5.2      # global default stays as-is
    retain:
      model: gpt-oss-20b                # cheap model for ingestion
    reflect:
      model: gpt-oss-120b               # stronger model for synthesis
    # consolidation: omitted → inherits the global model
```

Per-op fields: `model`, `provider`, `base_url`, `api_key` (all optional,
`base_url`/`api_key` are passthrough for a per-op provider that needs its own
endpoint/credential; `api_key` accepts a `vault:` reference). These map to the
engine's `HINDSIGHT_API_<OP>_LLM_MODEL` / `_PROVIDER` / `_BASE_URL` /
`_API_KEY` env vars, with the global `HINDSIGHT_API_LLM_*` as the fallback for
anything unset. There is one more per-op field, `context_window`, which is not
an env var at all — see below.

### Declare the backend's context window (`context_window`)

`hindsight.llm.context_window` declares how many tokens the backend serving
hindsight actually accepts. Switchroom derives the token budget from it —
consolidation batch size, the retain / consolidation `max_completion_tokens`
caps, and the reflect `max_context_tokens` cap — so a single call cannot
overflow the window:

```yaml
hindsight:
  llm:
    provider: litellm
    model: openai/gpt-oss-20b
    context_window: 32768        # llama.cpp -c 65536 -np 2 → 32768 per slot
    consolidation:
      context_window: 131072     # this lane routes to a big-window model
```

Absent → a per-provider default: `200000` for `claude-code`, a deliberately
conservative `32768` for anything else (a non-Claude provider in switchroom
usually means LiteLLM in front of a local llama.cpp / Ollama slot). All three
lanes — `retain`, `reflect`, `consolidation` — are budgeted independently, so a
per-op `context_window` only ratchets that lane.

**Set this if you self-host the backend.** A context overflow on llama.cpp is
*silent*: with `--context-shift` it discards the oldest tokens and keeps only
the first `--keep`, which is exactly where the system prompt and JSON schema
live, so the model then answers conversationally and returns **HTTP 200 with
`finish_reason: stop`**. Nothing errors; retain and consolidation just quietly
stop extracting. On the reference fleet that ran undetected for a week at a
44–47% malformed-response rate, against 2% for the same model on a
131k-window route. Declaring the window turns it into a loud failure at
`switchroom memory setup` time instead of never — an over-budget declaration
aborts the launch with the arithmetic that doesn't fit.

Under-declaring costs throughput (smaller batches, more LLM calls);
over-declaring corrupts memory. When in doubt, under-declare.

Takes effect on the next `switchroom memory setup` / rollout recreate of the
hindsight container (env is read at container launch).

### Capability-gated tunings you don't have to set

Switchroom emits these automatically when it can prove the host qualifies, so
they survive a container recreate instead of having to be re-applied by hand.
Override any of them through `hindsight.env` (an operator value always wins,
even when the gate is off).

| Var | Emitted when | Value | Why |
|-----|--------------|-------|-----|
| `HINDSIGHT_API_LLM_STRICT_SCHEMA` | LLM endpoint is self-hosted | `true` | Without it a local `gpt-oss:20b` prefixes prose to its JSON; ~45% of retain/consolidation calls then fail to parse. Upstream defaults it `False`. |
| `HINDSIGHT_API_LLM_MAX_RETRIES` | LLM endpoint is self-hosted | `2` | A local endpoint isn't rate-limited, so upstream's `3` mostly adds latency to a call that will fail the same way. |
| `HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE` | container can reach a GPU | `128` | Upstream's `32` is the CPU/MPS value. Measured on CUDA: rerank of 150 candidates `4.347s → 0.174s`, recall p50 `3.2s → 0.8s`. A 128-wide batch on CPU is a regression, hence the gate. |

"Self-hosted" is decided by `hindsightLocalLlmEnabled()` — a loopback, LAN, or
`*.local` base URL on `hindsight.llm` or the LiteLLM proxy. The GPU gate is the
same one that adds `--gpus all`.

**Changing models?** Follow the step-by-step runbook in
[`hindsight-model-change.md`](hindsight-model-change.md) — it covers the two
routing lanes (per-op `model:` alone does NOT reroute under a `claude-code`
global; see `docs/model-routing.md` G1/G5), the recreate-from-the-host
requirement, verification, and rollback.

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

## Vector index coverage (`switchroom memory repair`)

Hindsight creates a bank's per-`(bank, fact_type)` **partial vector indexes**
at bank-creation time — instant, because the bank is empty. A bank that
arrives **already populated** never takes that path:

- a logical restore (`switchroom memory` restore, `import-bank`, a `pg_dump`
  reload),
- a cross-version upgrade that repopulates rows outside the create path,
- a vector-extension / backend switch.

Recall on such a bank does not fail. It falls back to the **global** index plus
a post-filter and quietly **under-returns**. This is not a hypothetical: this
fleet ran that way, with several banks returning single-digit semantic
candidates out of a 100-candidate budget, for roughly three months. Nothing
went red, because every surface was checking liveness rather than coverage.

Upstream shipped detection + repair in **0.8.5**
([vectorize-io/hindsight#2645](https://github.com/vectorize-io/hindsight/issues/2645)).
Switchroom exposes it:

```bash
# See what is missing without touching anything.
switchroom memory repair --all --dry-run

# Repair one bank, by bank id or by the agent that owns it.
switchroom memory repair --bank agent_overlord
switchroom memory repair --agent overlord

# Repair the whole fleet.
switchroom memory repair --all
```

Rebuilds use `CREATE INDEX CONCURRENTLY`, so they never block live
retain/recall/consolidation. The command is **idempotent and safe to re-run** —
a failed index is dropped, and re-running is the documented retry.

`--dry-run` is scriptable — it reports coverage through the **exit code**, not
only through prose:

| Exit | Meaning |
|------|---------|
| `0` | Coverage **confirmed** complete — at least one bank scanned, nothing to create. |
| `3` | Indexes are **missing**. Recall on those banks is under-returning. |
| `4` | Coverage **could not be confirmed**: no summary line, or zero banks scanned (a mistyped `--bank`/`--schema` looks exactly like this). Nothing is known to be fine. |
| `1` | The check/repair itself failed (see output; a re-run is the retry). |

`4` is deliberately not `0`. "The command ran and I learned nothing" is the
failure mode this whole feature exists to eliminate, so it is never reported as
a pass. And the meaningful codes avoid `2` on purpose: the underlying admin CLI
is a typer app that exits `2` on a **usage** error, and `switchroom memory
repair` never re-emits the child's code — a mistyped flag is `1`, never
"coverage missing".

Notes:

- **Requires hindsight ≥ 0.8.5** (`HINDSIGHT_REPAIR_MIN_API_VERSION`). Against
  an older server the verb refuses with the reason, rather than the admin CLI's
  bare `No such command`. This is a *feature* floor and is checked at the point
  of use only — it deliberately does not make `switchroom doctor` red, because
  the doctor row tracks the MCP-contract floor (`HINDSIGHT_MIN_API_VERSION`,
  the version the committed tools/list snapshot was captured from). A standing
  red row for a capability you are not trying to use just teaches people to
  ignore doctor.
- **It will not remove the legacy global index.** `idx_memory_units_embedding`
  survives on instances that predate the per-bank scheme, and `repair-bank`
  does not drop it. Removing it is a manual `DROP INDEX CONCURRENTLY` decision.
- **Run it after every restore.** The restore path is the single most reliable
  way to produce a bank with no coverage, and it is silent.

## Chat-visible memory surfaces (what agents show users)

Memory is no longer entirely invisible. Three operator-visible behaviours
shipped as part of the Hindsight synthesis-layers work (RFC
`reference/rfcs/hindsight-synthesis-layers.md`). All are default-on and
opt-out per the switchroom conventions.

### Legibility lines (📌 / ✂️ / 🧠)

When an interactive agent turn *materially changes* what it remembers, it
posts ONE terse line into the originating chat/topic — never on ordinary
recall, never per-turn:

| Line | Fires on | Path |
|------|----------|------|
| `📌 remembered: "<directive>"` | a `create_directive` call | tool-observation (#2858), **default-on** |
| `✂️ forgot: <reason>` | an `invalidate_memory` or demote-tagged `update_memory` | tool-observation (#2858), **default-on** |
| `🧠 updated what I know about Y` | a background consolidation storing/correcting a durable observation | consolidation-webhook (#2872), **dormant + OFF** |

- **Store/correct side (📌 / ✂️)** is a deterministic tool-call observation —
  no model call, no polling. Opt out per-agent/fleet with the env var
  `SWITCHROOM_MEMORY_LEGIBILITY=0` (only the literal `0` disables).
- **Update side (🧠)** depends on a `consolidation.completed` webhook and stays
  dormant — but **not** for the reason this page used to give. It claimed the
  pinned engine does not emit the event. It does: `WebhookEventType.
  CONSOLIDATION_COMPLETED` is emitted from `hindsight_api/engine/
  memory_engine.py` in **both 0.8.4 and 0.8.5**, and the event is in the
  documented supported set (`retain.completed`, `consolidation.completed`,
  `memory_defense.triggered`). What is missing is on the switchroom side:
  nothing registers a webhook subscription with hindsight and there is no
  receiver endpoint, so the consumer
  (`telegram-plugin/consolidation-legibility.ts`) is never fed. It is also OFF
  by default (`SWITCHROOM_CONSOLIDATION_LEGIBILITY=1` to opt in). Enabling it
  today does nothing; the work required is a subscription + receiver, not an
  engine bump.

### Directive-capture nudge + verifier (Phase 3)

To make user corrections stick, two deterministic hooks backstop the model's
own judgment. The shape is **regex-detect → nudge → one bounded verifier
block, and the model still writes the directive** (no silent hook-side write):

- **Stage B nudge** (`recall.py`, UserPromptSubmit): regex-detects
  correction / standing-rule inbound ("always/never …", "from now on …",
  "stop doing …", a stated preference, "that's wrong, it's …") and appends a
  terse advisory telling the model to persist the rule with `create_directive`
  *if it is durable*.
- **Stage C verifier** (`directive_verify.py`, Stop): after the turn, if a
  durable-rule inbound recorded no `create_directive` call, blocks the stop
  **once** to re-prompt capture. The single-block guard prevents a re-prompt
  loop.

**Config knob:** `agents.<name>.memory.directive_capture_nudge` (schema
default `true`; also accepted at the `defaults`/profile tier). Setting it
`false` exports `HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE` to the hooks and disables
**both** stages. Known limitation: a restated rule can currently re-nudge /
re-block (dedup is tracked as a follow-up).

### Per-bank missions + disposition (Phase 2)

Each agent's memory bank can be shaped per specialist via config (all cascade
override / per-key merge, `src/config/schema.ts`):

| Field | Effect |
|-------|--------|
| `memory.retain_mission` | steers fact extraction on retain |
| `memory.reflect_mission` (a.k.a. legacy `bank_mission`) | steers the reflect read path |
| `memory.reflect_budget` | `low`\|`mid`\|`high` budget injected into reflect MCP calls when the caller omits it (shim default `mid`); explicit per-call `budget` wins; stdio-shim transport only |
| `memory.observations_mission` | steers observation synthesis |
| `memory.disposition` | `{ skepticism, literalism, empathy }` (0–5 each), per-key inheritable |

On a zero-YAML install, built-in `PROFILE_MEMORY_DEFAULTS` already differentiate
the shipped profiles (health-coach leans empathy-high; coding /
executive-assistant lean skeptical + literal). Operator config overrides per
key.

`observations_mission` is the one switchroom seeds and keeps current itself.
Precedence is **operator yaml > profile default > fleet default**:

- `coding`, `executive-assistant` and `health-coach` each ship their own
  consolidation mission. The two work profiles deliberately tell the
  consolidator that operational state (versions, open work, outstanding
  obligations) is durable knowledge and must be recorded with the date inline —
  it would otherwise be dropped by the engine's "purely ephemeral facts → omit"
  rule. `health-coach` deliberately does not, because a single day's reading
  genuinely is ephemeral there.
- Any other profile, including `default`, gets `DEFAULT_OBSERVATIONS_MISSION`.

Seeding is read-first and never clobbers: switchroom pushes only when the bank's
value is unset or byte-equals a text switchroom itself shipped, so a mission you
wrote through the Hindsight API is left alone forever. `switchroom doctor` shows
each bank's live value as a `bank <id> observations_mission` row, and warns when
one is unset (that bank is consolidating under Hindsight's stock mission) or is
waiting on a `switchroom agent reconcile <agent>`.

### Curated mental models + the curator skill (Phase 5)

Mental models are pinned, named, self-refreshing reflections over a bank. Two
operator-facing ways to add them, both leash-clean (never a silent self-write):

- **Declarative:** `agents.<name>.memory.mental_models[]` —
  `{ name, source_query, refresh_after_consolidation?, max_tokens? }`,
  **per-agent tier only** (never `defaults`/profile, so a model can't be pushed
  fleet-wide in one line). Ensured create-if-absent by exact name on scaffold
  and reconcile. Zero declarations = zero models. `refresh_after_consolidation`
  defaults **off** — turn it on per model, deliberately, since a refresh adds
  bounded (~2048 tok) invisible post-consolidation spend and can hit the
  reflect wall-timeout.
- **Agent-proposes → you approve:** the `mental-model-curator` skill (shipped
  **default-on fleet-wide**, #2883) surveys the agent's own bank and PROPOSES
  models via a `[✅ Approve] [🚫 Deny]` card (`mental_model_propose`). On
  approval, hostd appends the model to `memory.mental_models[]` and reconciles
  — the same declarative path above. The agent can never self-approve; your tap
  is the only gate. Identity / "who is the user" models are steered away from
  here (that lives in profile banks).

See `reference/rfcs/hindsight-phase5-mental-model-curation.md` for the full
design and the deliberately-deferred follow-ups (cron-driven proposals, any
fleet-wide default model).

## Shared repo bank (`switchroom-dev`) — repo knowledge

Constraint 2 of the memory-redesign RFC (`reference/rfcs/memory-redesign-2026-08.md`,
RFC item P6) is that shared memory is **repos only** — not general cross-agent
memory, not person-profile banks. The mechanism is a single shared bank,
`switchroom-dev`, that any agent can write durable repository knowledge into so
every agent that touches the repo inherits it.

### The convention (prompt half)

Auto-retain always resolves the agent's OWN bank (`derive_bank_id`,
`vendor/hindsight-memory/scripts/lib/bank.py`), and that asymmetry is
deliberate and unchanged — nothing routes conversation-level auto-retain to a
shared bank. What is new is fleet guidance (`MEMORY_GUIDANCE` in
`src/agents/scaffold.ts`, rendered into
`~/.switchroom/fleet/switchroom-invariants.md`): when an agent learns a durable
fact **about a repository** — a build invariant, a migration gotcha, a
house-style rule — it makes an explicit call that names the bank:

```
mcp__hindsight__retain(
  content="switchroom's vitest suite must run single-threaded — the shared "
          "worker pool corrupts the tmpdir scaffold fixtures",
  bank_id="switchroom-dev",
  tags=["repo:switchroom", "build"],
)
```

`retain` is pre-approved for every agent and accepts `bank_id`
(`src/cli/hindsight-mcp-shim.ts`), so no new write path is added — this reuses
the surface that already exists. Only durable, repo-scoped facts belong here;
conversation, user preferences, and anything about a person stay in the agent's
own bank. Every shared write is tagged `repo:<name>` for findability. The read
side is untouched — ordinary `recall` / `reflect` already reach the bank.

### The boundary (config half)

`additional_banks` is recall scoping and explicitly **not** an access boundary
(`src/config/schema.ts`). The only enforcement point is the bank's own
`mcp_enabled_tools` allowlist, set via `update_bank(config_updates=…)`
(`src/cli/hindsight-mcp-shim.ts`). Setting it on `switchroom-dev` to just the
tool set repo knowledge needs — write plus read — turns constraint 2 from a
convention into a boundary a prompt-injected agent cannot step past on that
bank. (This is a live shared-bank mutation, applied out-of-band, not part of
the repo change that shipped the guidance.)

### Measurement

The prompt half is prompt-dependent, so it is measured, not assumed. The single
unambiguous number is **writes per week to `switchroom-dev`** (its baseline was
13 facts total, last written 2026-08-07). Read
`switchroom memory recall-log` for the read side, and the bank's document/fact
counts (`get_bank_stats` / `list_documents`, or `switchroom doctor`'s per-bank
rows) for the write side. If the write rate does not move — fewer than one
write per agent per week over four weeks — the prompt approach has not landed
and the convention should be re-scoped to a deterministic trigger rather than
left running as dead guidance.
