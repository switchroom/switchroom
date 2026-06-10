/**
 * Telegram `/model` command — show or switch the Claude model for this
 * agent's live session.
 *
 * `/model` (bare) renders the model dashboard: the live model, a brief
 * quota line, and an inline-keyboard menu of the options claude's own
 * `/model` picker offers (discovered live via `src/agents/model-picker.ts`
 * — opened, parsed, Esc'd; never hardcoded, so new models appear the
 * moment the installed CLI offers them). A button tap re-opens the
 * picker fresh, matches the row by label, and applies session-only.
 * When discovery fails (agent mid-turn, CLI UI changed, kill-switched
 * via SWITCHROOM_MODEL_MENU=0) it falls back to the static v1 text.
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
import {
  labelTag,
  type DiscoverResult,
  type SelectResult,
  type ModelPickerOption,
} from '../../src/agents/model-picker.js'

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

// ---------------------------------------------------------------------------
// Picker-driven model menu (v2) — discovery, render, callback selection.
// ---------------------------------------------------------------------------

export interface ModelMenuDeps {
  /** Live picker discovery — src/agents/model-picker.ts discoverModels. */
  discover: (agent: string) => Promise<DiscoverResult>
  /** Live picker selection by label — selectModel (session-only `s`). */
  select: (agent: string, label: string) => Promise<SelectResult>
  /**
   * True while the agent is mid-turn. Driving the picker types into
   * claude's input box; doing that mid-turn would queue "/model" as
   * user text instead of opening the modal — refuse instead.
   */
  isBusy: () => boolean
  getAgentName: () => string
  /** One-line quota summary (e.g. "29% / 5h · 33% / 7d") or null. */
  getQuotaBrief: () => Promise<string | null>
  escapeHtml: (s: string) => string
}

/** Raw Telegram inline-keyboard shape (grammY accepts it verbatim). */
export interface ModelMenuKeyboardButton {
  text: string
  callback_data: string
}

export interface ModelMenuReply {
  text: string
  html: true
  /** Rows of buttons; absent on the no-menu fallback. */
  keyboard?: ModelMenuKeyboardButton[][]
}

export const MODEL_CALLBACK_PREFIX = 'mdl:'
const MODEL_CALLBACK_SELECT = 'mdl:s:'
export const MODEL_CALLBACK_REFRESH = 'mdl:r'

export function modelSelectCallbackData(label: string): string {
  // Identity is the label's hash, not its index — a tap re-discovers
  // the picker and matches by tag, so a list that shifted between
  // render and tap can never select the wrong row. 8 hex chars keeps
  // callback_data tiny (well under Telegram's 64-byte cap).
  return `${MODEL_CALLBACK_SELECT}${labelTag(label)}`
}

function busyReply(deps: Pick<ModelMenuDeps, 'escapeHtml'>): ModelMenuReply {
  return {
    text: '⏳ The agent is mid-turn — the model picker needs an idle prompt. Try again in a moment.',
    html: true,
  }
}

function menuKeyboard(options: ModelPickerOption[]): ModelMenuKeyboardButton[][] {
  // One option per row (labels + ✔ render cleanly at full width on
  // mobile), refresh on a trailing row.
  const rows: ModelMenuKeyboardButton[][] = options.map((o) => [
    {
      text: o.current ? `✅ ${o.label}` : o.label,
      callback_data: modelSelectCallbackData(o.label),
    },
  ])
  rows.push([{ text: '🔄 Refresh', callback_data: MODEL_CALLBACK_REFRESH }])
  return rows
}

/**
 * Build the `/model` dashboard: live model + quota brief + tap menu.
 * Returns a keyboard-less fallback (v1-shaped static text) when the
 * picker can't be driven right now — the command never hard-fails.
 */
