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
 * The observer reads the Telegram RESPONSE, not the request, which buys three
 * things for free:
 *   - the real `message_id` (the only thing a reply can point at),
 *   - the chat and forum-topic the message actually landed in,
 *   - the RENDERED text, which for a card is otherwise unrecoverable (it is
 *     composed from live tool activity and never persisted anywhere).
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

/** The subset of a Telegram `Message` response this observer reads. */
export interface SentMessageLike {
  message_id?: unknown
  chat?: { id?: unknown } | null
  message_thread_id?: unknown
  text?: unknown
  caption?: unknown
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
 * all. Pure.
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
    typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : ''
  return { chatId, messageId: id, threadId, text }
}

/** Per-id bookkeeping. `foreign` = the id belongs to a non-system row (a real
 *  reply or an inbound); never write to it again. */
type TrackedState = { lane: 'system' | 'foreign'; lastStoredMs: number }

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

      if (seen != null) {
        if (seen.lane === 'foreign') return
        if (t - seen.lastStoredMs < editRefreshMs) return
        if (deps.updateText({ chat_id: sent.chatId, message_id: sent.messageId, text: sent.text })) {
          seen.lastStoredMs = t
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
        kind: normalizeSendVerb(opts?.verb),
        text: sent.text,
      })
      if (inserted) {
        remember(key, { lane: 'system', lastStoredMs: t })
        return
      }
      // A row already exists for this id and we did not create it in this
      // process: either a real reply / inbound (leave it alone), or a card this
      // gateway posted before a restart. One probing update disambiguates —
      // `updateText` only ever matches a `system` row.
      const refreshed = deps.updateText({
        chat_id: sent.chatId,
        message_id: sent.messageId,
        text: sent.text,
      })
      remember(key, { lane: refreshed ? 'system' : 'foreign', lastStoredMs: t })
    } catch {
      /* observing a send must never break the send */
    }
  }
}
