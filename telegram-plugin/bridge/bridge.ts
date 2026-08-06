#!/usr/bin/env bun
/**
 * Thin MCP bridge — connects to the persistent Telegram gateway over IPC,
 * forwards tool calls, and emits MCP notifications for inbound messages.
 * Also runs the session tail + PTY tail and forwards those events to the
 * gateway so it can drive progress cards and status reactions.
 *
 * One bridge instance per Claude Code session. The gateway survives across
 * session restarts; the bridge is ephemeral.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { dirname, join } from 'path'
import { homedir } from 'os'

import { installPluginLogger } from '../plugin-logger.js'
import { startSessionTail, type SessionEvent, type SessionTailHandle } from '../session-tail.js'
import { truncateDetailPreservingRequestId } from '../raw-error-scrub.js'
import {
  startPtyTail,
  V1ToolActivityExtractor,
  type PtyTailHandle,
} from '../pty-tail.js'
import { createIpcClient, type IpcClientHandle } from './ipc-client.js'
import { buildEffectiveToolSchemas, LINEAR_ENV } from './tool-filter.js'
import type { InboundMessage, PermissionEvent, StatusEvent } from '../gateway/ipc-protocol.js'
import { matchesAllowRule } from '../permission-rule.js'
import { createOutstandingPermissionLedger } from './permission-ledger.js'
import { appendCrashBreadcrumb } from './crash-breadcrumb.js'
import { InboundDedup, shouldDedupInbound, dedupChatKey } from './inbound-dedup.js'
import { MCP_INSTRUCTIONS } from './mcp-instructions.js'

installPluginLogger()

// ─── Config ──────────────────────────────────────────────────────────────

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const SOCKET_PATH = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(STATE_DIR, 'gateway.sock')
const TOPIC_ID = process.env.TELEGRAM_TOPIC_ID ? Number(process.env.TELEGRAM_TOPIC_ID) : undefined

// Refuse to start as an unidentified bridge. Without SWITCHROOM_AGENT_NAME
// we'd previously default to 'default' and register against whichever
// gateway socket happened to be reachable — which is not us! Other
// claude-code sessions on the same host (e.g. an operator debugging in
// ~/code/) load the telegram MCP plugin and would crosstalk into the
// agent's chat. See #430. The fingerprint of this in the wild is
// dozens of `registered agent=default` lines per gateway log per hour
// (analysis: #424). Phase 2 of #424 closes this hole at the source —
// the bridge — and adds a server-side guard in ipc-server.ts as
// defence in depth.
const AGENT_NAME = process.env.SWITCHROOM_AGENT_NAME
if (!AGENT_NAME) {
  process.stderr.write(
    'telegram bridge: SWITCHROOM_AGENT_NAME is not set; refusing to register against ' +
    `gateway at ${SOCKET_PATH} (would crosstalk into another agent's chat). ` +
    'If this is a switchroom agent, ensure start.sh exports the agent name. ' +
    'If this is a stray claude-code session, this exit is the correct outcome.\n',
  )
  process.exit(0)
}

// ─── MCP server ──────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'telegram', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: MCP_INSTRUCTIONS,
  },
)

// ─── Tool schemas (same as server.ts / gateway.ts) ───────────────────────

const TOOL_SCHEMAS = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. By default the reply is a quote-reply to the latest inbound user message in this chat+thread — pass quote:false to opt out, or pass an explicit reply_to to thread under a specific earlier message. files (absolute paths) attach images or documents. inline_keyboard adds tappable buttons (URL or callback) under the message — single-tap actions beat asking the user to type YES. ' +
      // Forum-topic routing: the framework owns the answer's topic, so the
      // agent must NOT pick one. Moved here from the MCP server instructions
      // (#3562) — that string is capped at 2048 chars by the Claude Code
      // client and this detail was being silently truncated away.
      'FORUM TOPICS: a reply is auto-routed back to the topic the question came from, so do NOT pass message_thread_id on a normal reply — pass the inbound\'s origin_turn_id instead, so the answer lands in the right topic even if a message from another topic arrived while you were working. message_thread_id is only for deliberately posting into a topic that is not the one you were asked in. ' +
      // Format modes: likewise moved out of the truncated instructions string.
      'FORMAT: by default your text is rendered as rich GFM markdown (Bot API 10.1) — write natural markdown (bold, italic, code, links, code blocks, lists, tables) and it renders as-is. Pass format: "text" to send plain text verbatim with no rendering. "html" and "markdownv2" are accepted legacy aliases that route through the exact same single rich GFM path — there is no separate HTML engine and no auto-escaping.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: { type: 'string', description: 'Message ID to thread under. Overrides the default (latest inbound).' },
        quote: { type: 'boolean', description: 'Opt out of the default quote-reply behavior. Default: true. Pass false to send a bare message with no quote reference. Ignored when reply_to is explicitly set.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message in the same chat if not specified.' },
        origin_turn_id: { type: 'string', description: 'In a forum supergroup, pass back the origin_turn_id attribute from the <channel> message you are answering. It pins the reply to that message\'s topic even if another topic\'s turn started meanwhile. Omit in DMs / single-topic chats.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach. Images send as photos; other types as documents. Max 50MB each. Telegram rejects photos with extreme dimensions (aspect ratio over ~10:1, width+height over 10000px, or over 10MB) — very tall images like full-page screenshots are auto-rerouted as documents; crop or split them first if the user should see them inline as photos.' },
        format: { type: 'string', enum: ['html', 'markdownv2', 'text'], description: "Rendering mode. Default renders your text as rich GFM markdown (Bot API 10.1). 'text' sends plain text verbatim. 'html' and 'markdownv2' are legacy aliases that route through the same single rich GFM path — no separate HTML engine, no auto-escaping." },
        disable_web_page_preview: { type: 'boolean', description: 'Disable link preview thumbnails. Default: true.' },
        protect_content: { type: 'boolean', description: 'When true, Telegram prevents the message from being forwarded or saved.' },
        quote_text: { type: 'string', description: 'Surgical quote: specific text to highlight from the reply_to message. Must be an EXACT substring of that message (copy it verbatim, do not paraphrase; max 1024 chars) — a quote Telegram cannot find is dropped and the reply lands unquoted. Requires reply_to.' },
        disable_notification: { type: 'boolean', description: 'When true, Telegram delivers the message silently — no device ping for this user. Default false (pings). Use true for mid-turn updates ("still working through X") so only the final answer pings. Always omit (or pass false) on the final answer of a turn.' },
        inline_keyboard: {
          type: 'array',
          description: 'Optional 2D array of tappable buttons rendered under the message. Outer array = rows; inner array = buttons in each row (max 8 per row, 8 rows). Each button needs a `text` (label, max 64 chars) plus EXACTLY ONE of: `url` (opens link in browser; must start with http(s):// or tg://) or `callback_data` (string, max 58 chars; tap is delivered to this agent as an inbound channel event with meta.button_callback_data=<the data> and the original button_text). Use buttons for single-tap approval/triage flows like [Approve] [Hold]; one tap on mobile beats asking the user to type YES/NO. By default a tap shows a brief "✓ received" toast and removes the entire keyboard so the user can\'t double-fire — override per-button via `ack_text` (custom toast text, max 200 chars) and `single_use: false` (preserve the keyboard so e.g. a [Refresh] button stays tappable).',
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Button label visible to the user. Max 64 chars.' },
                url: { type: 'string', description: 'Open this URL when tapped. Mutually exclusive with callback_data.' },
                callback_data: { type: 'string', description: 'Opaque tag delivered back to the agent on tap. Max 58 chars (gateway prepends an `agent:` prefix to the 64-byte Telegram limit). Mutually exclusive with url.' },
                ack_text: { type: 'string', description: 'Toast text shown to the user the instant they tap this button (#710). Default "✓ received". Max ~200 chars (Telegram answerCallbackQuery limit). Has no effect on URL buttons.' },
                single_use: { type: 'boolean', description: 'When true (default) tapping any single_use button on the message removes the entire keyboard so the user can\'t double-fire. Set false on buttons that should stay tappable (e.g. a "Refresh" button). If ANY button on the message has single_use:false the keyboard is preserved on tap.' },
                inline_keyboard_confirm: { type: 'boolean', description: 'Per-message override for the "✅ You chose: <label> · HH:MM" body annotation on tap (#789). true forces the annotation even if the agent default is off; false skips it even if the agent default is on; omit to use the agent default. Only applies to single-use keyboards and requires the agent parseMode to be the default html. Has no effect on URL buttons. Note: annotation rebuilds the body from the message\'s plain text, so formatting entities on the original message are lost.' },
              },
              required: ['text'],
            },
          },
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'progress_update',
    description:
      'Post a short interim progress line to Telegram mid-task ("still working through X"). Sends a NEW plain message to the chat — it is not an edit and not a card row, so use it sparingly and only when the user genuinely benefits from knowing where a long task stands. The gateway enforces its own limits: text is truncated at 300 chars, at most one update per 20s per chat+thread, and at most 5 per turn; over-limit calls return {ok:false, reason:"too_soon"|"turn_limit"} instead of sending. Prefer edit_message when you already own a message to update, and always deliver the actual answer with reply.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat to post the progress line in — pass chat_id from the inbound message.' },
        text: { type: 'string', description: 'The progress line. One short sentence; truncated at 300 chars by the gateway.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message in the same chat if not specified.' },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'download_attachment',
    description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message the bot previously sent. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: { type: 'string', enum: ['html', 'markdownv2', 'text'], description: "Rendering mode. Default renders your text as rich GFM markdown (Bot API 10.1). 'text' sends plain text verbatim. 'html' and 'markdownv2' are legacy aliases that route through the same single rich GFM path — no separate HTML engine, no auto-escaping." },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'send_typing',
    description: 'Send a chat-status indicator. Default "typing" matches the legacy behavior; pass `action` to surface upload_document, record_voice, etc. so the indicator matches what the agent is actually doing. The indicator auto-refreshes every 4s for 30s; call again for longer operations.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        action: {
          type: 'string',
          enum: [
            'typing',
            'upload_photo',
            'record_video',
            'upload_video',
            'record_voice',
            'upload_voice',
            'upload_document',
            'choose_sticker',
            'find_location',
            'record_video_note',
            'upload_video_note',
          ],
          description: 'Telegram Bot API chat action. Defaults to "typing".',
        },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message the bot previously sent. Prefer edit_message if you just want to update text — delete_message is for true removal.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'forward_message',
    description: 'Forward an existing message to a chat. Preserves the original sender attribution. In forum topics, the forwarded message lands in the correct thread.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Destination chat ID' },
        from_chat_id: { type: 'string', description: 'Source chat ID where the original message lives' },
        message_id: { type: 'string', description: 'ID of the message to forward' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID in the destination chat. Auto-applied from the last inbound message if not specified.' },
      },
      required: ['chat_id', 'from_chat_id', 'message_id'],
    },
  },
  {
    name: 'get_recent_messages',
    description: 'Fetch the most recent messages from a chat (or specific forum topic). Returns both inbound and outbound messages, oldest-first. Telegram\'s Bot API exposes no history endpoint, but this plugin keeps a local SQLite buffer of every inbound and outbound message, and that buffer survives restarts — so call this to recover context after a Claude Code session restart instead of asking the user "what were we doing?". Optional message_thread_id filters to a single forum topic.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat to fetch history for.' },
        message_thread_id: { type: 'string', description: 'Optional forum topic filter.' },
        limit: { type: 'number', description: 'How many messages to return. Default 10, max 50.' },
        before_message_id: { type: 'string', description: 'Paginate backward: pass the smallest message_id from the previous page.' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'send_checklist',
    description:
      'Send a checklist (task list) to a chat. Native interactive Telegram checklists require a Business-account connection, which most deployments do not have — in that normal case the checklist is sent as a formatted TEXT message (bold title + ✅/⬜ task lines) and the result carries degraded:"text": tasks are NOT tappable, and you tick them yourself via update_checklist (task ids are 1..N in send order). With a Business connection configured, the checklist is sent natively and tick events arrive as channel events with kind="checklist_task_changed". Returns JSON with message_id and mode. Limit: 30 tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Target chat ID.' },
        title: { type: 'string', description: 'Checklist title shown above the task list.' },
        tasks: {
          type: 'array',
          description: 'Task list. Each item has a text (required) and an optional done flag. Max 30 items.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Task label text.' },
              done: { type: 'boolean', description: 'Pre-check the task. Default: false.' },
            },
            required: ['text'],
          },
        },
        message_thread_id: {
          type: 'string',
          description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.',
        },
        reply_to: {
          type: 'string',
          description: 'Message ID to reply-to / thread under.',
        },
        protect_content: {
          type: 'boolean',
          description: 'When true, Telegram prevents forwarding or saving the message.',
        },
      },
      required: ['chat_id', 'title', 'tasks'],
    },
  },
  {
    name: 'send_sticker',
    description:
      'Send a Telegram sticker. Use sparingly to add warmth or emotional punctuation that text alone reads cold for — non-coding personas (assistant, health-coach, lawyer) benefit most. Pass either a raw Telegram file_id (echo one back from an inbound sticker the user sent you) OR an alias name declared by the operator in switchroom.yaml under telegram.stickers (e.g. "happy", "thinking"). Aliases are operator-curated; you cannot create them yourself. The error message lists available aliases when an unknown one is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        sticker: { type: 'string', description: 'Telegram file_id OR alias name from telegram.stickers config.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
        reply_to: { type: 'string', description: 'Message ID to thread the sticker under.' },
      },
      required: ['chat_id', 'sticker'],
    },
  },
  {
    name: 'send_gif',
    description:
      'Send an animated GIF / MP4 / WebM. Pass either a Telegram file_id (echoed from an inbound GIF you saw) or a public https URL ending in .mp4 / .gif / .webm. URLs from operator-trusted sources only — there is no built-in GIF search; you cannot synthesise URLs. Use even more sparingly than send_sticker; GIFs are noisy in chat and only serve specific moods (celebration, exasperation, "got it"). Caption optional, max 1024 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        gif: { type: 'string', description: 'Telegram file_id OR https URL ending in .mp4 / .gif / .webm.' },
        caption: { type: 'string', description: 'Optional caption (max 1024 chars).' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
        reply_to: { type: 'string', description: 'Message ID to thread the gif under.' },
      },
      required: ['chat_id', 'gif'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Pose a multiple-choice question to the user via inline-keyboard buttons. Use when you need a deterministic choice (yes/no, option-A/B/C, severity levels) rather than free-form prose — the user taps one of the options and you receive their selection as the tool result. Returns { kind: "answered", choice: "<exact option text>" } on tap, { kind: "timeout" } if the user does not respond within timeout_ms (default 300_000ms / 5min, capped at 1_800_000ms / 30min). Do NOT use for "what would you like me to do next" generic prompts — that defeats the persistent-conversation model. Use for forced choices.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat that should receive the question. Pass from inbound meta.' },
        question: { type: 'string', description: 'The question text. Plain text or GFM markdown (rendered through the same rich path as replies). Keep it short — buttons render below.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 8 button labels. Each label becomes one tappable button. Returned verbatim as `choice` on tap.',
        },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
        timeout_ms: { type: 'integer', description: 'Cancel the prompt and return { kind: "timeout" } after this long. Default 300000 (5min). Max 1800000 (30min).' },
        reply_to: { type: 'string', description: 'Message ID to thread the question under. Default: the inbound message that triggered this turn.' },
      },
      required: ['chat_id', 'question', 'options'],
    },
  },
  {
    name: 'update_checklist',
    description:
      'Patch a checklist previously sent with send_checklist: update the title, append tasks, or mark tasks done/undone. Tasks with an id target existing items (ids are 1..N in send order for text-mode checklists); tasks without an id are appended. Removal is not supported. The edit re-renders in the mode the checklist was sent in (text for most deployments). Returns JSON { ok, ... }; after a gateway restart the stored task state may be gone — then it returns ok:false with reason "unknown_checklist" unless you pass a full replacement (title + every task\'s text).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat that owns the checklist.' },
        message_id: { type: 'string', description: 'Message ID of the checklist to update.' },
        title: { type: 'string', description: 'New title. Omit to keep current title.' },
        tasks: {
          type: 'array',
          description: 'Task patch list. Items with id target existing tasks; items without id are added.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Existing task id (32-bit int as string). Omit to add a new task.' },
              text: { type: 'string', description: 'New label text for the task.' },
              done: { type: 'boolean', description: 'Mark the task done (true) or undone (false).' },
            },
          },
        },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'vault_request_save',
    description:
      'Ask the user to confirm saving a secret value to the vault. Use this when the user gave you a credential/token in chat and asked you to save it (or when you discovered one mid-task that the user should curate). Renders a Telegram approval card with [Save once] [Discard] [Rename] buttons; the value is written to the host vault only when the user taps Save. The value never leaves the host — it is staged inside the gateway and never echoed back to the agent. Do NOT use this tool to read secrets — use the standard vault: reference syntax in your scaffolded prompt. Do NOT call this for values the user did not explicitly hand you (no proactive secret discovery from filesystem scans, command output, etc).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat to render the approval card in (use the chat_id of the user message that delivered the secret).' },
        key: { type: 'string', description: 'Suggested vault key (slug) to store the secret under. The user can override via the [Rename] button. Use lowercase snake_case, e.g. `klanker_telegram_bot_token`.' },
        value: { type: 'string', description: 'The secret value to save. Will be staged in the gateway and never echoed back to the agent.' },
        why: { type: 'string', description: 'Short human-readable reason rendered on the card (e.g. "for the klanker UAT bot you asked me to set up"). Helps the user verify intent.' },
        kind: { type: 'string', enum: ['string', 'binary'], description: 'Storage shape. Default "string". Use "binary" for base64-encoded blobs.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
      },
      required: ['chat_id', 'key', 'value'],
    },
  },
  {
    name: 'vault_request_access',
    description:
      'Ask the operator (via Telegram approval card) to grant this agent read or write access to a vault key it does not yet have. Use this when you hit `VAULT-BROKER-DENIED` or when you know upfront that an upcoming task needs a key you lack. Renders a [Approve] [Deny] card; on approve, the broker mints a scoped grant token and writes it to the agent\'s `.vault-token` file. You CANNOT mint or self-elevate; only the operator can tap Approve. After firing this tool, END YOUR TURN cleanly — the gateway will inject a fresh inbound message (with `<channel source="vault_grant_approved">`) when the operator approves, kicking off a new turn where you can resume the original task. Do NOT call this for keys you already have access to (use the normal `vault:<key>` reference) and do NOT spam-request (the operator sees every card).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat to render the approval card in (use the chat_id of the user message that triggered the workflow).' },
        key: { type: 'string', description: 'Vault key the agent wants access to (matches the key shown in the VAULT-BROKER-DENIED error, e.g. `fatsecret/credentials`).' },
        scope: { type: 'string', enum: ['read', 'write'], description: 'Access scope: "read" (default) for `vault:<key>` references; "write" if the agent needs to put new values.' },
        reason: { type: 'string', description: 'REQUIRED in practice — short human-readable rationale rendered on the card (e.g. "to look up today\'s food log entries"). The approval card now renders "why: not provided" when this is omitted, which signals to the operator that the agent skipped its explanation — they will usually Deny. Always supply a one-line rationale. `why` is accepted as an alias (matching `vault_request_save`).' },
        why: { type: 'string', description: 'Alias for `reason` (matches the sibling tool `vault_request_save`). If both are supplied, `reason` wins.' },
        duration: { type: 'string', description: 'Requested grant TTL, like "30d" or "12h". Default 30d, capped at 90d. Beyond 90d the operator should use the host CLI explicitly.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
      },
      required: ['chat_id', 'key'],
    },
  },
  {
    name: 'request_secret',
    description:
      'Ask the operator to PROVIDE a secret you do not have, securely — NEVER ask the user to paste a token/key/password as a normal chat message. Use this when you need a credential that is not in the vault (a `vault:<key>` reference is missing/empty, or you know an upcoming task needs one you lack). Renders a Telegram card with [Provide securely] [Decline]; on tap, the operator sends the value once and the gateway DELETES their message instantly and writes it straight to the vault — the raw value is never echoed back to you. You receive only `vault:<key>`. This is the sibling of `vault_request_save` (use that when the user already handed YOU a value to store) and `vault_request_access` (use that when the key exists but you lack read access). After firing this tool, END YOUR TURN cleanly — a fresh inbound message arrives once the operator provides (or declines) the secret. Do NOT call this for keys you already have, and do NOT spam (one open request per key; the operator sees every card).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat to render the card in (use the chat_id of the user message that triggered the workflow).' },
        key: { type: 'string', description: 'Vault key to store the provided secret under. Use lowercase namespaced snake_case, e.g. `coolify/api-token`.' },
        reason: { type: 'string', description: 'REQUIRED in practice — one-line human-readable rationale rendered on the card (e.g. "to trigger a redeploy on Coolify"). Omitting it makes the operator more likely to Decline.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
      },
      required: ['chat_id', 'key'],
    },
  },
  {
    name: 'mental_model_propose',
    description:
      "Propose a Hindsight MENTAL MODEL for the operator to approve (agent-proposes → human-approves, hindsight Phase 5). Use this when — over real work — you notice a recurring, domain-specific question worth maintaining a standing, semantically-refreshed answer to from YOUR bank (e.g. a coach's `training-plan-state`, a lawyer's `open-matters`). You may PROPOSE but can NEVER self-approve: this renders a Telegram [Approve]/[Deny] card to the operator. On Approve the model is DECLARED — appended to your `memory.mental_models[]` in switchroom.yaml via the operator-approved config-edit path — and ensured in your bank (it then refreshes from your bank content). On Deny nothing is written. This is NOT for identity/'who is the user' (dedicated profile banks own that) and NOT a substitute for `retain` (store a fact) or `create_mental_model` where you already have direct Hindsight tools — it is the leashed, human-gated way to add a DURABLE declared model to your config. After firing this tool, END YOUR TURN cleanly — a fresh inbound arrives (`<channel source=\"mental_model_proposal_applied\">` / `mental_model_proposal_denied`) once the operator decides. Do NOT propose a model whose name is already declared (it is rejected), and do NOT spam (one card per proposal; the operator sees every one).",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat to render the approval card in (use the chat_id of the user message that triggered the workflow).' },
        name: { type: 'string', description: 'Stable model name — the idempotent-ensure identity key (lowercase kebab/snake, e.g. `training-plan-state`). Must be UNIQUE among your already-declared models or the proposal is rejected.' },
        source_query: { type: 'string', description: 'The reflection query the model answers, semantically refreshed from your bank content (e.g. "What is the athlete\'s current training plan, recent sessions, and open adjustments?"). Frame it as a DOMAIN question, never an identity question.' },
        reason: { type: 'string', description: 'REQUIRED in practice — one-line rationale rendered on the card (e.g. "I keep re-deriving the plan state every session; a standing model would save the lookup"). Omitting it renders "why: not provided" and the operator will usually Deny.' },
        refresh_after_consolidation: { type: 'boolean', description: 'Refresh this model after each consolidation. Defaults OFF — refresh adds bounded background model-spend + timeout risk (RFC Phase 5). Only set true when the model genuinely needs to track fast-moving state.' },
        max_tokens: { type: 'number', description: 'Optional cap on the synthesized model\'s token size.' },
        message_thread_id: { type: 'string', description: 'Forum topic thread ID. Auto-applied from the last inbound message if not specified.' },
      },
      required: ['chat_id', 'name', 'source_query'],
    },
  },
  {
    name: 'linear_agent_activity',
    description:
      'Emit a structured Linear AgentActivity against an agent session (#2298). Use this ONLY inside a turn that was woken by a Linear agent session (the inbound carries meta.source="linear" and meta.agent_session_id) — pass that agent_session_id back here. Linear renders activities as status chips + a timeline on the issue, so the human sees acknowledge → work → result. Emit a `thought` within ~10s of being woken so the session does not look dead, then `message`(s) as you make progress, and finally exactly one terminal `complete` (work done) or `error` (you could not proceed). body is required for thought/message/error and optional for complete. Resolves the agent\'s Linear app token from the vault; on VAULT-BROKER-DENIED it returns an error instructing you to vault_request_access for `linear/<agent>/token`.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_session_id: {
          type: 'string',
          description: 'The Linear AgentSession id — copy it verbatim from the woken turn\'s meta.agent_session_id.',
        },
        type: {
          type: 'string',
          enum: ['thought', 'message', 'complete', 'error'],
          description: 'Activity kind. thought = visible reasoning ack (emit within ~10s); message = progress update; complete = terminal success; error = terminal failure.',
        },
        body: {
          type: 'string',
          description: 'Activity text (Markdown). Required for thought/message/error; optional for complete (a closing summary).',
        },
      },
      required: ['agent_session_id', 'type'],
    },
  },
  {
    name: 'linear_create_issue',
    description:
      'File a new Linear issue from a Telegram message the operator flagged for capture (#2312). Use this when a turn was triggered by a capture reaction (the inbound carries event="reaction" with a capture emoji like 👨‍💻 or 📌) — turn the reacted message + any relevant thread context into a well-formed issue. Write a crisp imperative title and a body that captures the ask, the context, and any acceptance criteria you can infer; the agent files it AS its own Linear app actor. Team is auto-resolved when the workspace has a single team; if there are multiple it returns text asking for an explicit team_id. Pass dedup_key (e.g. the chat_id:message_id of the reacted message) so a re-react of the same message does not file a duplicate. Resolves the agent\'s Linear app token from the vault; on VAULT-BROKER-DENIED it returns text instructing you to vault_request_access for `linear/<agent>/token`. Returns "Filed: <title> → <url>" on success — reply that link to the operator in plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Issue title — a crisp, imperative one-liner (e.g. "Fix duplicate webhook retries on Brevo sync").',
        },
        body: {
          type: 'string',
          description: 'Issue description (Markdown). Capture the ask, relevant context from the message/thread, and any acceptance criteria you can infer.',
        },
        team_id: {
          type: 'string',
          description: 'Optional Linear team id. Omit to auto-resolve when the workspace has a single team; required only when the workspace has multiple teams.',
        },
        dedup_key: {
          type: 'string',
          description: 'Optional idempotency key (use the reacted message identity, e.g. "<chat_id>:<message_id>"). A prior capture with the same key short-circuits to "Already filed: <url>".',
        },
        priority: {
          type: 'number',
          description: 'Optional Linear priority (0 none, 1 urgent, 2 high, 3 normal, 4 low).',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'linear_agent_setup',
    description:
      'Provision THIS agent as a Linear app actor (actor=app OAuth) from inside the container — the operator-approved in-container path that replaces the host-only `switchroom linear-agent setup` (which silently no-ops in a sandbox). Two steps. action="authorize_url": pass the OAuth app client_id + redirect_uri; returns the browser URL the operator opens to consent. action="complete": pass client_id, client_secret, redirect_uri, and the code from the redirect; exchanges it and stores the access token (linear/<agent>/token) + the durable refresh bundle (linear/<agent>/oauth) via the vault broker so the token auto-renews. Writing those NEW keys needs a write-grant — if the broker denies, the tool returns the exact vault_request_access calls to make (operator approves), then re-run "complete". After it stores the values, follow the returned guidance to config_propose_edit the linear_agent block + secrets[] ACL (also operator-approved) to make it durable. The client_secret and code are used in-process only — never stored in config or logged.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['authorize_url', 'complete'],
          description: '"authorize_url" to get the browser consent URL; "complete" to exchange the code and store the credentials.',
        },
        client_id: {
          type: 'string',
          description: 'Linear OAuth app client id (from Linear → Settings → API → your agent app).',
        },
        redirect_uri: {
          type: 'string',
          description: 'The redirect URI registered on the Linear OAuth app (e.g. http://localhost:3000/callback). Must match exactly in both steps.',
        },
        client_secret: {
          type: 'string',
          description: 'Linear OAuth app client secret. Required for action="complete"; used in-process for the token exchange, never stored or logged.',
        },
        code: {
          type: 'string',
          description: 'The authorization code from the redirect URL (the `code=` query param). Required for action="complete"; single-use.',
        },
      },
      required: ['action', 'client_id', 'redirect_uri'],
    },
  },
]

// Tool-surface right-sizing (P4): connection-gate linear_* + per-tool
// alwaysLoad pins for the hot path. See tool-filter.ts for the rationale.
// Computed once at startup — SWITCHROOM_TELEGRAM_LINEAR is fixed for the
// process lifetime (set by the gateway in .mcp.json when Linear is wired).
const EFFECTIVE_TOOL_SCHEMAS = buildEffectiveToolSchemas(TOOL_SCHEMAS, {
  linearEnabled: process.env[LINEAR_ENV] === '1',
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: EFFECTIVE_TOOL_SCHEMAS,
}))

// ─── MCP CallTool → IPC forward ─────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (!ipc || !ipc.isConnected()) {
    return {
      content: [{ type: 'text', text: 'error: not connected to gateway' }],
      isError: true,
    }
  }

  try {
    // reply and stream_reply can take a while (chunking, retries)
    const timeout = (tool === 'reply' || tool === 'stream_reply') ? 60_000 : 15_000
    const result = await ipc.callTool(tool, args, timeout)

    if (!result.success) {
      return {
        content: [{ type: 'text', text: result.error ?? 'tool call failed' }],
        isError: true,
      }
    }

    // #2094 finding 4 — turn-complete reset. A successful reply / stream_reply
    // is the bridge's turn-complete proxy: the agent delivered its answer for
    // this chat, so the per-chat inbound-dedup set can be cleared (thread-
    // agnostic — the reply may omit message_thread_id). Bounds memory and lets
    // a genuinely NEW turn re-use ids the sweep might legitimately resend.
    if (inboundDedupEnabled && (tool === 'reply' || tool === 'stream_reply')) {
      const replyChatId = args.chat_id
      if (typeof replyChatId === 'string' && replyChatId.length > 0) {
        inboundDedup.clearChat(replyChatId)
      }
    }

    // The gateway returns the same shape as the legacy server.ts handlers:
    // { content: [{ type: 'text', text: '...' }] }
    if (result.result && typeof result.result === 'object' && 'content' in (result.result as object)) {
      return result.result as { content: Array<{ type: string; text: string }> }
    }

    return {
      content: [{ type: 'text', text: typeof result.result === 'string' ? result.result : JSON.stringify(result.result) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `tool call failed: ${(err as Error).message}` }],
      isError: true,
    }
  }
})

// ─── Permission request forwarding ──────────────────────────────────────
// Claude Code sends permission_request notifications when it needs tool
// approval. Forward them to the gateway which renders inline keyboard
// buttons in the user's Telegram chat. The gateway sends the decision
// back as a PermissionEvent which we relay to Claude Code (see onPermission).
//
// #1138: session-scoped always-allow cache. When the operator taps
// "🔁 Always allow" the gateway calls `switchroom agent grant` which
// updates settings.json on disk, but the running claude process won't
// re-read that file — so a sub-agent (Task tool) dispatched later in
// the same session still hits the popup. To close that gap the gateway
// also broadcasts the resolved `rule` on the `permission` event and we
// stash it here; subsequent `permission_request` notifications whose
// (tool_name, input_preview) match a cached rule are auto-allowed
// without a round-trip to Telegram. The cache lives for the bridge's
// lifetime — which is the claude session's lifetime — so on the next
// boot the now-persisted `tools.allow` entry takes over and this cache
// is rebuilt as the operator approves things again. Parent claude and
// every Task-tool sub-agent share the same bridge process, so a rule
// added by either is honoured by all.
const sessionAllowRules = new Set<string>()

// #2861: outstanding permission-request ledger. Every permission_request from
// claude is recorded here and re-sent on each IPC (re)connect, so a request
// that arrives while the gateway is down (or that the gateway lost across a
// restart) is redelivered instead of dropped. Deleted in onPermission when a
// verdict is delivered. Kill switch: SWITCHROOM_PERMISSION_REARM=0 reverts to
// the legacy drop-when-disconnected behavior.
const outstandingPermissions = createOutstandingPermissionLedger()
const permissionRearmEnabled = process.env.SWITCHROOM_PERMISSION_REARM !== '0'

/**
 * Re-send every outstanding permission_request to the gateway. Called on each
 * IPC (re)connect via the ipc-client onConnect hook. The gateway dedupes /
 * re-arms them idempotently (gateway/permission-rearm.ts), so re-sending on
 * every reconnect is safe. Never answers a card — re-transmits the question.
 */
