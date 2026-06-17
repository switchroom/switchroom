# RFC J: Vault-broker resilience & default auto-unlock

Status: Draft v1
Author: Ken (via Claude pair-design)
Date: 2026-05-17

## 1. Summary

The vault-broker is the single decryptor that serves secrets (bot
tokens, OAuth creds) to agent gateways over per-agent UDS sockets.
The 2026-05-17 install-validation re-run surfaced a class of failure
that breaks the product's defining **always-on** outcome
(`reference/vision.md:88` — "Each agent is a long-running service.
They survive reboots, network drops…"):

> A routine `switchroom apply` (e.g. adding an agent) recreates the
> dockerized `switchroom-vault-broker` container. It comes back
> **locked**. Every agent gateway whose `bot_token` is a `vault:`
> ref then crash-loops, the supervisor **permanently gives up after
> 10 restarts in 60 s**, and that bot goes dark until a human
> intervenes — with **no working operator unlock path in the docker
> model**, while `docker compose ps` still reports the broker
> "healthy" and `switchroom vault broker status` reports a *phantom
> host daemon* as `unlocked:true`.

This is not one bug; it is an inverted default plus three latent
correctness gaps. This RFC defines the strategic end state: an
unattended fleet that **self-heals** across broker recreate / host
reboot with **no human in the loop**, and an operator/observability
surface that tells the truth.

## 2. Problem (code-grounded)

### 2.1 The docker-native auto-unlock mechanism already works — it is just never populated

The broker derives a machine-bound AES key from host-mounted
`/etc/machine-id` (HKDF-SHA256, `src/vault/auto-unlock.ts:60-190`)
and at boot calls `_tryAutoUnlockFromMachineBoundFile`
(`src/vault/broker/server.ts:2476`), reading the blob from
`SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH` (compose sets it to
`/state/vault-auto-unlock`, `src/agents/compose.ts:858`). The
"systemd-creds" wording in `vault broker enable-auto-unlock --help`
is **vestigial/incorrect** — the implementation uses machine-id
crypto (`src/cli/vault-broker.ts:404-415` → `encryptCredential` →
`writeAutoUnlockFile`), not systemd-creds (that path is a v0.6
fallback never hit in docker, `server.ts:2531-2550`).

Verified on the VM: `/etc/machine-id` *is* mounted into the broker
container; the broker *does* attempt machine-bound auto-unlock at
boot and logs:

```
[vault-broker] auto-unlock decrypt failed (format): Auto-unlock blob is malformed (wrong length or version).
[vault-broker] staying locked; use `switchroom vault broker unlock` interactively
```

Root cause: **non-interactive `switchroom setup` writes a 0-byte
placeholder `~/.switchroom/vault-auto-unlock` and never populates
it**, and `switchroom vault broker enable-auto-unlock` **aborts
"Empty passphrase"** even when `SWITCHROOM_VAULT_PASSPHRASE` is in
the environment (no non-interactive path). So the always-on install
can *never* establish auto-unlock, and the broker faithfully fails
to decrypt a malformed empty blob on every recreate.

**The default is inverted.** For an unattended 24/7 fleet,
machine-bound auto-unlock is the *correct* posture (the vault is
encrypted at rest; a vault stolen off-host is useless without that
host's machine-id). Interactive passphrase unlock should be the
opt-in *exception* for operators who explicitly want a human in the
loop. Today it is the reverse: manual is the default, auto-unlock is
the skipped optional step.

### 2.2 The gateway↔broker dependency is not resilient

`profiles/_base/start.sh.hbs:41-74` supervises the gateway sidecar
with a hard cap: **10 restarts in 60 s → log "giving up" → `return
1`** (`:68-70`); the sidecar dies and the agent runs with no
Telegram connectivity until the *container* is recreated. There is
**no backoff and no retry-forever path** — a 1 s fixed sleep
(`:72`), then permanent death. A transient dependency outage (broker
recreate, host reboot ordering, momentary lock) is therefore
*terminal*. The only non-give-up branch is `EX_CONFIG=78`
(`:58-60`), used for genuine 401/token-config errors (#1076) — that
quarantine is correct and must be preserved; the bug is that
*transient* unavailability is treated the same as permanent
misconfig.

Agents that resolved their token *before* a broker recreate keep
working on a held long-poll — which **masks** the failure until the
next restart. Nothing should depend on a held long-poll surviving.

### 2.3 #32: two competing brokers; the CLI reports a phantom

`switchroom vault broker {start,stop,status,unlock,lock}`
(`src/cli/vault-broker.ts:193-446`) operate a **host-side** daemon:
`start` (no `--foreground`) detached-spawns a host process
(`:231`), pid at `~/.switchroom/vault-broker.pid` (`:39`); `status`
talks to the legacy host socket. The **agents** talk to the
*containerized* broker via per-agent sockets, and the broker also
binds an operator + unlock socket (`server.ts:577`
`bindOperatorListener`) chowned to the operator uid, bind-mounted to
the host at `~/.switchroom/broker-operator/` (`compose.ts:882`). The
client resolver already knows both shapes and runtime-detects docker
(`src/vault/broker/client.ts:53-88`).

Net: on the VM, `switchroom vault broker status` reported
`{"running":true,"unlocked":true}` (the host daemon I had
started/unlocked) while the *container* broker logged "staying
locked." **The CLI actively misreports the broker the agents
actually use.** The fix is not "make host unlock also reach the
container" (perpetuates two paths) — it is to collapse to one.

### 2.4 Dishonest observability

The broker healthcheck (`src/agents/compose.ts:800`) is
bind-presence only (`ls /run/switchroom/broker/*/sock`) — a
deliberate "we don't speak the app protocol here" choice
(`:782-799`).
Consequence: a **locked** broker reads **healthy**. `BrokerStatus`
already carries `unlocked` (`src/vault/broker/protocol.ts:340-346`)
— the readiness signal exists, the healthcheck just ignores it.
Plus stale strings: the gateway error says `Run: switchroom vault
unlock` (`src/telegram/materialize-bot-token.ts:161`) — that
command does not exist (real: `switchroom vault broker unlock`); and
`vault broker unlock` printed "Timeout waiting for broker" on the VM
*while it actually succeeded*.

## 3. Goals / Non-goals

**Goals**
- A fresh unattended (`--non-interactive`) install survives broker
  recreate, host reboot, and `switchroom apply` with **zero human
  interaction** and **zero data loss**.
- One broker, one set of operator commands, correct under docker
  (and v0.6 host mode during the deprecation window).
- Observability never reports a non-serving broker as healthy.

**Non-goals**
- Changing the at-rest crypto (machine-id HKDF is sound; unchanged).
- Removing interactive-passphrase unlock — it remains, as the
  opt-in higher-assurance mode.
- Multi-host / HA broker. Single-tenant always-on box is the model.

## 4. Design

### Phase 1 — Auto-unlock is the unattended default (root-cause fix)

- `encryptCredential` / `vault broker enable-auto-unlock` gain a
  non-interactive path: when stdin is not a TTY, consume
  `SWITCHROOM_VAULT_PASSPHRASE` (mirrors how `setup
  --non-interactive` and the gateway already source it) instead of
  aborting "Empty passphrase".
- `switchroom setup --non-interactive` stops skipping the
  auto-unlock step when `SWITCHROOM_VAULT_PASSPHRASE` is present:
  it writes a *real* machine-bound blob and flips
  `vault.broker.autoUnlock`. Interactive setup keeps prompting
  (unchanged) but defaults the prompt to "yes (recommended for an
  always-on host)".
- Never write a 0-byte placeholder blob. A malformed blob is
  strictly worse than an absent one (it produces the scary
  "malformed" broker log and obscures the real state). Write the
  real blob or nothing.
- `switchroom apply` gains a post-reconcile invariant: if
  `vault.broker.autoUnlock` is enabled but the blob is
  missing/empty/malformed, surface a single actionable error
  (don't silently leave a fleet that will brick on next recreate).

### Phase 2 — Supervisor resilience (the always-on backbone)

`profiles/_base/start.sh.hbs` supervisor: classify exits.
- `EX_CONFIG=78` (401/token misconfig): keep the immediate
  quarantine + marker (unchanged — genuinely permanent).
- All other non-zero exits (incl. the "vault locked" class):
  **exponential backoff (cap ~60 s) and retry indefinitely**, with
  the attempt count + next-delay surfaced to the supervisor log and
  a one-line breadcrumb the boot card / `/status` can read. No
  permanent give-up for the transient-dependency class.
- The gateway's "vault locked" exit becomes explicitly a *transient*
  class (it self-resolves when the broker unlocks), so an agent
  whose broker comes back (auto-unlock or operator action) recovers
  on its own within one backoff cycle — no container recreate, no
  human.

### Phase 3 — Collapse the broker duality (#32)

- `switchroom vault broker {status,unlock,lock,start,stop}`
  runtime-detect docker mode (same detection used elsewhere:
  `SWITCHROOM_RUNTIME=docker` / compose-project presence) and
  target the **in-container** broker via the operator socket
  (`~/.switchroom/broker-operator/sock`, already bind-mounted). In
  docker mode the host-daemon detached-spawn path is removed; `start`
  becomes a no-op alias that points at the compose-managed
  container.
- Bake the `switchroom` CLI into `docker/Dockerfile.broker` so the
  documented `docker exec switchroom-vault-broker switchroom vault
  broker unlock` fallback actually works (today: "switchroom: not
  found").
- v0.6 host-mode keeps the legacy path during the deprecation
  window; a single resolver decides target by runtime so the
  operator types the *same command* regardless.

### Phase 4 — Honest observability

- Broker healthcheck: probe the real readiness signal (`unlocked &&
  serving`) rather than socket bind-presence. Either an
  unauthenticated `ready` byte on a dedicated probe path, or have
  the healthcheck speak the minimal status frame locally. A locked
  broker MUST read unhealthy so `docker compose ps`, `switchroom
  doctor`, and the dashboard tell the truth.
- Fix `src/telegram/materialize-bot-token.ts:161`: `switchroom
  vault unlock` → `switchroom vault broker unlock`.
- Fix the `vault broker unlock` "Timeout waiting for broker"
  false-negative (it reported failure on success).

## 5. Sequencing & risk

Phase order is by leverage and independence:

1. **Phase 2 first** (supervisor backoff) — highest resilience
   value, fully independent, and it alone converts "permanently
   bricked" into "self-heals when broker returns" even before
   auto-unlock lands. Subtle shell logic → its own PR + fresh
   review + a unit test on the classify/backoff path.
2. **Phase 1** (auto-unlock default) — closes the root cause for
   fresh installs. Security-sensitive default flip → call out the
   threat model in the PR; gated on `SWITCHROOM_VAULT_PASSPHRASE`
   presence so it never weakens an install that didn't opt into
   unattended.
3. **Phase 4** (observability) — cheap, unblocks correct operator
   diagnosis of the other phases.
4. **Phase 3** (#32 collapse) — largest blast radius (CLI + image +
   deprecation); do last, on its own, with the host-mode
   compatibility window explicit.

Risks: (a) auto-unlock default is a security posture change —
mitigated by gating on explicit unattended signal + documenting the
machine-bound threat model; (b) supervisor backoff must not mask a
real permanent misconfig — mitigated by preserving the EX_CONFIG
quarantine and surfacing attempt counts; (c) #32 collapse must not
strand v0.6 installs — mitigated by runtime-detected routing with
the legacy path intact for the deprecation window.

## 6. Definition of done

Re-run the install-validation two-bot matrix on a fresh
`--non-interactive` VM: add an agent via `switchroom apply` (which
recreates the broker), do **nothing else**, and within one backoff
cycle every bot — including the new one — is replying in Telegram.
`docker compose ps` shows the broker unhealthy iff it is actually
locked. `switchroom vault broker status` reports the broker the
agents use. No human typed a passphrase.
