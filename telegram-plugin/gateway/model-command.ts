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
 * Aliases the claude CLI resolves natively (`claude --help`: "an alias for
 * the latest model (e.g. 'fable', 'opus', or 'sonnet')"). Listed in help
 * text only — the handler does NOT restrict to these (a full model id like
 * `claude-opus-4-8` passes through and claude itself validates it, so new
 * aliases/models work without a switchroom release).
 *
 * `fable` is the latest flagship (Fable 5) — kept selectable here on
 * purpose. NB the alias is NOT the full codename: `claude-fable-5` (a
 * pinned pre-launch id) was retired server-side and 4xx'd the whole fleet
 * on 2026-06-13, while the `fable` alias keeps resolving to the current
 * model. Aliases are the durable way to pick a model — see the model
 * regression tests.
 */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'default'] as const

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
/** Callback prefix for sr-* (LiteLLM non-Anthropic) model selection. */
export const MODEL_CALLBACK_SR = 'mdl:sr:'
/** Callback for section-header rows — shows an informational toast, no action. */
export const MODEL_CALLBACK_HEADER = 'mdl:h'

/**
 * Friendly display names for sr-* synthetic model names. An sr-* model in
 * LiteLLM has no entry in `model_group_settings.*.forward_client_headers_to_llm_api`
 * so the Anthropic OAuth credential is NEVER forwarded — safe to route to
 * OpenRouter. Names here are display-only; the raw `sr-*` id is what gets
 * injected into the agent's session. See reference/rfcs/litellm-max-subscription-invariants.md § I6.
 */
export const SR_MODEL_LABELS: Record<string, string> = {
  'sr-gemini-2.5-pro': 'Gemini 2.5 Pro',
  'sr-gemini-2.5-flash': 'Gemini 2.5 Flash',
  'sr-deepseek-r1': 'DeepSeek R1',
  'sr-deepseek-v3': 'DeepSeek V3',
  'sr-glm-5': 'GLM-5',
}

function srFriendlyLabel(srName: string): string {
  return SR_MODEL_LABELS[srName] ?? srName.replace(/^sr-/, '').replace(/-/g, ' ')
}

/**
 * Split picker-discovered options into native Claude options and sr-*
 * (LiteLLM non-Anthropic) options. Options with "/" in the label or
 * other non-native prefixes (e.g., "openrouter/...", "gpt-4") are
 * silently dropped — they're internal LiteLLM routing paths, not
 * user-facing switching targets.
 */
export function classifyDiscoveredOptions(options: ModelPickerOption[]): {
  claude: ModelPickerOption[]
  sr: ModelPickerOption[]
} {
  return {
    // Native Claude picker labels start with an uppercase letter (e.g.
    // "Default (recommended)", "Opus", "Sonnet") or with "claude-" for full
    // model IDs. This excludes sr-* names, internal routing paths
    // ("openrouter/..."), and non-Claude models exposed by GATEWAY_MODEL_DISCOVERY
    // ("gpt-4", "gpt-4o", "voyage-law-2", etc.) — those are LiteLLM internals
    // not meant as user-facing switching targets.
    claude: options.filter(
      (o) => !o.label.startsWith('sr-') && !o.label.includes('/') &&
        (/^[A-Z]/.test(o.label) || o.label.startsWith('claude-')),
    ),
    sr: options.filter((o) => o.label.startsWith('sr-')),
  }
}

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

function headerRow(label: string): ModelMenuKeyboardButton[] {
  return [{ text: label, callback_data: MODEL_CALLBACK_HEADER }]
}

