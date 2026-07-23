/**
 * Rich-message inbound handler (forwarded-body drop fix).
 *
 * THE BUG THIS CLOSES (evidence: carrie history.db row message_id=944,
 * 2026-07-24 06:03; gateway-supervisor.log update_id=417526125
 * `content_keys=[forward_from,forward_date,rich_message]`): a message whose
 * content is a Bot API 10.1 `rich_message` — typically a FORWARDED bot
 * message, since the gateway itself sends everything via `sendRichMessage` —
 * carries NO top-level `text` or `caption`. It therefore matched none of the
 * registered `message:text` / `:photo` / `:caption` handlers, fell through to
 * the terminal catch-all (`unhandled-message.ts`), and the agent received the
 * placeholder `(unhandled message content: forward_from)` instead of the real
 * body. The forwarded content was silently dropped.
 *
 * grammy ^1.44 DOES ship a `message:rich_message` filter (see
 * `@grammyjs/types` `RichMessage` / `RichBlock` / `RichText`) — the gateway
 * simply never registered it. This module renders the inbound block tree to
 * plain markdown-ish text deterministically and routes it through the SAME
 * inbound pipeline as `message:text` (access gating + forward-origin parsing
 * happen downstream, unchanged — origin metadata stays on the trusted
 * `<channel>`-attr lane per #3162; nothing here injects provenance into the
 * body).
 *
 * Registration stays in gateway.ts (order pinned by
 * gateway-handler-registration-wiring.test.ts): `message:rich_message` is
 * registered BEFORE the terminal catch-all, so the catch-all no longer sees
 * these messages at all. `planUnhandledMessage` also imports
 * `extractRichMessageText` as belt-and-braces for any future shape that
 * carries a `rich_message` alongside unknown content.
 */

import type { Context, Filter } from 'grammy'
import type { MediaEnvelopeDeps } from './media-message-handlers.js'

/**
 * Delivered body when a rich message renders to nothing extractable (e.g. a
 * pure media/divider composition). Distinct from the catch-all's
 * `(unhandled message content: …)` placeholder — this one names the actual
 * situation and still yields a turn (fail-toward-delivery).
 */
export const RICH_MESSAGE_EMPTY_TEXT = '(rich message with no extractable text)'

/** Recursion guard: the Bot API caps rich messages at 16 nesting levels; a
 * hostile/malformed payload deeper than this is truncated, not stack-overflowed. */
const MAX_DEPTH = 32

interface RichTextNode {
  type?: string
  text?: unknown
  expression?: string
  alternative_text?: string
  name?: string
}

/**
 * Flatten a `RichText` union (string | RichText[] | typed node) to plain
 * text. Inline formatting (bold/italic/…) is dropped — the agent needs the
 * CONTENT; re-marking inline spans risks re-introducing accidental-formatting
 * classes the render guards exist to kill. Leaf specials keep their readable
 * payload: custom emoji → alternative text, math → LaTeX source, anchors →
 * nothing.
 */
export function renderRichText(rt: unknown, depth = 0): string {
  if (depth > MAX_DEPTH || rt == null) return ''
  if (typeof rt === 'string') return rt
  if (Array.isArray(rt)) return rt.map(t => renderRichText(t, depth + 1)).join('')
  if (typeof rt !== 'object') return ''
  const node = rt as RichTextNode
  if (node.type === 'custom_emoji') return node.alternative_text ?? ''
  if (node.type === 'mathematical_expression') {
    return typeof node.expression === 'string' ? node.expression : ''
  }
  if (node.type === 'anchor') return ''
  // Every other RichText node (bold, italic, url, mention, code, …) wraps a
  // `text: RichText` payload — recurse into it.
  if ('text' in node) return renderRichText(node.text, depth + 1)
  return ''
}

interface RichBlockNode {
  type?: string
  text?: unknown
  credit?: unknown
  language?: string
  expression?: string
  summary?: unknown
  blocks?: unknown
  items?: Array<{ label?: string; blocks?: unknown; has_checkbox?: boolean; is_checked?: boolean }>
  cells?: Array<Array<{ text?: unknown }>>
  caption?: { text?: unknown; credit?: unknown } | unknown
}

function renderCaption(caption: unknown, depth: number): string {
  if (caption == null || typeof caption !== 'object') return renderRichText(caption, depth)
  const c = caption as { text?: unknown; credit?: unknown }
  const text = renderRichText(c.text, depth)
  const credit = renderRichText(c.credit, depth)
  return [text, credit ? `— ${credit}` : ''].filter(Boolean).join(' ')
}

