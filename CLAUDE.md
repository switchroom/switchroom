# CLAUDE.md — Switchroom

This file orients Claude Code (and other agentic tools) to this repo.
`AGENTS.md` and `AGENT.md` are symlinks to this file — edit here, not
there.

**Auto-memory is the second-tier source.** Per-conversation memories at
`~/.claude/projects/-home-kenthompson-code-switchroom/memory/` (indexed
by `MEMORY.md`) carry the operator's running judgments and incident
post-mortems. CLAUDE.md is the durable contract; memories are the
recent context. When they disagree, the memory is usually newer —
verify against current code, then update whichever is stale.

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

Cron runs in-container as a per-agent sibling of the gateway (since
v0.8 / Phase 4); the legacy `switchroom-cron` singleton is gone. See
`docs/scheduling.md` and the "agent-scheduler" entries under "Repo
layout" below.

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
  `reference/rfcs/eliminate-claude-p.md`. A CI guard
  (`tests/bridge-flap-regression-guard.test.ts`) already enforces
  `--strict-mcp-config` on any headless `claude` spawn.
- **Before adding any code path that calls a model:** it MUST be the
  interactive `claude` session, or a synthesized turn injected into it
  (the cron / `inject_inbound` pattern). If you reach for the SDK or
  the API, stop — that is not switchroom.
- **Operator-controlled gateway carve-out (opt-in, default OFF).** An agent
  MAY be routed through the operator's own LiteLLM proxy
  (`litellm.enabled: true`) for usage metering + content-safety guardrails.
  This stays inside the constraint *only because* the proxy forwards the
  Pro/Max OAuth credential unchanged (subscription is still funding +
  identity), makes no API-key/SDK call, never alters the model or Claude's
  operation, and **fails open** to the direct OAuth path on outage. Per-agent
  attribution via per-agent virtual key + static tags; per-session is done by
  log⨝ledger correlation, never by mutating the claude protocol. Full rules:
  `reference/invariants.md` § "Operator-controlled gateway carve-out".

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

**Agent container process tree** (since v0.7.5): `tini` (PID 1) →
`start.sh` → (forks `autoaccept-poll` sidecar) → `exec tmux -L
switchroom-<name> new-session -A -s <name> bash -l "$0"`. The same
script re-enters under the `SWITCHROOM_DOCKER_TMUX_INNER` marker,
skips the wrapper, and runs `claude`.

**The tmux layer is load-bearing**, not a convenience. Without it,
autoaccept can't reach claude (talks tmux), `agent attach` can't
connect (`docker exec -it ... tmux attach -t <name>`), and `!
interrupt` (`tmux send-keys C-c`) has nowhere to send. Contract: tmux
socket `switchroom-<name>` + session `<name>` lives inside the agent
container — pinned at `src/agents/autoaccept.ts:151`,
`src/agents/lifecycle.ts:attachAgent`, `profiles/_base/start.sh.hbs`.

**Per-agent socket model:** compose mounts named volume
`broker-<name>-sock` at `/run/switchroom/broker/<name>` inside the
broker AND at `/run/switchroom/broker` inside agent-<name>. Broker
enumerates subdirs at `/run/switchroom/broker/`, binds a socket at
`<subdir>/sock`, chowns it to the agent UID (CAP_CHOWN granted) so a
non-root agent container can connect. Path-as-identity invariant: agent
name is parsed from the bind path via `socketPathToAgent` — never from
a wire payload. Same shape for approval-kernel.

**Vault auto-unlock:** machine-bound — broker derives an AES key from
host-mounted `/etc/machine-id` and decrypts the `vault-auto-unlock`
blob on boot. Operator writes the blob once via `switchroom vault
broker enable-auto-unlock`. If decrypt fails, broker falls back to
interactive unlock (`/vault unlock` from any agent DM, or `switchroom
vault broker unlock` on the host).

**Vault on-disk layout.** The vault is a *directory*
(`~/.switchroom/vault/`) containing `vault.enc` — the *directory* is
what compose bind-mounts into the broker. `apply.ts` refuses to mount
if the dir contains files outside the artifact whitelist
(`KNOWN_VAULT_ARTIFACT_NAMES` / `_PATTERNS`). The 5-state migration
machine in `src/vault/migrate-layout.ts` handles the legacy
single-file `~/.switchroom/vault.enc` shape — read its header doc
before touching that file. See `docs/vault.md` § "Layout".

**Networking:** agent containers use `network_mode: host` to reach
hindsight at `127.0.0.1:18888` and operator LAN devices. Trade-off:
no inter-agent network isolation. The trust model already assumed
shared-host operation.

