# RFC H: `switchroom-auth-broker` — single-writer OAuth credential plane

Status: Draft v1
Author: Ken (via Claude pair-design)
Date: 2026-05-14

## 1. Summary

A new compose singleton, `switchroom-auth-broker`, that becomes the
**sole writer** of per-agent `<agentDir>/.claude/credentials.json` and
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
   /.claude/credentials.json` (owned by the per-agent UID, mode 0700)
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

- Single writer for `<agentDir>/.claude/credentials.json` is the
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
- Migration tooling. No users in the wild → `switchroom apply`
  on the new binary rips the legacy on-disk state (slot dirs,
  `.oauth-token`, `.oauth-token.meta.json`) and the broker re-mirrors
  from `~/.switchroom/accounts/<label>/credentials.json` (which is
  unchanged in shape).

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
  mirror files into `<agentDir>/.claude/credentials.json`.
- Named volume `auth-broker-<name>-sock` per agent at
  `/run/switchroom/auth-broker/<name>/` inside the broker AND at
  `/run/switchroom/auth-broker/` inside agent-`<name>`. Same per-agent
  socket model as vault-broker / approval-kernel.
- `~/.switchroom/state/auth-broker/` mounted rw — broker's own
  state (quota tracker, audit log, refresh lease records).

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
| `get-credentials` | `{ account?: string }` | `{ account, credentials, expiresAt }` | any agent |
| `list-state` | `{}` | `{ active, fallback_order, accounts: [{ label, expiresAt, exhausted, exhausted_until }], agents: [{ name, account, override?: string }] }` | any agent |
| `set-active` | `{ account: string }` | `{ active, fanned: string[] }` | admin agents only |
| `mark-exhausted` | `{ account: string, until?: number }` | `{ account, rolled: string[] }` | any agent (reactive 429s) |
| `refresh-account` | `{ account: string }` | `{ account, expiresAt }` | admin agents only |
| `add-account` | `{ label: string, credentials: object }` | `{ label, expiresAt }` | admin agents only — CLI-initiated only, gated by peer UID==0 / operator UID |
| `rm-account` | `{ label: string }` | `{ label }` | admin agents only |
| `set-override` | `{ agent: string, account: string \| null }` | `{ agent, account }` | admin agents only |

**Authorization model:**

- `get-credentials` and `mark-exhausted` are open to any agent —
  every agent needs to be able to read its own credentials and
  report quota events. The broker fills in `account` from the
  agent's bind-path identity if not given.
- All other verbs require an *admin* peer. v1 ships with two
  recognised admin identities:
  - Peer UID == 0 (root, i.e. the CLI re-execed under sudo) — host
    operator path.
  - Peer agent listed in `auth.admin_agents: [...]` in
    `switchroom.yaml` — admin-agent capability (intentionally
    introduced *with* the broker, not as a separate prior step).
- A non-admin agent's call to an admin verb returns
  `{ ok: false, error: { code: "FORBIDDEN", … } }`.

### 4.4 On-disk state ownership

| Path | Writer | Notes |
|---|---|---|
| `~/.switchroom/accounts/<label>/credentials.json` | broker | OAuth refresh writes here atomically (tmp+rename). |
| `~/.switchroom/accounts/<label>/meta.json` | broker | created/last-refreshed/source label. |
| `~/.switchroom/agents/<name>/.claude/credentials.json` | broker | per-agent active-account mirror. Atomic write, chowned to agent UID, mode 0600. |
| `~/.switchroom/state/auth-broker/quota.json` | broker | per-account exhaustion state (label → reset-time). |
| `~/.switchroom/state/auth-broker/audit.jsonl` | broker | every op logged with peer UID, agent name, ts. |
| `~/.switchroom/state/auth-broker/refresh-lease/<label>` | broker | flock-protected pidfile to ensure single-refresher. |
| `switchroom.yaml` | CLI | `auth.active`, `auth.fallback_order`, `auth.admin_agents`. Broker reads it, doesn't write it. |

**Atomic writes:** broker uses `tmp+fsync+rename` for every file
write, same primitive vault-broker uses (see `src/vault/atomic.ts`
— pattern is shared, not duplicated).

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

agents:
  ziggy: {}                                # default: uses fleet active
  klanker:
    auth:
      override: ken.thompson@outlook.com.au   # opt-out (edge case)
```

