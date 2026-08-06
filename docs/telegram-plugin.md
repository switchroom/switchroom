# Switchroom's Telegram Plugin

Switchroom ships an enhanced Telegram MCP plugin (`switchroom-telegram`) that replaces the official `telegram@claude-plugins-official` marketplace plugin. It is the **default** for all agents. You don't need to configure anything to use it.

## Why a fork?

The official Telegram plugin provides basic message send/receive. Switchroom's fork adds everything needed for a production agent experience: streaming edits, emoji-driven progress signals, persistent message history, forum topic support, rich formatting, and per-agent access control.

## What the switchroom fork adds

### Message tools (11 MCP tools)

| Tool | What it does |
|------|-------------|
| `reply` | Send the final answer — text, photos, or documents; the single final-answer tool. Chunks anything over Telegram's 4096-char limit. Supports threading, topic routing, multi-file attachments, inline keyboard URL buttons, `protect_content`, `quote_text`, and an optional `accent` status header (`in-progress`/`done`/`issue`). |
| `react` | Add emoji reactions to messages (Telegram whitelist: 👍 👎 ❤️ 🔥 👀 🎉 etc). |
| `edit_message` | Update a previously sent message. |
| `delete_message` | Remove a bot-sent message (48h Telegram limit). |
| `forward_message` | Quote/resurface earlier messages with thread support. |
| `send_typing` | Show typing indicator during long operations (5s auto-expire). |
| `download_attachment` | Fetch files attached to inbound messages. |
| `get_recent_messages` | Query the local SQLite history buffer with pagination and thread filtering. |
| `send_checklist` | Checklist message — fixed-order items with per-item state. Native Telegram checklists are Business-account-only, so without a business connection (the normal case) it renders as a formatted ✅/⬜ text message and the result carries `degraded: "text"`. Returns a message id usable with `update_checklist` (#272). |
| `update_checklist` | Patch the state of items on a previously sent checklist (e.g. mark item 2 done) without re-sending the whole message. Re-renders in the mode the checklist was sent in. |

### Status accent headers

`reply` accepts an optional `accent: 'in-progress' | 'done' | 'issue'` parameter that prepends a status indicator line (`🔵 In progress…`, `✅ Done`, `⚠️ Issue`) above the message body. Use it for status communication on long-running work and completion announcements; omit it for routine conversational replies. (#328)

### Inline keyboard URL buttons

`reply` accepts an `inline_keyboard` parameter — an array of rows, each row an array of `{ text, url }` buttons — for tap-to-open links rendered as Telegram inline buttons (#271).

### Emoji status reactions

The plugin automatically reacts to the user's inbound message with a lifecycle progression:

👀 queued → 🤔 thinking → 👨‍💻 tool use → 🔥 streaming → 👍 done

Stall watchdogs promote to 🥱 (30s idle) then 😨 (90s) so the user always knows the agent is alive. Tool-specific reactions show what the agent is doing (👨‍💻 for bash/edit, ⚡ for web search/fetch).

### Background worker activity feed

When an agent dispatches a sub-agent with `run_in_background: true`, that worker decouples from the parent turn — once the turn ends, a long-running worker would read as silence with nothing surfacing its progress. The worker-activity feed closes that gap.

The feed is **on by default** (kill-switch: `SWITCHROOM_WORKER_ACTIVITY_FEED=0`). When on, the gateway posts **one regular Telegram message per background worker and edits it in place** as work happens:

```
🔧 Worker · Crawl the repo for dead code
⚡ Bash rg --files (4 tools · 00:21)
  ↳ Scanning src/ for unreferenced exports.
```

The header carries the **real dispatch task** (the `description` passed to the `Agent` tool), not a generic "sub-agent" label — it's read from the per-agent registry's `subagents` row. The message updates with the current tool, a running tool count, elapsed time, and a one-line summary, then finalizes to a terminal recap on completion:

```
✅ Worker done · Crawl the repo for dead code
20 tools · 01:36
```

(Failures finalize to `⚠️ Worker failed · …`.) It's the same "live, growing message" shape the agent's own answer uses — not a separate pinned card. Independently, the turn's 👍 (done) reaction is **held** while any background worker is still running, so the reaction never implies the work finished while a worker is still grinding.

The feed is on by default. To disable it per-agent, set `SWITCHROOM_WORKER_ACTIVITY_FEED=0` in the agent's gateway environment.

### Chat-legible memory (remembered / forgot)

When the agent **materially changes what it remembers** during a turn — stores a new standing directive, or invalidates/demotes an existing memory — the gateway surfaces **one terse line** in the originating chat/topic:

```
📌 remembered: "Always prefer TypeScript for this user's projects"
✂️ forgot: superseded deploy runbook
```

This makes memory honest and legible without being noisy. It is deliberately **sparse and material-only**:

- Fires only on `mcp__hindsight__create_directive` (📌 remembered) and `mcp__hindsight__invalidate_memory` / the `switchroom memory demote` tag path (✂️ forgot). In practice only the `invalidate_memory` branch can fire today: hindsight (0.8.4 and 0.8.5) has no per-memory tag-write path (`update_memory` accepts no `tags`/`add_tags`, and silently drops the unknown argument rather than rejecting it), so the demote branch is dead-but-forward-compatible — it lights up unchanged if upstream adds one. See `docs/configuration.md` → "Demoting individual memories from auto-recall".
- **Never** on ordinary recall, and **never** on routine consolidation — a per-turn "here's what I remember" line would itself be the "regurgitating old facts unprompted" anti-pattern the `remember-across-sessions` job forbids.

Detection is a deterministic tool-call observation (no model call, no polling). The line is a **real message** in the originating topic (never the operator DM), so it's durable and observable.

The surface is **on by default** (kill-switch: `SWITCHROOM_MEMORY_LEGIBILITY=0`). To disable it per-agent, set `SWITCHROOM_MEMORY_LEGIBILITY=0` in the agent's gateway environment.

#### Consolidation-driven "updated what I know" (opt-in)

The store/forget lines above are driven by the **foreground** session's own tool calls. The **background** consolidation engine — which distils new durable observations and supersedes stale ones between turns — is invisible to that path. When hindsight emits a `consolidation.completed` webhook, the gateway can surface a terse companion line for a *genuine* store/correct:

```
🧠 updated what I know about "your deploy preferences"
🧠 revised what I know about "the old runbook"
```

This is **off by default** and opt-in per agent: set `SWITCHROOM_CONSOLIDATION_LEGIBILITY=1` in the gateway environment. It is gated more tightly than the tool-observation path because it is fed by an unbounded background engine:

- **Material-only** — a line surfaces *only* when a consolidation actually stored or corrected a durable memory; the overwhelmingly common no-op consolidation surfaces nothing.
- **Rate-limited** — at most one line per agent per 10 minutes, and an identical "updated about X" line is suppressed for an hour, so a burst of material consolidations collapses to a single line.
- **Never a wake** — the webhook is recorded for audit and surfaced as a discrete status message (notifications suppressed); it never injects a model turn.

The webhook flows through the existing peercred-gated ingest socket (`webhook_via_gateway`); the pinned hindsight image does not yet emit `consolidation.completed`, so this consumer is dormant until that upstream event exists — which is why it ships off by default.

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

Admin agents are flagged with `admin: true` on their per-agent block
in `switchroom.yaml` — the same flag that gates `/agents`,
`/restart`, `/update`, `/logs`, etc. One knob to make an agent the
fleet control panel.

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

**There is no `/authfallback` command.** Pre-RFC-H builds had a
per-agent `/authfallback` verb that switched an agent to the next slot.
It was retired with the slot-pool model — fallback is now automatic and
fleet-wide (the broker rewires every affected agent without a command),
and the canonical *manual* control is `/auth use <label>` (swap the
whole fleet to a named healthy account) or `/auth rotate` (cycle to the
next non-exhausted account in `auth.fallback_order`). When the model is
unreachable, the "model unavailable" card now points at `/auth use`,
`/auth add`, and `/usage` — not `/authfallback`.

*Grounded in:* `telegram-plugin/model-unavailable.ts` (the card's
"What to try" block explicitly notes `/authfallback` is no longer a
verb post-RFC-H), `telegram-plugin/welcome-text.ts`,
`telegram-plugin/gateway/auth-command.ts`.

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

Progress-card messages are sent on a dedicated `lane: "progress"` via the
internal stream-reply handler so they don't collide with the answer message.
The final answer still lands separately via the model's `reply` call.

## Configuration

The switchroom fork reads additional env vars from `start.sh`:

| Env var | Source | Purpose |
|---------|--------|---------|
| `SWITCHROOM_TG_FORMAT` | `channels.telegram.format` | Default reply format (`html`, `markdownv2`, `text`) |
| `SWITCHROOM_TG_STREAM_MODE` | `channels.telegram.stream_mode` | `checklist` (default) or `pty`. See "Streaming modes" above |
| `TELEGRAM_STATE_DIR` | Auto-set by scaffold | Path to `telegram/` dir (history.db, access.json) |
| `SWITCHROOM_AGENT_NAME` | Auto-set by scaffold | Agent name for self-restart detection |
| `SWITCHROOM_CONFIG` | Auto-set by scaffold | Path to switchroom.yaml for config resolution |
| `SWITCHROOM_WORKER_ACTIVITY_FEED` | Gateway env (kill-switch) | On by default; `0` disables the background worker-activity feed. See "Background worker activity feed" above |
| `SWITCHROOM_MEMORY_LEGIBILITY` | Gateway env (kill-switch) | On by default; `0` disables the sparse "📌 remembered / ✂️ forgot" memory surface. See "Chat-legible memory" above |
| `SWITCHROOM_CONSOLIDATION_LEGIBILITY` | Gateway env (opt-in) | Off by default; `1`/`true`/`on`/`yes` enables the rate-limited "🧠 updated what I know about Y" line driven by the `consolidation.completed` webhook. See "Consolidation-driven" above |