**Self-restart commands (`/restart`, `/new`, `/reset`, `/update apply`).**
Since RFC C Phase 2 (#1338) `host_control.enabled` defaults **true**,
so the gateway dispatches these four verbs through the
**`switchroom-hostd`** daemon (separate compose project, docker socket
mounted) over UDS —
`telegram-plugin/gateway/hostd-dispatch.ts` is the primary path. There
is deliberately *no* silent spawn fallback when hostd is configured-on.

`spawnSwitchroomDetached` (`telegram-plugin/gateway/gateway.ts`) is
the fallback, used only when hostd is `"not-configured"`. Two
primitives in that fallback that are easy to "simplify away" and break
self-restart:

  1. **Detached spawn.** Gateway → `switchroom agent restart` → docker
     recreate kills its own parent; the child needs `detached: true`
     + `.unref()` to survive. A legacy branch also wraps the spawn in
     `systemd-run --user --scope` for v0.6 non-docker installs — dead
     code under v0.7+ docker but still present (Phase 3 cleanup
     pending). Don't add new dependencies on it.
  2. **Restart marker + sweep** (`writeRestartMarker`,
     `stampUserRestartReason`, `sweepBeforeSelfRestart`). Captures the
     originating chat so the post-restart greeting card edits into
     the same message; clears active reactions. All four verbs share
     the marker → a `/restart` fired mid-`/update` is debounced by
     the same 15s window.

The `isDockerReachable()` probe (#926) catches the case where the
agent container has no docker binary/socket and surfaces a clean
error pointing at the host CLI instead of exit-127.

**Agent-scheduler env knobs** (for narrowing a wedge / test overrides;
operators rarely set):
`SWITCHROOM_INLINE_SCHEDULER=0` disables in-agent scheduler;
`SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN` (default 30) caps boot-replay
window; `SWITCHROOM_AGENT_SCHEDULER_LOCK` / `_JSONL` /
`SWITCHROOM_GATEWAY_SOCKET` override paths. Empty-schedule agents
idle instead of restart-cap'ing (#921) — log line:
`agent-scheduler: <name> has no schedule entries — idling`.

## Docker test discipline (HARD RULES)

Tests run on a host that ALSO runs Coolify, hindsight,
nginx-tunnel-gateway, and every Coolify-managed app. Treat the host
as production.

- Every test container MUST carry the label `switchroom.test=<phase>` (e.g. `phase1c`) plus a per-run UUID label (`switchroom.test.run=<uuid>`).
- Every `docker run` MUST use `--rm` so containers self-clean on exit.
- The ONLY sanctioned bulk-teardown command is filtered by label:

  ```
  docker rm -f $(docker ps -aq --filter label=switchroom.test=<phase>) 2>/dev/null || true
  ```

- **Exception — detached for inter-call inspection:** if a test genuinely needs `docker run -d` (no `--rm`) because it `docker exec`s into the container between assertions, that's allowed BUT the callsite must (a) carry the standard labels, (b) have an explicit per-name `docker rm -f` in `finally`, AND (c) be covered by `safeLabelTeardown` in `afterAll`. All three. No exceptions to the exception.
- ABSOLUTE BAN: `docker ps -a | xargs docker rm`. Bare `docker rm $(docker ps -aq)`. `docker system prune`. `docker container prune`. `docker volume prune`. None of these. Ever. On any host.
- Per-container removal by explicit name is fine and is the pattern the existing tests use (see `tests/docker/per-agent-isolation.test.ts:248`, `tests/docker/e2e.test.ts:172`).
- Project-scoped compose teardown is also fine: `docker compose -p <project> down -v --remove-orphans`. Scope is the compose project name — won't touch anything outside it.
- If you find yourself wanting to "just clean everything up", STOP and ask.

## Vault & shared-state test discipline (HARD RULES)

Same principle as the Docker rules above: tests run on the **live
operator host**. `~/.switchroom/` is the production state tree — the
real encrypted vault, audit log, grants DB, and per-agent scaffolds. A
test that writes there corrupts a running fleet (real incident,
2026-05-22 — see memory `project_vault_clobbered_by_test_2026_05_22`).

- Any test that constructs a `VaultBroker`, opens/saves a vault
  (`openVault` / `saveVault` / `createVault`), or writes the audit log
  MUST point every path at an isolated tmpdir
  (`mkdtempSync(join(tmpdir(), "…"))`). Never `~/.switchroom/`.
- **The dangerous defaults** — each resolves to *production* when you
  omit an override:
  - `new VaultBroker(...)` with no `vaultPath` arg and no
    `config.vault.path` → `~/.switchroom/vault.enc`.
  - `createAuditLogger()` with no path → `~/.switchroom/vault-audit.log`.
  - `openVault` / `saveVault` take a *required* `vaultPath` — but
    `getVaultPath()` (`src/cli/vault.ts`) falls back to
    `~/.switchroom/vault.enc`, so a test that derives its path from
    `getVaultPath()` hits production.
  In tests, construct the broker via the `_testVaultPath` +
  `_testAuditLogger` hooks on the constructor's test-options arg (see
  `src/vault/broker/server.ts`), or pass an explicit tmp `vaultPath`.
  `tests/integration/vault-broker-e2e.test.ts` is the canonical
  isolated pattern (`mkdtempSync` → tmp vault + tmp socket) — copy it.
- The same applies to the grants DB (`vault-grants.db`), per-agent
  `.vault-token` files, and anything else under `~/.switchroom/`.
- A test that needs the *real* broker (a true e2e) still gets an
  isolated `SWITCHROOM_VAULT_PATH` / config + its own tmp socket — it
  never shares the operator's vault.
- If you're about to run a vault/broker test and can't point to where
  its tmpdir is, STOP — assume it will hit production.

## Design contract

`reference/` is the design contract for any non-trivial change. A
five-layer hierarchy, top (most durable) to bottom (most concrete) —
see `reference/README.md` for the map.

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
3. **Consistency test** — same CLI shape, cascade, vault syntax, chat-as-artifact as adjacent features?

**Invariants — `reference/invariants.md`** — *are we even allowed?*
The lines we won't cross by construction (claude-native,
no-self-escalation, on-leash, single-tenant, telegram-only,
chat-is-the-single-source-of-truth). Not a principle you trade off — a
hard gate. Breaking one is out of scope, full stop.

