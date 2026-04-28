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
