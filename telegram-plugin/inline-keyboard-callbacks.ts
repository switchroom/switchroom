/**
 * Agent-emitted inline-keyboard callback routing (#271).
 *
 * Agents emit `inline_keyboard` buttons via the `reply` / `stream_reply`
 * MCP tools. URL buttons need no routing — Telegram opens them in the
 * user's browser. callback_data buttons are different: the user's tap
 * arrives as a `callback_query` update on the gateway's bot, and we
 * need to deliver it back to the agent as an inbound channel event.
 *
 * Wire format
 * ───────────
 * The gateway namespaces agent-emitted callback_data with an `agent:`
 * prefix BEFORE sending to Telegram. Two reasons:
 *
 *   1. The existing callback_query dispatcher in gateway.ts routes by
 *      data prefix (`auth:`, `op:`, `vd:`, `vg:`, `aq:`, `perm:`).
 *      Any unprefixed data falls through to "ack-and-ignore". Agents
 *      could otherwise collide with infrastructure prefixes — `auth:`
 *      from an agent would silently invoke the auth dashboard handler.
 *
 *   2. Round-tripping. On callback_query receipt the gateway sees the
 *      `agent:` prefix, strips it, and forwards the raw data the agent
 *      originally supplied. Agent code only ever sees its own opaque
 *      payload — no leaky abstraction.
 *
 * Effective payload budget: 64 bytes (Telegram limit) − 6 bytes
 * (`agent:` prefix) = 58 bytes for agent-supplied data. This is
 * documented in the MCP tool schema.
 */

import {
  validateInlineKeyboard,
  TELEGRAM_BUTTON_LIMITS,
  type AnyButton,
  type ButtonValidationError,
} from './telegram-button-constraints.js'

/** Prefix used to namespace agent-emitted callback_data on the wire. */
export const AGENT_CALLBACK_PREFIX = 'agent:'

/**
 * Maximum bytes available to the agent for callback_data payloads.
 * Telegram's hard limit is 64 bytes; the gateway reserves 6 bytes for
 * the `agent:` prefix.
 */
export const AGENT_CALLBACK_DATA_MAX = 64 - AGENT_CALLBACK_PREFIX.length

/**
 * Per-button agent-supplied metadata that controls post-tap UX (#710).
 * These fields are stripped before the keyboard is sent to Telegram —
 * they are NOT part of the Bot API. The gateway extracts and stores
 * them via {@link extractAgentButtonMeta} so the callback handler can
 * honor them when the user taps.
 */
export interface AgentButtonMeta {
  /** Toast text shown via answerCallbackQuery on tap. Default `'✓ received'`. */
  ack_text?: string
  /**
   * When false, the button keyboard is preserved after tap (re-tappable).
   * When true (default), tapping ANY single_use button on the message
   * removes the entire keyboard to prevent double-fire.
   */
  single_use?: boolean
  /**
   * Per-message override for the button-choice-confirmation annotation
   * (#789). When true, tapping annotates the source message body with a
   * "✅ You chose: <label> · HH:MM" line even if the agent default is off;
   * when false, annotation is skipped even if the agent default is on.
   * Undefined falls back to the agent's
   * channels.telegram.button_choice_confirmation.enabled default. Only takes
   * effect on single-use keyboards (re-tappable keyboards are never
   * annotated).
   */
  inline_keyboard_confirm?: boolean
}

/** Fields the gateway adds to button objects — not valid Telegram API fields. */
const AGENT_META_FIELDS: ReadonlyArray<keyof AgentButtonMeta> = [
  'ack_text',
  'single_use',
  'inline_keyboard_confirm',
]

/**
 * Wrap every callback_data field in a 2D inline-keyboard with the
 * gateway's `agent:` namespace prefix. URL-only buttons pass through
 * unchanged. Returns a fresh array — does not mutate the input.
 *
 * Also strips agent-only meta fields (`ack_text`, `single_use`) so they
 * don't leak into the Telegram API request. Use
 * {@link extractAgentButtonMeta} on the raw keyboard BEFORE wrapping to
 * recover those fields for the callback handler.
 *
 * Throws when an agent-supplied callback_data exceeds the effective
 * 58-byte budget (so the operator sees a clear error, not a silent
 * Telegram 400 BUTTON_DATA_INVALID at send time).
 */
