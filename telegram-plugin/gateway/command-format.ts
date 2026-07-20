/**
 * Pure slash-command output formatting & keyboard helpers extracted from
 * `gateway.ts` (switchroom#3461, chips at #3460).
 *
 * Every function here is a straight MOVE from gateway.ts — bodies are
 * byte-identical, only `export` was added. None of them closed over any
 * IIFE-local mutable state in gateway.ts: their inputs are explicit
 * parameters plus imported constants/types (RICH_MESSAGE_MAX_CHARS,
 * grammy's InlineKeyboard/Context, AuthCodeOutcome, and the vault error
 * parser/renderer). That is what makes the extraction behavior-neutral
 * and the helpers independently unit-testable
 * (`tests/command-format.test.ts`).
 */

import { InlineKeyboard, type Context } from 'grammy'
import { RICH_MESSAGE_MAX_CHARS } from '../format.js'
import type { AuthCodeOutcome } from '../../src/auth/manager.js'
import { parseVaultCliError, renderVaultCliError } from '../secret-detect/vault-error.js'

// Default truncation budget for CLI output bound for Telegram. The rich-message
// wire cap is RICH_MESSAGE_MAX_CHARS (32768) post-#2669, not the legacy 4096
// plain-text limit. Mirrors shared/bot-runtime.ts formatSwitchroomOutput.
export function formatSwitchroomOutput(output: string, maxLen = RICH_MESSAGE_MAX_CHARS): string {
  const trimmed = output.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 20) + '\n... (truncated)'
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

// #2669: escape GFM-markdown specials in dynamic values interpolated into
// rich-message bodies (kept under the legacy name to avoid churn).
export function escapeHtmlForTg(text: string): string {
  return text.replace(/([\\`*_~=\[\]|])/g, '\\$1')
}

// Wrap CLI/command output in a fenced code block (content is literal there).
export function preBlock(text: string): string {
  return '```\n' + text.replace(/```/g, '`​``') + '\n```'
}

export function getCommandArgs(ctx: Context): string {
  const fromMatch = typeof ctx.match === 'string' ? ctx.match.trim() : ''
  if (fromMatch) return fromMatch
  const text = (ctx.msg as { text?: string } | undefined)?.text ?? (ctx.message as { text?: string } | undefined)?.text ?? ''
  const m = text.match(/^\/\S+\s+([\s\S]*)$/)
  return m ? m[1].trim() : ''
}

/**
 * True when a slash command's argument string carries a trailing `demo`
 * token — the per-command PII-mask modifier for screen recordings
 * (`/usage demo`, `/auth demo`, `/status demo`, `/whoami demo`). Matches
 * `demo` as the last whitespace-delimited token, case-insensitively, so
 * `/auth show demo` and `/usage demo` both flip the flag while a label
 * literally named `demo-foo` does not.
 */
export function hasDemoFlag(args: string): boolean {
  return /(?:^|\s)demo$/i.test(args.trim())
}

/** Validate that a string looks like a safe agent/resource name.
 *  Agent names should be alphanumeric with hyphens/underscores only.
 *  This prevents shell metacharacter injection even though both exec
 *  functions already handle quoting. Defense in depth. */
export function assertSafeAgentName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) && name !== 'all') {
    throw new Error(`invalid agent name: ${name}`)
  }
}

