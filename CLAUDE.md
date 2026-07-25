# CLAUDE.md — Switchroom

Orients Claude Code (and other agentic tools) to this repo. `AGENTS.md` and
`AGENT.md` are symlinks to this file — edit here, keep the symlinks intact.

**You are the developer.** Agents are the only developers of this repo — there
is no human team that picks up failures later. A bug you notice and don't fix
or file stays broken. Ownership discipline is spelled out in "Tests" below.

## What this project is

Switchroom is a Telegram plugin + agent lifecycle layer on top of the
unmodified `claude` CLI: Claude Code agents run 24/7 in Docker containers
(one per agent, plus shared singletons — `vault-broker`, `approval-kernel`,
`hostd`, web dashboard — under `docker compose`), talked to from Telegram,
authenticated with a Claude Pro/Max subscription via OAuth. Docker is for
distribution and isolation, not a runtime around claude. See `README.md`;
runtime details in `docs/architecture.md`.

## Hard constraint — Claude-native, subscription-funded

Non-negotiable; `reference/vision.md` pillar 3 as an engineering gate.

- Every agent runs the **unmodified `claude` CLI** on the operator's Pro/Max
  OAuth. No `ANTHROPIC_API_KEY`, no Agent SDK, no raw API, no protocol
  interception. This is Anthropic-policy compliance, not just cost.
- **`claude -p` is programmatic usage** (off-subscription since the
  2026-06-15 policy). Adding a `claude -p` callsite is a violation — route
  model work through the interactive session as a synthesized turn
  (cron / `inject_inbound` pattern). See `reference/rfcs/eliminate-claude-p.md`.
- Opt-in LiteLLM proxy carve-out exists (forwards the OAuth unchanged, fails
  open): `reference/invariants.md` § "Operator-controlled gateway carve-out".

## Commands

```bash
bun install                  # deps (bun.lock)
bun run dev -- <args>        # run CLI from src/ via bin/switchroom.ts
npm run build                # node scripts/build.mjs → dist/
npm run lint                 # tsc --noEmit + 8 guard scripts (see Lint gates)
npm test                     # vitest run + bun test <explicit file list>
                             #   NOTE: pretest runs a full build first
npm run test:vitest          # vitest only (src/ + tests/ + telegram-plugin non-bun)
npm run test:bun             # bun-only suites (bun:sqlite dependents)
npm run test:watch           # vitest --watch
```

Scoped runs: `./node_modules/.bin/vitest run <paths>` and
`bun test <paths>`. During src/ work prefer `bun run dev` over rebuilding.

## Repo layout

```
src/                    switchroom CLI (TypeScript, ES modules, Node ≥20)
  agents/               scaffold.ts, compose.ts (generates the fleet compose
                        file), lifecycle.ts, autoaccept.ts (tmux-driven)
  cli/                  one file per top-level verb, registered in index.ts
  config/               YAML loader + cascade (merge.ts; docs/configuration.md)
  vault/                AES-256-GCM store; broker/ (per-agent UDS daemon),
                        approvals/ (approval-kernel)
  agent-scheduler/      in-container cron sidecar; scheduler/ has the shared
                        dispatch primitives (docs/scheduling.md)
  auth/                 OAuth + multi-account slot pool
  fleet-health/         model-free sensor → priority ledger → GH-issue
                        lifecycle (reference/rfcs/fleet-health.md)
  web/                  web dashboard API (Fleet Health / Summary / Accounts
                        tabs; ui/ for frontend); separate compose project
  host-control/         hostd dispatch (self-restart verbs)
  worktree/             `switchroom worktree` claim/gc/reaper
  drive|microsoft|notion|linear|litellm|memory|...   integrations
telegram-plugin/        the MCP Telegram plugin + gateway (own test suite)
  server.ts             MCP stdio entry;  gateway/ is the long-lived gateway
  tests/                mostly bun test; uat/ is the live mtcute harness
docker/                 Dockerfile.{base,agent,broker,kernel,auth-broker,
                        hostd,web,hindsight,voice,uat-runner}
profiles/               agent profiles; _base/start.sh.hbs = container entry
skills/                 bundled Claude Code skills
scripts/                build.mjs + the lint guard scripts
tests/                  vitest suite for src/;  tests/docker/ = docker e2e
reference/              THE DESIGN CONTRACT (see below)
docs/                   user/operator docs only — design lives in reference/
```

