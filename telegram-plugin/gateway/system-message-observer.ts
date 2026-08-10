/**
 * system-message-observer.ts — make CARD message ids resolvable (#4571).
 *
 * The problem
 * -----------
 * Only two things ever reached `history.db`: an inbound message, and an
 * outbound that flowed through the `reply` / `stream_reply` family (which call
 * `recordOutbound` explicitly). Everything else the gateway posts — the
 * mid-turn activity card, the pinned status message, approval / boot / issues
 * / worker-feed cards, `progress_update` lines, restart notices — consumed a
 * real Telegram message id and left NO row behind. Measured on a live agent's
 * buffer: 116 rows across a 266-id span above id 20000, i.e. ~56% of the ids
 * in that chat were absent, clustered exactly where the cards were.
 *
 * That is user-visible, not cosmetic. The activity card is the most recent
 * message on the operator's screen for most of a turn, so quote-replying to it
 * is the natural gesture. Telegram then delivers `reply_to_message_id` pointing
 * at a message the agent has no record of, the reply-antecedent resolver
 * (`resolveReplyToFromBuffer`) gets `null` back, and the agent has to say "I
 * can't see the message you replied to".
 *
 * The mechanism
 * -------------
 * Rather than add a `recordSystemOutbound(...)` call to each of the ~110 raw
 * send sites (which is exactly the kind of per-call-site discipline that
 * decays — the `reply` path was the only site anyone remembered), this hooks
 * the ONE chokepoint every gateway outbound already goes through:
 * `gateway.ts`'s `robustApiCall` (chat-lock → send-gate → retry policy). Every
 * card send in the gateway is routed through it, enforced by the
 * `check-bot-api-wrapping` lint guard.
 *
 * The observer reads the Telegram RESPONSE, which buys three things for free:
 *   - the real `message_id` (the only thing a reply can point at),
 *   - the chat and forum-topic the message actually landed in,
 *   - the BODY, as Telegram RENDERED it.
 *
 * The #4576 bug was reading only ONE body field off the response. Every card
 * goes out via Bot API 10.1 `sendRichMessage`, and the `Message` it returns is
 * a `Message.RichMessageMessage`: the body lives under `rich_message.blocks`
 * ("Content of the message" — Bot API `RichMessage`), and `text` / `caption`
 * are absent. `extractSentMessage` read `msg.text ?? msg.caption ?? ''` and so
 * stored `''` on 100% of the rows on every agent in the fleet — the agent could
 * see WHICH card was quote-replied to but never WHAT IT SAID. The fix is to
 * read `rich_message` too, flattened by the same renderer the inbound
 * rich-message handler uses.
 *
 * Preferring the response is not just simpler, it is more FAITHFUL. The
 * request-side body for the dominant card path has already been through
 * `richMessage()`'s `guardAccidentalFormatting` (`rich-send.ts`), which is
 * applied in the CALLER, so `sent_text_capture.ts` is on the wire as
 * `sent\_text\_capture.ts` and `$12.40` as `\$12.40`. The response's
 * `rich_message` is the parsed, rendered block tree with those escapes already
 * resolved — i.e. what the operator actually saw on screen, which is exactly
 * what a quote-reply antecedent should say.
 *
 * The request-side stamp (`shared/sent-text-capture.ts`) is kept, LAST in the
 * precedence order, as the fallback for the shapes a response cannot supply —
 * a rich send whose blocks render to nothing (a media-only card), or a future
 * verb whose response omits the body. It is never preferred over the response.
 *
 * Send vs edit is NOT guessed from the verb (verb tagging is not uniform
 * across call sites and would rot). It falls out of the data: an edit returns
 * the same `message_id` it edited, so the conditional insert no-ops and the
 * call falls through to an in-place text refresh. One row per card, forever,
 * regardless of how many times it is edited.
 *
 * Cost control. The activity card is the highest-volume repeated
 * `editMessageText` in the gateway (it climbs every few seconds for the whole
 * turn). Refreshing its stored text on every edit would be a SQLite write per
 * edit. So a per-message throttle (`editRefreshMs`, default 20s) keeps the hot
 * path entirely in memory: a card edit inside the window costs one Map lookup
 * and no DB work at all. The stored text is therefore a recent snapshot, not
 * a byte-exact mirror of the live card — which is the right trade for a
 * quote-reply antecedent.
 *
 * Nothing here throws. A failure to record a card must never break the send it
 * is observing.
 */

import { readSentText } from '../shared/sent-text-capture.js'
import { extractRichMessageText } from './rich-message-handler.js'

