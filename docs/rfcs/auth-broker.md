# RFC H: `switchroom-auth-broker` — single-writer OAuth credential plane

Status: Draft v1
Author: Ken (via Claude pair-design)
Date: 2026-05-14

## 1. Summary

A new compose singleton, `switchroom-auth-broker`, that becomes the
**sole writer** of per-agent `<agentDir>/.claude/.credentials.json` and
the canonical owner of the OAuth refresh loop for every Anthropic
account on the host. The broker mirrors the architectural shape of
`switchroom-vault-broker` (long-lived UDS daemon, per-agent socket
chowned to the agent's UID, path-as-identity, bind-presence
healthcheck) and the operational contract from
`reference/share-auth-across-the-fleet.md`.

Side effects of landing this RFC:

- The whole per-agent-fanout-from-the-host-user code path goes away,
  so the EACCES class of bugs (`auth promote` / `auth refresh-accounts`
  failing into per-agent `.claude/` dirs owned by per-agent UIDs)
  disappears at the source. No `sudo` self-elevation needed in any
  auth verb.
- `auth refresh-accounts`' last-write-wins fanout bug (every agent's
  `credentials.json` ends up holding whichever account was last in
  the iteration) is structurally impossible: the broker writes
  one-account-per-agent based on that agent's *active* selection, not
  whichever account refresh loop ran last.
- The fleet-wide UX shift documented in earlier design conversations
  ships in the same PR: `auth use <label>` swaps the *fleet*'s active
  account in one verb; per-agent override is the edge case behind a
  hidden verb. The schema flips from per-agent `auth.accounts: […]`
  arrays to a single fleet-wide `auth.active`.
- `CLAUDE_CODE_OAUTH_TOKEN` env injection in `start.sh` is deleted
  (Decision 5 of the design contract). One mechanism, not two.
- The per-agent slot tree (`<agentDir>/.claude/accounts/<slot>/`,
  `.oauth-token`, `.oauth-token.meta.json`) is deleted from the
  scaffold (Decision 6).
- "No migration" applies: there are no users in the wild. The PR
  ships a clean break; existing dev/test fleets re-mirror cleanly
  on first `switchroom apply` post-merge.

This unblocks `feat/hindsight-claude-code` (parked branch — see
memory entry), which needs the broker's `get-credentials` UDS verb
to feed `claude` running in a hindsight container without
bind-mounting an agent dir.

## 2. Motivation

The current per-agent fanout model has three load-bearing problems
that have shown up in production over the last week:

1. **EACCES from host operator.** `apply` self-elevates via sudo;
   `auth promote / enable / disable / refresh-accounts` and `agent
   restart` do not. They try to write into `~/.switchroom/agents/<a>
   /.claude/.credentials.json` (owned by the per-agent UID, mode 0700)
   from the host user (UID 1000) and silently fail with a ⚠ that the
   exit code claims is success. Operator recovers by running
   `sudo HOME=… /full/path/bun /full/path/dist/cli/switchroom.js …`
   — an incantation no doc mentions.

2. **Last-write-wins fanout in `auth refresh-accounts`.** The function
   iterates `for (const label of listAccounts()) { fanoutAccountToAgents(label, allEnabled) }`,
   so each agent's `credentials.json` ends up holding whichever
   account iterated last — regardless of `auth.accounts[0]`. Running
   the tick once silently nukes the entire fleet's credentials onto
   one (effectively random) account.

3. **OAuth refresh race.** Anthropic's refresh-token endpoint is
   single-use: the response invalidates the prior refresh token. When
   multiple consumers refresh the same account concurrently, only one
   wins; the others silently get an invalid token. Today every agent
   container with claude can be a refresher, and a per-account
   coordinator does not exist.

The design contract at `reference/share-auth-across-the-fleet.md`
already prescribes the fix shape: one broker, one writer, one
refresher per account. This RFC is the *how* to that *what*.

## 3. Goals and non-goals

**Goals:**

- Single writer for `<agentDir>/.claude/.credentials.json` is the
  broker; the host CLI never writes per-agent credential files
  directly. EACCES on auth verbs becomes impossible.
- Single refresher per Anthropic account. The broker holds an
  exclusive lease on each account's refresh loop; the OAuth race
  becomes impossible.
- Single source of truth for per-account quota state. When account A
  hits 429, every agent on account A is rolled to its next fallback
  within seconds, not on each agent's next inbound message.
- Fleet-wide active-account verb: `switchroom auth use <label>`
  changes the active account for every non-overridden agent in one
  call.
- Ephemeral-consumer pattern: a non-agent container (hindsight,
  one-shot crons) can ask the broker for the current credentials of
  the active account and feed them to `claude` via a tmpfs
  `CLAUDE_CONFIG_DIR`.
- `switchroom-runtime`-style degraded mode: if the broker is down,
  agents keep running on whatever's in their existing
  `credentials.json`. Token lifetime is 8h; the broker can be down
  for hours without a user-visible outage.
- All five UX-contract checks the JTBD lists in *Signs it's working*
  (docs test, fits on one screen, sub-agent auth, cron auth, quota
  propagation, idle survival, audit answer-matches-reality, refusal
  on rm).

**Non-goals:**

- Anthropic-side rate-limit *prediction* (we react to 429, we don't
  predict against quota math). The track-plan-quota-live JTBD is a
  separate concern; the broker exposes the data it has, the chat
  surface formats it.
- Multi-host / network-reachable broker. UDS only. A
  TCP-or-TLS-fronted variant for remote consumers is a follow-up
  (and the trust model that comes with it is its own RFC).