function flushOutstandingPermissionRequests(): void {
  if (!permissionRearmEnabled) return
  if (!ipc || !ipc.isConnected()) return
  const pending = outstandingPermissions.all()
  if (pending.length === 0) return
  process.stderr.write(
    `telegram bridge: re-sending ${pending.length} outstanding permission request(s) on gateway (re)connect\n`,
  )
  for (const p of pending) {
    ipc.sendPermissionRequest({
      type: 'permission_request',
      requestId: p.request_id,
      toolName: p.tool_name,
      description: p.description,
      inputPreview: p.input_preview,
    })
  }
}

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    // Cache hit? Auto-allow without bothering the gateway. We deliver
    // the same `notifications/claude/channel/permission` shape claude
    // would otherwise receive after a Telegram tap, so the call site
    // is indistinguishable. We still notify the gateway out-of-band
    // (via a permission_request that the gateway short-circuits on
    // its side would be ideal, but for now skipping the forward is
    // safe: pendingPermissions is a gateway-side bookkeeping map only,
    // and nothing else depends on seeing this request_id).
    for (const rule of sessionAllowRules) {
      if (matchesAllowRule(rule, params.tool_name, params.input_preview)) {
        process.stderr.write(
          `telegram bridge: session-cached allow for ${params.tool_name} ` +
          `(rule="${rule}", request_id=${params.request_id})\n`,
        )
        onPermission({
          type: 'permission',
          requestId: params.request_id,
          behavior: 'allow',
        })
        return
      }
    }
    // #2861: record the request in the outstanding ledger BEFORE the connect
    // check so it survives a disconnected gateway and is re-sent on reconnect.
    // It's deleted in onPermission when the verdict is delivered.
    if (permissionRearmEnabled) {
      outstandingPermissions.add({
        request_id: params.request_id,
        tool_name: params.tool_name,
        description: params.description,
        input_preview: params.input_preview,
      })
    }
    if (!ipc || !ipc.isConnected()) {
      // BUFFER, don't drop (#2861 R2). The request is in the ledger; the
      // onConnect flush re-sends it once the gateway is reachable. Falls back
      // to the legacy drop only when re-arm is killed.
      if (permissionRearmEnabled) {
        process.stderr.write(
          `telegram bridge: permission_request buffered (gateway offline), will re-send on reconnect ` +
          `request_id=${params.request_id}\n`,
        )
      } else {
        process.stderr.write('telegram bridge: permission_request received but not connected to gateway\n')
      }
      return
    }
    ipc.sendPermissionRequest({
      type: 'permission_request',
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    })
  },
)