/** The subset of a Telegram `Message` response this observer reads. */
export interface SentMessageLike {
  message_id?: unknown
  chat?: { id?: unknown } | null
  message_thread_id?: unknown
  text?: unknown
  caption?: unknown
  rich_message?: unknown
}

/** The subset of `robustApiCall`'s opts the observer reads. */
export interface ObservedCallOpts {
  chat_id?: string
  threadId?: number
  verb?: string
}

export interface SystemMessageObserverDeps {
  /**
   * `history.recordSystemOutbound`. Must return true iff it inserted a NEW
   * row, and false if any row already existed for (chat_id, message_id).
   */
  insert: (args: {
    chat_id: string
    thread_id: number | null
    message_id: number
    kind: string | null
    text: string
  }) => boolean
  /**
   * `history.updateSystemOutboundText`. Must return true iff it updated a row,
   * and false when the target row is absent or is NOT a system row (i.e. the
   * id belongs to a real reply or an inbound).
   */
  updateText: (args: { chat_id: string; message_id: number; text: string }) => boolean
  /** Injectable clock for the edit throttle. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Called when a card row is about to be written with an EMPTY body — i.e.
   * neither the response nor the request-side stamp yielded anything readable.
   *
   * This is the alarm for the #4576 failure mode. That bug was silent for a
   * whole release precisely because an empty body is indistinguishable from a
   * healthy row unless someone queries `length(text)`. Fired at most ONCE per
   * `kind` (else per raw verb) per process so a broken verb is loud in the log
   * without becoming a per-send stderr storm. Never called with a non-empty
   * body, and never for a response that is legitimately bodiless
   * (`isLegitimatelyBodiless`) — an alarm on `sendSticker` is noise a reader
   * cannot act on, and noise is what teaches people to ignore the alarm.
   *
   * Defaults to `defaultEmptyCardTextWarning` (stderr). Pass an explicit
   * function to redirect it, or `() => {}` to silence it in a test.
   */
  onEmptyText?: (info: { chat_id: string; message_id: number; kind: string | null }) => void
}

export interface SystemMessageObserverOptions {
  /**
   * Minimum gap between two stored-text refreshes of the SAME message. Edits
   * inside the window are dropped without touching SQLite.
   */
  editRefreshMs?: number
  /** Cap on tracked message ids before the oldest half is evicted. */
  maxTracked?: number
}

export const DEFAULT_EDIT_REFRESH_MS = 20_000
export const DEFAULT_MAX_TRACKED = 512

/**
 * Normalise a `robustApiCall` verb into the stored `kind` discriminator.
 *
 * The verb is the honest, already-present label for what a send IS
 * (`activity-summary.send`, `boot-card`, `worker-feed`, `approval-card`), so
 * the kind is derived rather than invented. The trailing transport suffix is
 * stripped so a card's OPEN and its EDITs classify identically.
 *
 * Pure. Returns null for an absent / blank verb.
 */