- API-key auth. Subscription-honest principle still applies. The
  broker speaks OAuth and only OAuth.
- Long-term migration framework. There are no external users; the
  one in-the-wild deployment is the canonical-repo author's
  dogfood fleet. `apply` runs a one-shot in-place upgrade
  algorithm (§6) that handles that fleet's specific shape and is
  retained as deletable code for ~one release. The "no migration"
  stance here means: no compatibility shims, no two-shapes-
  coexisting, no `switchroom auth migrate` verb — *not* "no
  in-place upgrade." Pick the right framing when reading §6.

## 4. Design

### 4.1 Process model

A new compose service `switchroom-auth-broker`, lives alongside
`switchroom-vault-broker` and `switchroom-approval-kernel` in
`~/.switchroom/compose/docker-compose.yml`:

- Image: `ghcr.io/switchroom/switchroom-auth-broker:latest` (or
  built locally via `--build-local`, same pattern as the other
  singletons).
- Runs as root (needs CAP_CHOWN to chown per-agent sockets and
  mirror files to the agent UID).
- `cap_drop: [ALL]`, then `cap_add: [CHOWN, FOWNER, DAC_READ_SEARCH]`
  — the smallest cap set that lets it bind sockets and write mirror
  files into per-agent state dirs.
- `restart: unless-stopped`.
- Healthcheck: bind-presence probe on `/run/switchroom/auth-broker/`
  (same pattern as vault-broker PR #898).

Volumes:
- `~/.switchroom/accounts/` mounted rw — broker is canonical
  writer of `<label>/credentials.json` (it's where refreshes land).
- `~/.switchroom/agents/` mounted rw — broker writes per-agent
  mirror files into `<agentDir>/.claude/.credentials.json`. This is
  intentionally a broad mount (the broker only needs each
  `<agentDir>/.claude/`) — it matches vault-broker's existing
  mount scope, so per-agent introspection commands can reuse the
  same code path. Principle-of-consistency trade. If a future
  PR tightens vault-broker's mount scope, this one follows.
- Named volume `auth-broker-<name>-sock` per agent at
  `/run/switchroom/auth-broker/<name>/` inside the broker AND at
  `/run/switchroom/auth-broker/` inside agent-`<name>`. Same per-agent
  socket model as vault-broker / approval-kernel.
- `~/.switchroom/state/auth-broker/` mounted rw — broker's own
  state (quota tracker, audit log, refresh lease records,
  sha-index).

The broker is implemented in TypeScript, built into a Bun bundle,
COPYed into the image as `/opt/switchroom/auth-broker/index.js`.
Image is `switchroom/base` + the bundle, same shape as vault-broker.

### 4.2 Socket layout

Per-agent UDS sockets at `/run/switchroom/auth-broker/<name>/sock`,
bound by the broker at startup (and re-enumerated when agents are
added/removed via `apply`):

```
host fs:
  ~/.switchroom/state/auth-broker/sockets/<name>/sock  ← named volume
    bound by broker, chowned to per-agent UID, mode 0660

inside broker container:
  /run/switchroom/auth-broker/<name>/sock              ← bind target

inside agent container:
  /run/switchroom/auth-broker/sock                     ← single-agent view
```

**Path-as-identity** is the auth model. The broker parses agent
name from the bind path via `socketPathToAgent()`, never from a
wire payload. The agent's UID can connect (mode 0660); the broker
can read peer credentials via SO_PEERCRED for audit attribution
but does not gate authorization on them (UIDs collide; bind paths
don't). Same threat model as vault-broker — see
`docs/vault-broker.md` § "Path-as-identity".

### 4.3 Wire protocol

NDJSON over UDS, versioned envelope. Identical shape to vault-broker
protocol so future protocol additions reuse the framing primitives.

```jsonc
// request
{ "v": 1, "id": "<uuid>", "op": "<verb>", "args": { … } }

// response — success
{ "v": 1, "id": "<uuid>", "ok": true, "data": { … } }

// response — error
{ "v": 1, "id": "<uuid>", "ok": false, "error": { "code": "<code>", "message": "…" } }
```

**Verbs (v1):**

| op | args | returns | who can call |
|---|---|---|---|
| `get-credentials` | `{}` | `{ account, credentials, expiresAt }` | any agent / consumer |
| `list-state` | `{}` | `{ active, fallback_order, accounts: [{ label, expiresAt, exhausted, exhausted_until }], agents: [{ name, account, override?: string }] }` | any agent / consumer |
| `set-active` | `{ account: string }` | `{ active, fanned: string[] }` | admin only |
| `mark-exhausted` | `{ until?: number }` | `{ account, rolled: string[] }` | any agent / consumer — but only for the *caller's currently active account* (broker derives from path-identity → active-account lookup; argument cannot override) |
| `refresh-account` | `{ account: string }` | `{ account, expiresAt }` | admin only |
| `add-account` | `{ label: string, credentials: object }` | `{ label, expiresAt }` | admin only |
| `rm-account` | `{ label: string }` | `{ label }` | admin only |
| `set-override` | `{ agent: string, account: string \| null }` | `{ agent, account }` | admin only |

**Authorization model:**

The broker derives the caller's identity from the bind-path (peer
agent name or consumer name), looks up that caller's *currently
active account* (`auth.active`, or the per-agent `auth.override`,
or for a consumer the `auth.consumers[].account` binding), and
gates verbs against that:

- `get-credentials` always returns the caller's active account's
  credentials. No argument override — a caller cannot ask for an
  account it isn't on.
- `mark-exhausted` always operates on the caller's active account.
  Argument is `until` only; no `account` argument. This closes the
  abuse path where any agent could spuriously deauth the fleet by
  marking accounts it wasn't using. Spurious-from-real-user case
  (an agent that's actually on account X spamming `mark-exhausted`
  on X) is still possible but bounded — that agent's own account
  is the one it kills, which is self-limiting.
- All `admin only` verbs require one of:
  - Peer UID == 0 (root, i.e. CLI re-execed under sudo via the
    operator path) — host operator.
  - Peer agent listed in `auth.admin_agents: [...]` in
    `switchroom.yaml` (admin-agent capability, intentionally
    introduced *with* the broker).
- Non-admin caller of an admin verb gets
  `{ ok: false, error: { code: "FORBIDDEN", … } }`. Path-identity
  is always logged with the audit line so abuse is greppable.

**Refresh-threshold invariant.** The single-writer guarantee depends
on the broker refreshing tokens *strictly before* claude would. Concrete
values:

- **Broker threshold: 60 minutes remaining.** Keeps the existing
  `REFRESH_THRESHOLD_MS = 60 * 60 * 1000` constant from
  `src/auth/token-refresh.ts:77` and `src/auth/account-refresh.ts:60`;
  the broker imports it from the surviving `account-refresh.ts`
  module.
- **Claude's threshold: ≤5 minutes remaining**, per observed
  behaviour in the claude OAuth client. This is the dependency
  the invariant rests on.

The 55-minute gap is what guarantees no concurrent tmp+rename race
between broker and claude on the same `credentials.json`. Two
deliverables in this PR enforce the invariant:

1. **`docs/auth.md` § "Refresh windows"** — new operator doc that
   pins the broker / claude thresholds with the claude version
   range we tested against. The doc is part of this PR, not a
   follow-up.
2. **Runtime assertion in the broker.** On every refresh tick, the
   broker compares the current credentials' `expiresAt` against
   the *last value it wrote*. If it changed under the broker's
   feet (claude refreshed), the broker logs
   `THRESHOLD_VIOLATION <label> mtime=…` and increments a counter
   surfaced via `list-state.accounts[].threshold_violations`.
   This makes a future claude-narrows-the-window regression visible
   in production, not silent.

If a future claude release narrows its window below 60 min, the
broker threshold must move ahead of it; the assertion catches the
regression on the first refresh after the upgrade.

### 4.4 On-disk state ownership

| Path | Writer | Notes |
|---|---|---|
| `~/.switchroom/accounts/<label>/credentials.json` | broker | OAuth refresh writes here atomically (tmp+rename). |
| `~/.switchroom/accounts/<label>/meta.json` | broker | created/last-refreshed/source label. |
| `~/.switchroom/agents/<name>/.claude/.credentials.json` | broker | per-agent active-account mirror. Atomic write, chowned to agent UID, mode 0600. |
| `~/.switchroom/state/auth-broker/quota.json` | broker | per-account exhaustion state (label → reset-time). |
| `~/.switchroom/state/auth-broker/audit.jsonl` | broker | size-rotated at 10MB → `.1..5`, oldest discarded. |
| `~/.switchroom/state/auth-broker/refresh-lease/<label>` | broker | flock-protected lease file. Cross-container flock via host bind mount — protects against the (theoretical, today single-instance) restart-overlap race and against future multi-broker scenarios. |
| `switchroom.yaml` | CLI | `auth.active`, `auth.fallback_order`, `auth.admin_agents`, `auth.consumers`. Broker reads it on boot + on SIGHUP; CLI writes it. |

**Atomic writes.** Both brokers (vault and auth) want the same
`tmp+fsync+rename` primitive. Today vault-broker has its own copy
inside `src/vault/vault.ts:62` (`atomicWriteFileSync`). This RFC
factors it out into `src/util/atomic.ts` as a side commit (~30
LOC moved, no behaviour change) so both brokers depend on the
same implementation.

**`~/.switchroom/accounts/<label>/credentials.json` ownership.** The
file is created by the operator's CLI invocation of `auth add`
(host-user UID) and *then* written atomically by the broker (root)
on each subsequent refresh — so its on-disk owner flips to root
after the first refresh. The broker chowns to root on first write.
Any host-user CLI code path that previously read this file directly
(e.g., to seed an agent) now goes through `get-credentials` over
the broker UDS — no direct file reads from the CLI. This is the
sole-writer invariant: it costs one indirection in the CLI but
keeps the file's owner stable.

**Drift detection.** The broker computes and stores the sha256 of
every `~/.switchroom/accounts/<label>/credentials.json` it writes,
in `state/auth-broker/sha-index.json`. On boot, it verifies the
on-disk sha matches its index; mismatch is a hard error — broker
logs a `DRIFT_DETECTED <label>` line and exits non-zero. Operator
recovers via `switchroom auth add <label> --replace`, which the
broker accepts as authoritative and re-indexes. This commits the
RFC to "sole-writer" semantics rather than the "polite-mirror"
middle ground the reviewer flagged as worst-of-both-worlds.

**Operator runbook for drift recovery** lives at
`docs/operators/auth-broker-drift.md`, shipped in this PR.
Documents: the error message, the cause patterns (`claude
setup-token` behind the broker, manual file edit, restore from
backup, ownership change), and the `auth add --replace` flow.
Without this runbook the sole-writer-with-hard-error stance fails
the docs test.

**Account-file ownership.** First broker refresh flips
`~/.switchroom/accounts/<label>/credentials.json` from operator-UID
to root (the broker writes atomically as its container user).
After flip, the operator can `ls` and `cat` (file mode 0644 on
the parent dir is preserved; the file itself is 0600) but cannot
`rm` or `mv` without `sudo`. Operator-facing CLI paths that
previously read the file directly are routed through
`get-credentials` over UDS (no sudo). The runbook documents the
flip so operators don't trip over "I owned this file yesterday."

### 4.5 Schema diff

```yaml
# BEFORE (current state) ─────────────────────────────────────────
agents:
  ziggy:
    auth_label: "pixsoul@gmail.com"      # cosmetic, often stale
    auth:
      accounts: [me@kt, pixsoul, ken-outlook]   # primary + fallbacks per agent

# AFTER (this RFC) ───────────────────────────────────────────────
auth:
  active: me@kenthompson.com.au           # fleet-wide active
  fallback_order:                          # cycle order for `auth rotate`
    - me@kenthompson.com.au
    - pixsoul@gmail.com
    - ken.thompson@outlook.com.au
  admin_agents: [clerk]                    # optional — admin verbs allowed
  consumers:                               # optional — non-agent peers (hindsight, etc.)
    - name: hindsight
      account: me@kenthompson.com.au       # consumer's pinned active account
      uid: 11000                           # optional; broker chowns socket to this UID
      # `mark-exhausted` from this consumer only affects this account.
      # `get-credentials` always returns this account's creds.

agents:
  ziggy: {}                                # default: uses fleet active
  klanker:
    auth:
      override: ken.thompson@outlook.com.au   # opt-out (edge case)
```

`auth_label:` is deleted from the schema. `auth.accounts: [...]` is
deleted from per-agent schema. The single-knob default is the
common case; per-agent override is an explicit edge case.

`auth.consumers[]` entries each declare a non-agent peer that can
hold a broker socket. v1 schema is
`{ name: string, account: string, uid?: number }` — `name`
becomes the socket-path identity (binds at
`/run/switchroom/auth-broker/<name>/sock`), `account` is the
consumer's pinned active account, `uid` (optional) is the UID the
broker chowns the socket to (defaults to 0 = root, suitable for
sibling containers running as root; override for non-root
consumers).

Consumers cannot be admins. Enforcement happens in **two places**:
the CLI's `switchroom.yaml` schema validator (`src/config/schema.ts`)
refuses to write a config where any name appears in both
`admin_agents` and `consumers[].name`; the broker re-checks on
boot and refuses to start with a `CONFIG_INVALID` error if the
invariant is violated (defence in depth — operator could edit
the YAML by hand).

### 4.6 CLI surface diff

| Verb | Before | After |
|---|---|---|
| Add account | `auth account add <label> --from-agent <a>` | `auth add <label> --from-agent <a>` (also `--from-oauth` runs full OAuth flow) |
| List accounts | `auth account list` | `auth list` |
| Remove account | `auth account rm <label>` | `auth rm <label>` |
| Set fleet active | `auth promote <label> <a>...` (per-agent) | `auth use <label>` (fleet-wide) |
| Cycle on exhaustion | (manual `auth promote` chain) | `auth rotate` |
| Per-agent override | `auth enable / disable / promote` | `auth agent override <agent> <label>` (hidden) |
| Force refresh tick | `auth refresh-accounts` | `auth refresh [<label>]` (diagnostic) |
| Per-agent OAuth | `auth login <agent>` | **deleted** — account is the unit |
| Status | `auth status` (empty rows) | `auth show [<agent>]` (real state) |
| Heal | `auth heal <a>` | **deleted** (no per-agent slot pool to heal) |

CLI calls hit the broker UDS via a thin client (`src/auth/broker/
client.ts`). No file writes from the CLI for per-agent state.

**`auth show` output format.** Two modes:

```
$ switchroom auth show
ACCOUNT                           STATUS       EXPIRES   QUOTA-RESET
● me@kenthompson.com.au           active       355d 23h  —
✓ pixsoul@gmail.com               available    353d 23h  —
! ken.thompson@outlook.com.au     exhausted    356d 0h   1h 22m

AGENT       ACTIVE                   SOURCE
clerk       me@kenthompson.com.au    fleet-active (admin)
ziggy       me@kenthompson.com.au    fleet-active
klanker     ken.thompson@outlook…    override

CONSUMER    ACTIVE                   STATUS
hindsight   me@kenthompson.com.au    socket bound (last seen 12s ago)
```

```
$ switchroom auth show ziggy
ziggy
  Active account: me@kenthompson.com.au (fleet-active)
  Token expires:  355d 23h (refreshes at 60 min remaining)
  Last refresh:   2026-05-14 13:54:02
  Mirror sha:     ab12cd…  (matches broker index)
  Container:      switchroom-ziggy up 2 minutes
```

**`auth show` and `auth list` are open to any agent.** Per the docs
test: an operator should be able to answer "what's authenticated"
without `--admin`. The CLI builds these views from broker
`list-state` data.

**First-run / setup-wizard.** `switchroom setup` post-RFC: detects
no `auth.accounts` configured, runs OAuth (`auth add default
--from-oauth`), sets `auth.active = default`. The first agent
scaffolded inherits the fleet active by default. Two prompts ("log
in to Anthropic" + "name your first agent"), zero per-agent
`auth:` blocks emitted.

### 4.7 Refresh loop + quota state

Per-account, the broker owns:

1. **Refresh loop.** A scheduled task per account, fires when
   `expiresAt - now < REFRESH_THRESHOLD_MS` (60 minutes — the
   existing constant in `src/auth/account-refresh.ts:60`, imported
   into the broker, *not* changed by this RFC). The broker also
   compares the on-disk `expiresAt` against its own last-write to
   detect a claude-side refresh (the threshold-violation assertion
   from §4.3). Holds an exclusive flock on
   `state/auth-broker/refresh-lease/<label>` for the duration of the
   POST so future multi-broker scenarios cannot race. On success,
   writes `~/.switchroom/accounts/<label>/credentials.json`
   atomically, then walks every agent whose active account == this
   label and re-mirrors their `.claude/credentials.json`.

2. **Quota state.** Per-account in `state/auth-broker/quota.json`:

   ```jsonc
   { "pixsoul@gmail.com": { "exhausted_until": 1809484700000 } }
   ```

   On `mark-exhausted` (called by an agent that got 429), the broker
   sets `exhausted_until` and walks every agent using that account
   to fail them over to their next fallback (per
   `auth.fallback_order`). On reset-time pass, the broker clears
   the mark and rolls agents that *prefer* this account back to
   it on next idle.

3. **Audit.** Every op (read, write, refresh, quota event) writes a
   line to `state/auth-broker/audit.jsonl` with `{ts, op, peer_uid,
   agent, account, ok}`. JSONL because grep is the operator's tool;
   structured because future tooling will want to summarise.

### 4.8 Ephemeral consumers — the hindsight case

A "customer hindsight container" running `claude -p` against a
switchroom-managed Anthropic account is the motivating consumer
outside the agent fleet. The pattern:

1. Operator declares the consumer in `switchroom.yaml`:
   ```yaml
   auth:
     consumers:
       - name: hindsight
         account: me@kenthompson.com.au
   ```
   On next `apply`, broker binds a socket at
   `/run/switchroom/auth-broker/hindsight/sock`, chowned to the
   hindsight container's UID (declared via `consumers[].uid` if
   non-default).
2. Hindsight compose (separate project — `docker-compose -p
   hindsight`) bind-mounts the named volume `auth-broker-hindsight-sock`
   at `/run/switchroom/auth-broker/`.
3. Container calls `get-credentials` on the socket → returns
   the credentials for *its declared account* (cannot ask for
   a different one — peer-identity gating).
4. Container writes `credentials` to a tmpfs path
   `/run/claude-creds/credentials.json`, sets
   `CLAUDE_CONFIG_DIR=/run/claude-creds`, runs `claude -p '…'`.
5. On 429, container calls `mark-exhausted` — broker affects only
   the consumer's bound account (path-identity → consumer →
   bound account; the `account` arg is not honoured). Switchroom
   agents on the same account fail over too (quota state is
   shared at the account level).
6. Refresh attribution is the broker's job — broker owns the
   refresh lease. The refresh-threshold invariant (broker at
   60min, claude at <5min) means the in-container claude never
   fires its own refresh against the same credentials.json file.
   Hindsight re-fetches via `get-credentials` after its tmpfs copy
   ages out.

**Trust model for consumers.** Consumers are first-class peers
with path-identity (same primitive as agents), but they cannot be
admins (rejected at schema validation if added to `admin_agents`).
A consumer's reachable verbs are `get-credentials`, `list-state`,
and `mark-exhausted` — all scoped to its declared account by
broker-side derivation. `set-active`, `add-account`, etc. are
forbidden — admin operations only come from operator-CLI (UID 0
peer) or admin-agent peers.

Cross-host / network-reachable broker (a remote hindsight on a
different host) is **out of scope** for v1 — that's a TLS-fronted
variant with its own trust model. v1 is UDS-only.

## 5. Compose / installer changes

`src/agents/compose.ts:generateCompose()` additions:

- Emit `switchroom-auth-broker` service block (image, volumes, caps,
  healthcheck, restart policy).
- Emit a `auth-broker-<name>-sock` named volume per agent, mount
  into both the broker and agent-`<name>`.
- Add `SWITCHROOM_AUTH_BROKER_SOCKET` env to each agent service
  pointing at `/run/switchroom/auth-broker/sock`.
- For each entry in `auth.consumers`, emit a per-consumer named
  volume and broker mount; consumer service definitions themselves
  live outside `switchroom`'s compose project (e.g. the hindsight
  compose) and bind the named volume by canonical name.