`auth_label:` is deleted from the schema. `auth.accounts: [...]` is
deleted from per-agent schema. The single-knob default is the
common case; per-agent override is an explicit edge case.

### 4.6 CLI surface diff

| Verb | Before | After |
|---|---|---|
| Add account | `auth account add <label> --from-agent <a>` | `auth add <label> --from-agent <a>` |
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

### 4.7 Refresh loop + quota state

Per-account, the broker owns:

1. **Refresh loop.** A scheduled task per account, fires when
   `expiresAt - now < REFRESH_THRESHOLD_MS` (currently 30 min, same
   as `src/auth/token-refresh.ts`). Holds an exclusive flock on
   `state/auth-broker/refresh-lease/<label>` for the duration of the
   POST so concurrent broker restarts cannot race. On success,
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

1. Hindsight container has a bind mount on
   `/run/switchroom/auth-broker/hindsight/sock` (broker binds it at
   apply time if `auth.consumers: [hindsight]` is set in
   `switchroom.yaml`).
2. Container calls `get-credentials` on the socket → returns
   `{ account, credentials, expiresAt }`.
3. Container writes `credentials` to a tmpfs path
   `/run/claude-creds/credentials.json`, sets
   `CLAUDE_CONFIG_DIR=/run/claude-creds`, runs `claude -p '…'`.
4. On 429, container calls `mark-exhausted` so switchroom agents
   on the same account fail over too (quota state is shared).
5. Refresh attribution is the broker's job, not hindsight's — the
   broker owns the refresh lease. Hindsight just re-fetches when
   its tmpfs copy expires.

The `auth.consumers:` schema field is the minimum surface
needed for this to work (broker needs to know which sockets to bind
beyond the per-agent ones). Specific cross-host /
non-switchroom-managed hindsight integration is **out of scope** for
v1 — that's where the network-reachable broker variant lives, and
its trust model is non-trivial.

## 5. Compose / installer changes

`src/agents/compose.ts:generateCompose()` additions:

- Emit `switchroom-auth-broker` service block (image, volumes, caps,
  healthcheck, restart policy).
- Emit a `auth-broker-<name>-sock` named volume per agent, mount
  into both the broker and agent-`<name>`.
- Add `SWITCHROOM_AUTH_BROKER_SOCKET` env to each agent service
  pointing at `/run/switchroom/auth-broker/sock`.
- For each entry in `auth.consumers`, emit a per-consumer named
  volume and broker mount.

Tests update at `tests/docker/compose-generator.test.ts` — pin
every emitted field, same pattern as existing broker / kernel
emission tests.

Image build via `npm run build:auth-broker` (new script that bundles
`src/auth/broker/index.ts` to `dist/auth-broker/index.js`), then
`docker/Dockerfile.auth-broker` COPYs the bundle into the image.

## 6. No migration — clean break

Existing on-disk state on a dev host today:
- `~/.switchroom/accounts/<label>/credentials.json` — **preserved**,
  unchanged shape. Broker reads as-is.
- `<agentDir>/.claude/credentials.json` — **overwritten** on first
  post-merge `switchroom apply` (broker re-mirrors).
- `<agentDir>/.claude/accounts/default/credentials.json` — **deleted**
  by apply (slot pool is gone).
- `<agentDir>/.claude/.oauth-token`, `.oauth-token.meta.json` —
  **deleted** by apply (legacy env-injection mirrors gone).
- `<agentDir>/.claude/active` — **deleted** by apply (slot-name file).
- `switchroom.yaml` — `apply` runs a one-shot in-place rewrite:
  - Lift the most common `auth.accounts[0]` to top-level `auth.active`.
  - Lift the union of unique values across all agents'
    `auth.accounts` lists to `auth.fallback_order` (preserving
    first-seen order).
  - Any agent whose `auth.accounts[0]` ≠ the lifted active gets a
    per-agent `auth.override:` synthesized.
  - `auth_label:` and per-agent `auth.accounts:` are stripped.
  - A `# upgraded by auth-broker migration on <date>` comment
    marker is appended once so the user sees what happened.

