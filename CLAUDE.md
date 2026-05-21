# CLAUDE.md — Switchroom

This file orients Claude Code (and other agentic tools) to this repo.
`AGENTS.md` and `AGENT.md` are symlinks to this file — edit here, not
there.

## What this project is

Switchroom is a Telegram plugin + agent lifecycle layer sitting on top of
the unmodified `claude` CLI. Users run Claude Code agents 24/7 on a Linux
box, talk to them from Telegram, and authenticate with their Claude
Pro/Max subscription via OAuth (no API keys, no custom runtime around
claude). The headline feature is a live **progress card** that pins into
each Telegram topic while an agent works.

**Agents ship in Docker containers** — one per agent, plus two shared
singletons (`vault-broker`, `approval-kernel`) brought up by `docker
compose`. The `claude` CLI runs unmodified inside each agent container
— Docker is for *distribution and isolation*, not a custom runtime
around claude (the vision's "no Docker-as-runtime" line in
`reference/vision.md` is preserved).

> **Cron-fold-in note (v0.8 / Phase 4).** Earlier releases had a third
> singleton, `switchroom-cron`, that fired every agent's scheduled
> tasks via `docker exec`. The cutover (PRs #890–#893) retired that
> container; cron now runs in-container in every agent as a sibling
> of the gateway, delivering fires through the same `InboundMessage`
> IPC path Telegram uses (synthesized turns tagged `meta.source="cron"`).
> See `docs/scheduling.md` for the post-cutover model.

See `README.md` for the user-facing description.

## Hard constraint — Claude-native, subscription-funded (a core pillar)

This is **non-negotiable** and load-bearing for the entire product —
it is `reference/vision.md` pillar 3 ("subscription-honest") restated
as an engineering gate. A change that violates it is out of scope by
construction, however useful it seems.

- **Every agent runs the unmodified `claude` CLI**, authenticated with
  the operator's **Pro/Max OAuth** credentials. No `ANTHROPIC_API_KEY`,
  no API keys of any kind, no Claude Agent SDK, no raw Anthropic API,
  no protocol interception, no custom inference runtime. switchroom is
  scaffolding and lifecycle management *around* the CLI — never a
  harness *over* it.
- **The reason is Anthropic policy compliance**, not merely cost. Using
  the native CLI on the subscription is what keeps switchroom inside
  Anthropic's third-party policy. Treat it as a compliance boundary,
  not a preference.
- **`claude -p` (headless/print mode)** is the same CLI + OAuth, but
  as of the **2026-06-15** policy it is *programmatic usage* — a
  separate credit, off subscription limits. Adding a new `claude -p`
  callsite is a constraint violation: route the work through the
  interactive agent session as a synthesized turn instead. The
  existing callsites are being removed — see
  `docs/rfcs/eliminate-claude-p.md`. A CI guard
  (`tests/bridge-flap-regression-guard.test.ts`) already enforces
  `--strict-mcp-config` on any headless `claude` spawn.
- **Before adding any code path that calls a model:** it MUST be the
  interactive `claude` session, or a synthesized turn injected into it
  (the cron / `inject_inbound` pattern). If you reach for the SDK or
  the API, stop — that is not switchroom.

## v0.7+ runtime architecture (read this before touching docker/compose/broker code)

```
                  ┌─ vault-broker (root, cap_drop=ALL + CHOWN/FOWNER/DAC_READ_SEARCH)
                  │    /etc/machine-id mount → auto-unlock derives AES key
                  │    binds /run/switchroom/broker/<agent>/sock per agent (chowned to UID)
                  │    healthcheck: bind-presence probe (PR #898)
                  │
docker compose ───┼─ approval-kernel (root, mirror of broker socket model)
project=switchroom│    binds /run/switchroom/kernel/<agent>/sock per agent
                  │    healthcheck: bind-presence probe (PR #898)
                  │
                  └─ agent-<name> ✕ N (per-agent UID 10001-10999, network_mode: host)
                       tini → start.sh → tmux server+client → bash → claude
                                              ↑ telegram-plugin gateway sidecar
                                              ↑ autoaccept-poll sidecar (sibling to tmux)
                                              ↑ agent-scheduler sidecar (cron, since Phase 4)
```

**Agent container process tree** (since v0.7.5): `tini` is PID 1.
`start.sh` runs as tini's child. When `SWITCHROOM_RUNTIME=docker` is set
(by compose) and `SWITCHROOM_DOCKER_TMUX_INNER` is unset (top-level
entry), start.sh forks `bun /opt/switchroom/autoaccept-poll.js <name>`
as a sidecar then `exec`s into `tmux -L switchroom-<name>
new-session -A -s <name> bash -l "$0"` — the same script re-enters
inside tmux with the inner-marker set, skips the wrapper, and runs
claude. autoaccept-poll uses `tmux capture-pane / send-keys` against
the same socket+session names to dispatch first-run prompts (dev-channels
acknowledge, MCP trust, theme picker).

**Why both halves matter:** without tmux, autoaccept can't reach claude
(it talks tmux), `switchroom agent attach` can't connect (it does
`docker exec -it ... tmux attach -t <name>`), and `! interrupt`
(`tmux send-keys C-c`) has nowhere to send. The contract is "tmux
socket `switchroom-<name>` + session `<name>` lives inside the agent
container" — pinned in `src/agents/autoaccept.ts:151`,
`src/agents/lifecycle.ts:attachAgent`, and `profiles/_base/start.sh.hbs`.