export function formatAuthOutputForTelegram(output: string): { text: string; url: string | null } {
  const trimmed = stripAnsi(output).trim()
  const url = trimmed.match(/https:\/\/\S+/)?.[0] ?? null
  const lines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (!url) return { text: preBlock(formatSwitchroomOutput(trimmed)), url: null }
  // Drop the `switchroom auth code ...` and `switchroom auth cancel ...`
  // CLI hints. In Telegram the user never types those — they just reply
  // with the code (intercepted by the pendingReauthFlows flow above) or
  // tap the inline button. Surfacing shell syntax is confusing noise on
  // a phone.
  const body = lines.filter(line => {
    if (line === url) return false
    if (line.startsWith('switchroom auth code')) return false
    if (line.startsWith('switchroom auth cancel')) return false
    if (line.startsWith("Use 'tmux attach")) return false
    if (line.startsWith('After Claude shows you a browser code')) return false
    if (line.startsWith('Then finish with:')) return false
    if (line.startsWith('Cancel with:')) return false
    return true
  })
  const rendered = body.map(line => {
    if (line.startsWith('Started Claude auth') || line.startsWith('Auth session already running')) return `**${escapeHtmlForTg(line)}**`
    if (line.startsWith('Open this URL')) return `_${escapeHtmlForTg(line)}_`
    return escapeHtmlForTg(line)
  })
  // Mobile-native post-script. Two paths depending on which Anthropic
  // account the user wants to authorize:
  //
  //   (a) Button: 🔐 Open Claude auth — opens in Telegram's in-app
  //       browser (WebView) on most mobile clients. WebView has its
  //       own cookie jar, separate from the user's main browser. Fine
  //       when the WebView is already signed into the intended Claude
  //       account; wrong when it's signed into a different one.
  //
  //   (b) Long-press the URL text at the bottom of this message — every
  //       mobile Telegram client exposes "Copy Link" / "Open in
  //       Browser" / "Open in Chrome" on long-press. That's the
  //       escape hatch when you need to land in your main browser
  //       where you control which account is signed in.
  //
  // Why not a copy_text button? We tried. Telegram's CopyTextButton.text
  // field caps at 256 chars and OAuth URLs run ~320–340 chars. Result
  // was BUTTON_COPY_TEXT_INVALID. The long-press-the-URL path achieves
  // the same outcome with no API constraint. See PR #30.
  rendered.push(
    '',
    '👇 Tap **🔐 Open Claude auth** below, then **reply with the browser code**.',
    '',
    '_Wrong Anthropic account getting authorized? Long-press the URL below and choose "Copy Link" or "Open in Browser" — lands in your main browser where the right account is signed in, bypassing Telegram\'s in-app browser cookies._',
    '',
    url,
  )
  return { text: rendered.join('\n'), url }
}

/**
 * Build the inline keyboard shown under an auth-flow response that has
 * an OAuth URL. Single button:
 *
 *   [🔐 Open Claude auth]   — `url` button. On mobile Telegram clients
 *                             this typically opens in the app's in-app
 *                             browser (WebView).
 *
 * We previously tried adding a `[📋 Copy URL]` button using Telegram's
 * Bot API 7.7 `copy_text` type but it capped at 256 chars for the
 * copyable text. OAuth URLs (~320–340 chars) exceed that and produce
 * `BUTTON_COPY_TEXT_INVALID`. Instead, the message body renders the
 * URL as a tappable link; users long-press the URL text to get native
 * "Copy Link" / "Open in Browser" actions, bypassing the WebView.
 *
 * Defense in depth: this function's output is validated against
 * Telegram's real field-length constraints in
 * `telegram-plugin/tests/auth-url-keyboard-constraints.test.ts` so
 * future changes that breach a limit fail loudly at CI time rather
 * than silently in production.
 */
export function buildAuthUrlKeyboard(authorizeUrl: string): InlineKeyboard {
  return new InlineKeyboard().url('🔐 Open Claude auth', authorizeUrl)
}

/**
 * Issue #44: inline keyboard offering a one-tap unlock-and-save flow for
 * a deferred secret. The two buttons fire `vd:` callback_data which the
 * dispatcher in `bot.on('callback_query:data')` routes to
 * `handleVaultDeferCallback`.
 *
 *   `vd:unlock:<deferKey>` → prompt for passphrase, then auto-write the
 *                            held secret. Replaces the legacy six-step
 *                            "/vault list → re-paste" flow.
 *   `vd:cancel:<deferKey>` → discard the deferred secret without saving.
 *
 * `deferKey` is `<chat_id>:<message_id>` (the same key as
 * `deferredSecrets.set()`). Telegram limits callback_data to 64 bytes;
 * the prefix + key fits well within that on any realistic chat id.
 */
