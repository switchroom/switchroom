# AGENTS.md

Instructions for humans and coding agents working in `switchroom/switchroom`.

This is the **public** Hermes Fleet distribution. It owns generic implementation, the opinionated Fleet child image, independent sidecar source, and public GHCR publication. Deployment overlays, identities, and private binaries live elsewhere.

Product decisions live in [`reference/`](reference/). Read that before changing behaviour that operators will feel.

`CLAUDE.md` only imports this file. Edit `AGENTS.md`, not `CLAUDE.md`.

## Where this repo sits

```text
NousResearch/hermes-agent            upstream runtime
  -> switchroom/hermes-agent         fork plus Switchroom add-ons
  -> Agent image                     pinned in release/agent-image-manifest.json
  -> switchroom/switchroom           this repo: public distro
  -> ghcr.io/switchroom/switchroom   Fleet child image, plus ghcr.io/switchroom/<sidecar>
  -> private overlay Stage A PR      .github/workflows/release-handoff.yml
  -> private candidate image and host-run rollout (outside this repo)
```

The Agent image's new home is `ghcr.io/switchroom/hermes-agent`. Until the fork publishes there, `release/agent-image-manifest.json` keeps pinning a `ghcr.io/mekenthompson/hermes-agent` digest. Deployments pin by digest, and digests published under the old `ghcr.io/mekenthompson/*` names stay valid; never delete or retag them. Publication and handoff: `docs/image-release.md`. Rollout: `docs/rollout.md`.

Old names: this repo moved from `mekenthompson/hermes-fleet`, and the fork moved from `mekenthompson/hermes-agent`, on 2026-11-18. GitHub redirects both. Never create a repository at either old name, because that breaks the redirect. `switchroom/switchroom-classic` is the archived Claude Code harness; do not build on it.

Hermes is the runtime and Switchroom is the opinionated layer on top. Do not rename `HERMES_*` variables, `hermes-<profile>` container names, or `~/.hermes` paths.

## GitHub access

The `switchroom` organization rejects fine-grained personal access tokens with a lifetime over 366 days. A long-lived token that works on other owners gets a 403 here, which is not a broken login. Use an org-approved token for `switchroom/*`. Moving a repository between owners is a web-UI action by an org owner, not something an agent can do.

## Product contract

A change ships only when **all** hold:

1. It advances a named vision outcome in `reference/vision.md` / `reference/product-spec.md`.
2. It satisfies its Job Spec, proven by that job's outcome UAT.
3. It passes every principle check in `reference/principles.md`.
4. It crosses no invariant in `reference/invariants.md`.

Else: out of scope, however clever.

Humans own the vision, principles, invariants, and ratifying the job statement. Agents consume those anchors; they never author them.

Review is a **separate fresh-process reviewer**, never the author. Unit-green, outcome UAT, and production-readiness are three gates. None implies the others. **Built, published, and deployed are different claims.**

Do not add ledgers, dashboards, confidence scores, or standalone formulation documents. Record assumptions and findings inside the spec, RFC, or post-launch review.

Do not change policy merely to make documentation agree with code. Reconcile the explanation with the intended policy.

Ceremony matches user-visible change. Not every patch is a launch. Lighter evidence does not mean optional invariants.

## Hard rules

- Pin images by immutable digest. Never teach people to run mutable tags.
- Do not add credentials, vault URIs, OAuth state, sessions, memories, logs, or live topology.
- Do not add household names, private hostnames, or real profile identities.
- Do not vendor private binaries or unpublished local CLIs. Private binaries belong in the private overlay repository, with a hashed manifest and a COPY+sha256sum install.
- Do not enable anything by default outside the reviewed default set in `contracts/plugins.json` and `reference/rfcs/default-on-distribution.md`. A default must degrade cleanly when its credential is missing, never block an agent from starting, and add no model or paid path the principal did not grant. Mark a default `shipped` only when the starter overlay actually enables it.
- Do not treat a green unittest run as publication approval. Image publication still requires the Fleet image workflow.
- Do not bounce, start, or pin live household services from this repository.

## Layout

```text
Dockerfile                 Fleet child only
compose.example.yaml       Synthetic example, not a production baseline
contracts/                 Public product boundaries
docs/                      Human docs for public behavior
examples/overlay-repo/     Placeholder overlay repository
plugins/                   Mounted plugin source; off in the bare image, reviewed defaults via the overlay
recipes/                   Opt-in Compose fragments (gated A2A, artifact publishing); off unless layered
release/                   Pinned Agent parent handoff
scripts/                   Build, compose, and verification wrappers
sidecars/                  Independent sidecar source and image workflows
tests/                     Public product and sidecar tests
reference/                 ProductOS: vision, principles, invariants, product spec, jobs
```

There is no `sidecars/` copy in the private overlay, and no private compose in this tree.

## What CI runs and how to reproduce it locally

Required checks: `source-checks` (aggregate of `selection`, `source-tests` and every `runtime (*)` leg), `preflight` (Fleet Image bake, only when image inputs change) and `history-root`. Branch protection is strict.

