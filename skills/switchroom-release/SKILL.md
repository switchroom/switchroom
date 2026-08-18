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
- Cutting the tag fires **two** workflows: `docker-images` (builds + pushes the 6 ghcr images) and `release` (the **orchestrator** — builds the four static binaries, attaches them, waits for `docker-images`, then calls `npm-publish`, then takes the GitHub Release out of draft).
- **`npm-publish.yml` no longer has a tag trigger (#3654).** It is reachable only via `workflow_call` from `release.yml` and via `workflow_dispatch`. npm is the one leg that cannot be undone, so it runs last and only once everything else is green. It also re-proves both preconditions from inside its own run, so a hand dispatch cannot bypass the ordering either.
- **The GitHub Release is created as a DRAFT and stays one until every leg is green.** `install.sh` resolves the version to install from `/releases/latest`, and that endpoint excludes drafts — so a half-finished release is invisible to `curl | sh` users and the previous complete release keeps serving them. This is not theoretical: v0.19.19 shipped published-with-zero-assets and broke the installer on every platform.
- **A tag push is now SUFFICIENT: if no GitHub Release exists, `release.yml`'s `guard` job AUTO-CREATES it as a draft from the `## vX.Y.Z` section of `CHANGELOG.md` (#4331).** The manual `gh release create` in step 2b is therefore belt-and-suspenders — do it (it lets you pin an exact title/notes and shortens the guard's wait), but forgetting it no longer silently strands the release. This closed the v0.20.3/v0.20.4 hole: those tags shipped to the fleet with `gh release create` skipped, so `guard` failed, `npm` was skipped, and npm `latest` sat at 0.20.2 until it was recovered by hand. The one hard requirement is that `CHANGELOG.md` on the tagged commit HAS a section for the tag — if it doesn't, `guard` FAILS LOUDLY (it never invents an empty release).

## Before you start — pre-flight (verify, don't assume)

1. `git fetch origin`, confirm `main` is at the commit you want released.
2. `gh pr list --state open` — confirm no PR meant for this release is still open. Ask the operator if unsure.
3. Confirm CI on `main` is green (`gh run list --branch main --limit 3`).
4. Read the staged notes — they live in TWO places, both **continuously maintained** as PRs merge and both enforced by `scripts/check-changelog-entry.mjs` (part of `npm run lint`): the `changelog.d/` **fragment files** (the primary path — every shippable PR adds its own `<pr>-<slug>.<type>.md`; see `changelog.d/README.md`) and any legacy/hand-staged entries under `## Unreleased` in `CHANGELOG.md`. Together they should already read as a near-complete draft — you assemble and tidy, you do NOT author from scratch. **Nothing staged at release time (no fragments AND an empty `## Unreleased`) is an ANOMALY, not the normal state** — `bun run changelog:cut` refuses to cut it: it means either there genuinely is nothing to release, OR the enforcement was bypassed (`no-changelog` labels / `[skip changelog]` tokens on their own line on PRs that should have staged notes). Before assuming the former, cross-check against `git log <last-tag>..origin/main` — if real shippable work landed but nothing is staged, investigate and reconstruct rather than shipping a hollow release (this is exactly the v0.20.12 failure mode the enforcement exists to prevent).
5. Pick the next version: read the latest tag (`git tag --list 'v*' --sort=-v:refname | head -1`) and bump the patch (or minor if the operator asks). Confirm with the operator which.

## Step 1 — Assemble the changelog (the release commit is CHANGELOG + fragment deletions only)

- The notes are staged continuously (see pre-flight 4), so this step is **one command + a review**, not authorship:

  ```bash
  bun run changelog:cut -- --version vX.Y.Z --summary "<one-line summary>"
  ```

  `scripts/cut-changelog-release.mjs` folds every `changelog.d/` fragment (plus anything hand-staged under `## Unreleased`) into a new `## vX.Y.Z — <summary>` section grouped by category, **re-seeds a fresh empty `## Unreleased` block** (header + convention comment) below `# Changelog`, and **deletes the consumed fragment files**. Use `--dry-run` first to preview the assembled section. It FAILS LOUDLY on a double cut or an empty cut — if it refuses for "nothing to release", STOP and resolve the anomaly (pre-flight 4); do not invent a release note.
