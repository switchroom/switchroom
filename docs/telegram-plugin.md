# Switchroom's Telegram Plugin

Switchroom ships an enhanced Telegram MCP plugin (`switchroom-telegram`) that replaces the official `telegram@claude-plugins-official` marketplace plugin. It is the **default** for all agents. You don't need to configure anything to use it.

## Why a fork?

The official Telegram plugin provides basic message send/receive. Switchroom's fork adds everything needed for a production agent experience: streaming edits, emoji-driven progress signals, persistent message history, forum topic support, rich formatting, and per-agent access control.

## What the switchroom fork adds

### Message tools (12 MCP tools)

| Tool | What it does |
|------|-------------|
| `reply` | Send text, photos, or documents. Supports threading, topic routing, multi-file attachments, inline keyboard URL buttons, `protect_content`, `quote_text`, and an optional `accent` status header (`in-progress`/`done`/`issue`). |
| `stream_reply` | Edit a single message in place as work progresses (~1/sec throttle). Same `accent` and inline-keyboard support as `reply`. Optional `lane` parameter splits parallel streams (e.g. `thinking` vs default answer) per chat+thread. |
| `react` | Add emoji reactions to messages (Telegram whitelist: 👍 👎 ❤️ 🔥 👀 🎉 etc). |
| `edit_message` | Update a previously sent message. |
| `delete_message` | Remove a bot-sent message (48h Telegram limit). |
| `forward_message` | Quote/resurface earlier messages with thread support. |
| `pin_message` | Pin important outputs in the chat (requires bot admin). |
| `send_typing` | Show typing indicator during long operations (5s auto-expire). |
| `download_attachment` | Fetch files attached to inbound messages. |
| `get_recent_messages` | Query the local SQLite history buffer with pagination and thread filtering. |
| `send_checklist` | Native Telegram checklist message — fixed-order items with per-item state. Returns a checklist id usable with `update_checklist` (#272). |
| `update_checklist` | Patch the state of items on a previously sent checklist (e.g. mark item 2 done) without re-sending the whole message. |

### Status accent headers

Both `reply` and `stream_reply` accept an optional `accent: 'in-progress' | 'done' | 'issue'` parameter that prepends a status indicator line (`🔵 In progress…`, `✅ Done`, `⚠️ Issue`) above the message body. Use it for status communication on long-running work and completion announcements; omit it for routine conversational replies. (#328)

### Inline keyboard URL buttons

`reply` and `stream_reply` accept an `inline_keyboard` parameter — an array of rows, each row an array of `{ text, url }` buttons — for tap-to-open links rendered as Telegram inline buttons (#271).

### Emoji status reactions

The plugin automatically reacts to the user's inbound message with a lifecycle progression:

👀 queued → 🤔 thinking → 👨‍💻 tool use → 🔥 streaming → 👍 done

Stall watchdogs promote to 🥱 (30s idle) then 😨 (90s) so the user always knows the agent is alive. Tool-specific reactions show what the agent is doing (👨‍💻 for bash/edit, ⚡ for web search/fetch).

### Message history

A local SQLite database records every inbound and outbound message. After a Claude Code restart, the agent can call `get_recent_messages` to recover context instead of asking "what were we doing?". History survives process restarts and session resets.

### Rich formatting

Markdown from the model is automatically converted to Telegram-compatible HTML:

- **Bold**, *italic*, `inline code`, ```code blocks```
- Links, blockquotes, strikethrough
- Smart HTML chunking that preserves tag balance across Telegram's 4096-char limit
- Auto-detection of raw HTML from the model to avoid double-escaping
- File references (`.ts`, `.json`, `.py`, etc) auto-wrapped in `<code>` tags

### Access control

Per-agent `access.json` defines:
- **DM policy**: allowlist of Telegram user IDs that can DM the bot
- **Group policy**: per-group settings (requireMention, allowFrom)
- **Topic filtering**: agents can be scoped to specific forum topics

### `/auth` router

The gateway exposes three chat commands, backed by the
`switchroom-auth-broker` daemon. See [`docs/auth.md`](auth.md) for the
full model.

| Command | Who can call | Purpose |
|---|---|---|
| `/auth show` | any agent | Read-only snapshot of the fleet (accounts + health + active) |
| `/auth use <label>` | admin agents only | Swap the fleet-wide active account |
| `/auth rotate` | admin agents only | Cycle to the next non-exhausted account in `auth.fallback_order` |

Admin agents are listed in `auth.admin_agents:` in `switchroom.yaml`.
The 1100-LOC slot-pool `/auth` dashboard from v0.7 was deleted in the
broker rollout — the broker model doesn't need it.

### Auto-fallback on quota exhaustion

When any consumer (agent or hindsight) hits a 429, it tells the broker
via `mark-exhausted`. The broker sets `exhausted_until` for that
account and, in seconds, atomically rewrites every affected agent's
per-agent credentials mirror to the next account in `auth.fallback_order`.
Quota events propagate across the fleet automatically — no per-agent
restart, no manual intervention. If `fallback_order` is exhausted, the
broker logs the state and agents see expired-token errors until the
window resets or an operator runs `switchroom auth add` for a new
account. See `src/auth/broker/` for the implementation.

### Forum topic support

Messages from Telegram forum topics carry `message_thread_id`. The plugin:
- Routes replies back to the originating topic automatically
- Filters inbound messages by topic when configured
- Supports explicit topic targeting via `message_thread_id` parameter

## Opting out

If you prefer the upstream official plugin for a specific agent:

```yaml
agents:
  basic-agent:
    topic_name: "Basic"
    channels:
      telegram:
        plugin: official      # upstream marketplace plugin
```

### Streaming modes

How live progress is surfaced while a turn is in flight. Configure via
`channels.telegram.stream_mode` in `switchroom.yaml`:

- **`checklist`** (default): event-driven progress card. Reads canonical
  `tool_use` / `tool_result` / `turn_end` events from the session JSONL
  and renders a stable, fixed-order checklist with per-item state emojis
  (⏸ pending · ⚡ running · ✅ done · ❌ failed) and a short label per
  item derived from its input args (`Read: tests/merge.test.ts`,
  `Bash: bun test`, `Grep: "TODO" in src/`). Each item appears once and
  never reorders; only the current ⚡ line ticks elapsed time. Fires
  only on semantic transitions with a 500ms min-edit floor and a 400ms
  coalesce window, so bursts of quick tools render as a single edit.
  No flicker.
- **`pty`**: tails Claude Code's TUI output and re-renders a snapshot
  on each frame. Legacy fallback. Can visibly flicker as Ink does
  differential re-renders during quick tool calls. Keep this mode only
  if you've customised agent hooks or prompts in a way that breaks the
  session-tail projection.

```yaml
agents:
  coder:
    channels:
      telegram:
        stream_mode: pty   # opt out of the checklist card
```

Progress-card messages are sent on a dedicated `lane: "progress"` via
`stream_reply` so they don't collide with the answer message. The final
answer still lands separately via the model's `reply` / `stream_reply`
call.

## Configuration

The switchroom fork reads additional env vars from `start.sh`:

| Env var | Source | Purpose |
|---------|--------|---------|
| `SWITCHROOM_TG_FORMAT` | `channels.telegram.format` | Default reply format (`html`, `markdownv2`, `text`) |
| `SWITCHROOM_TG_RATE_LIMIT_MS` | `channels.telegram.rate_limit_ms` | Min delay between outgoing messages |
| `SWITCHROOM_TG_STREAM_MODE` | `channels.telegram.stream_mode` | `checklist` (default) or `pty`. See "Streaming modes" above |
| `TELEGRAM_STATE_DIR` | Auto-set by scaffold | Path to `telegram/` dir (history.db, access.json) |
| `SWITCHROOM_AGENT_NAME` | Auto-set by scaffold | Agent name for self-restart detection |
| `SWITCHROOM_CONFIG` | Auto-set by scaffold | Path to switchroom.yaml for config resolution |