function renderBlocks(blocks: unknown, depth: number): string {
  if (depth > MAX_DEPTH || !Array.isArray(blocks)) return ''
  return blocks
    .map(b => renderRichBlock(b, depth + 1))
    .filter(s => s.length > 0)
    .join('\n')
}

/** Render one `RichBlock` to a plain-text line/paragraph. Unknown block types
 * degrade to their `text` / nested `blocks` when present (fail-toward-content:
 * a future block type should surface its words, not vanish). */
export function renderRichBlock(block: unknown, depth = 0): string {
  if (depth > MAX_DEPTH || block == null || typeof block !== 'object') return ''
  const b = block as RichBlockNode
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'footer':
      return renderRichText(b.text, depth)
    case 'pre': {
      const body = renderRichText(b.text, depth)
      return body.length > 0 ? `\`\`\`${b.language ?? ''}\n${body}\n\`\`\`` : ''
    }
    case 'divider':
      return '---'
    case 'mathematical_expression':
      return typeof b.expression === 'string' ? b.expression : ''
    case 'anchor':
      return ''
    case 'list': {
      if (!Array.isArray(b.items)) return ''
      return b.items
        .map(item => {
          const body = renderBlocks(item?.blocks, depth)
          const check = item?.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : ''
          const label = typeof item?.label === 'string' && item.label.length > 0 ? item.label : '-'
          return body.length > 0 ? `${label} ${check}${body}` : ''
        })
        .filter(s => s.length > 0)
        .join('\n')
    }
    case 'blockquote': {
      const body = renderBlocks(b.blocks, depth)
      const credit = renderRichText(b.credit, depth)
      const quoted = body
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')
      return [quoted, credit ? `> — ${credit}` : ''].filter(s => s.length > 0).join('\n')
    }
    case 'pullquote': {
      const body = renderRichText(b.text, depth)
      const credit = renderRichText(b.credit, depth)
      return [body, credit ? `— ${credit}` : ''].filter(Boolean).join(' ')
    }
    case 'details': {
      const summary = renderRichText(b.summary, depth)
      const body = renderBlocks(b.blocks, depth)
      return [summary, body].filter(s => s.length > 0).join('\n')
    }
    case 'collage':
    case 'slideshow': {
      const body = renderBlocks(b.blocks, depth)
      const caption = renderCaption(b.caption, depth)
      return [body, caption].filter(s => s.length > 0).join('\n')
    }
    case 'table': {
      if (!Array.isArray(b.cells)) return ''
      const rows = b.cells
        .map(row =>
          Array.isArray(row)
            ? row.map(cell => renderRichText(cell?.text, depth)).join(' | ')
            : '',
        )
        .filter(s => s.length > 0)
        .join('\n')
      const caption = renderRichText((b as { caption?: unknown }).caption, depth)
      return [caption, rows].filter(s => s.length > 0).join('\n')
    }
    case 'map':
    case 'animation':
    case 'audio':
    case 'photo':
    case 'video':
    case 'voice_note': {
      // Media blocks: the binary itself is not downloaded here (a forwarded
      // rich message's media has no coalescing/attachment plumbing yet — see
      // PR description follow-up); the caption text IS the readable content.
      const caption = renderCaption(b.caption, depth)
      const tag = `[${b.type}]`
      return caption.length > 0 ? `${tag} ${caption}` : tag
    }
    case 'thinking':
      return ''
    default: {
      // Unknown/future block type — surface any text-ish payload it carries.
      const text = renderRichText(b.text, depth)
      if (text.length > 0) return text
      return renderBlocks(b.blocks, depth)
    }
  }
}

/**
 * Extract the readable text of an inbound `message.rich_message`, or
 * `undefined` when nothing extractable exists. Accepts `unknown` — the value
 * arrives from the Telegram wire and must never throw the handler.
 */
export function extractRichMessageText(rich: unknown): string | undefined {
  if (rich == null || typeof rich !== 'object') return undefined
  const blocks = (rich as { blocks?: unknown }).blocks
  const rendered = renderBlocks(blocks, 0)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return rendered.length > 0 ? rendered : undefined
}

/**
 * `message:rich_message` handler — same dispatch surface as the cluster-A
 * media-envelope handlers: renders the body and hands it to the normal
 * coalescing inbound pipeline (access gating + forward-origin parsing
 * downstream, identical to `message:text`).
 */
export async function handleRichMessageMessage(
  ctx: Filter<Context, 'message:rich_message'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const text = extractRichMessageText(ctx.message.rich_message) ?? RICH_MESSAGE_EMPTY_TEXT
    deps.log(`telegram gateway: inbound rich_message from chat=${ctx.chat?.id ?? '?'} chars=${text.length}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: rich_message handler error: ${(err as Error).message}\n`)
  }
}
