/**
 * sent-text-capture.ts — pair a card's RENDERED body with the message id
 * Telegram assigned it (#4571 follow-up).
 *
 * The bug this exists to close
 * ---------------------------
 * #4576 gave every gateway card a `role='system'` history row so a quote-reply
 * to it resolves. The row carried the right `message_id`, chat, thread and
 * `kind` — and an EMPTY `text`, on 100% of the rows, on every agent in the
 * fleet. `resolveReplyToFromBuffer` only sets `reply_to_text` when the stored
 * body is non-empty (`inbound-router.ts`), so the agent learned WHICH card was
 * tapped and still could not see WHAT IT SAID. That was the entire point.
 *
 * Root cause: the observer derived the body from the Telegram RESPONSE
 * (`msg.text ?? msg.caption`), and every card goes out through Bot API 10.1
 * `sendRichMessage`, whose response is a `Message.RichMessageMessage` — the
 * body lives under `rich_message: { blocks }`, and `text` / `caption` are
 * simply absent (`@grammyjs/types` `message.d.ts:98`, `:184`). So the extractor
 * fell through to `''` every single time.
 *
 * The mechanism
 * -------------
 * Don't re-derive the body from a response shape that varies per send verb.
 * Capture it from the REQUEST, where it is unambiguously known for every verb,
 * at the one seam no outbound call can bypass: a grammY API transformer
 * (`bot.api.config.use`) — the same seam `installRichMarkdownGuard` already
 * uses, and the reason that guard is universal where `richMessage()` is not.
 *
 * The transformer sees the outbound payload AND the resolved response in one
 * call, so it can pair them with zero bookkeeping: no id→text map, no eviction,
 * no cross-call race. It stamps the body onto the returned `Message` under a
 * non-enumerable, `Symbol.for`-keyed property, which:
 *   - survives grammY's `callApi` unwrapping — the transformer chain resolves
 *     with the raw `{ok, result}` envelope and `callApi` returns `data.result`
 *     BY REFERENCE (grammy 1.44.0 `out/core/client.js:95-99`), so the object
 *     the caller receives is the object we stamped;
 *   - is invisible to `JSON.stringify`, `Object.keys`, spreads and structural
 *     equality, so nothing that reads a `Message` today can observe it.
 *
 * Non-negotiable: this must never break the send it observes. Every step is
 * defensive and the transformer's only unconditional act is `return prev(...)`.
 */

import type { Bot } from 'grammy'

/**
 * The stamp key. `Symbol.for` (not a module-local `Symbol()`) deliberately:
 * the plugin is consumed both from source and from a bundle, and a duplicated
 * module instance would otherwise mint a second, non-matching symbol and
 * silently reopen the exact hole this file closes.
 */
export const SENT_TEXT = Symbol.for('switchroom.telegram.sentText')

/** Depth cap for the rich-block walk — a hostile/odd payload cannot recurse us. */
const MAX_BLOCK_DEPTH = 8

/**
 * Best-effort readable text out of an OUTBOUND `InputRichMessage.blocks` array.
 *
 * Nothing in this repo builds `{ blocks }` today (every rich send goes through
 * `richMessage()` → `{ markdown }`), so this is purely the guard against a
 * future adopter silently re-emptying the card lane. Bounded, allocation-shy,
 * never throws.
 */
function flattenInputRichBlocks(blocks: unknown, depth: number): string {
  if (!Array.isArray(blocks) || depth > MAX_BLOCK_DEPTH) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block == null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    for (const key of ['markdown', 'html', 'text', 'caption'] as const) {
      const v = b[key]
      if (typeof v === 'string' && v.length > 0) parts.push(v)
    }
    const nested = flattenInputRichBlocks(b.blocks, depth + 1)
    if (nested.length > 0) parts.push(nested)
  }
  return parts.join('\n')
}

/**
 * The body a Telegram API request is about to POST, or null when the payload
 * carries no user-visible text (pins, deletes, reactions, `getUpdates`, …).
 *
 * Shape verified against grammy 1.44.0 `out/core/api.js` and the payload notes
 * in `installRichMarkdownGuard`: `sendRichMessage` / rich `editMessageText`
 * put the body at `payload.rich_message.markdown`, plain sends at
 * `payload.text`, media sends at `payload.caption`. Pure.
 */
export function outboundPayloadText(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const rich = p.rich_message
  if (rich != null && typeof rich === 'object') {
    const r = rich as Record<string, unknown>
    if (typeof r.markdown === 'string') return r.markdown
    if (typeof r.html === 'string') return r.html
    const flat = flattenInputRichBlocks(r.blocks, 0)
    if (flat.length > 0) return flat
  }
  if (typeof p.text === 'string') return p.text
  if (typeof p.caption === 'string') return p.caption
  return null
}

/**
 * Stamp `text` onto a resolved API response envelope's `Message` result.
 *
 * Takes the raw `{ok, result}` envelope (what a transformer sees), not the
 * unwrapped message, and no-ops on anything that isn't a single Message —
 * `true` (pins / dropped edits / `editMessageText` on an inline message),
 * arrays, `{ok:false}` rejections. Never throws.
 */
export function attachSentText(envelope: unknown, text: string): void {
  try {
    if (envelope == null || typeof envelope !== 'object') return
    const env = envelope as { ok?: unknown; result?: unknown }
    if (env.ok !== true) return
    const result = env.result
    if (result == null || typeof result !== 'object' || Array.isArray(result)) return
    Object.defineProperty(result, SENT_TEXT, {
      value: text,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    /* stamping must never break the send */
  }
}

/**
 * Read the body stamped by {@link installSentTextCapture} off a `Message`, or
 * null when the message did not transit a capture-installed bot (a test double,
 * a second Bot instance, a hand-built fixture). Pure.
 */
export function readSentText(message: unknown): string | null {
  if (message == null || typeof message !== 'object') return null
  const v = (message as Record<symbol, unknown>)[SENT_TEXT]
  return typeof v === 'string' ? v : null
}

/**
 * Install the capture transformer on the production Bot.
 *
 * Install it AFTER `installRichMarkdownGuard` so it composes OUTSIDE the guard
 * (grammY's last-installed transformer runs first) and therefore captures the
 * body as the CALLER wrote it, before the accidental-formatting guard's
 * backslash escapes are applied. The stored antecedent is what the card said,
 * not the wire-escaped form of it.
 */
export function installSentTextCapture(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    let text: string | null = null
    try {
      text = outboundPayloadText(payload)
    } catch {
      text = null
    }
    const res = await prev(method, payload, signal)
    if (text != null) attachSentText(res, text)
    return res
  })
}
