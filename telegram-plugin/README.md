# Clerk Telegram Plugin

A production-grade Telegram channel for Claude Code. Forked from the
[official Claude Code Telegram plugin](https://github.com/anthropics/claude-plugins-official)
and substantially extended for long-running, multi-agent deployments.

## Why this fork exists

The upstream plugin handles the basic send/receive wire protocol. This fork
adds the ergonomics and reliability that an always-on agent fleet needs:

- **Streaming replies** — `stream_reply` edits a single message in place as
  work progresses (~1/sec throttle), so users see live progress instead of
  silent gaps followed by a wall-of-text. Optional `lane` parameter lets each
  lane (e.g. `thinking` vs default `answer`) get its own message per chat+thread.
- **Status reactions** — emoji lifecycle (👀 queued → 🤔 thinking → 👨‍💻 tool
  use → 🔥 streaming → 👍 done) on the user's own message gives "I'm working"
  feedback for free, plus stall watchdogs (🥱 30s idle, 😨 90s).
- **Forum topic routing** — `message_thread_id` is auto-captured from inbound
  messages and applied to all replies, so multi-agent setups can run one bot
  per topic in a shared group.
- **Smart HTML chunking** — long messages split at paragraph/line boundaries
  with tag integrity preserved across the boundary (including `tg-spoiler`,
  `tg-emoji`, and tags with attributes like `<a href>` / `<code class>`).
- **Persistent SQLite history** — every inbound and outbound message is
  recorded locally. After a process restart, agents call `get_recent_messages`
  to recover context instead of asking "what were we doing?".
- **Inbound coalescing** — rapid multi-line user messages are buffered and
  delivered as a single turn, so agents see complete thoughts.
- **Edit-404 recovery + pre-send debounce** — handles the race where a
  message we're trying to edit was deleted, and avoids redundant edits when
  several updates arrive within `idleMs`.
- **Activity lane suppression** — filters Claude Code TUI noise (spinner verbs
  like "Running Reading", keyboard hints like "ctrl+o to expand") that the
  user can't action and shouldn't see.
- **Clerk slash-commands** — `/agents`, `/restart`, `/logs`, `/memory`,
  `/grant`, `/dangerous`, `/permissions`, `/reconcile` etc., handled by the
  plugin without consuming Claude Code tokens.
- **10 MCP tools** — `reply`, `stream_reply`, `react`, `edit_message`,
  `delete_message`, `forward_message`, `pin_message`, `send_typing`,
  `download_attachment`, `get_recent_messages`.

The fork is the **default** for clerk agents (no config needed). Set
`channels.telegram.plugin: official` to fall back to the upstream plugin.

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

### HTML formatting (default)

Outbound messages now default to `"html"` parse mode. Markdown in reply/edit text is auto-converted to Telegram HTML:

| Markdown | Telegram HTML |
|----------|---------------|
| `**bold**` | `<b>bold</b>` |
| `*italic*` | `<i>italic</i>` |
| `` `code` `` | `<code>code</code>` |
| ```` ```lang\ncode\n``` ```` | `<pre><code class="language-lang">code</code></pre>` |
| `~~strike~~` | `<s>strike</s>` |
| `[text](url)` | `<a href="url">text</a>` |

File references like `server.ts` or `package.json` are auto-wrapped in `<code>` tags. HTML entities (`<`, `>`, `&`) are escaped in plain text.

The `format` parameter accepts `"html"` (default), `"markdownv2"`, or `"text"`. Configure the default via `parseMode` in `access.json`.

### Smart HTML chunking

Long HTML messages are split at paragraph (`\n\n`), line (`\n`), or space boundaries. Open HTML tags are automatically closed at chunk boundaries and reopened in the next chunk, preventing broken formatting.

Default chunk limit: 4000 characters (configurable via `textChunkLimit` in `access.json`).

### Inbound message coalescing

Rapid consecutive messages from the same user/chat are buffered and combined into a single delivery (joined with `\n`). The buffer flushes after `coalescingGapMs` milliseconds of silence (default: 1500ms).

This prevents fragmented context when users send multi-line thoughts across several quick messages. Non-text messages (photos, documents, etc.) bypass coalescing.

Set `coalescingGapMs` to `0` in `access.json` to disable.

### Typing indicator auto-refresh

The `send_typing` tool now auto-refreshes the typing indicator every 4 seconds (Telegram's indicator expires after ~5s). Auto-stops after 30 seconds or when the next reply is sent.

On 401/Unauthorized errors, uses exponential backoff (up to 5 min) and resets on success.

### Error handling and retry

All outbound API calls use robust error handling:

| Error | Behavior |
|-------|----------|
| **429 Too Many Requests** | Wait `retry_after` seconds, then retry |
| **400 "not modified"** | Silent ignore (edit with same content) |
| **400 "thread not found"** | Retry without `message_thread_id` |
| **Network errors** | Retry up to 3 times with exponential backoff |

### Link preview control

Link previews are disabled by default in outbound messages. Control via:
- `disable_web_page_preview` parameter in the `reply` tool call
- `disableLinkPreview` in `access.json` (default: `true`)

### Configurable settings in access.json

```json
{
  "textChunkLimit": 4000,
  "parseMode": "html",
  "disableLinkPreview": true,
  "coalescingGapMs": 1500
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `textChunkLimit` | number | 4000 | Max chars per outbound message before splitting |
| `parseMode` | `"html"` \| `"markdownv2"` \| `"text"` | `"html"` | Default parse mode for outbound messages |
| `disableLinkPreview` | boolean | `true` | Disable link preview thumbnails |
| `coalescingGapMs` | number | 1500 | Debounce gap for inbound message coalescing (0 = disabled) |

### Read receipt indicator

When an inbound message is received, the plugin immediately reacts with an emoji to indicate it was seen. Configure via `ackReaction` in `access.json`:

```json
{
  "ackReaction": "👀"
}
```

Set to an empty string `""` to disable. Only Telegram's fixed emoji whitelist is accepted (👍 👎 ❤ 🔥 👀 🎉 etc). A typing indicator is also sent automatically.

### `stream_reply` tool (preferred for multi-step work)

Sends or updates a streaming reply that edits one message in-place rather
than sending many. Call repeatedly during long tasks with full snapshots of
the current message; the plugin throttles edits to ~1/sec to respect
Telegram's rate limit. Set `done=true` on the final call to lock the
message.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `chat_id` | yes | Target chat ID |
| `text` | yes | Full text snapshot (NOT a delta — pass the complete current content each call) |
| `done` | no | `true` on final call. After `done=true` the stream is locked and further calls are no-ops. Default `false`. |
| `format` | no | `"html"` (default), `"markdownv2"`, or `"text"` |
| `lane` | no | Optional lane name. Each lane gets its own Telegram message per chat+thread. Use `lane: "thinking"` to surface reasoning progress alongside the main answer stream. Omit for the default answer lane. |
| `message_thread_id` | no | Forum topic thread ID (auto-applied from the last inbound message if not specified) |

Hard-stops at 4096 chars (Telegram message limit). On edit-404 (the message
we're editing was deleted), the plugin sends a fresh message and continues
the stream against the new id. A short `idleMs` pre-send debounce coalesces
back-to-back snapshots before the first wire send, avoiding a redundant
edit when several updates arrive in the same tick.

### Manual streaming progress via `edit_message`

If you need finer control than `stream_reply` offers, you can drive the
edit loop yourself:

1. Send an initial "thinking..." message with `reply` — note the returned `message_id`
2. Call `edit_message` with updated text as work progresses (edits are silent — no push notification)
3. Call `send_typing` between steps to keep the typing indicator alive (it expires after ~5s)
4. When done, send a **new** `reply` so the user's device pings with a push notification

In most cases `stream_reply` is simpler and is the recommended path.

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

## Clerk bot commands

The plugin includes built-in `/commands` that execute `clerk` CLI operations directly — no Claude Code tokens consumed, instant response.

### Available commands

Each plugin instance is bound to one agent (via `CLERK_AGENT_NAME` set by `start.sh`), so per-agent commands default to **the current agent**. Pass an explicit name only when you want to act on a different one.

| Command | Description |
|---------|-------------|
| `/agents` | List all agents and their status |
| `/clerkstart [name]` | Start an agent (default: this agent) |
| `/stop [name]` | Stop an agent (default: this agent) |
| `/restart [name\|all]` | Restart an agent (default: this agent; pass `all` for every agent) |
| `/auth` | Show auth/token status |
| `/topics` | Show topic-to-agent mappings |
| `/logs [name] [lines]` | Show agent logs (default: this agent, 20 lines, max: 200). `/logs 50` works too. |
| `/memory <query>` | Search agent memory |
| `/reconcile [name\|all]` | Re-apply clerk.yaml + restart (default: this agent) |
| `/permissions [agent]` | Show allow/deny list (default: this agent) |
| `/grant <tool>` / `/grant <agent> <tool>` | Grant a tool permission and reconcile (default: this agent) |
| `/dangerous [off]` / `/dangerous <agent> [off]` | Toggle full tool access (default: this agent) |
| `/clerkhelp` | List all available clerk bot commands |

### How it works

Commands are intercepted by Grammy's command handlers *before* reaching the general message handler, so they never trigger Claude Code. Each command:

1. Checks sender authorization (must be in the allowlist or an allowed group)
2. Runs the corresponding `clerk` CLI command via `execFileSync`
3. Formats the output for Telegram (monospace code block, truncated at 4000 chars)
4. Replies in the correct forum topic if applicable

### Configuration

| Env var | Description |
|---------|-------------|
| `CLERK_CLI_PATH` | Path to the `clerk` binary (default: `clerk` on PATH) |
| `CLERK_CONFIG` | Path to clerk config file — passed as `--config` to all commands |

### Notes

- `/clerkstart` is used instead of `/start` to avoid conflicting with Telegram's built-in `/start` command (used for pairing).
- Commands work in both DM and group/topic contexts.
- In groups, only users in the group's allowlist can execute commands.
- Commands are registered with BotFather automatically on startup.

## Testing

```bash
cd telegram-plugin
bun test
```

402 tests across 19 files (~975 expectations, ~3s). Coverage spans:

- `markdownToHtml` — bold, italic, code, code blocks, links, strikethrough,
  escaping, file references, nested formatting, raw-HTML detection
- `splitHtmlChunks` — basic splitting, tag preservation across boundaries
  (incl. `tg-spoiler`/`tg-emoji` hyphen tags, `<a href>` / `<code class>`
  attribute preservation on reopen, mid-tag-cut back-off), paragraph-
  preference splitting, nested tags
- `stream_reply` handler — first-call create, subsequent edits, `done=true`
  finalisation, PTY suppression registration (prevents duplicate messages
  after stream finalises), lane separation
- PTY tail / activity lane — V1 extractor, spinner-verb suppression
  (`Running Reading: ctrl+o to expand` regression pinned), TUI keyboard hint
  suppression (`ctrl+`, `esc to`, `shift+`, `alt+`, `tab to`), continuation-
  line heuristic
- Outbound ordering — per-chat queue, parseMode rotation on retry, noisy-tool
  suppression
- Coalescing — key uniqueness, message combining, newline handling
- Edit-404 recovery + idleMs pre-send debounce
- Status reactions lifecycle, stall watchdogs
- Steering, handoff continuity, context exhaustion, history (SQLite)

## Use case: multi-agent orchestration

In a Clerk multi-agent setup, each agent instance runs this plugin with its **own bot token** (one bot per agent — Telegram's `getUpdates` long-poll holds an exclusive lock per token, so sharing a token between processes drops messages at random) and its own `TELEGRAM_TOPIC_ID`, routing each forum topic in a shared group to a dedicated agent.
