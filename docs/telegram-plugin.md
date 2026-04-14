# Clerk's Telegram Plugin

Clerk ships an enhanced Telegram MCP plugin (`clerk-telegram`) that replaces the official `telegram@claude-plugins-official` marketplace plugin. It is the **default** for all agents — you don't need to configure anything to use it.

## Why a fork?

The official Telegram plugin provides basic message send/receive. Clerk's fork adds everything needed for a production agent experience: streaming edits, emoji-driven progress signals, persistent message history, forum topic support, rich formatting, and per-agent access control.

## What the clerk fork adds

### Message tools (10 MCP tools)

| Tool | What it does |
|------|-------------|
| `reply` | Send text, photos, or documents. Supports threading, topic routing, and multi-file attachments. |
| `stream_reply` | Edit a single message in place as work progresses (~1/sec throttle). Avoids spamming the chat with many short messages. |
| `react` | Add emoji reactions to messages (Telegram whitelist: 👍 👎 ❤️ 🔥 👀 🎉 etc). |
| `edit_message` | Update a previously sent message. |
| `delete_message` | Remove a bot-sent message (48h Telegram limit). |
| `forward_message` | Quote/resurface earlier messages with thread support. |
| `pin_message` | Pin important outputs in the chat (requires bot admin). |
| `send_typing` | Show typing indicator during long operations (5s auto-expire). |
| `download_attachment` | Fetch files attached to inbound messages. |
| `get_recent_messages` | Query the local SQLite history buffer with pagination and thread filtering. |

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
`channels.telegram.stream_mode` in `clerk.yaml`:

- **`checklist`** (default) — event-driven progress card. Reads canonical
  `tool_use` / `tool_result` / `turn_end` events from the session JSONL
  and renders a stable, fixed-order checklist with per-item state emojis
  (⏸ pending · ⚡ running · ✅ done · ❌ failed) and a short label per
  item derived from its input args (`Read: tests/merge.test.ts`,
  `Bash: bun test`, `Grep: "TODO" in src/`). Each item appears once and
  never reorders; only the current ⚡ line ticks elapsed time. Fires
  only on semantic transitions with a 500ms min-edit floor and a 400ms
  coalesce window, so bursts of quick tools render as a single edit.
  No flicker.
- **`pty`** — tails Claude Code's TUI output and re-renders a snapshot
  on each frame. Legacy fallback — can visibly flicker as Ink does
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

The clerk fork reads additional env vars from `start.sh`:

| Env var | Source | Purpose |
|---------|--------|---------|
| `CLERK_TG_FORMAT` | `channels.telegram.format` | Default reply format (`html`, `markdownv2`, `text`) |
| `CLERK_TG_RATE_LIMIT_MS` | `channels.telegram.rate_limit_ms` | Min delay between outgoing messages |
| `CLERK_TG_STREAM_MODE` | `channels.telegram.stream_mode` | `checklist` (default) or `pty` — see "Streaming modes" above |
| `TELEGRAM_STATE_DIR` | Auto-set by scaffold | Path to `telegram/` dir (history.db, access.json) |
| `CLERK_AGENT_NAME` | Auto-set by scaffold | Agent name for self-restart detection |
| `CLERK_CONFIG` | Auto-set by scaffold | Path to clerk.yaml for config resolution |