export function normalizeSendVerb(verb: string | undefined | null): string | null {
  if (typeof verb !== 'string') return null
  const trimmed = verb.trim()
  if (trimmed.length === 0) return null
  const base = trimmed.replace(/\.(send|edit|create|post|update)$/i, '')
  const cleaned = (base.length > 0 ? base : trimmed).slice(0, 64)
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Extract the (chat_id, message_id, thread, text) tuple from a Telegram API
 * result, or null when the result is not a sent/edited Message (the retry
 * wrapper also returns `true` for pins / deletes / reactions / callback
 * answers, and `undefined` for a swallowed benign 400).
 *
 * The response's own `chat.id` wins over the caller's `chat_id` opt: it is what
 * Telegram actually delivered to, and several call sites pass no `chat_id` at
 * all.
 *
 * `text` is resolved in strict precedence order, most authoritative first:
 *   1. `rich_message` on the RESPONSE, flattened by the same renderer the
 *      inbound rich-message handler uses. This is Telegram's own rendering of
 *      the block tree, so markdown escapes are already resolved — it is what
 *      the operator saw, and it is the shape every card send returns;
 *   2. `text` / `caption`, the plain-send and media-caption response shapes;
 *   3. the body stamped by `installSentTextCapture` from the outbound REQUEST —
 *      LAST, because on the dominant card path (`richMessage(body)`) it is the
 *      guard-escaped wire form, not the body as written. It is the fallback for
 *      responses that carry no renderable body at all.
 * `''` only when all three are absent, which the observer treats as an alarm
 * unless the response is legitimately bodiless. Pure.
 */
export function extractSentMessage(
  result: unknown,
  opts?: ObservedCallOpts,
): { chatId: string; messageId: number; threadId: number | null; text: string } | null {
  if (result == null || typeof result !== 'object') return null
  const msg = result as SentMessageLike
  const id = msg.message_id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null
  const rawChat = msg.chat?.id
  const chatId =
    rawChat != null && (typeof rawChat === 'number' || typeof rawChat === 'string')
      ? String(rawChat)
      : opts?.chat_id
  if (chatId == null || chatId.length === 0) return null
  const rawThread = msg.message_thread_id
  const threadId =
    typeof rawThread === 'number' && Number.isInteger(rawThread)
      ? rawThread
      : typeof opts?.threadId === 'number'
        ? opts.threadId
        : null
  const text =
    (msg.rich_message != null ? extractRichMessageText(msg.rich_message) : undefined) ??
    nonEmptyString(msg.text) ??
    nonEmptyString(msg.caption) ??
    readSentText(result) ??
    ''
  return { chatId, messageId: id, threadId, text }
}

/** `v` when it is a non-empty string, else undefined — so an empty `text` on
 *  the response falls THROUGH to the next precedence tier instead of pinning
 *  the result to `''`. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Response keys that mark a Telegram `Message` as LEGITIMATELY bodiless: the
 * send verb that produced it has no user-visible text by construction.
 *
 * The empty-body alarm exists to make a recurrence of #4576 loud. It is only
 * useful if it fires on a REGRESSION, so the verbs that are *supposed* to
 * store an empty body — `sendSticker`, `sendAnimation`, `sendVoice`,
 * `forwardMessage` of a media message, an uncaptioned `sendPhoto` — must not
 * emit an alarm indistinguishable from one.
 *
 * Keyed on the RESPONSE SHAPE rather than on `opts.verb` deliberately: verb
 * tagging is not uniform across call sites (`forwardMessage`,
 * `gateway.ts`, passes none at all), so a verb allowlist would rot exactly
 * where this needs to hold. A regressed CARD is a `rich_message` response
 * whose blocks rendered to nothing — it carries none of these keys and still
 * alarms. Pure.
 */
const BODILESS_MESSAGE_KEYS = [
  'sticker', 'animation', 'voice', 'video_note', 'dice', 'game', 'poll',
  'contact', 'location', 'venue', 'story', 'invoice', 'successful_payment',
  'checklist', 'photo', 'video', 'audio', 'document', 'paid_media',
] as const

export function isLegitimatelyBodiless(result: unknown): boolean {
  if (result == null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  return BODILESS_MESSAGE_KEYS.some((k) => r[k] != null)
}

/**
 * The observer's DEFAULT empty-body alarm: one stderr line naming the card kind
 * whose text capture missed.
 *
 * It lives here, and is the default rather than something gateway.ts wires,
 * for two reasons: gateway.ts is under an anti-inflation line ratchet
 * (switchroom#2996) so new logic belongs in a module; and a caller that forgets
 * to pass `onEmptyText` is exactly the caller that would re-ship #4576
 * silently. Opting OUT is now the explicit act.
 */
export function defaultEmptyCardTextWarning(info: {
  chat_id: string
  message_id: number
  kind: string | null
}): void {
  try {
    process.stderr.write(
      `telegram gateway: card-history text capture MISSED kind=${info.kind ?? '-'} ` +
        `chat=${info.chat_id} id=${info.message_id} — the response carried no ` +
        `rich_message/text/caption and no request-side body was stamped, so a ` +
        `quote-reply to this card will resolve its kind but not its body ` +
        `(see gateway/system-message-observer.ts extractSentMessage)\n`,
    )
  } catch {
    /* a broken stderr must never break the send */
  }
}

/** Per-id bookkeeping. `foreign` = the id belongs to a non-system row (a real
 *  reply or an inbound); never write to it again. `storedLen` is the length of
 *  the body currently in the row — 0 means the row is a HOLE, which the edit
 *  throttle must not preserve. */
type TrackedState = { lane: 'system' | 'foreign'; lastStoredMs: number; storedLen: number }

/**
 * Build the observer. The returned function is called with the RESOLVED result
 * of every `robustApiCall` and never throws.
 */
export function makeSystemMessageObserver(
  deps: SystemMessageObserverDeps,
  options?: SystemMessageObserverOptions,
): (result: unknown, opts?: ObservedCallOpts) => void {
  const now = deps.now ?? Date.now
  const editRefreshMs = options?.editRefreshMs ?? DEFAULT_EDIT_REFRESH_MS
  const maxTracked = Math.max(1, options?.maxTracked ?? DEFAULT_MAX_TRACKED)
  const tracked = new Map<string, TrackedState>()
  /** Kinds already reported through `onEmptyText` — one alarm per kind, per process. */
  const emptyReported = new Set<string>()
  const onEmptyText = deps.onEmptyText ?? defaultEmptyCardTextWarning

  function reportEmpty(
    chatId: string,
    messageId: number,
    kind: string | null,
    verb: string | undefined,
  ): void {
    // Bucket on the kind, else the RAW verb, else the untagged catch-all. Using
    // `kind ?? '<untagged>'` alone collapsed every untagged verb into one
    // bucket, so the first bodiless untagged send in the process permanently
    // silenced the alarm for every other untagged verb — including a real
    // regression.
    const bucket = kind ?? (typeof verb === 'string' && verb.length > 0 ? verb : '<untagged>')
    if (emptyReported.has(bucket)) return
    emptyReported.add(bucket)
    try {
      onEmptyText({ chat_id: chatId, message_id: messageId, kind })
    } catch {
      /* the alarm must never break the send either */
    }
  }

  function remember(key: string, state: TrackedState): void {
    tracked.set(key, state)
    if (tracked.size > maxTracked) {
      // Map iterates in insertion order — drop the oldest half in one pass so
      // eviction is amortised O(1) rather than per-insert.
      const drop = Math.ceil(tracked.size / 2)
      let i = 0
      for (const k of tracked.keys()) {
        if (i++ >= drop) break
        tracked.delete(k)
      }
    }
  }

  return function observeSentMessage(result: unknown, opts?: ObservedCallOpts): void {
    try {
      const sent = extractSentMessage(result, opts)
      if (sent == null) return
      const key = `${sent.chatId}:${sent.messageId}`
      const t = now()
      const seen = tracked.get(key)

      const kind = normalizeSendVerb(opts?.verb)
      if (sent.text.length === 0 && !isLegitimatelyBodiless(result)) {
        reportEmpty(sent.chatId, sent.messageId, kind, opts?.verb)
      }

      if (seen != null) {
        if (seen.lane === 'foreign') return
        // Never blank a body we already stored. A refresh whose text did not
        // reach us is missing information, not new information — overwriting
        // with `''` would destroy a usable quote-reply antecedent and hand the
        // agent the #4576 symptom on a row that was healthy a moment ago.
        if (sent.text.length === 0) return
        // The dual rule, and the one whose absence kept the #4576 symptom alive
        // on a row the alarm had already given up on: ALWAYS fill an EMPTY
        // stored body. A bodiless first observation (a media-only card, a
        // response we could not read) inserts `''` and starts the throttle
        // clock; the first REAL body then lands inside the 20s window and was
        // dropped, leaving the row permanently unusable as a quote-reply
        // antecedent. The throttle exists to cap SQLite writes on a card that
        // is already READABLE, so it only applies once something is stored.
        if (seen.storedLen > 0 && t - seen.lastStoredMs < editRefreshMs) return
        if (deps.updateText({ chat_id: sent.chatId, message_id: sent.messageId, text: sent.text })) {
          seen.lastStoredMs = t
          seen.storedLen = sent.text.length
        } else {
          // The row is gone (retention prune / delete) or was promoted to a
          // real `assistant` reply by recordOutbound. Either way this id is no
          // longer ours to write.
          seen.lane = 'foreign'
        }
        return
      }

      const inserted = deps.insert({
        chat_id: sent.chatId,
        thread_id: sent.threadId,
        message_id: sent.messageId,
        kind,
        text: sent.text,
      })
      if (inserted) {
        remember(key, { lane: 'system', lastStoredMs: t, storedLen: sent.text.length })
        return
      }
      // A row already exists for this id and we did not create it in this
      // process: either a real reply / inbound (leave it alone), or a card this
      // gateway posted before a restart. One probing update disambiguates —
      // `updateText` only ever matches a `system` row. The probe WRITES, so an
      // empty body cannot be used to run it: skip, stay untracked, and let the
      // next observation of this id (which carries a body) do the probing.
      if (sent.text.length === 0) return
      const refreshed = deps.updateText({
        chat_id: sent.chatId,
        message_id: sent.messageId,
        text: sent.text,
      })
      remember(key, {
        lane: refreshed ? 'system' : 'foreign',
        lastStoredMs: t,
        storedLen: refreshed ? sent.text.length : 0,
      })
    } catch {
      /* observing a send must never break the send */
    }
  }
}
