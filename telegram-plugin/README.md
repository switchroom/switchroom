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

## Use case: multi-agent orchestration

In a Clerk multi-agent setup, each agent instance can run this plugin with a different `TELEGRAM_TOPIC_ID`, routing each forum topic to a dedicated agent while sharing a single bot token and group chat.