export function buildDeferredSecretKeyboard(deferKey: string): InlineKeyboard {
  const unlockData = `vd:unlock:${deferKey}`
  const cancelData = `vd:cancel:${deferKey}`
  if (unlockData.length > 64 || cancelData.length > 64) {
    process.stderr.write(
      `telegram gateway: callback_data overflow — deferKey=${deferKey} unlockLen=${unlockData.length} cancelLen=${cancelData.length}\n`,
    )
    throw new Error(`callback_data overflow: deferKey too long (${deferKey.length} chars)`)
  }
  return new InlineKeyboard()
    .text('🔓 Unlock vault & save', unlockData)
    .text('🗑 Discard', cancelData)
}

/**
 * Render a vault-CLI failure as Telegram HTML. Routes recognised P0a
 * stderr markers (VAULT-SANDBOX-CONTEXT / VAULT-NEEDS-APPROVAL /
 * VAULT-BROKER-UNREACHABLE / VAULT-BROKER-DENIED) through the structured
 * renderer; falls back to a raw pre-block for anything else.
 */
export function renderVaultOpFailure(
  verbLabel: 'list' | 'get' | 'set' | 'delete',
  cliOutput: string,
  key: string | undefined,
): string {
  const parsed = parseVaultCliError(cliOutput)
  // Map the gateway-internal op label onto the renderer's verb. 'delete'
  // surfaces in the host hint as `switchroom vault remove <key>` (the
  // canonical CLI name); 'list' has no key.
  const verb = verbLabel === 'delete' ? 'remove' : verbLabel
  const rendered = renderVaultCliError(parsed, { verb, key })
  if (rendered.suppressRaw) return rendered.html
  return `**vault ${verbLabel} failed:**\n${preBlock(cliOutput)}`
}

export function statusIcon(status: string): string {
  if (status === 'active' || status === 'running') return '🟢'
  if (status === 'inactive' || status === 'stopped' || status === 'dead') return '🔴'
  if (status === 'failed') return '⚠️'
  return '⚪'
}

/**
 * Render an `AuthCodeOutcome` as a user-facing Telegram HTML string.
 * Returns null when the outcome is not present or is `success` (caller
 * can handle success via the existing text path).
 */
export function renderAuthCodeOutcome(outcome: AuthCodeOutcome | null | undefined): string | null {
  if (!outcome || outcome.kind === 'success') return null
  const tail = outcome.paneTailText
    ? `\n_${escapeHtmlForTg(outcome.paneTailText)}_`
    : ''
  switch (outcome.kind) {
    case 'invalid-code':
    case 'expired-code':
      return `Code rejected by Claude — tap **Restart flow** for a fresh URL.${tail}`
    case 'pane-not-ready':
      return `Auth pane not ready — tap **Retry**.`
    case 'timeout':
      return `Still waiting after 2 min — tap **Retry** or check \`switchroom auth list\`.${tail}`
  }
}

// Two-button scope picker shown to admin agents (when hostd is
// reachable) so the operator can run doctor for the WHOLE FLEET
// (host-side via hostd — has the docker socket) or just THIS agent
// (in-container, degraded). callback_data is tiny (`dr:fleet` /
// `dr:self`) — well within Telegram's 64-byte limit.
export function buildDoctorScopeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🩺 Whole fleet', 'dr:fleet')
    .text('🩺 This agent', 'dr:self')
}

// Shared report prettifier: ANSI-strip + status-glyph swap + pre block.
// Identical rendering for the in-container and the hostd fleet report.
export function formatDoctorReport(raw: string): string {
  const trimmed = stripAnsi(raw).trim()
  if (!trimmed) return 'doctor: no output'
  const pretty = trimmed
    .replace(/^( *)✓ /gm, '$1🟢 ')
    .replace(/^( *)✗ /gm, '$1🔴 ')
    .replace(/^( *)! /gm, '$1🟡 ')
  return preBlock(formatSwitchroomOutput(pretty))
}
