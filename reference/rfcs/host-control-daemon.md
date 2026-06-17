# RFC C: Host-control daemon (`switchroom-hostd`)

Status: Draft v3 (docker-first correction)
Author: Ken (via Claude pair-design)
Date: 2026-05-13

## 1. Summary

A new host-side singleton daemon, `switchroom-hostd`, that exposes a
narrow, audited subset of operator-only verbs (`switchroom apply`,
`switchroom agent restart`, `switchroom update [--check|--apply]`,
`switchroom upgradestatus`) to agent containers via a Unix-domain
socket. Agents reach it through a per-agent socket mount that mirrors
the vault-broker / approval-kernel model: bind-time path-as-identity,
admin-gated verbs, peercred for audit attribution, no wire-payload
identity. The gateway's existing `spawnSwitchroomDetached` shell-out
goes away for the verbs the daemon supports; the docker-availability
guard (#926) is replaced by an unconditional daemon-availability check
that points the operator at `docker compose -p switchroom-hostd ps`
on the unhappy path.

This closes the long-tracked "true self-modification" gap from #1164:
an in-container agent can stage a code change in its own worktree
(`repos:` pattern), open a PR, get review, and then — after merge —
ask the daemon to deploy the change to the running fleet. Today step 4
forces the operator out of Telegram and onto the host shell.

## 2. Motivation

The survey (this session) catalogued **six detached spawns and ~46
synchronous shell-outs** the gateway issues per session, all targeting
`switchroom <verb>`. They divide into three classes:

1. **Read-only**, no host privilege needed (`agent list`, `topics list`,
   `memory search`, `auth list`, `update --check`, `upgradestatus`,
   `issues list`, …). The in-container CLI already handles these fine
   because `SWITCHROOM_CONFIG` is mounted `:ro` and these verbs don't
   touch the running fleet.

2. **Per-agent self-restart** (`/restart`, `/new`, `/reset` → `agent
   restart <self>`). Today: detached spawn via
   `spawnSwitchroomDetached`, restart marker + sweep. The gateway
   runs *inside* the agent container in v0.7+, so the legacy
   cgroup-escape branch in `spawnSwitchroomDetached` (a v0.6 holdover)
   never executes — the detached child is just `spawn(..., {detached:
   true}).unref()` and the agent container's restart policy
   (`--restart unless-stopped` on the compose service) cleans up if
   the parent dies. Workable today but couples agent-restart UX to
   the in-container gateway's process tree and gives the operator no
   single audited surface for fleet-mutation.

3. **Fleet mutation** (`update --apply`, `apply`, `agent restart <other>`,
   `agent start/stop`, future: `vault rotate`, `image refresh`). Needs
   docker reach and write access to `~/.switchroom/compose/`. Today
   `/update apply` is the only one with a docker-availability guard
   (#926); the others would fail opaquely if attempted from inside the
   sandbox.

Class (1) is already handled. The daemon's job is (2) and (3).

Two adjacent forces:

- **`bind_mounts:` (#1166) was scoped at the wrong layer for dogfood.**
  Klanker doesn't need host-source-tree access; `repos:` gives it an
  in-container worktree of switchroom. What klanker still cannot do
  is *deploy* its merged change. That's a host-control problem, not a
  filesystem-reach problem. See §13 for the rectification.

- **The "self-restart from inside" pattern is fragile.** The gateway
  asking docker (via `switchroom agent restart`) to restart its own
  container is a circular dependency — the parent issuing the
  restart is killed by the restart it requested. Today's
  `spawnSwitchroomDetached` + restart-marker dance navigates around
  this, but it ties self-restart UX to the gateway's process tree.
  Moving the verb out of the agent container entirely (to a
  separately-supervised daemon) breaks the cycle: the agent asks the
  daemon, the daemon talks to docker, the agent gets recreated, the
  daemon survives.

## 3. Goals and non-goals

**Goals**:

- Move per-agent self-restart and fleet-mutation verbs off the
  `spawnSwitchroomDetached` path and onto a daemon RPC.
- Make the operator's "happy path" for code self-modification fully
  in-Telegram: agent opens PR → reviewer approves → operator (or
  admin agent) taps `/update apply` → daemon runs the deploy →
  card edits to reflect new fleet state.
- Re-use the broker/kernel trust model verbatim: bind-time
  path-as-identity, admin-gating in server config, peercred for
  audit, no wire identity claim.
- Audit every verb invocation to `~/.switchroom/host-control-audit.log`,
  same NDJSON shape as `vault-audit.log`.

**Non-goals**:

- Replacing the *read-only* verbs (class 1). They work today via
  `/state/config/switchroom.yaml:ro` + `SWITCHROOM_CONFIG`.
- Granting non-admin agents any host-control capability. The trust
  posture is identical to admin-gated vault grant-management: if you
  trusted the agent enough to set `admin: true`, this is the next
  privilege; if not, it gets nothing.
- Wire compatibility with the broker. Daemons share a wire *shape*
  (NDJSON, framed) but the protocol vocabularies are distinct;
  callers route by socket path.
- Becoming a generic RPC shim. The verb set is closed and
  enumerated. Operators who want a new verb file an RFC.

## 4. Threat model

Same baseline as the broker (`docs/vault.md:227`): ACL is
misconfiguration protection, not a security boundary. Same-UID
compromise of the host operator is game-over. The daemon defends
against:

- A non-admin agent accidentally invoking a fleet-mutating verb.
- A misconfigured agent attempting to restart another agent without
  the operator's intent.
- Replay of stale verb invocations across a daemon restart.
- An attacker on the network reaching the daemon (it doesn't listen
  on the network; UDS-only).

It does **not** defend against:

- The host operator being compromised. The daemon runs as the
  operator and inherits whatever they can do.
- A compromised admin agent. By policy `admin: true` is a trust
  declaration: if the agent is compromised, the operator's recovery
  path is `switchroom vault lock` + `docker compose down` from the
  host, same as today. The daemon doesn't expand or shrink that
  recovery posture.

## 5. Design

### 5.1 Process model

`switchroom-hostd` is a **Bun-runnable Node module** at
`src/host-control/main.ts`, bundled to `dist/host-control/main.js`,
and packaged as a docker image (`docker/Dockerfile.hostd`) for
distribution alongside the existing `switchroom-broker`,
`switchroom-kernel`, and `switchroom-agent` images.

**Deployment shape: host-side docker container, outside the
switchroom compose project.** Matches the v0.7+ docker-first
ethos — every other component (broker, kernel, agent) is a docker
container; the daemon follows suit. The container runs with
`network_mode: host` (so its UDS paths land on the operator's
filesystem at `~/.switchroom/hostd/`), `--restart unless-stopped`,
and the docker socket bind-mounted in. Operators bring it up
either via a one-line `docker run` or a sibling
`~/.switchroom/hostd/docker-compose.yml` file — **a separate
compose project** from `switchroom` itself.

**Why a separate compose project, not a sibling service in the
main compose file.** If the daemon were part of the switchroom
compose project, then `update_apply` → `docker compose up -d
--remove-orphans` would recreate the daemon mid-flight and kill
the in-progress update. By running it under its own project name
(`switchroom-hostd`), the main project's `compose up` /
`compose down` cycle cannot touch it. The daemon outlives the
fleet it controls.

**On the `sudo` argument that gated v2.** An earlier draft cited
"`switchroom apply` self-elevates via `sudo` and there is no
host `sudo` inside a container" as a second blocker for any
in-container deployment. That argument doesn't survive the
docker-first v0.7+ design: `apply`'s privilege need is to chown
per-agent state dirs and bind the broker socket across UIDs,
both of which are container capabilities (`CAP_CHOWN`,
`CAP_FOWNER`, `CAP_DAC_OVERRIDE`) rather than host-`sudo` calls.
The daemon container declares those caps explicitly (see the
`cap_add` block below); no `sudo` round-trip required.

**Same release surface as everything else.** The daemon ships
from `ghcr.io/switchroom/switchroom-hostd:<tag>`, pulled on
`switchroom update` like the other images. Operators don't manage
yet-another-supervisor system — they `docker pull`, `docker run`,
`docker logs`, `docker stop`. No systemd dependency. No Linux-
specific deployment paths. Works on macOS dev hosts the same way
it works on production Linux. `switchroom hostd install` (Phase
1.5) writes the sibling compose file or prints the equivalent
`docker run` command.

**Container capabilities + mounts.**

```yaml
# ~/.switchroom/hostd/docker-compose.yml (separate project)
name: switchroom-hostd
services:
  hostd:
    image: ghcr.io/switchroom/switchroom-hostd:${TAG:-latest}
    container_name: switchroom-hostd
    restart: unless-stopped
    user: "${OPERATOR_UID}:${OPERATOR_GID}"
    cap_add: [CHOWN, FOWNER, DAC_OVERRIDE]   # chown per-agent sockets
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock     # to drive compose
      - ${HOME}/.switchroom:${HOME}/.switchroom        # state + sockets
      - ${HOME}/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro
    environment:
      SWITCHROOM_CONFIG: /state/config/switchroom.yaml
    healthcheck:
      test: ["CMD-SHELL", "ls ${HOME}/.switchroom/hostd/*/sock 2>/dev/null | head -1 | grep -q ."]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

Notes on the compose shape:

- **No `network_mode: host`.** The daemon's only ingress is the
  per-agent UDS, which is a filesystem object (bind-mounted from
  `~/.switchroom/hostd/<agent>/`). Host networking would buy
  nothing and is correctly omitted.
- **`${HOME}` works because compose interpolates env vars when
  the operator runs `docker compose up`.** The equivalent
  `docker run` one-liner the install verb prints uses a shell-
  expanded path (`$HOME` outside quotes) so it works without
  compose's env interpolation. Both forms land at the same
  absolute path.

The daemon shells out to a `switchroom` CLI invocation inside its
own container — the image bakes in the same bundle as the agent
images (`/opt/switchroom/switchroom.js`). Mounting the docker
socket lets the in-container CLI's `apply` / `update` paths reach
the host's docker daemon. `--restart unless-stopped` means a daemon
crash is auto-recovered without operator intervention.

### 5.2 Socket layout (mirrors broker)

```
/run/switchroom/hostd/
  <agent-A>/sock      mode 0660, owner agent-A UID
  <agent-B>/sock      mode 0660, owner agent-B UID
  operator/sock       mode 0600, owner operator UID
```

Same path-as-identity contract as the broker:
`socketPathToIdentity()` parses the bound listen-path, returns
`{kind: "agent", name}` or `{kind: "operator"}`. Reserved name
`"operator"` enforced via `RESERVED_AGENT_NAMES` (already extant in
`src/vault/broker/peercred.ts:84`; extend that set or add a
host-control-local copy).

**Host vs container paths.** Two viewpoints, the same socket file:

- **Host side** (where the daemon binds): `~/.switchroom/hostd/<name>/sock`,
  parent dir mode 0700 owned by operator UID; socket mode 0660 owned
  by the agent UID.
- **Agent-container side** (what the in-container client opens):
  `/run/switchroom/hostd/<name>/sock`, the canonical in-container
  path mirroring the broker's `/run/switchroom/broker/<name>/sock`
  shape.

A compose-emitted bind mount couples the two: `~/.switchroom/hostd/<name>/`
on the host → `/run/switchroom/hostd/<name>/` inside the agent.
Path-as-identity parsing happens on the daemon's bind path
(host-side), so an agent cannot forge identity by renaming its
in-container view. Mirrors the broker pattern at
`src/agents/compose.ts:742-743`.

### 5.3 Wire protocol

NDJSON, max 64 KiB per frame, same framer as `src/vault/broker/protocol.ts`.

```jsonc
// request
{
  "op": "agent_restart",          // verb
  "args": { "name": "klanker", "reason": "user-requested via /restart" },
  "request_id": "f7…",            // client-generated; daemon echoes in response
  "idempotency_key": "f7…-1"      // optional; daemon dedupes within 60s
}

// response — single frame, then connection closes
{
  "request_id": "f7…",
  "result": "started",            // "started" | "completed" | "denied" | "error"
  "exit_code": 0,
  "stdout_tail": "…",             // last 4 KiB; for ack/error UI
  "stderr_tail": "…",
  "duration_ms": 320,
  "audit_id": "2026-05-13T01:23:45.123Z#hostd"
}
```

Verb set (v1, closed):

| Verb | Args | Effect | Trust |
|---|---|---|---|
| `agent_restart` | `name`, `reason`, `force?` | runs `switchroom agent restart <name> [--force]` on host | self → any agent; cross-agent → admin |
| `agent_start` | `name` | `switchroom agent start <name>` | admin |
| `agent_stop` | `name` | `switchroom agent stop <name>` | admin |
| `update_check` | (none) | `switchroom update --check`, returns plan | admin |
| `update_apply` | `skip_images?`, `rebuild?` | `switchroom update --apply [flags]` | admin + operator-attest (see §5.4) |
| `apply` | `non_interactive: true` (forced) | `switchroom apply --non-interactive` | admin + operator-attest |
| `upgrade_status` | (none) | `switchroom update --status` | any |
| `reconcile` | `agent?` | `switchroom reconcile [<agent>]` | admin |
| `get_status` | `request_id` | look up an in-flight or recently-completed mutation by id; returns the same response shape as the original call | matches the gate of the *original* call |

Anything not in this table is rejected with `result: "denied",
error: "verb not in v1 allowlist"`. New verbs land via RFC + table
addition.

**`get_status` in v1, not streamed progress.** Reviewer-flagged
(load-bearing): the long-running verbs (`update_apply` at 20–60s,
`apply` at 5–20s) return `result: "started"` within ~50ms, then run
detached. Without a query mechanism, the gateway can't tell whether a
verb succeeded, failed fast, or is still running — a regression
versus today's `notifyDetachedFailure` (`gateway.ts:7776`) which
catches non-zero exits within ~5s. `get_status` closes the gap:
gateway polls every ~2s for `started`-result verbs, drives the
progress card UI from the response. Cheaper to implement than
streamed-progress frames and lower protocol-complexity. Streamed
frames may still land in v2 if poll-driven UX proves choppy.

### 5.4 Auth model

Three layers, layered fail-closed:

1. **Path-as-identity** (always). Agent identity comes from the bind
   path. Operator socket is mode-0600 + UID-checked.
2. **Verb-allowlist** (always). The verb must be in the v1 table.
3. **Per-verb gate** (per row). Three gate types:
   - **`any`** — no extra check. (Only `upgrade_status` today: it's
     read-only and already exposed to non-admin agents via the
     gateway's `/upgradestatus` handler.)
   - **`admin`** — `config.agents[name].admin === true`. Reuses the
     broker's `isAdminAgent` check (`src/vault/broker/server.ts:1613-1615`).
   - **`admin + operator-attest`** — admin AND the request carries
     a valid operator-passphrase attestation. Reuses the broker's
     existing plaintext-forward pattern verbatim (see the
     "Attestation" paragraph immediately below, and
     `src/vault/broker/server.ts:1668` for the existing reference
     implementation). No new RPCs are added to the broker for the
     daemon's needs.

For `agent_restart` self-targeting (`args.name === caller.identity.name`),
the gate downgrades to `any` — matches the gateway's current behavior
(`/restart` self-targeting works without admin).

The daemon never has the vault passphrase. Attestation reuses the
existing **gateway → broker plaintext-forward** pattern (see
`src/vault/broker/server.ts:1668`, the `vault_request_save` path):
the gateway already caches the operator passphrase after `/vault
unlock` and forwards it on the wire when an admin agent invokes a
privileged verb. The daemon does the same forward over its own
admin-client connection to the broker (mounted at
`/run/switchroom/broker/hostd/sock`). Wrong passphrase → explicit
`DENIED` audit row, exactly mirroring the broker's existing mismatch
path at `server.ts:1668-1695`. No new broker RPCs are added; no
passphrase fingerprint is introduced (an earlier draft sketched a
`status`-op fingerprint, but it would have widened the broker's
same-UID attack surface to offline guessing — struck in favour of
plaintext-forward).

**Trust-loop sanity.** A compromised in-container actor that can
already drive the broker via the agent's vault-request flow can
already attest if `/vault unlock` was recent — that's the existing
envelope, not new surface. The daemon does not enlarge it: it just
exposes a *different* operation set behind the same gate. Recovery
posture (`switchroom vault lock` from the host) is unchanged.

To prevent a name-collision footgun, `hostd` is added to
`RESERVED_AGENT_NAMES` in `src/vault/broker/peercred.ts:84` so an
operator cannot name an agent `hostd` and clash with the daemon's
broker-client socket path.

### 5.5 Audit

Every accepted or denied request appends one NDJSON row to
`~/.switchroom/host-control-audit.log`, sample:

```jsonc
{
  "ts": "2026-05-13T01:23:45.123Z",
  "op": "update_apply",
  "caller": {"kind": "agent", "name": "klanker"},
  "peer_uid": 10042,
  "peer_cgroup": "switchroom-klanker.service",
  "args": {"skip_images": false, "rebuild": false},
  "result": "completed",
  "exit_code": 0,
  "duration_ms": 18420,
  "request_id": "f7…",
  "method": "passphrase-attest"
}
```

Tail consumable by `switchroom audit hostd` (new verb) and by the
admin agents' `/audit hostd` Telegram command (mirrors `/vault audit`).

Log rotation inherits `vault-audit.log`'s policy verbatim
(`logrotate.d/switchroom-vault-audit` per `docs/vault-broker.md` —
size-trigger rotation, retain N generations). The setup helper
installs an analogous `logrotate.d/switchroom-host-control-audit`
fragment.

### 5.6 Gateway integration

The gateway grows one new module
(`telegram-plugin/gateway/host-control-client.ts`) that exposes:

```ts
export async function hostd<T>(op: HostdVerb, args: HostdArgs[op]): Promise<HostdResponse<T>>
```

The six detached spawns (`spawnSwitchroomDetached` callsites for
`agent restart`, `update apply`, `apply`, etc., per the survey) get
replaced with `await hostd("agent_restart", {...})`. The function is
async-but-fast: the daemon returns "started" within ~50ms for
long-running verbs, then the gateway's existing restart-marker /
greeting-card plumbing takes over.

The `isDockerReachable()` guard is replaced by `isHostdReachable()`:
probe `/run/switchroom/hostd/<self>/sock` for socket-presence. On
miss, the error message points operators at
`docker compose -p switchroom-hostd ps` and
`docker logs switchroom-hostd` instead of "use the host shell".

## 6. Compose / installer changes

Two compose surfaces are touched: the existing switchroom compose
project (per-agent socket bind mounts on admin agents) and a new
sibling project (the daemon itself).

**Existing switchroom compose (`src/agents/compose.ts`):**

- Per-agent host-path bind mount on admin agents:
  `~/.switchroom/hostd/<name>/` (host) → `/run/switchroom/hostd/<name>/`
  (agent container). Gated on `host_control.enabled` AND the host
  directory existing (same `existsSync` guard pattern as the
  vault-audit.log mount — docker compose `up` hard-fails on a
  missing bind source).
- Both ends of the bind are on the host filesystem; no named volume
  is needed (the daemon container also bind-mounts the same host
  path, so they share the file directly).
- No compose service for the daemon itself in the switchroom
  project — see §5.1 for why (would get recreated on
  `update_apply`).

**New sibling project (`~/.switchroom/hostd/docker-compose.yml`):**

- Single service: `switchroom-hostd` per §5.1. Separate project
  name (`name: switchroom-hostd`) so the switchroom project's
  recreate cycle can never touch it.
- The daemon's container declares `cap_add: [CHOWN, FOWNER,
  DAC_OVERRIDE]` so it can bind and chown the per-agent sockets
  across UIDs — mirrors the broker's caps declared at
  `src/agents/compose.ts:549-552`.
- Healthcheck: same socket-presence shape the broker and kernel
  use today.

**New `docker/Dockerfile.hostd`:**

- Same base image and bun runtime as the broker/kernel.
- `COPY dist/host-control/main.js /opt/switchroom/host-control/main.js`.
- Bakes the same switchroom CLI bundle at
  `/opt/switchroom/switchroom.js` (the daemon shells out to it for
  every verb), with the CLI symlinked onto PATH.
- `CMD ["bun", "run", "/opt/switchroom/host-control/main.js"]`.

**`switchroom setup`** grows a one-shot step that drops the sibling
compose file at `~/.switchroom/hostd/docker-compose.yml` and prints
the `docker compose -p switchroom-hostd up -d` command. Idempotent;
safe to re-run. Works identically on Linux and macOS — no
host-specific install path.

## 7. Migration / cutover

Phased, behind `host_control.enabled` config flag (default
**false** for v1 to keep existing installs unchanged):

1. **Phase 1** (this RFC, opt-in). Daemon ships. Behaviour is
   determined **strictly** by `host_control.enabled`:
   - **`enabled: true`** → all supported verbs go through the
     daemon. **No silent fallback.** If the daemon is unreachable
     the call returns a clean operator-visible error
     ("`switchroom-hostd` unreachable; check `docker compose -p
     switchroom-hostd ps`"). This preserves the §5.5 audit
     guarantee — every privileged call lands in the daemon's audit
     log or fails loudly, never quietly routes around it.
   - **`enabled: false`** (default) → gateway uses the existing
     `spawnSwitchroomDetached` path unchanged. The two code paths
     are *configuration-toggled*, not *fallback-chained*. This
     keeps the detached-spawn path exercised in CI (the default)
     while opt-in operators get the daemon's stronger audit
     posture.

   Reviewer-flagged (load-bearing): an earlier draft proposed
   "prefer daemon, fall back to spawn on socket-miss." Struck —
   silent fallback means a flaky daemon would route privileged
   calls through the un-audited path that §5.5 promises is gone,
   and the audit log would have invisible gaps. Hard fail is the
   right shape.

2. **Phase 2** (v0.9, default-on). Flip the default to `enabled:
   true`. `spawnSwitchroomDetached` is still selectable but
   emits a deprecation warning on every invocation. Operators
   who don't want the daemon explicitly opt out.

3. **Phase 3** (v0.10, removal). Detached-spawn code path
   removed. `host_control.enabled: false` becomes a setup-time
   hard error pointing at the upgrade docs.

Rollback at any phase: set `host_control.enabled: false` and
restart. The detached-spawn path is preserved through phase 2; only
phase 3 makes downgrade harder.

## 8. Alternatives considered

- **Docker socket into admin agents.** Rejected: explicitly
  denylisted in `BIND_MOUNT_EXACT_DENY` (#1166); the daemon centralizes
  the same capability behind audit and verb allowlist instead.
- **SSH-back-to-host.** Adds a key-management surface, a network
  hop, and an SSH daemon dependency. Doesn't mesh with the
  bind-time identity contract (SSH gives wire-payload identity:
  the agent could claim any user).
- **Extend the broker to host verbs.** Tempting (one daemon, one
  socket). Rejected: the broker's threat model assumes it speaks
  vault secrets; mixing host-mutation verbs into the same process
  expands the blast radius of a broker bug and conflates two
  audit streams. Two daemons, two audits.
- **Host-shell-on-rails (no daemon, just a wrapper).** Doesn't
  solve the cgroup-escape problem; doesn't audit; doesn't gate.
- **Sub-process-only (no socket; agents `docker exec` into a host
  helper).** Requires docker socket in agents; same denylist
  problem as bullet 1.

## 9. Open questions

1. **Daemon binary distribution.** Bundled into the existing
   switchroom CLI (one binary, multiple entrypoints) or a separate
   `switchroom-hostd` binary? Leaning bundled — same release
   surface, same version pin, same telemetry — but the survey
   shows the broker and kernel are separate entrypoints. Match
   that pattern or break it?

2. **Long-running verb feedback.** `update_apply` takes 20-60s.
   Single-frame response means the gateway sits and waits. Should
   the wire protocol grow streamed-progress frames (one per stage:
   `pulling`, `recreating`, `health-checking`, `done`) so the
   gateway can edit the progress card in real time? Probably yes,
   but adds protocol complexity — defer to v2 unless the UX is
   visibly bad in v1 testing.

3. **Idempotency window.** Tied to the gateway's existing
   restart-marker debounce at `gateway.ts:7836` / `:7976` — currently
   15s. The daemon's `idempotency_key` cache uses the **same** 15s
   value so a double-tap that gets debounced at the gateway layer
   doesn't slip through to the daemon and vice versa. If the gateway
   debounce gets tuned, the daemon constant follows. (Earlier draft
   said 60s — struck; layer-divergence was the reviewer's
   correction.)

4. **Operator-attest cache.** The broker caches the operator
   passphrase after `/vault unlock`. Does the daemon get its own
   cache, or does every privileged verb re-attest through the
   broker? Re-attest is simpler and more auditable; daemon caching
   is faster. Lean re-attest; revisit if latency hurts.

5. **Multi-host fleets.** Out of scope today (switchroom is
   single-host). If switchroom ever fans out to multiple hosts,
   the daemon's "operator UID" assumption breaks. Note for the
   future, don't design for it now.

## 10. Verdict / next steps

Already landed in #1175 (Phase 1 — library + opt-in flag + per-agent
compose bind mounts):

1. ✅ `src/host-control/{protocol,peercred,server,client,main}.ts`
2. ✅ Per-agent host-path bind mounts on admin agents behind
   `host_control.enabled`
3. ✅ Schema field `host_control.enabled`
4. ✅ Tests (protocol round-trip, peercred path-as-identity, verb
   gates, get_status visibility, idempotency, DoS cap, audit log)

**Remaining work to make the daemon actually deployable:**

1. ✅ **Phase 1.5 — packaging** (#1202). `docker/Dockerfile.hostd`,
   `scripts/build.mjs` bundle target, GHCR workflow entry,
   `~/.switchroom/hostd/docker-compose.yml` template via the new
   `switchroom hostd {install,status,uninstall}` verb. Published
   at `ghcr.io/switchroom/switchroom-hostd:<tag>`. Hotfixed for
   `withConfigError` HOF misuse + symlinked-config bind (#1203)
   and bun-vs-node CLI shim (#1204). Integration tests added
   in #1207.
2. ✅ **Phase 2 verbs in daemon** (this PR). The five deferred verbs
   are now implemented in `protocol.ts` + `server.ts`:
   - `update_check` — read-only `switchroom update --check` proxy.
     Any caller (admin or not). Synchronous response.
   - `update_apply` — `switchroom update`. Admin only. Async
     fire-and-forget pattern (started → get_status). Gated by the
     new fleet-mutation lock (mutually exclusive with `apply`).
   - `apply` — `switchroom apply --non-interactive`. Same shape
     as `update_apply` (admin-only, async, fleet-lock-gated).
   - `agent_start` / `agent_stop` — per-agent verbs. Self-target
     always allowed; cross-agent requires admin. Synchronous.
     NOT gated by the fleet-mutation lock (per-service docker
     compose ops can safely race across agents).
   `reconcile` was dropped from the original list — there's no
   underlying `switchroom reconcile` CLI verb; `apply` covers the
   same intent.
3. **Phase 2 gateway swap** (separate PR, deferred). Replace the
   `spawnSwitchroomDetached` callsites in `telegram-plugin/gateway/`
   with `await hostd(verb, …)` calls, gated on `host_control.enabled`
   + `isHostdReachable(agentName)`. Fail-back to detached spawn when
   the daemon is unreachable. Per-callsite refactor (~7-10 sites);
   benefits from the audit trail + idempotency + fleet-mutation lock
   the daemon now provides. `update_apply`/`apply` from the
   Telegram surface starts working on docker hosts (closes the
   #926 docker-availability guard's apologetic-error path).
4. **Phase 2.5 — Telegram surface.** `switchroom audit hostd` verb
   + `/audit hostd` admin command.
5. **Phase 3 — legacy removal.** Once the daemon is the default,
   delete the legacy `triggerSelfRestart()` v0.6 systemctl path
   and the `resolveSystemdRunPath()` cgroup-escape branch in
   `spawnSwitchroomDetached`. Both are dead-code-inside-docker
   today (the docker branch is taken first and `systemd-run` is
   absent in containers), but they're still callable on v0.6
   installs — removal lands when those are no longer supported.

Effort estimate: **~120 agent minutes** for Phase 1.5 (Dockerfile +
image build + compose template + install verb + tests). **~180–240
agent minutes** for Phase 2 (gateway swap + remaining verbs +
broker-attestation client). **~30 agent minutes** for Phase 2.5
(audit surface). Streamed-progress frames remain a possible Phase 4
follow-up if `get_status` polling proves choppy.

### 10.1 Proposed Phase 3 verb — `run_tests`

Discovered during the klanker Bash-wedge RCA (PR #1186, PR #1188). The
agent-side prevention path for the persistent-shell wedge is "don't
run heavy test suites in the agent's own session." The cleanest
implementation of that prevention: a hostd verb that spawns `npm test`
on the host, in the agent's worktree, with output streamed back.

**Shape** (sketch; refine when implementing):

```
{
  op: "run_tests",
  args: {
    worktree: "/state/agent/home/<repo>",          // bind-mount accessible to host
    command: "npm test" | ["bun", "run", "test"], // explicit, no shell metachars
    env_strip: ["SWITCHROOM_RUNTIME", ...],        // optional; defaults to compose's injected set
    timeout_ms: 600_000,                            // default 10min, cap 30min
  }
}
```

**Response** (sketch):

Same `started` / `get_status` polling pattern as `agent_restart`. The
daemon spawns a host-side child, captures stdout/stderr to a per-
request file under `~/.switchroom/audit/hostd/<request_id>.log`,
sets `state: "running"` immediately, and updates to `done` with
`exit_code` when the child exits. The agent client polls or
opens a streaming `tail_status` (Phase 4) for live output.

**Trust posture.** `run_tests` is the first verb that executes
arbitrary code from the agent's worktree. Two posture constraints:

1. **Path canonicalization.** `worktree` must canonicalize under
   `~/.switchroom/agents/<agent>/home/**` — same containment check
   the bind_mounts primitive (#1166) uses. Refuse anything outside.
2. **Command allowlist.** Either a fixed string like `npm test` or
   `bun run test`, or an explicit array; no shell expansion. The
   agent can't ask hostd to run arbitrary commands — only registered
   test entrypoints. Future verbs (`run_build`, `run_lint`) would
   sit alongside with the same shape.

**Why not run as a Bash sub-agent inside the agent container?**
That works for prevention (the brief's recommendation today) but it
doesn't help when the test suite needs > 5GB of memory (six agents
× 6GB cgroups = 36GB, tight on a 60GB host; the test runners can
exceed that). Running on the host directly avoids the cgroup
constraint and the wedge surface entirely.

**Effort estimate: ~180 agent minutes** for the verb itself
(protocol schema + server handler + client method + tests),
plus ~60 agent minutes to wire the agent gateway into using it
optimistically (with sub-agent fallback). **~240 agent minutes
total.** Tracks as a Phase 3 follow-up; deferred until Phase 2
lands.

## 11. Relation to #1166 (bind_mounts)

See §13 below for the rectification. Short version: bind_mounts
stays as a *general* primitive (shared collab dirs, RW config-edit
case) but the dogfood framing in `docs/configuration.md` is wrong
and gets rewritten to point at `repos:` + this daemon. Keep, don't
revert.