This is *not* a migration framework — it's a one-shot in-place
upgrade run from `apply`, idempotent, runs only when the legacy
schema shape is detected. The implementation is ~80 lines and lives
in `src/auth/migrate-schema.ts`. No CLI verb for it. Re-running
`apply` post-upgrade is a no-op.

## 7. Files deleted

- `src/auth/account-promote.ts` (subsumed by `auth use`).
- The fanout half of `src/auth/account-refresh.ts` —
  `fanoutAccountToAgents`, `refreshAllAccounts`, `enabledAgentsForAccount`
  (the refresh-and-fan-out loop moves into the broker;
  the single-account refresh primitive `refreshAccountIfNeeded`
  stays put and gets imported by the broker server).
- `src/auth/token-refresh.ts` (per-agent refresh loop — replaced by
  broker's per-account loop).
- `src/cli/auth-accounts.ts` (most of the verb wiring; what remains
  becomes a thin client-shim over broker UDS).
- `src/cli/auth-accounts-yaml.ts` (per-agent `auth.accounts:` list
  manipulation — no longer a list, no longer per-agent in the
  common case).
- `src/auth/account-quota-store.ts` per-agent quota files (broker
  owns the canonical quota store).
- The `accounts/<slot>/` directory creation in scaffold.ts.
- The `.oauth-token` + `.oauth-token.meta.json` writes in
  `account-refresh.ts` and the env-injection block in
  `profiles/_base/start.sh.hbs`.
- `src/cli/auth.ts:registerHealCommand` (no slot pool to heal).
- The `auth_label` field in `src/config/schema.ts` and its emit
  in scaffold's `greetingCard` (already cosmetic; greeting now
  derives from `auth.active` at render time).

Roughly **~2,000 lines deleted, ~1,500 added** net.

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

## 10. Open questions

1. **Should `auth.consumers:` ship in v1 or v2?**
   Hindsight is the one motivating consumer and its branch is
   parked specifically on this. Shipping the socket-binding surface
   in v1 unblocks that branch immediately; deferring means hindsight
   re-blocks on a v2 PR. I lean v1 (add the schema field, broker
   binds the socket, semantics for non-agent peers are tight: same
   verbs, no admin escalation). But the agent-vs-consumer trust
   delta is real — wants a sentence from Ken in this review.

2. **What does `auth rotate` do mid-turn for an agent currently
   executing?** Options:
   - (a) Swap the mirror file immediately. Active claude process may
     hold the old token in memory for the duration of its current
     request — fine; the swap takes effect on the next subprocess
     spawn or next idle.
   - (b) Wait for in-flight turns to drain, then swap.
   Option (a) is simpler and matches the broker's
   "I-write-the-file, claude-rereads-eventually" contract. Proposed.

3. **Telegram-side: do we expose `/auth use` and `/auth rotate` in
   v1?** The host CLI verbs are mandatory. The Telegram twin is
   reachable today by piggybacking on the existing `spawnSwitchroom
   Detached` shell-out, but it'll be cleaner once RFC C's
   `switchroom-hostd` lands. Proposing v1 ships **CLI-only**; the
   Telegram twins land in a follow-up after hostd Phase 2.

4. **Audit log retention.** Append-only JSONL has no rotation. For
   v1 propose 30-day implicit retention (logrotate-compatible by
   filename), tracked as a follow-up if it becomes an actual
   space problem.

5. **Drift detection on `~/.switchroom/accounts/<label>/credentials.json`.**
   What if a user `claude setup-token`s into a global account file
   directly, behind the broker's back? Vault-broker has a
   drift-detection pattern (`drift-detection.test.ts`). Should we
   port it? I lean *yes* for v1 — the broker should warn on
   mtime/sha drift it didn't cause, even if it doesn't reject the
   foreign bytes.

## 11. Verdict / next steps

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
- Net diff size is roughly what § "Files deleted" predicts (~2k
  deleted, ~1.5k added) — meaningful negative net signals the
  cleanup landed.

After merge: `feat/hindsight-claude-code` rebases on this and uses
`get-credentials` per Decision 7.