**Per-agent socket model:** compose mounts named volume
`broker-<name>-sock` at `/run/switchroom/broker/<name>` inside the
broker AND at `/run/switchroom/broker` inside agent-<name>. Broker
enumerates subdirs at `/run/switchroom/broker/`, binds a socket at
`<subdir>/sock`, chowns it to the agent UID (CAP_CHOWN granted) so a
non-root agent container can connect. Path-as-identity invariant: agent
name is parsed from the bind path via `socketPathToAgent` — never from
a wire payload. Same shape for approval-kernel.

**Vault auto-unlock:** machine-bound — broker derives an AES key from
`/etc/machine-id` (host-mounted into the broker container) and decrypts
the `vault-auto-unlock` blob on boot. Operator runs `switchroom vault
broker enable-auto-unlock` once on the host to write the blob; rotation
is via the same CLI. If the blob is missing or fails to decrypt, the
broker falls back to interactive unlock (`switchroom vault broker
unlock` from any agent's Telegram chat with `/vault unlock`, or via
`docker exec -it switchroom-vault-broker ...`).

**Vault on-disk layout (v0.7.12+).** The vault is a *directory*
(`~/.switchroom/vault/`) containing `vault.enc`, not a single file.
Pre-v0.7.12 it was just `~/.switchroom/vault.enc` and atomic-rename
hit cross-fs EBUSY on docker single-file bind mounts. The migration
helper (`src/vault/migrate-layout.ts`, PR #955) moves the file in
place and symlinks the legacy path so existing `vault.path` configs
keep working. The 5-state migration machine (A virgin / B
pre-migration / C partial / D post-migration / E divergent) is
the contract — read the file's header doc before touching it. The
*directory* is what compose bind-mounts into the broker; the
`apply.ts` guard refuses to mount if the dir contains files outside
the artifact whitelist in `KNOWN_VAULT_ARTIFACT_NAMES` /
`_PATTERNS`. See `docs/vault.md` § "Layout" and
`docs/operators/rollback-v0.7.12.md` for downgrade.

**Networking:** agent containers use `network_mode: host` so scaffolded
`start.sh` can reach hindsight at `127.0.0.1:18888` and operator LAN
devices. Tradeoff: agents share the host network namespace (no
inter-agent isolation). The trust model already assumed shared-host
operation. Future work: an opt-in strict-isolation mode with
`extra_hosts: host.docker.internal`.

**Self-restart commands (`/restart`, `/new`, `/reset`, `/update apply`).**
Since RFC C Phase 2 (default-flip, #1338) `host_control.enabled`
defaults **true**, so the gateway dispatches these four verbs through
the **`switchroom-hostd`** daemon (a host-side container in its own
compose project with the docker socket mounted) over UDS —
`telegram-plugin/gateway/hostd-dispatch.ts` is the primary path.
`spawnSwitchroomDetached` (`telegram-plugin/gateway/gateway.ts`) is now
the **fallback**, used only when hostd is `"not-configured"`
(host_control explicitly disabled, per-agent socket absent, or daemon
unreachable). There is deliberately *no* silent spawn fallback when
hostd is configured-on.

Two load-bearing primitives in the spawn-detached *fallback* path that
are easy to "simplify away" and break the self-restart case:

  1. **Detached spawn + restart-marker dance.** The gateway runs
     inside the agent container in v0.7+; when it asks docker (via
     `switchroom agent restart`) to restart its own container, the
     parent dies as soon as the recreate begins. The fix is to
     spawn the child with `detached: true` + `.unref()` and capture
     the originating chat in the restart marker before the kill —
     see primitive 2. (Historical note: a legacy branch of this
     helper also wraps the spawn in `systemd-run --user --scope`
     for v0.6 non-docker installs where the gateway ran as a host
     systemd unit. That branch is unreachable in v0.7+ docker
     agents — `systemd-run` is absent inside the container — and
     is scheduled for removal in Phase 3 of the host-control
     daemon rollout. Don't add new dependencies on it.)

  2. **Restart marker + sweep** (`writeRestartMarker`,
     `stampUserRestartReason`, `sweepBeforeSelfRestart`). Captures
     the originating chat so the post-restart greeting card edits
     into the same message; clears active reactions so they don't
     get stranded across the restart. All four self-restart commands
     share the marker, so a `/restart` fired mid-`/update` is
     debounced by the same 15s window (and vice versa).

**`/update apply` docker-availability guard (#926).** The agent
container has no docker binary or `/var/run/docker.sock` mount.
`isDockerReachable()` in the gateway probes both before the
spawn-detached fallback; on failure it surfaces a clean error
pointing at the host CLI rather than an opaque exit-127. The proper
fix — the host-control daemon (RFC C,
`docs/rfcs/host-control-daemon.md`) — **has landed**: Phase 1
(library + per-agent socket bind mounts) and Phase 2 (gateway
callsites swapped, default-on, #1306/#1338) are both shipped, so
hostd is the primary path described above. Phase 3 (removing the
legacy `systemd-run` fallback branch) is the only remaining step.

**Agent-scheduler env knobs.**
- `SWITCHROOM_INLINE_SCHEDULER` — set to `0` in the compose env to
  disable the in-agent scheduler entirely. Default: enabled. Useful
  for narrowing a wedge to a single agent.
- `SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN` — minutes the boot replay
  walks back looking for missed cron fires. Default: 30. Set to 0
  to disable replay.
- `SWITCHROOM_AGENT_SCHEDULER_LOCK` / `SWITCHROOM_AGENT_SCHEDULER_JSONL`
  — override the lockfile / audit log paths. Default: under
  `/state/agent/`. Used by tests; operators rarely need to set.
- `SWITCHROOM_GATEWAY_SOCKET` — override the IPC socket the
  scheduler dispatches `inject_inbound` through. Default: under
  the agent's telegram state dir.

The empty-schedule idle path (#921) means agents with no `schedule:`
entries stay alive (instead of restart-cap'ing). Look for the line
`agent-scheduler: <name> has no schedule entries — idling` in
`/var/log/switchroom/agent-scheduler.log` to confirm.

## Docker test discipline (HARD RULES)

These rules are permanent guidance for every phase of the docker migration, not phase-1c-scoped commentary. Tests run on a host that ALSO runs Coolify, hindsight, nginx-tunnel-gateway, and every Coolify-managed app. Treat the host as production.

- Every test container MUST be created with the label `switchroom.test=<phase>` — substitute the phase you're working in (e.g. `phase1c`, `phase2c`, `phase3a`). Add a per-run UUID label too (e.g. `switchroom.test.run=<uuid>`).
- Every `docker run` MUST use `--rm` so containers self-clean on exit.
- The ONLY sanctioned bulk-teardown command is filtered by label — same `<phase>` value as the create label:

  ```
  docker rm -f $(docker ps -aq --filter label=switchroom.test=<phase>) 2>/dev/null || true
  ```

- **Exception — detached for inter-call inspection:** if a test genuinely needs `docker run -d` (no `--rm`) because it `docker exec`s into the container between assertions, that's allowed BUT the callsite must (a) carry the standard labels, (b) have an explicit per-name `docker rm -f` in `finally`, AND (c) be covered by `safeLabelTeardown` in `afterAll`. All three. No exceptions to the exception.
- ABSOLUTE BAN: `docker ps -a | xargs docker rm`. Bare `docker rm $(docker ps -aq)`. `docker system prune`. `docker container prune`. `docker volume prune`. None of these. Ever. On any host.
- Per-container removal by explicit name is fine and is the pattern the existing tests use (see `tests/docker/per-agent-isolation.test.ts:248`, `tests/docker/e2e.test.ts:172`).
- Project-scoped compose teardown is also fine: `docker compose -p <project> down -v --remove-orphans`. Scope is the compose project name — won't touch anything outside it.
- If you find yourself wanting to "just clean everything up", STOP and ask.

## Design contract

`reference/` is the design contract for any non-trivial change. Three
docs, three questions:

**Vision — `reference/vision.md`** — *should we build this?*
Every feature serves one of four outcomes:

1. **A standing team that knows you** — specialists with persona +
   memory, not one generalist
2. **You hold the leash** — controlled, purposeful, never roaming;
   awareness + control, not a tool-call log to babysit
3. **Subscription-honest and predictable** — the plan is the ceiling;
   the unmodified `claude` CLI on the subscription, no API/SDK
4. **Always available** — there in Telegram the second you reach for
   it; survives reboots, runs its schedules

**Principles — `reference/principles.md`** — *did we build it well?*
Three checks. A "no" on any one is a redesign, not a follow-up:

1. **Docs test** — can someone use this without opening `docs/`?
2. **Defaults test** — does it work on a fresh `switchroom setup` with zero config?
3. **Consistency test** — same CLI shape, cascade, vault syntax, progress card as adjacent features?

**JTBDs — `reference/<job>.md`** — *did it do the user's job?*
13 outcome-focused jobs grouped by outcome in `reference/README.md`.
Survey cheaply: `head -5 reference/*.md` reads every `job: / outcome:
/ stakes:` frontmatter in one shot. Read in full only the JTBD(s) the
change touches.

### Triggers — when to consult deeper

- **Designing or scoping** → read `vision.md`; name which outcome.
- **Opening a PR / doing review** → run the three checks above; cite the JTBD the change serves in the PR description.
- **Touching a UX surface** (CLI output, error messages, progress card, setup flow, profile/skill defaults) → read the matching JTBD's *Anti-patterns* section before designing.

### Verdict rule

A change ships when it (a) advances one of the four outcomes,
(b) satisfies its JTBD, and (c) passes all three principle checks.
Anything else is out of scope, however clever.

## Repo layout

```
src/                    TypeScript source for the `switchroom` CLI
  agents/               Agent scaffolding, lifecycle, workspace bootstrap
                        compose.ts — generates ~/.switchroom/compose/docker-compose.yml
                        scaffold.ts — renders start.sh, settings.json, .mcp.json per agent
                        autoaccept.ts — tmux capture-pane / send-keys first-run dispatcher
                        lifecycle.ts — start/stop/restart/status/attach
  auth/                 OAuth + multi-account slot pool (accounts.ts, manager.ts)
  cli/                  One file per top-level CLI verb (auth, agent,
                        workspace, debug, memory, topics, vault, ...)
                        autoaccept-poll.ts — bun-runnable bundle baked into agent image
  config/               YAML loader + three-layer cascade (defaults → profiles → agents)
  memory/               Hindsight memory integration
  scheduler/            Cron synthesis primitives — collectScheduleEntries,
                        dispatchAsInbound, JsonlAuditSink. Shared by the in-agent
                        scheduler (no host-side scheduler runtime since Phase 4).
  agent-scheduler/      In-container cron sibling — index.ts (entrypoint), ipc-client.ts
                        (NDJSON-over-UDS to gateway), lock.ts (pidfile dedup),
                        replay.ts (at-least-once boot replay). Bundled into
                        dist/agent-scheduler/index.js, baked into the agent image.
  setup/                Interactive `switchroom setup` wizard
  telegram/             Shared telegram helpers used by the CLI
  vault/                AES-256-GCM encrypted secrets store
    broker/             Long-lived UDS daemon (server.ts, client.ts, peercred.ts)
                        Per-agent sockets at /run/switchroom/broker/<name>/sock
    approvals/          approval-kernel — per-agent UDS for approval/grant flows
  web/                  Web dashboard

telegram-plugin/        The enhanced MCP Telegram plugin (own Bun tests)
  server.ts             MCP stdio server entry
  card-format.ts        Shared status-card formatters (progress card
                        rendered via stream-reply-handler.ts + subagent-watcher.ts)
  tool-labels.ts        Tool-use label formatting
  auth-slot-parser.ts   /auth router (add/use/list/rm)
  auto-fallback.ts      Quota-exhaustion auto-fallback
  tests/                Bun tests

docker/                 Dockerfiles (base, agent, broker, kernel). Built via
                        `--build-local` flag on `switchroom apply`, OR pulled
                        from GHCR (`ghcr.io/switchroom/switchroom-*:latest`).
                        Dockerfile.scheduler was retired in Phase 4 of the
                        cron-fold-in (#893) along with the singleton container.
profiles/               Built-in agent profiles (CLAUDE.md.hbs + SOUL.md.hbs)
                        _base/start.sh.hbs is the agent entry script template
                        (includes the docker-mode tmux preamble, since v0.7.5).
skills/                 Bundled Claude Code skills (symlinked into agents)
docs/                   User-facing docs
reference/              Design contract — vision.md, principles.md,
                        and outcome-focused JTBDs (*.md)
scripts/                Build + release helpers
tests/                  Vitest suite for src/
  docker/               Docker-specific tests (compose generator, broker IPC,
                        per-agent isolation, e2e). Use `switchroom.test=<phase>`
                        labels — see "Docker test discipline" above.
```

Agent scaffolds are written **outside** this repo (default
`~/.switchroom/agents/<name>/`) — never commit per-user agent state here.
The generated compose file lives at
`~/.switchroom/compose/docker-compose.yml`.

## Commands

```bash
bun install              # install deps (project uses bun.lock)
bun run dev -- <args>    # run the CLI directly from src/ via bin/switchroom.ts
npm run build            # compile src/ + telegram-plugin/ → dist/
npm run lint             # tsc --noEmit (type-check only, no emit)
npm test                 # vitest (src/) + bun test (telegram-plugin/)
npm run test:vitest      # src/ only
npm run test:bun         # telegram-plugin/ only
npm run test:watch       # vitest --watch
```

The build output (`dist/`) is what `switchroom` resolves when installed
globally. During local work on src/, prefer `bun run dev` over rebuilding.

## CI

**GitHub Actions is primary and gating.** `main` is protected by a
**repository Ruleset** (`main branch protection`, id `16470166`) —
not classic branch-protection. It enforces **10 required GHA checks**:
`lint`, `bun-test`, `vitest`, `build-base`, `build-hindsight`, and
`build-dependents (×5)` (agent, broker, kernel, auth-broker, hostd),
plus `non_fast_forward` + deletion protection. (`lint`/`bun-test`/
`vitest` are the always-running *sentinel* contexts that aggregate
the path-gated shards — see #1343 and the sentinel pattern in
`.github/workflows/ci-*.yml`; the old `unittest`/`vitest (1..4)`/`e2e`
names are retired.) A PR cannot merge to `main` until all 10 are
green.

**Governance posture (sec WS9-F2 / R7, set 2026-05-17 — deliberate,
do not "re-harden" without the owner revisiting):**
- **Admin-bypass is genuinely locked** — the ruleset's `bypass_actors`
  is empty (it previously granted the Admin role `bypass_mode:
  always`, which contradicted this doc's prior "admin bypass is off"
  claim). Repo admins (and anything with admin access) go through the
  10 checks like everyone else; there is no force-merge escape — the
  CI recovery lever is `workflow_dispatch` re-trigger, not bypass.
- **No required human PR review, by design.** switchroom is operated
  via autonomous agents that open PRs and auto-merge on green; a
  required-review rule on this solo-owner repo would deadlock that
  model. The load-bearing supply-chain hole (a PR skipping the test
  gates via path-filter blind spots) is closed *in the checks
  themselves* (#1405 / sec WS9-F1), so required review would be
  defense-in-depth, not the essential control — and is intentionally
  omitted.
- **`strict` (require-branch-up-to-date) is intentionally OFF** (sec
  WS9-F5, accepted residual): enabling it would stall the autonomous
  auto-merge flow; merge-skew risk is accepted given the now-
  comprehensive required checks.

Auto-merge is enabled repo-wide, so a PR with `--auto` enabled
merges itself the moment the last required check turns green (this is
the intended operating model — see above).

When checking PR state, `gh pr checks <n>` is the source of truth.
Look at:
- The named checks above (must be `pass`).
- `mergeStateStatus` — `CLEAN` means ready, `BLOCKED` means a required
  check is pending or failed, `DIRTY` means there's a merge conflict
  with `main`, `UNSTABLE` is the not-yet-required-checks state and is
  usually fine to merge if the required ones are green.

**Buildkite is retired** (PR for retirement: ci/retire-buildkite,
2026-05-15). UAT fuzz / race-long / evals are now on GHA
(`ci-uat`, `ci-tests-race-long`, `ci-evals`). The legacy
`.buildkite/` directory was removed; the three load-bearing shell
scripts (`docker-snapshot-gate.sh`, `annotate-evals.sh`,
`publish-badges.sh`) moved to `scripts/ci/` and the GHA workflows
were updated to reference the new paths.

Required-check tuning is a **Ruleset** edit, not classic protection:
`gh api repos/switchroom/switchroom/rulesets/16470166` to read, then
`gh api --method PUT repos/switchroom/switchroom/rulesets/16470166
--input <body>` with the `required_status_checks` rule's contexts
updated (preserve the other rules + `bypass_actors: []` + `enforcement:
active`). A new workflow that should gate merges is NOT auto-added —
it needs an explicit ruleset update. (The old
`branches/main/protection/...` classic-protection API path no longer
governs this repo.)

## Conventions

- **Language:** TypeScript, ES modules, Node ≥ 20.11. Strict TS config.
- **Tests:** vitest for `src/` + `tests/`, bun test for
  `telegram-plugin/tests/` (some rely on Bun's native APIs). Both run
  under `npm test`.
  - **Import the right runner.** Tests under `src/` + `tests/` MUST
    import from `"vitest"`, not `"bun:test"` — vitest can't resolve
    `bun:test` and the whole suite fails to load. The natural reach is
    `bun:test` because the project is bun-runtime; resist it. If a
    file genuinely needs bun-only APIs (`mock()`, `bun:sqlite`,
    `spyOn`), add it to the `exclude` array in `vitest.config.ts`. The
    `lint:bun-test-imports` step catches this structurally — five PRs
    in 24h on 2026-05-14 fixed this same one-line bug class before
    the lint rule landed.
- **No commented-out code.** Don't leave `// TODO: rename` or half-dead
  blocks — either fix it or open an issue.
- **CLI structure:** each top-level verb gets its own file in `src/cli/`
  with a `register<Name>Command(program)` export wired into
  `src/cli/index.ts`. Follow the existing shape when adding a verb.
- **Config cascade** is the central abstraction — see
  `docs/configuration.md` and `src/config/merge.ts`. New fields need a
  documented cascade mode (union / override / per-key merge / concat /
  deep-merge).
- **Commit style:** Conventional Commits (`feat(scope):`, `fix(scope):`,
  `docs(scope):`, `test(scope):`, `chore(scope):`). Recent history is a
  good reference — `git log --oneline -20`.
- **Effort estimates:** in **agent minutes** (wall-clock for a
  current-generation Claude agent doing the work end-to-end including
  tests), not human dev hours. "12 dev hours" is the wrong unit;
  "~25 agent minutes" is the right one. Reserve human-time estimates
  only for work that explicitly needs the user's review or input.

## Repo model & dev flow

Switchroom uses a **fork + canonical** model. Read this before pushing.

- **`switchroom/switchroom`** — canonical public repo, source of truth
  for releases. All `npm publish` output comes from here. Tagged
  versions (`v0.X.Y`) live here.
- **Your fork** (e.g. `<your-username>/switchroom`) — where you work.
  Feature branches + PRs on the fork for iteration; release-time PRs
  from the fork's `main` → `switchroom:main`.

**Local git remotes** should be:
- `origin` → your fork (for push)
- `upstream` → `switchroom/switchroom` (for pulling canonical updates)

Agent working on this repo: when you open a PR, **target
`switchroom/switchroom:main`** as the base, not the fork's main. The fork
is a staging area for your own iteration; the canonical repo is where
review + merge + release happens.

### Two workflows — know which one you're in

**1. Code-change dev loop (most common).** Editing source, iterating
locally. Full process in **Standard dev process** below.

**2. Release to npm (canonical maintainers).** Bump `package.json`,
update `CHANGELOG.md`, tag, push, `npm publish`. Full process in
**Standard release process** below.

### Standard dev process

This is the **mandatory** path for any non-trivial change. Skip steps
only with an explicit operator instruction (e.g. "no review", "ship
without UAT").

**1. Branch off `upstream/main`, in a fresh worktree.**

Multiple agents share this server and can collide on the same checkout.
Always work in a per-task worktree:

```
git fetch upstream
git worktree add ~/code/switchroom-<short-task-slug> \
  -b feat/<branch-name> upstream/main
cd ~/code/switchroom-<short-task-slug>
ln -s ~/code/switchroom-sec-1417/node_modules node_modules
```

The `node_modules` symlink lets `bun`/`vitest` resolve dependencies
without re-installing. `bun install` in a fresh worktree on this host
is unreliable — see `feedback_worktree_node_modules_symlink` memory.

**2. Implement, with tests.**

For most modules: a Vitest test that pins the behaviour you're adding.
For draft-stream / streaming code: tests run under **both** vitest AND
`bun test`, so avoid bun-incompatible APIs (e.g.
`vi.advanceTimersByTimeAsync` — use the sync `vi.advanceTimersByTime`
plus `await microtaskFlush()` instead). See
`telegram-plugin/tests/draft-stream.test.ts` for the canonical pattern.

For state-machine / pure-function changes: property tests with
~1k–10k random schedules.

**3. Validate locally before pushing.**

```
./node_modules/.bin/vitest run <path-to-affected-tests>
./node_modules/.bin/tsc --noEmit          # plugin-references gate
node scripts/check-plugin-references.mjs  # if you touched plugin/
bash scripts/check-bot-api-wrapping.sh    # if you touched gateway.ts
```

The CI required-checks list is in **CI** above; the gates that run
locally cover the load-bearing subset.

**Two lint traps worth memorising:**

- **`check-bot-api-wrapping.sh` allowlist drift** (gateway.ts only).
  The allowlist of permitted raw `ctx.api`/`bot.api` callsites is
  line-keyed. Any line insertion in `gateway.ts` shifts pre-existing
  raw callsites past their allowlist range and CI fails — tsc + tests
  pass, only this script catches it. If you inserted any code in
  `gateway.ts`, run the script locally; widen the allowlist range in
  the same PR if needed. See
  `feedback_gateway_bot_api_allowlist_drift`.

- **Push Protection on token fixtures.** GitHub blocks contiguous
  token-shaped strings even in test fixtures. If you need a fake
  token for a secret-detector test, build it at runtime by
  concatenation (`"sk-ant-" + "fake" + "-xyz"`), never as a single
  literal. Pattern lives in
  `telegram-plugin/tests/secret-detect-secretlint.test.ts`.

**4. Commit with Conventional Commits, push to fork, open PR against
`upstream/main`.**

```
git commit -m "feat(scope): short imperative summary

Longer body explaining the why and any non-obvious tradeoffs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/<branch-name>
gh pr create --repo switchroom/switchroom --base main \
  --head <your-fork-user>:feat/<branch-name> --title "..." --body "..."
```

PR title under 70 chars. Body covers: Summary, Why, Test plan
(check-list), Risk. Link any related PRs.

**5. Dispatch a fresh-process reviewer agent.**

The coder agent CANNOT review its own work in the same context — it
rubber-stamps. Spawn a separate `general-purpose` agent (or
`reviewer` if defined) with an explicit brief:

> Review PR #N (branch `<name>` against `<base>`). Verdict: APPROVE /
> REQUEST_CHANGES / BLOCK. Be specific about blockers and cite
> `file:line`.

Tell the reviewer what to check: behaviour equivalence, kill-switch
correctness, test adequacy, hidden coupling, CI state. Read the
review carefully. Iterate on REQUEST_CHANGES until APPROVE.

**Do not enable auto-merge before the reviewer APPROVE.** Per
`feedback_automerge_after_review`, auto-merge fires on CI-green and
will beat an out-of-band reviewer on a fast-CI / docs PR. The **CI**
section above documents that auto-merge is the intended *repo* policy
(autonomous agents + green-checks-merge); this dev-process step is
the *personal* gate that the coder agent applies on top — fresh
reviewer first, then turn on auto-merge.

**6. After APPROVE: enable auto-merge.**

```
gh pr merge <PR#> --repo switchroom/switchroom --auto --squash
```

The PR merges when all 10 required checks are green. If checks fail,
fix and re-push — never bypass hooks (`--no-verify`) or skip required
checks.

**7. UAT (when the change affects user-visible behaviour).**

See **Pre-rollout UAT (MTCute harness)** below. Required before any
fleet rollout; optional but encouraged before merging behaviour
changes.

### Standard release process

Cut a release **only** after the relevant feature PRs have merged to
`upstream/main` and you have at least one passing UAT (or an explicit
no-UAT directive).

**1. Release worktree off `upstream/main`.**

```
git fetch upstream
git worktree add ~/code/switchroom-rel-<vX.Y.Z> \
  -b chore/release-v<X.Y.Z> upstream/main
cd ~/code/switchroom-rel-<vX.Y.Z>
# For a RELEASE worktree, prefer a real copy over the symlink. `bun
# build` (the bundler in scripts/build.mjs) does NOT resolve through
# certain symlink shapes — the `~`-prefixed form `ln` leaves unexpanded
# silently produces an EMPTY dist/cli/. Releases have shipped broken
# this way (0.12.6 → 0.12.7 deprecation). See
# `feedback_npm_publish_landmines` for the post-mortem. Real copy is
# the safe default for a release worktree:
rm -rf node_modules && cp -a ~/code/switchroom-sec-1417/node_modules ./node_modules
```

**2. Bump `package.json` + CHANGELOG.**

- `package.json` `"version": "X.Y.Z"`.
- `CHANGELOG.md`: consolidate any `## unreleased — …` sections under
  a single `## vX.Y.Z — <theme>` header. For multi-PR releases,
  group entries under `### PR <letter> — <title> (#NNNN)` subsections.

**3. Build, verify, commit.**

```
# Never pipe build through tail — pipeline exit is tail's exit (0),
# so `npm run build | tail && npm publish` runs publish even on a
# failed build. Run build standalone:
node scripts/build.mjs
echo "BUILD EXIT=$?"                    # must be 0; abort otherwise
ls -la dist/cli/switchroom.js           # confirm exists, ~2.7MB
git checkout HEAD -- src/build-info.ts  # revert build-info only (node_modules is
                                        # untracked symlink/copy — don't `checkout` it)
git add CHANGELOG.md package.json
git commit -m "chore: release vX.Y.Z"
```

**4. Open release PR, auto-merge after CI green.**

```
git push -u origin chore/release-v<X.Y.Z>
gh pr create --repo switchroom/switchroom --base main \
  --head <your-fork-user>:chore/release-v<X.Y.Z> \
  --title "chore: release vX.Y.Z" --body "..."
gh pr merge <PR#> --repo switchroom/switchroom --auto --squash
```

Release PRs are usually trivial diff + green CI = APPROVE-equivalent;
the reviewer step can be skipped IF every constituent feature PR was
properly reviewed.

**5. Tag the merged commit + push the tag.**

```
git fetch upstream && git reset --hard upstream/main
git tag vX.Y.Z <merge-commit-sha>
git push upstream vX.Y.Z
```

The tag push triggers the `docker-images` workflow, which builds
the per-version-tagged ghcr.io images (~5 min).

**6. npm publish — verify the tarball first.**

Per `feedback_npm_publish_landmines`: ALWAYS verify the tarball has
`dist/cli/switchroom.js` before publishing. Past releases have shipped
broken (0.12.6→0.12.7) because dist wasn't bundled.

```
node scripts/build.mjs                          # rebuild — reset --hard wipes dist
npm pack                                        # produces switchroom-X.Y.Z.tgz
tar tzf switchroom-X.Y.Z.tgz | grep -E "dist/cli/switchroom.js|vendor/hindsight" | head -5
npm publish --ignore-scripts switchroom-X.Y.Z.tgz
```

`--ignore-scripts` skips `prepublishOnly` (which would re-run build +
lint + test); the just-verified tarball is what publishes. Operators
running `npm i -g switchroom` get the newest version.

**7. Update local host CLI.**

```
sudo env PATH=$PATH npm i -g switchroom@X.Y.Z
switchroom --version    # confirm X.Y.Z
```

**8. Wait for docker-images workflow to complete.**

```
gh run list --repo switchroom/switchroom --workflow=docker-images --limit 2
```

The `v<X.Y.Z>` tag-trigger run takes ~5 min. Don't roll the fleet
until ALL 5 images (agent, broker, auth-broker, kernel, hindsight)
are pull-able under the new tag.

**9. Canary on test-harness BEFORE fleet rollout.**

This is the mandatory gate. See **Pre-rollout UAT (MTCute harness)**
below.

**10. Fleet rollout — staggered, not bulk.**

After UAT passes:

```
sudo env PATH=$PATH HOME=$HOME switchroom update --pin vX.Y.Z
# OR per-agent (preferred for the first staggered rollout of any
# risky change — sequential, blocks until each agent's reconcile
# returns):
for a in clerk gymbro ziggy klanker lawgpt carrie finn reggie; do
  sudo env PATH=$PATH HOME=$HOME switchroom agent restart $a --force
  # `--version` assertion guards the `:latest` pull-race documented
  # in `project_release_rollout_ci_gotchas`. Without it, agents may
  # still report the prior version because the local docker daemon
  # raced GHCR's `:latest` tag update.
  docker exec switchroom-$a sh -lc 'switchroom --version' | grep -q "X.Y.Z" \
    || { echo "version mismatch on $a"; break; }
done
```

The historical thundering-herd wedge — mass-recreate stranding
mid-turn inbounds — was closed by the self-heal landing in v0.12.16
(#1546/#1549) and the durable inbound spool in v0.12.19 (#1558). So
the wedge class is no longer load-bearing for the stagger. The
sequential per-agent recipe is still preferred for two reasons: each
`switchroom agent restart` blocks ~30s on the boot card, naturally
spacing the bounces; and the `--version` assertion per-agent catches
the `:latest` pull-race that's still a live concern.

### Pre-rollout UAT (MTCute harness)

The `telegram-plugin/uat/` directory uses **mtcute** — a real Telegram
client driving a real bot over real chat. It's the only way to exercise
the full inbound → claude → outbound path end-to-end. **Required**
before any fleet rollout.

**Setup (one-time per dev host).**

```
cp .env.example .env                # operator credentials for mtcute
bun run uat:login                   # interactive — pastes a Telegram code
bun run uat:driver-info             # confirms session is valid
```

The driver session persists in `.env`'s `MTCUTE_SESSION` so subsequent
runs are non-interactive.

**Scenarios live at `telegram-plugin/uat/scenarios/`.**

Naming convention: `jtbd-<job>-<surface>.test.ts`. Each scenario
spins up a driver, sends a DM via the real Telegram API to a real
agent, asserts the response shape and timing.

```
bun run --cwd telegram-plugin test:uat jtbd-fast-trivial-dm
```

**When releasing changes that touch streaming, message format, or
turn lifecycle, run at least:**

- `jtbd-fast-trivial-dm` — warm-cache TTFO (baseline ~1.7s in DM).
- `jtbd-always-on-after-restart-dm` — first message after a restart
  must reply within 60s (the 5-min wedge regression gate).
- `jtbd-memory-survives-restart-dm` — memory persistence across
  restart.
- Any new scenario specific to the feature shipping.

If a UAT fails, **roll back the test-harness canary** and investigate.
Do NOT proceed to fleet.

**Canary discipline.**

The flow is always:

1. Roll test-harness to the new version, NOT the fleet:
   ```
   sudo env PATH=$PATH HOME=$HOME switchroom update --pin vX.Y.Z
   # (update is fleet-wide; until per-agent update exists, this
   # bounces all 9 — accept that for canary OR use a feature flag /
   # env var to keep the new code dormant on the other 8 until
   # validated.)
   ```
2. Run the UAT suite against test-harness.
3. Tail `/var/log/switchroom/gateway-supervisor.log` for the new
   trace lines / log shapes the change should produce.
4. Observe ≥1 real human DM round-trip if the change is user-visible.
5. If green: fleet rollout (step 10 of the release process).
6. If red: revert the pin (`switchroom update --pin v<previous>`)
   and queue a fix PR.

**The release isn't "shipped" until step 5 of the canary passes.**
Tagging + publishing + rolling are necessary but not sufficient.

### Operator update — `switchroom update`

For a host that's already running switchroom and just needs to catch
up with upstream, use the `update` verb (since #918 / v0.7.8). It
collapses what used to be three separate operator steps:

```
switchroom update              # pull images + apply + recreate + doctor
switchroom update --check      # dry-run: print the plan, exit 0
switchroom update --status     # read-only: CLI version + image/container ages
switchroom update --rebuild    # source-checkout users: also git pull + npm build
```

`apply` self-elevates via sudo internally (since #920) when the per-
agent scaffold dirs need root — no need for the operator to memorize
the old `sudo HOME=… PATH=… bun /path/to/dist/cli/switchroom.js
apply --non-interactive` incantation.

`apply` also runs a focused `doctor` sweep against the Agents section
on success (since #929) so the post-apply state is visible without
a separate verb. Suppress with `--no-doctor`; `update` passes this
internally to avoid double-printing (it has its own doctor step).

### Telegram operator surfaces

The same flow is reachable from any agent's DM (since #919, #927):

- `/upgradestatus` — read-only fleet snapshot (CLI version, image
  digests + ages, container ages). Not admin-gated.
- `/update` — dry-run plan (calls `switchroom update --check`).
- `/update apply [--skip-images|--rebuild]` — execute. Admin-gated.
  Internally guards with a docker-availability probe (#926): on the
  canonical docker install the agent container has no docker
  binary/socket, so the apply path returns a clean error pointing
  the operator at the host CLI. Host-side update daemon (the proper
  fix for in-Telegram apply on docker hosts) is a tracked follow-up.

### Code ≠ runtime

A rebuild updates the CLI + dist/. It does **not** update running agent
processes — those loaded the code at boot and hold it in memory.
**Changes only go live after the runtime restarts post-build.** When
your work affects the CLI, the telegram-plugin, or scaffolded assets,
expect a `switchroom agent restart all` to be part of verification.

Since PR #59, `switchroom agent restart` always runs reconcile first
(regenerating the per-agent scaffold + the compose file if changed). So
a restart is also a mini-deploy of any scaffold changes — under the
hood it re-emits `~/.switchroom/compose/docker-compose.yml` and bounces
the affected container(s) via `docker compose up -d`.

### Install paths

`~/.bun/bin/switchroom` is typically a symlink to the workspace's
`dist/cli/switchroom.js`. If you built with `bun run build`, the global
CLI is already fresh — no `npm i -g` needed. An `npm i -g switchroom`
installs a separate, pinned copy at `~/.nvm/…/node_modules/switchroom`;
PATH resolution order determines which wins. Prefer the bun-linked install
on dev machines, the npm-global install on consumer machines.

### Secrets in tests

The repo has GitHub Push Protection enabled. Don't commit real-looking
tokens — even as test fixtures — as contiguous string literals. If you
need a token-shaped fixture for testing secret detectors, construct it
at runtime via string concatenation so the source file never contains a
contiguous token pattern. See
`telegram-plugin/tests/secret-detect-secretlint.test.ts` for the pattern.

## Safety rails

- **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`) without an
  explicit instruction. If a hook fails, fix the cause.
- **Never force-push `main`.** Feature work → branch + PR, unless the
  user explicitly asks for a direct push.
- **Don't touch** `clerk-export/`, `private/`, `.vault/`,
  `~/.switchroom/vault/`, or anything under `vendor/` without a reason —
  those hold secrets or third-party code.
- Telegram bot tokens, OAuth tokens, and vault keys must never land in
  commits. The vault CLI (`switchroom vault`) exists so you don't have
  to.

## Where to look first

(For *design intent* — outcomes, principles, JTBDs — see "Design
contract" above. The pointers below are for *implementation*.)

- **"How does config resolution work?"** → `src/config/merge.ts` +
  `docs/configuration.md`.
- **"How does the progress card render?"** →
  `telegram-plugin/stream-reply-handler.ts` + `telegram-plugin/card-format.ts`
  + `docs/telegram-plugin.md` (streaming modes section).
- **"How does auth work?"** → `src/auth/accounts.ts` (slot storage) +
  `src/auth/manager.ts` (OAuth flow). Telegram `/auth` routing lives in
  `telegram-plugin/auth-slot-parser.ts`.
- **"What can I inspect at runtime?"** → `switchroom debug turn <agent>`
  dumps exact prompt layering; `switchroom workspace render <agent>`
  prints the bootstrap block.
- **"How is the docker compose file generated?"** →
  `src/agents/compose.ts:generateCompose()`. Tests pin every emitted
  field at `tests/docker/compose-generator.test.ts`. UID allocation is
  `allocateAgentUid()` (deterministic hash → 10001-10999).
- **"How does the broker authenticate agents?"** → path-as-identity:
  `src/vault/broker/peercred.ts:socketPathToAgent()` parses the bind
  path. Two canonical shapes: flat `<agent>.sock` (legacy / tests) and
  subdir `<agent>/sock` (what compose emits). ACL is bind-time, never
  wire-time.
- **"How does an agent boot inside a container?"** →
  `profiles/_base/start.sh.hbs` (docker-mode preamble forks three
  supervised sidecars — telegram-plugin gateway, autoaccept-poll,
  agent-scheduler — then re-execs into tmux). `docker/Dockerfile.agent`
  copies the bundles to `/opt/switchroom/{switchroom.js,
  telegram-plugin/dist/, autoaccept-poll.js, agent-scheduler/index.js}`
  (the CLI is symlinked onto PATH at `/usr/local/bin/switchroom` for the
  gateway's shell-out path) and sets CMD to `/state/agent/start.sh`
  under tini. `src/agents/compose.ts` emits the env / volumes / caps
  and the broker/kernel healthchecks.
- **"How does autoaccept dispatch first-run prompts?"** →
  `src/agents/autoaccept.ts` (tmux capture-pane + send-keys, regex
  prompts in `PROMPTS`). Bundle entry at `src/cli/autoaccept-poll.ts`.
  start.sh forks it as an in-container sidecar.
- **"How does cron work post-Phase-4?"** → `src/agent-scheduler/`.
  `index.ts` is the entrypoint, supervised by start.sh. Cron fires
  call `dispatchAsInbound` (`src/scheduler/dispatch.ts`) to synthesize
  an `InboundMessage` tagged `meta.source="cron"`, then send it via
  `inject_inbound` IPC (`telegram-plugin/gateway/ipc-protocol.ts`)
  to the local gateway, which forwards it to the bridge as a
  synthesized turn. Audit at `/state/agent/scheduler.jsonl`; at-least-once
  boot replay is bounded to past 30 min by default. See
  `docs/scheduling.md` and the cron-fold-in PRs (#890–#893).
- **"How do I know if a singleton (broker / kernel) is healthy?"** →
  `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps`
  shows the new health column. Probe is bind-presence on
  `/run/switchroom/<svc>/*/sock` (PR #898). Empty fleets correctly
  read as unhealthy — a singleton with no agents to serve isn't
  doing useful work.
