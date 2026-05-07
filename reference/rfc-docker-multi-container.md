---
title: One container per agent + docker compose
status: Draft
audience: switchroom maintainers, anyone considering picking this up
related: #793 (parent epic), #788, #776 (status-card RCAs that the per-agent process model touches), #786 (PreToolUse labels — must keep working), #725 (tmux supervision — load-bearing under this design)
source: research output for issue #793, "Option 3" of the comparison
---

# RFC: one container per agent, docker compose for the fleet

## Summary

Switchroom today is a Linux-only host install. Multi-OS reach is the point of #793 and Docker is the obvious substrate. This RFC picks Option 3 from the comparison: **one container per agent, plus a small set of shared-service containers (vault broker, approval kernel, telegram bridge), all wired together by a generated `docker-compose.yml`**. The user-visible end state is `switchroom setup` produces a compose file, `docker compose up -d` brings the fleet alive, and the README install path is one block of shell on Mac, Windows-WSL2, Synology, Unraid, RasPi, and Linux. The host-native install stays supported alongside it. Both deliver the same product promise.

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

The user-visible change is reach. Today switchroom installs cleanly on Linux. After this RFC it installs cleanly on Mac, Windows-WSL2, Synology, Unraid, RasPi, and Linux — same product promise on every box. That's the JTBD win. Whether the agent runs under a systemd unit or a Docker container is the CLI's problem, not the user's.

The OpenClaw wedge — stock `claude` CLI under your Pro/Max subscription, not a custom runtime against your API key — is unchanged. The container runs the unmodified `claude` CLI against the user's OAuth, exactly as the systemd unit does today. The substrate swap is invisible to that wedge.

## Goals

- One install command on Mac, Windows-WSL2, Linux, and ARM homelab boxes (Synology, RasPi 4/5, Apple Silicon).
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
                 │   │ agent-…        │                   │
                 │   └────────────────┘                   │
                 └────────────────────────────────────────┘
```

### Per-agent container

PID 1 is `tini`. tini reaps zombies, forwards signals, and exits clean. Under tini, `start.sh` (rendered from `profiles/_base/start.sh.hbs`, today 383 lines) does what it does now: env setup, tmux session spawn, claude attach. Inside tmux, `claude --continue` runs against `CLAUDE_CONFIG_DIR=/state/.claude/<agent>`. The telegram gateway runs as a sibling process inside the same container — same as today's per-agent `telegram-plugin/server.ts` (171 lines). Same FIFO queue, same stream-reply path, same tmux-send-keys interrupt handler.

The per-agent container is the only place we need to keep tmux. The `!` interrupt path stays local: gateway and claude are in the same container, same tmux socket at `/tmp/tmux-<uid>/<agent>`. `tmux send-keys C-c` works exactly as it does today. We do not cross a container boundary for the interrupt.

### Vault broker container (singleton)

Today: `src/vault/broker/server.ts` (1440 lines), peercred-authenticated unix socket at `~/.switchroom/vault-broker.sock`, ACL-driven, audit-logged. The broker authenticates by SO_PEERCRED — kernel-vouched (uid, pid, gid) of the connecting process.

In Docker: one broker container, one named volume (`switchroom-broker-sock`) mounted at the broker socket directory, every agent container also mounts the same volume read-write. Peercred over unix sockets in Docker works as long as the namespaces line up — see Risks. The broker's SQLite (audit log + grants DB) lives on a persistent volume.

### Approval kernel container (singleton)

`src/vault/approvals/kernel.ts` (564 lines), today an in-process module the broker server talks to. In Docker: separate container, IPC over a shared volume (same model as the broker socket) or via the broker as a proxy. The kernel's SQLite must survive container restart — that's a volume too.

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

### Compose skeleton

```yaml
# generated by `switchroom reconcile` — do not edit by hand
version: "3.9"

x-agent-defaults: &agent-defaults
  image: ghcr.io/switchroom/agent:0.7.0
  init: false                            # tini is PID 1 inside
  restart: unless-stopped
  depends_on:
    vault-broker: { condition: service_healthy }
    approval-kernel: { condition: service_healthy }
  volumes:
    - broker-sock:/run/switchroom
    - kernel-sock:/run/switchroom-kernel
    - ~/.claude/projects:/state/.claude
  environment:
    SWITCHROOM_BROKER_SOCKET: /run/switchroom/broker.sock

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
    mem_limit: 2g
    cpus: 2.0
    volumes:
      - broker-sock:/run/switchroom
      - kernel-sock:/run/switchroom-kernel
      - ~/.switchroom/agents/klanker:/state/agent
      - ~/.claude/projects/klanker:/state/.claude
      - ~/.switchroom/logs/klanker:/var/log/switchroom

  agent-coach:
    <<: *agent-defaults
    container_name: switchroom-coach
    mem_limit: 1g
    cpus: 1.0
    # ...