- **`depends_on:` ordering.** Every agent service emits
  `depends_on: switchroom-auth-broker: { condition: service_healthy }`.
  Agents do not start until the broker passes bind-presence
  healthcheck. Same pattern as vault-broker today. Removes the boot
  race window the reviewer flagged.

**Boot-race-with-no-broker fallback.** If the broker is *down at
agent boot* (e.g. crashlooping post-update), the dep-condition holds
the agent in `created` state until the broker recovers. If the
broker *dies after agents are running*, agents continue on their
existing mirrored credentials (Decision 9 of the JTBD doc). The
only window of risk is "broker has never been up + healthcheck
hasn't passed" — `depends_on` handles that.

Tests update at `tests/docker/compose-generator.test.ts` — pin
every emitted field, same pattern as existing broker / kernel
emission tests.

Image build via `npm run build:auth-broker` (new script that bundles
`src/auth/broker/index.ts` to `dist/auth-broker/index.js`), then
`docker/Dockerfile.auth-broker` COPYs the bundle into the image.

## 6. In-place upgrade (no compatibility shims)

Existing on-disk state on a dev host today:
- `~/.switchroom/accounts/<label>/credentials.json` — **preserved**,
  unchanged shape. Broker reads as-is.
- `<agentDir>/.claude/.credentials.json` — **overwritten** on first
  post-merge `switchroom apply` (broker re-mirrors).
