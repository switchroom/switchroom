# Switchroom

**An opinionated Hermes Agent distribution.** Hermes, run as a team. Each agent in its own box: one agent per container and gateway, no shared credentials.

Site: [switchroom.ai](https://switchroom.ai). Built on [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research; not affiliated with Nous Research. This repository keeps its working name, `hermes-fleet`, until it moves to the `switchroom` org. Early access: there is no quickstart yet. Naming and positioning: [`reference/rfcs/switchroom-positioning.md`](reference/rfcs/switchroom-positioning.md).

The public distribution is a provenance-bound child image, independent sidecar images, and the contracts that keep deployment identity out of the runtime. Pin every image by digest. Source or image publication is not a production rollout. A standing team of specialists you text is an outcome; isolation stays in the sentence.

## Why this exists

Hermes Agent is one process. That is the wrong blast radius for a team. Upstream `hermes update` now folds multi-profile installs into one multiplexed gateway. Switchroom deliberately keeps one container and one gateway per agent, so a bad change, leak or upgrade stays inside one box.

Switchroom is many named specialists, each with its own container, gateway, writable state, workspace, Docker network, memory, and credentials. You text the same person back. A change to one leaves the others alone. Failed upgrades recover without taking the rest down.

The public product proves that pattern without shipping anyone's credentials, deployment identities, private binaries, or live topology.

## What winning looks like

These are the product outcomes. If a change advances none of them, it does not belong here.

- **Standing team.** Named specialists, each independently addressable, with unshared memory and credentials. Not one generalist wearing hats.
- **On a leash.** One agent cannot see another's files, network, or vault. An intended change lands on the target and every other in-scope agent is still independently working.
- **There when you reach.** Telegram, Slack, and Hermes Desktop have the same bar. A restart does not drop identity, tools, or sessions. Persistence includes working tools, not just surviving files.
- **Subscription-honest.** Claude stays on the granted plan login, not a silent API meter. Other billed plans follow the same rule.

North Star is **trusted unsupervised turns**: work the principal did not sit through, that finished without a rescue, stayed inside granted tools, and made no off-plan model call. Isolation that strips the integrations that make Hermes useful is a loss.

## Opinions we will not trade

**One profile, one container, one gateway.** A shared runtime with profile names is not a fleet. Each specialist is a Docker service with its own volume and network. No Docker socket, no host network, no privileged mode. The image user is UID/GID 1000 so containers can start with no-new-privileges.

**No shared credentials.** The child image includes the 1Password CLI with no vault config. The overlay injects Connect host, token, and allowed origins per container. Vault item bindings stay in that overlay. Two agents never share a Connect token or an OAuth login. Recreating a profile or borrowing another agent's secrets to get past a blocker is out of product.

**Plugins stay off until the overlay turns them on.** The Fleet-owned plugin source trees live in this repository but are not baked into the child image. A deployment mounts one immutable, read-only copy at each expected plugin path and enables it per profile; the image still includes pinned CLI/runtime dependencies. Without the mount, a pruned plugin is absent rather than silently falling back to a baked copy. Default-enabled is empty for optional Fleet plugins; enabling one without its policy or origin fails closed.

**Digest or it did not happen.** Consume `ghcr.io/mekenthompson/hermes-fleet-public@sha256:<digest>`. Mutable tags are not a supported interface. Built, published, and deployed are different claims. A green unit run is not publication. Publication is not a production rollout.

**Identity stays in the overlay.** This repository has synthetic examples. Household names, bot tokens, vault URIs, OAuth state, and live compose do not belong here. `scripts/verify-public-tree.py` fail-closes on the obvious cases. It is a shape check, not a secret scanner.

## How a deployment actually uses it

Copy [`examples/overlay-repo/`](examples/overlay-repo) into a private overlay repository. That overlay owns:

- fleet-wide Hermes defaults and per-agent overrides (`fleet-config/`)
- compose that pins this child image by digest
- unpublished binaries and install policy
- secret injection (1Password Connect, not files in git)
- plugin policy maps (Linear workers, browser origin, voice sidecar URL)

Each compose service is one specialist. The operator changes one service. The principal texts Telegram, Slack, or Desktop and gets that specialist back, on the model plan they already pay for.

The example profiles in `compose.example.yaml` are synthetic. See [`docs/overlay-repository.md`](docs/overlay-repository.md).

## Plugins, and why they exist

Optional, **disabled by default**. They exist so isolation does not mean a dumb agent.

### Linear

`plugins/linear/` links meaningful outcomes to native Hermes tasks and reports their progress through a durable outbox. Human checkpoints and meaningful lifecycle milestones appear as regular issue comments, while Agent Sessions retain live steps and heartbeats. A completed internal stage does not close the human issue; outcome completion remains bound to the accepted native specification. Native Hermes owns execution, permissions, worker claims, recovery and Stop. Ordinary chat and authorized issue operations need no Linear claim or task link. Cross-channel follow-ups reach the existing native task without transfer phrases or another executor. The mounted plugin can also expose and independently inspect one exact current native request without granting control permission. It preserves legacy records and uncertain effects for reconciliation. It remains disabled by default; identities, scopes and reporting routes are overlay configuration. Details: [`plugins/linear/README.md`](plugins/linear/README.md).

### Browser handoff

The agent can run an isolated browser and hand the live session to the human when a login or a visual check needs a person. Cookies and origin stay on that profile's broker and sidecar. The public origin comes from `HERMES_BROWSER_HANDOFF_PUBLIC_HOST` at deploy time, not from this git tree. Sidecar images (broker, Camofox) publish separately; the Fleet child does not bake them in.

### Claude ACP

Stay on the granted Claude plan login via a profile-local ACP client. The overlay wires the account. The image does not silently fall back to an API key. The provider supports asynchronous auxiliary requests and forwards Hermes-prepared images through ACP; see [image compatibility and limits](docs/image-release.md#asynchronous-auxiliary-requests-and-images).

### Claude Subscription DirectSDK (experimental)

The official Nous Research CLI-backed provider is available as a separately installed, default-disabled source plugin; it is not baked into the Fleet image or routed by Fleet. It uses that profile's own Claude Code login and has no API-key fallback. See [packaging and scope](docs/claude-subscription-directsdk.md).

### Kokoro voice

Local TTS through a sidecar. Voice on Telegram without a cloud TTS meter. Sidecar URL and token come from the overlay.

### Perplexity search

A `web_search` backend only. Not a general web browser, not an extract path, not on by default.

### Read-only source snapshots

Allowlisted list/read/search over source snapshots so a specialist can inspect code without a write path into the tree.

### Tooling policy hook

Optional overlay binary that gates extra installs. Disabled until the overlay wires it.

## Architecture

```text
Hermes Agent image  (exact digest)
        |
        v
Switchroom child image  (this repo, hermes-fleet)
        |
        +-- profile A container + state volume + workspace + network
        +-- profile B container + state volume + workspace + network
        +-- independent sidecar images (browser broker, proxies, Camofox, Kokoro)
```

Sidecar source lives under `sidecars/`. Each sidecar publishes its own GHCR image through a dedicated workflow.

## What's in the image

The published child, `ghcr.io/mekenthompson/hermes-fleet-public`, is a digest-pinned child of an exact Hermes Agent image. It currently bundles:

- UID/GID 1000 for the `hermes` account so profile containers can start with no-new-privileges
- GitHub CLI 2.104.0 from the official release tarball
- 1Password CLI 2.42.0 from its digest-pinned official image (no vault config)
- Honcho Python SDK 2.9.0 in the Agent runtime and Honcho CLI 0.6.0 in an isolated environment, installed from hashed dependency locks with no workspace identifiers
- Codex, Grok, OpenCode, and Claude Code from the committed lockfile
- The optional plugins listed above
- Optional `tooling-policy-hook` binary for overlay install policy

Consume it only as:

```text
ghcr.io/mekenthompson/hermes-fleet-public@sha256:<digest>
```

## What's not in this repository

Keep these in a private overlay repository, not here:

- Credentials, OAuth state, vault references, and secret-source URIs
- Profile identities, live compose, and host topology
- Private binaries and unpublished local CLIs
- Deployment policy such as Linear agent maps

## Quick start

Build and compose only through the wrappers. Direct `docker build` / `docker compose` skip the immutable-reference guard.

```bash
python3 scripts/build-fleet-image.py \
  --agent-image ghcr.io/example/hermes-agent@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --tag hermes-fleet:local

export HERMES_FLEET_IMAGE=ghcr.io/example/hermes-fleet@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
python3 scripts/compose.py config
```

## Development

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/verify-public-tree.py
```

Source CI uses `scripts/source-ci.py` to select a conservative component-level subset:

- Markdown-only changes (including plugin documentation) run the cheap
  public-tree, compose, immutable-reference, and full-history checks, without runtime integrations.
- Test-only edits run the changed modules and their real-Agent contract runners.
  Test modules used as shared fixtures broaden to their component's consumers.
- Linear selects its tests plus pinned-Agent worker journeys, guarded origin/input, and retained
  HF-578 companion compatibility. Claude ACP and account connectors select the
  shared Claude tests and pinned-Agent context contract. Browser, sidecar,
  Perplexity, and tooling edits select their component and public contract tests.
- Agent/release manifests, CI/selector edits, unknown paths, unresolved ranges,
  and renamed/deleted paths run the full existing inventory. PRs compare against
  merge-base; pushes use the actual before/after range.
- Manual **CI** dispatch and the weekly scheduled CI run always validate everything.
  The `source-checks` aggregate requires every selected job to succeed; missing,
  failed, cancelled, or skipped selected work blocks it. `preflight` and
  `history-root` remain separate required contexts.

Inspect a route locally (this is routing evidence, not execution evidence):

```bash
python3 scripts/source-ci.py select --files docs/image-release.md
python3 scripts/source-ci.py select --files plugins/web/perplexity/provider.py
python3 scripts/source-ci.py select --event pull_request --base <base-sha> --head <head-sha>
```

The explicit map deliberately broadens rather than guessing new dependencies.
Image/sidecar scope, scans, immutable provenance, exact-main publication gates,
and release handoff are independent and unchanged. To roll back selection,
revert the source-CI change; manual full validation is the immediate backstop.
A green source run does not establish image publication or deployment readiness.
For real-Agent local execution see [the Linear invocation](plugins/linear/README.md#tests).

Pull requests build a non-publishing `linux/amd64` candidate, verify runtime/provenance, and run the critical-vulnerability gate. Pushes to `main` that touch image inputs publish the exact scanned candidate. See [`docs/image-release.md`](docs/image-release.md).

Coding agents should start at [`AGENTS.md`](AGENTS.md). Product scope is [`reference/`](reference/).

## Docs

- [`AGENTS.md`](AGENTS.md) — how to work in this repo
- [`reference/`](reference/) — vision, principles, invariants, product spec, jobs
- [`docs/overlay-repository.md`](docs/overlay-repository.md) — overlay repo layout, config layers, sample files
- [`docs/image-release.md`](docs/image-release.md) — image bake, scan, and publication
- [`plugins/linear/README.md`](plugins/linear/README.md) — native Linear and Kanban integration
- [`docs/perplexity.md`](docs/perplexity.md) — optional search provider
- [`plugins/linear/`](plugins/linear/) — optional Linear integration on core Kanban (staged, disabled)
- [`plugins/kokoro-voice/`](plugins/kokoro-voice/) — optional local Kokoro sidecar TTS
- [`plugins/browser-handoff/`](plugins/browser-handoff/) — optional browser handoff
- [`plugins/readonly-source/`](plugins/readonly-source/) — optional allowlisted read-only snapshot tools
- [`scripts/tooling-policy-hook`](scripts/tooling-policy-hook) — optional overlay install-policy hook
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and public boundary
- [`contracts/`](contracts/) — machine-readable architecture boundaries

## License

[MIT](LICENSE)
