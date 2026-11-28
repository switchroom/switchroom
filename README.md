# Switchroom

**An opinionated Hermes Agent distribution.**

**Hermes agents that work your projects, not just your chats.** One box per agent. Linear holds the thread. Runs on the Claude, ChatGPT or SuperGrok plan you already pay for, and lets you switch models as the lead changes.

Site: [switchroom.ai](https://switchroom.ai). Built on [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research; not affiliated with Nous Research, and not endorsed by Nous Research, Anthropic, OpenAI or xAI. This repository keeps its working name, `hermes-fleet`, until it moves to the `switchroom` org. Early access: there is no quickstart yet. Naming and positioning: [`reference/rfcs/switchroom-positioning.md`](reference/rfcs/switchroom-positioning.md).

1. **Works your projects.** The [Linear plugin](plugins/linear/README.md) gives long-running work one owning agent and one durable task per issue, posts checkpoints as issue comments, routes a follow-up from any chat to the same task, and lets several agents work one project with handoff between them. You see who owns what, what was done and what is next on the issue, not in a chat scroll. The plugin source is here and disabled in the bare image; end-to-end outcome evidence is still to validate.
2. **Safe to leave running.** One container and one gateway per agent, per-agent vaulted credentials, isolated by default. Agent-to-agent (A2A) stays an explicit opt-in per deployment, never a default.
3. **Runs on your plans.** Connect Claude, ChatGPT or SuperGrok, pick which one leads, and route each task role (chat, coding, fast, approvals, compression) to any plan you've connected ([Choose your plans](docs/choose-your-plans.md)). Claude leads today, not forever: swap the lead in one line (`primary_plan`) when a different lab pulls ahead. **Claude means your subscription quota, not API billing.** Claude runs through Claude Subscription DirectSDK (a Nous Research plugin its author labels experimental) and Claude ACP, on that agent's own Claude login, with no API key and no pay-per-token fallback. Claude ACP provides claude.ai connectors, qualified read-only so far. Every plan follows the same rule: a plan without a real login stays off, and nothing bills a plan you didn't connect. Model roles stay `planned` in [`contracts/plugins.json`](contracts/plugins.json) until a real boot proves them.
4. **Runs like infrastructure.** A digest-pinned child of an exact Hermes Agent image, config as code, a private overlay for identity and secrets, optional [encrypted volume backups with a restore check](docs/volume-backup.md), and opt-in report-only [host monitors](docs/monitors.md), a [daily upstream patch test](docs/upstream-patch-test.md) and a [1Password secret-reference audit](docs/secret-reference-audit.md).

Chat is standard Hermes: Telegram on the run, Slack or Desktop at your desk, and Linear keeps you from losing the thread across issues, projects and agents.

The public distribution is a provenance-bound child image, independent sidecar images, and the contracts that keep deployment identity out of the runtime. Pin every image by digest. Source or image publication is not a production rollout.

## Why this exists

Hermes Agent is one process. That is the wrong blast radius for a team. Upstream `hermes update` now folds multi-profile installs into one multiplexed gateway. Switchroom deliberately keeps one container and one gateway per agent, so a bad change, leak or upgrade stays inside one box.

Switchroom is many named specialists, each with its own container, gateway, writable state, workspace, Docker network, memory, and credentials. You get the same specialist back, and longer work stays on its Linear issue. A change to one leaves the others alone. Failed upgrades recover without taking the rest down.

The public product proves that pattern without shipping anyone's credentials, deployment identities, private binaries, or live topology.

## What winning looks like

These are the product outcomes. If a change advances none of them, it does not belong here.

- **Standing team.** Named specialists, each independently addressable, with unshared memory and credentials. Not one generalist wearing hats.
- **On a leash.** One agent cannot see another's files, network, or vault. An intended change lands on the target and every other in-scope agent is still independently working.
- **There when you reach.** Telegram, Slack, and Hermes Desktop have the same bar. A restart does not drop identity, tools, or sessions. Persistence includes working tools, not just surviving files.
- **Subscription-honest.** Claude leads today, not forever; ChatGPT and SuperGrok are peers. Claude stays on the granted plan login, not a silent API meter. Other billed plans follow the same rule.
- **Works your projects.** Someone running many pieces of work across several agents can see, per project and issue, who owns it, what was done and what is next, without reading chat history. Unmeasured.

North Star is **trusted unsupervised turns**: work the principal did not sit through, that finished without a rescue, stayed inside granted tools, and made no off-plan model call. Isolation that strips the integrations that make Hermes useful is a loss.

## Opinions we will not trade

**One profile, one container, one gateway.** A shared runtime with profile names is not a fleet. Each specialist is a Docker service with its own volume and network. No Docker socket, no host network, no privileged mode. The image user is UID/GID 1000 so containers can start with no-new-privileges.

**No shared credentials.** The child image includes the 1Password CLI with no vault config. The overlay injects Connect host, token, and allowed origins per container. Vault item bindings stay in that overlay. Two agents never share a Connect token or an OAuth login. Recreating a profile or borrowing another agent's secrets to get past a blocker is out of product.

**A reviewed default set, on by default, opt out per agent.** What the reference deployment runs daily (Claude Subscription DirectSDK as the default model path, Claude ACP connectors, Linear, voice, Honcho memory, web search and the working doctrine config) becomes the default, and anything outside that list stays off. Plugin source stays mounted read-only, not baked into the image. A default with a missing credential turns itself off and says so in a setup check instead of blocking startup, and no default adds a model or paid path you did not grant. The starter overlay in [`examples/overlay-repo/`](examples/overlay-repo/) turns them on. The bare image still turns nothing on. A default is `shipped` in [`contracts/plugins.json`](contracts/plugins.json) only after it was proven in real containers ([`docs/starter-overlay-acceptance.md`](docs/starter-overlay-acceptance.md)); the rest stay `planned`. Decision: [`reference/rfcs/default-on-distribution.md`](reference/rfcs/default-on-distribution.md).

**Digest or it did not happen.** Consume `ghcr.io/switchroom/switchroom@sha256:<digest>`. Mutable tags are not a supported interface. Built, published, and deployed are different claims. A green unit run is not publication. Publication is not a production rollout.

**Identity stays in the overlay.** This repository has synthetic examples. Household names, bot tokens, vault URIs, OAuth state, and live compose do not belong here. `scripts/verify-public-tree.py` fail-closes on the obvious cases. It is a shape check, not a secret scanner.

## How a deployment actually uses it

Copy [`examples/overlay-repo/`](examples/overlay-repo) into a private overlay repository. That overlay owns:

- fleet-wide Hermes defaults and per-agent overrides (`fleet-config/`)
- compose that pins this child image by digest
- unpublished binaries and install policy
- secret injection (1Password Connect, not files in git)
- plugin policy maps (Linear workers, browser origin, voice sidecar URL)

Each compose service is one specialist. The operator changes one service. The principal hands work to that specialist through Linear or any chat and gets it back, on the model plan they already pay for.

The example profiles in `compose.example.yaml` are synthetic. See [`docs/overlay-repository.md`](docs/overlay-repository.md).

## Plugins, and why they exist

**Disabled by default today.** Most are in the reviewed default set and will be on once the starter overlay lands. They exist so isolation does not mean a dumb agent.

### Linear

`plugins/linear/` links meaningful outcomes to native Hermes tasks and reports their progress through a durable outbox. Human checkpoints and meaningful lifecycle milestones appear as regular issue comments, while Agent Sessions retain live steps and heartbeats. A completed internal stage does not close the human issue; outcome completion remains bound to the accepted native specification. Native Hermes owns execution, permissions, worker claims, recovery and Stop. Ordinary chat and authorized issue operations need no Linear claim or task link. Cross-channel follow-ups reach the existing native task without transfer phrases or another executor. The mounted plugin can also expose and independently inspect one exact current native request without granting control permission. It preserves legacy records and uncertain effects for reconciliation. It remains disabled by default; identities, scopes and reporting routes are overlay configuration. Details: [`plugins/linear/README.md`](plugins/linear/README.md).

### Camoufox browser

The image installs Camoufox (pinned and attested) with a supervised, loopback-only camofox-browser service that opens it headed on the agent's own Bot Desktop. The official `camofox` plugin and `plugins/camoufox-desktop/` (Take over fence, hand-back note, steering, dock icon) make it the agent's primary browser once the overlay mounts and enables them; Chromium `browser_exec` stays as the backup. Details: [`docs/camoufox.md`](docs/camoufox.md).

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
Switchroom child image  (this repo, switchroom/switchroom)
        |
        +-- profile A container + state volume + workspace + network
        +-- profile B container + state volume + workspace + network
        +-- independent sidecar images (Kokoro)
```

Sidecar source lives under `sidecars/`. Each sidecar publishes its own GHCR image through a dedicated workflow.

## What's in the image

The published child, `ghcr.io/switchroom/switchroom`, is a digest-pinned child of an exact Hermes Agent image. It currently bundles:

- UID/GID 1000 for the `hermes` account so profile containers can start with no-new-privileges
- GitHub CLI 2.106.0 from the official release tarball
- 1Password CLI 2.42.0 from its digest-pinned official image (no vault config)
- Honcho Python SDK 2.9.0 in the Agent runtime and Honcho CLI 0.6.0 in an isolated environment, installed from hashed dependency locks with no workspace identifiers
- Codex, Grok, OpenCode, and Claude Code from the committed lockfile
- The optional plugins listed above
- Optional `tooling-policy-hook` binary for overlay install policy

Consume it only as:

```text
ghcr.io/switchroom/switchroom@sha256:<digest>
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
- [`docs/downstream-patches.md`](docs/downstream-patches.md) — build-time patches to third-party source, each with its upstream report and removal condition
- [`plugins/linear/README.md`](plugins/linear/README.md) — native Linear and Kanban integration
- [`docs/perplexity.md`](docs/perplexity.md) — optional search provider
- [`docs/volume-backup.md`](docs/volume-backup.md) — optional encrypted per-agent volume backups with a restore check (off by default)
- [`docs/monitors.md`](docs/monitors.md) — optional report-only host monitors: ownership audit, memory pressure, storage (off by default)
- [`docs/upstream-patch-test.md`](docs/upstream-patch-test.md) — daily re-apply of an overlay's Hermes Agent patches on the latest upstream; never deploys
- [`docs/secret-reference-audit.md`](docs/secret-reference-audit.md) — check each agent reads only its own 1Password references; never resolves a value
- [`plugins/linear/`](plugins/linear/) — optional Linear integration on core Kanban (staged, disabled)
- [`plugins/kokoro-voice/`](plugins/kokoro-voice/) — optional local Kokoro sidecar TTS
- [`recipes/`](recipes/) — opt-in Compose recipes: gated A2A, reviewed artifact publishing ([acceptance run](docs/opt-in-recipes-acceptance.md))
- [`plugins/screen-handoff/`](plugins/screen-handoff/) — optional `screen_handoff` tool: a link to the agent's Bot Screen, plus automatic take-back when a user messages the agent
- [`plugins/readonly-source/`](plugins/readonly-source/) — optional allowlisted read-only snapshot tools
- [`scripts/tooling-policy-hook`](scripts/tooling-policy-hook) — optional overlay install-policy hook
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and public boundary
- [`contracts/`](contracts/) — machine-readable architecture boundaries

## License

[MIT](LICENSE)