- **Preview the plan:** `python3 scripts/source-ci.py select --event pull_request --files $(git diff --name-only origin/main...)`. `units_full: true` means an unmapped path (every unit module, no real-Agent legs). `full: true` means a workflow or selector edit, a runtime input (agent manifest, scenario requirements, runners, `tests/` helpers) or an unknown change set: every leg runs. `deferred_on_pr` lists legs a Linear-plugin-only PR leaves to main push CI (fast lane; a red push is auto-reverted).
- **Fast local gate** (what `source-tests` runs; use it instead of a whole `discover`, which takes 4 min and skips every real-Agent scenario): `plan=$(python3 scripts/source-ci.py select --event pull_request --files <paths>); python3 scripts/source-ci.py units --plan "$plan"; python3 scripts/verify-public-tree.py`.
- **Real-Agent legs**, only for the test files you touched (CI shards the rest):
  - Core at the pinned revision, depth 1, not a full clone: `git init agent-source && git -C agent-source fetch --depth 1 https://github.com/switchroom/hermes-agent "$(jq -r .revision release/agent-image-manifest.json)" && git -C agent-source checkout -q FETCH_HEAD`.
  - Scenario venv: `python3.14 -m venv .venv && .venv/bin/pip install --require-hashes --only-binary=:all: -r release/linear-scenario-requirements.txt` (add `-r tests/native-input-requirements.txt` for the input seam).
  - Kanban: `.venv/bin/python scripts/run-linear-scenarios.py --agent-source agent-source --pattern test_<file>.py`. Origin: `scripts/run-linear-origin-scenarios.py --agent-source agent-source --shard 1/3`.
  - Input seam: `.venv/bin/python -I scripts/run-linear-input-scenarios.py --agent-source agent-source --shard 1/3` (no `--pattern`; about 4 min per shard). Its guard denies reads under your real `$HOME`, so keep `agent-source` and the venv outside it. Leave it to CI unless a seam file changed.
  - Worker journeys need Core's own environment, not the scenario venv: `(cd agent-source && python -m pm.build_env --source . --out ../journey-env --group dev --group test --extra all --ci)`, then `journey-env/bin/python scripts/run-linear-scenarios.py --agent-source agent-source --pattern test_linear_native_work_journey.py`.
- **Flakes:** known flaky real-Agent tests live only in `tests/ci-quarantine.json`; the runner retries those once with a `::warning::`. Anything else that fails twice is a bug: fix the test's race with a bounded wait-until on the condition, never product code to suit an old Core.
- **Workflow shape is tested:** edit `tests/test_source_ci_scope.py`, `tests/test_ci_linear_scenarios.py`, `tests/test_release_handoff_workflow.py` and `tests/test_image_scope_and_scans.py` together with `ci.yml`, `source-ci.py`, the runners or `fleet-image-change-scope.py`.
- **Main push CI** reuses the PR's green run when the merged tree is identical and the PR was current with main; a nightly run covers everything. Never wait on or poll a pipeline by hand.

If you change the Dockerfile or anything it copies, also expect `.github/workflows/fleet-image.yml` to bake. Keep `scripts/fleet-image-change-scope.py` in sync with every `COPY` source.

## How a change reaches the fleet

- **Plugins** (`plugins/**`) are mounted source, not image content: merge, green main CI, then Plugin pin handoff opens the private pin PR. No image bake; do not touch the Dockerfile for a plugin fix.
- **Image inputs** (`scripts/fleet-image-change-scope.py`): PR preflight bake, merge, Fleet Image publish (waits on exact-SHA main CI), Release Handoff, private Stage A PR with auto-merge, then the private pipeline and rollout.
- **Agent pins:** `release/pin-agent-*` PRs are bot-opened and always run the full suite. Never hand-edit `release/agent-image-manifest.json`.
- No step anywhere needs a human approval; nothing here deploys.

## Pull requests

- Small, one topic. Keep the branch current (merge or rebase `main`; pr-auto-update merges `main` into auto-merge PRs). Never force-push a shared branch.
- Independent cold review before merge, by a fresh session that did not write the change. Reviewers are read-only.
- Merge only when required CI is green on the exact reviewed head.
- Before any commit, scan the diff for household names, emails, chat IDs, and profile registries. `python3 scripts/verify-public-tree.py` and `tests/test_public_product.py` catch some of it, not all.
- PRs land by squash or rebase. Do not force-push `main`.
- Do not add reviewers, do not merge on failed CI, do not publish from a PR.

## Image changes

The child must keep:

- Digest-pinned Agent parent
- `USER 1000:1000` after rebinding `hermes`
- Inherited Agent entrypoint and command
- No Docker socket, no host network, no privileged mode

If you add a tool, pin it (version + sha256 or lockfile) and prove it in `fleet-image.yml` on both preflight and publish.

## Docs

Update `README.md` when the public product shape changes. Keep this file honest about the public/private split. Overlay layout and Hermes config layers: `docs/overlay-repository.md` and `examples/overlay-repo/`. Product scope and jobs live in `reference/`. `SECURITY.md` is the vulnerability path.