- `<agentDir>/.claude/accounts/default/credentials.json` — **deleted**
  by apply (slot pool is gone).
- `<agentDir>/.claude/.oauth-token`, `.oauth-token.meta.json` —
  **deleted** by apply (legacy env-injection mirrors gone).
- `<agentDir>/.claude/active` — **deleted** by apply (slot-name file).

**`switchroom.yaml` upgrade algorithm.** `apply` runs a one-shot
in-place rewrite when it detects the legacy schema. Pseudocode:

```
detect:  any agent has auth.accounts or auth_label in YAML
algorithm:
  primary_counts = histogram of agent.auth.accounts[0] across all agents
  if len(primary_counts) == 1:
    # uniform fleet — safe, fully recoverable
    auth.active = sole primary
    auth.fallback_order = first-seen union of all agents' auth.accounts
    no agents get override:
  else:
    # divergent fleet — primary preference per-agent is lost
    LOUDLY WARN to stderr:
      ⚠ Divergent per-agent auth.accounts[0] detected across N agents.
        Lifting "<most-common>" to fleet-active. The new schema
        loses TWO things from the old per-agent lists:
          1. Per-agent fallback ORDERING (each agent had its own
             priority list — the new schema only supports one
             global fallback_order; first-seen-union order is
             used).
          2. Per-agent fallback TAIL (each agent's accounts[1:]
             list is dropped except for the override target —
             agents with override:X no longer have a documented
             fallback to whatever they used to list after X).
        Agents whose primary differed from the fleet-active have
        been pinned via `override:`.
        Pre-RFC YAML backed up at ~/.switchroom/switchroom.yaml.pre-auth-broker
    auth.active = most-common primary; tiebreak: first-seen order
                  in the YAML file
    auth.fallback_order = first-seen union
    for each agent a where a.auth.accounts[0] != auth.active:
      a.auth.override = a.auth.accounts[0]
  strip every agent's auth_label and auth.accounts fields
  append: # upgraded by auth-broker migration on <date>
  write atomically
```