// ─── IPC client ──────────────────────────────────────────────────────────

let ipc: IpcClientHandle | null = null

// #2094 finding 4 — bridge-side messageId dedup. Guards against the
// stranded-message sweep re-delivering a genuine user message that was
// already forwarded to claude (double-executing side-effectful commands,
// double 👀). Cleared per-chat on turn-complete (a successful reply /
// stream_reply, below) and capped defensively. Kill switch:
// SWITCHROOM_INBOUND_DEDUP=0.
const inboundDedup = new InboundDedup()
const inboundDedupEnabled = process.env.SWITCHROOM_INBOUND_DEDUP !== '0'

function onInbound(msg: InboundMessage): void {
  // Drop a re-delivered duplicate of a plain user message before it reaches
  // the claude session. Only genuine re-deliverable messages are eligible
  // (see shouldDedupInbound) — synthetic / button / structured-event inbounds
  // are always forwarded.
  if (inboundDedupEnabled && shouldDedupInbound(msg)) {
    const chatKey = dedupChatKey(msg.chatId, msg.threadId)
    if (inboundDedup.checkAndRecord(chatKey, msg.messageId) === 'duplicate') {
      process.stderr.write(
        `telegram bridge: dropping duplicate inbound messageId=${msg.messageId} ` +
        `chat=${chatKey} (already forwarded this turn — sweep re-delivery, #2094)\n`,
      )
      return
    }
  }
  // Convert IPC InboundMessage → MCP channel notification
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: msg.text,
      meta: msg.meta,
    },
  }).catch((err) => {
    process.stderr.write(`telegram bridge: failed to deliver inbound to Claude: ${err}\n`)
  })
}

