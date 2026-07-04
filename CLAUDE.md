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

`npm run lint` = `tsc --noEmit` plus these guard scripts (each has an
`npm run lint:<name>` alias; see `package.json`):
`check-plugin-references`, `check-bot-api-wrapping`,
`check-bun-test-imports`, `check-no-pii-secrets`,
`check-vault-test-hermeticity`, `check-no-broadcast-delivery`,
`check-stale-tool-descriptions`, `check-web-subscription-honest`.

Traps that bite repeatedly:

- **`check-no-pii-secrets` fails on real operator PII** — real Telegram
  chat/user IDs, emails, hostnames pasted into tests or docs. Use synthetic
  IDs and the repo's placeholder conventions.
- **`gateway.ts` raw `bot.api` allowlist is file:line-keyed** — any insertion
  in `telegram-plugin/gateway/gateway.ts` shifts entries and fails
  `check-bot-api-wrapping` while tsc stays green. Run it locally and widen
  ranges in the same PR. New Telegram API calls go through
  `retryApiCall`/`robustApiCall`, not raw.
### Secrets in tests

GitHub Push Protection blocks token-shaped literals even in fixtures. Build
fake tokens by runtime concatenation (`"sk-ant-" + "fake"`); pattern:
`telegram-plugin/tests/secret-detect-secretlint.test.ts`.

## CI

GitHub Actions is primary and gating. `main` is protected by repository
Ruleset `16470166` with **11 required checks**: `lint`, `bun-test`, `vitest`,
`build-base`, `build-hindsight`, and `build-dependents` ×6 (agent, broker,
kernel, auth-broker, hostd, web). Edits to the required list are Ruleset
edits (`gh api repos/switchroom/switchroom/rulesets/16470166`), not classic
branch protection.

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
- Image build cache is **GHCR registry** (`:buildcache` tags), not
  `type=gha` (#1965 — SAS-token expiry hard-failed heavy builds). `cache-to`
  is gated off PR events; PRs read cache only.

## UAT — the live end-to-end gate

`telegram-plugin/uat/` drives a **real mtcute Telegram client against a real
bot** — the only full inbound → claude → outbound exercise. Runs under
vitest via `bun run --cwd telegram-plugin test:uat <name>`
(`vitest.uat.config.ts`). Scenarios: `telegram-plugin/uat/scenarios/`,
named `jtbd-<job>-{dm,channel}` / `fuzz-*`.

- **`uat-gate` is a REQUIRED check** (`ci-uat.yml`). The heavy `uat-gate-run`
  fires on the self-hosted `uat-host` runner when plugin/agent paths change
  and `UAT_GATE_ENABLED` is set; it runs three live scenarios:
  `jtbd-fast-trivial-dm` (real DM round-trip, **hard reply-latency SLA of
  12s** — `HARD_TTFO_MS`), `inbound-no-drop` (rapid-fire no-drop, #2089),
  and `jtbd-rich-formatting-render-dm` (Bot API rich-entity render
  round-trip, #2739). The `uat-gate` sentinel passes when the run passed OR
  was legitimately path-skipped.
- **Known-flaky under quota/API turbulence.** If your diff doesn't touch the
  reply-latency or delivery path and `uat-gate` reds, re-run the workflow
  rather than trying to merge past it (you can't — bypass is locked).
- `uat-fuzz` is `workflow_dispatch`-only and non-required (each fuzz scenario
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

## Release (condensed — full landmine detail in git history + memories)

- **Version source of truth is the git tag**, resolved by
  `scripts/build.mjs:resolveVersion()`. The committed `package.json`
  `version` is a stale placeholder by design (see its `//version` comment) —
  never bump it in a commit. Release = CHANGELOG consolidation PR → merge →
  tag `vX.Y.Z` on the merge commit → push tag (triggers `docker-images`).
- `npm pack` names the tarball from the stale version — bump `package.json`
  **uncommitted** at pack time; verify `dist/cli/switchroom.js` is in the
  tarball before `npm publish --ignore-scripts`. Never pipe the build through
  `tail` (masks a failed exit).
- Create the GitHub Release (`gh release create`) — historically silently
  dropped. The naive `awk '/^## vX/,/^## v/'` CHANGELOG range collapses to
  one line; use a start-flag awk instead.
- The web container is a separate compose project
  (`~/.switchroom/web/docker-compose.yml`) — `switchroom update` doesn't
  touch it; pull + up manually.
- Fleet rollout: canary on test-harness first (UAT above), then staggered
  per-agent `switchroom agent restart <name> --wait --force` with a
  `--version` assertion per agent (guards the `:latest` pull-race). Deploy
  only from the host shell or via hostd (`SWITCHROOM_HOST_HOME` invariant —
  `reference/rfcs/deploy-reliability.md`); never via an ad-hoc container
  mounting the operator home.

## Secrets & safety rails

Dev-host vault is broker-auto-unlocked: `switchroom vault get <key>` needs no
passphrase. Never mirror the vault to plaintext; never commit tokens. Never
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
