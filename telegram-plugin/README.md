# Clerk Telegram Plugin

Forked from the [official Claude Code Telegram plugin](https://github.com/anthropics/claude-plugins-official) with added support for Telegram forum topics (threads).

## What changed from the official plugin

All existing functionality is preserved. The following additions enable topic/forum routing:

### 1. Topic filtering via `TELEGRAM_TOPIC_ID`

Set this env var to restrict the plugin to a single forum topic. Messages from other topics are silently ignored.

```bash
# In ~/.claude/channels/telegram/.env
TELEGRAM_TOPIC_ID=12345
```

If unset, all messages are processed as before (fully backwards compatible).

### 2. Inbound topic metadata

When a message arrives from a forum topic, the MCP notification metadata includes:

```
message_thread_id: "12345"
```

This lets downstream agents know which topic the message came from.

### 3. Reply tool: `message_thread_id` parameter

The `reply` tool accepts an optional `message_thread_id` parameter to target a specific forum topic.

**Auto-capture**: When an inbound message has a `message_thread_id`, the plugin stores it per `chat_id`. Subsequent replies to that chat automatically route to the same topic without the agent needing to specify it. An explicit `message_thread_id` in the tool call overrides the auto-captured value.

### 4. File sending: thread-aware

All file-sending methods (`sendPhoto`, `sendDocument`) pass `message_thread_id` so attachments land in the correct topic.

### 5. Edit tool: unchanged

`edit_message` targets a specific `message_id` and does not need `message_thread_id`.

## Setup

Same as the official plugin. Requires:

- [Bun](https://bun.sh) runtime
- `TELEGRAM_BOT_TOKEN` in `~/.claude/channels/telegram/.env`
- Optionally `TELEGRAM_TOPIC_ID` for topic filtering

```bash
cd telegram-plugin
bun install
bun server.ts
```

## How topic routing works

1. Bot receives a message in a supergroup forum topic
2. Grammy provides `ctx.message.is_topic_message` and `ctx.message.message_thread_id`
3. If `TELEGRAM_TOPIC_ID` is set and doesn't match, the message is dropped early
4. Otherwise, the `message_thread_id` is included in the MCP notification metadata and auto-captured for replies
5. When the agent calls the `reply` tool, `message_thread_id` is passed to `bot.api.sendMessage()` so the response lands in the correct topic thread

## Enhanced features

### Read receipt indicator

When an inbound message is received, the plugin immediately reacts with an emoji to indicate it was seen. Configure via `ackReaction` in `access.json`:

```json
{
  "ackReaction": "👀"
}
```

Set to an empty string `""` to disable. Only Telegram's fixed emoji whitelist is accepted (👍 👎 ❤ 🔥 👀 🎉 etc). A typing indicator is also sent automatically.

### Streaming progress via message editing

For long-running tasks, agents can show progress:

1. Send an initial "thinking..." message with `reply` — note the returned `message_id`
2. Call `edit_message` with updated text as work progresses (edits are silent — no push notification)
3. Call `send_typing` between steps to keep the typing indicator alive (it expires after ~5s)
4. When done, send a **new** `reply` so the user's device pings with a push notification

### `send_typing` tool

Sends a typing indicator ("Bot is typing...") to a chat. Auto-expires after ~5 seconds. Call repeatedly during long operations.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `chat_id` | yes | Target chat ID |

### `pin_message` tool

Pins a message in a chat. Requires admin rights in groups.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `chat_id` | yes | Chat ID |
| `message_id` | yes | Message to pin |

### `forward_message` tool

Forwards an existing message to a chat, preserving original sender attribution. In forum topics, the forwarded message lands in the correct thread (auto-detected or explicit).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `chat_id` | yes | Destination chat ID |
| `from_chat_id` | yes | Source chat ID |
| `message_id` | yes | Message ID to forward |
| `message_thread_id` | no | Forum topic thread ID (auto-applied if not specified) |

### Improved MarkdownV2 formatting

When using `format: "markdownv2"` in the `reply` or `edit_message` tools, special characters are now **auto-escaped** outside of code blocks and inline code spans. Agents can write natural markdown without manually escaping Telegram's special characters (`_ * [ ] ( ) ~ > # + - = | { } . !`).

Code blocks (`` ``` ... ``` ``) and inline code (`` ` ... ` ``) are preserved as-is.

### Voice message metadata

When a voice message or audio file is received, the inbound metadata includes:

- `attachment_kind: "voice"` or `"audio"`
- `attachment_file_id` — use with `download_attachment` to fetch the file
- `attachment_mime` — MIME type (e.g. `audio/ogg` for voice messages)

**Whisper transcription**: To auto-transcribe voice messages, set up a Whisper MCP server (e.g. [whisper-mcp](https://github.com/modelcontextprotocol/servers)) and instruct your agent to download voice attachments and pass them to the Whisper tool for transcription.

## Use case: multi-agent orchestration

In a Clerk multi-agent setup, each agent instance can run this plugin with a different `TELEGRAM_TOPIC_ID`, routing each forum topic to a dedicated agent while sharing a single bot token and group chat.
