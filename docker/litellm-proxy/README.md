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
2. On the host: `diff` the repo copy against the live file. **First
   rollout only:** the live file predates this directory and was never
   vendored byte-for-byte (the fleet container that authored KEN-125 had no
   read access to it) — reconcile any live-only entries (extra model groups,
   env names, `pass_through_endpoints` blocks) INTO the repo copy first, so
   nothing silently regresses.
3. Copy the repo file over the host file.
4. Restart the LiteLLM service via Coolify (or `docker compose restart` in
   the service dir).
5. Verify: `curl -s http://127.0.0.1:4010/health/liveliness`, then confirm
   the fleet-health litellm sensor reports `ok` on its next scan.

## Version pin (`litellm-image.txt`)

Single non-comment line: the exact `image:` reference the host compose file
must use. Bump procedure: update the pin here (with changelog notes in the
PR), merge, then the operator edits the compose `image:` to match and
redeploys. The file currently carries an `UNVERIFIED-AGAINST-LIVE` marker —
the operator must replace the placeholder tag with the live deployed tag on
first reconcile. Only the host can answer *which* tag that is (the public
registry knows which tags exist, not which one this deployment runs), so read
it there:

```sh
docker inspect --format '{{.Config.Image}}' <litellm-container-name>
# or, for an immutable digest pin:
docker inspect --format '{{index .RepoDigests 0}}' <litellm-container-name>
```

Paste the result into `litellm-image.txt` and delete its
`UNVERIFIED-AGAINST-LIVE` notice — `src/litellm/repo-config.test.ts` couples
the two, so a placeholder without the marker (or a real tag that kept the
marker) fails the suite.

## What is deliberately NOT here

- **Secrets** — `os.environ/…` references only (`LITELLM_MASTER_KEY`,
  `DATABASE_URL`, `OPENROUTER_API_KEY` come from the service's env, managed
  in Coolify/vault).
- **Caching** — off by design (pass-through dominates; stale cache corrupts
  Hindsight memory ops). A scoped Redis recipe is commented in the yaml.
- **Virtual keys / teams** — provisioned at apply time by
  `src/litellm/provision.ts`, never in this file (`store_model_in_db: false`).
