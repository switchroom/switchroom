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
- **Update side (🧠)** depends on a `consolidation.completed` webhook the
  pinned hindsight image (v0.8.4) does **not** emit, so the consumer
  (`telegram-plugin/consolidation-legibility.ts`) stays dormant. It is also
  OFF by default; an operator opts in with `SWITCHROOM_CONSOLIDATION_LEGIBILITY=1`,
  but it does nothing until an engine that emits the webhook is pinned.

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
| `memory.observations_mission` | steers observation synthesis |
| `memory.disposition` | `{ skepticism, literalism, empathy }` (0–5 each), per-key inheritable |

On a zero-YAML install, built-in `PROFILE_MEMORY_DEFAULTS` already differentiate
the shipped profiles (health-coach leans empathy-high; coding /
executive-assistant lean skeptical + literal). Operator config overrides per
key.

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
