/**
 * Telegram `/model` command — show or switch the Claude model for this
 * agent's live session.
 *
 * `/model` (bare) shows the configured model and the switch options.
 * It deliberately NEVER injects the bare `/model` verb into the claude
 * pane: with no argument the CLI renders an interactive picker modal
 * that nothing on the Telegram side can drive (no arrow keys, no Esc),
 * which would wedge the pane — the same TUI-modal class of wedge as
 * the /rate-limit-options incident. Only the argument form is ever
 * injected.
 *
 * `/model <alias|full-id>` types claude's own `/model <name>` into the
 * agent's tmux pane via the existing allowlisted inject primitive
 * (`src/agents/inject.ts` — `/model` is already on the allowlist) and
 * relays the captured response. This is the Claude-native mechanism:
 * the unmodified CLI's REPL command, no API, no SDK, no config
 * mutation. The switch is session-scoped — it lasts until the agent
 * restarts; persisting requires `model:` in switchroom.yaml (cascade)
 * and a restart, which the reply spells out.
 *
 * Split parser/handler shape mirrors `auth-command.ts` so the logic is
 * unit-testable without booting the bot.
 */

import type { InjectResult } from '../../src/agents/inject.js'

/**
 * Aliases the claude CLI resolves natively. Listed in help text only —
 * the handler does NOT restrict to these (a full model id like
 * `claude-opus-4-8` passes through and claude itself validates it, so
 * new aliases/models work without a switchroom release).
 */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'default'] as const

/**
 * Shape gate for the model argument. This string is typed literally
 * into the agent's tmux pane, so the gate is strict by construction:
 * one token, alphanumeric start, then alphanumerics plus the chars
 * that appear in real model ids (`.` `_` `-` and the `[1m]`-style
 * variant brackets). No whitespace means no second token can ride
 * along; no control characters means no newline/Enter smuggling.
 */
const MODEL_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,99}$/

export function isValidModelArg(arg: string): boolean {
  return MODEL_ARG_RE.test(arg)
}

export type ParsedModelCommand =
  | { kind: 'show' }
  | { kind: 'set'; model: string }
  | { kind: 'help'; reason?: string }

/**
 * Parse a `/model` message. Returns null when the text isn't a /model
 * command at all (caller bug — bot.command should pre-filter).
 */
export function parseModelCommand(text: string): ParsedModelCommand | null {
  const m = text.match(/^\/model(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (rest.length === 0) return { kind: 'show' }
  const parts = rest.split(/\s+/)
  if (parts.length > 1) {
    return { kind: 'help', reason: 'model takes a single argument' }
  }
  const arg = parts[0]
  if (arg.toLowerCase() === 'help') return { kind: 'help' }
  if (!isValidModelArg(arg)) {
    return { kind: 'help', reason: `not a valid model name: ${arg}` }
  }
  return { kind: 'set', model: arg }
}

export interface ModelCommandDeps {
  /** Inject primitive — wired to injectSlashCommand in the gateway. */
  inject: (agent: string, command: string) => Promise<InjectResult>
  getAgentName: () => string
  /**
   * The agent's configured model from `switchroom agent list` (the
   * cascade-resolved `model:` field). Null when unset / unreadable —
   * rendered as "default".
   */
  getConfiguredModel: () => string | null
  escapeHtml: (s: string) => string
  preBlock: (s: string) => string
}

export interface ModelCommandReply {
  text: string
  html: true
}

const PERSIST_NOTE =
  '<i>Session-only — lasts until restart. To persist, set <code>model:</code> in switchroom.yaml and restart.</i>'

function helpText(deps: ModelCommandDeps, reason?: string): ModelCommandReply {
  const lines: string[] = []
  if (reason) lines.push(`⚠️ ${deps.escapeHtml(reason)}`)
  lines.push(
    '<b>/model</b> — show or switch the Claude model',
    '<code>/model</code> — show the configured model',
    `<code>/model &lt;name&gt;</code> — switch the live session (${MODEL_ALIASES.map(a => `<code>${a}</code>`).join(' · ')} or a full model id)`,
    PERSIST_NOTE,
  )
  return { text: lines.join('\n'), html: true }
}

export async function handleModelCommand(
  parsed: ParsedModelCommand,
  deps: ModelCommandDeps,
): Promise<ModelCommandReply> {
  if (parsed.kind === 'help') return helpText(deps, parsed.reason)

  if (parsed.kind === 'show') {
    const configured = deps.getConfiguredModel()
    const shown = configured && configured.length > 0 ? configured : 'default'
    return {
      text: [
        `<b>Model — ${deps.escapeHtml(deps.getAgentName())}</b>`,
        `Configured: <code>${deps.escapeHtml(shown)}</code>`,
        `Switch the live session: ${MODEL_ALIASES.map(a => `<code>/model ${a}</code>`).join(' · ')}`,
        'or <code>/model &lt;full-model-id&gt;</code>',
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  // kind === 'set' — re-gate at the seam so a caller that skipped the
  // parser can't type arbitrary keys into the pane.
  if (!isValidModelArg(parsed.model)) {
    return helpText(deps, `not a valid model name: ${parsed.model}`)
  }
  const verbHtml = `<code>/model ${deps.escapeHtml(parsed.model)}</code>`
  let result: InjectResult
  try {
    result = await deps.inject(deps.getAgentName(), `/model ${parsed.model}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      text: `❌ ${verbHtml} — inject failed: ${deps.escapeHtml(msg)}`,
      html: true,
    }
  }

  if (result.outcome === 'ok') {
    return {
      text: [
        `${verbHtml}`,
        deps.preBlock(result.output),
        ...(result.truncated ? ['<i>truncated</i>'] : []),
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  if (result.outcome === 'ok_no_output') {
    return {
      text: [
        `${verbHtml} — sent, but no response captured. The agent may be mid-turn; check <code>/inject /status</code> to confirm the active model.`,
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  // outcome === 'failed'
  if (result.errorCode === 'session_missing') {
    return {
      text:
        '❌ tmux session not found — the agent must be running under the tmux supervisor (the default). Remove <code>experimental.legacy_pty: true</code> if set.',
      html: true,
    }
  }
  return {
    text: `❌ ${verbHtml} — ${deps.escapeHtml(result.errorMessage ?? 'inject failed')}`,
    html: true,
  }
}