The pre-upgrade backup at `switchroom.yaml.pre-auth-broker` is
the audit trail. The migration is **destructive of per-agent
fallback ordering** when the fleet was divergent — that data does
not survive because the new schema can't express it. This is the
deliberate cost of the simpler model; the loud warning is the
mitigation. Tested against three fixture shapes (uniform-single,
uniform-multi, divergent) in `migrate-schema.test.ts`.

The implementation is ~120 lines and lives in
`src/auth/migrate-schema.ts`. No CLI verb for it. Re-running
`apply` post-upgrade is a no-op (detection short-circuits).

## 7. Files deleted / changed

### 7.1 Deleted source files

- `src/auth/account-promote.ts` (subsumed by broker `set-active`).
- `src/auth/token-refresh.ts` (per-agent refresh loop — replaced
  by broker's per-account loop).
- `src/auth/account-quota-store.ts` (broker owns the canonical
  quota store at `state/auth-broker/quota.json`).
- `src/cli/auth-accounts-yaml.ts` (per-agent `auth.accounts:` list
  manipulation — no longer a list).
- `telegram-plugin/auth-dashboard.ts` (1,104 lines — the in-place
  promote UI built on top of the old per-agent slot model. Replaced
  by simpler in-chat `/auth use <label>` and `/auth show` commands;
  see §7.3).
- `telegram-plugin/auth-slot-parser.ts` (parses `/auth <verb>` chat
  syntax for the dashboard model — replaced by a tighter parser
  for the three new chat commands inline in `gateway.ts`).
- `src/cli/auth.ts:registerHealCommand` and `auth heal` verb (no
  slot pool to heal).
- The `auth_label` field in `src/config/schema.ts` and its emit
  in scaffold's `greetingCard` (replaced by deriving greeting from
  the broker's `list-state`).

### 7.1a Deleted test files

- `telegram-plugin/tests/auth-dashboard-render.test.ts`
- `telegram-plugin/tests/auth-dashboard-callback.test.ts`
- `telegram-plugin/tests/auth-dashboard-summary.test.ts`
- `telegram-plugin/tests/auth-dashboard-quota.test.ts`
- `telegram-plugin/tests/boot-card-account-quota.test.ts` (boot-card
  account-quota path is rewired through broker `list-state`; new test
  replaces it).
- `telegram-plugin/tests/auth-account-identity-surface.test.ts`
- `tests/auth-token-refresh.test.ts`
- `tests/auth-account-quota-store.test.ts`
- `tests/web-api.account-promote.test.ts` (replaced by
  `tests/web-api.auth-use.test.ts`).
- `tests/auth-account-promote.test.ts`
- `tests/auth-accounts-yaml.test.ts`
- Any test under `telegram-plugin/tests/` matching pattern
  `auth-slot-*.test.ts`.

### 7.2 Modified (not deleted)

- `src/auth/account-refresh.ts` — keeps `refreshAccountIfNeeded`
  (the single-account refresh primitive, broker imports it),
  deletes `fanoutAccountToAgents` / `refreshAllAccounts` /
  `enabledAgentsForAccount` (the loop-and-fanout half moves into
  the broker).
- `src/cli/auth-accounts.ts` — collapsed to thin client-shims
  over broker UDS. The `withConfigError(... fanout ... writeFileSync)`
  paths go away; what remains is "build args, call broker, format
  response."
- `src/cli/auth.ts` — keeps the parent CLI router, rewires
  subcommands. `registerLoginCommand`, `registerReauthCommand`,
  `registerCodeCommand`, `registerCancelCommand` (the per-agent
  OAuth flow) collapse into one new `registerAddCommand` that
  scopes to accounts not agents.
- `src/web/api.ts` — the `/api/auth/promote` endpoint becomes
  `/api/auth/use` and calls the broker over UDS instead of
  `promoteAccountToPrimary` directly. Web dashboard's "promote on
  this agent" UI control retargets to the fleet-wide use button.
  `/api/auth/quota` reads from broker `list-state` instead of
  `readAccountQuota`.
- `telegram-plugin/quota-check.ts` — the per-account quota cache
  shape stays, but the read path swaps from
  `readAccountQuota(label)` to `brokerClient.listState().accounts[label]`.
  The cache itself is fine; only the upstream changes.
- `src/agents/scaffold.ts` — `accounts/<slot>/` directory creation
  removed; greeting-card auth-row rendering reads broker
  `list-state` via `brokerClient` instead of `auth_label`.
- `profiles/_base/start.sh.hbs` — `CLAUDE_CODE_OAUTH_TOKEN` env
  injection block deleted (Decision 5). Per-agent broker socket
  path exported as `SWITCHROOM_AUTH_BROKER_SOCKET`.
- `src/agents/compose.ts` — adds broker service emit + per-agent
  socket volumes + `depends_on` healthcheck wiring.
- `src/setup/wizard.ts` — first-run flow detects no accounts,
  guides through OAuth, sets `auth.active`.

### 7.3 Telegram surface

`auth-dashboard.ts` is replaced — not by a deletion-with-no-
replacement — by three thin chat commands the gateway adds:

- `/auth show` → calls broker `list-state` via gateway IPC,
  renders the same two-table format as the CLI's `auth show`.
  Reachable to any agent's chat (read-only).
- `/auth use <label>` → admin-gated (gateway checks
  `auth.admin_agents`), calls broker `set-active`. Admin agents
  can fleet-swap from Telegram.
- `/auth rotate` → same admin gate, calls broker. Useful one-tap
  failover from any admin chat when a 429 lands.

The complexity of the old dashboard (drift-warnings, slot-state
fixups, per-agent promote with mid-flight YAML editing) is gone
because the *fleet-wide* model has nothing to fix up — there's one
account active and one knob to change it.

**Transitive imports.** The deletion of `auth-dashboard.ts` and
`auth-slot-parser.ts` cascades into three live callsites that need
explicit replacement, not just a "remove the import" pass:

- `telegram-plugin/gateway/boot-card.ts:36-37` — imports
  `AccountSummary` type and `formatAccountQuotaLine` formatter.
  Boot-card auth-row rendering rewires to a new
  `telegram-plugin/gateway/auth-line.ts` (~50 LOC) that takes the
  broker's `list-state` shape and emits the existing one-line
  format. Boot-card visual output is unchanged; only the source of
  truth moves.
- `telegram-plugin/foreman/foreman.ts:55-59` — imports
  `DashboardState`, `DashboardSlot`, `parseAuthSubCommand`. Foreman
  retargets at the simpler broker-derived state model; the slot
  vocabulary disappears in favour of accounts-and-agents.
- `telegram-plugin/gateway/gateway.ts:86-110` — imports the bulk
  of the dashboard surface (`DashboardState`, `DashboardSlot`,
  `SlotHealth`, `AccountSummary`, `AccountHealth`, `isQuotaHot`,
  `isAccountQuotaHot`, `ACCOUNTS_DISPLAY_CAP`, `parseCallbackData`,
  `encodeCallbackData`, `parseAuthSubCommand`). Gateway gets a new
  inline `parseAuthCommand()` (~60 LOC) handling the three verbs;
  the rest of the symbols just stop being imported.

Each rewire is straightforward but visible — the implementer must
*replace* the surface, not just delete the imports and call it
done.

### 7.4 `CLAUDE_CODE_OAUTH_TOKEN` consumers

Three callsites today reference the env var. All three are
deleted in this RFC:
- `src/agents/scaffold.ts` — emits the env injection in start.sh
  (deleted with the rest of the env path).
- `src/agents/handoff-summarizer.ts` — passes the token into the
  summarizer subprocess explicitly via env (deleted; summarizer
  now reads `<agentDir>/.claude/.credentials.json` like every other
  consumer).
- `src/web/webhook-dispatch.ts` — same env pass for the webhook
  worker. Switches to broker `get-credentials` (it's an
  in-container consumer with broker socket access).

### 7.5 Net diff

Net negative — roughly **~2,400 LOC removed in src/ and telegram-plugin/
plus ~2,000 LOC of paired tests removed; ~1,500 LOC added** for the
broker, client, protocol, migrate-schema, and the new test surface.

## 8. Test plan

**Unit (vitest, src/):**

- `src/auth/broker/protocol.test.ts` — envelope encode/decode,
  unknown verb, version mismatch, malformed args.
- `src/auth/broker/server.test.ts` — per-verb behaviour with a
  tmpdir state root, fake-time refresh loop, peercred-mocked admin
  gate, quota fanout assertions.
- `src/auth/broker/client.test.ts` — happy path, server-down
  fallback (read existing creds), error code surfacing.
- `src/auth/migrate-schema.test.ts` — fixture-driven upgrade from
  every shape we have in the wild (single-account fleet,
  multi-account-uniform fleet, multi-account-with-overrides fleet).
- `tests/docker/compose-generator.test.ts` — pin the new
  `switchroom-auth-broker` block + per-agent socket mounts.

**Integration (vitest, tests/docker/):**

- `tests/docker/auth-broker.test.ts` — bring up the broker container
  in isolation (label `switchroom.test=auth-broker-rfc`), connect
  from a host-side client, exercise all v1 verbs end-to-end against
  fixture credentials. `--rm`, per-name teardown in `finally`,
  `safeLabelTeardown` in `afterAll` — same discipline as the existing
  docker tests.
- `tests/docker/auth-broker-fanout.test.ts` — three-agent compose,
  `auth use <label>`, verify each agent's mirror file contains the
  new account's bytes within N seconds; assert atomicity (no
  half-written files mid-read).

