---
name: clerk-telegram-guide
description: Explains the clerk-telegram plugin's features — 10 MCP tools (reply, stream_reply, react, edit, delete, forward, pin, typing, download, history), emoji status reactions, SQLite history, formatting, access control. Use when discussing Telegram integration, message handling, or formatting issues.
user-invocable: false
---

# Clerk Telegram Plugin Reference

The `clerk-telegram` plugin is an enhanced fork of the official Telegram MCP plugin. It's the default for all clerk agents.

## 10 MCP Tools

| Tool | One-line description |
|------|---------------------|
| `reply` | Send a message (text, photos, docs). Supports topic routing, threading, multiple file attachments. |
| `stream_reply` | Edit a single message in place as progress happens. ~1/sec throttle. Set `done=true` to finalize. |
| `react` | Add an emoji reaction to any message. Only Telegram-whitelisted emojis work (👍👎❤️🔥👀🎉 etc). |
| `edit_message` | Silently update a previously sent message (no push notification to user). |
| `delete_message` | Remove a bot message. Telegram enforces a 48-hour limit. Prefer `edit_message` when possible. |
| `forward_message` | Resurface/quote an earlier message, with optional topic targeting. |
| `pin_message` | Pin a message in the chat. Requires the bot to have admin rights. |
| `send_typing` | Show "typing..." indicator. Auto-expires after 5 seconds. |
| `download_attachment` | Fetch a file attached to an inbound message (returns local path). |
| `get_recent_messages` | Query the local SQLite history buffer. Supports pagination and thread filtering. |

## Status Reactions (automatic)

The plugin reacts to the user's inbound message automatically:

```
👀 queued  →  🤔 thinking  →  👨‍💻 tool use  →  🔥 streaming  →  👍 done
```

Stall watchdogs: `🥱` if idle 30s, `😨` if idle 90s.

## stream_reply Pattern

For long tasks, use stream_reply to edit one message in place:

```
1. stream_reply(chat_id, "Starting...", done=false)   ← fresh message
2. stream_reply(chat_id, "Starting...\nDone X.", done=false)  ← edit (full text)
3. stream_reply(chat_id, "Final answer: ...", done=true)  ← lock
```

After `done=true`, send a `reply` if you want a push notification (edits are silent).

## Message History

All inbound and outbound messages are stored in `telegram/history.db` (SQLite). Survives restarts. Call `get_recent_messages` to recover context after a Claude Code restart instead of asking the user "what were we doing?"

## Formatting

Default format is `html`. Markdown is auto-converted:
- `**bold**` → bold
- `` `code` `` → inline code
- ` ```blocks``` ` → code block
- Smart chunking across Telegram's 4096-char message limit

Other formats: `markdownv2` (with auto-escaping), `text` (plain).

## Access Control

`telegram/access.json` per agent controls:
- Which user IDs can DM the bot
- Per-group settings (requireMention, allowFrom)
- Topic filtering (scope agent to specific forum topics)

## Forum Topics

`message_thread_id` on inbound messages identifies the topic. The plugin routes replies back to the correct topic automatically — no manual thread tracking needed.

## Opting out

Per-agent in clerk.yaml:
```yaml
channels:
  telegram:
    plugin: official   # use upstream marketplace plugin instead
```
