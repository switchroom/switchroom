# Telegram Plugin

Clerk ships an enhanced `clerk-telegram` MCP plugin that replaces the official marketplace plugin. It is the default — no configuration needed.

## 10 MCP tools

| Tool | What it does |
|------|-------------|
| `reply` | Send text, photos, or documents. Supports threading, topic routing, file attachments. |
| `stream_reply` | Edit a single message in place as work progresses (~1/sec throttle). Use for long tasks to avoid chat spam. |
| `react` | Add emoji reactions to messages (Telegram whitelist: 👍 👎 ❤️ 🔥 👀 🎉 etc). |
| `edit_message` | Update a previously sent message. Edits are silent (no push notification). |
| `delete_message` | Remove a bot-sent message (48h Telegram API limit). |
| `forward_message` | Quote/resurface earlier messages with thread support. |
| `pin_message` | Pin important outputs (requires bot admin). |
| `send_typing` | Show typing indicator (5s auto-expire). Use during long operations. |
| `download_attachment` | Fetch files attached to inbound messages. |
| `get_recent_messages` | Query SQLite history buffer with pagination and thread filtering. |

## Emoji status lifecycle

The plugin automatically reacts to inbound messages with a lifecycle progression:

```
👀 queued → 🤔 thinking → 👨‍💻 tool use → 🔥 streaming → 👍 done
```

Stall watchdogs: `🥱` at 30s idle, `😨` at 90s — so the user always knows the agent is alive.

Tool-specific reactions:
- `👨‍💻` for Bash/Edit/Write
- `⚡` for web search/fetch

## Message history

A local SQLite database (`telegram/history.db`) records every message. After a Claude Code restart, the agent calls `get_recent_messages` to recover context instead of asking "what were we doing?"

History survives process restarts and session resets.

## stream_reply pattern

For tasks taking more than ~5 seconds:

```
1. stream_reply(chat_id, "Reading the file...", done=false)  ← creates message
2. stream_reply(chat_id, "Reading the file...\nParsing...", done=false)  ← edits in place
3. stream_reply(chat_id, "Done! Here's the result: ...", done=true)  ← locks
```

Pass the **full current text** on each call (not a delta). The plugin throttles to ~1/sec.

After `done=true`, send a separate `reply` if you want a push notification to the user's device (edits are silent).

## Formatting

Markdown is auto-converted to Telegram HTML:
- `**bold**` → `<b>bold</b>`
- `` `code` `` → `<code>code</code>`
- ` ```blocks``` ` → `<pre><code>...</code></pre>`
- Smart chunking preserves tag balance across Telegram's 4096-char limit

Formats: `html` (default), `markdownv2`, `text`

## Access control

`telegram/access.json` per agent:
- **DM policy**: allowlist of user IDs
- **Group policy**: per-group settings (requireMention, allowFrom)
- **Topic filtering**: scope agent to specific forum topics

## Forum topics

Messages from forum topics carry `message_thread_id`. The plugin routes replies back to the originating topic automatically. The agent doesn't need to pass `message_thread_id` explicitly.

## Opting out

To use the official upstream plugin for a specific agent:
```yaml
agents:
  basic:
    channels:
      telegram:
        plugin: official
```

## Env vars

| Var | Source | Purpose |
|-----|--------|---------|
| `CLERK_TG_FORMAT` | `channels.telegram.format` | Default reply format |
| `CLERK_TG_RATE_LIMIT_MS` | `channels.telegram.rate_limit_ms` | Min delay between outgoing messages |
| `TELEGRAM_STATE_DIR` | Auto-set by scaffold | Path to `telegram/` dir |
| `CLERK_AGENT_NAME` | Auto-set by scaffold | Agent name (used for self-restart detection) |
| `CLERK_CONFIG` | Auto-set by scaffold | Path to clerk.yaml |
