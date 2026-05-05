/**
 * #725 Phase 2 — Telegram /inject command handler.
 *
 * Lives in its own module so the unit tests can import it without
 * triggering gateway.ts's top-level `new Bot(TOKEN)` initialisation.
 * gateway.ts wires this into bot.command('inject', ...).
 */

import type { Context } from 'grammy'
import {
  InjectError,
  INJECT_ALLOWLIST,
  injectSlashCommand as defaultInject,
  type InjectResult,
} from '../../src/agents/inject.js'

export interface InjectDeps {
  isAuthorized: (ctx: Context) => boolean
  inject: (agent: string, command: string) => Promise<InjectResult>
  reply: (ctx: Context, text: string, opts?: { html?: boolean }) => Promise<void>
  getAgentName: () => string
  /** Pull the slash-command body out of the message (defaults to ctx.match-style logic). */
  getArgs: (ctx: Context) => string
  /** HTML-escape helper (matches gateway.ts's escapeHtmlForTg). */
  escapeHtml: (s: string) => string
  /** Format pre-block helper (matches gateway.ts's preBlock). */
  preBlock: (s: string) => string
  /** Optional formatter that trims/wraps the captured output. */
  formatOutput?: (s: string) => string
}

export async function handleInjectCommand(ctx: Context, deps: InjectDeps): Promise<void> {
  if (!deps.isAuthorized(ctx)) return
  const arg = deps.getArgs(ctx).trim()
  if (!arg) {
    const allow = [...INJECT_ALLOWLIST].sort().join(', ')
    await deps.reply(
      ctx,
      `Usage: <code>/inject &lt;slashCommand&gt;</code>\nAllowed: <code>${deps.escapeHtml(allow)}</code>`,
      { html: true },
    )
    return
  }
  const slashCommand = arg.startsWith('/') ? arg : `/${arg}`
  const agentName = deps.getAgentName()
  try {
    const { output, truncated } = await deps.inject(agentName, slashCommand)
    if (output.trim().length === 0) {
      await deps.reply(
        ctx,
        `<i>(no new output captured for ${deps.escapeHtml(slashCommand)})</i>`,
        { html: true },
      )
      return
    }
    const formatted = deps.formatOutput ? deps.formatOutput(output) : output
    const body = deps.preBlock(formatted)
    const suffix = truncated ? '\n<i>... (output truncated)</i>' : ''
    await deps.reply(ctx, body + suffix, { html: true })
  } catch (err) {
    if (err instanceof InjectError) {
      await deps.reply(
        ctx,
        `<b>inject failed</b> (<code>${deps.escapeHtml(err.code)}</code>): ${deps.escapeHtml(err.message)}`,
        { html: true },
      )
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    await deps.reply(ctx, `<b>inject failed:</b> ${deps.escapeHtml(msg)}`, { html: true })
  }
}

export { defaultInject }