function menuKeyboard(
  claudeOptions: ModelPickerOption[],
  srOptions: ModelPickerOption[],
): ModelMenuKeyboardButton[][] {
  const hasBothGroups = claudeOptions.length > 0 && srOptions.length > 0
  const rows: ModelMenuKeyboardButton[][] = []

  if (hasBothGroups) rows.push(headerRow('── Claude (Max / Pro subscription) ──'))
  for (const o of claudeOptions) {
    rows.push([{
      text: o.current ? `✅ ${o.label}` : o.label,
      callback_data: modelSelectCallbackData(o.label),
    }])
  }

  // sr-* models are non-Anthropic (routed via LiteLLM → OpenRouter).
  // Selection uses text-inject rather than cursor-nav — more reliable
  // when the picker has many models (GATEWAY_MODEL_DISCOVERY=1).
  if (srOptions.length > 0) {
    rows.push(headerRow('── OpenRouter / external ──'))
    for (const o of srOptions) {
      rows.push([{
        text: `🌐 ${srFriendlyLabel(o.label)}`,
        callback_data: `${MODEL_CALLBACK_SR}${o.label}`,
      }])
    }
  }

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

  // claude's ✔ marks the DEFAULT FOR NEW SESSIONS, which is a different axis
  // from the model the agent is running right now (set via --model at launch
  // or a prior session switch). Labelling the ✔ row "Now:" was misleading —
  // it could read "Opus 4.8" while the live session is on Fable. Call it what
  // it is, and tell the operator a switch applies to the live session.
  const { claude: claudeOptions, sr: srOptions } = classifyDiscoveredOptions(discovered.options)
  const current = claudeOptions.find((o) => o.current)
  const lines: string[] = [`<b>Model — ${deps.escapeHtml(deps.getAgentName())}</b>`]
  if (discovered.dismissFailed) {
    lines.push('⚠️ <i>The picker may still be open on the agent pane — check it before switching.</i>')
  }
  if (current) {
    const detail = current.detail ? ` · ${deps.escapeHtml(current.detail)}` : ''
    lines.push(`Default (new sessions): <b>${deps.escapeHtml(current.label)}</b>${detail}`)
  } else {
    lines.push('Default (new sessions): <i>unknown (no ✔ row in picker)</i>')
  }
  if (quota) lines.push(`Quota: ${deps.escapeHtml(quota)}`)
  lines.push('', 'Tap a model to switch the <b>live session</b>:')
  if (srOptions.length > 0) {
    lines.push('Claude models use your Max/Pro subscription. 🌐 models are billed separately via OpenRouter.')
  }
  lines.push(PERSIST_NOTE)

  return { text: lines.join('\n'), html: true, keyboard: menuKeyboard(claudeOptions, srOptions) }
}

export interface ModelCallbackOutcome {
  /**
   * When true, the caller should ONLY show the toast (`answer`) and leave
   * the existing menu message untouched — used for the mid-turn refusal so
   * the menu keeps its buttons and the operator can simply tap again when
   * the agent goes idle, instead of the menu collapsing to a button-less
   * "try again" line (which read as "nothing happened").
   */
  toastOnly?: boolean
  /**
   * On a successful session switch, the live model name now running (parsed
   * from claude's confirmation, e.g. "Fable 5"). The gateway records this as
   * the session-model override so `/status` reflects what's actually running.
   * Absent on every non-switch outcome.
   */
  selectedModel?: string
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

  if (data === MODEL_CALLBACK_HEADER) {
    // Section-header row — informational only, no action.
    return { answer: 'Tap a model in this section to switch', reply: await buildModelMenu(deps), toastOnly: true }
  }

