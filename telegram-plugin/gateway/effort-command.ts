/**
 * Telegram `/effort` command — show or switch the Claude reasoning effort
 * for this agent's live session. The effort sibling of `/model`.
 *
 * `/effort` (bare) renders the effort menu: the configured default plus an
 * inline keyboard of the five levels the CLI offers
 * (`low · medium · high · xhigh · max`, faster→smarter), the live level
 * marked ✅. A tap types claude's own `/effort <level>` into the agent's
 * tmux pane via the allowlisted inject primitive (`/effort` is on the
 * inject allowlist) — the Claude-native mechanism: the unmodified CLI's
 * REPL command, no API, no SDK, no config mutation.
 *
 * `/effort <level>` does the same non-interactively.
 *
 * The switch is session-scoped. It lasts until the agent restarts, because
 * `start.sh` always relaunches claude with `--effort <thinking_effort>`
 * (the cascade-resolved default, "low" out of the box) which re-pins the
 * session effort on boot. Persisting a new default is a `thinking_effort:`
 * change in switchroom.yaml + restart, which the reply spells out.
 *
 * Split parser/handler shape mirrors `model-command.ts` so the logic is
 * unit-testable without booting the bot.
 */

import type { InjectResult } from '../../src/agents/inject.js'

/**
 * The effort levels the installed CLI accepts (`claude --help`:
 * "--effort <level> … (low, medium, high, xhigh, max)"). Fixed and
 * ordered faster→smarter. Unlike model ids these don't churn, so they're
 * listed here rather than discovered live — a new level needs a one-line
 * edit, surfaced by the regression test.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Strict allowlist gate — the arg is typed verbatim into the agent pane. */
export function isValidEffortArg(arg: string): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(arg.toLowerCase())
}

export type ParsedEffortCommand =
  | { kind: 'show' }
  | { kind: 'set'; level: EffortLevel }
  | { kind: 'help'; reason?: string }

/**
 * Parse an `/effort` message. Returns null when the text isn't an /effort
 * command at all (caller bug — bot.command should pre-filter).
 */
