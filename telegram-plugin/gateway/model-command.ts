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
 * that appear in real model ids (`.` `_` `-` `/` and the `[1m]`-style
 * variant brackets). `/` is allowed for OpenRouter-style
 * `sr-vendor/model` ids; it is not a shell metachar inside the
 * double-quoted `claude --model "$_EFFECTIVE_MODEL"` usage, so it can't
 * break the launch. No whitespace means no second token can ride
 * along; no control characters means no newline/Enter smuggling.
 */
const MODEL_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._/\[\]-]{0,99}$/

export function isValidModelArg(arg: string): boolean {
  return MODEL_ARG_RE.test(arg)
}

/** True when `name` is an sr-* (LiteLLM/OpenRouter) model identifier. */
export function isSrModel(name: string): boolean {
  return name.startsWith('sr-')
}

/**
 * True when `name` is a Claude model — either a well-known alias or a
 * full `claude-*` id (including `[1m]` variants). This is intentionally
 * broader than MODEL_ALIASES: any `claude-…` string from claude's own
 * picker (e.g. `claude-opus-4-8`) qualifies.
 */
export function isClaudeModel(name: string): boolean {
  const lower = name.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lower)) return true
  return lower.startsWith('claude-')
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

/**
 * The busy state a typed `/model` disposition is decided against. Two
 * independent signals are folded here (#3177): `currentTurnActive` is the
 * gateway's per-turn atom (`currentTurn !== null`), which is NULLED at
 * `turn_end`; `turnInFlight` is the authoritative delivery-machine +
 * pending-approval gate (`turnInFlightForGate()`). The atom can read idle
 * while the session is still busy (the "recovered-late" / premature-turn-end
 * window seen in finn's 2026-07-12 log), so a switch decided on the atom ALONE
 * takes the direct-inject path and types `/model <name>` into a still-busy
 * pane, where claude swallows it as literal text — a silent no-op. Folding
 * BOTH signals means a session busy by EITHER measure ack+queues instead.
 */
export interface ModelCommandContext {
  /** Gateway per-turn atom is non-null (`currentTurn !== null`). */
  currentTurnActive: boolean
  /** Authoritative busy gate (`turnInFlightForGate()`): machine-in-turn OR a pending approval. */
  turnInFlight: boolean
  /** Interactive picker menu is enabled (`SWITCHROOM_MODEL_MENU !== '0'`). */
  menuEnabled: boolean
}

/**
 * True when the session is busy by EITHER busy signal. A typed `/model` set
 * MUST NOT take the direct-inject path while this holds — it would type into a
 * busy pane and be swallowed as text. See ModelCommandContext.
 */
export function isModelCommandBusy(ctx: Pick<ModelCommandContext, 'currentTurnActive' | 'turnInFlight'>): boolean {
  return ctx.currentTurnActive || ctx.turnInFlight
}

/**
 * What the gateway should do with a parsed `/model` command. Pure so the
 * routing decision is unit-testable without booting the bot. Every parsed
 * shape maps to exactly one visible action — there is NO branch that silently
 * does nothing (the #3177 swallow):
 *
 *  - `menu`  — bare `/model` with the picker enabled → render the dashboard.
 *  - `queue` — a `set` while busy (by EITHER signal) → ack + enqueue for
 *              apply-on-idle. `target` is the alias-expanded token.
 *  - `apply` — run the handler now (idle `set`, or `show`/`help` text paths).
 */
export type ModelCommandDisposition =
  | { kind: 'menu' }
  | { kind: 'queue'; target: string }
  | { kind: 'apply'; parsed: ParsedModelCommand }

export function planModelCommand(
  parsed: ParsedModelCommand,
  ctx: ModelCommandContext,
): ModelCommandDisposition {
  if (parsed.kind === 'show' && ctx.menuEnabled) return { kind: 'menu' }
  if (parsed.kind === 'set' && isModelCommandBusy(ctx)) {
    return { kind: 'queue', target: expandSrAlias(parsed.model) }
  }
  return { kind: 'apply', parsed }
}

/**
 * The unconditional durable log line the gateway writes at `/model` entry,
 * BEFORE any branch or reply attempt (#3177 guarantee (b)). Even if every
 * downstream reply is shed/dropped, this line — plus the paired history row —
 * guarantees a typed `/model` is never invisible. Kept pure + shape-stable so
 * the format is testable and greppable (`grep 'gw /model received'`).
 */
export function modelCommandReceiptLine(
  agent: string,
  parsed: ParsedModelCommand,
  busy: boolean,
): string {
  const arg =
    parsed.kind === 'set' ? parsed.model
      : parsed.kind === 'show' ? '(show)'
        : '(help)'
  return `telegram gateway: gw /model received agent=${agent} kind=${parsed.kind} arg=${arg} busy=${busy}`
}