function onPermission(msg: PermissionEvent): void {
  // #1138: stash the rule the gateway resolved on "Always allow" so we
  // can short-circuit later matching permission_request notifications
  // (from the parent claude or any Task-dispatched sub-agent in the
  // same session). The gateway only sets `rule` when it has also
  // persisted the rule to settings.json, so a process restart will
  // pick up the same set of rules from disk — the cache is purely a
  // mid-session bridge between the disk write and the next agent boot.
  if (msg.rule) {
    sessionAllowRules.add(msg.rule)
  }
  // #2861: verdict delivered → drop the request from the outstanding ledger so
  // a later reconnect doesn't re-send an already-resolved approval.
  outstandingPermissions.delete(msg.requestId)
  mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: {
      request_id: msg.requestId,
      behavior: msg.behavior,
      // `message` (deny only) is rendered by claude's channel as
      // "…the user said: ${message}". We use it to tell the model a deny was
      // a TIMEOUT, not a human denial — so it doesn't retry the identical
      // call and re-raise a duplicate card. Omitted → claude's default
      // "Denied" (safe degradation).
      ...(msg.message ? { message: msg.message } : {}),
    },
  }).catch((err) => {
    process.stderr.write(`telegram bridge: failed to deliver permission to Claude: ${err}\n`)
  })
}

