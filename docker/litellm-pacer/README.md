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
host:  /host/data/coolify/services/<litellm-service-id>/custom_pacing.py
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
  - '/data/coolify/services/<litellm-service-id>/custom_pacing.py:/app/custom_pacing.py'
```

## Code defaults vs. live env overrides

The module's **code defaults** (in `_Cfg`) are the conservative baseline and are
preserved here unchanged:

| Knob                   | Code default | Live deployment override (`docker-compose.yml`) |
|------------------------|:------------:|:-----------------------------------------------:|
| `PACE_MAX_CONCURRENCY` |      8       |                       64                        |
| `PACE_MAX_RPM`         |      60      |                       90                        |
| `PACE_MAX_RPS`         |      4       |                        6                        |
| `PACE_MAX_WAIT_S`      |      20      |                       12                        |
| `PACE_MAX_COOLDOWN_S`  |      60      |                       60                        |
| `PACE_LEASE_TTL_S`     |     300      |                       60                        |

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
  regime, checked on every iteration of the wait loop, so a bug in the hold
  logic can't wedge a request meaningfully past it. The true worst-case wait is
  `PACE_HARD_MAX_WAIT_S` + at most one backoff interval + the final admit-check
  latency (≈46s for the default 45s), since the loop only notices the deadline
  between admit attempts — not a to-the-millisecond ceiling. **Active by
  default** — it only ever shortens a pathological wait (default 45 >
  `MAX_WAIT_S`, so it never fires during normal burst-smoothing). The value is
  also clamped at config load into `[PACE_MAX_WAIT_S, 280]` (280 < the 300s
  gateway silence watchdog), so an env misconfig can't drop it below the
  smoothing ceiling or push it into hang-looks-like territory.

| Knob                          | Code default | Active by default? | Rollout value | Meaning |
|-------------------------------|:------------:|:------------------:|:-------------:|---------|
| `PACE_HARD_MAX_WAIT_S`        |      45      | yes (only shortens) |      45       | Absolute cap on any pacer wait, every regime, checked every iteration. Clamped at load into `[PACE_MAX_WAIT_S, 280]` (280 < the 300s gateway silence watchdog), so an out-of-range env value is corrected automatically. |
| `PACE_COOLDOWN_HOLD`          |    `false`   |  no (gate)          |    `true`     | Enables the cooldown-HOLD regime. Off = pre-L1 behaviour (fail open at `MAX_WAIT_S` even during a cooldown). |
| `PACE_COOLDOWN_HOLD_CEILING_S`|      60      |  only when hold on  |      60       | Max hold duration during an active cooldown. Clamped at load to `<= PACE_MAX_COOLDOWN_S`. |
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
absolute cap, which can only ever shorten a pathological (roughly >45s) wait.

## Token-aware pacing (`PACE_MAX_TPM`)

A **4th admission predicate**: a fleet-wide rolling ~60s **token** budget layered
on top of the concurrency/RPM/RPS gates. Anthropic's per-minute burst ceiling is
a token ceiling as much as a request ceiling — a handful of huge-context turns
can 429 an account that the RPM gate would happily admit. `PACE_MAX_TPM` smooths
that.

**Disabled by default (`0`).** With `PACE_MAX_TPM=0` every bit of token logic is
inert: the Lua predicate short-circuits, the estimator is never called, and the
`litellm_pace:tokens` key is never written — so merging + redeploy is
behaviour-neutral until the env is set at rollout. Production sets `1200000`.

How it works:

- **Admit-time estimate.** A cheap, dependency-free char-count estimator
  (`_estimate_tokens`) reserves budget: input chars across messages / system /
  tools divided by `PACE_TPM_CHARS_PER_TOKEN`, plus a bounded output reservation
  (`min(max_tokens, PACE_TPM_OUTPUT_RESERVE)`), all scaled by `PACE_TPM_EST_MULT`.
  It deliberately does NOT call `litellm.token_counter` (too slow on the hot
  path) and NEVER raises — any error estimates 0.
- **Rolling budget in Redis.** A HASH `litellm_pace:tokens` keyed by 10s bucket
  (`floor(now/10)*10`); the rolling sum is the buckets newer than `now-60` (~7
  live buckets). The admit Lua sums them, HDELs stale buckets as it walks, and
  denies when `sum + est > PACE_MAX_TPM`. The predicate runs AFTER the RPS check
  and BEFORE the lease/rate writes, so a token denial takes no slot.
- **Single-oversized-request bypass.** A request whose own estimate already
  meets/exceeds the whole budget could never satisfy `sum+est<=maxtpm` and would
  burn the full wait ceiling every attempt — so it is admitted on its first
  attempt (still recording its tokens) rather than being starved.
- **Best-effort reconciliation.** Once real usage is known, the non-streaming
  passthrough success handler and the router success hook HINCRBY the delta
  (`actual - est`, may be negative; the Lua clamps the rolling sum at ≥0) into
  the current bucket so the budget converges on real spend. **Streaming requests
  keep their estimate** — the streaming wrapper is left byte-transparent
  (no SSE parsing), an accepted, bounded imprecision.
- **Observability.** `litellm_pace:tpm_denied` is INCR'd inside the Lua on a
  token-caused denial ONLY (not concurrency/RPM/RPS/cooldown denials), so
  operators can see whether the token gate is the thing throttling the fleet.

Everything still **fails open**: a token gate that can't reach Redis, or a
request that waits past the ceiling, proceeds unpaced (and its estimate is
best-effort booked so the budget stays honest).

| Knob                       | Code default | Rollout value | Meaning |
|----------------------------|:------------:|:-------------:|---------|
| `PACE_MAX_TPM`             |      0       |    1200000    | Rolling ~60s fleet-wide token budget. `0` disables the whole predicate (inert). `max(0, …)` so a negative can't invert the gate. |
| `PACE_TPM_OUTPUT_RESERVE`  |     2048     |     2048      | Output tokens reserved per request in the estimate, and the CAP on a caller's `max_tokens` so one request can't reserve an unbounded slice. |
| `PACE_TPM_CHARS_PER_TOKEN` |     4.0      |      4.0      | Char/token ratio for the input estimator. |
| `PACE_TPM_EST_MULT`        |     1.0      |      1.0      | Safety multiplier on the whole per-request estimate. |
| `PACE_TPM_CACHE_READ_WEIGHT`|    1.0      |      1.0      | Weight applied to cache-READ tokens during reconciliation (a value < 1 discounts them; 1.0 counts at par). |

**Rollout env** (set alongside the existing live overrides in the deployed
`docker-compose.yml`, then redeploy litellm — a gated ROLLOUT step, separate from
this repo change):

```yaml
- 'PACE_MAX_TPM=1200000'
```

Until `PACE_MAX_TPM` is set to a positive value, the token predicate is fully
inert and behaviour is identical to today.

## Sync / redeploy step

After changing `custom_pacing.py` here (and getting it merged):

1. Copy the vendored file to the host deploy path:
   ```
   cp docker/litellm-pacer/custom_pacing.py \
      /data/coolify/services/<litellm-service-id>/custom_pacing.py
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
