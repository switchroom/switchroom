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
 * Cron guidance (originally issue #269) was REMOVED in #1798 along with
 * the `claude -p` cron-fold-in retirement. The cron-specific helpers
 * (`buildCronTelegramGuidance` / `applyCronTelegramGuidance`) wrapped the
 * cron prompt with delivery instructions for the headless-claude path that
 * Phase 4 retired (cron now flows through `inject_inbound` into the live
 * session, which already knows how to deliver via the reply tool).
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

## Vault / credential access

If you cannot reach a service or API because a credential is missing or denied, **do not tell the parent to ask the operator manually**. Instead, return the exact vault key name you need (use the \`<service>/<key>\` convention, e.g. \`coolify/api-token\`) and the verbatim error. Your parent agent can call \`vault_request_access\` to get the grant — that is the correct recovery path, not an escalation to the operator.
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

// `buildCronTelegramGuidance` / `applyCronTelegramGuidance` were removed
// with the cron-fold-in retirement (#1798). They wrapped cron prompts
// with instructions for headless `claude -p` delivery — which is the
// retired pre-Phase-4 path. Post-fold-in, cron prompts flow through
// `inject_inbound` IPC into the live session, which already knows how
// to deliver via the reply tool. No per-prompt wrapping needed.