export async function buildModelMenu(
  deps: ModelMenuDeps & ModelCommandDeps,
): Promise<ModelMenuReply> {
  if (deps.isBusy()) return busyReply(deps)

  const [discovered, quota] = await Promise.all([
    deps.discover(deps.getAgentName()),
    deps.getQuotaBrief().catch(() => null),
  ])

  if (!discovered.ok) {
    // Graceful static fallback — same content as the v1 show path,
    // with the discovery failure surfaced.
    const v1 = await handleModelCommand({ kind: 'show' }, deps)
    return {
      text: [`<i>(picker unavailable: ${deps.escapeHtml(discovered.reason)})</i>`, v1.text].join('\n'),
      html: true,
    }
  }

  const current = discovered.options.find((o) => o.current)
  const lines: string[] = [`<b>Model — ${deps.escapeHtml(deps.getAgentName())}</b>`]
  if (discovered.dismissFailed) {
    lines.push('⚠️ <i>The picker may still be open on the agent pane — check it before switching.</i>')
  }
  if (current) {
    const detail = current.detail ? ` · ${deps.escapeHtml(current.detail)}` : ''
    lines.push(`Now: <b>${deps.escapeHtml(current.label)}</b>${detail}`)
  } else {
    lines.push('Now: <i>unknown (no ✔ row in picker)</i>')
  }
  if (quota) lines.push(`Quota: ${deps.escapeHtml(quota)}`)
  lines.push('', 'Tap to switch (applies to the live session):')
  lines.push(PERSIST_NOTE)

  return { text: lines.join('\n'), html: true, keyboard: menuKeyboard(discovered.options) }
}

export interface ModelCallbackOutcome {
  /** Short toast for answerCallbackQuery. */
  answer: string
  /** Replacement dashboard (message edit). */
  reply: ModelMenuReply
}

/**
 * Handle a `mdl:*` callback tap. `mdl:r` re-renders the dashboard;
 * `mdl:s:<tag>` re-discovers the picker, resolves the tag back to a
 * live label, and applies it session-only. A tag that no longer
 * matches (claude updated its options since render) re-renders the
 * menu instead of guessing.
 */
export async function handleModelMenuCallback(
  data: string,
  deps: ModelMenuDeps & ModelCommandDeps,
): Promise<ModelCallbackOutcome> {
  if (data === MODEL_CALLBACK_REFRESH) {
    return { answer: 'Refreshed', reply: await buildModelMenu(deps) }
  }
  if (!data.startsWith(MODEL_CALLBACK_SELECT)) {
    return { answer: 'Unknown action', reply: await buildModelMenu(deps) }
  }
  if (deps.isBusy()) {
    return { answer: 'Agent is mid-turn — try again shortly', reply: busyReply(deps) }
  }

  const tag = data.slice(MODEL_CALLBACK_SELECT.length)
  const discovered = await deps.discover(deps.getAgentName())
  if (!discovered.ok) {
    return {
      answer: 'Picker unavailable',
      reply: {
        text: `❌ Could not open the model picker: ${deps.escapeHtml(discovered.reason)}`,
        html: true,
      },
    }
  }
  const target = discovered.options.find((o) => labelTag(o.label) === tag)
  if (!target) {
    // Options changed since the menu rendered — never guess; re-render.
    const fresh = await buildModelMenu(deps)
    return { answer: 'Model list changed — menu refreshed', reply: fresh }
  }
  if (target.current) {
    const fresh = await buildModelMenu(deps)
    return { answer: `Already on ${target.label}`, reply: fresh }
  }

  const result = await deps.select(deps.getAgentName(), target.label)
  if (!result.ok) {
    return {
      answer: 'Switch failed',
      reply: {
        text: `❌ Switch to <b>${deps.escapeHtml(target.label)}</b> failed: ${deps.escapeHtml(result.reason)}`,
        html: true,
      },
    }
  }

  const fresh = await buildModelMenu(deps)
  const confirmed: ModelMenuReply = {
    text: [`✅ ${deps.escapeHtml(result.confirmation)}`, '', fresh.text].join('\n'),
    html: true,
    ...(fresh.keyboard ? { keyboard: fresh.keyboard } : {}),
  }
  return { answer: result.confirmation, reply: confirmed }
}
