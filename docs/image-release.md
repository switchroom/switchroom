# Fleet image release

The public Fleet image is an opinionated child of the **exact Agent digest** recorded in `release/agent-image-manifest.json`. Mutable tags are rejected before Docker runs. The Agent parent is built and published by [`switchroom/hermes-agent`](https://github.com/switchroom/hermes-agent) as `ghcr.io/switchroom/hermes-agent`; pins published before that fork moved from `mekenthompson/hermes-agent` keep their `ghcr.io/mekenthompson/hermes-agent` digests.

## Transaction

Pull requests build one `linux/amd64` candidate from the exact Fleet source revision and never publish it (a same-repository PR may stage it for promotion on `main`; see "Promotion of the PR bake"). The trusted publication job either promotes the merged PR's exact scanned digest (see "Promotion of the PR bake") or independently builds its candidate, then verifies the pinned Agent handoff, inherited Agent provenance marker and installed Hermes version, Fleet revision and image identity, UID 1000 runtime user plus inherited Agent entrypoint/command, non-root `hermes` workload execution, 1Password CLI 2.42.0 from its exact official image digest, Claude Code 2.1.326, Codex 0.172.0, Grok 1.0.92, the Claude ACP adapter 0.112.0, the attributed subscription-only Claude provider plugin, absence of a Docker socket, full SPDX evidence, bounded package-level SPDX, official SPDX 2.3 schema validity through a fully hashed validator lock, and the critical-vulnerability gate.

Publication runs automatically on **every push to `main`** that touches the image input set (see "Change scoping" below). The publish job builds and scans its candidate while the `CI` push run for the same commit is still in flight, then waits (up to 30 minutes, polling every 20 seconds) for that run to complete. This is the **exact-SHA CI** gate: the newest `CI` push run for this exact commit (not a green run from another commit) must have succeeded, and absence, timeout, or any other conclusion fails closed. That gate is the last step before the first registry write; the earlier GHCR login exists only to pull the pinned Agent parent. Runs are grouped per commit and are never cancelled by a later push.

A `publish=false` dispatch runs the same read-only preflight bake and evidence gates as a pull request; it has no package-write permission and cannot write a registry reference. A `publish=true` dispatch from `main` is a re-run of the same publication path for a selected main commit (for example after a transient failure) and is subject to the same exact-SHA CI gate and scans. After its local runtime and Trivy/VEX gates pass, the publish job pushes a run/attempt-unique staging ref and captures the digest from Docker's `tag: digest: sha256:… size: N` push summary. It fetches the remote immutable manifest at that digest and fails unless its config digest equals the scanned local image config. The full SPDX document, which Syft has been generating in the background since the candidate was exported, is then collected fail-closed, compacted and schema-validated. Only after that does the job promote the immutable digest to the SHA tag without rebuilding, explicitly preserving its single-manifest form; it reads that SHA tag back and fails unless it resolves to the staged digest. No archive is transferred between jobs and nothing is loaded back into the daemon. Publication attaches SLSA build provenance and the bounded package-level SPDX document to that exact digest. A staging ref left behind by a failure after the push is run-unique, unpromoted and never consumed.

### Promotion of the PR bake (content identity, HF-851)

`main` requires PRs to be up to date and squash-merges them, so the tree a merged PR baked is exactly the tree of the `main` commit. Since HF-851 the image is stamped with **content identity** instead of the main commit: `FLEET_SOURCE_TREE` (the `hermes-fleet.source-tree` label, `HERMES_FLEET_SOURCE_TREE` and the `tree` field of `/etc/hermes-fleet/image-provenance.json`) is the git tree, and `FLEET_GIT_SHA` (the OCI revision label) is a real commit of that tree. A same-repository PR that is current with `main` stamps its **head** commit; a main rebuild stamps the main commit. Nothing in the image names the squash commit, so `main` publishes the PR's exact scanned digest without rebuilding it. `scripts/promote-fleet-image.py` carries the evidence across:

- **PR side, best effort.** A same-repository PR bake whose merge tree equals its head tree builds with inline BuildKit cache metadata and the head-SHA stamp. Once its candidate is exported, it pushes it to a run/attempt-unique `fleet-pr-stage-<run>-<attempt>` ref, overlapping the scans. Only after every preflight gate has passed (runtime and provenance checks, Camoufox smoke, Trivy, VEX, SPDX validation) it verifies that the remote manifest's config equals the scanned config, then uploads `fleet-image-staged-<head sha>`: a `staged.json` binding the digest, config, tree, stamped revision, PR head, run and build inputs, the bounded SBOM, the Trivy report and the VEX evaluation (each by sha256), plus Trivy's layer-analysis cache. This is why the job holds `packages: write`. Fork PRs get a read-only token and never stage. Every staging step is `continue-on-error`, so staging never decides the required `preflight` context. Nothing deploys a staging ref.
- **Main side.** A cheap `promotion` job probes for the merged PR's stage. It is promotable only when all of these hold:
  - the merged PR's newest Fleet Image run is same-repository and successful;
  - the run is less than 72 hours old and its staged artifact is live;
  - the previous `main` commit is an ancestor of the PR head, so the PR's test merge had exactly the PR head tree;
  - the PR head tree equals the checked-out tree.

  If it is, the `promote` job publishes instead of `publish`. It downloads the stage and re-checks every recorded hash, the tree, the stamped revision (the PR head) and the build inputs; reads the staged digest's registry manifest and config and requires the scanned config digest, the revision and tree labels, image identity, Agent parent, every pinned tool version and UID 1000 (`verify-stage`); re-runs the CRITICAL Trivy scan against the digest with **today's** database (`scan-fleet-image.py trivy-remote`; the PR's layer cache means no layer is pulled); re-checks VEX against the `op` binary of the pinned 1Password image and requires the PR's evaluation of the candidate's own binary to record the same hash; and waits for green exact-SHA CI. Only then does it tag `sha-<main commit>` (single manifest, read back for digest equality), emit the handoff with `fleet.revision` = the main commit, `fleet.tree` and `fleet.image_revision` = the PR head, attest SLSA provenance and the PR's bounded SBOM to the digest, and upload the evidence. A failure fails the run rather than rebuilding, so one commit never gets two digests; `workflow_dispatch` with `publish=true` rebuilds and publishes from scratch.
  Without a promotable stage `publish` rebuilds as before (using any stage only as build and Trivy layer cache) and stamps the main commit and its tree.
- **What the provenance says.** The SLSA provenance on a promoted digest names the main `promote` run, which verified and published bytes built by the tree-identical PR run of the same workflow file; the runtime, provenance and Camoufox checks ran on those exact bytes in the PR. Consumers bind the image by tree: the private bake requires `hermes-fleet.source-tree` to equal `parent_fleet_tree` and the revision label to be a commit of that tree. Overlay vendor fetches by revision keep working because the PR head stays reachable (`refs/pull/<n>/head`) with the identical tree.
- **Retention.** The staged-record artifact is kept for 7 days. `.github/workflows/fleet-image-stage-prune.yml` runs daily and deletes registry versions once every tag on them is a `fleet-pr-stage-*` ref and they are more than 7 days old. That includes stages from failed or abandoned PR bakes. A promoted stage also carries its `sha-*` tag and is never selected; untagged versions (published digests and attestations) are never selected either. A `workflow_dispatch` defaults to a dry run.
- **Token scope.** GitHub cannot narrow a job's token per step, so the whole `preflight_bake` job holds `packages: write`. That includes the optional BuildKit secret used by the Dockerfile's reviewed GH CLI fetch. This grants nothing new: any same-repository branch can already request `packages: write` from a push-triggered workflow. Fork PRs still get a read-only token. Only `promote`, on `main`, after the exact-SHA CI gate, turns a stage into a published digest.

Trivy's cache is keyed by layer content digests (diff IDs), so only analysis of unchanged layers is skipped, and the vulnerability match always runs against the current database.

### Scan concurrency

Both jobs export the built candidate exactly once with `docker save` (`scripts/scan-fleet-image.py export`), which fails unless the archive's manifest names the config ID that `docker image inspect` reports for the candidate; the publish job re-checks that ID immediately before the push, and the remote-manifest check above binds it to the pushed digest. Syft and Trivy then read that one archive instead of each re-exporting the multi-GB image: Syft runs detached (`start-sbom`) while Trivy scans in the foreground (`trivy`, CRITICAL, fixed-only, `--skip-db-update` against the database prefetched during the parent pull), and `wait-sbom` later fails closed on a non-zero status, a missing or non-SPDX-2.3 document, or a timeout. The parent pull, the Trivy database download and the hashed SPDX validator install run concurrently in one step whose every background process is waited on. Scanner versions are pinned in the workflow (`SYFT_VERSION`, `TRIVY_VERSION`) to the versions the previous SBOM and Trivy actions installed.

### Change scoping

A first, read-only `scope` job runs on every event and matches the changed paths against the Fleet image input set defined in `scripts/fleet-image-change-scope.py`: the Dockerfile and everything it copies (`package.json`, `package-lock.json`, `contracts/`, `scripts/claude-acp-subscription`, `scripts/tooling-policy-hook`, `scripts/image_ref.py`, `scripts/verify-agent-image-ref.py`), the pinned Agent handoff, the VEX policy, the SPDX schema and validator lock, every script the workflow invokes, and the workflow file itself. `tests/test_image_scope_and_scans.py` fails if a Dockerfile `COPY` source or a workflow script reference is missing from that list. Pull requests are diffed against their merge base; pushes are diffed as `before..sha`. On a pull request, the required `preflight` context always executes after `scope` and the internal `preflight_bake` job. A successful explicit no-image decision passes only with a skipped bake; an image-input decision passes only after the full bake succeeds. A missing or malformed decision, an unsuccessful scope job, or a missing or unsuccessful required bake fails the context. Manual dispatches and unresolved ranges still select a bake; an unsuccessful scope job also requests a bake, but the required context fails closed. `publish` still skips a main push with no image inputs. A `publish=false` dispatch uses the same read-only bake and result gate; a `publish=true` dispatch uses the independent publication path.

### Skipped publications

A skipped `publish` for a docs-only or test-only commit is **not a failure**: the image bytes for that commit are identical to the image published for the newest ancestor that changed an image input, so that publication remains the correct Fleet image for `main`. Consumers must therefore resolve "the current Fleet image for revision `H`" as *the newest successful publication at a revision `R` such that `R` is an ancestor of `H` **and** `git diff R...H` touches no path in the image input set* (`IMAGE_INPUT_FILES` / `IMAGE_INPUT_PREFIXES` in `scripts/fleet-image-change-scope.py`). Ancestry alone is not enough: if a push that changed the `Dockerfile` failed to publish and a later docs-only push was skipped, the newest successful publication is an ancestor of `HEAD` but lacks the Dockerfile change. In that state `main` stays unpublished until a `workflow_dispatch` with `publish=true` (which always bakes) succeeds. `scripts/release-conductor.py` in the private repository (`fleet_publish` stage) today only reuses `workflow_dispatch` publications and dispatches when none exists for `HEAD`, which is safe but rebuilds identical images; if it is changed to reuse push publications it must apply the input-diff rule above. `handoff.fleet.revision` names the commit the bytes were built from, which is the correct provenance to pin.

The final authenticated artifact is a House handoff manifest containing only public Agent and Fleet source/image identities. It is not deployment configuration and contains no topology, profile identity, host path, policy, or secret reference.

## Private Stage A handoff

Publication is the last step this repository performs on its own image; the private child is re-parented by a separate, cross-repository workflow. `.github/workflows/release-handoff.yml` runs on `workflow_run` of "Fleet Image" (`completed`, head branch `main`, same repository) and only when the run concluded successfully. Because `workflow_run` executes the workflow file from `main` and sets `github.sha` to `main`'s current head rather than the published commit, the job never builds anything and never reads `github.sha`: it lists the triggering run's artifacts by `github.event.workflow_run.id`, downloads `fleet-image-handoff-<head_sha>` from that run, and fails unless the manifest's `fleet.revision` equals `github.event.workflow_run.head_sha` and its `source_repository` is this repository. A successful "Fleet Image" run whose `publish` job was skipped (see "Skipped publications") has no handoff artifact; the job then emits a notice and exits successfully, because the previously published image remains the correct Fleet image for `main` and there is nothing to hand off.

The handoff identity is the GitHub App `hermes-release-bot` (Contents and Pull requests read/write, Metadata and Actions read). The job mints a short-lived installation token with `actions/create-github-app-token` from the repository variable `RELEASE_BOT_APP_ID` and the repository secret `RELEASE_BOT_PRIVATE_KEY`, scoped with `repositories: hermes-fleet-private` so it cannot touch any other repository. That secret is referenced by this workflow only; `fleet-image.yml` keeps `packages: write` and contains no `secrets.` reference, so the private key is never present in a job that can write the registry. The token flows to exactly two sinks: the checkout of `mekenthompson/hermes-fleet-private` at `main` (`persist-credentials: false`, path `private`) and the `GH_TOKEN` environment of the conductor step. It is never written to a file, a git config, or the log, and the action revokes it when the job ends. The job's own `GITHUB_TOKEN` permissions are `actions: read` and `contents: read`; there is no `packages`, `id-token`, or `pull-requests` grant and no environment.

From the private checkout the job runs the private repository's release conductor with global options before the stage name: `python3 scripts/release-conductor.py --workdir "$RUNNER_TEMP/conductor" --state "$RUNNER_TEMP/state.json" --fleet-handoff <downloaded manifest> private-stage-a-commit` (HF-851 single workflow). The stage is idempotent and fails closed: it reads `image/ci-release.json` on the private `main`, rewrites the `parent_*` fields (and `parent_fleet_tree` from `fleet.tree`) from the handoff, validates the candidate files, and either reports that `main` already holds the result or commits them straight to private `main` as one release-bot commit through the git data API (a non-forced ref update; if `main` moved it regenerates from the new `main`). When the agent revision moves it also re-derives `image/nous-drift-baseline.json` from the core commit's merge-base with Nous `main`, using a throwaway fetch-only clone under the workdir (both `switchroom/hermes-agent` and `NousResearch/hermes-agent` are public, so no credential is needed). A public commit carrying a `Candidate-Purpose: measurement` trailer passes that trailer to the private commit, so the private candidate is recorded as never auto-rolled. That push starts the private repository's own `main` pipeline: its full CI and the runtime bake, which waits for green exact-main CI before any registry write. A private conductor without that stage gets the previous path, `--auto-merge private-stage-a-pr`: a `release/stage-a-<short fleet sha>` PR whose exact-head private CI must pass before a head-pinned squash merge. This workflow performs no deployment and grants nothing beyond that one Stage A change.

## Keeping auto-merge PRs current

`main` requires PRs to be up to date before merging, so a bot pin PR with auto-merge armed stalls as soon as `main` moves. `.github/workflows/pr-auto-update.yml` runs after every push to `main` and every 15 minutes as a fallback. It merges `main` into each open, same-repository PR that has auto-merge enabled and is `BEHIND`, through the update-branch API bound to the head SHA it saw (never a force push or rebase). Fork PRs are ignored, and conflicting PRs are skipped with a warning. It uses the `hermes-release-bot` token (scoped to `switchroom/switchroom`, Contents, Pull requests and Workflows write; Workflows lets an update bring in `.github/workflows` changes from `main`) because a branch update pushed with `GITHUB_TOKEN` would not start the PR's CI. The job's own `GITHUB_TOKEN` has no permissions. If an update fails, for example because the PR head moved, the job logs a warning and the next sweep tries again.

## Boundaries

The public Fleet source repository is `https://github.com/switchroom/switchroom` (moved from `mekenthompson/hermes-fleet`, which GitHub redirects). The image publishes to `ghcr.io/switchroom/switchroom`. Images published before the move stay at `ghcr.io/mekenthompson/hermes-fleet-public` and its sidecar siblings; they are never deleted or retagged, because existing deployments pin them by digest.

This workflow performs **no production deployment**. It does not modify profile state, Docker Compose inputs, networks, secrets, or running containers. The public image inherits the Agent image's entrypoint and command. It rebinds the `hermes` account to UID/GID 1000 and ends as `USER 1000:1000`. The image also installs GitHub CLI 2.106.0 from the official release tarball, the Agent `honcho` extra without workspace identifiers, and the extra coding CLIs Codex, Grok, and OpenCode from the committed lockfile. Fleet also copies the `op` executable from the immutable official image `docker.io/1password/op@sha256:b0d7eebcb09bdc9d5862af91533e1851c968d4f969270c906f5da8c574f87e93`, verifies version `2.42.0` during build and release, and records that source in the image provenance marker. Claude Code is installed from the committed lockfile at exact version `2.1.326`; Codex and Grok are pinned to `0.172.0` and `1.0.92` respectively, and the Docker build plus both release gates assert their installed version banners. `npm ci` disables lifecycle scripts, then the Dockerfile explicitly invokes only the three locked CLI postinstall selectors needed to expose their native executables. The same lock pins `@agentclientprotocol/claude-agent-acp` to `0.112.0` with integrity `sha512-T9FrKGd9eDKHNmZE/EfEf01v49UHKeKyGcu91O8sdVc7a9eMEDOGWT/0moWirGHJdBqJ9qPVfqu07IBegJuniA==`. Hermes launches that adapter through the supported external-process provider seam using the image-owned `hermes-claude-acp-subscription` wrapper; the `claude` executable alone is not the ACP adapter. The provider plugin is adapted from `mvdbastos/hermes-acp-agents` revision `0526610a3945cc376ac517b63ca358a5b838a2fc`, records the exact upstream file hashes, retains the upstream MIT copyright and permission notice in `UPSTREAM_LICENSE`, and removes API-key, proxy, cloud-provider, and model-override environment variables before launch so the external Claude subscription login remains authoritative. Auto-update is disabled so runtime bytes cannot drift from the scanned image. The image contains no credentials, Claude OAuth state, account data, vault references, or 1Password configuration; those remain external runtime inputs.

## Claude ACP compatibility

ACP `0.112.0` uses Claude Agent SDK `0.3.331` and ACP SDK `2.12.0`; the launcher
continues to select the separately pinned Claude Code `2.1.326` executable. On
that release the ACP `opus[1m]` slot remains the existing Opus slot; the adapter
does not offer `claude-opus-5-5`. `allowDangerouslySkipPermissions` stays
false, and ACP 0.105 still removes `bypassPermissions` from the mode catalog
when that opt-out is set. With no `permissions.defaultMode`, ACP 0.105 starts
new sessions in Claude Code's `auto` mode when the account's mode catalog
offers it (upstream default since 0.101.0; accepted for this fleet). Its idle
compaction only arms in a long-lived adapter process; the provider spawns one
adapter per turn and closes it, so it never fires here. Both preflight and publication verify the provider's exact
executable and SDK declaration hashes, not only package version strings.

The optional Claude ACP provider declares the `opus[1m]` context window as
1,000,000 tokens through Agent's `ProviderProfile.get_model_context_length`
hook. Other logical handles fall back to Agent metadata. Explicit user context
overrides take precedence. CI discovers the actual plugin against the pinned
Agent source and checks context resolution, aliases and override precedence.

The native deny list keeps every previously denied name, including
`AppifactRepl`, `FetchInboxMessage`, and `SubagentHandback`, which remain in
the reviewed executable. It also denies new native tools from 2.1.296 and the 2.1.316 additions `SubscribePR`, `SendToProject` and `SendToProjectContext`, and the 2.1.319 additions `ReadWidgetContext`, `WrapUp` and `CrossSessionMessage` (2.1.323 adds no native tool names; its Read tool only gains `image_attached`/`page` output fields), and the 2.1.325 executable constants `PlaceHookTranscript`, `ReadSessionRepo` and `RunModFs` (denied defensively; 2.1.325 otherwise only reshapes the already-denied `ProposeSkills` input), and the 2.1.326 additions `GetGoal`, `SetGoal`, `PauseGoal`, `RunModFsRange` and `WorkspaceDiffForRemote` (session goal tools and session-host constants, denied not approved; 2.1.326 otherwise only changes field docs of existing tools), including
`OfferChromeSetup`, `ListConnectors`, `PublishPlugin`, `PowerShell`, and
`WaitForMcpServers`. Those tools are denied, not approved. `ToolSearch` stays
available only to discover profile-authorized connectors. Review actual
executable tools on future bumps; the SDK declaration alone is not an
exhaustive native-tool inventory.
`allowDangerouslySkipPermissions: false` explicitly disables the adapter's
bypass mode without weakening connector allow/deny rules. Managed connector
restrictions remain authoritative. No credential migration is required by these
releases.

The client deliberately does not advertise experimental compaction capability:
legacy compaction events are retained. Tool updates continue to use
`_meta.claudeCode.toolName`, because updates need not repeat the new standard
`name` field. Wire-fixture tests cover streaming, legacy compaction, trusted
bridge capture, forged events, cancellation and deadlines; these are not a
substitute for authenticated inference on a release candidate.

### Asynchronous auxiliary requests and images

The Claude provider preserves synchronous text callers while returning an awaitable
completion to asynchronous auxiliary callers. Transport work is admitted to a
four-worker pool without blocking the event loop; admission and request-lock waits
consume the request deadline. Caller context is copied into the worker. Cancelling
a queued request must not cancel another request using the same client, and stream
cleanup does not wait behind saturated transport workers.

Hermes-prepared base64 `data:image` inputs are forwarded as ordered ACP image blocks,
with text, profile policy and prior tool history preserved. The adapter must advertise
image prompt support. PNG, JPEG, GIF and WebP MIME types are supported; malformed,
empty, unsupported and remote-URL image inputs are rejected before launching an
adapter. The plugin adds a proactive four-MiB **encoded data URL** bound based on
core's reactive image-shrink target; this is not an existing core input ceiling.
It does not fetch URLs or log image payloads. Source provenance in `upstream.json`
continues to identify the original attributed plugin; these compatibility changes
are Fleet-local code, not a claim of a new upstream revision.

Credential-free wire tests prove serialization and lifecycle contracts only.
Release acceptance also requires actual image recognition through the asynchronous
`vision_analyze` path on the candidate, with provider fallback excluded from the proof.

## Automated publication gate

Only `main` may enter `fleet-image-publish`, whether the trigger is a push or a `publish=true` dispatch. There is no manual reviewer prerequisite: the exact-SHA CI proof, runtime checks, full SPDX, compact SPDX, Trivy result, VEX revalidation, remote immutable-manifest config binding, and attestations are mandatory and fail closed. Publication still does not authorize rollout.

### Scoped VEX handling

Trivy always runs and its full JSON report is retained. Critical findings fail the release unless `scripts/verify-trivy-vex.py` matches the finding to an unexpired, reviewed record in `release/vex-exceptions.json`. A record is bound to the exact vulnerability, package and versions, scanner target and type, immutable component image, executable SHA-256, approval, expiry, and the advisory's affected symbols. The gate extracts the executable from the built Fleet candidate and fails if its hash changes or an affected symbol is present. Unknown critical findings, malformed policies, changed artifacts, expired records, or additional critical findings fail closed.

There is no active VEX waiver. 1Password CLI 2.42.0 is scanned by the same critical gate as every other component and needs no record. The previous KEN-275 record was removed with the 2.41.1 pin. An empty `exceptions` list is valid. Any critical finding without a matching unexpired record still fails closed.

## Rollback

Rollback is digest selection, not an image rebuild. A private deployment may retain a previously verified Fleet digest and select it after its own cold/warm compatibility and rollback tests. Publishing a digest does not authorize rollout.