export interface ModelCommandDeps {
  /** Inject primitive — wired to injectSlashCommand in the gateway. */
  inject: (agent: string, command: string) => Promise<InjectResult>
  /**
   * True while the agent is mid-turn. A typed `/model <name>` switch drives
   * claude's session (either an inject into the input box, or a carrier-backed
   * restart) — doing either mid-turn is unsafe: an inject queues `/model` as
   * user text instead of switching, and a restart would tear down the live
   * turn. So the set path refuses when this is true and asks the operator to
   * retry, exactly like the menu callback path (`ModelMenuDeps.isBusy`).
   */
  isBusy: () => boolean
  getAgentName: () => string
  /**
   * The agent's configured model from `switchroom agent list` (the
   * cascade-resolved `model:` field). Null when unset / unreadable —
   * rendered as "default".
   */
  getConfiguredModel: () => string | null
  escapeHtml: (s: string) => string
  preBlock: (s: string) => string
  /**
   * The active session-model override set by a prior `/model` switch.
   * Null when no session override is active (using configured/default model).
   * Used to detect whether the current session is on an sr-* (OpenRouter)
   * model so a switch back to Claude can trigger a graceful restart instead
   * of an in-place inject (which would leave stale sr-* routing in place).
   */
  getActiveSessionModel: () => string | null
  /**
   * Schedule a graceful restart of this agent. Called instead of inject
   * when switching from an sr-* model back to Claude — the restart clears
   * the sr-* session context cleanly, whereas an in-place inject would
   * leave LiteLLM routing active. The gateway wires this to the same
   * mechanism as the `/restart` command (hostd-first, SIGTERM fallback).
   */
  scheduleRestart: (reason: string) => Promise<void>
  /**
   * Schedule a session-only switch TO a non-Claude (`sr-*` LiteLLM/OpenRouter)
   * model. claude's in-REPL `/model` picker rejects unknown `sr-*` ids, so an
   * inject can't set them. Instead the gateway writes the chosen token to the
   * durable `.session-model` override and gracefully restarts the agent;
   * the next boot launches `claude --model <token>` directly (LiteLLM routes
   * it, no picker validation). Session-only: reverts to the configured default
   * on the following restart. Wired to the same restart dispatch as
   * `scheduleRestart`, plus the carrier write. `model` is the full `sr-*` id
   * (already alias-expanded); `reason` is stamped as the restart reason.
   */
  scheduleModelRelaunch: (model: string, reason: string) => Promise<void>
}

export interface ModelCommandReply {
  text: string
  html: true
  /**
   * On a POSITIVELY-CONFIRMED typed switch, the model now running this session
   * (parsed from claude's confirmation, falling back to the requested token).
   * The gateway records this as the session-model override so `/status` reflects
   * what's actually running — the SAME code path the menu callback uses via
   * `ModelCallbackOutcome.selectedModel`. Absent on every unverified / non-switch
   * outcome (silent capture, error, busy refusal) so an unconfirmed switch never
   * lies to `/status`.
   */
  selectedModel?: string
}

const PERSIST_NOTE =
  '_Session-only — this override lasts until the agent’s next restart, then reverts to the configured \`model:\`. \`/model default\` clears it now. To change the default permanently, set \`model:\` in switchroom.yaml._'