export function parseEffortCommand(text: string): ParsedEffortCommand | null {
  const m = text.match(/^\/effort(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (rest.length === 0) return { kind: 'show' }
  const parts = rest.split(/\s+/)
  if (parts.length > 1) {
    return { kind: 'help', reason: 'effort takes a single level' }
  }
  const arg = parts[0]
  if (arg.toLowerCase() === 'help') return { kind: 'help' }
  if (!isValidEffortArg(arg)) {
    return { kind: 'help', reason: `not a valid effort level: ${arg}` }
  }
  return { kind: 'set', level: arg.toLowerCase() as EffortLevel }
}

export interface EffortCommandDeps {
  /** Inject primitive — wired to injectSlashCommand in the gateway. */
  inject: (agent: string, command: string) => Promise<InjectResult>
  getAgentName: () => string
  /**
   * The agent's cascade-resolved `thinking_effort` from
   * `switchroom agent list` (the value start.sh bakes into `--effort`).
   * Null when unreadable — rendered as the built-in default.
   */
  getConfiguredEffort: () => string | null
  escapeHtml: (s: string) => string
  preBlock: (s: string) => string
}

export interface EffortCommandReply {
  text: string
  html: true
}

const PERSIST_NOTE =
  '<i>Session-only — reverts to the configured default on restart. To change the default, set <code>thinking_effort:</code> in switchroom.yaml and restart.</i>'

const LEVELS_INLINE = EFFORT_LEVELS.map(l => `<code>${l}</code>`).join(' · ')

function helpText(deps: EffortCommandDeps, reason?: string): EffortCommandReply {
  const lines: string[] = []
  if (reason) lines.push(`⚠️ ${deps.escapeHtml(reason)}`)
  lines.push(
    '<b>/effort</b> — show or switch the reasoning effort (faster→smarter)',
    '<code>/effort</code> — show the configured effort + a tap menu',
    `<code>/effort &lt;level&gt;</code> — switch the live session (${LEVELS_INLINE})`,
    PERSIST_NOTE,
  )
  return { text: lines.join('\n'), html: true }
}

export async function handleEffortCommand(
  parsed: ParsedEffortCommand,
  deps: EffortCommandDeps,
): Promise<EffortCommandReply> {
  if (parsed.kind === 'help') return helpText(deps, parsed.reason)

  if (parsed.kind === 'show') {
    const configured = deps.getConfiguredEffort()
    const shown = configured && configured.length > 0 ? configured : 'low'
    return {
      text: [
        `<b>Effort — ${deps.escapeHtml(deps.getAgentName())}</b>`,
        `Configured default: <code>${deps.escapeHtml(shown)}</code>`,
        `Switch the live session: ${EFFORT_LEVELS.map(l => `<code>/effort ${l}</code>`).join(' · ')}`,
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  // kind === 'set' — re-gate at the seam so a caller that skipped the
  // parser can't type arbitrary keys into the pane.
  if (!isValidEffortArg(parsed.level)) {
    return helpText(deps, `not a valid effort level: ${parsed.level}`)
  }
  const verbHtml = `<code>/effort ${deps.escapeHtml(parsed.level)}</code>`
  let result: InjectResult
  try {
    result = await deps.inject(deps.getAgentName(), `/effort ${parsed.level}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `❌ ${verbHtml} — inject failed: ${deps.escapeHtml(msg)}`, html: true }
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
        `${verbHtml} — sent, but no response captured. The agent may be mid-turn; check <code>/inject /status</code> to confirm the active effort.`,
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
// Button menu — five fixed levels, the live one marked ✅. No live discovery
// (the levels don't churn) and no picker-driving (the inline `/effort <level>`
// form sets it directly), so this is far simpler than the /model menu.
// ---------------------------------------------------------------------------

export interface EffortMenuKeyboardButton {
  text: string
  callback_data: string
}

export interface EffortMenuReply {
  text: string
  html: true
  keyboard?: EffortMenuKeyboardButton[][]
}

export const EFFORT_CALLBACK_PREFIX = 'eff:'
const EFFORT_CALLBACK_SELECT = 'eff:s:'

export function effortSelectCallbackData(level: string): string {
  return `${EFFORT_CALLBACK_SELECT}${level}`
}

function menuKeyboard(highlight: string): EffortMenuKeyboardButton[][] {
  // Five short labels fit one row (Telegram allows up to 8/row). ✅ marks
  // the level we believe is live.
  return [
    EFFORT_LEVELS.map(l => ({
      text: l === highlight ? `✅ ${l}` : l,
      callback_data: effortSelectCallbackData(l),
    })),
  ]
}

/**
 * Build the `/effort` menu: configured default + a tap row of the five
 * levels. `highlight` marks the level shown as live (defaults to the
 * configured value; the callback path passes the just-selected level).
 */
export function buildEffortMenu(deps: EffortCommandDeps, highlight?: string): EffortMenuReply {
  const configured = deps.getConfiguredEffort() || 'low'
  const live = highlight ?? configured
  return {
    text: [
      `<b>Effort — ${deps.escapeHtml(deps.getAgentName())}</b>`,
      `Default: <code>${deps.escapeHtml(configured)}</code> · faster → smarter: ${LEVELS_INLINE}`,
      'Tap to switch the live session:',
      PERSIST_NOTE,
    ].join('\n'),
    html: true,
    keyboard: menuKeyboard(live),
  }
}

export interface EffortCallbackOutcome {
  reply: EffortMenuReply
  /** The level applied to the live session, if any (gateway records it). */
  selectedEffort?: string
}

/**
 * Handle an `eff:*` callback tap. `eff:s:<level>` injects claude's
 * `/effort <level>` and re-renders the menu with a one-line banner and the
 * new level checked. Never throws — failures render as a banner.
 */
export async function handleEffortMenuCallback(
  data: string,
  deps: EffortCommandDeps,
): Promise<EffortCallbackOutcome> {
  if (!data.startsWith(EFFORT_CALLBACK_SELECT)) {
    return { reply: buildEffortMenu(deps) }
  }
  const level = data.slice(EFFORT_CALLBACK_SELECT.length)
  if (!isValidEffortArg(level)) {
    return { reply: buildEffortMenu(deps) }
  }
  let banner: string
  let selected: string | undefined
  try {
    const result = await deps.inject(deps.getAgentName(), `/effort ${level}`)
    if (result.outcome === 'ok' || result.outcome === 'ok_no_output') {
      banner = `✅ Effort → <code>${deps.escapeHtml(level)}</code> for this session`
      selected = level
    } else if (result.errorCode === 'session_missing') {
      banner = '❌ tmux session not found — is the agent running under the supervisor?'
    } else {
      banner = `❌ couldn't set effort: ${deps.escapeHtml(result.errorMessage ?? 'inject failed')}`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    banner = `❌ inject failed: ${deps.escapeHtml(msg)}`
  }
  // Re-render with the just-selected level checked (or the configured
  // default if the inject failed) and the banner on top.
  const menu = buildEffortMenu(deps, selected)
  return {
    reply: { ...menu, text: `${banner}\n${menu.text}` },
    selectedEffort: selected,
  }
}