volumes:
  broker-sock:
  kernel-sock:
```

`switchroom reconcile` regenerates this whole file from `switchroom.yaml`, the same way it regenerates systemd units today. Hand edits get clobbered. There's a `# generated by` warning at the top.

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

Estimates assume Opus 4.7, supervised by a separate-process reviewer. Total budget across phases ≈ **2000 agent-minutes** (Phase 3 reweighted from 300 → 500-600 to reflect the 967-line bash port plus 5 grace windows, fixture suite, and parallel-run comparison).

### Phase 0 — spike, agent-minutes ≈ 120

Files: `Dockerfile.base`, throwaway compose, `docs/phase0-peercred-matrix.md` (deliverable). Goal: prove three things, in this order:

1. claude CLI runs in `linux/amd64` and `linux/arm64` images, OAuth headless flow completes. (#793 q4)
2. Two agent containers can both connect to a single broker container's unix socket via shared named volume, peercred works, ACL-gated grants resolve. **Produce a written test matrix** covering all four target environments below.
3. tmux send-keys C-c from the gateway process inside the container reaches claude in the same container's tmux pane. `!` interrupt loop end-to-end.

**Peercred test matrix (deliverable, not optional).** For each environment, run `getsockopt(SO_PEERCRED)` from the broker against a connection from an agent container and capture the actual `(uid, pid, gid)` returned. Also record the Docker Desktop version and the virtiofs version on Mac/Windows rows — peercred has historically regressed on specific virtiofs releases, and pinning the working/broken pairs is the only way to detect a future Docker Desktop update silently breaking us. Record values verbatim in `docs/phase0-peercred-matrix.md`:

| Environment | Docker Desktop ver | virtiofs ver | uid returned | pid returned | gid returned | ACL resolves correctly? |
|---|---|---|---|---|---|---|
| Docker Desktop Mac (latest, virtiofs) | | | | | | |
| Docker Desktop Windows / WSL2 backend | | | | | | |
| Linux rootless Docker, userns-remap ON | n/a | n/a | | | | |
| Linux rootful Docker, default config | n/a | n/a | | | | |

Acceptance criteria: every row produces a non-zero, non-garbage `(uid, pid)` AND the broker's ACL check resolves to the correct agent identity. If any row returns `0`, an unspecified value, or a uid that doesn't map to a known agent, the HMAC token fallback (see Risks) **must undergo an explicit ACL-narrowing security review before it lands** — peercred's "kernel-vouched" property is exactly what the broker's threat model relies on, and a token-handshake fallback weakens it. The review covers: token issuance flow, token storage (where on disk, what permissions), revocation on agent restart, and per-agent ACL scoping.

Abort criteria: (a) any of (1)(2)(3) doesn't work and the workaround is `--privileged` or host-level UID remap — non-starters. (b) Two or more matrix rows return broken peercred AND the security review concludes the HMAC fallback can't preserve the current ACL granularity — pivot to a different IPC design or pause the RFC.

### Phase 1 — Dockerfiles + compose generator, agent-minutes ≈ 360

Files: 4 Dockerfiles, `src/agents/compose.ts`, tests. Generate compose from the existing config cascade. Cover defaults, profiles, per-agent overrides, vault refs, mem/cpu limits.

Success: `switchroom reconcile` writes a compose file that `docker compose config` validates and `docker compose up -d` runs. Three agents up, all responding in Telegram.

**Acceptance test (promoted from Open Questions): `switchroom add agent` reconcile-then-up race.** Adding a new agent must update compose AND start the new container without disturbing existing ones. Test: 3-agent fleet running, send a message to agent-A every 2s, run `switchroom add agent newbie` concurrently, verify (a) agent-A's response stream is uninterrupted, (b) `docker compose up -d --no-deps agent-newbie` only touches the new service, (c) no broker/kernel restart, (d) newbie reaches "first reply in Telegram" within 60s. Failure to pass = Phase 1 incomplete, regardless of other criteria.

Abort: if compose generation can't cleanly express the cascade and we end up with post-render shell munging, stop and rethink.

### Phase 2 — volume + IPC contract, agent-minutes ≈ 240

Files: `src/vault/broker/peercred.ts` Docker branch, `src/vault/approvals/client.ts` socket-path resolver. Goal: vault refs + approval grants work identically inside-Docker and host-native, exercised by the existing test suite.

Success: every existing vault + approval test passes against a live broker container via testcontainers.

**Schema-stability invariant.** Phase 2 **must not change the vault broker SQLite layout** (grants table, audit-log table, indices, triggers — all frozen). The migration tool relies on `switchroom migrate to-host` reading the same DB the host-native broker reads. Any schema change here breaks the rollback path and turns migration into a one-way door. If a schema change is genuinely required, it gets its own RFC and ships ahead of Docker migration with paired up/down migrations and a parallel-read test. Same invariant applies to the approval kernel's SQLite (`kernel.db`).

Abort: if peercred-in-Docker requires user namespace remapping that breaks rootless setups, fall back to a token-based broker auth path. Document the security tradeoff (see Phase 0 ACL-narrowing review).

### Phase 3 — watchdog port, agent-minutes ≈ 550

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
- **Fixture suite — every platform.** Every documented restart reason gets a recorded `(docker events stream + docker logs tail + docker stats sample)` triple plus an expected action. Fixtures live in tree, run on every PR across Linux/Mac/Win CI matrices. Targets: 5 grace windows × at minimum 3 trigger paths each = 15+ fixtures.

Success: parallel dry-run shows zero divergence for 14 consecutive days **on Linux** AND every fixture passes **on every platform**. Audit trail (`journalctl -t switchroom-watchdog`) preserved bit-for-bit on Linux so existing operator `grep`s keep working there; on Mac/Win, operators read logs via `docker compose logs` or the `switchroom agent logs` shim (Phase 4), which abstracts the platform difference.

Abort: if porting introduces regressions we can't catch in tests because they're timing-dependent, keep the bash watchdog running against the Docker engine via journald-sourced events on Linux. Ugly but workable, and the journald commitment guarantees that fallback path exists on Linux. Mac/Win have no equivalent fallback — for those, fixture coverage is the only safety net, which is one more reason the fixture suite must be exhaustive.

### Phase 4 — CLI shim, agent-minutes ≈ 240

Files: `src/cli/*.ts` for every command that today shells to systemctl. Detect runtime mode at startup. Map verbs:

- `switchroom agent restart klanker` → `docker compose restart agent-klanker`
- `switchroom agent logs klanker` → `docker compose logs -f agent-klanker`
- `switchroom update` → `docker compose pull && docker compose up -d`
- `switchroom hindsight shell` (new) → `docker exec -it agent-<name> sqlite3 /state/agent/.switchroom/hindsight/bank.db`. Preserves the today-UX of `sqlite3 ~/.switchroom/hindsight/bank.db` for operators who poke the bank directly. Without this, `principles.md §1` ("if they need the docs we've failed") fails — because anyone who already has muscle memory for the host-native path now needs to learn `docker exec` invocations. Sibling verb `switchroom bank sqlite` aliases to the same thing for discoverability. The wrapper resolves the right container by agent name, picks the right path inside the container, and falls through transparently to a host `sqlite3` invocation when running in host-native mode.

Success: every documented switchroom CLI verb works identically in both modes. Doctor checks pass. `switchroom hindsight shell <agent>` drops into an interactive sqlite prompt against the right bank in both modes without the operator knowing or caring which.

Abort: if a verb has no Docker equivalent, write the missing command. Don't paper over.

### Phase 5 — migration tooling + e2e, agent-minutes ≈ 300

Files: `src/cli/migrate-to-docker.ts`, e2e suite. Migration tool reads the existing `~/.switchroom/`, generates compose, validates, prompts user to switch.

README install instructions cover both paths side by side: Docker (the default for new installs because it works on every supported OS) and host-native (still fully supported, no behavioural difference, picked by operators who prefer it or already have it). Both deliver the same product promise. The CLI auto-detects which mode it's in by looking for `~/.switchroom/compose/docker-compose.yml`.

Success: clean migration from host-native to Docker on a real fleet. e2e: cold install on Mac (Docker Desktop), Windows (WSL2 + Docker Desktop), RasPi 4 (arm64). All three to "first agent reply in Telegram" in under 5 minutes.

Abort: if Mac Docker Desktop file performance makes the bind-mounted Hindsight SQLite IO unusable (>3x slower than host), reshape volumes to put hot SQLite on Docker-managed volumes and only the user-edited config on bind mounts. Document the layout.

## Risks and mitigations

### Vault broker IPC across container boundaries

The broker authenticates connecting clients via SO_PEERCRED. In Docker, when both client and server containers share a named volume containing a unix socket, peercred returns **the `(uid, pid)` the broker process observes via its own `getsockopt(SO_PEERCRED, ...)` call against the agent-side connection** — which works as long as both containers run as the same UID inside their own user namespaces (or both share the host user namespace, which is the default). The Phase 0 matrix captures ground truth per environment; this paragraph is just framing.

Mitigations:
- Default: both containers run as UID 1000, no user namespace remapping. Simple, works on every Docker engine I've checked.
- Rootless Docker (Mac Docker Desktop, Linux rootless): both containers share the same remapped UID. Peercred still works because they're in the same user namespace.
- Hard mode: if user namespace remapping is enabled per-container, peercred values are meaningless. Add a fallback to a HMAC token handshake (broker issues per-agent tokens at start, agents present them on connect). This is not the default path.

If the broker container is unhealthy: every agent's vault resolution fails fast with a clear error ("vault broker unavailable, retry in N seconds"). Health check + `restart: unless-stopped` keeps the broker bouncing. Agents don't crash — they degrade to "vault refs return errors" until the broker is back. This is acceptable degradation; vault-using calls were already going to fail.

### tmux interrupt path

The `!` interrupt arrives at the gateway process. Gateway and claude REPL are **in the same container**, same tmux socket at `/tmp/tmux-1000/<agent>`. `tmux send-keys C-c` is a local IPC call. No container boundary crossed. This is the whole reason we picked one-container-per-agent over single-container-many-agents — it keeps the interrupt path identical to today's host-native model.

Validate in Phase 0. If this doesn't work, the design is wrong and we restart.

### Watchdog rewrite — porting bash logic to TS without losing fidelity

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

Defaults proposal:
- coding/worker/researcher agents: `mem_limit: 2g`, `cpus: 2.0`
- conversational/coach/exec-assistant: `mem_limit: 1g`, `cpus: 1.0`
- klanker (Opus 4.7, agentic, sub-agents): `mem_limit: 4g`, `cpus: 2.0`

These come from `docker stats` against the current host fleet under typical load + 50% headroom. Numbers go in `profiles/<profile>/profile.yaml`, override at the agent level. `switchroom doctor` warns if a 24h watchdog window shows OOM kills — that's the signal to bump the limit.

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

## Migration story

Existing host-native install. Both paths deliver the same product promise, so migration is opt-in — no pressure to move, no deprecation timer. Operators move when they want to (new box, want per-agent cgroup limits, want one install script across Mac/Linux/Pi). Steps below are for operators who've decided to switch.

```bash
# 1. Take a backup. Always.
tar -czf ~/switchroom-backup-$(date +%F).tar.gz ~/.switchroom ~/.claude/projects

# 2. Install Docker (Linux: convenience script; Mac/Windows: Docker Desktop).
curl -fsSL https://get.docker.com | sh   # Linux only
# or: install Docker Desktop from docker.com on Mac/Windows

# 3. Stop host-native fleet.
switchroom stop --all

# 4. Run the migration tool.
switchroom migrate to-docker
#  - reads ~/.switchroom/, generates compose, validates
#  - prints a diff of what will change
#  - on confirm: writes compose, pulls images, brings fleet up
#  - on first message in Telegram: confirms each agent end-to-end

# 5. Verify.
switchroom doctor
switchroom status

# 6. (Optional) Clean up host-native artifacts.
systemctl --user disable --now 'switchroom-*'
```

Rollback: `switchroom migrate to-host` reverses it. systemd units regenerated, agents restarted on host. State is preserved on the volumes; nothing is destroyed during migration.

Estimated migration time for a 5-agent fleet: 10 minutes including the image pull on first run. Subsequent restarts: seconds.

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

- Phase 0 spike fails on tmux interrupt or peercred. Both are load-bearing. No acceptable workaround = no project.
- Mac Docker Desktop file IO on the Hindsight bank is more than 3x slower than host-native and named volumes don't fix it. The product is sub-usable on Mac and that's half the audience.
- Multi-arch image build is unstable on arm64 in CI for >2 weeks. We can't ship a "works on Pi" promise we can't honour.
- Watchdog port falls behind the bash watchdog in detected-incident parity for >3 weeks. We cannot regress reliability for a refactor.

If none of those hit, the plan ships.

## Vision and product copy

Already done. PR #796 rewrote `reference/vision.md`, `reference/principles.md`, the README, and `docs/vs-openclaw.md` to be substrate-agnostic — the product promise is the JTBD outcomes (long-running service, survives reboots, auto-recovery, OAuth under your subscription, stock `claude` CLI), with no commitment to systemd or Docker either way. This RFC implements the substrate change behind that copy. No further doc edits required from this RFC.
