/**
 * Thin integration layer between `createDraftStream` and grammy's `bot.api`.
 *
 * Deduplicates the send/edit closure wiring that previously lived inline in
 * two places in server.ts:
 *   - the `stream_reply` MCP case block (model-driven streaming)
 *   - `handlePtyPartial` (PTY-tail TUI extractor → live preview)
 *
 * Both paths do the same thing: given a chat/thread, create a draft stream
 * whose `send` closure first calls `bot.api.sendRichMessage` and whose
 * `edit` closure calls `bot.api.editMessageText({ markdown })`, both wrapped
 * in the shared retry/429/not-modified policy (`robustApiCall`). Because
 * send and edit share the same opts, the "edit-rich-if-sent-rich" invariant
 * holds automatically (#2669). A `format:'text'` literal stream bypasses the
 * rich parser entirely (plain `sendMessage` / plain-string `editMessageText`).
 *
 * This module exists primarily so that wiring can be exercised by
 * integration tests against a mock bot.api, without having to mock the
 * entire server.ts top-level initialization.
 */

import {
  createDraftStream,
  makeDraftEditShedError,
  type DraftStreamHandle,
} from './draft-stream.js'
import { richMessage, isParseEntitiesError } from './rich-send.js'
import { renderOutboundChunks } from './render/rich-render.js'
import { isSendGateShed, type SendGateOpts } from './send-gate.js'
import {
  buildReplyParameters,
  dropQuoteFromSendOpts,
  isQuoteRejectionError,
  sendOptsHaveQuote,
} from './reply-quote.js'

/**
 * Minimal bot.api surface the controller needs. Real callers pass grammy's
 * `bot.api`; tests pass a mock with these methods.
 */
export interface StreamBotApi {
  sendMessage(
    chat_id: string,
    text: string,
    opts: StreamSendOpts,
  ): Promise<{ message_id: number }>
  sendRichMessage(
    chat_id: string,
    rich_message: { markdown: string },
    opts: StreamSendOpts,
  ): Promise<{ message_id: number }>
  editMessageText(
    chat_id: string,
    message_id: number,
    text: string | { markdown: string },
    opts: StreamSendOpts,
  ): Promise<unknown>
}

export interface StreamSendOpts {
  message_thread_id?: number
  link_preview_options?: { is_disabled: boolean }
  /**
   * Telegram's reply_parameters, used for quote-replying to an earlier
   * message. Only meaningful on the initial `sendMessage` — `editMessageText`
   * cannot add a quote reference to an existing message, so the controller
   * strips this from edit opts internally.
   *
   * `quote` is a Bot API **String** — the quoted substring itself. The optional
   * offset is a SIBLING `quote_position` Integer, which this plugin
   * deliberately never emits. Typing it as an object is what produced
   * `400 field "quote" must be of type String` on every quoted reply; see
   * `reply-quote.ts`.
   */
  reply_parameters?: { message_id: number; quote?: string }
  /**
   * Inline keyboard markup. Included in both sendMessage and editMessageText
   * so that inline buttons persist through text edits. Without this,
   * editMessageText strips any previously attached keyboard.
   */
  reply_markup?: unknown
  /**
   * When true, Telegram prevents the message from being forwarded or saved.
   * Only meaningful on the initial `sendMessage` — `editMessageText` does not
   * accept this parameter, so the controller omits it from edit opts.
   */
  protect_content?: boolean
  /**
   * When true, the initial `sendMessage` is silent (no device ping).
   * Has no effect on `editMessageText` — Telegram never pings on edits.
   * Used by mid-turn `stream_reply` calls under the #1122 conversational
   * pacing redesign so only the final answer pings.
   */
  disable_notification?: boolean
}

/**
 * Options a stream-controller call passes to its retry wrapper. A structural
 * superset of `SendGateOpts` (send-gate.ts) plus the retry policy's own
 * `threadId`, and assignable to `RetryCallOpts` (retry-api-call.ts) — so the
 * production wrapper (`robustApiCall` = send gate over `createRetryApiCall`)
 * receives `messageId` / `editPayload` / `priorityClass` and the gate's
 * per-message edit floor, last-write-wins coalescing, no-op skip and
 * cosmetic shedding govern the draft/answer stream (#3110; part3-design §4
 * names rapid same-message editMessageText as the #1 flood-ban trigger).
 */
export type RetryPolicyOpts = SendGateOpts & { threadId?: number }

export type RetryPolicy = <T>(
  fn: () => Promise<T>,
  opts?: RetryPolicyOpts,
) => Promise<T>