**JTBD UAT** (run by hand, documented in the PR description):

The eight UAT prompts in `reference/share-auth-across-the-fleet.md`
§ "UAT prompts" — every one of them executed and notes appended to
the PR.

## 9. Alternatives considered

- **Sudo self-elevation parity for current auth verbs.** Half-day
  unblock, leaves the refresh race, the OAuth fanout bug, the
  no-visibility gap, the env-injection double-mechanism. Throwaway
  work — would be deleted by this RFC. Rejected.
- **Group permissions on per-agent `.claude/` dirs.** Cleaner than
  sudo, would let an "admin agent" write across the fleet. But
  doesn't fix the refresh race or the quota-fanout coordination,
  and the "admin agent" concept is subsumed by the broker's
  `admin_agents:` list in a way that's cleaner. Rejected as a
  stepping stone (the broker design already needs the admin-agent
  notion as a peer-identity check).
- **Stage broker work**: ship broker-with-current-schema first, do
  the schema flip in a follow-up. Rejected because we have no users
  in the wild — the staging cost (legacy schema shapes in the
  broker, doc churn, two CLI surfaces transiently coexisting) buys
  nothing and ships twice the surface.
- **Run the broker as a host-side systemd service, not a
  container.** Rejected per project memory entry "Docker-first
  deployment philosophy" — new long-running components are
  containers; survives switchroom-project recreate by being a
  sibling container, not a different process model.

