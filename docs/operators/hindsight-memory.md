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

## LLM model selection (`hindsight.llm`)

The shared hindsight container runs its LLM operations (retain / reflect /
consolidation — recall is local-only, no LLM) through whatever model the
top-level `hindsight.llm` block selects. The flat form sets a **global
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
anything unset.

Takes effect on the next `switchroom memory setup` / rollout recreate of the
hindsight container (env is read at container launch).

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
