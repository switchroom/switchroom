---
title: One container per agent + docker compose
status: Draft
audience: switchroom maintainers, anyone considering picking this up
related: #793 (parent epic), #788, #776 (status-card RCAs that the per-agent process model touches), #786 (PreToolUse labels — must keep working), #725 (tmux supervision — load-bearing under this design)
source: research output for issue #793, "Option 3" of the comparison
---

# RFC: one container per agent, docker compose for the fleet

## Status (post-v0.6)

- **Phase 0** (peercred spike) — shipped (#801).
- **Phase 1** (compose generator + per-agent containers) — shipped (#802, #804, #807).
- **Phase 2** (broker IPC port + approval kernel IPC port + integration suite) — shipped (#813, #814, #815).
- **Phase 3a** (entry-guard hardening + HARD RULES + `_prod-snapshot.ts` helper) — shipped (#816, #817).
- **Phase 3c** (CI snapshot gate + real `switchroom add agent` codepath in race test + newbie-readiness split) — shipped (#824).
- **Phase 3d** (Linux-only declaration) — shipped via PR #825.
- **Phase 3a-3** (GHCR publishing workflow + compose digest-pin mode) — REMOVED in PR #825.
- **Phase 3b-1** (Docker fleet watchdog port) — DEFERRED indefinitely. `bin/bridge-watchdog.sh` continues to supervise the legacy systemd path; Docker fleets self-restart via compose `restart: unless-stopped`.
- **Phase 3b-2** (`switchroom migrate to-docker/to-host` CLI) — REMOVED in PR #825. Single-host personal tool doesn't need an in-place migration mechanism; fresh installs only.
- **Phase 3b-3** (default flip + advisory + doctor coexistence) — REMOVED in PR #825. `switchroom up` defaults Docker on Linux; `--legacy` is a plain branch selector.
- **Phase 4** (CLI shim + log abstraction + update flow) — OUT OF SCOPE for v1.0; not currently planned.
- **Phase 5** (migration tooling + e2e) — REMOVED.
- **Phase 3.5** (Mac/Docker-Desktop validation) — deferred to next week.

## Summary

Switchroom today is a Linux-only host install. Multi-OS reach is the point of #793 and Docker is the obvious substrate. This RFC picks Option 3 from the comparison: **one container per agent, plus a small set of shared-service containers (vault broker, approval kernel, telegram bridge), all wired together by a generated `docker-compose.yml`**. The user-visible end state is `switchroom setup` produces a compose file, `docker compose up -d` brings the fleet alive, and the README install path is one block of shell on Linux and Mac. Windows-WSL2, Synology, Unraid, and RasPi work in principle on the same compose file, but they aren't formally validated for v1.0 — best-effort, community-tested, no support promise. The host-native install stays supported on Linux alongside Docker. Both deliver the same product promise.

## Motivation

The host-native model has carried us a long way. It also carries weight we keep tripping over.

### Klanker takes the fleet down with it

A claude REPL is not a small process. RSS sits 150-300MB idle and spikes hard during long tool loops. Klanker (Opus 4.7, agentic, often dispatching parallel sub-agents) is the canonical OOM offender. When the host kernel reaps it, anything else co-resident with it on the same box is in the blast radius — either because the OOM killer wandered into a neighbour, or because the swap thrash before the kill stalled every other agent's response. We don't have observed cross-agent OOM kills in the audit log yet, but we have observed multi-second response stalls during klanker's heavy sub-agent fan-outs. Per-agent cgroup limits are the right answer. Today they aren't first-class — we'd have to hand-roll `MemoryMax=` into each unit and pick a number per agent. With one container per agent, `mem_limit` is one line in compose and the kernel does the enforcement.

### Multi-OS install is the wedge and we're losing it

`install.sh` is 133 lines of Linux. Mac users have to bring Lima or UTM. Windows users have to bring WSL2 first and then fight systemd-in-WSL. Both work, neither is one-click. The product principle "if they need the docs, we've failed" (`reference/principles.md` §1) is not currently met for non-Linux users — they need the docs before they can even start. Docker fixes that. `docker compose up -d` is the same line on every host that runs Docker, which is every host worth shipping to.

### `bin/bridge-watchdog.sh` is 967 lines of bash and the grace windows are cranked to "effectively never"

The watchdog's job is to detect a wedged agent and bounce it. The current implementation is bash, journalctl-sourced, systemd-cgroup-aware, and full of careful `set -euo pipefail` plumbing around shell-portability hazards. Every time we tighten it, false positives spike and we widen the grace window again. The thresholds today are conservative enough that the watchdog is approaching inert. Porting this to TypeScript against the Docker events stream + `docker logs --since` is not free, but the resulting code is testable, the failure modes are typed, and the source of truth (Docker container state) is far easier to reason about than systemd cgroup pathing.

### Per-agent resource isolation is missing

`MemoryMax`, `CPUQuota`, `IOWeight` are systemd-unit-level knobs. We don't set them today. We could. We won't, because tuning them by hand per agent on a host with a shared kernel is the wrong abstraction — the right abstraction is "this agent gets this slice of the box." Compose makes that one line per service and Docker enforces it.

### What's actually changing for users

PR #796 already landed the positioning shift this RFC implements: switchroom's product promise is the JTBD outcomes, not the substrate. Long-running service per agent, survives reboots, auto-recovery with audit trail, per-agent isolated logs, OAuth under your existing subscription, stock `claude` CLI. None of those say "systemd" and none of them say "Docker." The substrate is an internal engineering detail.

The user-visible change is reach, tiered. Today switchroom installs cleanly on Linux only. After this RFC, the supported install targets for v1.0 are **Linux and Mac** — same product promise on both. Windows-WSL2, Synology, Unraid, and RasPi run on the same architecture and compose file and are expected to work; they just aren't formally validated or release-gated. Operators on those platforms can install and most things will work; what they don't get is a "we tested this and signed it off" stamp. The architecture supports them; the test/release matrix is the thing that's tiered. Whether the agent runs under a systemd unit or a Docker container is the CLI's problem, not the user's.

**"Community-tested / best-effort" defined operationally.** Issues filed against best-effort platforms get the `platform:best-effort` label and are accepted but not release-blocking; bug reports are welcome, fixes via PR are welcome, but maintainers make no commitment to reproduce on those platforms or to gate releases on their state. Linux (and Mac under the default ship plan) get the inverse: maintainer-reproduced, release-gated, regressions block ship.

**JTBD narrowing acknowledged.** v1.0 narrows the "runs on the box you already have" claim to Linux + Mac boxes. Synology / Unraid / RasPi / Windows-WSL2 become bonus surface, not headline coverage — the install path is documented for them but they are not part of the v1.0 promise. The substrate-agnostic vision copy already reads correctly under this narrowing; release-notes are the right surface for naming the tier explicitly.

The OpenClaw wedge — stock `claude` CLI under your Pro/Max subscription, not a custom runtime against your API key — is unchanged. The container runs the unmodified `claude` CLI against the user's OAuth, exactly as the systemd unit does today. The substrate swap is invisible to that wedge.

## Goals

- One install command on Linux and Mac as the supported v1.0 targets. Same command works on Windows-WSL2 and ARM homelab boxes (Synology, Unraid, RasPi 4/5) on a best-effort basis — expected to work, not formally validated.
- Per-agent resource isolation — memory and CPU caps as first-class config, enforced by the kernel, not advisory.
- Watchdog rewritten in TypeScript against Docker's event stream. Smaller, testable, restorable to "actually catches wedges" thresholds.
- Product-promise-preserving: stock `claude` CLI inside the container, official OAuth, no API-key interception, vault and approval kernel work identically inside and out. Same JTBD outcomes as host-native, same wedge against OpenClaw.
- Compose file is generated by `switchroom` CLI, not hand-edited. Same cascade as today.
- Existing host-native install keeps working. Migration is opt-in.

## Non-goals

- Kubernetes / Helm. Not now. Maybe never.
- Multi-host fleets. One Docker host = one fleet, same as today.
- Hosted switchroom-as-a-service.
- Replacing the host-native install. Both stay.
- Single-container-multiple-agents (the original #793 default). We considered it. We rejected it. See Alternatives.

## Proposed architecture

```
                 ┌────────────────────────────────────────┐
                 │        host: Docker Engine             │
                 │                                        │
  ┌──────────┐   │   ┌────────────┐   ┌────────────┐      │
  │ Telegram │◄──┼──►│  bridge    │   │   vault    │      │
  │   API    │   │   │ container  │◄─►│  broker    │◄─┐   │
  └──────────┘   │   │ (1 per     │   │ container  │  │   │
                 │   │  agent)    │   │ (singleton)│  │   │
                 │   └─────┬──────┘   └────────────┘  │   │
                 │         │                          │   │
                 │         │ stdio over volume        │   │
                 │   ┌─────▼──────────┐               │   │
                 │   │ agent-klanker  │ unix socket───┘   │
                 │   │  tini + start  │                   │
                 │   │  + tmux        │                   │
                 │   │  + claude REPL │                   │
                 │   └────────────────┘                   │
                 │                                        │
                 │   ┌────────────────┐  ┌─────────────┐  │
                 │   │ agent-coach    │  │ approval    │  │
                 │   │ (same shape)   │  │ kernel      │  │
                 │   └────────────────┘  │ container   │  │
                 │                       │ (singleton) │  │
                 │   ┌────────────────┐  └─────────────┘  │
                 │   │ agent-…        │  ┌─────────────┐  │
                 │   └────────────────┘  │ switchroom- │  │
                 │                       │ cron        │  │
                 │                       │ (singleton, │  │
                 │                       │  docker.sock)│ │
                 │                       └─────────────┘  │
                 └────────────────────────────────────────┘
```

### Per-agent container internals

PID 1 is `tini`. tini reaps zombies, forwards signals, and exits clean. The process tree under it is single-spine — there is no separate "supervisor process" doing 4-way fan-out. The actual shape, mirroring today's host-native unit (`bin/start.sh.hbs:373` and the systemd unit's `ExecStart`):

```
tini (PID 1)
└── tmux (daemonised, listening on /tmp/tmux-1000/<agent>)
    └── start.sh           (rendered from profiles/_base/start.sh.hbs)
        └── claude --continue
            ├── MCP child: telegram gateway (telegram-plugin/server.ts)
            ├── MCP child: hindsight
            └── MCP child: ... (per-agent .mcp.json)
```

`start.sh` does env setup, then `exec`s into `claude --continue` inside the tmux pane. The telegram gateway is an MCP child of `claude`, not a sibling — it inherits claude's stdio and shares its lifecycle. There is no userland supervisor: tini handles signal forwarding and zombie reaping, tmux handles the pane, and claude's own MCP supervisor handles the gateway and hindsight children. The previous draft's "tini supervises start.sh + tmux + claude + gateway" framing was wrong; nothing in this tree is doing 4-way supervision and we should not introduce a 50-line process supervisor where none is needed.

Inside the container `CLAUDE_CONFIG_DIR=/state/.claude` (per-agent bind-mount, see Volume layout). The container is the only place we need tmux. The `!` interrupt path stays local: the gateway (an MCP child of claude) and claude itself share a single tmux socket at `/tmp/tmux-1000/<agent>` — same socket family as today. `tmux send-keys C-c` is a local IPC call. No container boundary is crossed for the interrupt.

### Container identity model — per-agent socket directories

This subsection is the load-bearing security redesign. Today's broker authenticates connecting clients by reading `/proc/<pid>/cgroup` to extract a systemd unit name like `switchroom-klanker-cron-3.service`, then cross-checking via `systemctl --user show <unit>` to defend against same-UID cgroup spoofing (`src/vault/broker/peercred.ts:196-302`). The broker's ACL (`src/vault/broker/acl.ts:159-209`) **only serves callers whose `peer.systemdUnit` parses as a switchroom cron unit**; anything else is rejected with "caller is not a switchroom cron unit". Both the cgroup parse and the `systemctl --user show` cross-check are structurally absent inside a container — there is no host systemd to consult, and the cgroup path inside the container's namespace says nothing about which agent the connection came from.

We need a different way to bind a connection to an agent identity. **Picked: per-agent unix socket directories, with OS file permissions as the gatekeeper.** Rationale: it requires no token storage, no token rotation, no replay-window reasoning, no new crypto. The kernel-vouched property the broker's threat model relies on (only the right principal can connect) is preserved by filesystem permissions, which is a substitution the broker already trusts for its on-disk audit log and SQLite. HMAC tokens were the obvious alternative; rejected because they widen the secret surface (one more thing to provision, leak, rotate, audit) when filesystem permissions already give us the same property.

Layout:

```
broker container:
  /run/switchroom/broker/
    klanker/sock        mode 0700, owned by uid:gid 1100:1100
    coach/sock          mode 0700, owned by uid:gid 1101:1101
    finn/sock           mode 0700, owned by uid:gid 1102:1102
    ...
```

Per-agent UIDs are allocated deterministically from the agent name at compose-generation time (e.g. `1100 + stable_hash(agent_name) % 800`, collision-checked across the fleet). Each agent container runs as its own UID. The compose generator emits per-agent volumes:

```yaml
agent-klanker:
  user: "1100:1100"
  volumes:
    - broker-klanker-sock:/run/switchroom/broker        # read-write, klanker only
    # NOT mounted: broker-coach-sock, broker-finn-sock, etc.

vault-broker:
  user: "0:0"                                            # broker needs to chown per-agent dirs
  volumes:
    - broker-klanker-sock:/run/switchroom/broker/klanker
    - broker-coach-sock:/run/switchroom/broker/coach
    - broker-finn-sock:/run/switchroom/broker/finn
```

On startup the broker `mkdir`s `/run/switchroom/broker/<agent>/`, `chown`s it to that agent's UID, `chmod`s `0700`, and `bind()`s a socket at `<agent>/sock`. An agent container only mounts its own subdirectory — agent-klanker has no path, no descriptor, no namespace through which it can reach `/run/switchroom/broker/coach/sock`. Compose is the gatekeeper; the compose generator enforces the invariant (one agent's broker volume mounts into exactly one agent's container) and a unit test asserts it on every regenerated file.

Identity resolution inside the broker:

- Replace `peer.systemdUnit` with `peer.agentName`, derived at `accept()` time from the **socket the connection arrived on**. The broker calls `getsockname(connFd)` to read the listening socket's path (`/run/switchroom/broker/<agent>/sock`), and parses `<agent>` out of the path. This is broker-controlled input — the agent has no way to influence it.
- ACL becomes: "this connection came in on the klanker socket, therefore caller is `klanker`; check `config.agents.klanker.schedule[*].secrets` for the requested key." `parseCronUnit` and the `(agentName, index)` pair go away — under containers, every grant is agent-scoped, not schedule-entry-scoped (the scheduler is now a separate container; see Scheduler architecture below).
- `peer.uid` is still consulted as a defence-in-depth check (does it match the expected UID for that agent's socket directory?), but the primary identity binding is path-derived, not credential-derived. SO_PEERCRED becomes confirmatory, not authoritative — which is exactly what we want, because it removes the userns / virtiofs peercred-regression risk that dominated the prior draft's Phase 0 matrix.
- The "non-cron callers are not served" rule (`acl.ts:204-208`) is dropped under containers — every connection on a per-agent socket *is* an agent caller by construction. Interactive `vault get` continues to use the `--no-broker` direct-read path.

What the agent sees: `SWITCHROOM_BROKER_SOCKET=/run/switchroom/broker/sock` (the in-container path; agent doesn't know its own UID is special). One env var. One socket. No tokens. No client-side crypto.

What the broker code change costs: about 80 lines net. `peercred.ts` keeps the SO_PEERCRED reader for defence-in-depth and grows a `socketPathToAgent()` helper. `acl.ts` grows a `checkAclByAgent(agentName, key)` path that runs alongside the existing cron-unit path; on host-native both still work, on Docker only the new path runs. The cron-unit path stays untouched — host-native scheduling is unchanged.

**Phase 0 acceptance for this section (replacing the previous peercred matrix):** end-to-end ACL resolution through `acl.ts`-equivalent — both deny and allow paths — on every target environment. Specifically: (a) klanker's container connects to its socket and successfully resolves a key in its allow-list; (b) klanker's container connects to its socket and is denied a key NOT in its allow-list; (c) klanker's container, with the compose file hand-edited to also mount coach's socket volume, successfully connects to coach's socket — and the doctor check catches the cross-mount before this is reachable. `getsockopt(SO_PEERCRED)` return values are recorded for forensics but are no longer pass/fail for the matrix.

### Approval kernel container (singleton)

`src/vault/approvals/kernel.ts` (564 lines), today an in-process module the broker server talks to. In Docker: separate container, same identity model as the broker. Per-agent socket directories under `/run/switchroom/kernel/<agent>/sock` with the same UID/permission discipline; `kernel.ts` derives the requesting agent from the listening socket path at `accept()` time. There is no token, no shared secret, no cross-agent reachability.

The kernel's SQLite (`kernel.db`) lives on a persistent named volume (`approvals-data`), bind-mounted only into the kernel container. Agent containers reach approvals only through the kernel socket — they have no path to `kernel.db` itself.

### Image layering

Two images, multi-arch (`linux/amd64` + `linux/arm64`).

- `switchroom/base:<sha>` — Debian slim + node + bun + tmux + tini + claude bundle + node_modules. Built on tag push. ~400-600MB. Same hash for every agent.
- `switchroom/agent:<sha>` — `FROM base:<sha>`, adds the switchroom CLI build artifacts. Each agent container runs this image with a config bind-mount, not a separate built image per agent.

Per-agent customisation (skills, profile, telegram tokens) lives in bind-mounted config, not in the image. Adding an agent does not rebuild an image.

### Volume layout

```
~/.switchroom/                       (host)
├── compose/
│   └── docker-compose.yml           (generated, source of truth)
├── agents/
│   ├── klanker/                     bind-mounted into agent-klanker:/state/agent
│   │   ├── start.sh
│   │   ├── settings.json
│   │   ├── .mcp.json
│   │   ├── CLAUDE.md
│   │   └── ...
│   └── coach/
├── vault/
│   ├── vault.db
│   └── audit.log                    bind-mounted into broker only
├── approvals/
│   └── kernel.db                    bind-mounted into approval-kernel only
└── logs/
    ├── klanker.log                  per-agent log bind, survives container

~/.claude/projects/<agent>/          bind-mounted into agent-<name>:/state/.claude
                                     per-agent CLAUDE_CONFIG_DIR isolation
```

Volumes that are shared between containers (broker socket, kernel IPC) are Docker-managed named volumes, not host bind mounts — that avoids the macOS bind-mount perf trap for everything except the things that genuinely need to be on the host filesystem (logs, audit trail, agent config the operator edits).

### Host UID alignment for bind-mounts

Agent containers run as a per-agent UID (1100, 1101, …) — see Container identity model. Bind-mounted host paths (`~/.switchroom/agents/<agent>/`, `~/.claude/projects/<agent>/`, `~/.switchroom/logs/<agent>/`) need to be readable and writable by the matching in-container UID, otherwise `start.sh` fails on first write.

Convention:

- **`SWITCHROOM_HOST_UID`** env var, sourced from `~/.switchroom/.env` written by `switchroom setup`. Linux default: the operator's own UID (the output of `id -u` at setup time, typically `1000`). Mac/Windows: explicit, no default — `switchroom setup` prompts and writes whatever the operator confirms.
- The compose generator sets `user: "${SWITCHROOM_HOST_UID}:${SWITCHROOM_HOST_GID}"` on every agent container that mounts host paths, **plus** an in-container supplementary group binding for the per-agent identity used inside `/run/switchroom/broker/<agent>/`. The two-UID story is: outside-mounted host files are owned as the host operator; inside-only sockets are owned as the per-agent UID. Compose's `user:` directive sets the primary UID; supplementary groups are added at start.sh entry.
- **Docker Desktop caveat (Mac/Windows):** the LinuxKit VM's virtiofs translates host UIDs so that *every* host file appears owned by container UID 1000 inside the VM, regardless of the host operator's actual UID. Per-agent isolation between bind-mounted host paths therefore cannot rely on UID separation on Mac/Win — it can only rely on the **compose generator never mounting agent-A's host path into agent-B's container**. This invariant is enforced by `src/agents/compose.ts` (a single agent's `~/.switchroom/agents/<name>` and `~/.claude/projects/<name>` paths only ever appear under that agent's service block) and audited by a doctor check `switchroom doctor --check cross-agent-mounts` that grep-asserts the rendered compose has no host path appearing under more than one service.
- The doctor check runs on every `switchroom reconcile`, every `switchroom up`, and as a CI gate on the compose generator's snapshot tests. Operator hand-edits that violate it fail the next doctor invocation with a hard error and a pointer to the offending lines.

### Compose skeleton

```yaml
# generated by `switchroom reconcile` — do not edit by hand
version: "3.9"

x-agent-defaults: &agent-defaults
  image: ghcr.io/switchroom/agent:0.7.0
  init: false                            # tini is PID 1 inside
  restart: unless-stopped
  stop_grace_period: 45s                 # gateway needs ~35s to drain — see note below
  depends_on:
    vault-broker: { condition: service_healthy }
    approval-kernel: { condition: service_healthy }
  environment:
    SWITCHROOM_BROKER_SOCKET: /run/switchroom/broker/sock
    SWITCHROOM_KERNEL_SOCKET: /run/switchroom/kernel/sock

services:
  vault-broker:
    image: ghcr.io/switchroom/broker:0.7.0
    restart: unless-stopped
    volumes:
      - broker-sock:/run/switchroom
      - ~/.switchroom/vault:/state/vault
    healthcheck:
      test: ["CMD", "/usr/local/bin/broker-healthcheck"]
      interval: 10s
      retries: 3

  approval-kernel:
    image: ghcr.io/switchroom/kernel:0.7.0
    restart: unless-stopped
    volumes:
      - kernel-sock:/run/switchroom-kernel
      - ~/.switchroom/approvals:/state/approvals

  agent-klanker:
    <<: *agent-defaults
    container_name: switchroom-klanker
    hostname: klanker
    user: "${SWITCHROOM_HOST_UID}:${SWITCHROOM_HOST_GID}"
    mem_limit: 6g                        # klanker (Opus 4.7, sub-agent fan-out) — see Resource defaults
    cpus: 2.0
    volumes:
      - broker-klanker-sock:/run/switchroom/broker     # ONLY klanker's broker socket dir
      - kernel-klanker-sock:/run/switchroom/kernel     # ONLY klanker's kernel socket dir
      - ~/.switchroom/agents/klanker:/state/agent
      - ~/.claude/projects/klanker:/state/.claude
      - ~/.switchroom/logs/klanker:/var/log/switchroom

  agent-coach:
    <<: *agent-defaults
    container_name: switchroom-coach
    user: "${SWITCHROOM_HOST_UID}:${SWITCHROOM_HOST_GID}"
    mem_limit: 1.5g                      # conversational default — see Resource defaults
    cpus: 1.0
    volumes:
      - broker-coach-sock:/run/switchroom/broker
      - kernel-coach-sock:/run/switchroom/kernel
      - ~/.switchroom/agents/coach:/state/agent
      - ~/.claude/projects/coach:/state/.claude
      - ~/.switchroom/logs/coach:/var/log/switchroom

volumes:
  broker-klanker-sock:
  broker-coach-sock:
  kernel-klanker-sock:
  kernel-coach-sock:
  # ... one pair per agent, generated
```

`switchroom reconcile` regenerates this whole file from `switchroom.yaml`, the same way it regenerates systemd units today. Hand edits get clobbered. There's a `# generated by` warning at the top.

**Why `stop_grace_period: 45s`.** Docker's default SIGTERM-to-SIGKILL window is 10s. The telegram gateway's drain path (`telegram-plugin/gateway/gateway.ts` shutdown handler) needs ~35s in the worst case to flush in-flight stream-replies, finalise the progress card, persist the FIFO queue tail, and let claude write its session JSONL. Without `stop_grace_period`, every `docker compose restart` becomes a SIGKILL crash mid-flush, which is precisely the failure mode the watchdog exists to detect — and would make routine restarts indistinguishable from real wedges in the audit log. 45s gives a 10s safety margin over observed peak.

### Scheduler architecture

Compose has no native scheduler. Today, scheduled tasks declared in `switchroom.yaml` (`src/config/schema.ts:757`, the `schedule:` cascade) become per-agent systemd `.timer` units generated by `src/agents/systemd.ts:794-864` via `cronToOnCalendar`. Under Docker, those timer units don't exist — and the cron-unit identity model the broker's old ACL relied on doesn't either (see Container identity model).

**Picked: singleton scheduler container reading the cascade and dispatching via `docker exec`.** Rationale: per-agent ofelia sidecars would multiply container count by 1.x and require their own bind-mounts to read cascade state; host-side cron (cron on the host calling `docker compose exec`) breaks the "same install path on Mac/Win/Linux" wedge because Mac and Windows-WSL2 don't have host cron stories that match. A singleton scheduler container is one new image, reads the same `switchroom.yaml` the rest of the fleet reads, owns its own audit trail, and has exactly one place to put the "did this fire" SQLite. It's also the shape that maps cleanly back to today's "every cron is a switchroom-managed entity," which keeps the operator mental model unchanged.

```
                ┌──────────────────────┐
                │   switchroom-cron    │
                │   container          │
                │  (singleton)         │
                │                      │
                │  • reads switchroom.yaml from
                │    /state/config (bind)
                │  • node-cron loop, OnCalendar parity
                │  • on fire: docker exec agent-<name> \
                │      claude -p "<prompt>"
                │  • writes to scheduler.db (audit)
                └──────────────────────┘
```

Compose snippet:

```yaml
switchroom-cron:
  image: ghcr.io/switchroom/scheduler:0.7.0
  restart: unless-stopped
  user: "0:0"                            # needs docker.sock access
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - ~/.switchroom:/state/config:ro
    - ~/.switchroom/scheduler:/state/scheduler   # scheduler.db
  environment:
    SWITCHROOM_CONFIG: /state/config/switchroom.yaml
```

Implementation:

- `src/scheduler/` (new, target ~500 lines + tests). Reads the cascade via the existing `src/config/loader.ts`, walks `agents.<name>.schedule[]`, registers each entry with `node-cron` against the same cron expression `cronToOnCalendar` parses today (so Phase 2 reuses the same cron-spec test fixtures).
- On fire, dispatches the prompt via `docker exec -i agent-<name> claude -p "<prompt>"` with the per-task env (vault refs already injected via `SWITCHROOM_BROKER_SOCKET` from the agent container's compose entry — the scheduler doesn't materialise secrets, the agent does). The scheduler is **not** a vault-broker client — it never sees the secret values, only fires the task.
- Writes a row per fire to `scheduler.db` (timestamp, agent, schedule index, prompt hash, exit code). `journalctl -t switchroom-cron` (Linux) / `docker compose logs switchroom-cron` (Mac/Win) for live observation.
- Authenticates to the vault broker (if it ever needs to — reserved): same per-agent socket model, but the scheduler container is special — it has its own `/run/switchroom/scheduler/sock` mount. For now, the scheduler does not call the broker; agents resolve their own secrets at task-start time, which is the same flow as host-native today.
- Identity model reflection: under containers, the broker's ACL no longer scopes by `(agentName, scheduleIndex)` because the scheduler-container-firing-an-agent-container path doesn't preserve `scheduleIndex` through `docker exec`. ACL becomes per-agent, with allowed keys flattening to the union of all `schedule[*].secrets` for that agent in the cascade. Documented loss of granularity; acceptable because (a) the audit log captures the firing schedule entry by index in `scheduler.db`, (b) host-native mode keeps the per-index ACL for operators who need it, (c) per-agent secret partitioning is the security boundary that matters in practice.

This is an architecture change, not a Phase 1 detail. The architecture diagram at the top of the doc gains one box. Effort lands in Phase 1 (compose generator emits the scheduler service) and Phase 2 (broker ACL gains the per-agent path).

## Code-change footprint

File-by-file inventory against the current tree.

**Replaced wholesale**

- `bin/bridge-watchdog.sh` (967 lines bash) → new `src/watchdog/` (TS, target ~400 lines + tests). Source switches from journalctl + systemctl-cgroup-walking to the Docker events API + `docker logs --since`.
- `install.sh` (133 lines) → `install.sh` (Docker-flavoured, target ~80 lines: detects Docker, writes initial compose, runs `docker compose up -d`, prints next-step). Host-native install moves to `install-host.sh`.
- `src/cli/systemd.ts` (137 lines) + `src/agents/systemd.ts` (1153 lines) → `src/agents/compose.ts` (target 600-800 lines: generates docker-compose.yml from the config cascade, same cascade rules). Systemd code stays for host-native mode behind a feature flag.

**Rewritten in place**

- `bin/start.sh.hbs` (383 lines, generated as `start.sh` per agent) → mostly the same. Inside the container the env layout differs (CLAUDE_CONFIG_DIR=/state/.claude, socket paths under /run/switchroom). Template bifurcates into `start.sh.hbs` (host) and `start-container.sh.hbs` (Docker). Net delta ~+100 lines for the container variant.
- `src/vault/broker/server.ts` (1440 lines) — peercred logic (`src/vault/broker/peercred.ts`, `peercred-ffi.ts`) needs a Docker-namespace-aware path. Code stays, behaviour gets a code branch. ~+150 lines + tests.
- `telegram-plugin/server.ts` (171 lines) and `telegram-plugin/gateway/gateway.ts` (10319 lines) — unchanged in core logic. Boot-card and wake-audit paths need to know they're inside a container so the env-detection branch picks up `docker logs` instead of `journalctl`. Net delta ~+50 lines.

**Unchanged**

- `src/vault/approvals/kernel.ts` (564 lines) — runs the same, just in its own container.
- `src/agents/scaffold.ts` (3423 lines) — the template engine doesn't care what host runtime is. The only delta is which start template gets selected.
- All of `src/config/`, `src/auth/`, `src/memory/`, `src/setup/`. Cascade is cascade.
- All of `telegram-plugin/` except the ~50-line env-branch above. The whole plugin keeps its current shape.
- `profiles/` — every profile, every skill, every CLAUDE.md template. Untouched.

**Net new**

- `src/watchdog/` (target 400 lines + 200 lines tests).
- `src/agents/compose.ts` (target 700 lines + tests).
- `Dockerfile.base`, `Dockerfile.agent`, `Dockerfile.broker`, `Dockerfile.kernel` (target 50-150 lines each).
- `.github/workflows/docker-publish.yml` for multi-arch builds on tag.

Total touched: maybe 6000 lines of new/changed TS, 2000 lines deleted bash, 4 Dockerfiles. Achievable.

## Phased plan

Estimates assume Opus 4.7, supervised by a separate-process reviewer. Total budget across phases ≈ **2570 agent-minutes** (P0 180, P1 600, P2 280, P3 750, P4 360, P5 400). P5 dropped ~200 minutes after re-scoping cross-platform e2e to Linux + Mac mandatory and treating Windows/Synology/Unraid/RasPi as best-effort, not release-gating. Earlier rebaseline from ~2000 covered: container identity model design + spike (P0), scheduler design + implementation (P1), 30+ watchdog fixtures + log hygiene audit (P3), update rolling-restart spec + cross-platform log shim + doctor checks (P4), migration tool + chown handling + round-trip e2e (P5).

### Phase 0 — spike, agent-minutes ≈ 180

Files: `Dockerfile.base`, throwaway compose, `docs/phase0-identity-matrix.md` (deliverable), prototype `acl.checkAclByAgent()` and `socketPathToAgent()`. Goal: prove four things, in this order:

1. **Docker Desktop installable and functional** on Mac (Apple Silicon), Windows (WSL2 backend), Linux rootful, Linux rootless. Four real installs, not paper checks. Time-to-running-fleet recorded for each.
2. claude CLI runs in `linux/amd64` and `linux/arm64` images, OAuth headless flow completes. (#793 q4)
3. **Container identity model end-to-end.** Per-agent socket directory layout works in practice: broker chowns `/run/switchroom/broker/<agent>/` to per-agent UIDs, agent container only mounts its own subdirectory, ACL resolves correctly via path-derived agent identity. Test matrix below.
4. tmux send-keys C-c from the gateway (claude's MCP child) inside the container reaches claude in the same container's tmux pane. `!` interrupt loop end-to-end.

**Identity-model test matrix (deliverable, not optional).** Tiered. The two Linux rows are mandatory PASS to unblock Phase 1. Mac is mandatory before v1.0 ships but runs as a parallel-track spike when hardware lands (next-week ETA), so it does not gate Phase 1 entry. Windows/WSL2 and the homelab platforms (Synology, Unraid, RasPi) are optional/best-effort — capture results if convenient, don't block on them.

| Environment | Tier | Allow path resolves? | Deny path rejects? | Cross-mount detection? | SO_PEERCRED uid (forensics) |
|---|---|---|---|---|---|
| Linux rootful Docker, default config | **mandatory (Phase 1 gate)** | | | | |
| Linux rootless Docker, userns-remap ON | **mandatory (Phase 1 gate)** | | | | |
| Docker Desktop Mac (latest, virtiofs) | **mandatory before v1.0 ship** | | | | |
| Docker Desktop Windows / WSL2 backend | optional / best-effort | | | | |
| Synology DSM (Container Manager) | optional / best-effort | | | | |
| Unraid (Docker tab) | optional / best-effort | | | | |
| RasPi 4/5 (arm64, Linux rootful) | optional / best-effort | | | | |

- **Allow path:** `agent-klanker` connects to `/run/switchroom/broker/sock` (mapped from `broker-klanker-sock` volume), requests a key in its `secrets` allow-list, broker resolves agent identity from `getsockname()`, ACL check passes, value returned.
- **Deny path:** same agent, different key not in allow-list. Broker returns typed error with reason `"key '<k>' not in ACL for klanker"`.
- **Cross-mount detection:** compose hand-edited to additionally mount `broker-coach-sock` into agent-klanker. `switchroom doctor --check cross-agent-mounts` flags the mount with a hard error pointing at the offending compose lines, before the fleet comes up.
- **SO_PEERCRED forensics column** (informational only, not pass/fail): record the uid returned for sanity. Under the new model it's defence-in-depth, not authoritative.

Acceptance criteria: **both Linux rows pass all three pass/fail columns** — that's the gate to start Phase 1. Mac runs as a parallel-track spike when hardware arrives (next-week ETA); it must pass all three columns before v1.0 ships, but does not gate Phase 1 entry. Optional rows are recorded if exercised, ignored if not. SO_PEERCRED column captured for the trouble-shooting record but does not gate anything.

Abort criteria:
- **Linux rootful OR Linux rootless fails** and the workaround is `--privileged` or host-level UID remap — pause the RFC. The whole plan rests on these two passing.
- **Mac fails** when validated — does NOT pause Linux build-out. Redesign virtiofs UID handling on the parallel track. Linux v1.0 can ship without Mac if the redesign slips past the v1.0 date (see Decision criteria); Mac then becomes a v1.1 deliverable.
- Per-agent socket directories cannot be made to work on Linux — pivot to HMAC tokens with a full lifecycle spec (issuance, storage at `/run/secrets/<agent>-broker-token`, revocation on broker restart, scoped ACL) and re-run Phase 0 against the token design. The HMAC fallback is documented in Risks but should not be needed; the per-agent socket design has no known blockers on Linux.
- Optional-tier failures are notes, not aborts.

### Phase 1 — Dockerfiles + compose generator + scheduler, agent-minutes ≈ 600

Files: 5 Dockerfiles (base, agent, broker, kernel, scheduler), `src/agents/compose.ts`, `src/scheduler/`, tests. Generate compose from the existing config cascade. Cover defaults, profiles, per-agent overrides, vault refs, mem/cpu limits, per-agent socket volumes, scheduler service generation. Scheduler implementation (node-cron loop, `docker exec` dispatch, audit DB) lands here so Phase 2's broker ACL changes have a working consumer.

Success: `switchroom reconcile` writes a compose file that `docker compose config` validates and `docker compose up -d` runs. Three agents up, all responding in Telegram.

**Acceptance test (promoted from Open Questions): `switchroom add agent` reconcile-then-up race.** Adding a new agent must update compose AND start the new container without disturbing existing ones. Test: 3-agent fleet running, send a message to agent-A every 2s, run `switchroom add agent newbie` concurrently, verify (a) agent-A's response stream is uninterrupted, (b) `docker compose up -d --no-deps agent-newbie` only touches the new service, (c) no broker/kernel restart, (d) newbie reaches "first reply in Telegram" within 60s. Failure to pass = Phase 1 incomplete, regardless of other criteria.

Abort: if compose generation can't cleanly express the cascade and we end up with post-render shell munging, stop and rethink.

**Test fleet teardown contract.** Phase 1 (and every later phase that spins up a fleet for tests) must follow these rules — the test host is shared with Coolify and hindsight in many environments; treat it as production unless you provisioned it yourself for this run.

- Every test container MUST carry the label `switchroom.test=<phase>` (e.g. `phase1c`) AND a per-run UUID label (e.g. `switchroom.test.run=<uuid>`).
- Use `--rm` on every `docker run`.
- Sanctioned teardown shape only:

  ```
  docker rm -f $(docker ps -aq --filter label=switchroom.test=<phase>) 2>/dev/null || true
  ```

- Banned: bulk teardown over `docker ps -a` (`docker ps -a | xargs docker rm`, bare `docker rm $(docker ps -aq)`). Banned: any `prune` command in test scripts (`docker system prune`, `docker container prune`, `docker volume prune`).
- Per-container removal by explicit name is fine. Project-scoped compose teardown (`docker compose -p <project> down -v --remove-orphans`) is also fine — scope is the compose project, won't touch anything outside it.

### Phase 2 — broker + kernel IPC port, agent-minutes ≈ 280

Files: `src/vault/broker/peercred.ts` (add `socketPathToAgent` + container code branch), `src/vault/broker/acl.ts` (add `checkAclByAgent`), `src/vault/approvals/client.ts` socket-path resolver, kernel-side mirrors. Goal: vault refs + approval grants work identically inside-Docker and host-native, exercised by the existing test suite. Path here depends on the identity model that landed in Phase 0 — this phase is the production implementation of whatever Phase 0 proved.

Success: every existing vault + approval test passes against a live broker container via testcontainers.

**Schema-stability invariant.** Phase 2 **must not change the vault broker SQLite layout** (grants table, audit-log table, indices, triggers — all frozen). The migration tool relies on `switchroom migrate to-host` reading the same DB the host-native broker reads. Any schema change here breaks the rollback path and turns migration into a one-way door. If a schema change is genuinely required, it gets its own RFC and ships ahead of Docker migration with paired up/down migrations and a parallel-read test. Same invariant applies to the approval kernel's SQLite (`kernel.db`).

Abort: if peercred-in-Docker requires user namespace remapping that breaks rootless setups, fall back to a token-based broker auth path. Document the security tradeoff (see Phase 0 ACL-narrowing review).

### Phase 3 — watchdog port, agent-minutes ≈ 750

> **Status (post-v0.6):** DEFERRED / REMOVED in PR #825 — see Status block at top.

Files: `src/watchdog/` from scratch, fixture suite under `src/watchdog/__fixtures__/`. Source: Docker events stream (`docker events --filter type=container`) for restart triggers, `docker logs --since` + `docker stats` for liveness probes, `docker inspect` for config sanity.

**Log-driver decision (committed, Linux hosts only): `--log-driver=journald` for every container.** On Linux hosts (the production target — bare-metal, RasPi, Linux servers), all container stdout/stderr forwards to the host journal under a `CONTAINER_NAME=` selector. This preserves the bash watchdog's existing `journalctl` queries verbatim during the parallel dry-run window and keeps `journalctl -t switchroom-watchdog` working for operators after cutover. Compose snippet:

```yaml
x-logging: &default-logging
  driver: journald
  options:
    tag: "switchroom/{{.Name}}"
```

Applied to every service on Linux. Without this, `journalctl` has no signal under Docker (default `json-file` driver writes to `/var/lib/docker/containers/...`) and the parallel-run validation strategy is vacuous on Linux.

**Mac and Windows caveat.** Docker Desktop runs the engine inside a LinuxKit/virtiofs VM. The host (macOS or Windows) has no journald, and the in-VM journal isn't exposed to host tooling — so `journalctl -t switchroom-watchdog` is a non-starter on those platforms regardless of compose log-driver settings. The compose generator should still emit the `journald` directive (Docker Desktop's engine accepts it transparently), but operator muscle memory for `journalctl` on Mac/Win does not carry over, and the parallel dry-run premise (bash watchdog vs TS watchdog, both sourcing journald-forwarded logs) **does not apply on Mac/Win**. On those platforms, the validation reduces to fixture-only.

Validation strategy:
- **Parallel dry-run, two weeks — Linux hosts only.** Bash watchdog continues to source from `journalctl -t switchroom-watchdog`. TS watchdog sources from `docker events`. Both run in dry-run mode (log intended action, don't execute). Compare action streams nightly; any divergence files an issue and blocks cutover. This check is gated on Linux — Mac/Win don't participate.
- **Fixture suite — every platform.** Every documented restart reason gets a recorded `(docker events stream + docker logs tail + docker stats sample)` triple plus an expected action. Fixtures live in tree, run on every PR across Linux/Mac/Win CI matrices. **Target: 30+ fixtures**, derived from an honest inventory of the bash watchdog's behaviour:

  Trigger surface (6 distinct restart reasons): `service-failed`, `service-inactive`, `bridge-disconnect`, `bridge-socket-flap`, `journal-silence`, `turn-hang`. Each has a "fires" path and a "deferred" path.

  Grace-window surface (10+ thresholds the bash code threads through together): `UPTIME_GRACE_SECS=90`, `DISCONNECT_GRACE_SECS=600`, `LIVENESS_GRACE_SECS=30`, `JOURNAL_SILENCE_SECS=4000`, `JOURNAL_SILENCE_HARD_SECS=4000`, `RECENT_ACTIVITY_WINDOW_SECS=3600`, `TURN_HANG_SECS=300`, `JSONL_LIVENESS_SECS=60`, `MAX_RESTARTS_PER_WINDOW=5`, `RESTART_RATE_WINDOW_SECS=1800`, `AUTH_REFRESH_INTERVAL_SECS=600`.

  Required fixtures (minimum): each trigger × (fires / deferred-by-uptime-grace / deferred-by-progress-fresh) = 18 base. Plus interaction edges: trap-zone fixture covering `JOURNAL_SILENCE_SECS × RECENT_ACTIVITY_WINDOW_SECS` interaction (silence age between the two thresholds → no marker; silence age past both → marker → restart after hard window). Rate-cap window fixture (5 restarts inside 1800s → 6th attempt blocks with `restart-rate-capped`). Progress-fingerprint OR-defence fixture (silence-detected AND turn-hang-detected, but JSONL touched within `JSONL_LIVENESS_SECS` → both deferred). `find -mmin` minute-rounding edge fixture (mtime exactly 60s old vs 59s vs 61s, guarding against the 1-min granularity bash uses). Service-state fixtures across `failed`, `inactive`, `activating`, `active`. That lands at ~30 fixtures with explicit named coverage; PR review can grow it from there.

Success: parallel dry-run shows zero divergence for 14 consecutive days **on Linux** AND every fixture passes **on every platform**. Audit trail (`journalctl -t switchroom-watchdog`) preserved bit-for-bit on Linux so existing operator `grep`s keep working there; on Mac/Win, operators read logs via `docker compose logs` or the `switchroom agent logs` shim (Phase 4), which abstracts the platform difference.

**Log hygiene audit — gating acceptance for the journald commit.** Before Phase 3 ships and locks in `--log-driver=journald`, audit every container's stdout/stderr for secret content with a recorded run sheet:

- **Broker:** confirm no vault-key values, no agent OAuth tokens, no full grant rows leak to stdout — only redacted audit-line equivalents (key name + reason + agent + decision). Inspect `src/vault/broker/server.ts` log-call sites; any `logger.info(grant)` style call that includes the resolved value gets redacted before this phase closes.
- **Kernel:** approval prompts and approval bodies must NOT hit stdout — they're potentially sensitive (the prompts users see in approval-required dialogs). Stdout gets the kernel decision (allow/deny) plus the request hash, nothing more.
- **Agent:** claude-side stdout already excludes user message bodies by default, but verify that the gateway's debug logs (when `DEBUG=switchroom:*` is set) don't print full user message contents. The `--log-driver=journald` invariant assumes "no secrets to stdout under any debug flag operators would routinely set."
- **MCP servers:** out of our control — third-party MCP servers may print arbitrary content. Documented mitigation: operators with sensitive-MCP setups can per-service override `logging.driver: local` (file-based, not journald-forwarded) for the affected agent. The compose generator exposes `logging_driver_override:` in the agent stanza for this. Doctor warns when an MCP-emitting agent is on the default `journald` driver and points at the override.

Document the **"no secrets to stdout"** invariant in `reference/operators-guide.md`. Failing the audit blocks the journald commit; we either fix the offending log site or add `logging_driver_override` to default for that container class.

Abort: if porting introduces regressions we can't catch in tests because they're timing-dependent, keep the bash watchdog running against the Docker engine via journald-sourced events on Linux. Ugly but workable, and the journald commitment guarantees that fallback path exists on Linux. Mac/Win have no equivalent fallback — for those, fixture coverage is the only safety net, which is one more reason the fixture suite must be exhaustive.

### Phase 4 — CLI shim + log abstraction + update flow, agent-minutes ≈ 360

> **Status (post-v0.6):** DEFERRED / REMOVED in PR #825 — see Status block at top.

Files: `src/cli/*.ts` for every command that today shells to systemctl, `src/logs/` (new — stdout-tailing shim for non-Linux). Detect runtime mode at startup. Map verbs:

- `switchroom agent restart klanker` → `docker compose restart agent-klanker`
- `switchroom agent logs klanker` → on Linux, `journalctl --user CONTAINER_NAME=switchroom-klanker -f`; on Mac/Win, reads from the rotated bind-mount path (see below).
- `switchroom update` → rolling restart, see below.
- `switchroom hindsight shell` (new) → `docker exec -it agent-<name> sqlite3 /state/agent/.switchroom/hindsight/bank.db`. Preserves the today-UX of `sqlite3 ~/.switchroom/hindsight/bank.db` for operators who poke the bank directly. Without this, `principles.md §1` ("if they need the docs we've failed") fails — because anyone who already has muscle memory for the host-native path now needs to learn `docker exec` invocations. Sibling verb `switchroom bank sqlite` aliases to the same thing for discoverability. The wrapper resolves the right container by agent name, picks the right path inside the container, and falls through transparently to a host `sqlite3` invocation when running in host-native mode.

**Update flow — rolling restart commitment.** `switchroom update` does not bounce the whole fleet at once. Sequence:

```bash
docker compose pull                          # all images, atomic
for agent in $(switchroom list-agents); do
  docker compose up -d --no-deps --force-recreate agent-$agent
  sleep "${SWITCHROOM_UPDATE_GRACE:-30}"     # let the agent settle, broker reconnect, gateway warm
done
docker compose up -d --no-deps vault-broker approval-kernel switchroom-cron  # shared services last
```

The serial loop means at most one agent is down at any moment; the rest of the fleet keeps responding to Telegram throughout. The 30s sleep is configurable per-fleet via `~/.switchroom/.env`; doctor warns if it's set below 15s (gateway re-handshake margin).

**Phase 4 acceptance test for update:** 5-agent fleet running, send a message to each agent every 5s during the update, verify (a) no agent is unresponsive for more than `SWITCHROOM_UPDATE_GRACE` seconds, (b) at no point are 2+ agents simultaneously down, (c) shared services are restarted exactly once at the tail, (d) all 5 agents respond on the new image within `5 × (grace + restart_time)` seconds total. Distinct from the Phase 1 `add agent` acceptance — that one tested non-disturbance during scale-up; this one tests bounded disruption during update.

**Cross-platform log abstraction (`src/logs/`).** Wake-audit and operator log-grep currently rely on `journalctl -t switchroom-watchdog` and `journalctl --user CONTAINER_NAME=...`. Mac/Win Docker Desktop has no host journald (the journal lives in the LinuxKit VM and isn't exposed to host tooling). Spec:

- Each agent container gets a stdout-tailing sidecar baked into `start.sh` — a `node` shim that reads claude/gateway stdout and appends rotated jsonl to `/var/log/switchroom/agent.jsonl` (bind-mounted to `~/.switchroom/logs/<agent>/agent.jsonl` on the host). Rotation: 50 MB × 10 files. Same writer used on Linux too — operators get a consistent jsonl format alongside journald.
- Wake-audit's `journalctl -t switchroom-watchdog` calls become reads against `~/.switchroom/logs/watchdog/audit.jsonl` on non-Linux. The `src/watchdog/` audit writer (Phase 3) emits to both journald (Linux) and the bind-mounted jsonl (every platform).
- `switchroom agent logs` and `switchroom agent logs --since <duration>` route to journalctl on Linux, jsonl tail on Mac/Win. Same UX, two backends.
- Documented in `reference/operators-guide.md`: "logs live at `~/.switchroom/logs/<agent>/agent.jsonl` on every platform; on Linux, the same content is also in journald."

Success: every documented switchroom CLI verb works identically in both modes. Doctor checks pass. `switchroom hindsight shell <agent>` drops into an interactive sqlite prompt against the right bank in both modes without the operator knowing or caring which. `switchroom agent logs` works on Mac/Win/Linux with a single CLI surface.

Abort: if a verb has no Docker equivalent, write the missing command. Don't paper over.

### Phase 5 — migration tooling + e2e, agent-minutes ≈ 400

> **Status (post-v0.6):** DEFERRED / REMOVED in PR #825 — see Status block at top.

Files: `src/cli/migrate-to-docker.ts`, `src/cli/migrate-to-host.ts`, e2e suite. Migration tool reads the existing `~/.switchroom/`, generates compose, validates, performs UID alignment, prompts user to switch.

README install path messaging: **Docker is the default install path for Mac and Linux.** The bare-metal/host-native install path stays fully supported on Linux for operators who prefer it or already have it — no behavioural difference, same product promise. Other platforms (Windows-WSL2, Synology, Unraid, RasPi) work via the same Docker compose file but are best-effort: expected to work, not formally tested or release-gated. Migration tooling and CLI verbs work on those platforms when Docker Desktop or Docker Engine is functional, they're just not part of the validated release matrix. The CLI auto-detects which mode it's in by looking for `~/.switchroom/compose/docker-compose.yml`.

**UID alignment in migration.** Host-native files are owned by the operator's host UID (typically `1000`). Under Docker, agents may run as a different UID (e.g. `1100` per the identity model on Mac/Win where virtiofs translates everything to `1000` regardless, or as `${SWITCHROOM_HOST_UID}` for bind-mounted host paths). Migration must `chown -R` session JSONLs, hindsight banks, and per-agent state to match the destination UID:

- **`migrate to-docker`:** read `SWITCHROOM_HOST_UID` from `~/.switchroom/.env` (prompt and write if absent on Mac/Win). `chown -R $SWITCHROOM_HOST_UID:$SWITCHROOM_HOST_GID ~/.switchroom/agents/ ~/.claude/projects/ ~/.switchroom/logs/`. Fail loudly if any path can't be chowned (likely indicates the operator is on a multi-user box and needs `sudo`).
- **`migrate to-host`:** inverse. `chown -R $(id -u):$(id -g) ~/.switchroom/agents/ ~/.claude/projects/ ~/.switchroom/logs/`. Same fail-loud discipline.
- Both modes write a `migration.log` with timestamps + chown summary, kept under `~/.switchroom/migrations/`.

**Phase 5 acceptance — round-trip e2e.** Beyond cold-install, the migration round-trip is gating:

1. Start on host-native, write a session in agent-klanker (send a message, get a reply, confirm the JSONL has at least 4 turns).
2. `switchroom migrate to-docker`. Verify chown completed, fleet comes up, klanker resumes the same session (`--continue` reads the same JSONL).
3. Send another message to klanker, confirm the session JSONL grew (turn 5+ written under Docker UID).
4. `switchroom migrate to-host`. Verify chown reverses, host-native fleet comes up, klanker continues the same session.
5. Send turn 6+. Confirm continuity end-to-end across both directions.

Failure to complete the round-trip = Phase 5 incomplete.

Success: clean migration from host-native to Docker on a real fleet, AND clean rollback. e2e cold-install matrix is tiered:

- **Mandatory (release gate):** Linux (Docker Engine, bare metal) and Mac (Docker Desktop). Both to "first agent reply in Telegram" in under 5 minutes.
- **Best-effort, not blocking:** Windows-WSL2 (Docker Desktop), Synology DSM, Unraid, RasPi 4 (arm64). These platforms aren't unsupported — they're "expected to work, not formally tested." Migration tooling, the compose file, and the CLI verbs all work on those platforms when Docker is functional; we just don't run them through the release-gate e2e suite. Community-validated bug reports get triaged like any other issue, but they don't block ship.

Round-trip migration test passes on Linux (the only platform where host-native ever ran).

Abort: if Mac Docker Desktop file performance makes the bind-mounted Hindsight SQLite IO unusable (>3x slower than host), reshape volumes to put hot SQLite on Docker-managed volumes and only the user-edited config on bind mounts. Document the layout.

## Risks and mitigations

### Vault broker IPC across container boundaries

Resolved by the per-agent socket directory design (see §"Container identity model"). The broker no longer relies on SO_PEERCRED for primary identity — agent identity is derived from the listening socket path, which is broker-controlled and compose-enforced. Peercred remains as a defence-in-depth UID match.

What's left as a risk:

- **Compose-generator correctness.** The whole model collapses if the generator ever mounts agent-A's broker socket volume into agent-B. Mitigation: unit test on `src/agents/compose.ts` asserts the per-agent-volume-mounts-into-one-service invariant for every generated compose. Doctor check `--check cross-agent-mounts` greps the live compose. CI gate. Operator hand-edits that violate it fail doctor.
- **HMAC fallback (only if Phase 0 surfaces something we didn't predict).** If per-agent socket directories prove unworkable on one of the four target environments, fall back to HMAC tokens with a full lifecycle: broker generates a token bundle on startup (rotating per-agent tokens, written to `/run/secrets/<agent>-broker-token` mode 0400 owned by that agent's UID), agents read at connect time, broker revokes all tokens on its own restart (forcing agents to re-fetch on first 401). Token replay across broker restarts: by construction impossible — broker startup invalidates the prior bundle. No design work needed up-front, but the spec is here so Phase 0 has a known fallback to argue against if the primary design fails.
- **Broker container unhealthy.** Every agent's vault resolution fails fast with a typed error ("vault broker unavailable, retry in N seconds"). Health check + `restart: unless-stopped` keeps the broker bouncing. Agents don't crash — they degrade to "vault refs return errors" until the broker is back. Acceptable degradation; vault-using calls were already going to fail.

### tmux interrupt path

The `!` interrupt arrives at the gateway process. Gateway and claude REPL are **in the same container**, same tmux socket at `/tmp/tmux-1000/<agent>`. `tmux send-keys C-c` is a local IPC call. No container boundary crossed. This is the whole reason we picked one-container-per-agent over single-container-many-agents — it keeps the interrupt path identical to today's host-native model.

Validate in Phase 0. If this doesn't work, the design is wrong and we restart.

### Watchdog rewrite — porting bash logic to TS without losing fidelity

> **Status (post-v0.6):** DEFERRED / REMOVED in PR #825 — see Status block at top.

`bin/bridge-watchdog.sh` has 967 lines of accumulated edge-case handling. Rewriting it from scratch is a translation problem, and translations introduce bugs.

Mitigations (committed in Phase 3):
- **Log driver: `--log-driver=journald` on every container, on Linux hosts.** This is the load-bearing decision for the Linux validation path. With journald forwarding in place, the bash watchdog's existing `journalctl` queries continue to return signal, which is what makes the parallel dry-run a real comparison rather than a tautology on Linux. On Mac/Win (Docker Desktop, no host journald), the parallel-run claim does not apply — see Phase 3 for the platform split.
- **Parallel dry-run for 14 days, Linux hosts only.** Both watchdogs run, neither acts (log-only). Action-stream divergence is investigated and resolved before either is allowed to act.
- **Fixture suite, every platform.** Recorded event streams + log tails + expected actions for every restart reason. Runs on every PR across the Linux/Mac/Win CI matrix. This is the only safety net on Mac/Win, so coverage must be exhaustive.
- Audit trail (`journalctl -t switchroom-watchdog`) shape preserved bit-for-bit on Linux so existing operator `grep`s keep working there. Mac/Win operators use `switchroom agent logs` (Phase 4) which abstracts the platform difference.

### Sub-agent dispatch (Agent tool)

When the parent agent dispatches a sub-agent, claude spawns a child claude process **in the same container**. Cgroup limits apply to the whole container, so 5 parallel sub-agents inside agent-klanker share klanker's 2GB. That matches the host-native model exactly. No new failure mode.

Risk: aggressive parallel sub-agent fan-out could OOM the container mid-turn. Today on the host it OOMs the whole host. Tomorrow in Docker it OOMs only that agent's container, the watchdog restarts it, the audit trail captures the crash. That's a strict improvement.

Mitigation: default mem_limit per agent should be calibrated. See "resource limits as foot-guns" below.

### Resource limits as foot-guns

Set the limit too low: agents get OOM-killed mid-turn, user sees "agent restarted" cards way too often. Set it too high: defeats the point.

Defaults proposal, derived from observed RSS on the current production fleet plus 50% headroom over peak:

| Class | Observed RSS (typical) | `mem_limit` | `cpus` |
|---|---|---|---|
| klanker (Opus 4.7, sub-agent fan-out) | 648 MB idle, peak ~3.8 GB | `6g` | 2.0 |
| conversational (clerk, finn, carrie) | 370–420 MB | `1.5g` | 1.0 |
| lightweight (gymbro, reggie, ziggy) | 290–330 MB | `1g` | 0.5 |
| coding/worker/researcher | 400–700 MB under load | `2g` | 2.0 |

Klanker's 6 GB is **not** a typo — the previous draft's 4 GB was based on idle measurement and would have OOM-killed the container during routine sub-agent fan-outs (observed peak ~3.8 GB plus dispatch overhead lands well above 4 GB). Conversational's 1.5 GB likewise gives ~3x headroom over typical, accommodating the spikes during long stream-replies and progress-card edits.

Numbers go in `profiles/<profile>/profile.yaml`, override at the agent level. `switchroom doctor` warns if a 24h watchdog window shows OOM kills — that's the signal to bump the limit. Operators on tight-memory hosts (RasPi 4 with 4 GB total) can lower limits explicitly; the doctor also warns if `sum(mem_limit) > 0.8 * host_total`.

### Docker Desktop on Mac and Windows

Three real, documented problems:

1. **Bind-mount file performance.** `~/.claude/projects/<agent>/sessions/*.jsonl` gets appended on every turn, and Hindsight's SQLite does heavy reads/writes. On Mac Docker Desktop with `osxfs`/`virtiofs`, bind-mount throughput is famously poor. Mitigation: hot data (claude session JSONLs, Hindsight bank, SQLite) lives on Docker-managed named volumes. User-edited files (compose.yml, agent config, logs) stay on bind mounts. This needs measurement in Phase 5.
2. **Networking.** Telegram long-polling against `api.telegram.org` from inside a container is plain outbound HTTPS — works on every Docker engine including Desktop. No special routing. The OAuth loopback redirect (`localhost:port`) needs `--network host` (Linux) or a published port (Mac/Windows). Document both.
3. **cgroup v1 vs v2.** Docker Desktop for Mac is v2. Linux hosts are mixed. Memory limit semantics differ slightly (swap accounting). The TS watchdog reads `docker stats` which abstracts this, so we don't care at the watchdog layer. We do care at the kernel layer for OOM triggers — test on both.

### Rootless Docker

Vault broker socket cross-container: works as long as both containers are in the same Docker daemon's user namespace, which is the default. If a user runs the broker in a rootful daemon and an agent in rootless, peercred breaks. Detect this in `switchroom doctor` and refuse to bring the fleet up with a clear message.

### Logs survive container restart

Two paths for any given log:
- High-frequency, ephemeral: `docker logs <container>` — survives container restart, lost on `docker rm`. Fine for stdout/stderr noise.
- Audit-grade: bind-mount `~/.switchroom/logs/<agent>/` into the container, agent writes structured logs there. Survives anything short of host disk loss.

`clean-shutdown.json`, watchdog audit trail, card-event-log — all bind-mounted. Same audit guarantees as today.

### Approval kernel state

`kernel.db` (SQLite) holds in-flight approval grants. If the kernel container restarts, in-flight approvals must survive. Mitigation: bind-mount `~/.switchroom/approvals/` into the kernel container. Same persistence model as today's kernel that lives in the broker process.

### Per-agent CLAUDE_CONFIG_DIR isolation

Each agent gets `~/.claude/projects/<agent>` bind-mounted as `/state/.claude` inside its container. Sessions, MCP cache, OAuth tokens are per-agent already on host-native, this just moves the boundary. No behavioural change.

### Multi-arch (amd64 + arm64)

claude CLI ships universal binaries. node and bun ship arm64. tmux + tini are trivial. The image build matrix is `{linux/amd64, linux/arm64} × {base, agent, broker, kernel}` = 8 builds per release, parallelised in GH Actions. CI gate: smoke test on both arches before publishing the manifest.

Apple Silicon: native arm64. RasPi 4/5: native arm64. AWS Graviton: native arm64. All work.

### Compose file as source of truth

`switchroom add agent` must update compose AND start the container. Same idempotency rules as `reconcile` today: read config cascade, regenerate full compose, `docker compose up -d --no-deps <changed-services>`. Rollback: `~/.switchroom/compose/docker-compose.yml.bak.<timestamp>` written before every reconcile, last 10 kept. `switchroom rollback` swaps back and re-`up`s.

### Update flow

Today: `switchroom update` does a `git pull` against the in-tree checkout, runs build, restarts services. In Docker: `docker compose pull && docker compose up -d` (image-tag-pinned per release). The CLI detects which mode it's in by looking for `~/.switchroom/compose/docker-compose.yml` and routes accordingly. Both modes preserved.

### Networking inside Docker

Outbound to api.telegram.org: bridge network, NAT'd through the host. Long polling works. Latency adds <5ms vs host-native. Inbound: we don't need any. Telegram is poll-only by default. If a future feature uses webhooks, it'd need a published port — that's a per-deployment operator choice, not a default.

### Performance — bind-mount IO on Docker Desktop

Hindsight's SQLite is the heaviest IO surface. On Mac Docker Desktop, bind-mounted SQLite has been measured at 3-10x slower than native, varying by virtiofs version. Mitigation: hindsight bank goes on a Docker-managed named volume (`hindsight-data`), bind-mounted only for user backups via `docker run --rm -v hindsight-data:/src busybox tar czf -`. This is the single biggest open question in Phase 5 — needs real measurement before we commit.

### Single point of failure — vault broker container

The broker is now a discrete container. If it's down, every agent's vault resolution fails. Mitigations:
- `restart: unless-stopped` + healthcheck. Crashloop is auto-recovered.
- Agents tolerate broker-unavailable: vault refs return a typed error, agent surfaces it, retry on next turn. Already the behaviour today (broker can be slow / restarting under host-native).
- Doctor checks broker health on every CLI invocation.

Same story for the approval kernel.

### #786 PreToolUse labels in a containerised world

The PreToolUse hook (#786) is wired in `settings.json` as a path to a shell script the harness exec's before each tool call. Today that path is host-side (e.g. `~/.switchroom/hooks/pretool-label.sh`). Inside a container, host paths don't exist, and the harness inside the container will fail to exec the hook unless we plan for it.

Wiring under Docker:
- The hook script is rendered into the agent's bind-mounted config directory (`~/.switchroom/agents/<name>/hooks/pretool-label.sh`), which mounts to `/state/agent/hooks/` inside the container. The generated `settings.json` references the in-container path: `"PreToolUse": "/state/agent/hooks/pretool-label.sh"`.
- The hook runs inside the container under the same UID as `claude` (UID 1000), with `PATH` set in `start.sh` to include `/usr/local/bin` and `/state/agent/bin`. If the hook needs `gh`, `git`, or other CLI tools, those ship in `Dockerfile.agent`.
- The hook's environment receives `SWITCHROOM_RUNTIME=docker` so existing host-native logic that branches on path layout can disambiguate.
- Fallback: if `/state/agent/hooks/pretool-label.sh` is missing or non-executable at hook-fire time, the harness logs a one-line warning to the agent's stdout (captured by journald per the Phase 3 log-driver decision) and proceeds without labelling. We do not block tool calls on hook failure — that's the same fail-open behaviour as host-native today.

Phase 1 acceptance: PreToolUse labels appear on agent activity in a containerised fleet identically to host-native.

### OAuth token threat model

`~/.claude/projects/<agent>/` bind-mounts into each agent container at `/state/.claude`. That directory contains the OAuth refresh token claude uses to talk to Anthropic. Today, host-native, the file is protected by host UID permissions: only the user running switchroom can read it.

In Docker, the file crosses the container boundary. The threat surface widens in one specific way: **any container that mounts that volume can read the refresh token.** Compose is the gatekeeper. The discipline:

- **Each agent's `~/.claude/projects/<name>` is mounted into that agent's container only.** Never shared between agents. Never mounted into broker, kernel, or watchdog containers.
- The compose generator (`src/agents/compose.ts`) enforces this — the bind-mount line for `~/.claude/projects/<name>` only appears under `agent-<name>:`. A test asserts this invariant on every regenerated compose.
- Inside the container, the directory is owned by UID 1000 with `0700` perms, same as host.
- Operators who hand-edit the generated compose to share `~/.claude/projects` across containers are explicitly warned in the file header. Doctor flags it.

A compromised container reading its own agent's token is no worse than a compromised host process reading the host file — the threat model is unchanged for that case. A compromised broker or kernel container reading agent tokens **would** be a regression; the per-agent-only mount discipline prevents it.

## Migration story (v0.6)

There is no in-place migration tool. Operators on the legacy systemd installation perform a clean re-install:

1. Stop existing systemd units: `systemctl --user stop 'switchroom-*'`.
2. Disable: `systemctl --user disable 'switchroom-*'`.
3. Run `switchroom up` (defaults to Docker on Linux).
4. To roll back: stop the Docker fleet (`docker compose down`), re-enable + start the systemd units, OR run `switchroom up --legacy` if you've kept the legacy units installed.

No marker file, no advisory, no `switchroom migrate` command. The `--legacy` flag on `switchroom up` is a plain branch selector that runs the systemd path.

## Alternatives considered

### Option 1 — Docker-wrap-current-architecture (one big container, systemd inside)

Build a Debian image with systemd as PID 1, run the existing systemd units inside, mount everything as one volume. **Rejected.** systemd-in-Docker requires `--privileged` or hand-tuned cgroup mounts, which is a Docker anti-pattern and a rootless-Docker non-starter. We'd be shipping a worst-of-both-worlds image: still Linux-only in spirit, just hidden inside a container.

### Option 2 — Single Node supervisor, all agents in one container

Replace systemd with a TS supervisor process that spawns and manages every agent's claude REPL as a child process inside one container. **Rejected.** Fails the "always-on, auto-recovery" outcome: OOM in one agent kills the whole container, taking the rest of the fleet with it. Per-agent resource isolation impossible without cgroup gymnastics. Single-process model also forces every agent's tmux session into one tmux server, which complicates the `!` interrupt path and weakens the "see every step" promise. The "compose multiplies image overhead" worry from #793 is actually small (one image, multiple containers — pages of memory shared).

### Option 3 — One container per agent + compose (this RFC)

Picked. Per-agent isolation native to Docker. Existing tmux/gateway model stays intact. Compose is a real ops format with a real ecosystem. The cost is 4 Dockerfiles and a watchdog rewrite.

### Control-plane-runner architecture

A long-lived control-plane container that drives ephemeral per-task runner containers. **Rejected.** Switchroom agents are persistent (long-running tmux + claude --continue), not task-shaped. The control-plane-runner shape is right for batch / CI workloads, wrong for "persistent conversational agent." Shoehorning it would force a session-resumption model we don't need and don't want.

## Open questions

These need spike-validation in Phase 0, not paper analysis.

1. Peercred semantics under rootless Docker on Mac Docker Desktop's specific virtiofs setup. I believe it works. I haven't proved it.
2. Hindsight SQLite IO on Mac Docker Desktop bind mount vs named volume — quantified throughput numbers, not vibes.
3. tmux send-keys behaviour when the gateway and the claude process are in the same container but the tmux server was started by `start.sh` under tini's supervision. Should be fine — tmux is a normal client/server unix-socket dance — but spike to confirm.
4. claude CLI OAuth on Windows Docker Desktop with WSL2 backend. Loopback ports and WSL2 networking have edge cases.

(The `switchroom add agent` reconcile-then-up race that previously sat here is now a Phase 1 acceptance test, not a deferred question.)

## Decision criteria

Abandon this plan and pivot if any of these hit:

- Phase 0 spike fails on tmux interrupt or peercred on Linux (rootful or rootless). Both are load-bearing. No acceptable workaround = no project.
- Mac Docker Desktop file IO on the Hindsight bank is more than 3x slower than host-native and named volumes don't fix it. Mac is a supported v1.0 target; sub-usable Mac performance is a ship blocker for the v1.0 release matrix, not just a Mac-only concern.
- Watchdog port falls behind the bash watchdog in detected-incident parity for >3 weeks on Linux. We cannot regress reliability for a refactor.

Tradeoff calls (decide, don't pivot):

- **Mac validation slips past the v1.0 ship date.** Hardware delays, virtiofs redesign drags, peercred fails on Mac and the workaround needs more time — any of these. Decision: either (a) **slip Mac to v1.1** and ship Linux-only as v1.0 (Mac install path documented as "coming, beta"), or (b) **hold v1.0** until Mac passes. Default lean is (a) — Linux is the substrate the existing fleet runs on and Mac users are not currently served by switchroom anyway, so shipping Linux-on-Docker without Mac is still a strict improvement over today. Pick at the time based on how close Mac is. **If decision (a) fires, the supported-target language elsewhere in this RFC (Summary line, Goals, Motivation paragraph, the install-path README block) re-resolves to Linux-only for v1.0; the Mac language ships in v1.1 release notes when validation completes.** This RFC's "Linux + Mac" framing is the intent under the default ship plan — it is not a promise that survives a Mac slip.
- Multi-arch image build instability on arm64 in CI for >2 weeks. RasPi/homelab is best-effort, not release-gating, so this doesn't pause the plan — it just means the arm64 image stays "build it yourself" until CI stabilises. Document, move on.

If none of the abandon criteria hit, the plan ships.

## Vision and product copy

Already done. PR #796 rewrote `reference/vision.md`, `reference/principles.md`, the README, and `docs/vs-openclaw.md` to be substrate-agnostic — the product promise is the JTBD outcomes (long-running service, survives reboots, auto-recovery, OAuth under your subscription, stock `claude` CLI), with no commitment to systemd or Docker either way. This RFC implements the substrate change behind that copy.

Light touch needed: the substrate-agnostic copy already squares with the tiered-platform reality. The JTBD framing "runs on the box you already have" remains accurate — Linux and Mac are the supported install targets for v1.0; Windows, Synology, Unraid, and RasPi work in principle and may work for you, but aren't formally validated. Don't rewrite vision.md to enumerate the tiers — the substrate-agnostic framing is correct and shouldn't list operating systems by name. The release notes for v1.0 are where the supported-vs-best-effort split gets stated explicitly. No further RFC-driven edits to vision/principles/README.
