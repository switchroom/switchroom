# LiteLLM proxy config (`litellm-config.yaml`) — repo-managed (KEN-125)

Repo-managed source of truth for the fleet LiteLLM proxy config
(`127.0.0.1:4010`). Companion to the sibling `../litellm-pacer/` directory,
which vendors the pass-through pacer module the same way.

## Why this directory exists

Until KEN-125 the proxy config lived **only** as an operator-maintained file
on the Coolify host — no versioning, no review, no tests, and the I2
OAuth-leak scoping (`docs/model-routing.md`) enforced purely by convention.
This directory makes the config reviewable and CI-checked:

- `litellm-config.yaml` — the config: `model_list` (non-Claude OpenRouter
  models + model-mapped Claude groups), `router_settings` retries/fallbacks,
  I2-scoped `model_group_settings`, pacer callback wiring.
- `litellm-image.txt` — the proxy image pin (see "Version pin" below).
- Guarded by `scripts/check-litellm-config-guard.mjs` (part of `npm run
  lint` — the repo copy is ALWAYS checked, so the guard is no longer vacuous
  in CI) and asserted by `src/litellm/repo-config.test.ts`.

**The repo copy is authoritative.** Changes belong here first (reviewed,
tested, linted), then get synced to the host by the operator — never edited
on the host and back-ported.

## Invariants (do not break)

1. **Pass-through is sacred.** Agent Claude traffic uses the URL-based
   `/anthropic` pass-through route (raw byte-forward). Nothing in
   `model_list` captures it, and Claude agent traffic must NOT be pointed at
   the model-mapped `/v1/messages` route — LiteLLM re-chunks that stream and
   long Opus responses stalled mid-stream (2026-07-05 incident; rationale in
   `src/agents/compose.ts` and `docs/model-routing.md`).
2. **I2 OAuth scoping.** `forward_client_headers_to_llm_api: true` only under
   Claude groups in `model_group_settings`; never global, never on
   `openrouter/*` / non-Claude groups. Lint + the fleet-health sensor
   (`src/fleet-health/litellm-config-sensor.ts`) both fail on a violation.
3. **G8 — the auth broker owns Claude failover.** Claude groups keep
   `num_retries: 1` plus a `fallbacks` chain; do not add LiteLLM-side retry
   churn on subscription accounts.

## Deploy path on the host (operator action — switchroom never touches it)

```
repo:  docker/litellm-proxy/litellm-config.yaml
host:  /data/coolify/services/<litellm-service-id>/litellm-config.yaml
       (from the root debugging agent: /host/data/coolify/services/…)
```

To roll out a change:

1. Merge the change here (CI green — lint guard + `repo-config.test.ts`).
2. On the host: **back up the live file**, then `diff` it against the repo
   copy and read every hunk. The first-rollout reconciliation is DONE
   (2026-07-25): the live file predated this directory and had never been
   vendored, so the repo copy was missing the whole Opus family, fable, haiku,
   most OpenRouter models, every `sr-*` name, the Voyage embeddings and the
   Presidio guardrails — syncing it then would have deleted live routing.
   Entry order now mirrors the live file so the diff stays readable. Two
   deliberate deltas remain and will show up in that diff:
   - repo-only: `openrouter/google/gemini-3.1-flash-lite` (the compiled-in
     Hindsight default in `src/setup/hindsight.ts`; additive on sync);
   - live-only: the disabled local-Ollama deployment blocks, not vendored
     because they hard-code LAN/Tailscale addresses of the operator's
     machines (host-specific detail, same rule as the Coolify service id).
     They are inert (in no routing group) but a blind copy removes them.
3. Copy the repo file over the host file.
4. Restart the LiteLLM service via Coolify (or `docker compose restart` in
   the service dir).
5. Verify: `curl -s http://127.0.0.1:4010/health/liveliness`, then confirm
   the fleet-health litellm sensor reports `ok` on its next scan.

## Version pin (`litellm-image.txt`)

Single non-comment line: the exact `image:` reference the host compose file
must use. Bump procedure: update the pin here (with changelog notes in the
PR), merge, then the operator edits the compose `image:` to match and
redeploys. The pin was verified against the live deployment on 2026-07-25 and
is stored digest-qualified (`<image>:<tag>@sha256:<digest>`): the tag half must
match the host compose `image:` line verbatim, the digest half makes it
immutable. Only the host can answer *which* tag is deployed (the public registry
knows which tags exist, not which one this deployment runs), so on any bump read
it there:

```sh
docker inspect --format '{{.Config.Image}}' <litellm-container-name>
# or, for an immutable digest pin:
docker inspect --format '{{index .RepoDigests 0}}' <litellm-container-name>
```

Paste the result into `litellm-image.txt`. `src/litellm/repo-config.test.ts`
enforces the shape (tag, digest, or tag@digest — never a floating tag) and
still couples the `REPLACE-WITH-LIVE-PINNED-TAG` placeholder to an
`UNVERIFIED-AGAINST-LIVE` marker, so a future placeholder can never ship
silently.

## What is deliberately NOT here

- **Secrets** — `os.environ/…` references only (`LITELLM_MASTER_KEY`,
  `DATABASE_URL`, `OPENROUTER_API_KEY`, `VOYAGE_API_KEY` come from the
  service's env, managed in Coolify/vault). `master_key` / `database_url` are
  not declared at all: LiteLLM reads them from the environment, which is how
  the live proxy runs.
- **Host-specific detail** — the Coolify service id (placeholdered as
  `<litellm-service-id>`) and the operator's LAN/Tailscale Ollama addresses.
- **Virtual keys / teams** — provisioned at apply time by
  `src/litellm/provision.ts`, never in this file.

Caching used to be listed here as "off by design". It is not: the live proxy
runs `cache: true` on Redis with a 600s TTL, and the reconciled file now says
so. The Anthropic `/anthropic` pass-through never reaches that layer.
`store_model_in_db` is likewise `true` live (UI model management), with the
consequence that a model added through the LiteLLM UI is not captured here and
will not survive a config-driven redeploy.