Agent scaffolds live outside the repo (`~/.switchroom/agents/<name>/`);
generated compose at `~/.switchroom/compose/docker-compose.yml`. Never commit
per-user agent state.

## Tests — runners, classification, ownership

**Two runners, hard boundary.** vitest runs `src/` + `tests/` (+ most of
telegram-plugin via the root config); `bun test` runs the suites that need
Bun natives — chiefly `bun:sqlite` (history, grants, approval-kernel,
registry). `npm test` runs both; `npm run test:bun` is the explicit file
list in `package.json`.

- **Never import `bun:test` or `bun:sqlite` in a vitest-run file** — vitest
  can't resolve them and the whole suite fails to load. This broke CI
  repeatedly before the `check-bun-test-imports` lint guard landed. If a file
  genuinely needs Bun APIs, add it to the `exclude` list in
  `vitest.config.ts` AND to the `test`/`test:bun` scripts in `package.json`.
- Dual-run files (draft-stream/streaming) must avoid bun-incompatible vitest
  APIs (`vi.advanceTimersByTimeAsync` → use sync advance + microtask flush);
  pattern: `telegram-plugin/tests/draft-stream.test.ts`.

**Local env noise vs real failures.** The full local suite has known
environment-dependent failures: vault SQLite in sandboxes, the fake-binary
harness, `/tmp` mounted noexec (set an exec-capable `TMPDIR`), socket/root
container constraints, parallel port contention. The ~73 scenarios under
`telegram-plugin/uat/scenarios/` need live Telegram/mtcute creds and
fail/skip locally by design.

**Classification discipline — prove it, don't footnote it.** When a local
test fails, re-run the exact failing test on pristine `origin/main` (fresh
worktree or stash) before drawing any conclusion. Three buckets, each with an
obligation:

1. **Fails only with your diff** → your regression. Fix before pushing.
2. **Fails on main too** → genuinely pre-existing — which makes it YOUR bug
   backlog, not someone else's. Fix it in a small follow-up PR or file an
   issue. Never silently footnote "pre-existing" and move on.
3. **Environment-only artifact** (no live creds, noexec /tmp, sandbox
   SQLite) → note it and let CI be the authority for those paths. CI is the
   arbiter for env-dependent suites; local is the arbiter for pure-logic
   suites.

## Lint gates

`npm run lint` = `tsc --noEmit` plus these guard scripts (most have an
`npm run lint:<name>` alias; see `package.json`):
`check-plugin-references`, `check-bot-api-wrapping`,
`check-bun-test-imports`, `check-no-pii-secrets`,
`check-vault-test-hermeticity`, `check-no-broadcast-delivery`,
`check-stale-tool-descriptions`, `check-web-subscription-honest`,
`check-litellm-config-guard`.

Traps that bite repeatedly:

- **`check-no-pii-secrets` fails on real operator PII** — real Telegram
  chat/user IDs, emails, hostnames pasted into tests or docs. Use synthetic
  IDs and the repo's placeholder conventions.
- **`gateway.ts` raw `bot.api` allowlist is file:line-keyed** — any insertion
  in `telegram-plugin/gateway/gateway.ts` shifts entries and fails
  `check-bot-api-wrapping` while tsc stays green. Run it locally and widen
  ranges in the same PR. New Telegram API calls go through
  `retryApiCall`/`robustApiCall`, not raw.
- **`check-litellm-config-guard` SKIPS off-host** — the operator-maintained
  LiteLLM config path comes from `LITELLM_CONFIG_PATH` (no hard-coded
  default — the real path embeds a deployment-identifying Coolify service
  id), which is unset in CI/dev, so the lint step is a near-vacuous belt. The
  load-bearing I2 OAuth-leak enforcement is the fleet-health sensor
  (`src/fleet-health/litellm-config-sensor.ts`), which runs where the file
  lives and escalates a violation into the priority ledger. That sensor takes
  its path from **`fleet_health.litellm_config_path` in the host-local
  `switchroom.yaml`** (env `LITELLM_CONFIG_PATH` as the fallback) — set the
  config field on the host, or the sensor logs `SKIPPED — no config path` and
  the check does not run. Point `LITELLM_CONFIG_PATH` at a real config to
  exercise the lint locally.