  // sr-* model tap: text-inject `/model sr-<name>` rather than cursor-nav.
  // Text-inject is more reliable when the picker has many models; sr-* names
  // are safe (no entry in model_group_settings → no OAuth forwarding). See I6.
  if (data.startsWith(MODEL_CALLBACK_SR)) {
    const srName = data.slice(MODEL_CALLBACK_SR.length)
    if (!isValidModelArg(srName)) {
      return { answer: 'Invalid model name', reply: await buildModelMenu(deps) }
    }
    if (deps.isBusy()) {
      return {
        answer: '⏳ Agent is mid-turn — tap again when it’s idle',
        reply: busyReply(deps),
        toastOnly: true,
      }
    }
    let srResult: InjectResult
    try {
      srResult = await deps.inject(deps.getAgentName(), `/model ${srName}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: 'Switch failed',
        reply: await menuWithBanner(deps, `❌ Switch to <b>${deps.escapeHtml(srName)}</b> failed: ${deps.escapeHtml(msg)}`),
      }
    }
    if (srResult.outcome === 'ok') {
      const friendlyName = srFriendlyLabel(srName)
      const confirmation =
        srResult.output
          .split('\n')
          .map((l) => l.trim())
          .find((l) => /set model|switched/i.test(l)) ?? `Switched to ${friendlyName} (session)`
      return {
        answer: confirmation,
        reply: await menuWithBanner(deps, `✅ ${deps.escapeHtml(confirmation)}`),
        selectedModel: srName,
      }
    }
    return {
      answer: 'Switch failed',
      reply: await menuWithBanner(
        deps,
        `❌ Switch to <b>${deps.escapeHtml(srFriendlyLabel(srName))}</b> failed — agent may be mid-turn`,
      ),
    }
  }

  if (!data.startsWith(MODEL_CALLBACK_SELECT)) {
    return { answer: 'Unknown action', reply: await buildModelMenu(deps) }
  }
  // Mid-turn: refuse WITHOUT touching the message. Driving the picker types
  // into claude's input box, which mid-turn would queue "/model" as user
  // text. toastOnly keeps the menu (and its buttons) exactly as-is so the
  // operator just taps again when the agent is idle — no button-less
  // "try again" line that read as a dead menu.
  if (deps.isBusy()) {
    return {
      answer: '⏳ Agent is mid-turn — tap again when it’s idle',
      reply: busyReply(deps),
      toastOnly: true,
    }
  }

  const tag = data.slice(MODEL_CALLBACK_SELECT.length)
  const discovered = await deps.discover(deps.getAgentName())
  if (!discovered.ok) {
    // Keep the menu interactive: re-render (falls back to v1 text if even
    // the show path can't discover) with the failure as a banner.
    return {
      answer: 'Picker unavailable',
      reply: await menuWithBanner(
        deps,
        `❌ Could not open the model picker: ${deps.escapeHtml(discovered.reason)}`,
      ),
    }
  }
  const target = discovered.options.find((o) => labelTag(o.label) === tag)
  if (!target) {
    // Options changed since the menu rendered — never guess; re-render.
    const fresh = await buildModelMenu(deps)
    return { answer: 'Model list changed — menu refreshed', reply: fresh }
  }
  // NOTE: do NOT short-circuit when target.current is set. The picker's ✔
  // marks claude's DEFAULT FOR NEW SESSIONS, which is a DIFFERENT axis from
  // the model the live session is running (set by --model at launch). Tapping
  // the ✔ row to apply that model to the live session is a legitimate switch
  // — e.g. an agent launched on Fable tapping "Default (Opus)". Skipping it
  // here was the "tapped Default, nothing happened" bug. Always drive the
  // selection; claude harmlessly answers "Kept model as X" if it's already
  // the session model.
  const result = await deps.select(deps.getAgentName(), target.label)
  if (!result.ok) {
    // Switch failed but the agent is reachable — keep the menu so the
    // operator can retry, with the reason as a banner.
    return {
      answer: 'Switch failed — see the menu',
      reply: await menuWithBanner(
        deps,
        `❌ Switch to <b>${deps.escapeHtml(target.label)}</b> failed: ${deps.escapeHtml(result.reason)}`,
      ),
    }
  }

  return {
    answer: deps.escapeHtml(result.confirmation),
    reply: await menuWithBanner(deps, `✅ ${deps.escapeHtml(result.confirmation)}`),
    selectedModel: sessionModelFromConfirmation(result.confirmation) ?? target.label,
  }
}

/**
 * Pull the model NAME out of claude's session-switch confirmation so it can
 * be shown in `/status` as the live session model. claude phrases it as
 * "Set model to <name> for this session only" (or "Switched to <name>").
 * Returns null when the confirmation doesn't carry a recognizable name (the
 * caller falls back to the tapped picker label).
 */
export function sessionModelFromConfirmation(confirmation: string): string | null {
  const m = /(?:Set model to|Switched to)\s+(.+?)(?:\s+for (?:this|the) session|\s*\(|\s*$)/i.exec(
    confirmation.trim(),
  )
  const name = m?.[1]?.trim()
  return name && name.length > 0 ? name : null
}

/**
 * Re-render the live menu with a one-line banner on top. Used by every
 * post-tap outcome (success, already-default, failure) so the menu ALWAYS
 * keeps its buttons and the operator can act again — the consistent
 * "status line + interactive menu" shape the other dashboards use. Falls
 * back to the banner alone if the menu can't be rebuilt right now.
 */
async function menuWithBanner(
  deps: ModelMenuDeps & ModelCommandDeps,
  banner: string,
): Promise<ModelMenuReply> {
  const fresh = await buildModelMenu(deps)
  return {
    text: [banner, '', fresh.text].join('\n'),
    html: true,
    ...(fresh.keyboard ? { keyboard: fresh.keyboard } : {}),
  }
}