export interface StreamControllerConfig {
  bot: { api: StreamBotApi }
  chatId: string
  threadId?: number
  /**
   * When true, this stream is a literal `format:'text'` send: the body
   * bypasses the rich-markdown parser entirely (plain `sendMessage` /
   * plain-string `editMessageText`). Default (false/undefined) → the
   * rich-markdown path via `sendRichMessage` / `editMessageText({ markdown })`.
   */
  literalText?: boolean
  disableLinkPreview?: boolean
  /**
   * Optional quote-reply target. When set, the initial send attaches
   * `reply_parameters: { message_id: replyToMessageId }` so the first
   * streamed message quote-threads under the referenced message. Edits
   * don't include it (Telegram rejects reply_parameters on edit).
   */
  replyToMessageId?: number
  /**
   * Optional quote text for surgical quoting. When set along with
   * `replyToMessageId`, the initial send includes
   * `reply_parameters: { message_id, quote }` — `quote` is a Bot API String
   * (see `reply-quote.ts`). A quote Telegram cannot find in the replied-to
   * message is dropped and the send retried unquoted, so the answer still
   * lands.
   */
  quoteText?: string
  /**
   * When true, Telegram prevents the message from being forwarded or saved.
   * Applied on the initial `sendMessage` only — editMessageText does not
   * accept protect_content.
   */
  protectContent?: boolean
  /**
   * When true, the initial `sendMessage` is silent (no device ping).
   * editMessageText never pings regardless. Default false. #1122.
   */
  disableNotification?: boolean
  /**
   * Inline keyboard markup attached to every send and edit. Without this,
   * editMessageText strips any previously attached keyboard. The progress-
   * card driver passes the Steer button here so it persists through edits.
   */
  replyMarkup?: unknown
  throttleMs?: number
  /** Pre-send idle debounce. See DraftStreamConfig.idleMs. */
  idleMs?: number
  /**
   * Retry wrapper around bot.api calls. Defaults to calling `fn` directly
   * (no retry) so tests that don't care about policy can omit it. In
   * production, pass server.ts's `robustApiCall`.
   */
  retry?: RetryPolicy
  /** Observers — fire after each successful send/edit. Optional. */
  onSend?: (messageId: number, chars: number) => void
  onEdit?: (messageId: number, chars: number) => void
  /**
   * Optional diagnostic logger. Receives the draft-stream's internal
   * status lines (edit-failed, not-modified, re-sending, finalize).
   * When omitted, those lines are dropped — which is what the plugin
   * did for its entire history, silently hiding transient edit errors.
   * Pass a stderr writer in production to surface them.
   */
  log?: (msg: string) => void
  /**
   * Optional warning logger. Used for fallback notices.
   */
  warn?: (msg: string) => void
  /**
   * True when the chat is a private DM. Passed to createDraftStream so
   * the throttle default (400 ms for DMs vs 1000 ms for groups) is applied
   * correctly when no explicit throttleMs is set.
   */
  isPrivateChat?: boolean
  /**
   * If set, the controller is initialized as if a previous send had
   * landed with this `message_id`. The first `update()` invokes
   * `editMessageText` against this id rather than `sendMessage`.
   * Threads through to `createDraftStream`'s `initialMessageId`. Used
   * by callers that know the anchor message id from an external source
   * (e.g. the gateway's pin manager) to guarantee subsequent emits
   * edit in place rather than create a fresh sendMessage. Closes the
   * "done=true → activeDraftStreams entry deleted → next emit creates
   * fresh sendMessage" duplicate-message class (issue #626).
   */
  initialMessageId?: number | null
}

/**
 * Build a draft stream that writes to Telegram via `bot.api`.
 *
 * The returned handle is the standard `DraftStreamHandle` contract:
 * `update(text)`, `finalize()`, `getMessageId()`, `isFinal()`.
 */
