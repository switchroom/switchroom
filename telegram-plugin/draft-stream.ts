/**
 * Edit-in-place streaming for Telegram messages.
 *
 * Ports the throttle/flush pattern from openclaw's
 * src/channels/draft-stream-loop.ts. The loop holds a single `pendingText`
 * snapshot (NOT a queue — only the latest matters) plus a single in-flight
 * promise. update(text) either fires immediately if the throttle window
 * is open, or schedules a setTimeout for the remaining ms. When the
 * in-flight call resolves, if pendingText changed during flight it loops
 * once more without waiting.
 *
 * This is what makes the experience feel responsive without burning
 * Telegram's 1-edit-per-second-per-message rate limit. The latest delta
 * always lands within ~1s, with at most one outstanding API call.
 *
 * In our model-driven architecture (no inference hooks), the controller
 * is driven by the model calling stream_reply(text, done) multiple times
 * during a long task. First call → sendMessage (or sendMessageDraft in DMs).
 * Subsequent calls → throttled editMessageText (or sendMessageDraft). done=true
 * → flush, materialize as a fresh sendMessage (push notification), clear draft.
 *
 * Transport selection:
 *   - previewTransport: "auto" (default) — use draft in DMs only
 *   - previewTransport: "draft"           — always use draft (if API available)
 *   - previewTransport: "message"         — always use sendMessage/editMessageText
 *
 * Forum topics (message_thread_id set) force message transport because
 * sendMessageDraft does not support threads. The caller (stream-controller.ts)
 * handles this by passing previewTransport: "message" for threaded chats.
 */

import {
  shouldFallbackFromDraftTransport,
  allocateDraftId,
  isDraft429,
  extractDraft429RetryAfterSecs,
} from './draft-transport.js'

const TELEGRAM_MAX_CHARS = 4096
// PR B: transport-aware defaults.
//   Draft transport (DMs): 300 ms — drafts are ephemeral and don't share
//     editMessageText's per-message rate cap, so we can refresh much faster.
//     300 ms feels live without burning bandwidth.
//   Message transport (groups / forums / draft API absent): 1000 ms — must
//     respect Telegram's "1 edit/sec/message" practical ceiling.
// Both defaults can be overridden per-stream via `config.throttleMs` (which
// is itself wired from `channels.telegram.stream_throttle_ms` in the agent
// yaml, via the SWITCHROOM_TG_STREAM_THROTTLE_MS env var the gateway reads).
const DEFAULT_DRAFT_THROTTLE_MS = 300
const DEFAULT_MESSAGE_THROTTLE_MS = 1000
const MIN_THROTTLE_MS = 250

// PR C — sendMessageDraft 30-second ephemeral persist-chain.
//
// Telegram's sendMessageDraft preview expires after 30 seconds. Long
// LLM turns blow past that, leaving the user staring at a stale draft.
// To stay live for arbitrary-length turns: at ~25s of accumulated
// draft streaming (or when the unpersisted chunk approaches 4000 chars
// — the per-message length cap with safety margin), fire a real
// sendMessage with the current chunk. This persists what the user has
// seen so far as a real message (with push notification). Then we
// allocate a fresh draft_id and continue streaming the next chunk
// into a new ephemeral preview. The model still sees a single
// continuous turn; the user sees a CHAIN of persisted messages, each
// up to ~25s / ~4000 chars, separated by live previews.
//
// At done=true / finalize(), the LAST unpersisted chunk is fired via
// sendMessage so the final state of the response is durable.
//
// These triggers fire on top of the normal throttle loop — i.e., the
// persist boundary is checked just before each draft fire, not on a
// separate timer. This keeps the loop simple and avoids fighting with
// the in-flight promise.
const PERSIST_INTERVAL_MS = 25_000
const PERSIST_SAFETY_CHAR_LIMIT = 4000

/**
 * Send the first message in a stream. Receives the rendered text plus a
 * thread_id (forum topic) and returns the new Telegram message_id.
 */
export type StreamSendFn = (text: string) => Promise<number>

/**
 * Edit an existing stream message. Receives the message_id and rendered text.
 */
export type StreamEditFn = (messageId: number, text: string) => Promise<void>

