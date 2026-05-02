/**
 * Fidelity-(c) fake Telegram Bot API for integration tests.
 *
 * Built on top of the simpler `bot-api.harness.ts` (which uses plain
 * `vi.fn()` stubs). This module adds two things the simpler harness
 * doesn't have:
 *
 *   1. An in-memory "chat model" — tracks sent message ids, pinned
 *      messages, reactions per (chat_id, thread_id). Lets tests assert
 *      the full outbound state, not just the most recent call.
 *
 *   2. A fault-injection DSL that produces REAL `GrammyError` shapes
 *      (error_code, description, parameters.retry_after). `robustApiCall`
 *      checks `err instanceof GrammyError`, so throwing anything else
 *      would miss the production retry/fallback branches entirely —
 *      which is why the existing harness couldn't test flood-wait or
 *      "message to edit not found" behaviour.
 *
 * Existing tests using `createMockBot()` keep working; new tests that
 * need realistic error paths use `createFakeBotApi()`.
 */

import { GrammyError } from 'grammy'
import { vi, beforeEach } from 'vitest'

export interface SentMessage {
  readonly message_id: number
  readonly chat_id: string
  readonly text: string
  readonly parse_mode?: string
  readonly reply_to_message_id?: number
  readonly message_thread_id?: number
  readonly disable_notification?: boolean
}

export interface PinnedRef {
  readonly chat_id: string
  readonly message_id: number
}

export interface ReactionRef {
  readonly chat_id: string
  readonly message_id: number
  readonly reactions: ReadonlyArray<unknown>
}

export interface ChatModel {
  /** Every sendMessage call, oldest first. */
  readonly sent: ReadonlyArray<SentMessage>
  /** Latest text per message_id (reflects edits). */
  readonly currentText: ReadonlyMap<number, string>
  /** Pinned messages. Unpin removes. */
  readonly pinned: ReadonlyArray<PinnedRef>
  /** Reactions set per message. Later calls overwrite earlier. */
  readonly reactions: ReadonlyArray<ReactionRef>
  /** Deleted message ids. */
  readonly deleted: ReadonlySet<number>
}

export interface FaultQueueEntry {
  method: string
  chat_id?: string
  error: unknown
}

export interface FaultInjector {
  /**
   * Next call matching `method` (optionally also matching chat_id) will
   * throw `error`. Consumed after one hit. FIFO across multiple queued
   * faults for the same method.
   */
  next(method: string, error: unknown, chat_id?: string): void
  /** Clear all queued faults. */
  reset(): void
}

export interface HoldHandle {
  /** Resolve the held call so it completes its normal mutation + return. */
  release(): void
  /** Reject the held call with `error` instead of letting it complete. */
  fail(error: unknown): void
  /** Whether the held call has been entered (the API method awaited the gate). */
  triggered(): boolean
}

/**
 * Hold queue entry — when a matching call hits, it `await`s `gate`
 * before doing its normal work. `release()` resolves the gate;
 * `fail(err)` rejects it. The handle's `triggered` flag flips true
 * once the production call enters the await — useful for tests to
 * confirm "yes, the in-flight call is parked here, now I can fire the
 * other event."
 */
interface HoldQueueEntry {
  method: string
  chat_id?: string
  gate: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
  setTriggered: () => void
}

/**
 * Build a `GrammyError` with realistic payload — grammy's own
 * constructor needs `(message, ApiError, method, payload)`.
 */
export function makeGrammyError(opts: {
  error_code: number
  description: string
  method: string
  retry_after?: number
  migrate_to_chat_id?: number
  payload?: Record<string, unknown>
}): GrammyError {
  const parameters: Record<string, unknown> = {}
  if (opts.retry_after != null) parameters.retry_after = opts.retry_after
  if (opts.migrate_to_chat_id != null) parameters.migrate_to_chat_id = opts.migrate_to_chat_id
  return new GrammyError(
    `Call to '${opts.method}' failed! (${opts.error_code}: ${opts.description})`,
    {
      ok: false,
      error_code: opts.error_code,
      description: opts.description,
      parameters: parameters as GrammyError['parameters'],
    },
    opts.method,
    opts.payload ?? {},
  )
}