export function wrapAgentCallbacks(keyboard: AnyButton[][]): AnyButton[][] {
  return keyboard.map((row) =>
    row.map((btn) => {
      const cleaned: AnyButton = { ...btn }
      for (const f of AGENT_META_FIELDS) delete cleaned[f]
      if (typeof btn.callback_data !== 'string') return cleaned
      const raw = btn.callback_data
      const rawBytes = new TextEncoder().encode(raw).byteLength
      if (rawBytes > AGENT_CALLBACK_DATA_MAX) {
        throw new Error(
          `inline_keyboard.callback_data exceeds ${AGENT_CALLBACK_DATA_MAX}-byte agent budget ` +
          `(actual=${rawBytes}, raw="${raw.slice(0, 32)}${raw.length > 32 ? '…' : ''}")`,
        )
      }
      cleaned.callback_data = `${AGENT_CALLBACK_PREFIX}${raw}`
      return cleaned
    }),
  )
}

/**
 * Redact agent-authored free-text on an inline keyboard BEFORE it is sent to
 * Telegram (#3148 fast-follow secret-scrub coverage). `wrapAgentCallbacks`
 * rewrites only `callback_data`; the visible `text` label, the `ack_text`
 * toast, and any `copy_text.text` clipboard payload pass through VERBATIM. An
 * agent that puts a secret in any of those transmits it unmasked, and it
 * resurfaces on tap — the label is echoed back (`button_text`), re-rendered in
 * the "✅ You chose: <label>" annotation (#789), and `ack_text` is shown as the
 * toast. `switch_inline_query` / `switch_inline_query_current_chat` /
 * `switch_inline_query_chosen_chat.query` are also agent-authored free text
 * that Telegram pastes into a chat's input box on tap (the current chat for
 * the `_current_chat` variant, a user-picked chat for `_chosen_chat` — both
 * user-visible), so they carry the same leak class. Route every one of these free-text fields
 * through the SAME outbound redactor the reply `text` body uses, at the
 * outbound boundary, so every downstream resurface reads already-masked bytes.
 *
 * `callback_data` is the routing key and is NEVER touched — redacting it would
 * break tap round-tripping. Button structure/order is preserved; the redactor
 * (`redact()`) only replaces detected secret byte-ranges with a non-empty
 * marker, so it never empties a label (the non-empty-text invariant holds).
 * Returns a fresh keyboard; does not mutate the input. `redactFn` is injected
 * so this stays pure + unit-testable and carries no gateway import cycle.
 *
 * Only agent-authored keyboards flow through here (the `reply` tool path);
 * framework-internal keyboards (approval cards, vault wizard, model menus) are
 * built separately and are NOT redacted by this function.
 */
export function redactAgentKeyboard(
  keyboard: AnyButton[][],
  redactFn: (s: string) => string,
): AnyButton[][] {
  // The keyboard is validated for length BEFORE redaction, but the redaction
  // marker (`[REDACTED:...]`) can be longer than the secret it replaces, so a
  // field that was within a Telegram cap can exceed it after masking. An
  // over-limit button field makes sendMessage 400 → the WHOLE reply is dropped
  // (worse than the leak we just closed), so clamp each masked free-text field
  // to its cap. Truncating a marker is harmless — it's already non-secret.
  const clamp = (s: string, max: number): string =>
    s.length > max ? s.slice(0, max) : s
  return keyboard.map((row) =>
    row.map((btn) => {
      const out: AnyButton = { ...btn }
      if (typeof out.text === 'string') {
        out.text = clamp(redactFn(out.text), TELEGRAM_BUTTON_LIMITS.TEXT_MAX)
      }
      // ack_text is a switchroom-side toast (answerCallbackQuery), not a
      // sendMessage field, so an over-length value can't drop the reply — no
      // clamp needed, but redact it all the same.
      if (typeof out.ack_text === 'string') out.ack_text = redactFn(out.ack_text)
      // switch_inline_query* paste agent free text into a chat input box on tap
      // — same leak class as the label. URL-class fields (url/web_app/login_url)
      // are deliberately left exact: a [REDACTED] marker would corrupt a URL.
      const siq = (out as { switch_inline_query?: unknown }).switch_inline_query
      if (typeof siq === 'string') {
        (out as { switch_inline_query?: string }).switch_inline_query = clamp(
          redactFn(siq), TELEGRAM_BUTTON_LIMITS.SWITCH_INLINE_QUERY_MAX)
      }
      const siqc = (out as { switch_inline_query_current_chat?: unknown })
        .switch_inline_query_current_chat
      if (typeof siqc === 'string') {
        (out as { switch_inline_query_current_chat?: string })
          .switch_inline_query_current_chat = clamp(
            redactFn(siqc), TELEGRAM_BUTTON_LIMITS.SWITCH_INLINE_QUERY_MAX)
      }
      // switch_inline_query_chosen_chat.query is the third variant: agent free
      // text pasted into a user-picked chat's input box on tap — same leak class.
      const cc = (out as { switch_inline_query_chosen_chat?: unknown })
        .switch_inline_query_chosen_chat
      if (cc != null && typeof cc === 'object' &&
          typeof (cc as { query?: unknown }).query === 'string') {
        (out as { switch_inline_query_chosen_chat?: Record<string, unknown> })
          .switch_inline_query_chosen_chat = {
            ...(cc as Record<string, unknown>),
            query: clamp(
              redactFn((cc as { query: string }).query),
              TELEGRAM_BUTTON_LIMITS.SWITCH_INLINE_QUERY_MAX),
          }
      }
      const ct = out.copy_text
      if (ct != null && typeof ct === 'object' &&
          typeof (ct as { text?: unknown }).text === 'string') {
        out.copy_text = {
          ...(ct as Record<string, unknown>),
          text: clamp(
            redactFn((ct as { text: string }).text),
            TELEGRAM_BUTTON_LIMITS.COPY_TEXT_MAX),
        }
      }
      return out
    }),
  )
}