- Read through the assembled section and lightly edit for grouping/summary before committing.
- The release commit touches **CHANGELOG.md and the deleted `changelog.d/` fragments only**. Do NOT bump `package.json` (placeholder discipline). (A CHANGELOG + fragment-deletion PR changes no shippable code, so `check-changelog-entry.mjs` passes it without a staged note of its own — deleting fragments never counts as staging one.)
- Branch protection blocks direct push to `main`, so: create a `release/vX.Y.Z` branch, push it, open a `chore: release vX.Y.Z` PR (base `main`), arm auto-merge (squash, delete-branch) on green CI.

## Step 2 — Create the DRAFT release on a PINNED SHA, then push the tag

Once the changelog PR is merged. **Order matters, and so does the pin.**

### 2a — Resolve and PIN the commit

```bash
git fetch origin
SHA="$(git rev-parse origin/main)"
git --no-pager log -1 --oneline "$SHA"    # show the operator exactly what is being released
```

**Never pass `--target main`.** `main` is resolved server-side at the moment the API call lands, and agents merge PRs in parallel here — a PR that merged in the seconds between your pre-flight check and your `gh release create` would be silently swallowed into the release. Resolve `$SHA` once, confirm it is the commit you inspected in pre-flight, and use that literal SHA everywhere below.

### 2b — Create the release as a DRAFT

```bash
gh release create "vX.Y.Z" -R switchroom/switchroom \
  --draft \
  --target "$SHA" \
  --title 'vX.Y.Z — <summary>' \
  --notes-file <notes-file>
```

- **`--draft` is mandatory.** A published release with no assets immediately becomes `/releases/latest` and 404s every `curl | sh` install for the entire ~25-minute build window. `release.yml` will forcibly re-draft an incomplete published release within about a minute, but do not rely on the safety net — it exists for the case where this step was done wrong.
- **Creating the release object *before* the tag is effectively REQUIRED, not belt-and-suspenders.** `release.yml`'s `guard` job polls ~150s for the release to appear, and if it never does it auto-creates the draft from `CHANGELOG.md` (#4331). But that auto-create routinely lands **too late for the same `release` run's completeness check**: the draft is created at the tail of the poll window, the check re-reads the release list in the *same* job, still cannot see it, exits 4, and **fails the run** — `npm`/`publish`/`finalize` all `needs:` this job, so they SKIP and nothing ships. This is not hypothetical: on **v0.21.18** (`release` run `32095648269`, attempt 1) the tag was pushed with no draft, `guard` retried 10× over ~150s, logged `auto-created draft release v0.21.18 from CHANGELOG.md`, then still exited 4 (`auto-created v0.21.18 but the completeness check still cannot see it`) and the job failed at `03:33:23Z` — npm/publish/latest all SKIPPED. So do not read #4331 as "skipping this step is fine": create the draft here, on the pinned SHA, before the tag push. It also lets you author a title/notes that differ from the raw CHANGELOG section.
- **If the tag is already pushed without a draft and `guard` has failed, the fix-forward is a re-run, not a re-cut.** The auto-create has by then left a real draft object behind, so re-run the failed jobs — the guard's completeness check now sees the draft and passes:
  ```bash
  gh run rerun <release-run-id> --failed -R switchroom/switchroom
  ```
  On the second attempt `guard` passes → binaries attach → npm publishes → the GitHub Release un-drafts → `:vX.Y.Z` promotes to `:latest`. This is exactly how v0.21.18 recovered (attempt 2 published `03:37:03Z`). Do NOT cut a new patch version to route around a failed guard — the release for this tag already exists as a draft.