**Product spec — `reference/product-spec.md`** — *what does it deliver?*
The four outcomes in full, how the product functions at a high level,
and the job index (the single source of truth for which jobs exist).

**Job specs — `reference/jobs/<job>.md`** — *did it do the user's job?*
20 outcome-focused jobs, each with `job: / outcome: / stakes: / serves:
/ invariants:` frontmatter. Survey cheaply: `head -7 reference/jobs/*.md`.
Read in full only the job spec(s) the change touches; the body is
**Good / bad** (dual-audience decision aid), **Prove it** (UAT wired to
real scenarios), and **Verdict**. Doc-class rule: `job:` ALWAYS means a
durable job spec (in `reference/jobs/`); a doc with `serves:` / `artefact:`
/ `backs:` (no `job:`) is an RFC or design record carrying the *how* (in
`reference/rfcs/`) — `serves:` the job it delivers, or `backs:` the
invariant it details (e.g. `access-model.md` backs `no-self-escalation`).

### Triggers — when to consult deeper

- **Designing or scoping** → read `vision.md` + `product-spec.md`; name which outcome.
- **Opening a PR / doing review** → run the three principle checks + confirm no invariant is crossed; cite the job spec the change serves in the PR description.
- **Touching a UX surface** (CLI output, error messages, status surfaces, setup flow, profile/skill defaults) → read the matching job spec's *Good / bad* section before designing.

### Verdict rule

A change ships when it (a) advances one of the four outcomes,
(b) satisfies its job spec — proven by its outcome UAT, (c) passes all three
principle checks, and (d) crosses no invariant. Anything else is out of
scope, however clever.

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
  rich-send.ts          Rich-message send/edit helpers (Bot API 10.1) —
                        `richMessage(md)` → `{ markdown }`, the ONE render
                        path through `sendRichMessage`/`editMessageText`
  format.ts             GFM markdown normalizer + `escapeMarkdown`
  auto-fallback.ts      Quota-exhaustion auto-fallback
  gateway/              Gateway core. `/auth` chat-command routing lives in
                        gateway/auth-command.ts (parse + handle); the old
                        auth-slot-parser.ts / auth-dashboard.ts were deleted
                        (RFC H §7.3)
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
reference/              The design home (all design thinking, one place).
                        Root holds only the top tier: anchors (vision.md,
                        principles.md, invariants.md) + product-spec.md
                        (outcomes + job index). jobs/ (per-job job specs);
                        rfcs/ (ALL RFCs + standing design records — the
                        "how" layer, incl. access-model.md detailing the
                        no-self-escalation invariant). docs/ holds
                        usage/operator docs only; design docs are NOT split
                        across docs/.
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
npm run lint             # tsc --noEmit + 8 structural guard scripts:
                         #   plugin-references, bot-api-wrapping,
                         #   bun-test-imports, no-pii-secrets,
                         #   vault-test-hermeticity, no-broadcast-delivery,
                         #   stale-tool-descriptions, web-subscription-honest
                         # (see scripts/check-*.{mjs,sh})
npm test                 # vitest (src/) + bun test (telegram-plugin/)
npm run test:vitest      # src/ only
npm run test:bun         # telegram-plugin/ only
npm run test:watch       # vitest --watch
```

The build output (`dist/`) is what `switchroom` resolves when installed
globally. During local work on src/, prefer `bun run dev` over rebuilding.

## Telegram formatting capability — source of truth

The **Telegram Bot API changelog** is the authority on what renders, not
our recollection: <https://core.telegram.org/bots/api-changelog>. As of
**rich messages (Bot API 10.1, June 2026)** every outbound message goes
through `sendRichMessage` with raw GFM-style Markdown — so **tables,
headings (`#`), thematic rules (`---`), task lists (`- [x]`), `==highlight==`,
blockquotes, and ordered/unordered lists all render**. Documented limits:
**32768 chars, 500 blocks, 16 nesting levels, 20 columns per table**. The
ONE GFM construct that still falls back to literal text is **sub/superscript**
(`H~2~O`, `x^2^`) — avoid it. The agent-facing steer is the floor card in
`src/agents/scaffold.ts` (`TELEGRAM_FORMATTING_FLOOR_CARD`), mirrored in
`reference/telegram-formatting-guide.md`. When the changelog moves, update
both.

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

**Governance posture (set 2026-05-17, sec WS9-F2/R7 — do not
"re-harden" without the owner revisiting; memory
`feedback_repo_governance_automerge`):**

- **Admin-bypass is locked** (`bypass_actors: []`). No force-merge
  escape; CI recovery lever is `workflow_dispatch` re-trigger.