/**
 * Extract per-button {@link AgentButtonMeta} from a raw (pre-wrap)
 * keyboard. Returns a map keyed by the raw (unprefixed) callback_data
 * string. Buttons without callback_data or without any meta fields are
 * omitted. Used by the gateway to remember post-tap UX preferences for
 * each button on a sent message.
 */
export function extractAgentButtonMeta(
  keyboard: AnyButton[][],
): Map<string, AgentButtonMeta> {
  const out = new Map<string, AgentButtonMeta>()
  for (const row of keyboard) {
    for (const btn of row) {
      if (typeof btn.callback_data !== 'string') continue
      const meta: AgentButtonMeta = {}
      if (typeof btn.ack_text === 'string') meta.ack_text = btn.ack_text
      if (typeof btn.single_use === 'boolean') meta.single_use = btn.single_use
      if (typeof btn.inline_keyboard_confirm === 'boolean') {
        meta.inline_keyboard_confirm = btn.inline_keyboard_confirm
      }
      if (
        meta.ack_text != null ||
        meta.single_use != null ||
        meta.inline_keyboard_confirm != null
      ) {
        out.set(btn.callback_data, meta)
      }
    }
  }
  return out
}

/**
 * Aggregate the message-level "should we strip the keyboard after a tap"
 * decision (#710). Default policy is single-use=true. The keyboard is
 * preserved only when at least one button on the message explicitly opts
 * out via `single_use: false`.
 */
export function keyboardIsSingleUse(
  metaByRawData: Map<string, AgentButtonMeta>,
): boolean {
  for (const meta of metaByRawData.values()) {
    if (meta.single_use === false) return false
  }
  return true
}

/**
 * Parse a callback_query.data string. Returns the raw agent payload
 * (sans prefix) when the data is agent-emitted; null otherwise so the
 * gateway dispatcher can fall through to its other routes.
 */
export function parseAgentCallback(data: string): { raw: string } | null {
  if (!data.startsWith(AGENT_CALLBACK_PREFIX)) return null
  return { raw: data.slice(AGENT_CALLBACK_PREFIX.length) }
}

// ─── #789 button-choice-confirmation ("✅ You chose: X") ──────────────────
//
// When a user taps an agent-emitted single-use inline_keyboard button, the
// gateway can annotate the source message body with a
// "✅ You chose: <label> · HH:MM" line so the chat surface is
// self-documenting (mirrors the ask_user finalize UX). The DECISION and the
// rendered text are pure functions here so they can be unit-tested against
// the exact payload the gateway ships — the gateway owns only the Telegram
// I/O and the once-per-process warning dedupe.

/** Per-agent button-choice-confirmation config (projected into access.json). */
export interface ButtonChoiceConfirmationConfig {
  enabled?: boolean
  format?: string
  timezone?: 'gateway' | 'utc'
}

/** Default annotation template. `{label}` and `{time}` are substituted. */
export const BUTTON_CONFIRM_DEFAULT_FORMAT = '✅ You chose: {label} · {time}'

