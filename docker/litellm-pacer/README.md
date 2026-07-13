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