- **No required human PR review, by design.** Autonomous agents open
  PRs and auto-merge on green; required review would deadlock the
  solo-owner model. Supply-chain hole closed in the checks themselves
  (#1405 / sec WS9-F1).
- **`strict` (require-branch-up-to-date) is OFF** (WS9-F5, accepted
  residual): enabling it would stall auto-merge.

Auto-merge is enabled repo-wide — a PR with `--auto` merges the
moment the last required check turns green. This IS the operating
model.

When checking PR state, `gh pr checks <n>` is the source of truth.
Look at:
- The named checks above (must be `pass`).
- `mergeStateStatus` — `CLEAN` means ready, `BLOCKED` means a required
  check is pending or failed, `DIRTY` means there's a merge conflict
  with `main`, `UNSTABLE` is the not-yet-required-checks state and is
  usually fine to merge if the required ones are green.

Buildkite is retired (2026-05-15); UAT / race-long / evals are now
GHA workflows (`ci-uat`, `ci-tests-race-long`, `ci-evals`).

Required-check tuning is a **Ruleset** edit (classic
`branches/main/protection/...` no longer governs):
`gh api repos/switchroom/switchroom/rulesets/16470166` to read, then
`PUT` with the `required_status_checks` rule's contexts updated
(preserve other rules + `bypass_actors: []` + `enforcement: active`).
A new gating workflow needs explicit ruleset update.

**Image build cache = GHCR registry, NOT `type=gha`** (#1965). The
`docker-images` build steps cache via
`type=registry,ref=ghcr.io/<owner>/switchroom-<img>:buildcache`
(`mode=max,image-manifest=true,oci-mediatypes=true`). `type=gha` was
dropped because its Azure-blob backend restores each layer behind a
short-lived SAS token; on the heavy `agent` image (Chromium/webkite,
143MB layers) the token expired / the blob restore stalled mid-copy and
**hard-failed the build** (`failed to compute cache key: failed to
copy`), repeatedly blocking releases. Registry cache has no SAS expiry,
restores over the same GHCR path the images publish to, and a miss is a
non-fatal cold build. **`cache-to` is gated to non-PR events** — fork
PRs have no GHCR write token, so an export there would fail the
required `build-dependents` check and block every merge; PRs read the
last main build's `:buildcache` (the packages are public) and never
write. The `:buildcache` tags are mode=max (all layers) and overwrite
in place per push, so they don't accumulate. If a registry cache ever
misbehaves, the recovery lever is still `workflow_dispatch` re-trigger
(no `gh cache delete` needed — there is no GHA cache to poison).

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

## Secrets on the dev host — `.env` + the auto-unlocked vault

You almost never need a vault passphrase on a running switchroom host, and
you rarely need to copy secrets around. Two facts an agent working this repo
should know up front (so a session doesn't have to be *told* each time):

- **The vault is auto-unlocked here.** The broker derives its key from
  `/etc/machine-id` at boot (see the runtime-architecture § above), so
  `switchroom vault get <key>` returns the secret **with no passphrase**,
  both from a plain host shell and from inside an agent container
  (`docker exec switchroom-<agent> switchroom vault get <key>`). List names
  with `switchroom vault list`. The passphrase is only a fallback for when
  the broker is unreachable. **Do not** mirror the vault into plaintext —
  it holds the operator's entire credential store (SSH keys, every OAuth /
  bot token); a plaintext copy is a security regression and buys nothing,
  since reads are already passphrase-free.

- **The repo-root `.env` is a gitignored cache of the dev/UAT secrets**
  (mtcute driver creds, bot tokens, GitHub PAT, `SWITCHROOM_UAT_CHAT_ID`,
  …). The **UAT harness auto-loads it** at startup
  (`telegram-plugin/uat/load-env.ts`), so `bun run --cwd telegram-plugin
  test:uat …` already has the creds — you do **not** need to source `.env`
  or unlock the vault to run mtcute UAT. `.env.example` documents every key
  and the vault-refresh workflow; keep the two key-sets in sync when you add
  a knob. The file is **not** auto-exported into general shells by design;
  for an ad-hoc secret in a script, prefer `switchroom vault get <key>` over
  copying it into `.env`.

## Repo model & dev flow

Switchroom uses a **canonical-only** model. Read this before pushing.

- **`switchroom/switchroom`** — the one canonical repo, source of truth
  for releases. All `npm publish` output comes from here. Tagged
  versions (`v0.X.Y`) live here. You push feature branches **directly**
  to this repo and open PRs against its `main` — there is no personal
  fork in the loop.

**Local git remotes** should be:
- `origin` → `switchroom/switchroom` (for both push and pull)

Agent working on this repo: push your feature branch to `origin`
(`switchroom/switchroom`) and **target `switchroom/switchroom:main`** as
the PR base. There is no fork staging area — review + merge + release all
happen on this one canonical repo.

### Standard dev process

This is the **mandatory** path for any non-trivial change. Skip steps
only with an explicit operator instruction (e.g. "no review", "ship
without UAT").

**1. Branch off `origin/main`, in a fresh worktree.**

Multiple agents share this server and can collide on the same checkout.
Always work in a per-task worktree:

```
git fetch origin
git worktree add ~/code/switchroom-<short-task-slug> \
  -b feat/<branch-name> origin/main
cd ~/code/switchroom-<short-task-slug>
ln -s ~/code/switchroom/node_modules node_modules   # donor: any stable checkout
```

The `node_modules` symlink lets `bun`/`vitest` resolve dependencies
without re-installing. `bun install` in a fresh worktree on this host
is unreliable — see `feedback_worktree_node_modules_symlink` memory.
(Pick any long-lived checkout as the donor — e.g. `~/code/switchroom`
or `~/switchroom`. Do **not** hard-code a per-task worktree as the
donor; those get garbage-collected, see below.)

**When the PR merges, remove the worktree** — don't leave it behind:

```
git worktree remove ~/code/switchroom-<short-task-slug>
git branch -d feat/<branch-name>
```

Leftover worktrees are the sprawl that filled the dev host (300 dirs /
20GB, cleaned 2026-06-23). The backstop for when this is forgotten is
**`switchroom worktree gc`** — it quarantines orphaned worktree dirs
(moved to `~/.switchroom/worktree-gc-trash/`, recoverable) and removes
registered worktrees whose PR is **MERGED** and whose tree is clean. It
is dry-run by default; `--yes` acts. A weekly host cron runs it as a
safety net (`docs/operators/worktree-gc.md`). It never touches the main
checkout, agent/claim worktrees, or worktrees with uncommitted work.

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

- **`gateway.ts` allowlist drift.** The allowlist of raw
  `ctx.api`/`bot.api` callsites is line-keyed. Any insertion shifts
  pre-existing entries → CI fails (tsc + tests stay green). Run
  `check-bot-api-wrapping.sh` locally and widen the range same-PR.
  Memory: `feedback_gateway_bot_api_allowlist_drift`.
- **Push Protection on token fixtures.** Build fake tokens at runtime
  by concatenation (`"sk-ant-" + "fake" + "-xyz"`), never a single
  literal. Pattern: `telegram-plugin/tests/secret-detect-secretlint.test.ts`.

**4. Commit with Conventional Commits, push the branch to `origin`, open
PR against `origin/main`.**

```
git commit -m "feat(scope): short imperative summary

Longer body explaining the why and any non-obvious tradeoffs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/<branch-name>
gh pr create --repo switchroom/switchroom --base main \
  --head feat/<branch-name> --title "..." --body "..."
```

PR title under 70 chars. Body covers: Summary, Why, Test plan
(check-list), Risk. Link any related PRs.

**5. Dispatch a fresh-process reviewer.**

The coder agent CANNOT review its own work in the same context — it
rubber-stamps. Spawn a separate `general-purpose` (or `reviewer`)
agent with:

> Review PR #N (branch `<name>` against `<base>`). Verdict: APPROVE /
> REQUEST_CHANGES / BLOCK. Be specific about blockers and cite
> `file:line`.

Tell it what to check: behaviour equivalence, kill-switch correctness,
test adequacy, hidden coupling, CI state. Iterate on REQUEST_CHANGES
until APPROVE.

**Do not enable auto-merge before reviewer APPROVE.** Memory
`feedback_automerge_after_review`: auto-merge fires on CI-green and
beats the out-of-band reviewer on fast-CI / docs PRs.

**6. After APPROVE: enable auto-merge.**

```
gh pr merge <PR#> --repo switchroom/switchroom --auto --squash
```

**7. UAT (user-visible changes).** See **Pre-rollout UAT** below.
Required before fleet rollout.

### Standard release process

Cut a release **only** after the relevant feature PRs have merged to
`origin/main` and you have at least one passing UAT (or an explicit
no-UAT directive).

**1. Release worktree off `origin/main`.**

```
git fetch origin
git worktree add ~/code/switchroom-rel-<vX.Y.Z> \
  -b chore/release-v<X.Y.Z> origin/main
cd ~/code/switchroom-rel-<vX.Y.Z>
# Release worktree needs a REAL node_modules, not the dev-worktree
# symlink. `bun build` doesn't resolve through certain symlink shapes
# and silently emits an empty dist/cli/ (broke v0.12.6→v0.12.7). See
# memory `feedback_npm_publish_landmines`.
rm -rf node_modules && cp -a ~/code/switchroom-sec-1417/node_modules ./node_modules
```

**2. CHANGELOG only — do NOT hand-bump `package.json`'s `version`.**

> **Version source of truth = the git tag, resolved by
> `scripts/build.mjs:resolveVersion()`.** Priority order (#2526):
> `TAG_VERSION` env (set by `docker-images.yml`) → `GITHUB_REF`
> (`refs/tags/vX.Y.Z`) → `git describe --tags --exact-match HEAD` →
> `package.json` `"version"` (**dev / non-tag fallback ONLY**). A
> mis-stamp guard aborts the build if the git-derived version disagrees
> with `TAG_VERSION`. The resolved version is stamped into
> `src/build-info.ts` at build time; `src/cli/resolve-version.ts` reads it
> (with a shipped-`package.json` walk-up as a secondary source).
>
> So the committed `package.json` `"version"` is a **stale placeholder**
> (it has read `0.15.48` across many tagged releases, v0.15.49…v0.15.57+):
> it is deliberately *not* bumped per release, and **editing it does
> nothing for a release** — it's only the Layer-4 fallback for a non-tag
> dev build. A release is just: tag a main commit and push the tag
> (step 5); the tag flows through `resolveVersion()` automatically.

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
  --head chore/release-v<X.Y.Z> \
  --title "chore: release vX.Y.Z" --body "..."
gh pr merge <PR#> --repo switchroom/switchroom --auto --squash
```

Release PRs are usually trivial diff + green CI = APPROVE-equivalent;
the reviewer step can be skipped IF every constituent feature PR was
properly reviewed.

**5. Tag the merged commit + push the tag.**

```
git fetch origin && git reset --hard origin/main
git tag vX.Y.Z <merge-commit-sha>
git push origin vX.Y.Z
```

The tag push triggers the `docker-images` workflow, which builds
the per-version-tagged ghcr.io images (~5 min).

**5a. Create the GitHub Release** (silently dropped v0.12.18–v0.13.11,
backfilled 2026-05-22 — memory `feedback_release_create_github_release`):

```
gh release create vX.Y.Z --repo switchroom/switchroom \
  --title "vX.Y.Z — <theme>" \
  --notes "$(awk '/^## vX\.Y\.Z/{f=1;print;next} /^## v/&&f{exit} f' CHANGELOG.md)"
```

(The naive `awk '/^## vX\.Y\.Z/,/^## v/'` range collapses because the
start line also matches the end pattern — returns 1 line, not the
section.)

**6. npm publish — verify tarball first** (memory
`feedback_npm_publish_landmines`: past releases shipped without
`dist/cli/switchroom.js`).

The committed `package.json` version is a stale placeholder (see step 2).
`npm pack` names the tarball from that stale version, so you get
`switchroom-0.16.21.tgz` even on a v0.16.22 release. **Bump `package.json`
temporarily before packing — do NOT commit the bump:**

```
node scripts/build.mjs                          # rebuild — reset --hard wipes dist
node -e "const p=require('./package.json'); p.version='X.Y.Z'; \
  require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
npm pack                                        # now produces switchroom-X.Y.Z.tgz
tar tzf switchroom-X.Y.Z.tgz | grep -E "dist/cli/switchroom.js|vendor/hindsight" | head -5
npm publish --ignore-scripts switchroom-X.Y.Z.tgz
# Leave package.json bumped in the worktree (it's throwaway); don't commit it
```

`--ignore-scripts` skips `prepublishOnly` so the verified tarball is
what ships.

**7. Update local host CLI.**

```
sudo env PATH=$PATH npm i -g switchroom@X.Y.Z
switchroom --version    # confirm X.Y.Z
```

**8. Wait for `docker-images` workflow** (`gh run list
--workflow=docker-images --limit 2`, ~5 min). All 5 images (agent,
broker, auth-broker, kernel, hindsight) must be pull-able under the
new tag.

**8a. Update the web container** — `switchroom update` and per-agent
`agent restart` only touch agent/broker/kernel images. The
`switchroom-web` container is a **separate compose project**
(`~/.switchroom/web/docker-compose.yml`) and must be updated manually:

```
docker pull ghcr.io/switchroom/switchroom-web:vX.Y.Z
sed -i 's|switchroom-web:vOLD|switchroom-web:vX.Y.Z|g' ~/.switchroom/web/docker-compose.yml
docker compose -p switchroom-web -f ~/.switchroom/web/docker-compose.yml up -d
docker exec switchroom-web switchroom --version   # confirm X.Y.Z
```

The auth token for the web API lives at `~/.switchroom/web-token` (plain
text, auto-generated on first start). Use it to smoke-test endpoints:

```
TOKEN=$(cat ~/.switchroom/web-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['sessions']), 'sessions')"
```

**9. Canary on test-harness BEFORE fleet rollout** — mandatory gate.
See **Pre-rollout UAT** below.

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

The historical thundering-herd wedge (mass-recreate stranding
mid-turn inbounds) was closed in v0.12.16 / v0.12.19 (#1546, #1549,
#1558). Sequential per-agent restart is still preferred — each
`switchroom agent restart` blocks ~30s on the boot card (spacing the
bounces) and the `--version` assertion catches the `:latest`
pull-race.

**Pick the right restart flag for the change shipping** (memory
`feedback_agent_restart_image_rollout_flags`):

- `agent restart <name>` — recreate, deploys new image, NOT
  marker-safe by default.
- `--wait` — recreate + wait for in-flight turn (deploys new image,
  marker-safe). **Use this for image rollouts.**
- `--graceful-restart` — in-place IPC bounce, **keeps the old image**.
  Useful for forcing a clean reconnect without pulling new bits.
- `--force` — bypasses safety prompts; pair with `--wait` for fleet
  rollout loops.

`agent restart` does NOT self-elevate (unlike `apply`). When the
agent is running, the scaffold dir is 0700 owned by the agent UID, so
restart from the operator account fails EACCES. Marker-safe one-agent
deploy: `sudo env PATH=$PATH HOME=$HOME switchroom agent restart
<name> --wait --force` (memory
`feedback_agent_restart_needs_sudo_when_running`).

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

Scenarios live at `telegram-plugin/uat/scenarios/`, named
`jtbd-<job>-<surface>.test.ts`. Each spins up a driver, sends a real
Telegram DM to a real agent, asserts response shape + timing.

```
bun run --cwd telegram-plugin test:uat jtbd-fast-trivial-dm
```

**Release-critical scenarios** (streaming, message format, turn
lifecycle changes):

- `jtbd-fast-trivial-dm` — warm-cache TTFO (~1.7s baseline).
- `jtbd-always-on-after-restart-dm` — first message after restart
  ≤60s (5-min wedge regression gate).
- `jtbd-memory-survives-restart-dm` — memory persistence across restart.
- `jtbd-message-during-restart-dm` / `-channel` — a message sent
  *during* the restart boot window is still answered (v0.14.48 / #2117
  lost-message gate; sends DURING boot, unlike always-on which sends
  after). Set `SWITCHROOM_UAT_BOOT_SEND_DELAY_MS=6000` to land it deep
  enough in the not-ready window to exercise the strand-rescue sweep.
- `jtbd-interrupted-turn-resumes-dm` — a turn interrupted by a restart
  is resumed (and the resume turn completes, not silently dropped)
  (v0.14.50 / #2122 gate). Asserts the resume *framing*, not an
  end-token (the resume synthetic only carries the first ~160 chars of
  the original prompt).
- Any feature-specific scenario.

**Supergroup / channel UAT (status-routing work — required).** Every
status surface (background worker feed, sub-agent handback/progress,
foreground sub-agent nesting, fuzzy replies) MUST be proven in BOTH a DM
AND a forum supergroup — historically the whole suite was DM-only, which
hid every channel-routing bug (handback landing in the wrong topic, etc.,
the v0.14.43 fixes). Channel scenarios are named `jtbd-<job>-channel` /
`fuzz-<job>-channel` and live beside their `-dm` twins. They **self-skip
green** when `SWITCHROOM_UAT_CHAT_ID` is unset or the chat isn't a
postable forum supergroup, so they never red an unwired host (uat/** is
excluded from gating CI anyway). To run them live:

1. **The test group MUST be a forum supergroup with Topics enabled —
   NOT a basic group.** A basic group (`inputPeerChat`) has no forum
   topics, so topic-routing can't be exercised; its Bot-API id is
   `-<id>` (no `-100`). Telegram → group → Settings → enable **Topics**
   migrates a basic group to a supergroup and mints a NEW `-100…` id.
   (Symptom of a basic group: mtcute resolves it as `inputPeerChat` and
   `resolvePeer(-100…)` throws "Peer not found".)
2. **Capture the real chat_id from the bot side, not by eyeballing.**
   The test bot (`TELEGRAM_TEST_BOT_USERNAME`, == test-harness's bot)
   must be a group member/admin AND the driver account a member. Post
   any message in the group, then read test-harness's gateway log:
   `inbound dropped reason=group_unknown chat_id=-100… chat_type=supergroup`
   — that `-100…` is the id (the bot logs unknown-group inbounds even
   before the group is wired). `docker exec switchroom-test-harness sh -lc
   'grep group_unknown /var/log/switchroom/gateway-supervisor.log | tail'`.
3. **Wire test-harness supergroup-owned** (mirrors marko): under its
   `channels.telegram` in `~/.switchroom/switchroom.yaml` add
   `chat_id: "-100…"` + `default_topic_id: 1`, then `switchroom apply`
   and `agent restart test-harness --wait --force`. It still serves DMs.
4. Set `SWITCHROOM_UAT_CHAT_ID=-100…` in the repo-root `.env`
   (`load-env.ts` loads it; the scenarios read it).
5. Run: `bun run --cwd telegram-plugin test:uat supergroup` (+ the
   `*-channel` names). Each asserts `chatId === supergroup` — the
   parity proof that status lands in the channel, not the DM.

**mtcute caveat (load-bearing):** this repo's mtcute has **no
forum-topic create/enumerate API**, so channel scenarios use the
supergroup's **General topic** — they prove DM-vs-channel routing but
NOT "correct topic among many." That finer routing is pinned by the
gateway **unit thread-assertions** (e.g. the handback/progress builder
tests). The driver runs on `MemoryStorage` (empty peer cache each
connect), so a username-less supergroup marked-id isn't resolvable until
`driver.primeDialogs()` runs; use `driver.canResolve(chatId)` to
skip-guard. mtcute also CANNOT observe drafts or reactions — the
activity/worker feeds are real `sendMessage`/`editMessageText` (observable),
but draft-transport and reaction surfaces must be checked via the gateway
log, not mtcute.

**Canary discipline.** Always: (1) pin **test-harness** to the new
version (`switchroom update --pin vX.Y.Z` — note: fleet-wide today,
so accept the bounce or use a feature flag to keep new code dormant);
(2) run UAT; (3) tail `/var/log/switchroom/gateway-supervisor.log`;
(4) observe ≥1 real human DM round-trip; (5) green → fleet rollout;
red → revert pin and queue a fix PR.

**The release isn't shipped until step 5 passes** — tagging /
publishing / rolling are necessary but not sufficient.

### Operator update — `switchroom update`

For a host that's already running switchroom and just needs to catch
up with upstream:

```
switchroom update              # pull images + apply + recreate + doctor
switchroom update --check      # dry-run plan
switchroom update --status     # read-only: CLI version + image/container ages
switchroom update --rebuild    # source-checkout users: also git pull + npm build
switchroom update --pin vX.Y.Z # pin a specific version
```

`apply` self-elevates via sudo internally and runs a focused `doctor`
sweep on success. Reachable from any agent DM via `/upgradestatus`
(read-only, not admin-gated), `/update` (dry-run), `/update apply`
(admin-gated; uses hostd on docker hosts, falls back to a clean
host-CLI error if hostd is unreachable).

### Deploy reliability — never poison host bind-mounts

**The invariant:** deploys derive the operator home from
`SWITCHROOM_HOST_HOME`, set by the host shell (`apply`'s sudo
preservation chain) or by hostd. They never derive it from the
container's ambient `HOME`.

**Operating rules:**

- **Always deploy from the host shell or via hostd.** Both set
  `SWITCHROOM_HOST_HOME`. Running `switchroom apply` / `update` from
  the host shell is the default; `/update apply` in Telegram dispatches
  through hostd.
- **Never deploy via an ad-hoc helper container** that mounts the
  operator home or `~/.docker` writable (e.g. `docker run <agent-image>
  switchroom update`). The in-process guards will throw on a post-fix
  image — but a pre-fix image silently bakes the container `HOME` as
  bind-mount sources, causing Docker to auto-create empty root-owned dirs
  on the host and crashing the fleet (the 2026-06-23 outage, 5 h down).
- **If `docker compose` breaks host-wide**, check whether
  `~/.docker/cli-plugins/docker-compose` is a directory instead of
  the plugin binary — Docker auto-dir'd it during a poisoned deploy.
  Remove it and reinstall the plugin.
- **Recovery:** `switchroom host repair-mounts` removes auto-dir
  artifacts; then `switchroom apply` from the host shell regenerates a
  clean compose.

Design record: `reference/rfcs/deploy-reliability.md`.

### Code ≠ runtime

A rebuild updates `dist/`. It does **not** update running agents —
they loaded code at boot. Changes go live only after restart. Since
PR #59, `agent restart` always runs reconcile first (re-emits the
compose file + scaffold), so it's also a mini-deploy.

`~/.bun/bin/switchroom` is the dev-machine install (symlink to
workspace `dist/cli/switchroom.js`). `npm i -g switchroom` is the
consumer-machine install (separate pinned copy under `~/.nvm/…`).
PATH order picks the winner.

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

(Implementation pointers. For *design intent* — outcomes, principles,
invariants, job specs — see "Design contract" above.)

- **Config resolution** → `src/config/merge.ts` + `docs/configuration.md`.
- **Progress card** → `telegram-plugin/stream-reply-handler.ts` +
  `telegram-plugin/card-format.ts` + `docs/telegram-plugin.md`.
- **Background worker-activity feed** (on by default; kill-switch
  `SWITCHROOM_WORKER_ACTIVITY_FEED=0`) → live edit-in-place
  message per `run_in_background` sub-agent. Render in
  `telegram-plugin/worker-activity-feed.ts`; wired in
  `telegram-plugin/gateway/gateway.ts` `onProgress`/`onFinish`. The feed
  header's real task description comes from the registry `subagents`
  row via `telegram-plugin/gateway/worker-feed-dispatch.ts`
  (`resolveWorkerFeedDispatch`, pinned by `worker-feed-dispatch.test.ts`)
  — the watcher only carries a generic `'sub-agent'` placeholder, so do
  NOT source the header from `subagent-watcher.ts`. E2E gate:
  `telegram-plugin/uat/scenarios/jtbd-worker-activity-feed-dm.test.ts`.
- **Auth** → `src/auth/accounts.ts` (slots) + `src/auth/manager.ts`
  (OAuth). Telegram `/auth` routing: `telegram-plugin/gateway/auth-command.ts`
  (`parseAuthCommand` + `handleAuthCommand`; the old `auth-slot-parser.ts`
  was deleted in RFC H §7.3).
- **Runtime inspection** → `switchroom debug turn <agent>` (prompt
  layering) and `switchroom workspace render <agent>` (bootstrap block).
- **Compose generation** → `src/agents/compose.ts:generateCompose()`,
  pinned by `tests/docker/compose-generator.test.ts`. UID via
  `allocateAgentUid()` (deterministic hash → 10001-10999).
- **Broker peer auth** → path-as-identity in
  `src/vault/broker/peercred.ts:socketPathToAgent()`. Shapes: flat
  `<agent>.sock` (legacy/tests), subdir `<agent>/sock` (compose). ACL
  is bind-time, never wire-time.
- **Agent boot inside container** → `profiles/_base/start.sh.hbs`
  (forks gateway + autoaccept-poll + agent-scheduler, then re-execs
  into tmux). `docker/Dockerfile.agent` lays the bundles under
  `/opt/switchroom/`; CLI symlinked at `/usr/local/bin/switchroom`;
  CMD `/state/agent/start.sh` under tini.
- **Autoaccept first-run prompts** → `src/agents/autoaccept.ts`
  (regex `PROMPTS`, tmux capture-pane + send-keys). Bundle entry
  `src/cli/autoaccept-poll.ts`.
- **Cron** → `src/agent-scheduler/index.ts` (entrypoint) →
  `dispatchAsInbound` (`src/scheduler/dispatch.ts`) → `inject_inbound`
  IPC to local gateway. Audit at `/state/agent/scheduler.jsonl`;
  bounded boot replay (30 min default). See `docs/scheduling.md`.
- **Singleton health** →
  `docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps`.
  Probe is bind-presence on `/run/switchroom/<svc>/*/sock` (#898);
  empty fleets correctly read unhealthy.