/**
 * HTML-entity escaper for the annotation payload (shipped with
 * parse_mode: 'HTML'). Escapes exactly the three characters Telegram's HTML
 * parser treats specially — `&`, `<`, `>` — so arbitrary button labels and
 * source-message text can never 400 the editMessageText call. `&` is escaped
 * first so freshly produced entities aren't double-escaped. This is NOT the
 * GFM-markdown escaper (#2669) — that one escapes backticks/underscores and
 * would garble text (`Do_it` → `Do\_it`) under HTML parse mode.
 */
export function escapeHtmlEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Dedup-strip regex: matches a prior DEFAULT-shape annotation appended to the
 * body so a retap replaces rather than duplicates it. The `<b>`/`</b>` tags
 * are optional because Telegram returns `message.text` as PLAIN text (entity
 * markup lives in `message.entities`, not in the text) — on a real retap the
 * prior annotation arrives without tags. The `s` (dotAll) flag tolerates a
 * stray newline inside an older, un-stripped label (belt-and-braces alongside
 * the newline-stripping applied to the label on the way in). NOTE: dedup only
 * recognizes the DEFAULT annotation shape — a custom
 * button_choice_confirmation.format that diverges from it accumulates one
 * line per retap instead of replacing.
 */
export const BUTTON_CONFIRM_STRIP_RE =
  /\n\n✅ You chose: (?:<b>)?.*(?:<\/b>)? · \d{2}:\d{2}$/s

/**
 * Build the confirmation line. `{label}` → the tapped button's text with
 * newlines collapsed to spaces, trimmed to 60 chars (mirrors the toast trim),
 * HTML-entity-escaped (`&`, `<`, `>`) and wrapped in `<b>`; `{time}` →
 * HH:MM in the chosen timezone. `now`/`escapeLabel` are injectable for
 * deterministic tests; `escapeLabel` defaults to the real
 * {@link escapeHtmlEntities}. Substitutions use replacer FUNCTIONS so
 * String.replace special patterns (`$&`, `$'`, …) in labels are inert.
 */
export function buildButtonConfirmation(args: {
  template: string
  label: string
  timezone: 'gateway' | 'utc'
  escapeLabel?: (s: string) => string
  now?: Date
}): string {
  const escape = args.escapeLabel ?? escapeHtmlEntities
  const cleanLabel = args.label.replace(/\n/g, ' ').slice(0, 60)
  const now = args.now ?? new Date()
  const hh = args.timezone === 'utc'
    ? String(now.getUTCHours()).padStart(2, '0')
    : String(now.getHours()).padStart(2, '0')
  const mm = args.timezone === 'utc'
    ? String(now.getUTCMinutes()).padStart(2, '0')
    : String(now.getMinutes()).padStart(2, '0')
  return args.template
    .replace('{label}', () => `<b>${escape(cleanLabel)}</b>`)
    .replace('{time}', () => `${hh}:${mm}`)
}

/** Outcome of the annotate-or-strip decision for a single tap. */
export interface TapAnnotationResult {
  /** True → gateway should editMessageText with `text` (and strip keyboard). */
  annotate: boolean
  /** Annotated body text, present iff `annotate` is true. */
  text?: string
  /** True → gateway should emit the once-per-process parseMode warning. */
  warnParseMode: boolean
  /** True → gateway should emit the once-per-process single_use-mismatch warning. */
  warnSingleUseMismatch: boolean
}

/**
 * Pure decision for the #789 annotation. Resolves the per-message override
 * (the tapped button's `inline_keyboard_confirm`) over the agent default,
 * gates on single-use + presence of body text + a resolvable label + the
 * `html` parse mode, and renders the annotated body (with any prior
 * default-shape annotation stripped so a retap replaces it). Returns
 * `annotate:false` for every skip path; the caller still performs the
 * historical keyboard-only strip when the keyboard is single-use.
 *
 * The base body is HTML-entity-escaped too (Telegram hands us `message.text`
 * as plain text, so `&`/`<`/`>` in it would otherwise 400 the HTML edit).
 * Known limitation: because the body is rebuilt from `message.text`, any
 * entities/formatting (bold, links, …) on the original message are lost on
 * annotation. Documented in the config schema + CHANGELOG.
 */