function onStatus(msg: StatusEvent): void {
  process.stderr.write(`telegram bridge: gateway status: ${msg.status}\n`)
  if (msg.status === 'gateway_shutting_down') {
    process.stderr.write('telegram bridge: gateway shutting down, exiting\n')
    cleanup()
    process.exit(0)
  }
}

// ─── Session tail ────────────────────────────────────────────────────────

const sessionTailEnabled = process.env.SWITCHROOM_SESSION_TAIL !== 'off'
let sessionTailHandle: SessionTailHandle | null = null

function forwardSessionEvent(ev: SessionEvent): void {
  if (!ipc || !ipc.isConnected()) return
  // Derive chatId from the event if available (enqueue carries it)
  let chatId = ''
  let threadId: number | undefined
  if (ev.kind === 'enqueue') {
    chatId = ev.chatId ?? ''
    threadId = ev.threadId != null ? Number(ev.threadId) : undefined
  }
  // Forward the tailer's already-attached file (its tracked
  // currentFile) so the gateway's proactive-compaction check reads
  // occupancy from the exact session JSONL the tailer is on, never an
  // independent findActiveSessionFile re-scan (which can transiently
  // resolve a sub-agent transcript or a stale rotated file).
  const activeFile = sessionTailHandle?.getActiveFile() ?? null
  ipc.sendSessionEvent({
    type: 'session_event',
    event: ev as unknown as Record<string, unknown>,
    chatId,
    ...(threadId != null ? { threadId } : {}),
    ...(activeFile ? { activeFile } : {}),
  })
}

