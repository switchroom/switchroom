# Buildkite CI

This directory drives switchroom's CI on Buildkite. The pipeline runs three test
stages on every commit, plus an optional skills-eval stage that exercises the
prompts inside `skills/` against a real Claude model.

## Files

| File | Purpose |
|------|---------|
| `pipeline.yml` | The full pipeline definition (lint, tests, evals, summary annotation, badge publish) |
| `annotate-evals.sh` | Reads `evals/results/*.json` and posts a Buildkite annotation summarising pass rates |
| `publish-badges.sh` | Writes shields.io-compatible badge JSON for tests + trigger evals + quality evals into a public Gist so the repo README can render dynamic status badges. Best-effort; swallows errors. Needs `GITHUB_GIST_TOKEN` cluster secret. |

## One-time setup in Buildkite

1. Create a new pipeline pointing at this repo (`switchroom/switchroom`).
2. Set the **initial command** in Pipeline Settings to:
   ```
   buildkite-agent pipeline upload
   ```
3. (Optional, for the eval stages) Add `ANTHROPIC_API_KEY` under
   Pipeline Settings → Environment Variables, or expose it via an agent
   environment hook. Without it, the eval steps are gated off and the build
   stops at the test stage.
4. Pick an agent queue. The pipeline defaults to `queue: "default"`; override
   in `pipeline.yml` if you have a dedicated queue.

## Agent prerequisites

The agent box needs:

- `bun` — TypeScript runtime + test runner (used for both `vitest` and
  `bun test`)
- `python3` with `pip` — eval runners use `pyyaml`
- `claude` — only needed for the eval stages; install with
  `npm i -g @anthropic-ai/claude-code`

## Stage map

| Stage | Command | When it runs (`if_changed`) |
|-------|---------|------------------------------|
| Type check | `bun lint` (= `tsc --noEmit`) | Any `*.ts`, `tsconfig.json`, package/lockfile |
| Core tests | `bun run test:vitest` | `src/`, `tests/`, `telegram-plugin/**/*.ts`, vitest config, lockfiles |
| Plugin tests | `cd telegram-plugin && bun test` | `telegram-plugin/**` |
| UAT fuzz (gated) | `pipeline upload .buildkite/pipeline.uat.yml` → `bun run test:uat fuzz-` (self-hosted `uat-host` queue) | `telegram-plugin/**`, `src/agents/**`, `telegram-plugin/uat/**`, `vitest.uat.config.ts` — only when `SWITCHROOM_UAT_GATE_ENABLED=true` |
| Trigger evals | `python3 evals/run_trigger.py --parallel 5` | `skills/**/SKILL.md`, eval framework, profile CLAUDE.md |
| Quality evals | `python3 evals/run_quality.py --parallel 5` | `skills/**/SKILL.md`, eval framework, dataset |
| Eval summary | `annotate-evals.sh` | Always (after eval steps); no-ops if no result files |

A pure-docs commit (no `*.ts`, `*.py`, `*.yml`, or `SKILL.md` changes) builds
empty after the pipeline upload — zero compute. Touching
`.buildkite/pipeline.yml` re-runs every step (it's listed in every
`if_changed:` so a pipeline change is its own integration test).

## Local validation

Validate the pipeline YAML before pushing:

```bash
# Syntax check
bk pipeline lint .buildkite/pipeline.yml

# Or via the agent
buildkite-agent pipeline upload --debug --dry-run < .buildkite/pipeline.yml
```

## Secrets

The Buildkite API token (`bkua_*`) is stored in switchroom's encrypted vault under
the key `buildkite-api-token`. Retrieve it with:

```bash
switchroom vault get buildkite-api-token
```

Use it for any `bk` CLI calls that need API access (creating pipelines,
triggering builds, listing agents). It is **not** needed by the pipeline
itself — Buildkite agents authenticate via their own per-agent token.

## UAT fuzz step

