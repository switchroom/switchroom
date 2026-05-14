# Switchroom Architecture

## The short version

One Claude Code REPL per agent, dressed up with Docker Compose and a Telegram bot. Each agent is an unmodified `claude` CLI process running interactively inside its own container, with a separate long-lived gateway process that owns the Telegram connection. Everything else — memory, MCP tools, scheduling — layers on top of that pair.

The runtime is Docker on Linux.

---

## Per-agent process model (containers)

A switchroom fleet is a small set of containers wired together by a generated `docker-compose.yml` (`~/.switchroom/compose/docker-compose.yml`). Four published images on GHCR cover the whole stack:

- `ghcr.io/switchroom/switchroom-base` — shared base layer
- `ghcr.io/switchroom/switchroom-agent` — the per-agent claude REPL (also runs the in-container scheduler sibling for that agent's scheduled tasks)
- `ghcr.io/switchroom/switchroom-broker` — vault broker
- `ghcr.io/switchroom/switchroom-kernel` — approval kernel

Per agent, compose brings up:

- `switchroom-<agent>` — the agent container (claude REPL + gateway + telegram MCP + agent-scheduler sidecar, single-spine process tree under `tini` as PID 1).

Plus shared services per host: `switchroom-vault-broker` (vault) and `switchroom-approval-kernel` (approval grants). All containers run with `restart: unless-stopped`. Compose is the supervisor — a crashed agent is brought back automatically.

> **Cron-fold-in note.** Older releases shipped a singleton `switchroom-cron` container that fired every agent's scheduled tasks via `docker exec`. As of v0.8 (Phase 4 of the cron-fold-in), cron runs in-container in every agent as a sibling of the gateway, delivering fires through the same `InboundMessage` IPC path Telegram uses (synthesized turns tagged `meta.source="cron"`). The singleton image and container were removed in that cutover.

### Inside the agent container

The container's entrypoint is the agent's `start.sh`, run as PID 1's child under `tini`. `start.sh` invokes claude with flags like:

```bash
exec claude \
  --dangerously-load-development-channels server:switchroom-telegram \
  --plugin-dir ~/.switchroom/agents/<agent>/plugins \
  --model claude-opus-4-7 \
  --append-system-prompt "$(switchroom workspace render <agent> --stable)"
```

Key flags:

- `--continue` — **omitted by default.** As of switchroom #362, `session_continuity.resume_mode` defaults to `handoff`: every restart starts a fresh `claude` session and the prior session's context is reconstituted via a handoff briefing injected into `--append-system-prompt` (see "Session continuity model" below). Under `resume_mode: continue` `--continue` is always passed; under `auto` it's passed only when the latest JSONL transcript exists, is under the configured size cap (default 2 MB), and is under 7 days old; under `none` it's never passed and no handoff briefing is assembled. See `profiles/_base/start.sh.hbs` for the exact logic.
- `--dangerously-load-development-channels server:switchroom-telegram` — loads the switchroom Telegram MCP as a development channel.
- `--plugin-dir` — points at the agent's local plugin directory.
- `--append-system-prompt` — injects the stable workspace bootstrap block (SOUL.md, AGENTS.md, TOOLS.md, etc.) plus, in `handoff` / `auto` mode, the assembled handoff briefing.

Environment variables set before exec:

- `CLAUDE_CONFIG_DIR` — pinned to `/agent/.claude/` (the agent's per-container config dir, host-mounted from `~/.switchroom/agents/<agent>/.claude/`). Fully isolates each agent's auth, settings, transcripts, and MCP config from every other agent and from the user's personal Claude setup.
- `CLAUDE_CODE_OAUTH_TOKEN` — populated from the active slot or shared Anthropic account.

This is an **interactive REPL**, not `claude -p`. The session is persistent and long-lived; continuity across container restarts is provided by the switchroom layer (handoff briefing + Hindsight recall + Telegram history buffer), not by `--continue` (which is off by default).

### Session continuity model

Default mode is `handoff`. On a clean shutdown, the Stop hook runs `switchroom handoff <agent>` which summarizes the most recent session JSONL into `<agentDir>/.handoff.md`. On next boot, start.sh reads that file, plus a live briefing assembled by `handoff-briefing.sh` from recent Telegram messages / Hindsight recall / today's daily memory file (`<agentDir>/.handoff-briefing.md`), and merges both into `--append-system-prompt`. The fresh `claude` session wakes up already knowing what was going on without the cost or fragility of replaying a multi-MB transcript.

Other state survives a restart through dedicated channels:

- **`SWITCHROOM_PENDING_TURN`** — if the previous session was killed mid-turn (watchdog / SIGTERM / timeout), the gateway writes `<agentDir>/.pending-turn.env` and start.sh sources it into the new process. The agent reads it from CLAUDE.md and decides whether to acknowledge the interruption or silently continue.
- **`.wake-audit-pending`** sentinel under `TELEGRAM_STATE_DIR` — dropped on every boot. The agent's first turn runs a three-signal check (owed reply / orphan sub-agents / open todos), surfaces findings, then `rm -f`s the sentinel.
- **`SWITCHROOM_SESSION_MODE`** env (`continue` / `handoff` / `fresh` / `cold`) — exported for the SessionStart hook so the session-greeting card can render the correct "Session" row.

The `/reset` and `/new` Telegram commands write a `.force-fresh-session` marker that start.sh consumes once to force a cold boot regardless of `resume_mode`.

### The gateway

A Bun process (`telegram-plugin/gateway/gateway.ts`) runs alongside the claude REPL inside the same agent container. Responsibilities:

- Owns the Telegram Bot API polling loop (long-poll, persistent connection)
- Listens on a Unix domain socket at `/agent/telegram/gateway.sock`
- Buffers inbound Telegram messages in SQLite while Claude is down or restarting
- Handles auth gating (`access.json`), admin commands, permission prompts forwarded from claude, and progress card lifecycle
- Routes outbound messages from the switchroom-telegram MCP back to Telegram

The gateway is intentionally decoupled from the Claude process so that Telegram connectivity survives Claude crashes, OOM kills, and scheduled restarts inside the container.

---

## How the brain and the mouth talk

The switchroom-telegram MCP server runs as a child process **inside** the `claude` process (loaded via `--dangerously-load-development-channels`). It connects to the gateway over the Unix socket.

```
Inbound path:
  Telegram API
    -> gateway polls, receives message
    -> gateway writes to SQLite buffer
    -> gateway sends message over Unix socket to MCP child
    -> MCP child synthesizes a <channel>-tagged user message
    -> claude sees it as a new user turn

Outbound path:
  claude calls MCP tool (reply / stream_reply / react / etc.)
    -> MCP child sends payload over Unix socket to gateway
    -> gateway calls Telegram Bot API
    -> message delivered to user
```

The MCP child never makes direct HTTP calls to Telegram — all Telegram API calls go through the gateway.

---

## Why two processes inside the container

- **Survival across Claude restarts.** The gateway must stay alive when Claude exits (OOM, crash, scheduled compaction restart). If polling lived inside claude, every restart would drop the Telegram connection and lose in-flight messages.
- **Message buffering.** The gateway's SQLite buffer holds inbound messages while claude is down. When claude restarts (whether the new session is fresh-with-handoff or a `--continue` resume), the MCP child drains the buffer.
- **Separation of concerns.** The gateway handles all Telegram I/O. Claude handles all inference. Neither needs to know the internals of the other.

---

## Where `claude -p` is (and isn't) used

The main agent loop does **not** use `claude -p`. Agents run interactive — by default a fresh session per restart with handoff continuity (`--continue` is gated by `session_continuity.resume_mode`, which defaults to `handoff`).

`claude -p` is used in exactly one place, short-lived and headless:

- **Handoff summarization** (`src/agents/handoff-summarizer.ts`) — generates a cross-session handoff summary on demand. Exit on completion.

(Pre-v0.8, scheduled cron tasks were also dispatched via `claude -p` from the singleton scheduler container. As of the cron-fold-in cutover (Phase 4), cron tasks arrive in the running agent's session as synthesized inbound turns through the gateway IPC — same path as Telegram messages — so they appear in the agent's transcript and Hindsight context as ordinary turns tagged `meta.source="cron"`.)

---

## Other moving parts

**Vault broker (`switchroom-broker`)** — a long-running container holding the vault decrypted in memory after a one-time interactive unlock (`switchroom vault broker unlock`, or auto-unlock on boot). Cron tasks fetch declared keys via a host-shared unix socket. Container identity is asserted from the listening socket path (`/run/switchroom/broker/<agent>/sock`), not from cgroup parsing — broker-controlled input the agent cannot influence. See [`vault-broker.md`](vault-broker.md).

**Approval kernel (`switchroom-kernel`)** — out-of-process broker that gates every tool call against the per-agent allowlist; pending grants surface as inline Telegram cards. The agent never decides its own permissions; it asks and waits.

**Hindsight** — runs as a separate Docker container (`ghcr.io/vectorize-io/hindsight:latest`) exposing its API on `localhost:18888`. Mounted into each agent's `claude` process as an MCP plugin. Provides semantic memory, knowledge graph, entity resolution, and directives.

**Per-agent `.claude/`** — each agent has a fully isolated Claude config directory at `~/.switchroom/agents/<agent>/.claude/` on the host, bind-mounted into the container at `/agent/.claude/`. Separate auth credentials, separate `settings.json`, separate plugin config, separate transcript store.

**Config cascade** — agent config is resolved at apply time from `switchroom.yaml`: global defaults, then profile (`extends:`), then per-agent overrides. The rendered config is written into the agent's directory and the compose file is re-emitted. `switchroom apply` is the canonical reconcile.

**Three-tier Telegram command model** — every per-agent gateway routes inbound slash commands through three tiers:

1. **Self-management commands** — `/auth`, `/restart` (self), `/interrupt`, `/new`, `/reset`, `/version`, `/help`, `/approve`, `/deny`, `/pending`. Handled by the gateway locally on **every** agent, regardless of admin status. Claude is never invoked. These work even when Claude is rate-limited, the OAuth token is expired, or the model is unreachable.
2. **Fleet-management commands** — `/agents`, `/restart <other>`, `/stop`, `/agentstart`, `/update`, `/logs`, `/reconcile`, `/grant`, `/dangerous`, `/permissions`, `/vault`, `/memory`, `/topics`. Intercepted by the gateway and routed to the `switchroom` CLI **only when the agent has `admin: true`** in `switchroom.yaml`. Other agents reject with an "admin required" reply; Claude never sees the command.
3. **Conversational fall-through** — everything else (plain text, non-slash messages, slash commands the gateway doesn't recognise) is forwarded to Claude as a normal inbound turn.

An `admin: true` agent acts as the fleet's control panel from Telegram. Per-agent operations like `/auth reauth` work on every agent regardless of admin status. See `telegram-plugin/admin-commands/index.ts` for the authoritative list of fleet-management verbs and `telegram-plugin/gateway/gateway.ts:7452` for the admin-gate middleware.

> Historical note: a separate `switchroom-foreman` standalone bot used to provide fleet-wide admin commands. It was retired in favour of the three-tier model — gateway-side intercepts on `admin: true` agents subsume foreman's role without an extra container.

---

## What switchroom does NOT do

- Fork, patch, or repackage the `claude` CLI binary
- Use the Anthropic Agent SDK
- Call Anthropic's API directly
- Proxy or intercept inference requests
- Transmit OAuth tokens off-device
- Modify Claude Code's internal behavior
- Sit between Claude Code and Anthropic's inference API

---

## Compliance

See [`compliance-attestation.md`](compliance-attestation.md) for a point-in-time attestation against Anthropic's published policies. The short version: switchroom leverages Claude Code natively, no SDK hackery, sets up the CLI as designed.