## 10. Decisions (resolved during review)

1. **`auth.consumers:` ships in v1.** Concrete schema in §4.5;
   trust model in §4.8. Hindsight branch unblocks on this PR.

2. **`auth rotate` mid-turn: swap-mirror-immediately.** Active claude
   process holds the old token in memory until the next subprocess
   spawn or its own next disk-read. Acceptable; matches the
   broker's "I-write-the-file, claude-rereads-eventually" contract.

3. **Telegram-side ships in v1 — three commands** (`/auth show`,
   `/auth use`, `/auth rotate`). The old `auth-dashboard.ts` is
   deleted in the same PR, replaced by these three chat commands
   (§7.3). The UX is simpler than the dashboard *because* the
   fleet-wide model has less state to manage.

4. **Audit log: size-rotation at 10MB.** Five files retained
   (`audit.jsonl`, `.1`, `.2`, `.3`, `.4`, `.5`). Implementation
   is ~30 LOC in `src/auth/broker/audit.ts`. Date-based rotation
   added later if needed.

5. **Drift detection: hard error.** Broker refuses to start if
   sha-index mismatch with on-disk creds. Operator recovers via
   `auth add <label> --replace`. Detailed in §4.4. This commits
   to "sole writer" and gives up the polite-mirror compromise.

## 11. Remaining open questions