export function createStreamController(cfg: StreamControllerConfig): DraftStreamHandle {
  const {
    bot,
    chatId,
    threadId,
    literalText = false,
    disableLinkPreview = true,
    throttleMs,
    idleMs,
    retry = <T>(fn: () => Promise<T>) => fn(),
    onSend,
    onEdit,
    log,
    warn,
    replyToMessageId,
    quoteText,
    protectContent,
    replyMarkup,
    isPrivateChat,
    initialMessageId,
  } = cfg

  // Base opts shared by send + edit. The initial send adds reply_parameters
  // and protect_content on top (see below); edits must NOT carry those —
  // Telegram's editMessageText rejects them. Both send and edit share these
  // opts, so a rich send is always followed by a rich edit (#2669 invariant).
  const baseOpts: StreamSendOpts = {
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
    ...(replyMarkup != null ? { reply_markup: replyMarkup } : {}),
  }
  // `let`, not `const`: a quote Telegram cannot find in the replied-to message
  // is stripped ONCE for the whole stream (see sendPieceWithQuoteFallback) —
  // re-attaching it to the next piece would just 400 again.
  let sendOpts: StreamSendOpts = {
    ...baseOpts,
    ...(replyToMessageId != null
      ? {
          // `quote` is a Bot API String; `quote_position` is a separate sibling
          // Integer we deliberately don't emit. See reply-quote.ts.
          reply_parameters: buildReplyParameters(replyToMessageId, quoteText),
        }
      : {}),
    ...(protectContent === true ? { protect_content: true } : {}),
    ...(cfg.disableNotification === true ? { disable_notification: true } : {}),
  }

  // Send the body via the rich-markdown path, unless this is a literal
  // `format:'text'` stream (plain sendMessage, no rich wrapper).
  // sendRichMessage does NOT accept link_preview_options (rich messages
  // control previews via entity detection), so strip it for the rich path.
  // Render the outbound body into 1+ wire-cap-respecting pieces. The common
  // case is a SINGLE piece whose output is identical to the pre-existing
  // `maybeRenderOutbound` path; a body whose markdown-escaping pushed the
  // rendered form past the cap splits into several pieces, each of which fits
  // its own wire cap and never bisects a fenced block / table row (see
  // `renderOutboundChunks`). Rendering disabled (SWITCHROOM_RICH_RENDER=0)
  // and a literal `format:'text'` stream both yield a single passthrough
  // piece — byte-for-byte the pre-renderer send path.
  const renderPieces = (text: string): { text: string; rich: boolean }[] => {
    if (literalText) return [{ text, rich: false }]
    // A `plain`-mode piece (oversized/unsafe content renderSafe declined to
    // emit as rich) sends WITHOUT the rich wrapper.
    return renderOutboundChunks(text).map((r) => ({ text: r.text, rich: r.mode !== 'plain' }))
  }
  // Send ONE rendered piece. Rich pieces go through sendRichMessage (with
  // link_preview_options stripped — rich messages control previews via entity
  // detection); plain pieces (and literal streams) through sendMessage.
  const sendPiece = (piece: { text: string; rich: boolean }, opts: StreamSendOpts) => {
    if (!piece.rich) return bot.api.sendMessage(chatId, piece.text, opts)
    const richOpts = { ...opts }
    delete richOpts.link_preview_options
    return bot.api.sendRichMessage(chatId, richMessage(piece.text), richOpts)
  }
  // Send a piece, degrading gracefully when the SURGICAL QUOTE is the thing
  // Telegram rejected. `reply_parameters.quote` must be an exact substring of
  // the replied-to message; when it isn't, the 400 kills a perfectly good
  // answer. Drop the highlight (for this send and every later one on this
  // stream) and re-send — the reply still lands, still threaded under the same
  // message.
  const sendPieceWithQuoteFallback = async (piece: { text: string; rich: boolean }) => {
    try {
      return await sendPiece(piece, sendOpts)
    } catch (err) {
      if (!isQuoteRejectionError(err) || !sendOptsHaveQuote(sendOpts)) throw err
      warn?.(
        `stream-controller: quote not found in the replied-to message — re-sending without the quote (${err instanceof Error ? err.message : String(err)})`,
      )
      sendOpts = dropQuoteFromSendOpts(sendOpts)
      return await sendPiece(piece, sendOpts)
    }
  }
  const editPiece = (id: number, piece: { text: string; rich: boolean }, opts: StreamSendOpts) => {
    if (!piece.rich) return bot.api.editMessageText(chatId, id, piece.text, opts)
    return bot.api.editMessageText(chatId, id, richMessage(piece.text), opts)
  }

  // ---- Send-gate wiring for the edit path (#3110) -------------------------
  //
  // Every edit call passes `messageId` / `editPayload` / `priorityClass`
  // through the retry wrapper so the send gate's per-message edit floor
  // (>=1.5s), last-write-wins coalescing, and no-op skip govern the draft
  // stream — previously these edits carried only `{ threadId, chat_id }`,
  // so the gate treated them as ordinary sends and the stream's own 400 ms
  // DM throttle drove same-message editMessageText well under the floor
  // (the #1 documented flood-ban trigger, part3-design §4; production ban
  // 2026-07-12 on #3110). The local per-surface throttle stays as a cheap
  // pre-filter; the gate is the authority.
  //
  // Priority classes: intermediate draft edits are `cosmetic` (part3-design
  // §2 lists "stream updates" there) — shed under pressure / an open flood
  // window; the next flush carries full state. The FINALIZE flush (the edit
  // that renders the completed answer) is `critical`, mirroring the reply
  // path's preview-finalize convention (gateway.ts editPreview): never shed,
  // waits out a short window, fails fast with a structured FLOOD_WAIT_ACTIVE
  // on a long one. SENDS stay untagged (the gate admits untagged non-edit
  // sends as `critical`) — a shed send would resolve the gate's shed
  // sentinel instead of `{ message_id }` and break message-id capture, and
  // the anchor/tail sends ARE the answer surface.
  //
  // `handleRef.isFinal()` is true from the moment finalize() is entered
  // (draft-stream sets `final` before its last flush), so the closures below
  // classify exactly the finalize flush — and anything after it — as
  // critical. The ref is assigned right after createDraftStream returns,
  // before any closure can run (closures only fire from update/finalize).
  //
  // KNOWN MISSED BENEFIT (review F5, deliberate): the gate's last-write-wins
  // coalescing never engages for THIS surface, because draft-stream
  // serializes its flushes — it awaits each edit before issuing the next, so
  // at most one edit per message is ever inside the gate. Consequence: a
  // stale draft sleeping on the gate's floor still lands (one API call the
  // coalescer would have replaced) before the newer snapshot, and a finalize
  // issued mid-floor can trail by up to ~2x editFloorMs (floor wait for the
  // stale draft, then floor wait for the final). Correctness is unaffected —
  // the latest state always lands, floor-paced — and the gate coalescing
  // remains live protection for CONCURRENT writers to one message (e.g. a
  // re-attached #626 controller racing its predecessor).
  let handleRef: DraftStreamHandle | null = null
  const editGateOpts = (id: number, payload: unknown): RetryPolicyOpts => ({
    threadId,
    chat_id: chatId,
    messageId: id,
    editPayload: payload,
    priorityClass: handleRef?.isFinal() === true ? 'critical' : 'cosmetic',
  })
  // The rendered payload the gate hashes for the no-op skip / coalescing —
  // exactly what goes over the wire (rich wrapper included), so a plain
  // fallback of the same text never hashes equal to its rich form.
  const piecePayload = (piece: { text: string; rich: boolean }): unknown =>
    piece.rich ? richMessage(piece.text) : piece.text
  // Shed detection (#3110 review F1): keyed EXACTLY off the gate's
  // SEND_GATE_SHED sentinel — never off `undefined`, which is overloaded
  // (gate no-op drop; robustApiCall's swallowed benign 400s like "message is
  // not modified"). Those benign cases mean the payload is ALREADY on screen
  // and are treated as delivered, exactly as before this wiring existed. A
  // true shed means the edit did NOT land: draft-stream must not record the
  // snapshot as on-screen (its dedupe would skip a later flush of the same
  // text — the completed answer would never render), so the edit closure
  // throws the marker error draft-stream recognizes and recovers from
  // (`makeDraftEditShedError` → snapshot preserved for finalize, review F2).

  // Overflow-tail bookkeeping, shared across the send + edit closures for the
  // whole stream lifetime. A body large enough to split into several
  // wire-cap pieces anchors on piece[0] (edited in place by draft-stream) and
  // parks pieces[1..n] as follow-up messages. The draft-stream edit callback
  // fires on EVERY throttled flush as a streamed answer grows, so we MUST NOT
  // re-send those tails each tick (that flooded the chat with duplicates — the
  // blocker this fix closes). Instead we remember each tail's message_id the
  // first time it is emitted and edit it in place on later flushes; a tail that
  // did not exist on a prior flush (the piece count grew) is sent fresh once.
  // End state after finalize: anchor + one message per tail piece, no dupes.
  const tailIds: number[] = []
  const tailLastText: string[] = []

  // Emit or update a single tail piece (0-based index `ti` = piece index - 1).
  // Sends a fresh message the first time; edits in place (skipping unchanged
  // text) thereafter. A non-parse failure is logged as a partial-delivery
  // warning and swallowed so the remaining tail pieces still get a chance to
  // land — never a silent drop, never an abort of pieces K..N (concern C1).
  //
  // Returns TRUE when this piece's edit was SHED by the send gate (did not
  // land): the caller must then report the whole flush as shed so
  // draft-stream does not record the full body as delivered while a tail is
  // stale (review F3). The piece's own tailLastText stays stale too, so the
  // recovery flush re-attempts exactly the shed piece.
  const upsertTail = async (
    ti: number,
    piece: { text: string; rich: boolean },
  ): Promise<boolean> => {
    const existingId = tailIds[ti]
    if (existingId != null) {
      if (tailLastText[ti] === piece.text) return false // unchanged — skip the API call
      try {
        const res = await retry(
          () => editPiece(existingId, piece, baseOpts),
          editGateOpts(existingId, piecePayload(piece)),
        )
        if (isSendGateShed(res)) return true // shed — stale; retried by the recovery flush
        tailLastText[ti] = piece.text
        onEdit?.(existingId, piece.text.length)
      } catch (err) {
        if (!literalText && piece.rich && isParseEntitiesError(err)) {
          warn?.(
            `stream-controller: tail-piece #${ti + 1} edit parse-entities rejected — retrying same id=${existingId} as plain text (${err instanceof Error ? err.message : String(err)})`,
          )
          const res = await retry(
            () => bot.api.editMessageText(chatId, existingId, piece.text, baseOpts),
            editGateOpts(existingId, piece.text),
          )
          if (isSendGateShed(res)) return true // shed — stale; retried by the recovery flush
          tailLastText[ti] = piece.text
          onEdit?.(existingId, piece.text.length)
        } else {
          // Best-effort continue: leave tailLastText[ti] stale so the next
          // flush retries this piece, and surface the partial delivery loudly.
          warn?.(
            `stream-controller: tail-piece #${ti + 1} edit FAILED (id=${existingId}) — partial delivery, this piece may be stale (${err instanceof Error ? err.message : String(err)})`,
          )
        }
      }
      return false
    }
    // First emission of this tail piece → a fresh follow-up message.
    try {
      const sent = await retry(() => sendPieceWithQuoteFallback(piece), { threadId, chat_id: chatId })
      tailIds[ti] = sent.message_id
      tailLastText[ti] = piece.text
      onSend?.(sent.message_id, piece.text.length)
    } catch (err) {
      if (!literalText && piece.rich && isParseEntitiesError(err)) {
        warn?.(
          `stream-controller: tail-piece #${ti + 1} send parse-entities rejected — sending as plain text (${err instanceof Error ? err.message : String(err)})`,
        )
        const sent = await retry(
          () => bot.api.sendMessage(chatId, piece.text, sendOpts),
          { threadId, chat_id: chatId },
        )
        tailIds[ti] = sent.message_id
        tailLastText[ti] = piece.text
        onSend?.(sent.message_id, piece.text.length)
      } else {
        // Best-effort continue: no id recorded, so the next flush re-attempts
        // this piece rather than silently dropping pieces K..N (concern C1).
        warn?.(
          `stream-controller: tail-piece #${ti + 1} send FAILED — partial delivery, this and later pieces may be missing this flush (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
    // First-emission SENDS are untagged (critical) — the gate never sheds
    // them, so this path can only land or fail (handled above).
    return false
  }

  const handle = createDraftStream(
    async (text) => {
      // Render → 1+ cap-respecting pieces. The FIRST piece's message_id anchors
      // the stream (later edits target it); any overflow pieces are parked as
      // follow-up messages via upsertTail. For the common single-piece case
      // this is exactly one send.
      const pieces = renderPieces(text)
      const head = pieces[0]
      let anchorId: number | undefined
      try {
        const sent = await retry(
          () => sendPieceWithQuoteFallback(head),
          { threadId, chat_id: chatId },
        )
        anchorId = sent.message_id
      } catch (err) {
        if (!literalText && head.rich && isParseEntitiesError(err)) {
          // Piece rejected because its markdown couldn't be parsed. There is
          // no message_id to edit (the send 400'd before any message was
          // created), so recover with a single fresh PLAIN send of the same
          // body (no rich wrapper, so the parser never runs) — see issue #657.
          warn?.(
            `stream-controller: send parse-entities rejected — retrying once as plain text (${err instanceof Error ? err.message : String(err)})`,
          )
          // Resend the RAW source verbatim (readable, and the exact
          // pre-existing #657 contract) rather than the escaped/rendered
          // body. For a single-piece stream (the common case) this is the
          // whole message; for a rare oversize split the head falls back to
          // its own body and each tail to its own body below.
          const fallbackBody = pieces.length === 1 ? text : head.text
          const sent = await retry(
            () => bot.api.sendMessage(chatId, fallbackBody, sendOpts),
            { threadId, chat_id: chatId },
          )
          anchorId = sent.message_id
        } else {
          throw err
        }
      }
      // C2: report the ACTUAL emitted anchor-piece length, not the full body
      // length — the anchor only holds the head piece, and the tails report
      // their own lengths via upsertTail.
      onSend?.(anchorId as number, head.text.length)
      // Park overflow pieces (first-time send records their ids for reuse).
      for (let pi = 1; pi < pieces.length; pi++) {
        await upsertTail(pi - 1, pieces[pi])
      }
      return anchorId as number
    },
    async (id, text) => {
      const pieces = renderPieces(text)
      const head = pieces[0]
      // Whether any piece of THIS flush was shed by the gate (did not land).
      // Decided at the very end — AFTER the tail loop — so a benign anchor
      // outcome (or even a shed anchor) never starves the tail pieces of
      // their own upsert attempt (review F1: an anchor whose payload stopped
      // changing resolves benignly every flush while only the tail grows).
      let anchorShed = false
      // Edit the anchor message in place with the FIRST piece.
      try {
        const res = await retry(() => editPiece(id, head, baseOpts), editGateOpts(id, piecePayload(head)))
        if (isSendGateShed(res)) {
          // Shed by the gate (cosmetic under pressure / an open flood
          // window) — did NOT land. Benign `undefined` resolutions (gate
          // no-op drop, robustApiCall's swallowed "message is not modified")
          // deliberately do NOT take this branch: the payload is already on
          // screen and the flush proceeds as delivered.
          anchorShed = true
        } else {
          // C2: report the actual head-piece length, not the full body length.
          onEdit?.(id, head.text.length)
        }
      } catch (err) {
        if (!literalText && head.rich && isParseEntitiesError(err)) {
          // Edit rejected because the markdown couldn't be parsed — DO NOT
          // send a fresh message. The whole point of issue #657 is that the
          // previous implementation sent a duplicate message every time a
          // parse rejection fired. Retry the edit on the SAME message_id as
          // PLAIN text (no rich wrapper, so the parser never runs).
          warn?.(
            `stream-controller: edit parse-entities rejected — retrying same id=${id} as plain text (${err instanceof Error ? err.message : String(err)})`,
          )
          // Re-edit the SAME id with the RAW source verbatim (the exact #657
          // contract). For a single-piece stream (common case) this is the
          // whole body; a rare oversize split edits the head piece's body.
          const fallbackBody = pieces.length === 1 ? text : head.text
          const res = await retry(
            () => bot.api.editMessageText(chatId, id, fallbackBody, baseOpts),
            editGateOpts(id, fallbackBody),
          )
          if (isSendGateShed(res)) anchorShed = true
          else onEdit?.(id, head.text.length)
        } else {
          throw err
        }
      }
      // Oversize tail: the anchor message holds only the first piece. On EVERY
      // edit flush we UPDATE the parked tail messages in place (or send a tail
      // that only just came into existence) — we never re-send tails already
      // emitted on a prior flush. This is the fix for the duplicate-flood
      // blocker: the previous code re-sent pieces[1..n] as brand-new messages
      // on each throttled edit tick. Runs BEFORE the shed decision below so a
      // shed (or benign) anchor never starves the tails (review F1).
      let anyTailShed = false
      for (let pi = 1; pi < pieces.length; pi++) {
        if (await upsertTail(pi - 1, pieces[pi])) anyTailShed = true
      }
      // Review F3: ANY shed piece — anchor or tail — means this flush did not
      // fully land. Throw the marker error so draft-stream does not record
      // the body as delivered (its dedupe would freeze the shed piece
      // forever) and instead preserves the snapshot for the finalize
      // re-flush. Pieces that DID land are unaffected on that re-flush: the
      // gate's no-op skip drops their identical payloads before the API, and
      // landed tails short-circuit on tailLastText.
      if (anchorShed || anyTailShed) throw makeDraftEditShedError(id)
    },
    {
      ...(throttleMs != null ? { throttleMs } : {}),
      ...(idleMs != null ? { idleMs } : {}),
      ...(log != null ? { log } : {}),
      ...(warn != null ? { warn } : {}),
      ...(isPrivateChat != null ? { isPrivateChat } : {}),
      ...(initialMessageId != null ? { initialMessageId } : {}),
      chatId,
    },
  )
  handleRef = handle
  return handle
}