/** Pre-built error factories for the cases production code actually handles. */
export const errors = {
  floodWait(retry_after = 5, method = 'sendMessage'): GrammyError {
    return makeGrammyError({
      error_code: 429,
      description: 'Too Many Requests: retry after ' + retry_after,
      method,
      retry_after,
    })
  },
  notModified(method = 'editMessageText'): GrammyError {
    return makeGrammyError({
      error_code: 400,
      description: 'Bad Request: message is not modified',
      method,
    })
  },
  messageToEditNotFound(method = 'editMessageText'): GrammyError {
    return makeGrammyError({
      error_code: 400,
      description: 'Bad Request: message to edit not found',
      method,
    })
  },
  messageToDeleteNotFound(): GrammyError {
    return makeGrammyError({
      error_code: 400,
      description: 'Bad Request: message to delete not found',
      method: 'deleteMessage',
    })
  },
  threadNotFound(method = 'sendMessage'): GrammyError {
    return makeGrammyError({
      error_code: 400,
      description: 'Bad Request: message thread not found',
      method,
    })
  },
  forbidden(method = 'sendMessage'): GrammyError {
    return makeGrammyError({
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
      method,
    })
  },
  badRequest(description: string, method = 'sendMessage'): GrammyError {
    return makeGrammyError({ error_code: 400, description: 'Bad Request: ' + description, method })
  },
  /** Simulate a network-level fetch failure (grammy wraps these differently). */
  networkError(reason = 'ECONNRESET'): Error {
    return new Error('fetch failed: ' + reason)
  },
}

export interface FakeBotApi {
  sendMessage: ReturnType<typeof vi.fn>
  editMessageText: ReturnType<typeof vi.fn>
  deleteMessage: ReturnType<typeof vi.fn>
  setMessageReaction: ReturnType<typeof vi.fn>
  editMessageReplyMarkup: ReturnType<typeof vi.fn>
  sendChatAction: ReturnType<typeof vi.fn>
  pinChatMessage: ReturnType<typeof vi.fn>
  unpinChatMessage: ReturnType<typeof vi.fn>
  getFile: ReturnType<typeof vi.fn>
  getMe: ReturnType<typeof vi.fn>
  setMyCommands: ReturnType<typeof vi.fn>
  forwardMessage: ReturnType<typeof vi.fn>
  getChat: ReturnType<typeof vi.fn>
  sendDocument: ReturnType<typeof vi.fn>
  sendPhoto: ReturnType<typeof vi.fn>
  answerCallbackQuery: ReturnType<typeof vi.fn>
}

export interface FakeBot {
  api: FakeBotApi
  state: ChatModel
  faults: FaultInjector
  /** Force the next message_id to a specific value. */
  setNextMessageId(n: number): void
  /** Snapshot the messages that landed in a chat (oldest first). */
  messagesIn(chat_id: string): ReadonlyArray<SentMessage>
  /** Current visible text of message_id, or null if deleted/unknown. */
  textOf(message_id: number): string | null
  /** Is a given message currently pinned? */
  isPinned(chat_id: string, message_id: number): boolean
  /**
   * Hold the next matching call in-flight. Returns a handle whose
   * `release()` lets the call complete. Used to assert ordering between
   * an in-flight outbound and an unrelated inbound event without timer
   * fragility — e.g. "👍 must NOT fire while editMessageText is still
   * pending." See HARNESS.md Pattern 7.
   *
   * FIFO across multiple holds for the same method. Hold matches before
   * fault matches, so combining the two yields surprising results —
   * pick one per call.
   */
  holdNext(method: string, chat_id?: string): HoldHandle
  /** Reset all state, fault queue, and hold queue. */
  reset(): void
}

/**
 * Parse-mode validation strictness. Real Telegram returns 400 on
 * unbalanced MarkdownV2/HTML entities; the fake accepts everything by
 * default to preserve back-compat with all existing tests. Tests that
 * want catch-malformed-markdown coverage opt in via 'lenient' (catches
 * the common imbalances) or 'strict' (reserved for future stricter
 * checks).
 */
export type ParseModeValidation = 'off' | 'lenient' | 'strict'

export interface CreateFakeBotApiOpts {
  startMessageId?: number
  /**
   * If 'lenient' or 'strict', sendMessage/editMessageText with
   * `parse_mode: 'MarkdownV2'` reject unbalanced markers (`*`, `_`,
   * `` ` ``, `[`, `]`). Default 'off'. See parseModeBalanced.
   */
  validateParseMode?: ParseModeValidation
}

/**
 * Create a fake bot. The `api` methods apply fault-injection first
 * (if a fault is queued for this method + chat), then mutate the in-memory
 * chat model, then return the shape grammy would return.
 *
 * This gives tests three orthogonal observations:
 *   - `fake.state` — did the outbound message model converge to what we expect?
 *   - `fake.api.sendMessage.mock.calls` — exactly which call sequence fired?
 *   - `fake.faults.next(...)` — "the Telegram API happens to fail this way now".
 *   - `fake.holdNext(...)` — "park this call mid-flight while I fire something else".
 */