export function resolveTapAnnotation(args: {
  perMessageOverride?: boolean
  singleUse: boolean
  config?: ButtonChoiceConfirmationConfig
  parseMode: 'html' | 'markdownv2' | 'text'
  sourceText?: string
  label?: string
  escapeLabel?: (s: string) => string
  now?: Date
}): TapAnnotationResult {
  const shouldAnnotate = args.perMessageOverride ?? args.config?.enabled ?? false
  const warnSingleUseMismatch = shouldAnnotate && !args.singleUse

  const wantAnnotate =
    shouldAnnotate &&
    args.singleUse &&
    args.sourceText != null &&
    args.label != null
  if (!wantAnnotate) {
    return { annotate: false, warnParseMode: false, warnSingleUseMismatch }
  }
  if (args.parseMode !== 'html') {
    return { annotate: false, warnParseMode: true, warnSingleUseMismatch }
  }
  const escape = args.escapeLabel ?? escapeHtmlEntities
  // Strip a prior annotation from the RAW text first (Telegram delivers it
  // un-tagged), then entity-escape the remainder for the HTML edit.
  const base = escape(
    (args.sourceText as string).replace(BUTTON_CONFIRM_STRIP_RE, ''),
  )
  const formatted = buildButtonConfirmation({
    template: args.config?.format ?? BUTTON_CONFIRM_DEFAULT_FORMAT,
    label: args.label as string,
    timezone: args.config?.timezone ?? 'gateway',
    escapeLabel: escape,
    ...(args.now != null ? { now: args.now } : {}),
  })
  return {
    annotate: true,
    text: `${base}\n\n${formatted}`,
    warnParseMode: false,
    warnSingleUseMismatch,
  }
}

/**
 * Perform the annotation edit against Telegram, with a keyboard-strip
 * fallback: if the editMessageText 400s/rejects for ANY reason (over-long
 * body, HTML edge case, message too old, …), we still strip the inline
 * keyboard via editMessageReplyMarkup so single-use protection holds even
 * though the button meta has already been consumed. Extracted here (with the
 * two Telegram calls injected) so the fallback is unit-testable.
 *
 * Returns 'annotated' | 'stripped-fallback' | 'failed' for observability.
 */
export async function applyTapAnnotationEdit(io: {
  editMessageText: (text: string, other: {
    parse_mode: 'HTML'
    reply_markup: { inline_keyboard: never[] }
  }) => Promise<unknown>
  editMessageReplyMarkup: (other: {
    reply_markup: { inline_keyboard: never[] }
  }) => Promise<unknown>
}, text: string): Promise<'annotated' | 'stripped-fallback' | 'failed'> {
  try {
    await io.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    })
    return 'annotated'
  } catch {
    try {
      await io.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
      return 'stripped-fallback'
    } catch {
      return 'failed'
    }
  }
}

/**
 * Convenience: validate + wrap in one call. Returns either the
 * wrapped keyboard or a structured error list — caller throws so the
 * tool result carries the diagnostic upstream.
 */
export function validateAndWrapAgentKeyboard(
  keyboard: AnyButton[][],
): { ok: true; wrapped: AnyButton[][] } | { ok: false; errors: ButtonValidationError[] } {
  const errors = validateInlineKeyboard(keyboard)
  if (errors.length > 0) return { ok: false, errors }
  // wrapAgentCallbacks may throw on byte-budget overflow; let it
  // propagate so the caller surfaces the message verbatim.
  const wrapped = wrapAgentCallbacks(keyboard)
  return { ok: true, wrapped }
}

// ─── finalizeCallback (#1150 + audit follow-up) ──────────────────────────
//
// Centralized "the user tapped a terminal button" helper. Every callback
// handler that resolves a decision (Approve / Deny / Pick option / Confirm
// revoke / Always-allow / Dismiss / etc.) MUST route through this helper
// so the three button-UX invariants are uniformly enforced:
//
//   1. Visible press feedback — `answerCallbackQuery` with `text:` so
//      Telegram shows a toast. Operators who tap and see nothing within
//      ~200ms double-tap; the toast IS the press-feedback affordance.
//   2. Keyboard collapses with clarity — the message is edited in place
//      to strip `reply_markup` AND append a status line that describes
//      what the operator selected. One atomic edit, not two: the user
//      must be able to scroll back later and see the resolved decision
//      next to the original prompt.
//   3. Side effect (typically: synthesize an inbound back to the model
//      so the agent's turn continues) — runs AFTER the message edit
//      lands so the model never sees "I'm being woken up" before the
//      operator sees the visual confirmation.
//
// Multi-step wizards (vault grant wizard, etc.) should NOT use this
// helper for intermediate-step transitions — those swap one keyboard
// for the next via `editMessageText` + new `reply_markup`. Use this
// helper for the WIZARD-FINAL step (Generate, Cancel) so the success
// card collapses correctly and isn't re-tappable.

/**
 * Minimal callback-context shape the helper needs. Real grammy
 * `Context` satisfies this; tests can implement a lightweight fake
 * without dragging the grammy types in.
 */
