/**
 * Pure helpers for the `send_sticker` MCP tool's alias-resolution path.
 *
 * Stickers in Telegram are addressed by `file_id` — opaque, ~70-char,
 * agent-unfriendly. To make outbound stickers usable by personas we
 * let operators declare named aliases in switchroom.yaml under
 * `telegram.stickers: { mood_happy: "<file_id>", thinking: "<file_id>" }`.
 * The agent then calls `send_sticker(chat_id, alias='mood_happy')` and
 * we resolve to the file_id at send time.
 *
 * This file owns the resolution + validation. Pure — no Telegram API
 * calls, no I/O, fully unit-testable.
 *
 * Why operator-curated and not Tenor/Giphy: subscription-honest
 * principle says no third-party API keys. Stickers the agent wants to
 * send must be ones an operator has explicitly approved by capturing
 * a file_id and putting it in config. Same model the existing access
 * surface uses: trust-by-explicit-listing.
 */

export interface StickerAliasMap {
  /** alias name → Telegram file_id. Both validated on read. */
  [alias: string]: string
}

export interface StickerSendArgs {
  chat_id: string
  /** Either a raw Telegram file_id OR an alias declared in
   *  `telegram.stickers`. We accept both to match the agent's
   *  conversational intent: it might pass `'mood_happy'` from the
   *  config, or echo back a file_id it saw on inbound. */
  sticker: string
  message_thread_id?: string
  reply_to?: string
}

export interface ValidatedStickerSendArgs {
  chatId: string
  fileId: string
  /** What the resolution path was, for log lines + telemetry. Lets
   *  operators see "agent used alias 'happy' which mapped to file_id
   *  CAACAg..." vs "agent passed raw file_id." */
  resolution: 'alias' | 'raw'
  /** Original alias name if resolution === 'alias'. */
  aliasName?: string
  threadId?: number
  replyTo?: number
}

/**
 * Telegram file_ids are alphanumeric + `-` + `_`, typically 50-100
 * chars. Reject anything outside that shape early so the agent gets
 * a clear error rather than Telegram's generic 400.
 *
 * The 200-char ceiling matches the existing `download_attachment`
 * tool's validator — same shape across the surface.
 */
export function looksLikeFileId(s: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/.test(s)
}

/**
 * Aliases are operator-typed config keys. Restrict to safe shell-ish
 * characters so a misconfigured alias can't accidentally collide with
 * a file_id on the boundary, and so config files stay diff-friendly.
 */
export function isValidAliasName(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s)
}

/**
 * Validate raw sticker-send args + resolve any alias against the
 * configured map. Throws with an actionable error on every failure
 * mode so the agent's tool-error reply tells the user (or operator)
 * exactly what to fix.
 */
export function resolveStickerSendArgs(
  raw: StickerSendArgs,
  aliasMap: StickerAliasMap,
): ValidatedStickerSendArgs {
  if (typeof raw.chat_id !== 'string' || raw.chat_id.length === 0) {
    throw new Error('send_sticker: chat_id is required')
  }
  if (typeof raw.sticker !== 'string' || raw.sticker.length === 0) {
    throw new Error('send_sticker: sticker (file_id or alias) is required')
  }

  let fileId: string
  let resolution: 'alias' | 'raw'
  let aliasName: string | undefined

  // Distinguishing alias vs file_id: file_ids include only alnum + `-`
  // + `_`, but they're long (50-100). Aliases are short (under 64).
  // First check: is it a known alias? If yes, use that. Otherwise, is
  // it a valid file_id? If yes, pass through. Otherwise, error.
  //
  // The "known alias" check first means an operator can never have an
  // alias collide with a file_id by accident — config wins.
  if (Object.prototype.hasOwnProperty.call(aliasMap, raw.sticker)) {
    aliasName = raw.sticker
    fileId = aliasMap[raw.sticker]
    resolution = 'alias'
    if (!looksLikeFileId(fileId)) {
      throw new Error(
        `send_sticker: alias '${raw.sticker}' resolves to malformed file_id ` +
        `in switchroom.yaml — fix telegram.stickers.${raw.sticker}`,
      )
    }
  } else if (looksLikeFileId(raw.sticker)) {
    fileId = raw.sticker
    resolution = 'raw'
  } else if (isValidAliasName(raw.sticker)) {
    // The agent asked for an alias that doesn't exist. Tell it
    // explicitly so it can ask the user to add one or pick a
    // different one.
    const known = Object.keys(aliasMap).sort()
    const hint = known.length > 0
      ? ` Available aliases: ${known.join(', ')}.`
      : ' No sticker aliases are configured for this agent.'
    throw new Error(`send_sticker: unknown alias '${raw.sticker}'.${hint}`)
  } else {
    throw new Error(
      `send_sticker: '${raw.sticker}' is neither a valid Telegram file_id ` +
      `nor a configured alias name`,
    )
  }

  let threadId: number | undefined
  if (raw.message_thread_id != null) {
    threadId = Number(raw.message_thread_id)
    if (!Number.isFinite(threadId) || threadId <= 0) {
      throw new Error('send_sticker: message_thread_id must be a positive integer string')
    }
  }
  let replyTo: number | undefined
  if (raw.reply_to != null) {
    replyTo = Number(raw.reply_to)
    if (!Number.isFinite(replyTo) || replyTo <= 0) {
      throw new Error('send_sticker: reply_to must be a positive integer string')
    }
  }

  return {
    chatId: raw.chat_id,
    fileId,
    resolution,
    aliasName,
    threadId,
    replyTo,
  }
}

