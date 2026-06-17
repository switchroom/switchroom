# Install-validation re-run — 2026-05-17

Re-run of the 2026-05-14 blank-server install validation
(`install-validation-2026-05.md`) on a freshly snapshot-restored
Ubuntu 26.04 LTS VM. Goal: confirm the prior loop's open findings are
closed and that `install.sh` / `scripts/install-deps.sh` /
`docs/install.md` are aligned to the v0.7+ Docker architecture with
no stale or unneeded prerequisites.

Method: brand-new user, public docs/scripts only, no source dives.
Only interactive step is the Claude OAuth handoff; all other secrets
from repo-root `.env`. Both install entrypoints validated and
reconciled. Friction logged before fixing.

## Environment

- VM: `switchroom-vm` (192.168.2.250), Ubuntu 26.04 LTS, kernel
  7.0.0-15-generic, 8 vCPU, ~11 GiB RAM, 61 GiB disk. Snapshot
  restored to blank (uptime 0, no docker/node/bun/claude/switchroom,
  no `~/.switchroom`, no `~/code`).
- Canonical repo state: `upstream/main` @ f2fa5960.
- Driver: mtcute UAT harness (`telegram-plugin/uat/`) from workstation.

## Prior open findings to re-test

| # | Prior status | Expectation this run |
|---|---|---|
| 17 | foreman never reaches compose | re-test if `setup --foreman` used |
| 28 | OAuth scope too narrow → "Select login method" | PR #1280/#1286 area — verify boot auth |
| 31 | per-agent bot token: global env wins | PR #1256 fixed — verify two-bot identities |
| 33 | vault layout divergence too easy | verify clean first-write |
| 19b/23 | GHCR image stale vs source | verify deployed image current |

## Live findings (this run)

### Phase 1 — install-deps.sh
- ✅ Clean exit 0 in 71s on blank Ubuntu 26.04. docker 29.5.0,
  compose 5.1.3, node 22.22.1, bun 1.3.14, claude 2.1.143,
  switchroom 0.11.1. **Prior #1 (404 path) and #2 (undocumented
  bun) confirmed FIXED.**

### Phase 3 — `switchroom setup --non-interactive`

