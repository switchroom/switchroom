# Telegram Plugin

Switchroom ships an enhanced `switchroom-telegram` MCP plugin that replaces the official marketplace plugin. It is the default — no configuration needed.

## MCP tools

The plugin's tool count changes as features land — don't hard-code a number
here; `telegram-plugin/bridge/bridge.ts`'s `TOOL_SCHEMAS` array is the source
of truth. As of this writing it defines 21 tool schemas, grouped by purpose:

| Category | Tools | What it does |
|----------|-------|-------------|
| Messaging | `reply`, `edit_message`, `delete_message`, `forward_message`, `progress_update` | `reply` is the single final-answer tool — send text, photos, or documents. Chunks anything over the 32768-char rich-message cap (4096 applies only to plain-text degradations). Supports threading, topic routing, file attachments. `edit_message` updates a previously sent message silently (no push notification). `delete_message` removes a bot-sent message (48h Telegram API limit). `forward_message` quotes/resurfaces earlier messages with thread support. `progress_update` posts a short interim status line mid-turn. |
| Interactivity | `react`, `send_typing`, `ask_user`, `send_checklist`, `update_checklist`, `send_sticker`, `send_gif` | `react` adds emoji reactions (Telegram whitelist). `send_typing` shows a typing indicator (5s auto-expire). `ask_user` blocks for a structured reply. `send_checklist`/`update_checklist` render and mutate a tappable checklist card. `send_sticker`/`send_gif` send media. |
| History & attachments | `download_attachment`, `get_recent_messages` | Fetch files attached to inbound messages; query the SQLite history buffer with pagination and thread filtering. |
| Vault & secrets | `vault_request_save`, `vault_request_access`, `request_secret` | Post approval cards for saving/granting/requesting vault-backed secrets. |
| Memory | `mental_model_propose` | Post an approval card to create/refresh a Hindsight mental model. |
| Linear (conditional) | `linear_agent_activity`, `linear_create_issue`, `linear_agent_setup` | Only registered when Linear integration is configured for the agent. |

## Emoji status lifecycle

The plugin automatically reacts to inbound messages with a state machine
(`telegram-plugin/status-reactions.ts`) tracking CURRENT TURN ACTIVITY, not
delivery state. The real state set: `queued, thinking, coding, web,
compacting, awaiting, undelivered, error, stallSoft, stallHard`. Working
states (`thinking`, `tool`, `coding`, `web`, `compacting`) cycle freely and
bidirectionally within one turn — none is "higher" than another. The only
terminal state is reached via `finalize()`, triggered by the Stop hook
(`turn_end`).

A representative progression:

```
👀 queued → 🤔 thinking → 👨‍💻 coding → 👍 done
```

Stall watchdogs auto-promote to `🥱` (stallSoft) at 30s idle, `😨` (stallHard)
at 90s — so the user always knows the agent is alive. `🔥` is reserved for
genuine 5xx server errors, not for "streaming" — there is no streaming state.

Tool-specific reactions:
- `👨‍💻` for Bash/Edit/Write (coding)
- `⚡` for web search/fetch (web)

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

## Inbound message attributes

Every inbound Telegram message arrives as a `<channel source="telegram" ...>`
tag whose attributes are built in
`telegram-plugin/gateway/inbound-router.ts:112-484`. Notable ones:

| Attribute | Meaning |
|-----------|---------|
| `reply_to_message_id` | Set when the user long-pressed a prior message and chose Reply — that message is the antecedent for "this"/"that" pronoun references. `reply_to_text`/`reply_to_role`/`reply_to_kind` accompany it. |
| `message_thread_id` | The forum topic the message came from. |
| `origin_turn_id` | Pass this back on a reply (instead of `message_thread_id`) so the answer routes to the topic this message came from, even if a message from another topic arrived mid-turn. |
| `attachment_file_id`, `attachment_kind` | Present when the inbound message has a file attachment; feed `attachment_file_id` to `download_attachment`. |
| `forwarded_from`, `forwarded_from_type`, `forwarded_from_id`, `forwarded_date` | Server-stamped forward-origin context (Bot API 7.0+ `forward_origin`) — trustworthy provenance, unlike the forwarded body text. A multi-origin burst carries numbered siblings (`forwarded_from_2`, ...). |

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