export function createFakeBotApi(opts: CreateFakeBotApiOpts = {}): FakeBot {
  let nextMessageId = opts.startMessageId ?? 500
  const validateParseMode: ParseModeValidation = opts.validateParseMode ?? 'off'

  const sent: SentMessage[] = []
  const currentText = new Map<number, string>()
  const pinned: PinnedRef[] = []
  const reactions: ReactionRef[] = []
  const deleted = new Set<number>()

  // Keyed `${method}` or `${method}|${chat_id}` → queue (FIFO). When a
  // request comes in, we try the chat-scoped queue first, then the
  // method-wide queue.
  const faultQueue: FaultQueueEntry[] = []
  const holdQueue: HoldQueueEntry[] = []
  // Holds that have matched a call and are awaiting `release()` or
  // `fail()`. Tracked separately so `reset()` can reject any in-flight
  // holds left dangling by a forgotten cleanup.
  const triggeredHolds = new Set<HoldQueueEntry>()

  function pullFault(method: string, chat_id: string | undefined): unknown | null {
    // Chat-scoped match first
    for (let i = 0; i < faultQueue.length; i++) {
      const f = faultQueue[i]
      if (f.method === method && f.chat_id != null && f.chat_id === chat_id) {
        faultQueue.splice(i, 1)
        return f.error
      }
    }
    // Then method-wide match
    for (let i = 0; i < faultQueue.length; i++) {
      const f = faultQueue[i]
      if (f.method === method && f.chat_id == null) {
        faultQueue.splice(i, 1)
        return f.error
      }
    }
    return null
  }

  function pullHold(method: string, chat_id: string | undefined): HoldQueueEntry | null {
    for (let i = 0; i < holdQueue.length; i++) {
      const h = holdQueue[i]
      if (h.method === method && h.chat_id != null && h.chat_id === chat_id) {
        holdQueue.splice(i, 1)
        return h
      }
    }
    for (let i = 0; i < holdQueue.length; i++) {
      const h = holdQueue[i]
      if (h.method === method && h.chat_id == null) {
        holdQueue.splice(i, 1)
        return h
      }
    }
    return null
  }

  function maybeThrow(method: string, chat_id: string | undefined): void {
    const err = pullFault(method, chat_id)
    if (err != null) throw err
  }

  /**
   * Common entry for any API method: pull a fault (throw), then await
   * a hold gate (if matched). Order matters — fault checks happen
   * before the hold so a queued fault still fires synchronously the
   * way real grammy errors do, and tests that hold + fault don't
   * accidentally trigger both.
   */
  async function applyEntryGates(method: string, chat_id: string | undefined): Promise<void> {
    maybeThrow(method, chat_id)
    const hold = pullHold(method, chat_id)
    if (hold != null) {
      hold.setTriggered()
      triggeredHolds.add(hold)
      try {
        await hold.gate
      } finally {
        triggeredHolds.delete(hold)
      }
    }
  }

  function checkParseMode(method: string, text: string, parse_mode: string | undefined): void {
    if (validateParseMode === 'off') return
    if (parse_mode !== 'MarkdownV2') return
    const issue = parseModeBalanced(text)
    if (issue == null) return
    throw makeGrammyError({
      error_code: 400,
      description: `Bad Request: can't parse entities: ${issue}`,
      method,
    })
  }

  const api: FakeBotApi = {
    sendMessage: vi.fn(async (chat_id: string, text: string, opts?: Record<string, unknown>) => {
      await applyEntryGates('sendMessage', chat_id)
      checkParseMode('sendMessage', text, opts?.parse_mode as string | undefined)
      const message_id = nextMessageId++
      const record: SentMessage = {
        message_id,
        chat_id,
        text,
        parse_mode: opts?.parse_mode as string | undefined,
        reply_to_message_id: opts?.reply_to_message_id as number | undefined,
        message_thread_id: opts?.message_thread_id as number | undefined,
        disable_notification: opts?.disable_notification as boolean | undefined,
      }
      sent.push(record)
      currentText.set(message_id, text)
      return { message_id, chat: { id: chat_id }, date: Math.floor(Date.now() / 1000), text }
    }),

    editMessageText: vi.fn(
      async (chat_id: string, message_id: number, text: string, opts?: Record<string, unknown>) => {
        await applyEntryGates('editMessageText', chat_id)
        checkParseMode('editMessageText', text, opts?.parse_mode as string | undefined)
        if (deleted.has(message_id) || !currentText.has(message_id)) {
          // Simulate Telegram's real 400 when the target is gone.
          throw errors.messageToEditNotFound()
        }
        const prev = currentText.get(message_id)
        if (prev === text) {
          throw errors.notModified()
        }
        currentText.set(message_id, text)
        return true
      },
    ),

    deleteMessage: vi.fn(async (chat_id: string, message_id: number) => {
      await applyEntryGates('deleteMessage', chat_id)
      if (deleted.has(message_id) || !currentText.has(message_id)) {
        throw errors.messageToDeleteNotFound()
      }
      deleted.add(message_id)
      currentText.delete(message_id)
      // Also drop any pin referencing it.
      for (let i = pinned.length - 1; i >= 0; i--) {
        if (pinned[i].message_id === message_id) pinned.splice(i, 1)
      }
      return true as const
    }),

    setMessageReaction: vi.fn(
      async (chat_id: string, message_id: number, react: unknown) => {
        await applyEntryGates('setMessageReaction', chat_id)
        // Overwrite existing
        const idx = reactions.findIndex(
          (r) => r.chat_id === chat_id && r.message_id === message_id,
        )
        const entry: ReactionRef = { chat_id, message_id, reactions: react as ReadonlyArray<unknown> }
        if (idx >= 0) reactions[idx] = entry
        else reactions.push(entry)
        return true as const
      },
    ),

    editMessageReplyMarkup: vi.fn(
      async (chat_id: string, _message_id: number, _opts?: unknown) => {
        await applyEntryGates('editMessageReplyMarkup', chat_id)
        return true as const
      },
    ),

    sendChatAction: vi.fn(async (chat_id: string, _action: string) => {
      await applyEntryGates('sendChatAction', chat_id)
      return true as const
    }),

    pinChatMessage: vi.fn(async (chat_id: string, message_id: number, _opts?: unknown) => {
      await applyEntryGates('pinChatMessage', chat_id)
      pinned.push({ chat_id, message_id })
      return true as const
    }),

    unpinChatMessage: vi.fn(async (chat_id: string, message_id: number) => {
      await applyEntryGates('unpinChatMessage', chat_id)
      const idx = pinned.findIndex((p) => p.chat_id === chat_id && p.message_id === message_id)
      if (idx >= 0) pinned.splice(idx, 1)
      return true as const
    }),

    getFile: vi.fn(async (file_id: string) => {
      await applyEntryGates('getFile', undefined)
      return { file_id, file_unique_id: 'uniq-' + file_id, file_size: 1024, file_path: 'documents/file.bin' }
    }),

    getMe: vi.fn(async () => {
      await applyEntryGates('getMe', undefined)
      return { id: 999, is_bot: true, first_name: 'TestBot', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }
    }),

    setMyCommands: vi.fn(async () => true as const),

    forwardMessage: vi.fn(async (chat_id: string) => {
      await applyEntryGates('forwardMessage', chat_id)
      const message_id = nextMessageId++
      return { message_id, chat: { id: chat_id }, date: Math.floor(Date.now() / 1000) }
    }),

    getChat: vi.fn(async (chat_id: string) => {
      await applyEntryGates('getChat', String(chat_id))
      return { id: chat_id, type: 'supergroup' as const, is_forum: true }
    }),

    sendDocument: vi.fn(async (chat_id: string) => {
      await applyEntryGates('sendDocument', chat_id)
      const message_id = nextMessageId++
      sent.push({ message_id, chat_id, text: '' })
      currentText.set(message_id, '')
      return { message_id, chat: { id: chat_id }, date: Math.floor(Date.now() / 1000) }
    }),

    sendPhoto: vi.fn(async (chat_id: string, _photo: unknown, opts?: Record<string, unknown>) => {
      await applyEntryGates('sendPhoto', chat_id)
      const message_id = nextMessageId++
      const caption = (opts?.caption as string | undefined) ?? ''
      sent.push({ message_id, chat_id, text: caption })
      currentText.set(message_id, caption)
      return { message_id, chat: { id: chat_id }, date: Math.floor(Date.now() / 1000) }
    }),

    answerCallbackQuery: vi.fn(async (_id: string, _opts?: unknown) => true as const),
  }

  const faults: FaultInjector = {
    next(method, error, chat_id) {
      faultQueue.push({ method, error, chat_id })
    },
    reset() {
      faultQueue.length = 0
    },
  }

  function holdNext(method: string, chat_id?: string): HoldHandle {
    let resolve!: () => void
    let reject!: (err: unknown) => void
    const gate = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    let triggered = false
    const entry: HoldQueueEntry = {
      method,
      chat_id,
      gate,
      resolve,
      reject,
      setTriggered: () => {
        triggered = true
      },
    }
    holdQueue.push(entry)
    return {
      release: () => entry.resolve(),
      fail: (err) => entry.reject(err),
      triggered: () => triggered,
    }
  }

  const bot: FakeBot = {
    api,
    state: {
      get sent() { return sent },
      get currentText() { return currentText },
      get pinned() { return pinned },
      get reactions() { return reactions },
      get deleted() { return deleted },
    } as ChatModel,
    faults,
    setNextMessageId(n) { nextMessageId = n },
    messagesIn(chat_id) { return sent.filter((s) => s.chat_id === chat_id) },
    textOf(message_id) { return currentText.get(message_id) ?? null },
    isPinned(chat_id, message_id) {
      return pinned.some((p) => p.chat_id === chat_id && p.message_id === message_id)
    },
    holdNext,
    reset() {
      sent.length = 0
      currentText.clear()
      pinned.length = 0
      reactions.length = 0
      deleted.clear()
      faultQueue.length = 0
      // Drain any unreleased holds — letting them survive a reset would
      // cause a later test to inherit a "stuck" call. Reject both
      // queued (never matched) and triggered (matched, awaiting
      // release) holds so any dangling awaits surface as test
      // failures, not silent hangs.
      for (const h of holdQueue) h.reject(new Error('fake-bot reset() called while hold pending'))
      holdQueue.length = 0
      for (const h of triggeredHolds) h.reject(new Error('fake-bot reset() called while hold in flight'))
      triggeredHolds.clear()
      nextMessageId = opts.startMessageId ?? 500
      for (const fn of Object.values(api)) (fn as ReturnType<typeof vi.fn>).mockClear()
    },
  }

  return bot
}