- **R1 (P0, regression of prior #30 — STILL OPEN).** `switchroom
  setup` wrote the config to **cwd** (`~/switchroom.yaml`), not
  `~/.switchroom/switchroom.yaml`. `docs/install.md:88` explicitly
  tells the new user setup "writes `~/.switchroom/switchroom.yaml`"
  — false. Depending on the cwd of a later `switchroom apply`, the
  config may not be found. Doc claim and code disagree.
- **R2 (UX, regression of prior #25 — STILL OPEN).** `setup`
  invoked with `SWITCHROOM_MEMORY_BACKEND=none` (per
  `docs/install.md:98` non-interactive table) still tried to create
  Hindsight banks for all 4 agents and printed 4 `⚠ Failed to
  create Hindsight bank … Unable to connect` warnings. The env var
  does not override the bundled config's per-agent
  `memory.backend`. Non-fatal (exit 0) but contradicts the
  documented knob.
- **R3 (Doc/UX, new).** `docs/install.md:87` says the wizard
  "scaffolds your first agent (`assistant` by default)" — singular.
  The bundled `examples/switchroom.yaml` actually scaffolds **4**
  agents (assistant, coach, dev, exec) with themed topics
  (Fitness, …). A new user following the doc expects one agent and
  gets four. Docs-vs-reality + defaults-test friction.
- ✅ `vault.enc` created in non-interactive mode (416 B). **Prior
  #16 (vault not inited non-interactively) confirmed FIXED.**

### Phase 5 — auth (interactive OAuth via `--via-claude`)

- **R4 (P0, prior #28 — code FIXED, user-facing surfaces NOT).**
  `--via-claude` mints the correct broad scope
  (`org:create_api_key user:profile user:inference
  user:sessions:claude_code user:mcp_servers user:file_upload`) —
  verified live from the surfaced OAuth URL. But the broken
  narrow-scope `--from-oauth` path is still recommended in **three**
  user-facing surfaces:
  1. `docs/install.md:144` Step 5 — the canonical new-user
     instruction.
  2. `src/cli/doctor.ts` "not authenticated" remediation hint.
  3. The auth "not authenticated" agent-health hint emitted by
     `apply`'s doctor sweep.
  A new user following the docs verbatim mints a token Claude
  refuses on boot — exactly the prior #28 symptom, relocated from
  code to docs/remediation copy. Fix: replace `--from-oauth` with
  `--via-claude` in all three surfaces. `auth add --help` itself is
  already correct (recommends `--via-claude`).
- **R5 (UX, new).** Every host-side `switchroom auth …` command run
  before Step 6 (`up -d`) prints `auth-broker unreachable … The
  broker may be down … Check the daemon: docker compose -p
  switchroom ps switchroom-auth-broker`. But per `docs/install.md`
  the documented order is auth (Step 5) **before** apply/up
  (Step 6) — so the broker legitimately does not exist yet. The
  message reads as a failure during a step the docs told the user
  to do. Either soften the message when no compose project exists
  yet (pre-bootstrap state), or reorder the docs so auth follows
  `up -d`.
- ✅ via-claude interactive handoff worked end to end over a
  scripted tmux drive (URL surfaced, pasted code injected,
  credentials ingested, exit 0). Credentials landed at
  `~/.switchroom/accounts/me/.credentials.json`.

### Phase 6 — apply + compose up

- **R6 (UX, candidate — confirm post-up).** `apply`'s post-run
  doctor sweep reports `! <agent>: start.sh scheduler block
  (unreadable: EACCES: permission denied, open …/agents/<agent>/
  start.sh)` for every agent on a fresh install. Doctor runs as the
  operator; start.sh is UID-aligned to the per-agent container UID
  by apply, so the operator can't read it. Non-fatal ("apply
  succeeded") but every agent shows a warning. Confirm whether this
  clears once containers are up.
- ✅ `apply --non-interactive` exit 0 in 6s; compose file emitted
  with vault-broker, approval-kernel, switchroom-auth-broker, 4
  agents + per-agent broker/kernel/auth-broker sockets. Found
  `~/switchroom.yaml` from `$HOME` (R1 happy-path holds while cwd
  ==$HOME; breaks if user `cd`s elsewhere — to be demonstrated).

### Phase 6/7 — HEADLINE P0: documented install never yields a working agent

**Verdict: a brand-new user following `docs/install.md` verbatim
ends up with every agent wedged at Claude's "Select login method"
screen. The goal's core gate (blank box → agent replies in
Telegram) is NOT crossed on the documented happy path.** Root-cause
chain (each link independently real):

1. **Docs auth/up ordering (P0).** `docs/install.md` Step 5 (auth)
   precedes Step 6 (`apply` + `docker compose up`). `switchroom
   auth add … --via-claude` and `auth use …` must talk to the
   auth-broker, which does not exist until Step 6. So `auth add`
   never registers the account with the broker; `auth use` prints
   `auth-broker unreachable`. The broker is the *sole writer* of
   each agent's `.credentials.json` (start.sh:150–151, RFC H) — with
   no registered account it writes nothing.
2. **`auth list` false-positive (P0-adjacent).** Post-`up`, `auth
   list` reports `✓ me available` (it reads the on-disk accounts
   store) while `auth use me` correctly fails `ACCOUNT_NOT_FOUND`
   (broker registry empty). The two disagree; the operator is told
   auth succeeded when the broker has nothing.
3. **Label mismatch (P0).** `setup` initialises `auth.active:
   default` and recommends adding a `default` account.
   `docs/install.md:144` Step 5 uses label `me`. Even with correct
   ordering, `auth use me` ≠ config `active: default`, so the fleet
   active never points at the created account.
4. **Onboarding wedge — the actual terminal blocker (P0).** Even
   after the corrected sequence (up → `auth add default
   --from-credentials …` with broker live → `auth use default` →
   broker mirrors `.credentials.json` to all agents → `claude auth
   status` = `{"loggedIn":true,…}`), the agent's `claude` *still*
   sits at "Select login method". Cause: `src/setup/onboarding.ts:
   359` `createMinimalClaudeConfig()` writes the scaffolded
   `.claude.json` with `hasCompletedOnboarding: false` (+ a stale
   "complete onboarding via `switchroom agent attach`" warning — a
   pre-Docker/pre-broker leftover). With that false, claude enters
   the first-run wizard whose login-method step **autoaccept-poll
   deliberately does not auto-answer**, so claude blocks there
   forever despite being functionally logged in.
   `src/agents/scaffold.ts:2437` already writes
   `hasCompletedOnboarding: true` — the two writers disagree and
   the `false` path wins.

   **Empirically confirmed fix:** flipping the agent's
   `.claude.json` `hasCompletedOnboarding` → `true` and recreating
   the container → claude boots straight to the working REPL,
   `loggedIn:true`, autoaccept then clears dev-channels + MCP-trust
   (`fired enter-to-confirm,dev-channels-loading,dev-channels-local`),
   and the agent reaches "Listening for channel messages from:
   server:switchroom-telegram". End-to-end auth path works once
   this one line is corrected.

- **R8 (P0, prior #28 — 5th surface).** `auth heal` /
  `diagnoseAuthState` (`src/cli/auth.ts:174`) and `apply`'s doctor
  sweep both still print `switchroom auth add default --from-oauth`
  as the remediation — the known-broken narrow-scope path. (R4 +
  R8: `--from-oauth` is wrongly recommended in **5** user-facing
  surfaces; only `auth add --help` is correct.)
- **R9 (UX/diagnostic bug).** `diagnoseAuthState` (auth.ts:103–111)
  wraps `JSON.parse(readFileSync(credsPath))` in a bare `catch {}`
  that reports `credentials_malformed` for **any** read failure.
  Run as the operator against an agent-UID-owned mode-0600
  `.credentials.json`, the EACCES is swallowed and misreported as
  "credentials file corrupted", with a remediation to re-run the
  broken `--from-oauth`. The file is valid; the operator just can't
  read it. EACCES must be distinguished from a parse failure.
- **R10 (UX).** `switchroom agent restart <agent>` on a
  freshly-booted agent fails with a lock and only a cryptic "re-run
  with `--force-locked` (will hard-fail with cleaner error)" hint —
  no explanation of what holds the lock or why.
- ✅ Singletons vault-broker / approval-kernel / auth-broker all
  report **healthy** on a fresh install. **Prior #18 (kernel
  SQLite crash-loop) and the broker healthchecks confirmed FIXED.**
- ✅ Broker fanout mechanism itself is correct (mirrors valid
  broad-scope `.credentials.json`, mode 0600, agent-UID owned;
  `claude auth status` accepts it). The problem is sequencing +
  the onboarding flag, not the broker.

## Verdict & prioritised fixes

**Not clean.** install-deps.sh and the prereq set ARE Docker-aligned
(no stale/unneeded prereqs — C1/C2 refuted). But the documented
*install flow* is internally inconsistent and cannot produce a
working agent without undocumented manual recovery.

Prioritised:

1. **P0 fix (one line, headline).** `src/setup/onboarding.ts:359`
   `hasCompletedOnboarding: false → true`, `numStartups: 0 → 1`
   (match `scaffold.ts:2437`); drop the stale "complete onboarding
   via `switchroom agent attach`" warning (pre-Docker).
2. **P0 docs.** `docs/install.md`: reorder so `apply` + `up`
   (current Step 6) precede auth (current Step 5); make the auth
   label consistent with `setup`'s `auth.active: default`; replace
   `--from-oauth` with `--via-claude`.
3. **P0 code.** Replace `--from-oauth` with `--via-claude` in the
   `diagnoseAuthState` recommendation (`src/cli/auth.ts:174`) — kills
   R4/R8 across the doctor-sweep + heal surfaces in one change.
4. **High.** `diagnoseAuthState` EACCES≠malformed (R9).
5. **High.** `SWITCHROOM_MEMORY_BACKEND=none` must override the
   bundled config (R2 / prior #25), or stop documenting the knob.
6. **Med (design call — flag to Ken).** Bundled
   `examples/switchroom.yaml` ships 4 agents sharing one
   `vault:telegram-bot-token` while `docs/install.md:87` says "your
   first agent (assistant)". Either ship a minimal 1-agent default
   or make the 4-agent example runnable + correct the doc (R3/R7).
7. **Med.** `setup` writes config to cwd, not
   `~/.switchroom/switchroom.yaml`; `docs/install.md:88` claims the
   latter (R1 / prior #30).
8. **Low.** R5 (pre-`up` "broker may be down" false alarm — mostly
   resolved by the Step 5/6 reorder), R10 (restart lock hint).

### Static-audit candidates — RESOLVED

- **C1 — REFUTED (not a finding).** Host `@anthropic-ai/claude-code`
  is *correctly required*: `switchroom auth add --via-claude` (the
  recommended first-time auth path) spawns host `claude` to mint the
  broader-scope token. install-deps.sh installing it is right.
- **C2 — REFUTED (not a finding).** Host `tmux` is *correctly
  required*: `--via-claude` drives `claude` inside a host tmux
  session (`switchroom-via-claude`). install-deps.sh installing tmux
  is right. (Net: the install-deps.sh prereq list is Docker-aligned
  — no stale/unneeded prereqs found in it.)

### Candidate findings from static pre-audit (to confirm empirically)

- **C1** — `scripts/install-deps.sh:158` + `docs/install.md:36,51` +
  `README.md:170` install `@anthropic-ai/claude-code` on the **host**.
  In the v0.7+ Docker model `claude` runs *inside* each agent
  container (baked into the agent image per CLAUDE.md). Host-side
  claude-code looks like a pre-Docker vestige. Confirm whether any
  host CLI path actually needs it.
- **C2** — `scripts/install-deps.sh:90-92` installs `tmux` on the
  **host**. The tmux socket+session contract lives *inside* the agent
  container; host attach is `docker exec -it … tmux`. Confirm host
  tmux is unneeded.

## Follow-up resolution (post-loop, 2026-05-17)

Every code finding from this loop was fixed and merged to
`switchroom/switchroom:main`, each via a fresh separate-process
reviewer:

| PR | Finding | Notes |
|---|---|---|
| #1422 | Headline P0 chain | onboarding `hasCompletedOnboarding` flag; docs auth/up ordering + label; `--from-oauth`→`--via-claude`; auth-heal EACCES. E2E verified (blank box → Telegram reply, 7 s). |
| #1423 | R3/R7 | one bot per agent — example ships ONE active agent, rest commented w/ own `bot_token`; install.md + botfather docs. |
| #1426 | R1 (prior #30) | `setup` bootstraps to `~/.switchroom/switchroom.yaml`; `stepConfigFile` mirrors `findConfigFile`. |
| #1428 | per-agent vault seed | `storeTokenInVault` takes explicit ref; per-agent `vault:` tokens now persisted. |
| #1425 | R2 (prior #25) | `SWITCHROOM_MEMORY_BACKEND=none` honored. Took **4 review rounds** — env override was respected at 1 of ~11 sites. Resolution: a single exported `isHindsightEnabled()` helper; every scaffold/reconcile/CLI/diagnostic gate routes through it; zero inline gates remain. |

### Two-bot admin-gate matrix (goal DoD #4)

- ✅ **Admin-gate enforced (core security property):** `/agents`
  to the non-admin bot returned the exact gateway rejection —
  *"⚠️ /agents is an admin command — this agent (assistant) isn't
  admin-flagged. Run it from an admin agent, or set admin: true…"*.
  Gateway intercepted; Claude never saw it.
- ✅ Distinct bot identities (admin `7767260960` / normal
  `8803564120`); admin agent scaffolded `admin: true` + own
  vault-scoped token. Single-bot conversational reply proven (#1422).
- ⚠️ **Admin-bot `/agents` + conversational reply BLOCKED** — not
  an admin-gate defect. New finding below.

### New finding — vault-broker re-lock fragility (P1; extends #32)

`switchroom apply` (e.g. adding an agent) recreates the dockerized
`switchroom-vault-broker` container **locked**, because
non-interactive `setup` writes a **0-byte** `vault-auto-unlock`
blob and never populates it (and `vault broker enable-auto-unlock`
has no non-interactive path — aborts "Empty passphrase"). The
docker-native machine-id auto-unlock mechanism *is implemented and
does run* (`server.ts:_tryAutoUnlockFromMachineBoundFile`); it just
has a malformed empty blob to decrypt → "staying locked". Every
agent gateway with a `vault:` bot_token then crash-loops; the
supervisor **permanently gives up after 10 restarts/60 s**
(`profiles/_base/start.sh.hbs:68`); no operator unlock path works
in the docker model (host `vault broker unlock` drives a *separate*
host daemon — #32; broker image lacks the CLI); the broker
healthcheck reports "healthy" while locked; the gateway's error
names a non-existent command (`switchroom vault unlock`). Agents
that resolved their token before the recreate keep working on a
held long-poll, masking it.

Strategic resolution captured as **RFC J — Vault-broker resilience
& default auto-unlock** (`reference/rfcs/vault-broker-resilience.md`):
(1) auto-unlock as the unattended default — mechanism already
exists, wire it into non-interactive setup; (2) supervisor
exponential-backoff + indefinite retry for the transient-dependency
class (the always-on backbone); (3) collapse the host/in-container
broker duality (#32); (4) honest healthcheck + operator messages.
This is the single biggest install-correctness gap remaining after
this loop's PRs.