function helpText(deps: ModelCommandDeps, reason?: string): ModelCommandReply {
  const srAliasExamples = Object.keys(SR_MODEL_ALIASES).map(a => `\`${a}\``).join(' · ')
  const lines: string[] = []
  if (reason) lines.push(`⚠️ ${deps.escapeHtml(reason)}`)
  lines.push(
    '**/model** — show or switch the Claude model',
    '\`/model\` — show the configured model',
    `\`/model <name>\` — switch the live session (${MODEL_ALIASES.map(a => `\`${a}\``).join(' · ')} or a full model id)`,
    `_OpenRouter shortcuts:_ ${srAliasExamples}`,
    '_OpenRouter (sr-\\*) switches restart the session (~30s); Claude switches apply instantly._',
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
    const srAliasExamples = Object.keys(SR_MODEL_ALIASES).map(a => `\`/model ${a}\``).join(' · ')
    return {
      text: [
        `**Model — ${deps.escapeHtml(deps.getAgentName())}**`,
        `Configured: \`${deps.escapeHtml(shown)}\``,
        `Switch the live session: ${MODEL_ALIASES.map(a => `\`/model ${a}\``).join(' · ')}`,
        `OpenRouter shortcuts: ${srAliasExamples}`,
        'or \`/model <full-model-id>\`',
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

  // Expand short aliases: `flash` → `sr-gemini-2.5-flash`, `codex` → `sr-codex-5.5`, etc.
  const model = expandSrAlias(parsed.model)

  // Busy gate: a typed switch either injects into claude's input box or triggers
  // a carrier-backed restart. Both are unsafe mid-turn — an inject queues the
  // `/model` text instead of switching, and a restart kills the live turn. Refuse
  // and ask the operator to retry (parity with the menu callback's isBusy check).
  if (deps.isBusy()) {
    return {
      text: '⏳ The agent is mid-turn — a model switch needs an idle session. The switch was not applied.',
      html: true,
    }
  }

  // sr-* → Claude: an in-place `/model` inject would leave LiteLLM routing
  // active in the live session because the sr-* model context was set by
  // the proxy at session start, not by claude's own REPL. A graceful restart
  // is the only clean path back to the native OAuth route. Route it through the
  // SAME carrier mechanism as a Claude → sr-* switch (scheduleModelRelaunch)
  // so the requested Claude model is written to the durable `.session-model` and
  // survives the restart — otherwise boot launches the configured default and
  // the operator's choice is silently dropped. start.sh's LiteLLM-down guard
  // only special-cases `sr-*` overrides, so a Claude token is never dropped.
  const currentSession = deps.getActiveSessionModel()
  if (currentSession !== null && isSrModel(currentSession) && isClaudeModel(model)) {
    try {
      await deps.scheduleModelRelaunch(model, `user: /model ${model} (sr-to-claude restart)`)
    } catch (err) {
      if (isRestartInFlight(err)) {
        return {
          text: `⏳ A restart is already in flight — your switch to \`${deps.escapeHtml(model)}\` will apply as it completes (~15s).`,
          html: true,
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return {
        text: `❌ Could not schedule restart: ${deps.escapeHtml(msg)}`,
        html: true,
      }
    }
    return {
      text: [
        `Switching from \`${deps.escapeHtml(currentSession)}\` back to Claude — restarting session cleanly. Claude will be ready in ~30s.`,
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  // Claude → sr-*: an in-place inject can't set a non-Anthropic model — claude's
  // native `/model` picker rejects the unknown `sr-*` id ("Model not found").
  // Carry the token across a graceful restart and relaunch `claude --model
  // sr-*` directly (LiteLLM routes it). Session-only: reverts to the configured
  // default on the next restart. The sr-* → Claude direction is handled above.
  if (isSrModel(model)) {
    try {
      await deps.scheduleModelRelaunch(model, `user: /model ${model} (session-only relaunch)`)
    } catch (err) {
      if (isRestartInFlight(err)) {
        return {
          text: `⏳ A restart is already in flight — your switch to \`${deps.escapeHtml(model)}\` will apply as it completes (~15s).`,
          html: true,
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return {
        text: `❌ Could not schedule model switch: ${deps.escapeHtml(msg)}`,
        html: true,
      }
    }
    return {
      text: [
        `Switching to \`${deps.escapeHtml(model)}\` — restarting session (~30s).`,
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  const verbHtml = `\`/model ${deps.escapeHtml(model)}\``
  let result: InjectResult
  try {
    result = await deps.inject(deps.getAgentName(), `/model ${model}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      text: `❌ ${verbHtml} — inject failed: ${deps.escapeHtml(msg)}`,
      html: true,
    }
  }

  if (result.outcome === 'ok') {
    // claude's `/model <name>` either prints a "Set model to X" acknowledgement
    // or switches SILENTLY (no line). `result.output` on the silent path is just
    // whatever pane scrollback sat below the command echo (the agent's previous
    // prose answer) — NOT a confirmation. We MUST NOT claim success on that
    // scrollback, and we must never dump it back as a code block (screenshot-
    // confirmed leak on klanker, v0.16.47).
    //
    // Honest reporting: (1) if claude printed an error ("Model not found" /
    // "Invalid model"), the switch FAILED — say so. (2) if an anchored
    // confirmation line is present, the switch is verified — relay it and record
    // the live model for /status. (3) otherwise we cannot positively verify the
    // switch (silent success or nothing) — say "sent, but couldn't confirm" and
    // record NOTHING, so /status is never lied to.
    const errLine = modelSwitchErrorLine(result.output)
    if (errLine) {
      return {
        text: [
          `❌ ${verbHtml} — the switch did not take:`,
          deps.preBlock(errLine),
          'Check \`/model\` for valid model names.',
        ].join('\n'),
        html: true,
      }
    }
    const confirmation = modelSwitchConfirmationLine(result.output)
    if (confirmation) {
      const confirmed = sessionModelFromConfirmation(confirmation) ?? model
      return {
        text: [
          `${verbHtml}`,
          deps.preBlock(confirmation),
          ...(result.truncated ? ['_truncated_'] : []),
          PERSIST_NOTE,
        ].join('\n'),
        html: true,
        // Only record when the confirmation carries a real switch (Set/Switched);
        // a "Kept model as" line means no change — don't overwrite the override.
        ...(isKeptModelConfirmation(confirmation) ? {} : { selectedModel: confirmed }),
      }
    }
    return {
      text: [
        `${verbHtml} — sent, but couldn't confirm the switch — check \`/status\`.`,
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  if (result.outcome === 'ok_no_output') {
    return {
      text: [
        `${verbHtml} — sent, but no response captured. The agent may be mid-turn; check \`/inject /status\` to confirm the active model.`,
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  // outcome === 'failed'
  if (result.errorCode === 'session_missing') {
    return {
      text:
        '❌ tmux session not found — the agent must be running under the tmux supervisor (the default). Remove \`experimental.legacy_pty: true\` if set.',
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
  /**
   * Fetch sr-* model names available via LiteLLM for this agent.
   * Returns [] when LiteLLM is not configured or the probe fails.
   */
  discoverSrModels: () => Promise<string[]>
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
 * Callback prefix for Claude aliases that the CLI picker doesn't render but
 * the CLI resolves natively (e.g. `fable`). Carries the alias verbatim; its
 * handler INJECTS `/model <alias>` — the same mechanism MODEL_CALLBACK_SR
 * uses — because the cursor-nav select path can only pick rows claude's own
 * picker actually renders.
 */
export const MODEL_CALLBACK_ALIAS = 'mdl:alias:'
/** Callback: open the nested "External models" keyboard page. */
export const MODEL_CALLBACK_PAGE_EXTERNAL = 'mdl:page:ext'
/** Callback: return from the External page to the main keyboard page. */
export const MODEL_CALLBACK_PAGE_MAIN = 'mdl:page:main'

/** Which keyboard page the model menu is currently rendering. */
export type ModelMenuPage = 'main' | 'external'

/**
 * Static Claude aliases appended to the scraped Claude group. The claude CLI's
 * own `/model` picker (deps.discover) does NOT list `fable`, but the CLI
 * resolves the alias natively, so we render it as an extra button that selects
 * by injecting `/model fable` (MODEL_CALLBACK_ALIAS). Extend this list to
 * surface further CLI-resolvable aliases the picker omits.
 */
export const EXTRA_CLAUDE_ALIASES: ReadonlyArray<{ alias: string; label: string }> = [
  { alias: 'fable', label: 'Fable' },
]

/**
 * Friendly display names for sr-* synthetic model names. An sr-* model in
 * LiteLLM has no entry in `model_group_settings.*.forward_client_headers_to_llm_api`
 * so the Anthropic OAuth credential is NEVER forwarded — safe to route to
 * OpenRouter. Names here are display-only (used by srFriendlyLabel for /status
 * and switch confirmations); the raw `sr-*` id is what gets injected into the
 * agent's session. This table is a SUPERSET of the menu-reachable set
 * (SR_MODEL_ALIASES): it also labels models that are only reachable by typing
 * the full `/model sr-<name>` (manual passthrough), so those still get a
 * friendly name without appearing as a keyboard button.
 * See reference/rfcs/litellm-max-subscription-invariants.md § I6.
 */
export const SR_MODEL_LABELS: Record<string, string> = {
  'sr-gemini-2.5-pro': 'Gemini 2.5 Pro',
  'sr-gemini-2.5-flash': 'Gemini 2.5 Flash',
  'sr-deepseek-r1': 'DeepSeek R1',
  'sr-deepseek-v3': 'DeepSeek V3',
  // sr-glm-5 now targets glm-5.2 in the live litellm config — label bumped to match.
  'sr-glm-5': 'GLM-5.2',
  'sr-codex-5.5': 'Codex 5.5',
  // OpenRouter coverage (pairs with the live litellm sr-* model_name additions).
  'sr-gpt-oss-20b': 'GPT-OSS 20B',
  'sr-gpt-oss-120b': 'GPT-OSS 120B',
  'sr-gpt-5.5': 'GPT-5.5',
  'sr-gpt-5-codex': 'GPT-5 Codex',
  'sr-gpt-5.2-codex': 'GPT-5.2 Codex',
  'sr-gemini-flash-lite': 'Gemini 3.1 Flash Lite',
  'sr-minimax-m3': 'MiniMax M3',
  'sr-deepseek-v4-flash': 'DeepSeek V4 Flash',
}

/**
 * Short text-command aliases for sr-* models. These let the operator type
 * `/model flash`, `/model codex`, etc. instead of the full `sr-*` id.
 * Expanded in handleModelCommand before injection; the full sr-* id is what
 * reaches the agent session and LiteLLM.
 */
export const SR_MODEL_ALIASES: Record<string, string> = {
  flash: 'sr-gemini-2.5-flash',
  gemini: 'sr-gemini-2.5-pro',
  deepseek: 'sr-deepseek-v3',
  r1: 'sr-deepseek-r1',
  glm: 'sr-glm-5',
  codex: 'sr-codex-5.5',
}

/** Expand a short alias (case-insensitive) to its full sr-* id, or return the original. */
/**
 * #3042 review blocker 2a: can `token` be trusted for a boot-applied
 * `.session-model` carrier persist WITHOUT a live confirmation from claude?
 *
 * A queued typed `/model <arg>` that is persisted at shutdown was never
 * validated by claude's picker. Under the consume-once carrier (rev 4) a
 * garbage-but-shape-valid token (e.g. `claude-nonexistnet-9`) can crash at
 * most ONE boot before the carrier is gone and the agent reverts — but we
 * still avoid even that crash-boot. Only tokens with a switchroom-known
 * meaning are offline-trustable: the static Claude aliases (claude resolves
 * them itself) and the curated sr-* alias TARGETS (present in the LiteLLM
 * config by construction). Full `claude-*` / arbitrary `sr-*` ids typed by
 * hand are refused — they need the live session to verify, so the operator is
 * asked to re-issue after boot.
 */
export function isOfflineTrustedModelToken(token: string): boolean {
  // #3043 item 1: the live accept path normalizes case (isClaudeModel /
  // expandSrAlias lowercase before matching), so a queued `/model OPUS` is
  // accepted live — but this persist-time gate compared case-sensitively and
  // then refused it with the over-conservative "couldn't verify" card. Lowercase
  // once so the persist decision matches what the live path already accepted.
  const lower = token.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lower)) return true
  if (lower in SR_MODEL_ALIASES) return true
  return Object.values(SR_MODEL_ALIASES).includes(lower)
}

export function expandSrAlias(arg: string): string {
  return SR_MODEL_ALIASES[arg.toLowerCase()] ?? arg
}

export function srFriendlyLabel(srName: string): string {
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

const BUSY_REFUSAL_TEXT =
  '⏳ The agent is mid-turn — the model picker needs an idle prompt. Your tap was not applied.'

/**
 * Busy-refusal detector (#3039). The gateway's queued-command drain applies a
 * command believing the session is idle; if a new turn started in the race
 * window the underlying handler still refuses with one of these texts. The
 * drain matches on this and RE-ENQUEUES the command instead of stamping the
 * refusal onto the ack card as a false final state — so no user-visible path
 * ever ends at "try again".
 */
export function isBusyRefusalText(text: string): boolean {
  return text.includes('The agent is mid-turn')
}

/**
 * Mid-turn `/model` menu (#3039): instead of refusing ("try again in a
 * moment"), render a STATIC keyboard that needs no picker discovery — the
 * alias rows + the external page. Every switch tap rides the gateway's
 * mid-turn queue (ack → apply at idle → confirm), so opening the menu during
 * a long turn still lets the operator lock in a choice.
 */
function busyStaticMenu(
  deps: Pick<ModelMenuDeps, 'escapeHtml'> & Pick<ModelCommandDeps, 'getAgentName'>,
  page: ModelMenuPage,
): ModelMenuReply {
  const externalNames = externalModelNames([])
  if (page === 'external') {
    return {
      text: [
        `**Model — ${deps.escapeHtml(deps.getAgentName())}** · 🌐 External`,
        '_Agent is mid-turn — taps are queued and apply the moment the turn ends._',
        'These models are **billed separately** via OpenRouter. Tap one to switch the **live session**:',
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
      keyboard: externalPageKeyboard(externalNames),
    }
  }
  const rows: ModelMenuKeyboardButton[][] = []
  for (const alias of MODEL_ALIASES) {
    if (alias === 'default') continue
    rows.push([{
      text: alias.charAt(0).toUpperCase() + alias.slice(1),
      callback_data: `${MODEL_CALLBACK_ALIAS}${alias}`,
    }])
  }
  rows.push([{ text: 'Default (configured)', callback_data: `${MODEL_CALLBACK_ALIAS}default` }])
  if (externalNames.length > 0) {
    rows.push([{ text: '🌐 External models ▸', callback_data: MODEL_CALLBACK_PAGE_EXTERNAL }])
  }
  rows.push([{ text: '🔄 Refresh', callback_data: MODEL_CALLBACK_REFRESH }])
  return {
    text: [
      `**Model — ${deps.escapeHtml(deps.getAgentName())}**`,
      '_Agent is mid-turn, so the live picker can\u2019t be read right now — this is the quick list. A tap is queued and applies the moment the turn ends._',
      'Tap a model to switch the **live session**:',
      PERSIST_NOTE,
    ].join('\n'),
    html: true,
    keyboard: rows,
  }
}

function headerRow(label: string): ModelMenuKeyboardButton[] {
  return [{ text: label, callback_data: MODEL_CALLBACK_HEADER }]
}

/**
 * The external (🌐 non-Anthropic) model list, sourced from the static
 * SR_MODEL_ALIASES values UNION-ed with any live discoverSrModels() results,
 * deduped and sorted.
 *
 * Why the static union: discoverSrModels() reads LiteLLM's /model/info, which
 * requires ANTHROPIC_CUSTOM_HEADERS (a litellm key) to be set on the gateway
 * process. switchroom never sets that env on the gateway, so in production
 * discoverSrModels() always returns [] and the external group was silently
 * empty. The six SR_MODEL_ALIASES targets are the CURATED main sr-* set, so
 * seeding from them makes the group reliable without the missing env — while
 * still merging any live results on hosts that do configure discovery.
 *
 * Deliberately a SUBSET: the litellm config exposes more sr-* models than this
 * (the full OpenRouter catalogue). Those extras are display-labelled in
 * SR_MODEL_LABELS and remain typeable via `/model <full-sr-name>` (manual
 * passthrough — the set path is a shape gate, no whitelist), but they are kept
 * OUT of SR_MODEL_ALIASES on purpose so the keyboard stays small and curated.
 *
 * Subscription-honest: ONLY the curated sr-* aliases surface as buttons. Raw
 * gpt-4o / openrouter/* dupes / voyage-* embeddings never do.
 */
export function externalModelNames(discovered: string[]): string[] {
  const set = new Set<string>(Object.values(SR_MODEL_ALIASES))
  for (const n of discovered) {
    if (isSrModel(n)) set.add(n)
  }
  return [...set].sort()
}

/**
 * Main keyboard page: scraped Claude buttons + static Fable alias, then (only
 * when the external list is non-empty) a single "🌐 External models ▸" row that
 * opens the nested page, then Refresh.
 */
function mainPageKeyboard(
  claudeOptions: ModelPickerOption[],
  hasExternal: boolean,
): ModelMenuKeyboardButton[][] {
  const rows: ModelMenuKeyboardButton[][] = []

  for (const o of claudeOptions) {
    rows.push([{
      text: o.current ? `✅ ${o.label}` : o.label,
      callback_data: modelSelectCallbackData(o.label),
    }])
  }

  // Static Claude aliases the CLI picker omits (e.g. Fable). Deduped: if the
  // scraped Claude options already include a matching row, don't render the
  // static one too.
  for (const { alias, label } of EXTRA_CLAUDE_ALIASES) {
    const already = claudeOptions.some(
      (o) => o.label.toLowerCase() === label.toLowerCase() ||
        o.label.toLowerCase() === alias.toLowerCase(),
    )
    if (already) continue
    rows.push([{ text: label, callback_data: `${MODEL_CALLBACK_ALIAS}${alias}` }])
  }

  if (hasExternal) {
    rows.push([{ text: '🌐 External models ▸', callback_data: MODEL_CALLBACK_PAGE_EXTERNAL }])
  }

  rows.push([{ text: '🔄 Refresh', callback_data: MODEL_CALLBACK_REFRESH }])
  return rows
}

/**
 * External keyboard page: a labelled header, one 🌐 button per external model
 * (reusing the existing MODEL_CALLBACK_SR select handler), then Back + Refresh.
 */
function externalPageKeyboard(externalNames: string[]): ModelMenuKeyboardButton[][] {
  const rows: ModelMenuKeyboardButton[][] = []
  rows.push(headerRow('── External (billed separately) ──'))
  for (const name of externalNames) {
    rows.push([{
      text: `🌐 ${srFriendlyLabel(name)}`,
      callback_data: `${MODEL_CALLBACK_SR}${name}`,
    }])
  }
  rows.push([{ text: '◂ Back', callback_data: MODEL_CALLBACK_PAGE_MAIN }])
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
  page: ModelMenuPage = 'main',
): Promise<ModelMenuReply> {
  if (deps.isBusy()) return busyStaticMenu(deps, page)

  const [discovered, quota, srNames] = await Promise.all([
    deps.discover(deps.getAgentName()),
    deps.getQuotaBrief().catch(() => null),
    deps.discoverSrModels().catch(() => [] as string[]),
  ])

  if (!discovered.ok) {
    // Graceful static fallback — same content as the v1 show path,
    // with the discovery failure surfaced.
    const v1 = await handleModelCommand({ kind: 'show' }, deps)
    return {
      text: [`_(picker unavailable: ${deps.escapeHtml(discovered.reason)})_`, v1.text].join('\n'),
      html: true,
    }
  }

  // claude's ✔ marks the DEFAULT FOR NEW SESSIONS, which is a different axis
  // from the model the agent is running right now (set via --model at launch
  // or a prior session switch). Labelling the ✔ row "Now:" was misleading —
  // it could read "Opus 4.8" while the live session is on Fable. Call it what
  // it is, and tell the operator a switch applies to the live session.
  // sr-* models come from LiteLLM (/model/info via discoverSrModels), not the
  // claude picker — the CLI only knows Anthropic models.
  const { claude: claudeOptions } = classifyDiscoveredOptions(discovered.options)
  const externalNames = externalModelNames(srNames)

  // External page: a focused list of the 🌐 (billed-separately) models with a
  // Back button. It never switches the model itself — the page callbacks just
  // re-render with the other page's keyboard.
  if (page === 'external') {
    const lines: string[] = [`**Model — ${deps.escapeHtml(deps.getAgentName())}** · 🌐 External`]
    lines.push(
      '',
      'These models are **billed separately** via OpenRouter — they do NOT use your Claude Max/Pro subscription. Tap one to switch the **live session**:',
      PERSIST_NOTE,
    )
    return { text: lines.join('\n'), html: true, keyboard: externalPageKeyboard(externalNames) }
  }

  // claude's ✔ marks the DEFAULT FOR NEW SESSIONS, which is a different axis
  // from the model the agent is running right now (set via --model at launch
  // or a prior session switch). Labelling the ✔ row "Now:" was misleading —
  // it could read "Opus 4.8" while the live session is on Fable. Call it what
  // it is, and tell the operator a switch applies to the live session.
  const current = claudeOptions.find((o) => o.current)
  const lines: string[] = [`**Model — ${deps.escapeHtml(deps.getAgentName())}**`]
  if (discovered.dismissFailed) {
    lines.push('⚠️ _The picker may still be open on the agent pane — check it before switching._')
  }
  if (current) {
    const detail = current.detail ? ` · ${deps.escapeHtml(current.detail)}` : ''
    lines.push(`Default (new sessions): **${deps.escapeHtml(current.label)}**${detail}`)
  } else {
    lines.push('Default (new sessions): _unknown (no ✔ row in picker)_')
  }
  if (quota) lines.push(`Quota: ${deps.escapeHtml(quota)}`)
  lines.push('', 'Tap a model to switch the **live session**:')
  if (externalNames.length > 0) {
    lines.push('Claude models use your Max/Pro subscription. Tap 🌐 External models for models billed separately via OpenRouter.')
  }
  lines.push(PERSIST_NOTE)

  return {
    text: lines.join('\n'),
    html: true,
    keyboard: mainPageKeyboard(claudeOptions, externalNames.length > 0),
  }
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
   * True when this outcome is the mid-turn refusal (#3039). The queued-command
   * drain re-enqueues on this instead of stamping the refusal onto the ack
   * card as a false final state.
   */
  busyRefusal?: boolean
  /**
   * On a successful session switch, the live model name now running (parsed
   * from claude's confirmation, e.g. "Fable 5"). The gateway records this as
   * the session-model override so `/status` reflects what's actually running.
   * Absent on every non-switch outcome.
   */
  selectedModel?: string
  /**
   * The canonical `claude --model` token (alias or full `claude-*` id) for a
   * Claude selection, when derivable — distinct from `selectedModel` (a display
   * name for /status). The gateway persists this to the durable
   * `.session-model` override so the confirmed switch survives
   * switchroom-managed relaunches (and, on an sr-* → Claude transition, its own
   * restart). Absent when the target has no derivable token.
   */
  selectedModelToken?: string
  /**
   * True when the confirmed selection was the "Default (recommended)" row —
   * i.e. the session is now on the configured default and any sticky
   * `.session-model` override must be CLEARED (there is no token to persist;
   * persisting nothing while leaving a stale override would re-apply the old
   * model on the next keep-relaunch).
   */
  clearedDefault?: boolean
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

  // Page navigation — these DO NOT switch the model. They just re-render the
  // menu with the other page's keyboard + body text (mirrors the REFRESH shape).
  if (data === MODEL_CALLBACK_PAGE_EXTERNAL) {
    return { answer: 'External models', reply: await buildModelMenu(deps, 'external') }
  }
  if (data === MODEL_CALLBACK_PAGE_MAIN) {
    return { answer: 'Back', reply: await buildModelMenu(deps, 'main') }
  }

  // Claude-alias tap (e.g. Fable): the CLI resolves the alias but its picker
  // doesn't render it, so select by injecting `/model <alias>` — same path as
  // the sr-* handler below, no cursor-nav.
  if (data.startsWith(MODEL_CALLBACK_ALIAS)) {
    const alias = data.slice(MODEL_CALLBACK_ALIAS.length)
    if (!isValidModelArg(alias)) {
      return { answer: 'Invalid model name', reply: await buildModelMenu(deps) }
    }
    if (deps.isBusy()) {
      return {
        answer: '⏳ Agent is mid-turn — tap again when it’s idle',
        reply: { text: BUSY_REFUSAL_TEXT, html: true },
        toastOnly: true,
        busyRefusal: true,
      }
    }
    let aliasResult: InjectResult
    try {
      aliasResult = await deps.inject(deps.getAgentName(), `/model ${alias}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: 'Switch failed',
        reply: await menuWithBanner(deps, `❌ Switch to **${deps.escapeHtml(alias)}** failed: ${deps.escapeHtml(msg)}`),
      }
    }
    if (aliasResult.outcome === 'ok') {
      // Anchored confirmation only — a loose /set model|switched/ match false-
      // positives on ordinary scrollback prose ("I switched the deploy…").
      const confirmation =
        modelSwitchConfirmationLine(aliasResult.output) ?? `Switched to ${alias} (session)`
      // "Kept model as X" means no change — don't overwrite the override.
      const kept = isKeptModelConfirmation(confirmation)
      return {
        answer: confirmation,
        reply: await menuWithBannerStatic(deps, `✅ ${deps.escapeHtml(confirmation)}`),
        ...(kept ? {} : {
          selectedModel: sessionModelFromConfirmation(confirmation) ?? alias,
          selectedModelToken: alias,
        }),
      }
    }
    return {
      answer: 'Switch failed',
      reply: await menuWithBanner(
        deps,
        `❌ Switch to **${deps.escapeHtml(alias)}** failed — agent may be mid-turn`,
      ),
    }
  }

  if (data === MODEL_CALLBACK_HEADER) {
    // Section-header row — the gateway handles this with a direct answerCallbackQuery
    // before calling this function, so this branch is dead in practice. Guard
    // for callers that skip gateway.ts (tests, future refactors).
    return { answer: 'Tap a model in this section to switch', reply: { text: '', html: true }, toastOnly: true }
  }

  // sr-* model tap. In the live gateway this branch is DEAD — the gateway
  // intercepts `mdl:sr:` at its callback dispatcher (before calling this
  // function) and routes it straight to scheduleModelRelaunch (carrier + restart).
  // The old body here text-injected `/model sr-<name>`, which is doubly broken if
  // ever reached: claude's picker rejects unknown sr-* ids AND the ANTHROPIC_BASE_URL
  // is never repointed at the LiteLLM router, so the request 4xxs against Anthropic.
  // Delegate to the SAME carrier mechanism so a direct caller (tests, a future
  // refactor that drops the gateway intercept) still does the safe thing.
  if (data.startsWith(MODEL_CALLBACK_SR)) {
    const srName = data.slice(MODEL_CALLBACK_SR.length)
    const friendlyName = srFriendlyLabel(srName)
    if (!isValidModelArg(srName)) {
      return { answer: 'Invalid model name', reply: await buildModelMenu(deps) }
    }
    if (deps.isBusy()) {
      return {
        answer: '⏳ Agent is mid-turn — tap again when it’s idle',
        reply: { text: BUSY_REFUSAL_TEXT, html: true },
        toastOnly: true,
        busyRefusal: true,
      }
    }
    try {
      await deps.scheduleModelRelaunch(srName, `user: /model ${srName} (session-only relaunch, menu)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        answer: 'Switch failed',
        reply: await menuWithBannerStatic(deps, `❌ Switch to **${deps.escapeHtml(friendlyName)}** failed: ${deps.escapeHtml(msg)}`),
      }
    }
    return {
      answer: `Switching to ${friendlyName} — restarting (~30s)`,
      reply: await menuWithBannerStatic(
        deps,
        `🔄 Switching session to **${deps.escapeHtml(friendlyName)}** — restarting (~30s).\n${PERSIST_NOTE}`,
      ),
      selectedModel: srName,
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
      reply: { text: BUSY_REFUSAL_TEXT, html: true },
      toastOnly: true,
      busyRefusal: true,
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
        `❌ Switch to **${deps.escapeHtml(target.label)}** failed: ${deps.escapeHtml(result.reason)}`,
      ),
    }
  }

  // "Kept model as X" means the tapped model was ALREADY the session model —
  // nothing changed. Do NOT overwrite the override (and never store the display
  // label). Tapping the "Default (recommended)" row on the already-default model
  // previously stored "Default (recommended)" verbatim into /status.
  if (isKeptModelConfirmation(result.confirmation)) {
    return {
      answer: deps.escapeHtml(result.confirmation),
      reply: await menuWithBanner(deps, `✅ ${deps.escapeHtml(result.confirmation)}`),
    }
  }
  // Normalize what we store: prefer the model name claude confirmed, else a
  // canonical token derived from the row label — never a pure display label like
  // "Default (recommended)". If neither resolves, record nothing rather than lie.
  const token = canonicalClaudeToken(target.label)
  const selectedModel = sessionModelFromConfirmation(result.confirmation) ?? token ?? undefined
  // The "Default (recommended)" row has no derivable token BY DESIGN — a
  // confirmed switch to it means "back on the configured default", which the
  // gateway must translate into clearing the sticky override.
  const clearedDefault = token == null && /^default\b/i.test(target.label.trim())
  return {
    answer: deps.escapeHtml(result.confirmation),
    reply: await menuWithBanner(deps, `✅ ${deps.escapeHtml(result.confirmation)}`),
    ...(selectedModel ? { selectedModel } : {}),
    ...(token ? { selectedModelToken: token } : {}),
    ...(clearedDefault ? { clearedDefault: true } : {}),
  }
}

/**
 * True when the transition from `prevModel` to `nextModel` is a switch FROM
 * an sr-* (LiteLLM/OpenRouter) model BACK TO a native Claude model. This
 * signals that a session restart is required — an in-place model-picker select
 * cannot undo the LiteLLM routing that the sr-* switch established in the live
 * session. Null / undefined prev means no prior sr-* session — not a transition.
 */
export function isSrToClaudeTransition(
  prevModel: string | null | undefined,
  nextModel: string,
): boolean {
  return !!prevModel?.startsWith('sr-') && !nextModel.startsWith('sr-')
}

/**
 * Return the single line of a pane capture that actually reads as claude's
 * model-switch acknowledgement ("Set model to X…", "Switched to X", or
 * "Kept model as X"), or null when no such line is present. Used by the
 * direct `/model <name>` path to decide whether `result.output` carries a
 * genuine confirmation worth relaying, versus mere scrollback that must NOT
 * be echoed back to chat. Mirrors the line-scan already used by the picker
 * alias/sr-* callback paths.
 */
export function modelSwitchConfirmationLine(output: string): string | null {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => MODEL_SWITCH_CONFIRMATION_PREFIX.test(l))
  return line && line.length > 0 ? line : null
}

/**
 * claude's failure output for a bad `/model <name>` — the CLI rejects an
 * unknown id with "Model not found" / "Invalid model" / "Unknown model".
 * Detecting it lets the typed set path report an HONEST failure instead of
 * falsely claiming "switched (session)". Anchored to LINE START (behind the
 * same optional status glyph + optional "Error:" prefix as
 * MODEL_SWITCH_CONFIRMATION_PREFIX) so ordinary scrollback prose that merely
 * CONTAINS the phrase mid-sentence (e.g. "deploy failed: model not found in
 * registry") can never false-positive a successful switch into a reported
 * failure — the false-FAILURE variant of the scrollback-leak class.
 *
 * Empirically verified against claude v2.1.205 (disposable TUI probe,
 * 2026-07-10): `/model claude-bogus-99` prints
 * `⎿  Model 'claude-bogus-99' not found` — glyph prefix `⎿`, quoted model
 * name between "Model" and "not found". Both shapes are covered.
 */
const MODEL_SWITCH_ERROR_RE =
  /^\s*[⏺●•>⎿-]?\s*(?:Error:\s*)?(?:Model(?:\s+'[^']+')?\s+not found|Invalid model|Unknown model|No such model)\b/i

/** The single capture line that reads as a claude model-switch error, or null. */
export function modelSwitchErrorLine(output: string): string | null {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => MODEL_SWITCH_ERROR_RE.test(l))
  return line && line.length > 0 ? line : null
}

/**
 * True when a confirmation line is claude's "Kept model as X" — i.e. the model
 * was ALREADY the session model and nothing changed. The caller must NOT record
 * this as a session-override (there is nothing to override), and must not store
 * a display label in its place. See the menu-select bug where tapping the
 * "Default (recommended)" row on the already-default model stored the display
 * label verbatim into /status.
 */
export function isKeptModelConfirmation(confirmation: string): boolean {
  return /^\s*[⏺●•>⎿-]?\s*Kept model as\b/i.test(confirmation.trim())
}

/**
 * Normalize a picker ROW LABEL to a canonical `claude --model` token suitable
 * for the durable `.session-model` override (aliases and full `claude-*` ids —
 * NOT display strings like "Default (recommended)" or "Opus 4.8", which the CLI
 * flag rejects). Returns null when the label is a pure display label with no
 * derivable token: for the "Default" row that correctly means "boot the
 * configured default" (write no carrier).
 */
export function canonicalClaudeToken(label: string): string | null {
  const l = label.trim()
  if (l.toLowerCase().startsWith('claude-')) return l
  const first = l.toLowerCase().split(/\s+/)[0]
  if (first === 'default') return null
  if ((MODEL_ALIASES as readonly string[]).includes(first)) return first
  return null
}

/**
 * True when an error thrown by scheduleRestart / scheduleModelRelaunch signals
 * "a restart is already in flight" (the gateway's 15s debounce) rather than a
 * genuine dispatch failure. Carried as a `code` property so model-command.ts
 * need not import the gateway's error type.
 */
export function isRestartInFlight(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'restart_in_flight'
}

/**
 * claude's real model-switch confirmation always begins the line (optionally
 * behind a status glyph like `⏺` or `⎿` + whitespace) with one of these exact
 * phrasings. Anchoring to the line start keeps ordinary scrollback prose that
 * merely *contains* words like "switched" or "set model" (e.g. "I switched the
 * deploy to blue-green") from false-positiving as a confirmation worth
 * relaying. Shared by `modelSwitchConfirmationLine` (does this line qualify?)
 * and `sessionModelFromConfirmation` (pull the name out).
 *
 * Empirically verified against claude v2.1.205 (disposable TUI probe,
 * 2026-07-10): the arg form `/model opus` is NOT silent — it prints
 * `⎿  Set model to Opus 4.8 and saved as your default for new sessions`.
 * The `⎿` glyph survives the inject capture (isTuiChromeLine doesn't strip
 * it), so it must be in the glyph class or every typed switch would fall
 * through to the "couldn't confirm" branch and never record the override.
 */
const MODEL_SWITCH_CONFIRMATION_PREFIX =
  /^\s*[⏺●•>⎿-]?\s*(?:Set model to|Switched to|Kept model as)\b/i

/**
 * Pull the model NAME out of claude's session-switch confirmation so it can
 * be shown in `/status` as the live session model. claude phrases it as
 * "Set model to <name> for this session only" / "Switched to <name>" /
 * (v2.1.205 arg form) "Set model to <name> and saved as your default for new
 * sessions" — the "and saved" tail must terminate the name capture or the
 * whole sentence would be stored as the model. Returns null when the
 * confirmation doesn't carry a recognizable name (the caller falls back to
 * the tapped picker label).
 */
export function sessionModelFromConfirmation(confirmation: string): string | null {
  const m = /(?:Set model to|Switched to)\s+(.+?)(?:\s+for (?:this|the) session|\s+and saved\b|\s*\(|\s*$)/i.exec(
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

// Static variant — skips discover() entirely and uses the v1 text path.
// Use after a text-inject where the picker state is inherently uncertain:
// discover() reliably fails immediately post-inject, producing a spurious
// "(picker unavailable)" warning that reads as an error.
async function menuWithBannerStatic(
  deps: ModelMenuDeps & ModelCommandDeps,
  banner: string,
): Promise<ModelMenuReply> {
  const v1 = await handleModelCommand({ kind: 'show' }, deps)
  return {
    text: [banner, '', v1.text].join('\n'),
    html: true,
    // No keyboard — picker state is unknown after a text-inject; operator
    // can tap /model to get a fresh interactive menu.
  }
}