The `:robot: UAT fuzz (real Telegram)` step gates every PR that touches
`telegram-plugin/`, `src/agents/`, or `telegram-plugin/uat/` against the
second-pass fuzz harness (PR #1132 / #1134 / #1136 human-style). The
harness drives a real mtcute MTProto user session against a real test
bot in a real supergroup — it cannot run on the stock hosted queue.

### Why a self-hosted agent

- The test-harness switchroom agent is a long-lived Docker container
  with its own state, vault ACL, and bot ACL; ephemeral hosted agents
  can't host it.
- `TELEGRAM_UAT_DRIVER_SESSION` is bearer-equivalent to the driver
  Telegram user account. We don't want it in the build env of a
  hosted Buildkite worker that may be shared across orgs.
- Telegram per-bot rate limits are global; running fuzz from multiple
  random agents in parallel would interfere with itself and with the
  manual UAT workflow.

### Pipeline env opt-in

The UAT step lives in a separate fragment (`.buildkite/pipeline.uat.yml`)
that's only uploaded into the build plan when this pipeline-level env
var is set on the pipeline. Add it via **Pipeline Settings →
Environment Variables** in the Buildkite web UI (same surface that
hosts `ANTHROPIC_API_KEY` — see step 3 of "One-time setup in Buildkite"
above):

```
SWITCHROOM_UAT_GATE_ENABLED=true
```

Set this **last** — only after the agent is online (so the `uat-host`
queue is registered with the cluster) AND the four secrets exist.
Before that, `build.env("SWITCHROOM_UAT_GATE_ENABLED")` returns
`null`, the upload step's `if:` condition evaluates to false, the
fragment is never loaded, and the `uat-host` queue reference never
reaches the pipeline.yml validator. (Without this split, the BK
validator rejects `pipeline.yml` outright with "Queue 'uat-host'
does not exist".)

### Setting up the `uat-host` self-hosted agent (one-time)

On the box that already runs `test-harness` + `switchroom-vault-broker`:

```bash
# 1. Install the buildkite-agent (Linux x86_64; see buildkite docs).
# 2. Tag the agent queue:
#    /etc/buildkite-agent/buildkite-agent.cfg
#      tags="queue=uat-host,host=switchroom-prod"
# 3. Ensure bun is on PATH for the buildkite-agent user.
# 4. Ensure the test-harness container is running:
switchroom agent status test-harness
# 5. Restart the buildkite-agent service so it picks up the new tags.
sudo systemctl restart buildkite-agent
```

The agent runs as a Linux user that needs read access to whatever bun
install is on PATH and (via `bun run test:uat`) the ability to make
outbound MTProto / HTTPS connections to Telegram.

### Cluster secrets

Four secrets must exist in the cluster secret store (set via the
Buildkite Cluster API or web UI → Cluster → Secrets):

| Key | Source | Rotation |
|---|---|---|
| `TELEGRAM_API_ID` | `my.telegram.org/apps` → API id | Stable; only rotate when re-issued. |
| `TELEGRAM_API_HASH` | `my.telegram.org/apps` → API hash | Stable; rotate alongside `API_ID`. |
| `TELEGRAM_UAT_DRIVER_SESSION` | `bun uat:login` output | Rotate whenever the driver account 2FA/devices change — see `telegram-plugin/uat/SETUP.md` §4. |
| `TELEGRAM_TEST_BOT_USERNAME` | BotFather (no leading `@`) | Stable. |

To provision (one-time, then per-rotation):

```bash
# 1. Read the live vault values on the UAT host, in the test-harness
#    container's ACL (see telegram-plugin/uat/SETUP.md §6).
docker exec switchroom-test-harness switchroom vault get telegram-uat-api-id
docker exec switchroom-test-harness switchroom vault get telegram-uat-api-hash
docker exec switchroom-test-harness switchroom vault get telegram-uat-driver-session
# Bot username is the BotFather username without `@`, e.g.
# `meken_switchroom_test_bot`.
```

Then push each value to the Buildkite cluster secret store via the
**REST API** or the **Web UI** — the `buildkite-agent secret`
subcommand on the agent only exposes `get`, not `create`. REST API
example (one secret; repeat for each of the four keys):

```bash
BUILDKITE_API_TOKEN=$(switchroom vault get buildkite-api-token)
ORG="<your-org-slug>"
CLUSTER_ID="<your-cluster-uuid>"
curl -fsSL -X POST \
  -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"TELEGRAM_API_ID","value":"…","description":"UAT fuzz"}' \
  "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets"
```

Existing secrets are updated via `PATCH` against the same path with
the secret's UUID. Do not echo `TELEGRAM_UAT_DRIVER_SESSION` to
terminal history or copy/paste it through a chat-style channel —
it is bearer-equivalent to the driver Telegram user account.

If any of the four secrets is missing at build time the step posts a
warning annotation and exits 0 (soft-skip), so a rotation in flight
doesn't block all PRs. A hard failure inside the test run is **not**
soft-skipped — fuzz invariant violations are real signals (a single
flake retries via `retry.automatic` on -1 / 143 only).
