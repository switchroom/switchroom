# Telegram Plugin

Switchroom ships an enhanced `switchroom-telegram` MCP plugin that replaces the official marketplace plugin. It is the default — no configuration needed.

## 9 MCP tools

| Tool | What it does |
|------|-------------|
| `reply` | Send text, photos, or documents — the single final-answer tool. Chunks anything over the 32768-char rich-message cap (4096 applies only to plain-text degradations). Supports threading, topic routing, file attachments. |
| `react` | Add emoji reactions to messages (Telegram whitelist: 👍 👎 ❤️ 🔥 👀 🎉 etc). |
| `edit_message` | Update a previously sent message. Edits are silent (no push notification). |
| `delete_message` | Remove a bot-sent message (48h Telegram API limit). |
| `forward_message` | Quote/resurface earlier messages with thread support. |
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

## Progress while working

For long tasks you do not need to narrate progress by editing a message. The
plugin renders an event-driven progress card (Plan → Run → Done with live tool
bullets, elapsed time, and status emoji) for free while the turn is in-flight.
Send the final answer once, with `reply` — it chunks anything over the
32768-char rich-message cap (4096 applies only to plain-text degradations).
For an explicit mid-turn check-in use `progress_update`.

## Formatting

Every outbound message is sent as raw GFM markdown via the Bot API 10.1
rich-message path (`sendRichMessage` / `editMessageText({ markdown })`) —
Telegram parses the markdown server-side. There is no markdown→HTML
conversion and no `parse_mode` on this path. Smart chunking
(`splitMarkdownChunks`) splits anything over the 32768-char rich cap without
bisecting code fences or table rows; bodies that degrade to plain text fall
back to the legacy 4096-char cap. See
`reference/telegram-formatting-guide.md` for the full vocabulary.

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
| `SWITCHROOM_TG_FORMAT` | `channels.telegram.format` | Default reply format |
| `TELEGRAM_STATE_DIR` | Auto-set by scaffold | Path to `telegram/` dir |
| `SWITCHROOM_AGENT_NAME` | Auto-set by scaffold | Agent name (used for self-restart detection) |
| `SWITCHROOM_CONFIG` | Auto-set by scaffold | Path to switchroom.yaml |
