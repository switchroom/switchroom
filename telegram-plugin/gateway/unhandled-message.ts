/**
 * Terminal catch-all + diagnostic tap for inbound Telegram messages (#3300).
 *
 * THE CLASS OF BUG THIS CLOSES: the gateway registers only content-specific
 * handlers (`bot.on('message:text')`, `:photo`, … `:paid_media`). grammy
 * ^1.44 routes `bot.on` as filtering middleware — internally
 * `on → filter(pred, handler) → branch(pred, handler, pass)` — and a
 * `message` update matching NONE of the registered predicates falls through
 * every branch and is SILENTLY discarded: no log, no ack, no history row.
 *
 * Live signature (2026-07-16, klanker DM): message_id 19090 was allocated
 * between an outbound reply (19089, 21:51:11Z) and the next inbound (19091,
 * 21:59:31Z) with ZERO gateway trace — no early_ack, no gw-trace inbound, no
 * gate-deny, no error — while polling stayed healthy on both sides. Exactly
 * the zero-observability failure this module makes impossible: every update
 * is now logged on receipt (tap) and every message either produces a turn or
 * an explicit log-only line (catch-all).
 *
 * Extracted into its own module (rather than inline in gateway.ts) so tests
 * can drive the REAL registration path on a real grammy Bot — gateway.ts is
 * a side-effecting module that cannot be imported into a unit test.
 */

import type { Bot, Context } from 'grammy'

/**
 * Top-level `message` envelope fields — identity/routing metadata, excluded
 * when surfacing the CONTENT keys of a message (the fields that determine
 * which `bot.on('message:*')` handler should match).
 */
export const MESSAGE_ENVELOPE_KEYS: ReadonlySet<string> = new Set<string>([
  'message_id', 'message_thread_id', 'date', 'chat', 'from', 'sender_chat',
  'forward_origin', 'reply_to_message', 'external_reply', 'quote',
  'reply_to_story', 'edit_date', 'media_group_id', 'author_signature',
  'is_topic_message', 'is_automatic_forward', 'via_bot', 'sender_boost_count',
  'business_connection_id', 'effect_id', 'has_protected_content',
  'is_from_offline', 'link_preview_options', 'show_caption_above_media',
  'entities', 'caption_entities', 'paid_star_count',
])

/**
 * Known-noise SERVICE message content keys: chat/topic lifecycle events that
 * carry no user intent for the agent. These are LOGGED (never silently
 * dropped — the whole point of #3300) but do NOT become agent turns:
 * forum-topic lifecycle events are a recurring spam vector in supergroups,
 * and each spurious turn costs tokens and attention.
 *
 * Anything NOT in this set that reaches the catch-all is delivered as a turn
 * (fail-toward-delivery: an unknown content type plausibly carries user
 * intent; better a placeholder turn than a lost message).
 */
export const SERVICE_NOISE_KEYS: ReadonlySet<string> = new Set<string>([
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed',
  'migrate_to_chat_id', 'migrate_from_chat_id',
  'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed',
  'forum_topic_reopened', 'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'video_chat_scheduled', 'video_chat_started', 'video_chat_ended',
  'video_chat_participants_invited',
  'giveaway_created', 'giveaway', 'giveaway_winners', 'giveaway_completed',
  'boost_added', 'chat_background_set', 'write_access_allowed',
  'proximity_alert_triggered', 'chat_set_theme',
  'connected_website', 'direct_message_price_changed',
])

/** The CONTENT keys of a message — top-level keys minus envelope metadata. */
export function messageContentKeys(msg: Record<string, unknown>): string[] {
  return Object.keys(msg).filter(k => !MESSAGE_ENVELOPE_KEYS.has(k))
}

export type UnhandledMessagePlan =
  | { action: 'turn'; text: string; contentKeys: string[] }
  | { action: 'log-only'; contentKeys: string[] }

/**
 * Decide what the catch-all does with a message no specific handler consumed:
 * known-noise service messages → log-only (no turn); everything else → a turn
 * with best-effort text (`text ?? caption ?? placeholder naming the type`).
 */
