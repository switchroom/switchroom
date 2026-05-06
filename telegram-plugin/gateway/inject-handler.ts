/**
 * #725 Phase 2 — Telegram /inject command handler.
 *
 * Lives in its own module so the unit tests can import it without
 * triggering gateway.ts's top-level `new Bot(TOKEN)` initialisation.
 * gateway.ts wires this into bot.command('inject', ...).
 *
 * UX upgrade: the underlying inject primitive now returns a tagged
 * `InjectResult` (outcome of `ok | ok_no_output | failed`). This
 * handler switches on that outcome and shapes a single Telegram
 * reply per the table in the epic spec — accent header from
 * stream-reply-handler's `buildAccentHeader` + a short body.
 */

import type { Context } from 'grammy'
import {
  INJECT_COMMANDS,
  injectSlashCommand as defaultInject,
  type InjectResult,
} from '../../src/agents/inject.js'
import { buildAccentHeader } from '../stream-reply-handler.js'

export type InjectAccent = 'done' | 'issue' | 'in-progress'

export interface InjectDeps {
  isAuthorized: (ctx: Context) => boolean
  inject: (agent: string, command: string) => Promise<InjectResult>
  /**
   * Send a reply. The optional `accent` lifts the status header into
   * the rendered HTML body via `buildAccentHeader`. The handler always
   * sends `html: true` so callers can prepend the accent header.
   */
  reply: (
    ctx: Context,
    text: string,
    opts?: { html?: boolean; accent?: InjectAccent },
  ) => Promise<void>
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

/**
 * Render the inject reply body. Accent header is prepended HERE so
 * tests can assert exact final text — `deps.reply` is treated as a
 * dumb sender. Returns { body, accent } for the caller to hand to
 * `deps.reply`.
 */
function shapeReply(
  result: InjectResult,
  slashCommand: string,
  deps: Pick<InjectDeps, 'escapeHtml' | 'preBlock' | 'formatOutput'>,
): { body: string; accent: InjectAccent } {
  const verbHtml = `<code>${deps.escapeHtml(result.command || slashCommand)}</code>`

  if (result.outcome === 'ok') {
    const formatted = deps.formatOutput ? deps.formatOutput(result.output) : result.output
    let body = `${verbHtml}\n${deps.preBlock(formatted)}`
    if (result.diagnostic === 'truncated_output' || result.truncated) {
      body += '\n<i>truncated</i>'
    }
    return { body, accent: 'done' }
  }

  if (result.outcome === 'ok_no_output') {
    const meta = result.meta
    if (meta?.silentNote) {
      return {
        body: `${verbHtml} — ${deps.escapeHtml(meta.silentNote)}`,
        accent: 'done',
      }
    }
    if (meta?.expectsOutput) {
      return {
        body: `${verbHtml} — empty capture; agent may be busy or pane scrolled`,
        accent: 'issue',
      }
    }
    // expectsOutput=false, no silentNote — bare ack.
    return { body: verbHtml, accent: 'done' }
  }

  // outcome === 'failed'
  const code = result.errorCode ?? 'tmux_failed'
  const msg = result.errorMessage ?? 'unknown error'
  if (code === 'blocked') {
    // errorMessage already mentions the reason; keep the body focused.
    return {
      body: `${verbHtml} — blocked: ${deps.escapeHtml(stripBlockedPrefix(msg))}`,
      accent: 'issue',
    }
  }
  if (code === 'not_allowed') {
    const allowed = [...INJECT_COMMANDS.keys()].sort().join(' ')
    return {
      body: `${verbHtml} — not allowed. Try: ${deps.escapeHtml(allowed)}`,
      accent: 'issue',
    }
  }
  if (code === 'session_missing') {
    return {
      body: 'tmux session not found — agent must be running under the tmux supervisor (the default). Remove <code>experimental.legacy_pty: true</code> if set.',
      accent: 'issue',
    }
  }
  if (code === 'invalid') {
    return {
      body: 'usage: <code>/inject /&lt;command&gt;</code>',
      accent: 'issue',
    }
  }
  // tmux_failed / timeout / other
  return {
    body: `tmux send-keys failed: ${deps.escapeHtml(msg)}`,
    accent: 'issue',
  }
}

/**
 * Strip the boilerplate "X is explicitly blocked from inject (" wrapper
 * from a blocked-error message so the surfaced reason is just the
 * parenthetical reason text. Defensive — falls through to the original
 * message when the shape doesn't match.
 */
function stripBlockedPrefix(msg: string): string {
  const m = /\(([^)]+)\)\.?$/.exec(msg)
  return m ? m[1] : msg
}

export async function handleInjectCommand(ctx: Context, deps: InjectDeps): Promise<void> {
  if (!deps.isAuthorized(ctx)) return
  const arg = deps.getArgs(ctx).trim()
  if (!arg) {
    const allow = [...INJECT_COMMANDS.keys()].sort().join(', ')
    await deps.reply(
      ctx,
      `Usage: <code>/inject &lt;slashCommand&gt;</code>\nAllowed: <code>${deps.escapeHtml(allow)}</code>`,
      { html: true },
    )
    return
  }
  const slashCommand = arg.startsWith('/') ? arg : `/${arg}`
  const agentName = deps.getAgentName()

  let result: InjectResult
  try {
    result = await deps.inject(agentName, slashCommand)
  } catch (err) {
    // The default runner throws InjectError on validation failures (so
    // CLI use that doesn't pre-validate still works). Surface as
    // outcome=failed for shaping. Anything non-InjectError is an
    // unexpected runtime — bubble a generic failure body.
    const anyErr = err as { code?: string; message?: string; name?: string }
    if (anyErr?.name === 'InjectError' && typeof anyErr.code === 'string') {
      result = {
        outcome: 'failed',
        output: '',
        truncated: false,
        command: slashCommand.split(/\s+/, 1)[0]?.toLowerCase() ?? '',
        meta: null,
        errorCode: anyErr.code as InjectResult['errorCode'],
        errorMessage: anyErr.message ?? 'inject failed',
      }
    } else {
      result = {
        outcome: 'failed',
        output: '',
        truncated: false,
        command: slashCommand.split(/\s+/, 1)[0]?.toLowerCase() ?? '',
        meta: null,
        errorCode: 'tmux_failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const { body, accent } = shapeReply(result, slashCommand, deps)
  // Prepend accent header into the body so callers downstream of
  // deps.reply (and tests) see a single, fully-rendered string.
  const finalText = buildAccentHeader(accent) + body
  await deps.reply(ctx, finalText, { html: true, accent })
}

export { defaultInject }
