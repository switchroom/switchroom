/**
 * Telegram progress-update guidance appended to sub-agent prompts (#32).
 *
 * When the parent agent runs in a Telegram-rooted session, sub-agents
 * spawned via the Claude Code Agent tool are separate processes. Their
 * tool calls and intermediate output don't flow back into the parent's
 * progress card, so from the Telegram user's perspective a long-running
 * sub-agent looks like a black box: "spawning worker" → silence → final
 * result.
 *
 * Cheapest fix (issue #32 option 1): tell the sub-agent it can post its
 * own progress via the `mcp__switchroom-telegram__progress_update` tool
 * to the chat the parent is serving. The user's primary chat (DM) is
 * baked in as a default; sub-agents can also infer the live chat from
 * the parent's recent messages if they're handling forum topics.
 */

/**
 * Returns true when the agent is wired up with a Telegram channel and
 * we have at least one chat to address. Anything else (no telegram, no
 * chats) means the addendum is meaningless and should be omitted.
 */
export function shouldAppendTelegramProgressGuidance(args: {
  telegramEnabled: boolean
  defaultChatId: string | undefined
}): boolean {
  return args.telegramEnabled && args.defaultChatId != null && args.defaultChatId.length > 0
}

/**
 * Markdown block to append to a sub-agent's prompt body when the parent
 * runs in a Telegram-rooted session.
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
 * Combine an existing sub-agent prompt body with the Telegram progress
 * guidance when applicable. Pure: returns the body unchanged when
 * telegram isn't configured.
 */
export function applyTelegramProgressGuidance(
  body: string,
  args: { telegramEnabled: boolean; defaultChatId: string | undefined },
): string {
  if (!shouldAppendTelegramProgressGuidance(args)) return body
  const trimmed = body.replace(/\s+$/, '')
  return trimmed + buildTelegramProgressGuidance({ defaultChatId: args.defaultChatId! })
}