if (sessionTailEnabled) {
  try {
    const sessionCwd = process.env.CLAUDE_CONFIG_DIR
      ? dirname(process.env.CLAUDE_CONFIG_DIR)
      : process.cwd()
    sessionTailHandle = startSessionTail({
      cwd: sessionCwd,
      log: (msg) => process.stderr.write(`telegram bridge: ${msg}\n`),
      onEvent: forwardSessionEvent,
      onOperatorEvent: (ev) => {
        // Phase 4c: forward Anthropic API errors to the gateway so it can
        // post the operator card + record into the /status history. The
        // gateway resolves the destination chat from its access allowlist
        // (operator events are agent-level, not tied to a specific user
        // message), so chatId is left empty here.
        if (!ipc || !ipc.isConnected()) return
        try {
          ipc.sendOperatorEvent({
            type: 'operator_event',
            kind: ev.kind,
            agent: AGENT_NAME,
            // Preserve the Anthropic request_id through the 1000-char cap: it
            // sits in the trailing byte-blob (often past char 1000), and it is
            // the reliable EXACT key for the cross-surface dedup gate. A naive
            // slice would drop it → the gate degrades to the coarse per-kind key
            // and wrongly collapses two distinct same-kind errors within 60s.
            detail: truncateDetailPreservingRequestId(ev.detail, 1000),
            chatId: '',
          })
        } catch (err) {
          process.stderr.write(
            `telegram bridge: sendOperatorEvent failed kind=${ev.kind}: ${(err as Error).message}\n`,
          )
        }
      },
    })
    process.stderr.write(
      `telegram bridge: session tail watching ${sessionTailHandle.getActiveFile() ?? '(no active file yet)'}\n`,
    )
  } catch (err) {
    process.stderr.write(`telegram bridge: session tail failed to start: ${(err as Error).message}\n`)
  }
}