### Secrets in tests

GitHub Push Protection blocks token-shaped literals even in fixtures. Build
fake tokens by runtime concatenation (`"sk-ant-" + "fake"`); pattern:
`telegram-plugin/tests/secret-detect-secretlint.test.ts`.

## CI

GitHub Actions is primary and gating. `main` is protected by repository
Ruleset `16470166` with **4 required checks**: `lint`, `bun-test`, `vitest`,
`images-ok` (the docker-images sentinel — the individual build jobs are NOT
required, so matrix/job renames there don't touch branch protection; keep
`images-ok`'s `needs` list complete instead). Edits to the required list are
Ruleset edits (`gh api repos/switchroom/switchroom/rulesets/16470166`), not
classic branch protection.

- **Sentinel pattern:** `lint` / `bun-test` / `vitest` / `uat-gate` are
  always-running sentinel jobs that aggregate path-gated heavy runs
  (`lint-run`, `bun-test-run`, `vitest-shard` ×4, `uat-gate-run`). A
  path-filtered job reporting "skipping" is a PASS for that PR — **skipping
  ≠ failing**. Don't chase skipped shards.
- Governance (set 2026-05-17, deliberate): admin-bypass locked
  (`bypass_actors: []` — `gh pr merge --admin` cannot work), no required
  human review, `strict` up-to-date OFF. Auto-merge repo-wide: `--auto
  --squash` merges the moment required checks go green. CI recovery lever is
  `workflow_dispatch` re-trigger.
- `gh pr checks <n>` is the source of truth. `mergeStateStatus`: `CLEAN`
  ready, `BLOCKED` pending/failed required check, `DIRTY` merge conflict,
  `UNSTABLE` = optional checks pending (usually fine).
- Image build cache is **GHCR registry**, not `type=gha` (#1965 — SAS-token
  expiry hard-failed heavy builds). base/dependents build per-arch on native
  runners and use `:buildcache-<arch>` tags; hindsight/voice keep plain
  `:buildcache`. `cache-to` is gated off PR events; PRs read cache only.

## UAT — the live end-to-end gate

`telegram-plugin/uat/` drives a **real mtcute Telegram client against a real
bot** — the only full inbound → claude → outbound exercise. Runs under
vitest via `bun run --cwd telegram-plugin test:uat <name>`
(`vitest.uat.config.ts`). Scenarios: `telegram-plugin/uat/scenarios/`,
named `jtbd-<job>-{dm,channel}` / `fuzz-*`.

- **`uat-gate` is a sentinel job, NOT ruleset-required** (`ci-uat.yml`; as
  of 2026-07 it is absent from Ruleset 16470166's 11 required checks, so
  `--auto --squash` WILL merge past a red `uat-gate` — check it yourself
  before enabling auto-merge on plugin/agent-path PRs). The heavy `uat-gate-run`
  fires on the self-hosted `uat-host` runner when plugin/agent paths change
  and `UAT_GATE_ENABLED` is set; it runs three live scenarios:
  `jtbd-fast-trivial-dm` (real DM round-trip, **hard reply-latency SLA of
  12s** — `HARD_TTFO_MS`), `inbound-no-drop` (rapid-fire no-drop, #2089),
  and `jtbd-rich-formatting-render-dm` (Bot API rich-entity render
  round-trip, #2739). The `uat-gate` sentinel passes when the run passed OR
  was legitimately path-skipped.
- **Known-flaky under quota/API turbulence.** If your diff doesn't touch the
  reply-latency or delivery path and `uat-gate` reds, re-run the workflow
  and get it green before merging — never ship past a red gate.
- `uat-fuzz` is `workflow_dispatch` + scheduled runs, non-required (each fuzz scenario
  burns real subscription quota).
- **Don't attempt full headless UAT locally** — it needs the live
  test-harness agent, a real MTProto driver session, and vault creds. Scope
  local verification to vitest / bun test / `tsc` / build. On a wired dev
  host, the repo-root `.env` (gitignored, auto-loaded by
  `telegram-plugin/uat/load-env.ts`) carries the driver creds;
  `.env.example` documents every key. One-time setup: `bun run uat:login`.
- Channel scenarios need a **forum supergroup with Topics** (not a basic
  group) and `SWITCHROOM_UAT_CHAT_ID` set; they self-skip green otherwise.
  mtcute here has no forum-topic API (channel tests use the General topic)
  and cannot observe drafts/reactions — check those via the gateway log.
- Release canary discipline: pin test-harness → run release-critical
  scenarios (`jtbd-fast-trivial-dm`, `jtbd-always-on-after-restart-dm`,
  `jtbd-memory-survives-restart-dm`, `jtbd-message-during-restart-*`,
  `jtbd-interrupted-turn-resumes-dm`) → tail
  `/var/log/switchroom/gateway-supervisor.log` → one real human round-trip →
  then fleet rollout.

## Design contract — reference/

`reference/` governs any non-trivial change (`reference/README.md` is the
map): `vision.md` (four outcomes: standing team / on the leash /
subscription-honest / always available), `principles.md` (three checks —
docs test, defaults test, consistency test; a "no" is a redesign),
`invariants.md` (hard gates: claude-native, no-self-escalation, on-leash,
single-tenant, telegram-only, chat-is-source-of-truth), `product-spec.md`
(job index), `jobs/*.md` (outcome-focused job specs — survey with
`head -7 reference/jobs/*.md`), `rfcs/` (the "how" layer + standing design
records).

**Verdict rule — every PR must pass it:** a change ships when it (a) advances
one of the four vision outcomes, (b) satisfies the job spec it cites — proven
by its outcome UAT, (c) passes all three principle checks, (d) crosses no
invariant. **Cite the job spec from `reference/jobs/` in the PR
description.** Touching a UX surface → read that job's Good/bad section
first.

## Dev flow & PR hygiene

1. **Branch off freshly fetched `origin/main`, one branch per issue, in a
   per-task worktree.** A stale base produces 1000-file phantom diffs; the #1
   cause of closed-unmerged PRs is superseded/duplicate/stale-base work.
   ```bash
   git fetch origin
   git worktree add ~/code/switchroom-<slug> -b feat/<name> origin/main
   ```
   If `bun install` misbehaves in a fresh worktree, symlink `node_modules`
   from a stable checkout. Remove the worktree after merge (`switchroom
   worktree gc` is the backstop — `docs/operators/worktree-gc.md`).
2. **Root-context editing:** never write into a uid-1000 checkout as uid 0 —
   root-owned files cause EACCES + git "dubious ownership" fallout for every
   later session. If it happens, `chown -R` back to the owning uid.
   **The same rule binds scaffold/reconcile code:** any file a root-running
   process (hostd rollout, sudo `apply`, `agent restart`'s reconcile) writes
   into an agent home (`~/.switchroom/agents/<name>/`) MUST end up owned by
   that agent's uid (`allocateAgentUid`) and readable by it — root:root 0600
   agent dotfiles disable the agent's permission allowlist and storm the
   operator with approval cards (#3168, v0.18.14 fleet incident). New write
   sites inside `reconcileAgent` are covered by the end-of-reconcile
   ownership sweep (`src/agents/agent-owned-tree.ts`); writers outside it
   must chown explicitly (apply's `alignAgentUid` pattern) **and pin the
   ownership with a regression test**. Beware especially tmp+rename atomic
   writes — they replace the inode and silently re-own the file to the
   writer's euid.
3. Implement with tests; validate locally with scoped vitest/bun test +
   `npm run lint`.
4. Conventional Commits (`feat(scope):` …). Push the branch to `origin`
   (canonical-only model, no forks): `gh pr create --repo
   switchroom/switchroom --base main`. Title <70 chars; body: Summary / Why /
   Test plan / Risk + the job-spec citation.
5. **Fresh-process review before auto-merge.** The coder can't review its own
   work in-context. Dispatch a separate reviewer agent; iterate to APPROVE;
   only then `gh pr merge --auto --squash`. Never enable auto-merge before
   APPROVE (auto-merge beats an out-of-band reviewer on fast-CI PRs), and
   never try to merge past red required checks.
6. **Line anchors drift fast.** File:line references in design notes,
   reviews, and the bot-api allowlist go stale within days — re-validate
   against current `main` before acting on or writing one.
7. Code ≠ runtime: a rebuild updates `dist/`; running agents load code at
   boot and change only after restart (`agent restart` reconciles first).

## Development Protocol (fleet standard, Ken 2026-07-11)

The fleet-wide protocol every agent gets via the `_shared/dev-protocol.md.hbs`
fragment (long form: the bundled `dev-protocol` skill). It binds work on THIS
repo too — the five parts, condensed:

1. **Orient/ground.** Validate, don't assume; never assert an unchecked fact.
   Verify root cause in real source (src/, not `dist/` or generated output).
   If evidence contradicts the plan or the ticket, report the contradiction —
   don't force-fit. Cite PRs / commits / `file:line`.
2. **Clarify vs proceed.** Infer from the codebase and history first. If
   genuinely unsure, ask ONE question at a time — during planning. During
   execution, act autonomously: make the reasonable call, note the assumption.
3. **Design-align on larger tasks.** Evidence-grounded design report to the
   user before implementation; adversarially red-team the plan (per-item
   verdicts with evidence); stage delivery as focused single-concern PRs.
4. **Pipeline.** Branch off fresh main. Scoped tests + `npm run lint`
   locally; CI is the full-suite authority. Adversarial review of the diff;
   fix ALL findings including lows; re-review the fix; merge only on CI
   green. Durable fixes over hack patches; deterministic mechanisms over
   model-dependent behavior; tests assert outcomes, not just code paths.
5. **Communicate.** Consolidated messages, always-visible progress, no
   foreground watches over 30s (background + notification), max 15 parallel
   sub-agents.

## Docker test discipline (HARD RULES)

Tests run on a host that also runs production (Coolify, hindsight, the live
fleet). Treat the host as production.

- Every test container carries labels `switchroom.test=<phase>` +
  `switchroom.test.run=<uuid>`, and uses `--rm` (or, if detached for
  inter-call `docker exec`, has per-name `docker rm -f` in `finally` AND
  label-scoped `afterAll` teardown).
- Only sanctioned bulk teardown: `docker rm -f $(docker ps -aq --filter
  label=switchroom.test=<phase>)`. Project-scoped `docker compose -p <proj>
  down -v` is fine.
- **ABSOLUTE BAN:** `docker system|container|volume prune`, bare
  `docker rm $(docker ps -aq)`, any unlabelled bulk removal. If you want to
  "just clean everything up", STOP and ask.

## Vault & shared-state test discipline (HARD RULES)

`~/.switchroom/` is the production state tree (real encrypted vault, grants
DB, audit log, scaffolds). A test that writes there corrupts a running fleet
(real incident 2026-05-22).

- Any test constructing a `VaultBroker` / opening a vault / writing audit
  MUST point every path at `mkdtempSync(join(tmpdir(), …))`. The dangerous
  defaults (no-arg `VaultBroker`, `createAuditLogger()`, `getVaultPath()`
  fallback) all resolve to production. Canonical isolated pattern:
  `tests/integration/vault-broker-e2e.test.ts`; the
  `check-vault-test-hermeticity` lint guard enforces this structurally.
- If you can't point to a vault test's tmpdir, assume it hits production and
  stop.

## Release (condensed — full landmine detail in git history)

**Follow the `switchroom-release` skill for the full ordered checklist.**
The two gates below (npm publish + images) are HARD prerequisites for
rollout — v0.18.4 and v0.18.5 shipped to the fleet but were never
published to npm because publish wasn't gated. Don't let that recur.

- **Version source of truth is the git tag**, resolved by
  `scripts/build.mjs:resolveVersion()`. The committed `package.json`
  `version` is a stale placeholder by design (see its `//version` comment) —
  never bump it in a commit. Release = CHANGELOG consolidation PR → merge →
  tag `vX.Y.Z` on the merge commit → push tag (triggers `docker-images`
  AND `npm-publish` in parallel).
- **npm publish is automated by `.github/workflows/npm-publish.yml`** on
  tag push: it does the uncommitted pack-time `package.json` bump, builds,
  verifies `dist/cli/switchroom.js` is non-empty AND in the tarball (the
  v0.12.6→7 empty-build guard), `npm publish --ignore-scripts
  --provenance`, and verifies `npm view switchroom version` shows the new
  version. Needs the `NPM_TOKEN` repo secret (set once). **Do NOT roll
  the fleet until this workflow is green AND `npm view switchroom version`
  returns the tag version.** Never run `npm publish` by hand from an
  agent container (no npm auth there); fix the workflow, don't side-step
  it. Release builds need a **real `node_modules`**, not a worktree
  symlink — a symlinked one made `bun build` silently emit an empty
  `dist/cli/` (broke v0.12.6→7); the workflow's setup-switchroom action
  avoids this and the empty-build guard catches it.
- Create the GitHub Release (`gh release create`) — historically silently
  dropped. The naive `awk '/^## vX/,/^## v/'` CHANGELOG range collapses to
  one line; use a start-flag awk instead.
- The web container is a separate compose project
  (`~/.switchroom/web/docker-compose.yml`) — `switchroom update` doesn't
  touch it; pull + up manually.
- **Fleet rollout — only after BOTH gates pass:** npm publish verified
  (above) AND `docker-images` verified (`docker manifest inspect
  ghcr.io/switchroom/<image>:vX.Y.Z` for agent, auth-broker, kernel,
  broker, web, hostd). Then canary on test-harness first (UAT above),
  then staggered per-agent `switchroom agent restart <name> --wait
  --force` with a `--version` assertion per agent (guards the `:latest`
  pull-race). Deploy only from the host shell or via hostd
  (`SWITCHROOM_HOST_HOME` invariant — `reference/rfcs/deploy-reliability.md`);
  never via an ad-hoc container mounting the operator home.


## Secrets & safety rails

Dev-host vault is broker-auto-unlocked: `switchroom vault get <key>` needs no
passphrase. On-disk layout + the 5-state layout migration
(`src/vault/migrate-layout.ts`) are documented in `docs/vault.md` § Layout.
Never mirror the vault to plaintext; never commit tokens. Never
bypass hooks (`--no-verify`) or force-push `main`. Don't touch `vendor/`,
`~/.switchroom/vault/`, or private dirs without reason.

## Where to look first

- Config cascade → `src/config/merge.ts` + `docs/configuration.md`
- Progress card / streaming → `telegram-plugin/stream-reply-handler.ts`,
  `card-format.ts`; outbound formatting → `telegram-plugin/rich-send.ts` +
  `reference/telegram-formatting-guide.md`
- Gateway (inbound routing, self-restart, hostd dispatch) →
  `telegram-plugin/gateway/gateway.ts`, `gateway/hostd-dispatch.ts`
- Worker-activity feed → `telegram-plugin/worker-activity-feed.ts` (header
  text comes from the registry via `gateway/worker-feed-dispatch.ts`, NOT
  `subagent-watcher.ts`)
- Compose generation → `src/agents/compose.ts:generateCompose()`, pinned by
  `tests/docker/compose-generator.test.ts`
- Broker peer auth → the per-agent socket model: compose mounts a volume at
  `/run/switchroom/broker/<name>`; the broker binds `<name>/sock` and parses
  the agent identity from the bind path
  (`src/vault/broker/peercred.ts:socketPathToAgent()`) — never from a wire
  payload; ACL is bind-time. Same shape for the approval-kernel.
- Container boot → `profiles/_base/start.sh.hbs` (tini → start.sh → tmux →
  claude; gateway + autoaccept + agent-scheduler sidecars). The tmux layer is
  load-bearing (autoaccept, `agent attach`, interrupts).
- Cron → `src/agent-scheduler/index.ts` → `inject_inbound` IPC;
  `docs/scheduling.md`
- Fleet health → `src/fleet-health/` + `src/web/fleet-health-read.ts`;
  ledger at `~/.switchroom/fleet-health/ledger.json` (never committed)
- Runtime inspection → `switchroom debug turn <agent>`, `switchroom
  workspace render <agent>`

## Voice (docs, CLI output, errors)

Plain, direct, opinionated. Lead with what the team feels like, not the
machinery. Trust details stay honest and present. No filler, no hype, no em
dashes in user-facing surfaces. Name what it deliberately doesn't do.
Effort estimates in **agent minutes**, not human dev hours.