/**
 * Optional sendMessageDraft callback. When present and the transport is
 * "draft", this is called instead of sendMessage/editMessageText.
 * Signature mirrors Telegram's sendMessageDraft Bot API method.
 */
export type StreamDraftFn = (
  chatId: string,
  draftId: number,
  text: string,
  params?: { message_thread_id?: number },
) => Promise<unknown>

export interface DraftStreamConfig {
  /** Throttle window in ms. Floored at 250. Default 1000. */
  throttleMs?: number
  /**
   * Maximum total characters before hard-stopping the stream. Default 4096
   * (Telegram's limit). When exceeded, future updates are ignored — the
   * caller should fall back to a fresh sendMessage.
   */
  maxChars?: number
  /**
   * Optional debounce window applied BEFORE the first send of a stream.
   * When > 0, the first update() defers the send by idleMs, restarting
   * the timer on each additional update that arrives during the window.
   * Useful when the caller bursts several update() calls at turn start
   * and you'd rather collapse them into a single send than pay the
   * latency of an immediate first-fire + follow-up edit.
   *
   * Default 0 (no pre-send debounce — first update fires immediately).
   * Only affects the first send; subsequent edits use throttleMs.
   *
   * NOTE: This debounce only applies to message transport. Draft transport
   * fires immediately on the first update because drafts are ephemeral —
   * the throttle/flush loop already collapses bursts into 1 API call/sec
   * via throttleMs.
   */
  idleMs?: number
  /**
   * Transport selector.
   * - "auto" (default): use draft transport when isPrivateChat=true AND
   *   sendMessageDraft is provided; otherwise use message transport.
   * - "draft": always prefer draft (falls back to message if sendMessageDraft absent).
   * - "message": always use sendMessage/editMessageText.
   */
  previewTransport?: 'auto' | 'message' | 'draft'
  /**
   * True if the current chat is a private DM. Used by "auto" transport to
   * decide whether to activate draft. Has no effect when previewTransport
   * is "draft" or "message".
   */
  isPrivateChat?: boolean
  /**
   * sendMessageDraft callback. When absent, the stream falls back to
   * sendMessage/editMessageText regardless of previewTransport.
   */
  sendMessageDraft?: StreamDraftFn
  /**
   * The Telegram chat id string — required when sendMessageDraft is provided,
   * so the draft can be cleared on finalize.
   */
  chatId?: string
  /**
   * PR C — persist-chain interval override. Default 25_000 ms. Lower
   * for tests; production should leave default.
   */
  persistIntervalMs?: number
  /**
   * PR C — persist-chain size threshold override (chars). Default 4000.
   * Lower for tests so the size-trigger can fire on small text without
   * colliding with the 4096-char maxChars hard-stop.
   */
  persistSizeLimit?: number
  /** Optional logger for debugging. Receives one string per event. */
  log?: (msg: string) => void
  /** Optional warning logger. Used for transport fallback notices. */
  warn?: (msg: string) => void
  /**
   * If set, the stream is initialized as if a previous send had landed
   * with this `message_id` — the FIRST update() call invokes `edit`
   * against this id rather than `send`. Used by callers (notably the
   * gateway's progress-card emit) that know the anchor message id from
   * an external source (e.g. the pin manager) and want to guarantee a
   * subsequent emit edits in place rather than creating a fresh
   * sendMessage. This closes the "done=true → activeDraftStreams entry
   * deleted → next emit creates fresh sendMessage" duplicate-message
   * class (issue #626). The not-found fallback at the edit site
   * (line ~280: re-send on `MESSAGE_ID_INVALID`) gracefully handles a
   * stale id — the bad edit fails once, then a fresh send fires.
   */
  initialMessageId?: number | null
}

export interface DraftStreamHandle {
  /**
   * Push a new full-text snapshot. The loop holds only the latest. Returns
   * a promise that resolves once this update has either (a) been sent or
   * (b) been superseded by a later update.
   */
  update(text: string): Promise<void>

  /**
   * Mark the stream as final. Flushes any pending text and rejects all
   * future update() calls. Returns a promise that resolves once the final
   * edit has landed (or the initial send if no edits ever fired).
   */
  finalize(): Promise<void>

  /** Returns the captured Telegram message_id, or null if nothing has sent yet. */
  getMessageId(): number | null

