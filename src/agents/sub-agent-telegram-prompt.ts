/**
 * Telegram progress-update guidance for sub-agent prompts — DISABLED (#256).
 *
 * This module previously appended a "## Telegram visibility" block to every
 * sub-agent prompt when the parent agent ran in a Telegram-rooted session
 * (originally introduced in #32). That block instructed sub-agents to call
 * `mcp__switchroom-telegram__progress_update` so the user could see live
 * progress from parallel workers.
 *
 * Removed in #256 because:
 *  - The parent's progress card already provides equivalent visibility:
 *    sub-agent tool counts and descriptions render there automatically.
 *  - With parallel workers each posting "Got it…" and "Done with X…" the
 *    Telegram thread became noisy and ate the user's attention budget.
 *  - The JTBD (user sees worker activity) is preserved through the progress
 *    card; the spam is gone.
 *
 * The exported function signatures are kept intact so callers in scaffold.ts
 * continue to compile without changes.
 *
 * Cron guidance (issue #269): scheduled tasks run as isolated `claude -p`
 * invocations with no live session. They must deliver their Telegram message
 * via `mcp__switchroom-telegram__reply` (which applies markdown→HTML
 * conversion) and then emit `HEARTBEAT_OK` as their sole stdout line so the
 * cron script can confirm execution without forwarding model text to Telegram.
 * The `buildCronTelegramGuidance` / `applyCronTelegramGuidance` helpers below
 * are independent of the disabled progress-update guidance above and remain
 * active.
 */

/**
 * Returns true when the agent is wired up with a Telegram channel and
 * we have at least one chat to address.
 *
 * @deprecated The result of this function is no longer acted on —
 *   `applyTelegramProgressGuidance` always returns the body unchanged (#256).
 *   Kept for call-site compatibility.
 */
export function shouldAppendTelegramProgressGuidance(args: {
  telegramEnabled: boolean
  defaultChatId: string | undefined
}): boolean {
  return args.telegramEnabled && args.defaultChatId != null && args.defaultChatId.length > 0
}

/**
 * Markdown block that was previously appended to a sub-agent's prompt body.
 *
 * @deprecated No longer appended to any prompt (#256). Kept for call-site
 *   compatibility.
 */
export function buildTelegramProgressGuidance(args: {
  defaultChatId: string
}): string {
  return `

## Telegram visibility (parent runs on Telegram)

Your parent agent's user is reading this conversation on Telegram, NOT in this terminal. Your tool calls and intermediate output do not reach the user — they only see what gets posted via the parent's reply tool, or what *you* explicitly post.

When you do non-trivial work, post brief check-ins via \`mcp__switchroom-telegram__progress_update\` so the user knows you're alive:

- **Plan formed** — "Got it. Going to do X first, then Y."
- **Pivot or blocker** — "First approach didn't work because <reason>. Trying <alternative>."
- **Chunk finished** — "Done with X. Starting Y now."

One sentence each. Don't narrate every tool call. Skip updates for trivial one-shot tasks.

The default chat is **${args.defaultChatId}** (the parent agent's primary user). If the parent is handling a forum topic or a different chat in this turn, prefer that chat by passing the same \`chat_id\` (and \`message_thread_id\` if any) the parent is using — check the recent inbound message context.
`
}

/**
 * Returns the sub-agent prompt body unchanged.
 *
 * Previously appended Telegram progress guidance when the parent ran in a
 * Telegram-rooted session. Disabled in #256: visibility is already provided
 * by the parent's progress card, and the per-worker check-in messages were
 * producing noise that hurt the user's attention budget.
 *
 * The `args` parameter is accepted but ignored so call sites in scaffold.ts
 * continue to compile without modification.
 */
export function applyTelegramProgressGuidance(
  body: string,
  args: { telegramEnabled: boolean; defaultChatId: string | undefined },
): string {
  // Feature disabled (#256): always return body unchanged.
  return body
}

/**
 * Instruction block appended to cron task prompts (issue #269).
 *
 * Cron tasks are isolated `claude -p` invocations — no live session, no
 * PTY tail. They must deliver their Telegram message via the MCP reply tool
 * (which applies markdown→HTML conversion, smart chunking, and all the same
 * rendering logic as a live session) rather than relying on the cron script
 * to forward stdout via curl (which sends raw text with no conversion).
 *
 * After sending, the model MUST print `HEARTBEAT_OK` as its sole stdout line.
 * The cron script discards stdout, so this serves only as a structured
 * exit-status indicator for monitoring (e.g. a future watchdog that fails the
 * systemd service when the sentinel is absent).
 */
export function buildCronTelegramGuidance(args: {
  chatId: string
}): string {
  return `

## Delivery instructions (cron context)

This task runs as a one-shot \`claude -p\` invocation — there is no live Telegram session. Your stdout is discarded; the user will NOT see anything you print.

To deliver your response to the user, you MUST call:

\`\`\`
mcp__switchroom-telegram__reply(chat_id="${args.chatId}", text="<your message>")
\`\`\`

The \`reply\` tool handles markdown→HTML conversion, chunking, and all formatting automatically — write normal markdown and it will render correctly on the user's phone.

After calling \`reply\`, print \`HEARTBEAT_OK\` as your final stdout line and nothing else. This confirms successful execution to the cron watchdog.

If you have nothing useful to say (data is dull, all signals are nominal), print \`HEARTBEAT_OK\` without calling \`reply\` — a silent heartbeat is correct behaviour, not an error.
`
}

/**
 * Combine an existing cron prompt body with the cron Telegram delivery
 * guidance. Pure: returns the body unchanged when chatId is absent.
 */
export function applyCronTelegramGuidance(
  body: string,
  args: { chatId: string | undefined },
): string {
  if (!args.chatId) return body
  const trimmed = body.replace(/\s+$/, '')
  return trimmed + buildCronTelegramGuidance({ chatId: args.chatId })
}