- **Notes extraction gotcha (historical):** the naive `awk '/^## vX/,/^## v/' CHANGELOG` range collapses to a single line. Use a start-flag awk: `awk 'f{print} /^## vX\.Y\.Z/{print; f=1} f && /^## v/ && !/^## vX\.Y\.Z/{exit}'` — or extract the section to a temp file by line range.
- **`gh release create` has been silently dropped in past runs.** Verify it exists and is a draft:
  ```bash
  gh release view vX.Y.Z -R switchroom/switchroom --json tagName,isDraft
  ```
  `gh` resolves drafts by tag name (it falls back to scanning the release list). Note the raw REST `GET /releases/tags/{tag}` does **not** — it 404s on a draft. That difference is why the workflow scripts use the list endpoint; don't "fix" them to use the by-tag endpoint.

### 2c — Push the tag at that same pinned SHA

GitHub does not create the tag ref for a *draft* release (it creates it on publish), so the tag push below is what actually starts the pipeline. Confirm that before pushing, because if the ref already existed at `$SHA` the push would be a silent no-op and **no workflow would fire**:

```bash
git ls-remote --tags origin "refs/tags/vX.Y.Z"   # expect NO output
git push origin "$SHA:refs/tags/vX.Y.Z"
```

Pushing the SHA-to-ref form rather than `git tag && git push --tags` guarantees the tag lands on the commit you pinned in 2a, not on whatever your local `main` happens to be. (If the ref *does* already exist at a different commit, the push is rejected — that is the safe direction. Do not force it; work out why first.)

Then confirm both workflows actually started before you walk away:

```bash
gh run list -R switchroom/switchroom --branch vX.Y.Z --limit 5
```

You should see a `docker-images` run and a `release` run. If you see neither, the tag ref already existed and nothing fired.

## Step 3 — Wait for the pipeline (two workflows, one of them orchestrated)

The tag push triggers `docker-images` and `release`. `release` internally waits for `docker-images`, then publishes to npm, then un-drafts the GitHub Release. **Do not proceed to rollout until both are green AND verified.**

### Gate A — docker images (`docker-images.yml`)
- `gh run list --workflow=docker-images.yml --limit 1` — wait for `completed` / `success`.
- Verify all 6 images are published. The repository name is `switchroom-<name>`, **not** `<name>` — `.github/workflows/docker-images.yml` builds `${REGISTRY}/${IMAGE_NAMESPACE}/switchroom-${{ matrix.image.name }}`, so `ghcr.io/switchroom/agent` does not exist and returns `manifest unknown`. Check each of:
  ```bash
  for n in agent auth-broker kernel broker web hostd; do
    docker manifest inspect "ghcr.io/switchroom/switchroom-$n:vX.Y.Z" >/dev/null \
      && echo "OK   switchroom-$n" || echo "MISS switchroom-$n"
  done
  ```
  Each must resolve.
- If any image is missing: do NOT roll — the rollout canary version-assert fails on an unpublished tag. Wait + re-check. `release` will block on this by itself, so a red image build means npm never publishes and the release never leaves draft. That is the design.