  /** True if finalize() has been called. */
  isFinal(): boolean
}

/**
 * Create a draft stream bound to a specific Telegram chat+thread.
 *
 * The first update() call invokes `send` to create the message. All
 * subsequent calls invoke `edit` against the captured message_id.
 *
 * When sendMessageDraft is provided (and transport allows it), intermediate
 * updates use the draft API instead of sendMessage/editMessageText. On
 * finalize(), a real sendMessage is sent for push notification, then the
 * draft is cleared best-effort.
 */
export function createDraftStream(
  send: StreamSendFn,
  edit: StreamEditFn,
  config: DraftStreamConfig = {},
): DraftStreamHandle {
  // PR B: transport-aware default — the actual transport resolves a few
  // lines below, so we replicate the prefersDraft check here. An
  // explicit `config.throttleMs` (from the operator yaml or the
  // caller) wins.
  const _willPreferDraft =
    (config.previewTransport ?? 'auto') === 'draft' ||
    ((config.previewTransport ?? 'auto') === 'auto' && config.isPrivateChat === true)
  const _defaultForTransport = _willPreferDraft && config.sendMessageDraft != null
    ? DEFAULT_DRAFT_THROTTLE_MS
    : DEFAULT_MESSAGE_THROTTLE_MS
  const throttleMs = Math.max(MIN_THROTTLE_MS, config.throttleMs ?? _defaultForTransport)
  // PR C: persist-chain config overrides (testability — production
  // leaves defaults at 25 s / 4000 chars).
  const persistIntervalMs = config.persistIntervalMs ?? PERSIST_INTERVAL_MS
  const persistSizeLimit = config.persistSizeLimit ?? PERSIST_SAFETY_CHAR_LIMIT
  const maxChars = config.maxChars ?? TELEGRAM_MAX_CHARS
  const idleMs = Math.max(0, config.idleMs ?? 0)
  const log = config.log
  const warn = config.warn
  const draftApi = config.sendMessageDraft
  const chatId = config.chatId ?? ''

  // Resolve transport
  const requestedTransport = config.previewTransport ?? 'auto'
  const prefersDraft =
    requestedTransport === 'draft'
      ? true
      : requestedTransport === 'message'
        ? false
        : (config.isPrivateChat === true) // 'auto': DM only

  // Footgun guard: caller asked for "auto" + provided sendMessageDraft but
  // forgot isPrivateChat. They almost certainly wanted draft in DMs but will
  // silently get message transport everywhere. Warn so the bug is visible.
  if (
    requestedTransport === 'auto'
    && draftApi != null
    && config.isPrivateChat === undefined
  ) {
    warn?.('draft-stream: previewTransport="auto" with sendMessageDraft but isPrivateChat undefined — defaulting to message transport')
  }

  // Use draft transport only if we have the API
  let usesDraftTransport = prefersDraft && draftApi != null
  let draftId: number | undefined = usesDraftTransport
    ? allocateDraftId()
    : undefined

  if (prefersDraft && !usesDraftTransport) {
    warn?.('draft-stream: sendMessageDraft unavailable; falling back to sendMessage/editMessageText')
  }

  // Stream-start trace — always-on, structured for grep + aggregation.
  // Resolves WHY the chosen transport landed (req=auto|draft|message;
  // dm=true|false|undef; api=available|absent). Gates the rest of the
  // sendMessageDraft alignment PR sequence: without this we can't tell
  // a draft-routing regression from a config-toggle change.
  // Kill switch: SWITCHROOM_STREAM_TRACES=0.
  if (process.env.SWITCHROOM_STREAM_TRACES !== '0') {
    const reason = usesDraftTransport
      ? 'draft'
      : requestedTransport === 'message'
        ? 'explicit-message'
        : requestedTransport === 'draft' && draftApi == null
          ? 'draft-requested-but-no-api'
          : !prefersDraft
            ? 'auto-non-dm'
            : 'fallback'
    const draftIdPart = draftId != null ? ` draftId=${draftId}` : ''
    process.stderr.write(
      `gw-trace stream-start transport=${usesDraftTransport ? 'draft' : 'message'} ` +
        `reason=${reason} req=${requestedTransport} ` +
        `dm=${config.isPrivateChat === undefined ? 'undef' : String(config.isPrivateChat)} ` +
        `api=${draftApi != null ? 'available' : 'absent'} ` +
        `throttleMs=${throttleMs}${draftIdPart} ` +
        `chatId=${chatId || '-'}\n`,
    )
  }

  let messageId: number | null = config.initialMessageId ?? null
  let pendingText: string | null = null
  let lastSentText: string | null = null
  let lastSentAt = 0
  let inFlight: Promise<void> | null = null
  // PR A observability — per-stream fire counters for the stream-end
  // trace. draftFires/editFires/sendFires let the aggregator distinguish
  // "stream used 80% draft + 20% edit fallback" vs "all edits, draft
  // never fired". `firstFireAtMs` is the latency from stream-start to
  // first wire send (matches TTFO sub-component for a single stream).
  const streamStartedAt = Date.now()
  let firstFireAtMs: number | null = null
  let draftFires = 0
  let editFires = 0
  let sendFires = 0
  let fallbackFires = 0
  // PR C — persist-chain state. `persistedTextLen` is the offset into
  // the full cumulative model text that has already been committed to
  // a real Telegram message via `sendMessage`. Subsequent draft fires
  // send only the slice from `persistedTextLen` onward (the
  // unpersisted tail). `currentChunkStartedAt` is when the CURRENT
  // chunk (since last persist boundary) started streaming — drives
  // the 25-second persist trigger. `persistChainFires` counts how
  // many chunks have been persisted in this stream (always 0 for
  // message-transport streams, only ticks for draft-transport).
  let persistedTextLen = 0
  let currentChunkStartedAt: number | null = null
  let persistChainFires = 0
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null
  let final = false
  let stopped = false

  // Tracks pending update() calls so caller can `await` the next flush
  const waiters: Array<() => void> = []

  function notifyWaiters(): void {
    const w = waiters.splice(0)
    for (const fn of w) {
      try {
        fn()
      } catch { /* ignore waiter errors */ }
    }
  }

  async function sendViaDraft(textToSend: string): Promise<boolean> {
    if (!draftApi || draftId == null) return false
    // PR C: draft sees only the unpersisted tail. If the model produced
    // text BEYOND what's already been committed to a real sendMessage,
    // that tail is what the user sees in the live preview. When the
    // tail is empty (model hasn't added anything new since persist),
    // there's nothing to draft — the draft was cleared at persist time.
    const draftText = textToSend.slice(persistedTextLen)
    if (draftText.length === 0) {
      // Treat as success — no work to do, dedup will skip on next call.
      return true
    }
    try {
      const result = await draftApi(chatId, draftId, draftText)
      // PR D: sendMessageDraft is documented to return `true` on success.
      // A non-true (or missing) return is a soft failure — Telegram
      // accepted the call but the draft didn't land. Fall back to
      // message transport for the rest of this stream so the user still
      // sees the content. This catches API surface changes + edge cases
      // not covered by `shouldFallbackFromDraftTransport`'s regex.
      if (result !== true && result !== undefined) {
        // Some grammY wrappers strip the bool and return undefined on
        // success; treat ONLY explicitly-falsy returns as failure to
        // avoid false-positive fallback. true / undefined → success.
        if (result === false || result === null) {
          warn?.(
            `draft-stream: sendMessageDraft returned non-true (${JSON.stringify(result)}) — falling back to message transport`,
          )
          fallbackFires++
          usesDraftTransport = false
          draftId = undefined
          return false
        }
      }
      if (firstFireAtMs == null) firstFireAtMs = Date.now() - streamStartedAt
      // Mark the start of THIS chunk's persist window on first fire of
      // each chunk (after the previous persist boundary).
      if (currentChunkStartedAt == null) currentChunkStartedAt = Date.now()
      draftFires++
      log?.(`stream → draft (id: ${draftId}, ${draftText.length} chars tail)`)
      return true
    } catch (err) {
      // PR D: dedicated 429 path. Telegram rate-limits sendMessageDraft
      // independently from sendMessage/editMessageText. On 429:
      //   - extract `retry_after`
      //   - fall back to message transport for the rest of this stream
      //   - bump `lastSentAt` so the throttle window absorbs the
      //     retry_after delay — prevents the message-transport
      //     fallback from immediately firing and getting 429'd too
      //     (Telegram's per-chat rate cap is shared across methods).
      const retryAfterSecs = extractDraft429RetryAfterSecs(err)
      if (retryAfterSecs != null && isDraft429(err)) {
        warn?.(
          `draft-stream: sendMessageDraft 429 (retry_after=${retryAfterSecs}s) — falling back to message transport + backoff`,
        )
        fallbackFires++
        usesDraftTransport = false
        draftId = undefined
        // Push lastSentAt forward so the NEXT flush waits at least
        // `retry_after` seconds before the message-transport send.
        // The throttle math at update() / schedule() compares
        // `Date.now() - lastSentAt >= throttleMs`, so by moving
        // lastSentAt forward we delay the next fire.
        lastSentAt = Date.now() + retryAfterSecs * 1000 - throttleMs
        return false
      }
      if (shouldFallbackFromDraftTransport(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        warn?.(`draft-stream: sendMessageDraft rejected — falling back to sendMessage/editMessageText (${msg})`)
        fallbackFires++
        usesDraftTransport = false
        draftId = undefined
        return false
      }
      throw err
    }
  }

  async function flush(): Promise<void> {
    if (stopped) {
      notifyWaiters()
      return
    }
    if (pendingText == null) {
      notifyWaiters()
      return
    }
    const textToSend = pendingText
    pendingText = null

    if (textToSend === lastSentText) {
      // Nothing actually changed — skip the API call but free waiters
      notifyWaiters()
      return
    }

    // PR C — persist-chain trigger check. Runs BEFORE the maxChars
    // hard-stop so we can chunk large outputs across multiple
    // sendMessage calls instead of dropping them. Only the draft
    // path needs this; message transport edits the same id forever
    // and the 4096-char cap is a real terminal stop there.
    //
    // The trigger fires when EITHER the current chunk has been
    // streaming for ≥25s OR the unpersisted tail is approaching the
    // 4000-char message length cap. On fire: send the chunk via
    // real sendMessage, bump persistedTextLen, allocate a fresh
    // draftId, reset the chunk window. The subsequent normal-flow
    // draft fire below sends only the (now-empty or post-persist) tail.
    if (usesDraftTransport && currentChunkStartedAt != null) {
      const elapsed = Date.now() - currentChunkStartedAt
      const tailLen = textToSend.length - persistedTextLen
      const sizeApproaching = tailLen >= persistSizeLimit
      const timeElapsed = elapsed >= persistIntervalMs
      if ((timeElapsed || sizeApproaching) && tailLen > 0) {
        const chunk = textToSend.slice(persistedTextLen)
        try {
          const newMsgId = await send(chunk)
          messageId = newMsgId
          persistedTextLen = textToSend.length
          draftId = allocateDraftId()
          currentChunkStartedAt = null
          persistChainFires++
          // PR follow-up: persist-chain's bare send() bypasses
          // sendViaMessage's increment, same shape as the finalize-
          // materialize bug. Without this, streams that cross the
          // 25s / 4000-char boundary would under-report `sends` by
          // the chain count in stream-end.
          sendFires++
          if (process.env.SWITCHROOM_STREAM_TRACES !== '0') {
            process.stderr.write(
              `gw-trace stream-persist chunk_chars=${chunk.length} ` +
                `elapsed=${elapsed} reason=${timeElapsed ? 'time' : 'size'} ` +
                `newMsgId=${newMsgId} newDraftId=${draftId} ` +
                `chatId=${chatId || '-'}\n`,
            )
          }
          log?.(`stream → persisted chunk (id: ${newMsgId}, ${chunk.length} chars, reason=${timeElapsed ? 'time' : 'size'})`)
        } catch (err) {
          // Persist failed — log and continue. The next flush re-
          // evaluates the trigger and re-fires.
          //
          // Edge case (accepted as v1 ceiling): if `send(chunk)`
          // actually LANDED on Telegram but the response/ack was lost
          // (network blip), the retry will double-persist — the user
          // sees the same chunk twice as two separate sendMessages.
          // Telegram doesn't expose a sendMessage idempotency key. The
          // user-visible artifact is "duplicate chunk", not data loss,
          // and observed rate of lost-ACK is rare. PR D follow-up
          // could add a per-chunk hash dedup on retry.
          warn?.(
            `draft-stream: persist sendMessage failed — chunk stays in draft (${err instanceof Error ? err.message : String(err)})`,
          )
        }
      }
    }

    // Edge case: if the model RETRACTS cumulative text (rare — most
    // LLM streams are strict-extension), `textToSend.length` may be
    // less than `persistedTextLen`. `slice(persistedTextLen)` returns
    // "" and the persist trigger's `tailLen > 0` guard short-circuits,
    // so we silently skip. The live preview goes stale until the model
    // re-extends past `persistedTextLen`. No crash, no double-send.
    // Tolerated as the failure mode is benign and the cause is upstream.

    // Hard-stop check — applies to the sendable size (full text for
    // message transport, post-persist tail for draft transport). After
    // a successful persist, the tail resets so this won't fire even
    // for huge cumulative texts in the draft path.
    const sendableLen = usesDraftTransport
      ? textToSend.length - persistedTextLen
      : textToSend.length
    if (sendableLen > maxChars) {
      log?.(`stream stopped: ${usesDraftTransport ? 'tail' : 'text'} exceeds ${maxChars} chars`)
      stopped = true
      notifyWaiters()
      return
    }

    try {
      if (usesDraftTransport) {
        const ok = await sendViaDraft(textToSend)
        if (!ok) {
          // Draft failed with a permanent error → fell back to message transport.
          // Replay this text via message transport.
          await sendViaMessage(textToSend)
        }
      } else {
        await sendViaMessage(textToSend)
      }
      lastSentText = textToSend
      lastSentAt = Date.now()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if (/\bmessage is not modified\b/i.test(msg)) {
        lastSentText = textToSend
        lastSentAt = Date.now()
        log?.(`stream → not modified (id: ${messageId})`)
      } else if (
        /\bmessage to edit not found\b/i.test(msg)
        || /\bMESSAGE_ID_INVALID\b/i.test(msg)
      ) {
        log?.(`stream → message not found (id: ${messageId}), re-sending`)
        messageId = null
        lastSentText = null
        if (pendingText == null) pendingText = textToSend
      } else {
        log?.(`stream → edit failed: ${msg}`)
      }
    }

    notifyWaiters()
  }

  async function sendViaMessage(textToSend: string): Promise<void> {
    if (messageId == null) {
      messageId = await send(textToSend)
      if (firstFireAtMs == null) firstFireAtMs = Date.now() - streamStartedAt
      sendFires++
      log?.(`stream → sent (id: ${messageId}, ${textToSend.length} chars)`)
    } else {
      await edit(messageId, textToSend)
      if (firstFireAtMs == null) firstFireAtMs = Date.now() - streamStartedAt
      editFires++
      log?.(`stream → edited (id: ${messageId}, ${textToSend.length} chars)`)
    }
  }

  async function flushLoop(): Promise<void> {
    // Drain any updates that arrived during the in-flight call.
    while (pendingText != null && !stopped) {
      await flush()
    }
  }

  function schedule(): void {
    if (scheduledTimer != null) return
    if (stopped) return
    const sinceLast = Date.now() - lastSentAt
    const delay = Math.max(0, throttleMs - sinceLast)
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null
      if (inFlight) {
        // The in-flight loop will pick up pendingText after it resolves.
        return
      }
      inFlight = flushLoop().finally(() => {
        inFlight = null
      })
    }, delay)
  }

  return {
    update(text: string): Promise<void> {
      if (final || stopped) return Promise.resolve()
      pendingText = text
      const waitPromise = new Promise<void>(resolve => {
        waiters.push(resolve)
      })

      // Pre-send idle debounce: for the FIRST send of a stream, optionally
      // defer by idleMs so a burst of update() calls collapses into one
      // send. Each incoming update resets the timer. Once the initial
      // send has landed (messageId != null OR draft has fired), this path
      // is skipped and the regular throttle kicks in.
      if (idleMs > 0 && messageId == null && !usesDraftTransport && inFlight == null) {
        if (scheduledTimer != null) clearTimeout(scheduledTimer)
        scheduledTimer = setTimeout(() => {
          scheduledTimer = null
          inFlight = flushLoop().finally(() => { inFlight = null })
        }, idleMs)
        return waitPromise
      }

      // If nothing in flight and the throttle window is open, fire now.
      if (inFlight == null && Date.now() - lastSentAt >= throttleMs) {
        inFlight = flushLoop().finally(() => {
          inFlight = null
        })
      } else if (inFlight == null) {
        schedule()
      } else {
        // inFlight is set — the current flushLoop is running. Previous
        // versions of this code relied on flushLoop's while(pendingText
        // != null) to pick up the new text, but there's a race: if
        // update() fires AFTER the while's final (null) check but
        // BEFORE the flushLoop promise settles, the new pendingText
        // lands in a shell with no one looking at it, and the waiter
        // hangs forever. Chain a follow-up flush off the current
        // flushLoop so the new text is guaranteed to be drained.
        inFlight.then(() => {
          if (stopped || pendingText == null) return
          if (inFlight != null) return // a new flushLoop already started
          if (Date.now() - lastSentAt >= throttleMs) {
            inFlight = flushLoop().finally(() => { inFlight = null })
          } else {
            schedule()
          }
        })
      }
      return waitPromise
    },

    async finalize(): Promise<void> {
      if (final) return
      final = true
      // Drain any pending updates
      if (scheduledTimer != null) {
        clearTimeout(scheduledTimer)
        scheduledTimer = null
      }
      if (inFlight) {
        await inFlight
      }
      if (pendingText != null && !stopped) {
        await flush()
      }

      // Draft transport: materialize as a real sendMessage for push
      // notification, then clear the draft best-effort.
      //
      // PR C: with the persist-chain in play, earlier chunks may
      // already be persisted as their own sendMessages. We materialize
      // ONLY the unpersisted tail here — otherwise the user gets a
      // duplicate of the prior chunks at turn end.
      if (usesDraftTransport && draftApi != null) {
        const fullText = lastSentText ?? ''
        const textToMaterialize = fullText.slice(persistedTextLen)
        if (textToMaterialize.length > 0) {
          try {
            messageId = await send(textToMaterialize)
            persistedTextLen = fullText.length
            // PR follow-up: bump sendFires so the stream-end trace
            // reflects the finalize-materialize sendMessage call. Pre-
            // this fix, the counter under-reported by 1 for every
            // draft-transport stream that produced a non-empty reply:
            // gw-trace stream-end showed `drafts=N sends=0` even
            // though sendMessage HAD fired (visible in tg-post lines).
            sendFires++
            log?.(`stream → materialized tail (id: ${messageId}, ${textToMaterialize.length} chars)`)
          } catch (err) {
            warn?.(`draft-stream: materialize sendMessage failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          // Clear draft best-effort (cosmetic — Telegram input area cleanup)
          if (draftId != null) {
            try {
              await draftApi(chatId, draftId, '')
            } catch {
              // Best-effort — ignore failures
            }
          }
        } else if (draftId != null) {
          // Whole text already persisted via the chain — just clear the
          // current draft so the input area isn't left with stale
          // preview content.
          try {
            await draftApi(chatId, draftId, '')
          } catch {
            // Best-effort — ignore
          }
        }
      }

      log?.(`stream finalized (id: ${messageId})`)

      // Stream-end trace — pairs with stream-start. `drafts`/`edits`/
      // `sends` lets the aggregator see the transport ratio per stream;
      // `firstFireMs` is the per-stream send latency component of TTFO;
      // `chars` is the final committed text length.
      if (process.env.SWITCHROOM_STREAM_TRACES !== '0') {
        const durationMs = Date.now() - streamStartedAt
        process.stderr.write(
          `gw-trace stream-end transport=${usesDraftTransport ? 'draft' : 'message'} ` +
            `drafts=${draftFires} sends=${sendFires} edits=${editFires} ` +
            `fallbacks=${fallbackFires} persists=${persistChainFires} ` +
            `firstFireMs=${firstFireAtMs ?? -1} durationMs=${durationMs} ` +
            `chars=${(lastSentText ?? '').length} ` +
            `chatId=${chatId || '-'}\n`,
        )
      }
    },

    getMessageId(): number | null {
      return messageId
    },

    isFinal(): boolean {
      return final
    },
  }
}
