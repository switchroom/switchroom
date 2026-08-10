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

## Models

- **Code default** when `model:` is absent or the literal `"default"` is
  `claude-sonnet-5` (`SWITCHROOM_DEFAULT_MAIN_MODEL`, `src/agents/scaffold.ts:1509`;
  `resolveMainModel()` at :1525). `"default"` deliberately does NOT mean the
  *account* default — claude would pass it through and resolve it to a model
  the account may not have, 4xx'ing every turn. The live fleet's
  `defaults.model` lives in the operator's `switchroom.yaml`, not in this repo.
- **Prefer the family aliases** `opus` / `sonnet` / `haiku` / `fable` over pinned
  ids: an alias tracks the current flagship, a pinned id goes stale. `fable`
  resolves ONLY through the LiteLLM proxy — `normalizeModelAlias()` folds
  `claude-fable-5` → `fable`. **Adding a proxy-only model means editing the
  repoint `case` in `profiles/_base/start.sh.hbs` (~:1772)** — that is where
  routing actually moves. `src/agents/compose.ts` bakes `ANTHROPIC_BASE_URL` on
  model CLASS, so `fable` (a Claude model) starts on the `/anthropic`
  passthrough and start.sh repoints it to the router root at boot.
  `declaredRoutingMode()` (`scaffold.ts:1546`) routes nothing: it only encodes
  the POST-repoint intent so `.routing-mode` can compare landed vs declared.
  Change the repoint case and that function together or a healthy boot fires a
  spurious "Routing divergence" alert.
