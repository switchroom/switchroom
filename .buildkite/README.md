# Buildkite CI

This directory drives clerk's CI on Buildkite. The pipeline runs three test
stages on every commit, plus an optional skills-eval stage that exercises the
prompts inside `skills/` against a real Claude model.

## Files

| File | Purpose |
|------|---------|
| `pipeline.yml` | The full pipeline definition (lint, tests, evals, summary annotation) |
| `annotate-evals.sh` | Reads `evals/results/*.json` and posts a Buildkite annotation summarising pass rates |

## One-time setup in Buildkite

1. Create a new pipeline pointing at this repo (`mekenthompson/clerk`).
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

| Stage | Command | Notes |
|-------|---------|-------|
| Type check | `bun lint` (= `tsc --noEmit`) | Cached `node_modules/` keyed on `bun.lock` |
| Core tests | `bun run test:vitest` | Vitest suite for `src/` and most of `tests/` |
| Plugin tests | `cd telegram-plugin && bun test` | 402 tests, 19 files — Bun-only because of `bun:sqlite` |
| Trigger evals | `python3 evals/run_trigger.py --parallel 5` | Skill-routing dataset (~30 near-miss scenarios). Soft-fails so flakes warn, not block |
| Quality evals | `python3 evals/run_quality.py --parallel 5` | Per-skill content evals (~50 across 8 skills). Soft-fails |
| Eval summary | `annotate-evals.sh` | Reads result JSONs, posts pass/fail annotation |

## Local validation

Validate the pipeline YAML before pushing:

```bash
# Syntax check
bk pipeline lint .buildkite/pipeline.yml

# Or via the agent
buildkite-agent pipeline upload --debug --dry-run < .buildkite/pipeline.yml
```

## Secrets

The Buildkite API token (`bkua_*`) is stored in clerk's encrypted vault under
the key `buildkite-api-token`. Retrieve it with:

```bash
clerk vault get buildkite-api-token
```

Use it for any `bk` CLI calls that need API access (creating pipelines,
triggering builds, listing agents). It is **not** needed by the pipeline
itself — Buildkite agents authenticate via their own per-agent token.
