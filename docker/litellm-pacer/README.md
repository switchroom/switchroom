# Fleet LLM pacer (`custom_pacing.py`)

Fleet-wide request pacer for LiteLLM's Anthropic **passthrough** path. It runs
as a LiteLLM `CustomLogger` callback and smooths the burst that hits a single
Anthropic OAuth account when the switchroom auth-broker flips the whole fleet
onto it. Full mechanism is in the module docstring at the top of
`custom_pacing.py`.

## This directory is now the source of truth

Until 2026-07-13 this file lived **only** as a bind-mounted file on the Coolify
host, with no repo tracking, no tests, and no CI. That was a durability defect
(a fleet-critical hot-path module with no reviewable source of truth). This
directory fixes that:

- `custom_pacing.py` — the vendored module, **byte-for-byte identical** to the
  live deployed copy at vendor time.
- `test_custom_pacing.py` — stdlib `unittest` coverage of the pure decision
  logic (admit / cooldown / fail-open / Retry-After). Wired into the
  `ci-tests-python` GitHub Actions lane.

**The repo copy is authoritative.** Changes to the pacer belong here first
(reviewed + tested), then get synced to the host — never edited on the host and
back-ported.

## Deploy path on the host

The live copy is bind-mounted into the LiteLLM proxy container:

```
host:  /host/data/coolify/services/vhz4jc1tzvk6gdql8jueiwq4/custom_pacing.py
       (Coolify service dir; from inside this repo's root agent it is
        /host/data/... , on the raw host /data/coolify/services/...)
container: /app/custom_pacing.py   (the config dir is on the proxy's sys.path)
```

Wire-up in the sibling `litellm-config.yaml`:

```yaml
litellm_settings:
  callbacks: ["custom_pacing.pacer_instance"]
```

Bind mount in the sibling `docker-compose.yml`:

```yaml
volumes:
  - '/data/coolify/services/vhz4jc1tzvk6gdql8jueiwq4/custom_pacing.py:/app/custom_pacing.py'
```

## Code defaults vs. live env overrides

The module's **code defaults** (in `_Cfg`) are the conservative baseline and are
preserved here unchanged:

| Knob                   | Code default | Live deployment override (`docker-compose.yml`) |
|------------------------|:------------:|:-----------------------------------------------:|
| `PACE_MAX_CONCURRENCY` |      8       |                       16                        |
| `PACE_MAX_RPM`         |      60      |                       90                        |
| `PACE_MAX_RPS`         |      4       |                        6                        |
| `PACE_MAX_WAIT_S`      |      20      |                       12                        |
| `PACE_MAX_COOLDOWN_S`  |      60      |                       60                        |
| `PACE_LEASE_TTL_S`     |     300      |                       300                       |

**Tuning the running fleet is the deployment's job, via env** — set/adjust the
`PACE_*` vars in `docker-compose.yml` (or live via the same Redis keys). Do NOT
change the code defaults here to chase a live value; the repo copy stays the
safe baseline and the deployment layer owns the operating point.

## Layer 1 — cooldown-hold + hard-wait backstop (throughput safety)

Splits the single fail-open wait ceiling in `async_pre_call_hook` into two
regimes, plus one absolute backstop:

- **Burst-smoothing regime** (admission blocked only by concurrency/RPM/RPS, no
  active cooldown): unchanged — wait up to `PACE_MAX_WAIT_S` then fail open.
  Leaking here is benign smoothing.
- **Cooldown-HOLD regime** (Redis `cooldown_until` is in the future — Anthropic
  has *signalled* a throttle): instead of leaking at the ~12s burst ceiling,
  keep holding until the cooldown elapses, bounded by
  `PACE_COOLDOWN_HOLD_CEILING_S`. **Gated OFF by default** so merge + redeploy is
  behaviour-neutral until the env is set at rollout.
- **Absolute backstop**: `PACE_HARD_MAX_WAIT_S` caps *any* wait in *either*
  regime, enforced on every iteration of the wait loop, so a bug in the hold
  logic can never wedge a request longer than this. **Active by default** — it
  only ever shortens a pathological wait (default 45 > `MAX_WAIT_S`, so it never
  fires during normal burst-smoothing).

| Knob                          | Code default | Active by default? | Rollout value | Meaning |
|-------------------------------|:------------:|:------------------:|:-------------:|---------|
| `PACE_HARD_MAX_WAIT_S`        |      45      | yes (only shortens) |      45       | Absolute cap on any pacer wait, every regime, every iteration. Keep `< 300` (gateway silence watchdog) and `>= PACE_MAX_WAIT_S`. |
| `PACE_COOLDOWN_HOLD`          |    `false`   |  no (gate)          |    `true`     | Enables the cooldown-HOLD regime. Off = pre-L1 behaviour (fail open at `MAX_WAIT_S` even during a cooldown). |
| `PACE_COOLDOWN_HOLD_CEILING_S`|      60      |  only when hold on  |      60       | Max hold duration during an active cooldown. Keep `<= PACE_MAX_COOLDOWN_S`. |
| `PACE_RELEASE_JITTER_S`       |      1.0     |  only when holding  |     1.0       | Extra jitter window added to the backoff while holding, so held requests re-admit spread across this window when the cooldown elapses (thundering-herd guard) instead of stampeding one 1s window and re-tripping the 429. |

**Rollout env** (set alongside the existing live overrides in the deployed
`docker-compose.yml`, then redeploy litellm — this is the gated ROLLOUT step,
separate from this repo change):

```yaml
- 'PACE_HARD_MAX_WAIT_S=45'
- 'PACE_COOLDOWN_HOLD=true'
- 'PACE_COOLDOWN_HOLD_CEILING_S=60'
- 'PACE_RELEASE_JITTER_S=1.0'
```

Until `PACE_COOLDOWN_HOLD=true` is set, the only active change vs. today is the
45s absolute cap, which can only ever shorten a pathological (>45s) wait.

## Sync / redeploy step

After changing `custom_pacing.py` here (and getting it merged):

1. Copy the vendored file to the host deploy path:
   ```
   cp docker/litellm-pacer/custom_pacing.py \
      /data/coolify/services/vhz4jc1tzvk6gdql8jueiwq4/custom_pacing.py
   ```
   (Keep a timestamped `.bak` first, matching the existing host convention.)
2. **Redeploy / restart the LiteLLM service** so the proxy re-imports the
   callback module — a running proxy holds the old module in memory; the pacer
   is only reloaded on container (re)start. Redeploy the Coolify `litellm`
   service, or restart its container.
3. Verify the callback loaded (proxy logs mention `custom_pacing`) and that a
   passthrough request is being paced.

Changing only env knobs (`PACE_*`) also requires a container restart to re-read
env — unless you set the equivalent live Redis keys, which take effect
immediately.

> Full one-command deploy automation (copy + redeploy + verify) is a follow-up.
> P0 scope is: get the file in-repo, under test, with the sync documented.

## Running the tests locally

```
python3 -m unittest discover -s docker/litellm-pacer -p 'test_*.py'
```

Pure stdlib — no `pip install`. The test stubs the top-level `litellm` imports
via `sys.modules`, so neither `litellm` nor `redis` needs to be installed.
