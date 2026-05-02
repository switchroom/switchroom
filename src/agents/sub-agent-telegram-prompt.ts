/**
 * Telegram progress-update guidance for sub-agent prompts.
 *
 * Originally introduced in #32; disabled in #256 because each
 * `progress_update` call posted a fresh Telegram message and parallel
 * sub-agents spammed the chat. Re-enabled in #305 Option A (PR #413):
 * the gateway now routes sub-agent `progress_update` calls onto the
 * parent's pinned progress card row body instead of sending separate
 * messages, so the spam concern is gone and the JTBD (user sees what
 * the sub-agent is doing) is restored without attention cost.
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
 * we have at least one chat to address. Used as the precondition for
 * appending Telegram progress guidance to a sub-agent prompt.
 */
export function shouldAppendTelegramProgressGuidance(args: {
  telegramEnabled: boolean
  defaultChatId: string | undefined
}): boolean {
  return args.telegramEnabled && args.defaultChatId != null && args.defaultChatId.length > 0
}

/**
 * Markdown block appended to a sub-agent's prompt body when the parent
 * runs on Telegram. The sub-agent's `progress_update` calls land on the
 * parent's pinned progress card (PR #413, issue #305 Option A) — they
 * do NOT send separate Telegram messages, so this is cheap and safe to
 * call at every meaningful inflection point.
 */
export function buildTelegramProgressGuidance(args: {
  defaultChatId: string
}): string {
  return `

## Progress visibility on the parent's pinned card

Your parent agent runs in a Telegram chat. The user reads on a phone, not in this terminal. Tool calls and intermediate output do not reach them — only what is posted to the parent's pinned progress card.

When you call \`mcp__switchroom-telegram__progress_update\` from inside this sub-agent, the gateway routes the text onto your row in the parent's pinned card (replace-on-write, capped at ~200 chars). It does NOT send a separate Telegram message, so call it freely at meaningful inflection points:

- **Start of work** — "Analyzing 12 files in /src/auth"
- **Blocker / pivot** — "First approach hit X, switching to Y"
- **Major chunk done** — "Tests green, opening PR"

One short line per call. Skip for trivial one-shot tasks. Don't narrate every tool call — the parent card already shows your tool ring buffer.

Pass \`chat_id\` = \`${args.defaultChatId}\` unless the parent is handling a different chat in this turn, in which case use whatever chat_id the parent saw on its inbound message.
`
}

/**
 * Append Telegram progress guidance to the sub-agent prompt body when
 * the parent runs in a Telegram-rooted session. Idempotent on the gate:
 * if `telegramEnabled` is false or no `defaultChatId` is known, the body
 * is returned unchanged.
 */
export function applyTelegramProgressGuidance(
  body: string,
  args: { telegramEnabled: boolean; defaultChatId: string | undefined },
): string {
  if (!shouldAppendTelegramProgressGuidance(args)) return body
  // shouldAppend guarantees defaultChatId is a non-empty string.
  return body + buildTelegramProgressGuidance({ defaultChatId: args.defaultChatId as string })
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
  jobSlug?: string
}): string {
  // The cron wrapper auto-resolves any issue whose source is `cron:<jobSlug>`
  // when this script exits 0. So if THIS task records an issue mid-run, it
  // must use that exact source string — otherwise the auto-resolve trailer
  // can't find it and the issue stays open forever even after a successful
  // re-run. The block below is appended only when jobSlug is known
  // (production scaffold/reconcile always supplies one).
  const issuesBlock = args.jobSlug
    ? `

## If you need to record a transient issue

If something half-broken happens during this run (e.g. an upstream API timed out, a vault key was missing, a non-fatal data gap), record it via:

\`\`\`
switchroom issues record --severity warn --source "cron:${args.jobSlug}" --code <stable-code> --summary "<one-line>"
\`\`\`

Use the EXACT \`--source "cron:${args.jobSlug}"\` shown above — the cron wrapper auto-resolves issues with that source on a clean run. Picking a different source means the issue persists across recoveries.
`
    : ""

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
${issuesBlock}`
}

/**
 * Combine an existing cron prompt body with the cron Telegram delivery
 * guidance. Pure: returns the body unchanged when chatId is absent.
 */
export function applyCronTelegramGuidance(
  body: string,
  args: { chatId: string | undefined; jobSlug?: string },
): string {
  if (!args.chatId) return body
  const trimmed = body.replace(/\s+$/, '')
  return trimmed + buildCronTelegramGuidance({ chatId: args.chatId, jobSlug: args.jobSlug })
}
