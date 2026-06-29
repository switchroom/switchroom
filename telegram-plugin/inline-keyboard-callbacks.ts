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
}

/** Fields the gateway adds to button objects — not valid Telegram API fields. */
const AGENT_META_FIELDS: ReadonlyArray<keyof AgentButtonMeta> = ['ack_text', 'single_use']

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
      if (meta.ack_text != null || meta.single_use != null) {
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