export interface FinalizeCallbackContext {
  answerCallbackQuery: (
    opts?: { text?: string; show_alert?: boolean },
  ) => Promise<unknown>
  editMessageText: (
    text: string | { markdown: string },
    opts?: Record<string, unknown>,
  ) => Promise<unknown>
}

export interface FinalizeCallbackOptions {
  /**
   * Toast text shown to the operator via `answerCallbackQuery`. Telegram
   * caps this at 200 chars; pass a short verb-phrase ("Approved",
   * "Saved", "Switching to slot 2"). Required — the toast IS invariant 1.
   */
  ackText: string
  /**
   * When true, the toast renders as a full modal alert instead of the
   * bottom-bar toast. Default false. Use for destructive or one-way
   * decisions (e.g. "Vault grant revoked") where the operator needs
   * stronger acknowledgement.
   */
  alert?: boolean
  /**
   * The new body text for the message AFTER the keyboard is stripped.
   * Build this yourself from `<original prompt>\n\n<status line>` so the
   * scrollback preserves the question alongside the answer. The keyboard
   * is stripped unconditionally regardless of `newText`.
   */
  newText: string
  /**
   * When true, `newText` is edited as a LITERAL plain string (no markdown
   * parsing) — match the original message's send shape. Default (false) →
   * the rich-markdown path, so `newText` is rendered as GFM markdown
   * (#2669, successor to the old `parseMode` option).
   */
  literalText?: boolean
  /**
   * Side effect invoked AFTER `editMessageText` resolves. Use for
   * synthesizing the `<channel source="...">` inbound that wakes the
   * agent's session. Errors are caught + logged via the `log` seam;
   * they do NOT propagate (a failed inbound synthesis must not regress
   * to "operator's tap visually un-applied"). The model-visible flow
   * is allowed to fail loudly via separate mechanisms (the supervisor
   * watchdog, the silence-poke ladder); this helper's job is to keep
   * invariants 1+2 strict and best-effort the rest.
   *
   * Skip for surfaces with no model in the loop (auth dashboard
   * actions that shell to the host CLI, operator-event dismiss, etc).
   */
  synthInbound?: () => void | Promise<void>
  /** Logger seam for tests. Defaults to stderr. */
  log?: (line: string) => void
}

/**
 * Apply the three-invariant finalize pattern. See module docstring
 * above for design rationale.
 *
 * Order: ack → edit → synth. The ack is fired-and-forgotten (so a slow
 * Telegram API doesn't delay the visible state change), but the edit
 * is awaited so `synthInbound` doesn't race ahead of the operator's
 * visual confirmation. Each step's error is logged + swallowed —
 * partial success is preferred to "tap looked dead AND the model
 * stayed stuck" full failure.
 */
export async function finalizeCallback(
  ctx: FinalizeCallbackContext,
  opts: FinalizeCallbackOptions,
): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line))
  // Invariant 1 — toast. Fire-and-forget; we don't want a slow
  // answerCallbackQuery round-trip to delay the message edit.
  void ctx.answerCallbackQuery({
    text: opts.ackText,
    ...(opts.alert ? { show_alert: true } : {}),
  }).catch((err: unknown) => {
    log(`finalizeCallback: answerCallbackQuery failed: ${(err as Error).message}\n`)
  })
  // Invariant 2 — strip keyboard + append status line, atomic edit.
  try {
    await ctx.editMessageText(
      opts.literalText ? opts.newText : { markdown: opts.newText },
      {
        reply_markup: { inline_keyboard: [] },
        // Default link_preview_options off — most finalized cards don't
        // benefit from preview cards, and a stale preview survives the
        // edit otherwise.
        link_preview_options: { is_disabled: true },
      },
    )
  } catch (err) {
    // MESSAGE_NOT_MODIFIED (text didn't change) and MESSAGE_TO_EDIT_NOT_FOUND
    // (operator already deleted the card) are both benign. Other failures
    // log + continue — we still want synthInbound to run.
    log(`finalizeCallback: editMessageText failed: ${(err as Error).message}\n`)
  }
  // Invariant 3 — model wake-up (when applicable).
  if (opts.synthInbound != null) {
    try {
      const r = opts.synthInbound()
      if (r != null && typeof (r as Promise<unknown>).then === 'function') {
        await (r as Promise<unknown>)
      }
    } catch (err) {
      log(`finalizeCallback: synthInbound threw: ${(err as Error).message}\n`)
    }
  }
}
