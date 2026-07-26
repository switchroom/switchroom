---
name: switchroom-release
description: "Cut and ship a switchroom release end-to-end: CHANGELOG consolidation, tag, npm publish, image build, and the fleet rollout gate. Use when the user says 'cut a release', 'ship a release', 'release vX', 'publish a new version', 'roll out the latest', or otherwise wants the merged work on main to go live for the fleet. This is the ONLY skill that authorizes a fleet rollout, and it enforces the npm-publish + image-build gates that were historically skipped (v0.18.4/v0.18.5 shipped to the fleet but never hit npm). Do NOT use for adding agents (switchroom-manage), diagnostics (switchroom-health), or a plain `switchroom update` on one agent (switchroom-cli)."
allowed-tools: Bash(git *) Bash(gh *) Bash(npm view *) Bash(npm pack *) Bash(docker manifest inspect *) Bash(docker buildx imagetools inspect *)
---

# Switchroom release

Cut a release of `switchroom/switchroom` and get it live on the fleet. This is a **gated, ordered checklist** — do not skip steps, do not reorder. The whole point of this skill is that two steps that used to be skipped silently (npm publish, image-build verification) are now **hard gates before rollout**.

## What a release actually is

- A release = a `vX.Y.Z` **git tag** on `main` (the merge commit of the CHANGELOG PR).
- The tag is the version source of truth (`scripts/build.mjs:resolveVersion()`). `package.json` `version` is a **stale placeholder by design** — never bump it in a commit (the `//version` comment + #2733 discipline). The uncommitted pack-time bump happens in CI now, not by hand.
- Cutting the tag fires TWO workflows in parallel on tag push: `docker-images` (builds + pushes the 6 ghcr images) and `npm-publish` (builds, packs, verifies, publishes to npm). **Rollout is gated on BOTH going green.**

## Before you start — pre-flight (verify, don't assume)

1. `git fetch origin`, confirm `main` is at the commit you want released.
2. `gh pr list --state open` — confirm no PR meant for this release is still open. Ask the operator if unsure.
3. Confirm CI on `main` is green (`gh run list --branch main --limit 3`).
4. Read `CHANGELOG.md` — the `## Unreleased` section is the staging area for this release's notes. If it's empty, there's nothing to release.
5. Pick the next version: read the latest tag (`git tag --list 'v*' --sort=-v:refname | head -1`) and bump the patch (or minor if the operator asks). Confirm with the operator which.

## Step 1 — Consolidate the changelog (the release commit is CHANGELOG-only)

- Move the `## Unreleased` entries under a new `## vX.Y.Z — <one-line summary>` heading.
- The release commit touches **CHANGELOG.md only**. Do NOT bump `package.json` (placeholder discipline).
- Branch protection blocks direct push to `main`, so: create a `release/vX.Y.Z` branch, push it, open a `chore: release vX.Y.Z` PR (base `main`), arm auto-merge (squash, delete-branch) on green CI.

## Step 2 — Cut the tag (on the merge commit, not the PR branch)

Once the changelog PR is merged:
- `git fetch origin && git checkout main && git pull --ff-only`
- Tag the merge commit and create the GitHub Release:
  - `gh release create vX.Y.Z -R switchroom/switchroom --target main --title 'vX.Y.Z — <summary>' --notes-file <notes-file>`
- **Notes extraction gotcha (historical):** the naive `awk '/^## vX/,/^## v/' CHANGELOG` range collapses to a single line. Use a start-flag awk: `awk 'f{print} /^## vX\.Y\.Z/{print; f=1} f && /^## v/ && !/^## vX\.Y\.Z/{exit}'` — or extract the section to a temp file by line range.
- **`gh release create` has been silently dropped in past runs.** After running it, verify: `gh release view vX.Y.Z` must return the release. If it didn't create, re-run.

## Step 3 — Wait for ALL THREE tag-push workflows (hard gates)

The tag push triggers `docker-images`, `npm-publish` AND `release` in parallel. **Do not proceed to rollout until all three are green AND verified.**

### Gate A — npm publish (`npm-publish.yml`)
- `gh run list --workflow=npm-publish.yml --limit 1` — wait for it to reach `completed` / `success`.
- Verify the publish is live: `npm view switchroom version` must return `X.Y.Z` (not the old version). Retry a few times — npm registry propagation can lag a few seconds.
- If this workflow fails: **the release is not published.** Do NOT roll. Diagnose (NPM_TOKEN unset? npm 5xx? empty dist?). Re-run via `gh workflow run npm-publish.yml --ref vX.Y.Z` after fixing.

### Gate B — docker images (`docker-images.yml`)
- `gh run list --workflow=docker-images.yml --limit 1` — wait for `completed` / `success`.
- Verify all 6 images are published: `docker manifest inspect ghcr.io/switchroom/<image>:vX.Y.Z` for `agent`, `auth-broker`, `kernel`, `broker`, `web`, `hostd`. Each must resolve.
- If any image is missing: do NOT roll — the rollout canary version-assert fails on an unpublished tag. Wait + re-check.

### Gate C — static binaries (`release.yml`)
- `gh run list --workflow=release.yml --limit 1` — wait for `completed` / `success`.
- Verify the release page actually has assets: `gh release view vX.Y.Z --json assets --jq '.assets[].name'` must list all four binaries (`switchroom-{linux,macos}-{amd64,arm64}`) **and** `switchroom-checksums.txt`. This is the gate that did not exist through v0.19.19 — every release up to then shipped **zero** assets and the advertised `curl | sh` installer (`install.sh`) was dead on every platform (#3633).
- `release.yml` uploads to a release that must ALREADY EXIST — it deliberately does not invent one, so step 2's `gh release create` is a prerequisite, not optional. If the workflow failed with "no GitHub Release exists for …", create the release, then re-run: `gh workflow run release.yml --ref vX.Y.Z -f dry_run=false`.
- To rehearse a change to this workflow without publishing anything: `gh workflow run release.yml --ref <branch>` (dry_run defaults to true — it builds, checksums and verifies the bundle, and attaches it as a workflow artifact only).

**Only when Gates A, B AND C are green + verified** do you proceed.

## Step 4 — Fleet rollout (operator-gated, canary-first)

- Fire the rollout via the hostd rollout path (`mcp__hostd__rollout`), which pops an **approval card**. Do NOT roll without the operator tapping approve.
- Canary discipline: roll the release-critical canary agent first (the test-harness agent, per CLAUDE.md > Release canary discipline), monitor its logs + a smoke check, then stagger the rest per-agent with a `--version` assertion each (guards the `:latest` pull-race).
- For a release that changes agent runtime behavior (a CLI pin bump, a behavioral template change), offer the operator a canary-first path (one agent → monitor → sweep) vs all-at-once; let them choose.

## What you must NOT do

- **Never bump `package.json` `version` in a commit.** It's a stale placeholder; the tag is the source of truth and `npm-publish.yml` does the uncommitted pack-time bump.
- **Never run `npm publish` by hand from the agent container.** You can't reach the operator's npm auth, and the workflow is the reliable path. If the workflow is broken, fix the workflow — don't side-step it.
- **Never roll the fleet before Gate A (npm) AND Gate B (images) are both green + verified.** A release that's on the fleet but not on npm is the exact regression this skill exists to prevent.
- **Never push directly to `main`.** The CHANGELOG PR goes through auto-merge on green.
- **Never force-push `main` or bypass hooks (`--no-verify`).**

## If something goes wrong

- **npm-publish failed but the tag is already pushed:** fix + `gh workflow run npm-publish.yml --ref vX.Y.Z`. Do NOT roll until it's green + `npm view` confirms.
- **Images failed but npm succeeded:** the npm package is live but the fleet can't roll yet. Fix the image workflow / re-run. (npm being ahead of images is fine — the CLI is published for npm consumers; the fleet waits on images.)
- **Rollout started before publish verified (the old bug):** abort the rollout, publish, then re-roll. Do not let a half-published release sit on the fleet.

## Operator one-time setup (tell them once, not every release)

The `npm-publish.yml` workflow needs an `NPM_TOKEN` repo secret (automation-scoped npm access token with publish rights on `switchroom`). Set it once in repo settings → Secrets and variables → Actions → `NPM_TOKEN`. Without it, Gate A fails loudly on the first release — that's the design (loud > silent).