### Gate B — the release pipeline (`release.yml`)
- `gh run list --workflow=release.yml --limit 1` — wait for `completed` / `success`. Expect ~25-30 minutes: four native build legs plus the wait on `docker-images`.
- Its jobs, in order: `guard` (release exists + held out of `latest`) → `build` ×4 → `bundle` → `publish` (attach) → `images-gate` (wait on docker-images) → `npm` → `finalize` (un-draft) → `images-latest` (promote `:vX.Y.Z` → `:latest`). A red job anywhere leaves the release a **draft** and npm **unpublished** — which is the correct, recoverable state.
- `images-latest` is why a tag push no longer moves the `:latest` image tag by itself (#3685). If that last job is the one that failed, every other leg shipped and only the image tag lags: re-run it with `gh workflow run promote.yml -f from=vX.Y.Z -f to=latest`. Don't roll the fleet off `:latest` until it is green — `docker manifest inspect ghcr.io/switchroom/switchroom-agent:latest` should report the same digest as `:vX.Y.Z`.
- Verify the release page actually has assets **and is no longer a draft**:
  ```bash
  gh release view vX.Y.Z -R switchroom/switchroom --json isDraft,assets \
    --jq '{isDraft, assets: [.assets[].name]}'
  ```
  `isDraft` must be `false`, and `assets` must list all four binaries (`switchroom-{linux,macos}-{amd64,arm64}`) **and** `switchroom-checksums.txt`. This is the gate that did not exist through v0.19.19 — every release up to then shipped **zero** assets and the advertised `curl | sh` installer (`install.sh`) was dead on every platform (#3633).
- Confirm the installer's own resolution path agrees:
  ```bash
  gh api repos/switchroom/switchroom/releases/latest --jq '{tag_name, assets: [.assets[].name]}'
  ```
  This is literally what `install.sh` calls. If it still reports the previous version, `finalize` did not run.

### Gate C — npm publish
- npm is published by the `npm` job **inside** the `release` run, not by a separate workflow run. `gh run list --workflow=npm-publish.yml` will show nothing new for a normal release — that is expected, not a failure.
- Verify the publish is live: `npm view switchroom version` must return `X.Y.Z` (not the old version). Retry a few times — npm registry propagation can lag a few seconds.

**Only when Gates A, B AND C are green + verified** do you proceed.

### Rehearsing a workflow change without releasing anything
`gh workflow run release.yml --ref <branch>` — `dry_run` defaults to `true`, so it builds, checksums and verifies the full bundle and attaches it as a workflow artifact, touching no GitHub Release, no npm, and no image tags. This is the only supported way to prove a change to the release pipeline before a real tag.

## Step 4 — HOST OPERATOR CLI FIRST (#4571)

**The host CLI is upgraded BEFORE the fleet, not after.** It is what runs `switchroom apply`, `vault`, `doctor` and the *next* roll host-side, so a host CLI left behind means every later host-shell command runs retired code. Treating it as a trailing chore is how it silently drifted to **0.20.16 while the fleet ran 0.20.21** — five releases, with every roll exiting green.

This is now **enforced, not advised**: `switchroom rollout` reads `~/.switchroom/host-cli.json` (the stamp every host-context CLI invocation refreshes) and **refuses to start** when the host CLI is observably older than the target — before a single agent restarts. The refusal names the exact install command, derived from how the host CLI was *actually* installed.

- Ask the operator to run the upgrade on the host **before** you fire the roll. Do not hand them `sudo npm i -g switchroom@X` from memory: that is wrong on a user-owned nvm prefix (it installs into a different tree, or root-poisons this one). Take the command from `switchroom doctor`'s `cli (host)` fix line or from the rollout refusal text — both derive it from the stamp.
- Confirm it landed: `switchroom --version` on the host shell reports the target. Any host-context switchroom command also refreshes the stamp, so the gate sees the new version immediately.
- `--allow-stale-host-cli` is the escape hatch and must be a deliberate, stated decision — it leaves the host CLI drifted and says so loudly in the roll's warnings.
- A host CLI predating this feature writes no stamp. The gate then does not block (it cannot know), and the roll's terminal card says so instead of claiming convergence. Confirm host-side.

## Step 5 — Fleet rollout (operator-gated, canary-first)

- Fire the rollout via the hostd rollout path (`mcp__hostd__rollout`), which pops an **approval card**. Do NOT roll without the operator tapping approve.
- Canary discipline: roll the release-critical canary agent first (the test-harness agent, per CLAUDE.md > Release canary discipline), monitor its logs + a smoke check, then stagger the rest per-agent with a `--version` assertion each (guards the `:latest` pull-race).
- For a release that changes agent runtime behavior (a CLI pin bump, a behavioral template change), offer the operator a canary-first path (one agent → monitor → sweep) vs all-at-once; let them choose.

## What you must NOT do

- **Never bump `package.json` `version` in a commit.** It's a stale placeholder; the tag is the source of truth and `npm-publish.yml` does the uncommitted pack-time bump.
- **Never run `npm publish` by hand from the agent container.** You can't reach the operator's npm auth, and the workflow is the reliable path. If the workflow is broken, fix the workflow — don't side-step it.
- **Never create the GitHub Release without `--draft`,** and **never `gh release create --target main`.** Pin the SHA (step 2a).
- **Never take the release out of draft by hand** while the pipeline is still running. `finalize` is the only thing that should publish it; un-drafting early puts an incomplete release on `/releases/latest` and breaks every installer.
- **Never roll the fleet before Gates A, B AND C are green + verified.** A release that's on the fleet but not on npm is the exact regression this skill exists to prevent.
- **Never push directly to `main`.** The CHANGELOG PR goes through auto-merge on green.
- **Never force-push `main` or bypass hooks (`--no-verify`).**

## If something goes wrong

**The single recovery command for almost everything is a re-dispatch of the orchestrator:**

```bash
gh workflow run release.yml -R switchroom/switchroom --ref vX.Y.Z -f dry_run=false
```

It re-runs every leg — including `finalize`, which is what actually takes the release out of draft. Re-running one leg on its own generally leaves the release stuck as a draft.

**But a re-dispatch cannot fix a defect that lives in the tag's own tree.** `workflow_dispatch` executes the workflow YAML **at the dispatched ref**, so `--ref vX.Y.Z` re-runs the same broken file and fails identically, every time. This is not theoretical — it is how v0.19.20 died (#3691). Before reaching for the re-dispatch, root-cause the failure in the workflow source **at that tag** (`git show vX.Y.Z:.github/workflows/release.yml`) and compare it to `main`. If the bug is in the tag's tree, the only path is a fix merged to `main` plus a **fresh tag**; abandon the old tag as a permanent draft (do not delete it, do not hand-publish it) and burn a patch version. Re-dispatch is for *transient* failures — a flaky runner, an npm 5xx, a `docker-images` run that has since gone green.

- **`release` failed at `guard` ("cannot auto-create … no usable CHANGELOG.md section"):** the tag has no matching `## vX.Y.Z` section in `CHANGELOG.md` on the tagged commit, so `guard` could not auto-create the release from it (#4331). This is the fail-loud fallback, not the old "no release exists" failure — `guard` now auto-creates the DRAFT release from the CHANGELOG section whenever `gh release create` was skipped, so a missing release object no longer blocks the pipeline. The fix is a CHANGELOG defect in the tag's own tree: consolidate the notes under `## vX.Y.Z — <summary>` (step 1), merge to `main`, and cut a **fresh** tag — a re-dispatch on the same tag re-runs the same CHANGELOG-less tree and fails identically (see the "cannot fix a defect in the tag's tree" note above). If instead you simply want to override the auto-notes, `gh release create vX.Y.Z --draft --notes-file …` by hand before re-dispatching still works.
- **`release` failed at `images-gate`:** `docker-images` was not green for this tag+commit. Fix it, `gh workflow run docker-images.yml --ref vX.Y.Z`, wait for green, then re-dispatch `release.yml`. Nothing was published to npm and the release is still a draft — nothing to undo.
- **`release` failed at `npm` (e.g. a transient npm 5xx):** re-dispatch `release.yml` as above. `npm-publish` treats "already published" as success, so a re-run is safe and idempotent. Dispatching `npm-publish.yml --ref vX.Y.Z` directly also works and its own gates still apply, but it will NOT un-draft the release, so you would then have to re-dispatch `release.yml` anyway.
- **Everything is green but the release is still a draft:** `finalize` did not run. Check `gh run view <run-id>` for a skipped job, then re-dispatch. Do not hand-publish — `finalize` re-verifies the asset set immediately before flipping the flag.
- **Rollout started before publish verified (the old bug):** abort the rollout, publish, then re-roll. Do not let a half-published release sit on the fleet.

## Operator one-time setup (tell them once, not every release)

The `npm-publish.yml` workflow needs an `NPM_TOKEN` repo secret (automation-scoped npm access token with publish rights on `switchroom`). Set it once in repo settings → Secrets and variables → Actions → `NPM_TOKEN`. Without it, Gate A fails loudly on the first release — that's the design (loud > silent).
