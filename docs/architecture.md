# Switchroom Architecture

## The short version

One Claude Code REPL per agent, dressed up with systemd and a Telegram bot. Each agent is an unmodified `claude` CLI process running interactively under systemd, with a separate long-lived gateway process that owns the Telegram connection. Everything else — memory, MCP tools, scheduling — layers on top of that pair.

---

## Per-agent process model (two systemd units)

### `switchroom-<agent>.service` — the brain

Runs the Claude Code CLI session. The unit's `ExecStart` is:

```
/usr/bin/script -qfc "/usr/bin/expect -f bin/autoaccept.exp ~/.switchroom/agents/<agent>/start.sh" <logFile>
```

The layers:

- **`script`** — allocates a PTY and writes a full-fidelity terminal log. Required because `claude` expects an interactive terminal; also enables log-based token-detection during auth.
- **`expect`** (via `bin/autoaccept.exp`) — handles the one-time TUI dialogs Claude Code shows on first run (theme picker, trust-folder prompt, `--dangerously-load-development-channels` acknowledgement) so headless systemd launches don't block on keyboard input. It does NOT auto-accept per-tool permission prompts — those still route through the Telegram inline-button approval flow when the agent hits one mid-turn. `expect` then launches `/bin/bash -l start.sh` internally.
- **`start.sh`** — thin wrapper that sets environment variables, then `exec`s the `claude` binary.

`start.sh` invokes claude with flags like:

```bash
exec claude \
  --continue \
  --dangerously-load-development-channels server:switchroom-telegram \
  --plugin-dir ~/.switchroom/agents/<agent>/plugins \
  --model claude-opus-4-7 \
  --append-system-prompt "$(switchroom workspace render <agent> --stable)"
```

Key flags:

- `--continue` — passed conditionally. Under `session_continuity.resume_mode: auto` (default), it's set only when the transcript exists, is under the configured size cap (default 2 MB), and is under 7 days old — so long-running agents pick up where they left off, but stale or oversized transcripts start fresh. Under `resume_mode: continue` it's always set; under `handoff` or `none` it's never set (the agent starts cold, optionally with a handoff briefing). See `profiles/_base/start.sh.hbs` for the exact logic.
- `--dangerously-load-development-channels server:switchroom-telegram` — loads the switchroom Telegram MCP as a development channel. Operators can swap this for `--channels plugin:telegram@claude-plugins-official` per-agent.
- `--plugin-dir` — points at the agent's local plugin directory.
- `--append-system-prompt` — injects the stable workspace bootstrap block (SOUL.md, AGENTS.md, TOOLS.md, etc.) at session start.

Environment variables set before exec:

- `CLAUDE_CONFIG_DIR` — pinned to `~/.switchroom/agents/<agent>/.claude/`. Fully isolates each agent's auth, settings, transcripts, and MCP config from every other agent and from the user's personal Claude setup.
- `CLAUDE_CODE_OAUTH_TOKEN` — populated from the active slot file (`accounts/<slot>/.oauth-token`) for multi-account rotation. Claude Code reads this env var and uses it in place of the credentials file when set.

This is an **interactive REPL**, not `claude -p`. The session is persistent and long-lived, conditionally resumed across restarts via `--continue` (see flag description above).

### `switchroom-<agent>-gateway.service` — the mouth

A Bun process running `telegram-plugin/gateway/gateway.ts`. Responsibilities:

- Owns the Telegram Bot API polling loop (long-poll, persistent connection)
- Listens on a Unix domain socket at `~/.switchroom/agents/<agent>/telegram/gateway.sock`
- Buffers inbound Telegram messages in SQLite while Claude is down or restarting
- Handles auth gating (`access.json`), admin commands, permission prompts forwarded from claude, and progress card lifecycle
- Routes outbound messages from the switchroom-telegram MCP back to Telegram

The gateway is intentionally decoupled from the Claude process so that Telegram connectivity survives Claude crashes, OOM kills, and scheduled restarts.

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

The MCP child never makes direct HTTP calls to Telegram — all Telegram API calls go through the gateway. This keeps the socket boundary clean and lets the gateway handle rate limiting, error retry, and message buffering in one place.

---

## Why two processes

- **Survival across Claude restarts.** The gateway must stay alive when Claude exits (OOM, crash, scheduled compaction restart). If polling lived inside claude, every restart would drop the Telegram connection and lose in-flight messages.
- **Message buffering.** The gateway's SQLite buffer holds inbound messages while claude is down. When claude restarts via `--continue`, the MCP child drains the buffer and presents the queued messages as a new turn.
- **Separation of concerns.** The gateway handles all Telegram I/O (polling, rate limits, retries, bot-API quirks). Claude handles all inference. Neither needs to know the internals of the other.

---

## Where `claude -p` is (and isn't) used

The main agent loop does **not** use `claude -p`. Agents run interactive (`--continue`).

`claude -p` is used in exactly two places, both short-lived and headless:

- **Scheduled cron tasks** (`src/agents/scaffold.ts` ~L1150) — one-shot prompts fired by systemd timers. Exit on completion.
- **Handoff summarization** (`src/agents/handoff-summarizer.ts` ~L297) — generates a cross-session handoff summary on demand. Exit on completion.

Neither use case is affected by any rumored deprecation of `-p` in a meaningful way — they are genuinely one-shot, not persistent sessions dressed up as headless.

---

## Other moving parts

**Hindsight** — runs as a Docker container (`ghcr.io/vectorize-io/hindsight:latest`) exposing its API on `localhost:18888` (port mapping `127.0.0.1:18888 → 8888/tcp`; also exposes `127.0.0.1:19999 → 9999/tcp`). It's mounted into each agent's `claude` process as an MCP plugin (`--plugin-dir .claude/plugins/hindsight-memory`), so every agent shares the same long-term memory backend while keeping its own bank. Deployment mechanism (Docker) is independent of switchroom itself — switchroom only wires the MCP plugin into each agent's `claude` invocation. Provides semantic memory, knowledge graph, entity resolution, and directives.

**Foreman** — an optional always-on admin bot (`telegram-plugin/foreman/foreman.ts`) that provides fleet-wide visibility and lifecycle control over a separate Telegram bot token. Does not run Claude inference. Talks to the `switchroom` CLI directly for status, logs, restart, and create operations. Gated by `access.json` sender allowlists.

**Per-agent `.claude/`** — each agent has a fully isolated Claude config directory at `~/.switchroom/agents/<agent>/.claude/`. Separate auth credentials, separate `settings.json`, separate plugin config, separate transcript store. No agent can see or affect another agent's config.

**Config cascade** — agent config is resolved at reconcile time from `switchroom.yaml`: global defaults, then profile (`extends:`), then per-agent overrides. The rendered config is written into the agent's directory. Changing one line in `switchroom.yaml` and running `switchroom agent reconcile <agent>` propagates the change.

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