None blocking. Two minor items tracked as PR-time decisions:

- Should `--replace` on `auth add` require an interactive
  confirmation, or is the verb name sufficient? Lean: confirmation
  if stdout is a TTY, skip if `--non-interactive`.
- Should the broker expose its quota-cap data (`5h / 7d` windows
  per account, already gathered by `quota-check.ts`) via
  `list-state`, or keep that in the chat-surface layer? Lean: yes
  expose via `list-state.accounts[].quota_5h_pct` etc — JTBD
  *track-plan-quota-live* benefits directly.

## 12. Verdict / next steps

The RFC ships when:
- The four product-principle checks pass:
  - **Docs test**: a new operator can `auth add`, `auth use`,
    `auth rotate`, `auth show` without opening `docs/`.
  - **Defaults test**: `switchroom setup` on a fresh host wires up
    the broker, OAuth's one account, sets it as `auth.active`, and
    the first agent comes up authenticated. Zero per-agent
    `auth:` blocks needed.
  - **Consistency test**: per-agent UDS sockets at
    `/run/switchroom/auth-broker/<name>/sock` is the same shape as
    vault-broker and approval-kernel. CLI verbs follow the
    `switchroom <verb>` cadence. NDJSON-over-UDS protocol matches
    vault-broker framing.
  - **Outcome alignment**: serves "Visibility" (`auth show` is the
    answer to "what's running on what"), "Subscription-honest"
    (OAuth-only, fleet-wide subscription identity), and
    "Multi-agent fleet" (one OAuth flow per account, N agents).
- All eight UAT prompts in `share-auth-across-the-fleet.md` § "UAT
  prompts" pass on a 3-agent / 2-account dev fleet.
- The unit + integration test plan from §8 is implemented and
  green.
- Net diff is meaningfully negative (~2k LOC deleted net) — the
  cleanup is the win, not just the new daemon.

After merge: `feat/hindsight-claude-code` rebases on this and uses
`get-credentials` per Decision 7.