- **Only PINNED Opus 4.x is covered by the adaptive-thinking risk check.**
  `isAdaptiveThinkingOpus()` (`src/config/thinking-effort-risk.ts`) matches
  `claude-opus-4*` and nothing else; `switchroom doctor` WARNs on those with
  `thinking_effort` above the `low` floor (`src/cli/doctor.ts:533`). The
  documented failure is the upstream claude-CLI interleaved-streaming merge bug
  (#1978): `400 messages.N.content.M: 'thinking' or 'redacted_thinking' blocks
  in the latest assistant message cannot be modified`. It was FIXED in
  claude-code 2.1.156, so Opus 5 and the bare `opus` alias are deliberately not
  matched and the fleet runs `medium`. Don't re-add the Opus 5 arms, and don't
  advise pinning `low` fleet-wide. **That narrowing is only sound while the
  container is actually running a CLI at the floor**, so the residual risk is
  covered by a second check, not by widening the first: doctor's
  `Claude CLI floor (#1978)` section (`src/cli/doctor-claude-cli.ts`)
  `docker exec`s each container, resolves `claude` through the same PATH prefix
  `start.sh` exports (so a shadow install is seen, not the image binary), and
  WARNs below the floor — naming the exposure when that agent is on an Opus
  model at `medium`+. `CLAUDE_CLI_THINKING_MERGE_FIX_VERSION` in
  `thinking-effort-risk.ts` is the single source of the floor; the production
  pin stays in `docker/Dockerfile.base` and is read from there.
- **Cron tiering keys off the model STRING — but only third**
  (`src/scheduler/cron-routing.ts`). Two gates decide before the model is
  consulted: `kind: action` returns `tier: "action"` at `:89` and is
  flag-independent (a zero-token verb has no Tier-2 fallback, so gating it would
  silently drop the cron); and the `cheapCronEnabled` kill-switch
  (`SWITCHROOM_CHEAP_CRON=0|false|off`) short-circuits **every** fire to
  `{ tier: "main", session: "main" }` at `:97`, leaving `kind`/`model`/`context`
  inert. Past those, an explicit **`context:` outranks model inference**
  (`:107`) — only the `else` branch consults `isKnownCheapModel()` (`:109`),
  where `sonnet|haiku` ⇒ cheap Tier-1 fresh session and `opus` ⇒ Tier-2 live
  session. An **unrecognised id also falls to Tier-2** with a
  `customModelDowngrade` warning — a typo'd or newly-renamed cheap model
  silently costs full-session tokens.
- **The `/model` override rides a consume-once carrier** whose shape gate is
  byte-parity across **five** sites: four identical `grep -Eq` copies in
  `profiles/_base/start.sh.hbs` (live-model :1478, last-known-good :1502,
  migration :1551, carrier :1629) and `MODEL_ARG_RE` in
  `telegram-plugin/gateway/model-command.ts:64`. A string failing the gate is
  dropped to the configured default with a one-shot operator alert and is never
  retried. Change one, change all five in the same PR —
  `tests/scaffold.session-model.test.ts:194` scrapes every `{0,99}` pattern out
  of the RENDERED `start.sh`, asserts they are byte-identical, and runs a shared
  fixture table against both the shell pattern and the TS `isValidModelArg`.
- **Never hard-code a token budget against an assumed context window** — derive
  it from a declared one (`src/setup/hindsight-context-budget.ts`, #3717). The
  `claude-code` / `anthropic` provider default is `200_000`.

## Commands

```bash
bun install                  # deps (bun.lock)
bun run dev -- <args>        # run CLI from src/ via bin/switchroom.ts
npm run build                # node scripts/build.mjs → dist/
npm run lint                 # tsc --noEmit + 16 guard scripts (see Lint gates)
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
  setup/                first-run setup + hindsight provisioning/budgets
  self-improve/         self-improvement proposal gating + tier routing
  hindsight-watch/      memory-quality probe → metrics → thresholds
  telegram/             CLI-side Telegram helpers (bot setup, access)
  secret-detect/        secret detection + redaction shared by gateway/issues
  drive|microsoft|notion|linear|litellm|memory|...   integrations
bin/                    switchroom.ts entry + the hook/boot shell scripts
telegram-plugin/        the MCP Telegram plugin + gateway (own test suite)
  server.ts             MCP stdio entry;  gateway/ is the long-lived gateway
  tests/                mostly bun test; uat/ is the live mtcute harness
docker/                 Dockerfile.{base,agent,broker,kernel,auth-broker,
                        hostd,web,hindsight,voice,uat-runner}
profiles/               agent profiles; _base/start.sh.hbs = container entry
skills/                 bundled Claude Code skills
scripts/                build.mjs + the lint guard scripts
tests/                  vitest suite for src/;  tests/docker/ = docker e2e
evals/                  Python eval harness (dataset.yaml + run_*.py)
commands/               bundled slash commands (setup/start/status/stop)
vendor/                 vendored upstream (hindsight-memory) — a snapshot,
                        not the spec; read vendor/hindsight-memory/CLAUDE.md
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

**A third suite gates merges, outside `npm test`.** `ci-tests-python.yml` runs
`python3 -m unittest discover` in `vendor/hindsight-memory/scripts` (`tests/`),
`docker/voice-sidecar` and `docker/litellm-pacer`, reporting as the required
`python-ok` sentinel — touching Python under those paths needs a local
`unittest` run, not a vitest one. `tests/docker/` (the docker e2e suite) is
likewise gated in CI by `docker-e2e.yml` → the required `e2e-ok` sentinel, and
does not run under plain `npm test`.

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
container constraints, parallel port contention. The 89 scenarios under
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
`check-bun-test-imports`, `check-bun-module-mock-scope`,
`check-no-pii-secrets`, `check-vault-test-hermeticity`,
`check-auth-test-hermeticity`, `check-agent-state-dir-hermeticity`,
`check-no-broadcast-delivery`, `check-stale-tool-descriptions`,
`check-mcp-instructions-budget`, `check-web-subscription-honest`,
`check-no-unpinned-npx-playwright`, `check-gateway-line-ratchet`,
`check-litellm-config-guard`, `check-release-asset-names`,
`check-status-pin-single-path`, `check-agent-attribution-trailers`,
`check-callback-ctx-wrapping`, `check-ctx-send-wrapping`,
`check-foreign-db-readonly`.

Traps that bite repeatedly:

- **`check-agent-attribution-trailers` needs full history.** It diffs
  `origin/<base>..HEAD` and looks for `Switchroom-Agent:` /
  `Switchroom-Model:` on machine-authored commits. Under a depth-1
  checkout there is no base ref and it SKIPs — which is why
  `ci-lint.yml` checks out with `fetch-depth: 0`. If it fails locally,
  your agent container is committing without the attribution hook: set
  `git config --global core.hooksPath /opt/switchroom/git-hooks`, then
  re-stamp with
  `git rebase -i --exec 'git commit --amend --no-edit' <base>`.

- **`check-callback-ctx-wrapping` ratchets the button-tap path** (#3891). Raw
  `ctx.answerCallbackQuery` / `ctx.editMessageText` / `ctx.editMessageReplyMarkup`
  bypass `robustApiCall`, so their 429s never reach the flood ledger and a failed
  card repaint leaves an already-resolved approval card live and tappable. The
  guard requires `apiCall` on every `finalizeCallback(` call site and holds the
  remaining raw sites to an EXACT per-file inventory in
  `scripts/callback-ctx-wrapping-baseline.json` — adding one fails, and removing
  one fails until you lower the number in the same PR. Escape hatch (reason
  mandatory): `// allow-raw-callback-ctx: <reason>` on the preceding line.

- **`check-ctx-send-wrapping` ratchets the context-SEND path** (#4599). Same
  mechanism, different family: raw `ctx.reply` / `ctx.replyWithRichMessage`.
  `check-bot-api-wrapping.sh` is anchored on `\.api\.` and *structurally cannot*
  match these, so a green run of it never meant "every send transits
  `robustApiCall`" — that false claim in `system-message-observer.ts` is why
  `/usage` cards left no history row and native replies to them resolved to an
  id with no text. EXACT per-file inventory in
  `scripts/ctx-send-wrapping-baseline.json`; escape hatch (reason mandatory):
  `// allow-raw-ctx-send: <reason>` on the preceding line. Counting rules for
  both ratchets live once in `scripts/lib/raw-ctx-scan.mjs`.

- **`check-no-pii-secrets` fails on real operator PII** — real Telegram
  chat/user IDs, emails, hostnames pasted into tests or docs. Use synthetic
  IDs and the repo's placeholder conventions.
- **`check-auth-test-hermeticity` guards the auth-broker live-probe flake**
  (#3612). `AuthBroker` force-probes accounts through `fetchQuota` (10s
  default abort) inside request paths the broker harnesses deadline at 3s,
  so an un-seamed broker in a unit test is a latency coin flip that reds CI
  as `Error: rpc timeout` (#3609, #3613). `tests/vitest-setup/auth-net-guard.mjs`
  (a `setupFiles` entry) replaces `globalThis.fetch` with a rejecting stub
  for every vitest file that constructs an `AuthBroker` or calls
  `fetchQuota` — so **`fetch` throwing `SWITCHROOM_AUTH_TEST_NET_GUARD` in
  an auth test is the guard working, not a bug**. If your test needs a real
  quota result, inject `_testFetchQuota` (broker) or `fetchImpl`
  (`fetchQuota`). The lint fails if the wiring is removed or if a
  fetchQuota-reachable file is vitest-`exclude`d (bun-run) where the setup
  file cannot load; `src/auth/broker/net-hermeticity.test.ts` is the
  matching runtime alarm.
- **`gateway.ts` raw `bot.api` allowlist is file:line-keyed** — any insertion
  in `telegram-plugin/gateway/gateway.ts` shifts entries and fails
  `check-bot-api-wrapping` while tsc stays green. Run it locally and widen
  ranges in the same PR. New Telegram API calls go through
  `retryApiCall`/`robustApiCall`, not raw.
- **`check-litellm-config-guard` always checks the repo-managed config** —
  `docker/litellm-proxy/litellm-config.yaml` is the source of truth (KEN-125)
  and MUST exist, parse, and pass I2 scoping; editing it badly fails lint and
  `src/litellm/repo-config.test.ts`. The LIVE host copy is additionally checked
  where resolvable — `LITELLM_CONFIG_PATH`, else discovered by scanning
  `/data/coolify/services/*/litellm-config.yaml` (no deployment service id is
  hardcoded in this repo; ambiguous or absent → skip, so CI/dev skips the live
  copy); on-host enforcement for the live file is the fleet-health sensor
  (`src/fleet-health/litellm-config-sensor.ts`), which escalates a violation
  into the priority ledger.

### Secrets in tests

GitHub Push Protection blocks token-shaped literals even in fixtures. Build
fake tokens by runtime concatenation (`"sk-ant-" + "fake"`); pattern:
`telegram-plugin/tests/secret-detect-false-positives.test.ts` (~:86) and
`telegram-plugin/tests/secret-detect-sanctum.test.ts` (~:18).

## Progress surfaces and pins — one path only

Status pins (the foreground activity card, worker feeds, the slot banner, tool
cards) are a **single-path subsystem**. There is exactly one implementation and
you may not add a second, not even "temporarily" or "just for this one call
site". #3831 is what happens otherwise: the retarget expansion existed twice —
once in the orchestrator, once inside the driver — with *different* persistence
semantics, the second copy unreachable in production and quietly drifting until
someone wired it up.

The path, top to bottom:

```
caller (narrative lane / worker feed / turn-end / reaper / boot sweep)
  → gateway `reconcileStatusPin(pinKey, chatId, desired)`      gateway.ts
    → runStatusPinReconcile()          gateway/status-pin-retarget.ts
         the ONLY decider (decidePinAction) and retarget expansion
      → reconcileAndPersistStatusPin() gateway/status-pin-store.ts
           persist-BEFORE-pin; the ONLY writer of status-pins.json
        → executePinLeg()              status-pin-driver.ts
             executes ONE decided leg; its `PinLegAction` type cannot
             express a repin, so the fork cannot grow back
          → createStatusPinApi()       gateway/status-pin-api.ts
               the ONLY raw pinChatMessage / unpinChatMessage surface
```

Rules, in the order you are most likely to trip them:

- **Want something pinned or unpinned? Call `reconcileStatusPin`.** Never
  `bot.api.pinChatMessage` / `unpinChatMessage` / `unpinAllChatMessages`
  directly. Only that path keeps the in-memory claim, the durable
  `status-pins.json` row and Telegram in agreement — which is what lets the
  mid-session reaper and the boot sweep clean up after a crash.
- **Never call `decidePinAction` yourself, and never name a `'repin'`** outside
  `status-pin.ts` / `status-pin-retarget.ts`. That is the #3831 fork verbatim.
- **Never mutate the claim registry** (`statusPinClaims.set/delete/clear`).
  Read it freely; it is written only by handing it to `runStatusPinReconcile`.
  Writing it out of band re-creates #3809 — a claim the reaper can never act on.
- **Never write `status-pins.json` directly.** `reconcileAndPersistStatusPin`
  owns the persist-BEFORE-pin ordering crash recovery depends on.
- **Never compose the orchestrator + driver a second time.** One wiring, in
  `gateway.ts`; a second composition is a second subsystem with its own claims.

`scripts/check-status-pin-single-path.mjs` (in `npm run lint`, so it fails CI)
enforces all five statically, with actionable failure messages. Sanctioned files
live in `scripts/check-status-pin-single-path-allowlist.txt` — adding one is a
deliberate, reviewable edit, which is the point; the raw-API and store-write
rules also take an inline `// allow-raw-pin: <reason>` /
`// allow-raw-pin-store: <reason>` escape (a reason is mandatory). The decider,
expansion and claim-registry rules have **no escape at all**.

Outcome coverage lives in `telegram-plugin/tests/status-pin-lifecycle.test.ts`,
which drives the real modules with fakes only at the Telegram/fs boundary and
asserts observable pin/unpin calls across claim → retarget → worker pin →
restart-with-stale-claim → SIGTERM → bridge flap → done. Extend it rather than
writing a unit test of a helper: this area regresses through *composition*, not
through individual functions.

## CI

GitHub Actions is primary and gating. `main` is protected by repository
Ruleset `16470166` with **7 required checks**: `lint`, `bun-test`, `vitest`,
`images-ok`, `uat-gate`, `e2e-ok`, `python-ok`. Every one is a *sentinel* —
the individual heavy/build jobs are NOT required, so matrix/job renames there
don't touch branch protection; keep each sentinel's `needs` list complete
instead. Edits to the required list are Ruleset edits (`gh api
repos/switchroom/switchroom/rulesets/16470166`), not classic branch
protection.

- **Sentinel pattern:** all seven are always-running jobs that aggregate
  path-gated heavy runs — `lint` (`ci-lint.yml` → `lint-run`), `vitest`
  (`ci-tests-core.yml` → `vitest-shard` ×4), `bun-test`
  (`ci-tests-plugin.yml` → `bun-test-run`), `python-ok`
  (`ci-tests-python.yml` → `unittest`), `uat-gate` (`ci-uat.yml` →
  `uat-gate-run`), `e2e-ok` (`docker-e2e.yml` → `e2e` + `hindsight-probe`),
  `images-ok` (`docker-images.yml`). A path-filtered job reporting "skipping"
  is a PASS for that PR — **skipping ≠ failing**. Don't chase skipped shards.
- **The merge queue is ON** (a `merge_queue` rule on the same ruleset: SQUASH,
  `ALLGREEN` grouping, 60-min `check_response_timeout`). GitHub pushes a
  `gh-readonly-queue/...` ref and waits for all seven contexts to report **on
  that ref**, so every one of those workflows carries a `merge_group:` trigger
  — dropping one wedges `main`. Rules and invariants: `.github/MERGE-QUEUE.md`,
  pinned by `tests/ci-merge-queue-triggers.test.ts`.
- Governance (set 2026-05-17, deliberate): admin-bypass locked
  (`bypass_actors: []` — `gh pr merge --admin` cannot work), no required
  human review, `strict` up-to-date **ON** — a branch must be up to date with
  `origin/main` before it can merge. Auto-merge repo-wide: `--auto --squash`
  merges the moment required checks go green. CI recovery lever is
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

- **`uat-gate` IS a required check** (`ci-uat.yml:230`) — an always-on sentinel
  in Ruleset 16470166's seven, so `--auto --squash` cannot merge past a red
  one. It passes when `uat-gate-run` succeeded OR was legitimately skipped
  (non-UAT PR / gate off), and fails on a real failure or a broken `changes`
  filter. The heavy `uat-gate-run` fires on the self-hosted `uat-host` runner
  only when plugin/agent paths change AND the repo var `UAT_GATE_ENABLED` is
  `true` — **it has been `false` since 2026-07-04** (per-commit live UAT burns
  subscription quota), so in practice the heavy run is `workflow_dispatch`
  on-demand only and the sentinel passes on the skip path. It is also
  deliberately never run on `merge_group` (single self-hosted runner would
  stall the queue). When it does run, three live scenarios:
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
single-tenant, telegram-and-buzz-only, chat-is-source-of-truth), `product-spec.md`
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
4. Conventional Commits (`feat(scope):` …). **Before pushing a shippable
   change, stage the CHANGELOG entry author-side:** `bun run
   changelog:generate` derives a `## Unreleased` entry from your
   conventional-commit title (idempotent; respects the `no-changelog` /
   `[skip changelog]` hatches), then commit `CHANGELOG.md` so it rides your own
   push — #4469's `check-changelog-entry.mjs` stays the CI backstop. Generation
   is author-side, not a CI commit-back, because a `GITHUB_TOKEN` push can't
   re-trigger the required checks (see `.github/MERGE-QUEUE.md` § "Author-side
   changelog generation"). Push the branch to `origin` (canonical-only model,
   no forks): `gh pr create --repo switchroom/switchroom --base main`. Title
   <70 chars; body: Summary / Why / Test plan / Risk + the job-spec citation.
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
fragment. It binds work on THIS repo too — the five parts, condensed:

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
4. **Pipeline.** `git fetch origin`, then branch off `origin/main` — never
   off the working copy as-is. Scoped tests + `npm run lint` locally; CI is
   the full-suite authority. Adversarial review of the diff; blockers and
   majors block the merge, lows get filed as follow-up issues rather than
   fixed now (filing is mandatory). Fix what blocks, then merge on CI green.
   **Do not count review rounds and do not run a mandatory re-review pass** —
   verifying your own fix is part of making it, not a separate step. Durable
   fixes over hack patches; deterministic mechanisms over model-dependent
   behavior; tests assert outcomes, not just code paths.
5. **Communicate.** Consolidated messages, always-visible progress, no
   foreground watches over 30s (background + notification), max 15 parallel
   sub-agents — enforced, not merely advised: `start.sh` /
   `cron-session.sh` export `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=15`
   (below the CLI's own default of 20). Change that export and the
   dev-protocol prose together.

## Third-party docs — the official site is the spec

Authority order for any third-party dependency, highest first:

1. **The vendor's official documentation site.** Search it first, before
   concluding anything about what that dependency does or doesn't support.
2. **context7 when the library is indexed** — `resolve-library-id` then
   `query-docs`; wired for every agent by default (`docs/configuration.md`).
3. **The OSS repo and our `vendor/` copy, last.** A vendored tree is an
   implementation snapshot at one commit, not the specification.

For Hindsight, which we vendor and run:

- Docs root <https://hindsight.vectorize.io/>. Memory curation lives at
  `/developer/api/memories`; see also `/developer/api/retain`,
  `/developer/api/recall`, `/developer/observations`,
  `/developer/configuration`, and the index at `/api-reference`. There is no
  `/developer/` index page (it 404s) — enter from the root.
- context7: prefer `/websites/hindsight_vectorize_io` (the docs site) over
  `/vectorize-io/hindsight` (the OSS repo).

**"No config path exists" / "not supported" / "not possible" are positive
claims that need a check, not inferences from a failed local grep.** A worker
tuning hindsight recall/consolidation told the operator no documented config
path existed, because the running container ships no `/app/docs` and `vendor/`
had no such knob — while the docs site documented the sanctioned answer the
whole time: `PATCH /v1/default/banks/{bank}/memories/{id}` with
`state: "invalidated"` soft-retires a duplicate, `state: "valid"` restores it.
Absence of local documentation is not evidence that no documentation exists.

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
  **pin `SHA=$(git rev-parse origin/main)`** → `gh release create vX.Y.Z
  --draft --target "$SHA"` → `git push origin "$SHA:refs/tags/vX.Y.Z"`.
  Never `--target main`: it resolves server-side and agents merge in
  parallel, so an unrelated PR can be swallowed into the release.
- **`.github/workflows/release.yml` is the release ORCHESTRATOR (#3654).**
  A tag push starts exactly two workflows — `docker-images` and `release` —
  and `release` sequences everything else: attach the four static binaries →
  wait for `docker-images` to conclude `success` for that exact tag+commit →
  `workflow_call` into `npm-publish.yml` → un-draft the GitHub Release →
  promote `:latest`. **`npm-publish.yml` has NO tag trigger.** npm is the only
  irreversible leg, so it runs late, and it re-proves both preconditions from
  inside its own run — a hand `workflow_dispatch` cannot half-ship either. Any
  red leg leaves the release a draft with npm unpublished, which is
  recoverable; re-dispatch `release.yml --ref vX.Y.Z -f dry_run=false` to
  resume.
- **`:latest` follows the RELEASE, not the tag push (#3735, issue #3685).** A
  `v*` tag push makes `docker-images.yml` publish `:vX.Y.Z` **only** — it no
  longer moves `:latest` (only a main push still tags `:latest` + `:sha-<7>`).
  `release.yml`'s terminal `images-latest` job runs `needs: finalize` (so after
  binaries, `images-gate`, npm and the un-draft are all green) and
  `workflow_call`s `promote.yml` with `from: vX.Y.Z, to: latest`, which retags
  by manifest copy across all 9 images and verifies digest equality. Failure
  mode is therefore `:latest` **lagging** the release — the previous good image
  keeps serving installs and `switchroom update` — never `:latest` leading a
  half-shipped one. Manual recovery: `gh workflow run promote.yml -f
  from=vX.Y.Z -f to=latest`. `promote.yml`'s matrix must cover every image
  `docker-images.yml` publishes on a tag or that image's `:latest` silently
  stops advancing; R14 in `tests/release-pipeline-gating.test.ts` derives the
  expected set and fails on drift.
- **The GitHub Release is created as a DRAFT and only `finalize` publishes
  it.** `install.sh` resolves the version from `/releases/latest`, which
  excludes drafts — so an in-flight or failed release leaves the previous
  complete release serving `curl | sh` installs. Creating it published is
  the v0.19.19 failure (published, zero assets, `latest`, installer 404 on
  every platform); `release.yml`'s `guard` job re-drafts an incomplete
  published release within ~1 minute as the safety net.
- **npm publish (`.github/workflows/npm-publish.yml`)** does the uncommitted
  pack-time `package.json` bump, builds, verifies `dist/cli/switchroom.js`
  is non-empty AND in the tarball (the v0.12.6→7 empty-build guard),
  `npm publish --ignore-scripts --provenance`, and verifies `npm view
  switchroom version` shows the new version. Needs the `NPM_TOKEN` repo
  secret (set once). **Do NOT roll the fleet until `npm view switchroom
  version` returns the tag version.** Never run `npm publish` by hand from
  an agent container (no npm auth there); fix the workflow, don't side-step
  it. Release builds need a **real `node_modules`**, not a worktree
  symlink — a symlinked one made `bun build` silently emit an empty
  `dist/cli/` (broke v0.12.6→7); the workflow's setup-switchroom action
  avoids this and the empty-build guard catches it.
- **Both release workflows keep every `${{ }}` out of `run:` bodies** — they
  hold `contents: write` and `NPM_TOKEN`, and an interpolated expression is
  materialised into the script file on the runner where log masking cannot
  reach it. `tests/release-pipeline-gating.test.ts` fails the build if one
  reappears, and mutation-tests every gating rule (neither workflow runs on
  a PR, so a broken gate would otherwise only surface at the next release).
- The naive `awk '/^## vX/,/^## v/'` CHANGELOG notes range collapses to one
  line; use a start-flag awk instead.
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
