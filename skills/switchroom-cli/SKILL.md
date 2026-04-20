---
name: switchroom-cli
description: "Run switchroom CLI operations on existing agents: logs, restart, reconcile, config inspection, scheduled tasks, and Telegram plugin reference. Use when the user wants to: show logs (\"logs\", \"what happened\", \"check the journal\", \"why did it crash\"); restart agents (\"restart\", \"reboot\", \"bounce\", \"kick\", \"it's stuck\"); apply config changes (\"apply\", \"sync my config\", \"reconcile\", \"I just edited switchroom.yaml\"); inspect an agent's effective config (\"what model is X using\", \"how is <agent> configured\", \"show the cascade\"); list scheduled tasks (\"cron\", \"timers\", \"what runs automatically\", \"scheduled tasks\"); or ask about Telegram-plugin features (\"what MCP tools does the bot have\", \"how does reply work\"). Do NOT use for adding/removing agents (switchroom-manage), bootstrapping switchroom from scratch (switchroom-install), or \"something is broken\" diagnostics (switchroom-health).
allowed-tools: Bash(switchroom *) Bash(systemctl --user *) Bash(journalctl *)
---

# Switchroom CLI operations

This skill is the reference for running `switchroom` CLI commands against existing agents. Each section below is triggered by a distinct user intent — jump to the relevant one rather than walking top-to-bottom.

**Prerequisite:** the `switchroom` CLI must be on `PATH`. If it isn't, direct the user to the `switchroom-install` skill.

---

## Logs — "show me the logs", "what happened", "why did it crash"

Fetch recent journal output when the user wants to see what an agent did or is debugging a specific crash.

### Step 1 — Identify the agent

If the user didn't name one, ask: *"Which agent do you want logs for?"* Then list available agents:

```bash
switchroom agent list
```

### Step 2 — Tail the logs

Default is the last 20 lines. User can specify a number. Use the CLI if available; fall back to `journalctl` when it's not:

```bash
switchroom agent logs <name> [--lines 50]
# or, when switchroom CLI isn't reachable:
journalctl --user -u switchroom-<name>.service -n 50 --no-pager
```

### Step 3 — Present output

Include the last ~20 lines verbatim, then summarise what you see (crash, stall, normal chatter). If the user asked "why did it crash" and you don't see a clear cause, say so and offer `/doctor` as the next step.

---

## Restart — "restart", "reboot", "bounce", "it's stuck"

Restart one agent or all. Also covers "refresh", "kick", "kill and restart", "stop and start".

### Step 1 — Identify the agent

If the user didn't name one, ask which. Accept `all` as a valid target.

### Step 2 — Run the restart

```bash
switchroom agent restart <name>
# or for the whole fleet:
switchroom agent restart all --force
```

### Step 3 — Confirm

Report the outcome. If the agent is being restarted via Telegram (`/restart` handler), the user will see a `🔄 Restarting <name>…` ack followed by a `🎛️ Switchroom restarted — ready` message. Don't double-post.

**If you want a fresh session** (flush handoff + restart), prefer `switchroom agent reconcile <name> --restart` or the Telegram `/new` / `/reset` commands — plain restart preserves the handoff briefing.

---

## Reconcile — "apply my changes", "sync config", "I just edited switchroom.yaml"

Re-apply `switchroom.yaml` to one or all running agents. Use only when the user has edited config and wants it live.

### Step 1 — Scope

```bash
# Single agent:
switchroom agent reconcile <name>

# All agents:
switchroom agent reconcile all
```

### Step 2 — Optional restart

`reconcile` rewrites `.mcp.json`, `settings.json`, `start.sh`, and the generated hooks — but most changes only take effect on restart. Append `--restart` when the user wants the new config live immediately:

```bash
switchroom agent reconcile <name> --restart
```

### Step 3 — Confirm

Tell the user what changed (the CLI prints the affected files). If nothing changed, say so — "nothing to reconcile" is a valid answer.

---

## Config inspection — "what model is X using", "show config for <agent>"

Surface the resolved effective config for a specific agent. Use for "how is X configured", "what tools does X have", or cascade-resolution questions.

### Step 1 — Find the config

```bash
switchroom agent list --json
```

This returns per-agent `name`, `model`, `extends`, `topic_name`, `topic_emoji`, `status`, `uptime`. For the full merged config (including tools, soul, memory, hooks, skills), inspect the scaffolded files:

```bash
cat ~/.switchroom/agents/<name>/.claude/settings.json
```

### Step 2 — Explain the cascade

Agent config resolves through `defaults → extends profile → agent-specific`, with later keys winning. If the user asks *why* a value is set the way it is, walk them through which layer contributed it.

---

## Scheduled tasks — "what cron runs", "show me the timers"

List cron jobs and scheduled tasks.

### Step 1 — Show live timers

```bash
systemctl --user list-timers --all | grep switchroom
```

### Step 2 — Show declared schedule entries

From `switchroom.yaml`, the `schedule:` array under each agent specifies `cron` + `prompt` + optional `model`. Read the relevant agent block and enumerate the entries with their next-fire times.

---

## Telegram plugin reference — "what MCP tools", "how does reply work"

The `switchroom-telegram` plugin is an enhanced fork of the official Telegram MCP plugin and is the default for all switchroom agents. It exposes **10 MCP tools** (all prefixed `mcp__switchroom-telegram__`):

| Tool | Purpose |
|---|---|
| `reply` | Send a text/photo message, with optional `reply_to` for threaded quotes |
| `stream_reply` | Incrementally stream a long reply (edits the same message as tokens arrive) |
| `react` | Emoji reaction on an inbound or outbound message |
| `edit_message` | Modify an earlier bot message's text |
| `delete_message` | Remove an earlier bot message |
| `forward_message` | Forward a message from another chat |
| `pin_message` | Pin a message in the current chat |
| `send_typing` | Show the "typing…" indicator |
| `download_attachment` | Save a Telegram file attachment to the agent's inbox |
| `get_recent_messages` | Fetch recent history for context |

Additional features:
- **Status reactions** — 👀 queued → 🤔 thinking → 👨‍💻 tool → 🔥 streaming → 👍 done
- **Progress cards** — pinned, live-updating tool-step summary
- **SQLite history** — enables quote-reply defaults
- **PI-safe envelope** — inbound text wrapped in `<channel source="telegram">` for prompt-injection safety
- **Inline approvals** — tool permissions surface as ✅/❌ buttons or via `/approve` `/deny` `/pending`
- **Slash commands** — `/new`, `/reset`, `/approve`, `/deny`, `/pending`, `/restart`, `/reconcile`, `/update`, `/logs`, `/doctor`, `/switchroomhelp` (see `TELEGRAM_MENU_COMMANDS` in `telegram-plugin/welcome-text.ts`)
- **Access control** — `dmPolicy: pairing | allowlist | disabled` per agent

---

## Rule of thumb

If the user is asking **"do X"**, this is your skill. If they're asking **"why is X broken"**, switch to `switchroom-health`. If they're asking **"how do I add/remove an agent"**, switch to `switchroom-manage`. If they're new and don't have switchroom yet, switch to `switchroom-install`.