/**
 * Install a `beforeEach` that resets the bot between tests.
 * Call once at the top of a describe() block.
 */
export function installFakeBotResetHook(bot: FakeBot): void {
  beforeEach(() => bot.reset())
}

/**
 * Lenient MarkdownV2 balance check. Returns null if the text looks
 * balanced; returns a one-line description if it doesn't. Used by
 * `validateParseMode: 'lenient'` to mimic Telegram's
 * `can't parse entities` 400.
 *
 * Not a real parser — just checks the count of unescaped marker
 * characters. Telegram's full grammar is more complex (nested entities,
 * the e2e parser at https://core.telegram.org/bots/api#markdownv2-style),
 * but unbalanced counts catch the most common mistakes (forgetting to
 * close a `*` after a token break in a streamed message).
 *
 * Markers checked: `*`, `_`, `` ` ``, `[` / `]`. Backslash-escaped
 * markers (`\*`) are ignored. Triple-backtick code blocks are
 * collapsed first (their inner content is exempt from emphasis rules).
 */
export function parseModeBalanced(text: string): string | null {
  // Strip code blocks (```...```) — content inside is verbatim.
  const stripped = text.replace(/```[\s\S]*?```/g, '')
  // Strip inline code (`...`) — also verbatim.
  const stripped2 = stripped.replace(/`[^`\n]*`/g, '')
  // Strip backslash-escaped chars.
  const stripped3 = stripped2.replace(/\\[*_`\[\]()~>#+\-=|{}.!\\]/g, '')

  const counts: Record<string, number> = { '*': 0, _: 0 }
  let bracketDepth = 0
  for (const ch of stripped3) {
    if (ch === '*' || ch === '_') counts[ch]++
    else if (ch === '[') bracketDepth++
    else if (ch === ']') {
      bracketDepth--
      if (bracketDepth < 0) return "unbalanced ']' bracket"
    }
  }
  if (counts['*'] % 2 !== 0) return "unbalanced '*' (bold marker)"
  if (counts['_'] % 2 !== 0) return "unbalanced '_' (italic marker)"
  if (bracketDepth !== 0) return "unbalanced '[' bracket"
  // Backticks: count remaining (unstripped) — should be 0 after the
  // inline-code strip above.
  const tickCount = (stripped3.match(/`/g) ?? []).length
  if (tickCount !== 0) return 'unbalanced backtick'
  return null
}
