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