export interface GifSendArgs {
  chat_id: string
  /** Either a Telegram file_id OR an https URL pointing at an
   *  animated mp4/gif. URLs let agents embed GIFs from operator-
   *  curated sources without the alias-config overhead — but we
   *  validate the URL is https + has a known media extension. */
  gif: string
  caption?: string
  message_thread_id?: string
  reply_to?: string
}

export interface ValidatedGifSendArgs {
  chatId: string
  /** Either a file_id or a URL — Telegram's sendAnimation accepts
   *  both via the same `animation` field. */
  animationRef: string
  refKind: 'file_id' | 'url'
  caption?: string
  threadId?: number
  replyTo?: number
}

/**
 * Animated-media URLs: https, ends in `.mp4` / `.gif` / `.webm`.
 * Telegram accepts these via sendAnimation's URL form. Reject other
 * URLs so the agent can't accidentally try to embed an HTML page.
 */
export function isAcceptableGifUrl(s: string): boolean {
  if (!/^https:\/\//.test(s)) return false
  if (s.length > 1024) return false
  // Strip query string before extension check so e.g.
  // ?cache=123 doesn't trip us up.
  const noQuery = s.split('?')[0].split('#')[0]
  return /\.(mp4|gif|webm)$/i.test(noQuery)
}

export function resolveGifSendArgs(raw: GifSendArgs): ValidatedGifSendArgs {
  if (typeof raw.chat_id !== 'string' || raw.chat_id.length === 0) {
    throw new Error('send_gif: chat_id is required')
  }
  if (typeof raw.gif !== 'string' || raw.gif.length === 0) {
    throw new Error('send_gif: gif (file_id or url) is required')
  }

  let animationRef: string
  let refKind: 'file_id' | 'url'

  if (raw.gif.startsWith('http')) {
    if (!isAcceptableGifUrl(raw.gif)) {
      throw new Error(
        'send_gif: url must be https with .mp4 / .gif / .webm extension',
      )
    }
    animationRef = raw.gif
    refKind = 'url'
  } else if (looksLikeFileId(raw.gif)) {
    animationRef = raw.gif
    refKind = 'file_id'
  } else {
    throw new Error(
      `send_gif: '${raw.gif.slice(0, 40)}...' is neither a valid Telegram ` +
      `file_id nor an acceptable https URL`,
    )
  }

  if (raw.caption != null && typeof raw.caption !== 'string') {
    throw new Error('send_gif: caption must be a string')
  }
  if (raw.caption != null && raw.caption.length > 1024) {
    throw new Error('send_gif: caption too long (max 1024 chars)')
  }

  let threadId: number | undefined
  if (raw.message_thread_id != null) {
    threadId = Number(raw.message_thread_id)
    if (!Number.isFinite(threadId) || threadId <= 0) {
      throw new Error('send_gif: message_thread_id must be a positive integer string')
    }
  }
  let replyTo: number | undefined
  if (raw.reply_to != null) {
    replyTo = Number(raw.reply_to)
    if (!Number.isFinite(replyTo) || replyTo <= 0) {
      throw new Error('send_gif: reply_to must be a positive integer string')
    }
  }

  return {
    chatId: raw.chat_id,
    animationRef,
    refKind,
    caption: raw.caption,
    threadId,
    replyTo,
  }
}