// ─── PTY tail ────────────────────────────────────────────────────────────

const ptyTailEnabled = process.env.SWITCHROOM_PTY_TAIL !== 'off'
let ptyTailHandle: PtyTailHandle | null = null

if (ptyTailEnabled) {
  try {
    const agentDir = process.env.CLAUDE_CONFIG_DIR
      ? dirname(process.env.CLAUDE_CONFIG_DIR)
      : process.cwd()
    const serviceLogPath = process.env.SWITCHROOM_SERVICE_LOG_PATH
      ?? join(agentDir, 'service.log')
    ptyTailHandle = startPtyTail({
      logFile: serviceLogPath,
      log: (msg) => process.stderr.write(`telegram bridge: ${msg}\n`),
      onPartial: (text) => {
        // Forward to the gateway so it can drive a draft-stream edit.
        // Best-effort: ipc.sendPtyPartial silently no-ops when not
        // connected, mirroring how sendSessionEvent handles the gap.
        // Disable forwarding entirely with SWITCHROOM_PTY_TAIL=off
        // (handled by ptyTailEnabled above) — there's no per-side
        // toggle because the bridge doesn't know whether the gateway
        // wants the events. The gateway-side `onPtyPartial` handler
        // is also optional, so a downgraded gateway gets silent drops.
        ipc?.sendPtyPartial({ type: 'pty_partial', text })
      },
      activityExtractor: new V1ToolActivityExtractor(),
      onActivity: (_text) => {
        // Activity (the "Running Read…" tool-use lane) is currently
        // surfaced gateway-side via session_event tool_use → progress
        // card. No separate IPC forward needed for that lane.
      },
    })
    process.stderr.write(`telegram bridge: pty tail watching ${serviceLogPath}\n`)
  } catch (err) {
    process.stderr.write(`telegram bridge: pty tail failed to start: ${(err as Error).message}\n`)
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────

function cleanup(): void {
  sessionTailHandle?.stop()
  ptyTailHandle?.stop()
  ipc?.close()
}

// stdin EOF → MCP transport closed → Claude Code session ended
process.stdin.on('end', () => {
  process.stderr.write('telegram bridge: stdin EOF, shutting down\n')
  cleanup()
  setTimeout(() => process.exit(0), 500)
})

process.on('SIGTERM', () => {
  process.stderr.write('telegram bridge: SIGTERM received\n')
  cleanup()
  setTimeout(() => process.exit(0), 500)
})

process.on('SIGINT', () => {
  process.stderr.write('telegram bridge: SIGINT received\n')
  cleanup()
  setTimeout(() => process.exit(0), 500)
})

// #3033 — the bridge process must survive stray errors, and when it can't,
// it must leave a diagnosable trace. Claude Code NEVER respawns a dead MCP
// server: if this process exits, the reply tool vanishes from the session
// (`No such tool available`) and only a full container restart recovers the
// chat surface (2026-07-11 clerk incident — the gateway crashed, its
// supervisor brought it back in 1s, but the bridge had died in the same
// window and the agent was mute for 7 minutes until the operator bounced
// the container). Claude Code also drops MCP-server stderr after startup,
// so both handlers persist a breadcrumb to STATE_DIR/bridge-crash.log.
const CRASH_LOG_PATH = join(STATE_DIR, 'bridge-crash.log')

process.on('unhandledRejection', (err) => {
  process.stderr.write(`telegram bridge: unhandled rejection: ${err}\n`)
  appendCrashBreadcrumb(CRASH_LOG_PATH, 'unhandledRejection', err)
})

process.on('uncaughtException', (err) => {
  // Log-and-continue, mirroring the unhandledRejection posture. Risky in
  // general, but the alternative is strictly worse here: process death is
  // unrecoverable by design (see above), while the IPC client's reconnect
  // loop can heal any gateway-connection damage on its own.
  process.stderr.write(`telegram bridge: uncaught exception (continuing): ${(err as Error)?.stack ?? err}\n`)
  appendCrashBreadcrumb(CRASH_LOG_PATH, 'uncaughtException', err)
})

async function main(): Promise<void> {
  // Connect to the gateway IPC socket. The client has built-in reconnect
  // logic, so even if the gateway isn't up yet, the handle is returned and
  // will keep retrying in the background.
  ipc = await createIpcClient({
    socketPath: SOCKET_PATH,
    // Non-null asserted: the early process.exit at module top guards
    // this — TS can't narrow across the exit (returns `never` but the
    // compiler doesn't know).
    agentName: AGENT_NAME!,
    topicId: TOPIC_ID,
    onInbound,
    onPermission,
    onStatus,
    // #2861: re-send outstanding permission requests on every (re)connect.
    onConnect: flushOutstandingPermissionRequests,
    log: (msg) => process.stderr.write(`telegram bridge: ipc: ${msg}\n`),
    // #2307 Tier-1: the cron-session bridge shares the agent's STATE_DIR
    // (access.json / history / gateway.sock) but writes its liveness file to a
    // DISTINCT path (SWITCHROOM_BRIDGE_ALIVE_PATH, set in the cron .mcp.json) so
    // a live <agent>-cron bridge can't mask a dead MAIN bridge in the
    // dashboard/doctor liveness probe (RISK #2). Unset ⟹ the main bridge's
    // canonical STATE_DIR/.bridge-alive, exactly as before.
    livenessFilePath: process.env.SWITCHROOM_BRIDGE_ALIVE_PATH ?? join(STATE_DIR, ".bridge-alive"),
  })
  if (ipc.isConnected()) {
    process.stderr.write(`telegram bridge: connected to gateway at ${SOCKET_PATH}\n`)
  } else {
    process.stderr.write(
      `telegram bridge: gateway not available at ${SOCKET_PATH}, will retry in background\n`,
    )
  }

  // Start MCP transport (blocks until stdin EOF)
  await mcp.connect(new StdioServerTransport())
}

// Top-level await so that `import('./bridge/bridge.js')` in server.ts
// does NOT resolve until the MCP transport closes (stdin EOF). Without
// this, the server.ts dual-mode shim would `process.exit(0)` immediately
// after the import resolves, killing the bridge before it starts serving.
await main().catch((err) => {
  process.stderr.write(`telegram bridge: fatal: ${err}\n`)
  cleanup()
  process.exit(1)
})