export function planUnhandledMessage(msg: Record<string, unknown>): UnhandledMessagePlan {
  const contentKeys = messageContentKeys(msg)
  if (contentKeys.length > 0 && contentKeys.every(k => SERVICE_NOISE_KEYS.has(k))) {
    return { action: 'log-only', contentKeys }
  }
  const contentType = contentKeys[0] ?? 'unknown'
  const text =
    (typeof msg.text === 'string' ? msg.text : undefined) ??
    (typeof msg.caption === 'string' ? msg.caption : undefined) ??
    `(unhandled message content: ${contentType})`
  return { action: 'turn', text, contentKeys }
}

/** One compact diagnostic line per update; cap prevents log flooding. */
export const TAP_MAX_LINES_PER_MINUTE = 300

/**
 * Install the diagnostic update tap: pass-through middleware (`bot.use` →
 * always calls next()) logging every received update's type + content keys
 * (never payload bodies — privacy). Rate-limited to TAP_MAX_LINES_PER_MINUTE
 * per wall-clock minute; on rollover a single summary line reports how many
 * were suppressed, so even a flood is never invisible.
 *
 * MUST be installed before all `bot.on` handlers so it observes every update.
 */
export function installUpdateTap(
  bot: Pick<Bot, 'use'>,
  log: (line: string) => void,
  nowMs: () => number = Date.now,
): void {
  let windowStart = 0
  let windowCount = 0
  let suppressed = 0
  bot.use(async (ctx, next) => {
    try {
      const now = nowMs()
      if (now - windowStart >= 60_000) {
        if (suppressed > 0) {
          log(`telegram gateway: rx tap suppressed ${suppressed} update lines in the last minute (cap ${TAP_MAX_LINES_PER_MINUTE}/min)\n`)
        }
        windowStart = now
        windowCount = 0
        suppressed = 0
      }
      if (windowCount < TAP_MAX_LINES_PER_MINUTE) {
        windowCount++
        const upd = ctx.update as unknown as Record<string, unknown>
        const updateType = Object.keys(upd).find(k => k !== 'update_id') ?? 'unknown'
        const msg = ctx.message as unknown as Record<string, unknown> | undefined
        const detail = msg ? ` content=[${messageContentKeys(msg).join(',')}]` : ''
        log(`telegram gateway: rx update_id=${ctx.update.update_id} type=${updateType}${detail}\n`)
      } else {
        suppressed++
      }
    } catch {
      // The diagnostic tap must never break the inbound pipeline.
    }
    await next()
  })
}

/**
 * Install the terminal catch-all. MUST be registered LAST among the
 * `message`/`message:*` handlers: grammy leaf handlers never call `next()`,
 * so a matched specific handler stops the chain (specific handler always
 * wins) and this only fires for messages no specific handler consumed —
 * registration order IS the no-double-handling guarantee.
 *
 * `onInbound` is the normal inbound pipeline (gateway.ts passes
 * handleInboundCoalesced), which applies the same access gating and
 * forward-origin parsing as every other content handler.
 */
export function installUnhandledMessageCatchAll(
  bot: Pick<Bot, 'on'>,
  onInbound: (ctx: Context, text: string) => Promise<void>,
  log: (line: string) => void,
): void {
  bot.on('message', async ctx => {
    try {
      const msg = ctx.message as unknown as Record<string, unknown>
      const plan = planUnhandledMessage(msg)
      // Log KEYS + ids only — never the payload bodies (privacy).
      log(
        `telegram gateway: catch-all inbound (no specific handler) ` +
          `update_id=${ctx.update.update_id} chat_id=${ctx.chat?.id ?? '?'} ` +
          `message_id=${ctx.message?.message_id ?? '?'} ` +
          `content_keys=[${plan.contentKeys.join(',')}] action=${plan.action}\n`,
      )
      if (plan.action === 'turn') {
        await onInbound(ctx, plan.text)
      }
    } catch (err) {
      log(`telegram gateway: catch-all handler error: ${(err as Error).message}\n`)
    }
  })
}
