// Outbound send-path — deterministic text pipeline + chunking core (#2996).
//
// Phase 2 of the gateway.ts decomposition (issue #2996, plan §3B). This
// module owns the pure, side-effect-free heart of the reply/stream/turn-flush
// outbound pipeline: the normalize → redact → punctuation/bold → voice-scrub
// text transform, the effective-text spacing decision, the length-limit
// chunking, and the oversize-chunk re-split. These are exactly the transforms
// where the recent oversize / redaction / voice-scrub regressions landed, and
// extracting them here makes them unit-testable in isolation (see
// outbound-send-path.test.ts golden snapshots).
//
// Deliberately NOT moved here (they stay in gateway.ts, delegating to this
// module): the side-effecting send orchestration — currentTurn pinning,
// emission-authority / over-ping decisions, activity-card finalize, voice
// synthesis + sends, typing loops, history recording, the shared
// `outboundDedup` singleton check/record, and the raw bot.api send loop with
// its partial-failure contract. Those read gateway module state and are not
// byte-identically relocatable without an invocable-executeReply harness that
// this pure-core extraction is itself the prerequisite for.
//
// currentTurn coupling (#1067/#1664): this module NEVER reads the currentTurn
// global. Every function here is pure over its arguments — turn identity is
// pinned by the caller and never observed here.

import {
  repairEscapedWhitespace,
  normalizeParagraphBreaks,
  normalizePunctuation,
  stripExcessBold,
  splitMarkdownChunks,
  hardSliceToCap,
  RICH_MESSAGE_MAX_CHARS,
} from '../format.js'
import { scrubVoice } from '../text-voice-scrub.js'
import { isMessageTooLongError, isHtmlParseRejectError } from '../retry-api-call.js'

/** The redactor the caller injects. In gateway this is `redactOutboundText`,
 *  which wraps `redact()` and logs (never the secret value) when a mask fires.
 *  Injected rather than imported so the redaction structural-wiring test
 *  (`gateway-outbound-redact.test.ts`) keeps pinning the helper in gateway.ts,
 *  and so this module stays free of the stderr side effect. */
export type RedactFn = (text: string, site: string) => string

export interface NormalizeOutboundResult {
  /** The fully-normalized text. This is the value used downstream as the
   *  dedup key, the Telegraph threshold input, and (after effective-text
   *  spacing) the chunk source. Callers apply it exactly as the pre-#2996
   *  inline pipeline did. */
  text: string
  /** Number of voice-scrub replacements applied (dashes → commas/periods,
   *  opener strips). >0 means the voice scrub mutated the text; the caller
   *  emits the `voice_scrub_applied` runtime metric on that condition. */
  voiceReplaced: number
}

/**
 * Stage 1 — the deterministic outbound text transform, byte-identical to the
 * inline pipeline at the entry of executeReply (and mirrored on the
 * answer-stream + turn-flush paths):
 *
 *   1. repairEscapedWhitespace  — undo LLM JSON-escape bungles
 *   2. normalizeParagraphBreaks — promote lone prose breaks to GFM hard breaks
 *   3. redact (injected)        — outbound secret scrub (#2044), BEFORE the
 *                                 punctuation/bold normalizers so a secret with
 *                                 an em-dash or `**` is matched literally
 *   4. stripExcessBold∘normalizePunctuation — fleet-consistent formatting
 *   5. scrubVoice               — em/en dash → comma/period (#1683)
 *
 * The order is load-bearing and MUST NOT change (each step's comment in the
 * former inline site documents why). Pure over its arguments.
 */
export function normalizeOutboundBody(
  rawText: string,
  site: string,
  redact: RedactFn,
): NormalizeOutboundResult {
  let text = normalizeParagraphBreaks(repairEscapedWhitespace(rawText))
  text = redact(text, site)
  text = stripExcessBold(normalizePunctuation(text))
  let voiceReplaced = 0
  const scrub = scrubVoice(text)
  if (scrub.replaced > 0) {
    text = scrub.scrubbed
    voiceReplaced = scrub.replaced
  }
  return { text, voiceReplaced }
}

/**
 * Effective-text stage. Historically this injected an NBSP paragraph spacer on
 * the rich path (#2669) to force a visible gap; that pass was removed in the
 * #2669 follow-up because the live Bot API 10.1 GFM renderer already renders a
 * `\n\n` gap as one normal blank line — the spacer was double-gapping every
 * paragraph. Both paths now pass the text through byte-identically; the stage
 * is retained as the named pipeline seam (and the literal/rich distinction is
 * kept for callers) so a future rich-only transform has a home. Pure.
 */
export function computeEffectiveText(text: string, _literalText: boolean): string {
  return text
}

/**
 * Length-limit chunking. The literal path uses the newline/length `chunk()`
 * splitter; the rich path uses `splitMarkdownChunks` (markdown-boundary-aware).
 * Pure. `chunk` is passed in so the splitter (moved here as `chunkText`) and
 * this decision stay colocated without a circular gateway import.
 */
export function computeReplyChunks(args: {
  effectiveText: string
  literalText: boolean
  limit: number
  chunkMode: 'length' | 'newline'
}): string[] {
  const { effectiveText, literalText, limit, chunkMode } = args
  return literalText
    ? chunkText(effectiveText, limit, chunkMode)
    : splitMarkdownChunks(effectiveText, limit)
}

/**
 * Oversize-chunk re-split (length-error recovery). A single pre-computed chunk
 * can still exceed the wire cap when `splitMarkdownChunks` hit an indivisible
 * region and emitted it whole (a giant fenced block, a no-boundary blob).
 * Re-split at the hard `RICH_MESSAGE_MAX_CHARS` cap; for a truly indivisible
 * block, fall back to a hard character cut so each delivered piece stays under
 * the wire cap. Byte-identical to the inline `sendChunkResplit` piece
 * computation. Pure.
 */
export function resplitOversizeChunk(piece: string): string[] {
  const subPieces = splitMarkdownChunks(piece, RICH_MESSAGE_MAX_CHARS)
  return subPieces.length > 1 ? subPieces : hardSliceToCap(piece, RICH_MESSAGE_MAX_CHARS)
}

/**
 * Length/newline text splitter (relocated verbatim from gateway.ts). Splits
 * `text` into <= `limit`-char pieces. In `newline` mode it prefers a paragraph
 * break, then a line break, then a space past the halfway point; `length` mode
 * cuts hard at the limit. Pure.
 */
export function chunkText(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ─── Send orchestration (#2996 step 1) ────────────────────────────────────
//
// The reply chunk-send loop, relocated VERBATIM from executeReply so it can be
// driven from a unit test against a fake bot API (see
// outbound-send-path.test.ts). This is the highest-bug-density mechanic of the
// send path — the recent oversize / wire-cap / parse-reject / THREAD_NOT_FOUND
// fallback fixes all landed HERE — and it was previously reachable only through
// the non-importable gateway monolith (gateway.ts runs boot logic + Bun.listen
// at import, so `executeReply` cannot be invoked from vitest/bun in-place).
//
// The module stays bot-agnostic: every Telegram send is an INJECTED function
// dep, so the raw `bot.api.*` calls (and their retry wrapping + allow-raw-bot-api
// markers) remain in gateway.ts, and a test passes fakes. The caller keeps
// building the per-chunk send/edit option objects (so the option shape stays
// byte-identical to the inline site and the deps surface stays small — 8), pins
// the turn, owns dedup/voice/history, and threads the shared `sentIds` array by
// reference. currentTurn is NEVER read here (#1067/#1664).

/** Injected Telegram send surface + logging for {@link sendReplyChunks}. In
 *  gateway these are thin adapters over `lockedBot.api.*` (retry-wrapped where
 *  the inline site wrapped them); in tests they are fakes recording call shape. */
export interface ReplyChunkSendDeps {
  /** robustApiCall-wrapped rich send. Adapter: `sendRichMessage(richMessage(s))`.
   *  `threadId` (the live value) is passed into the robustApiCall meta so a
   *  thread-not-found 400 is converted to THREAD_NOT_FOUND, exactly as inline. */
  sendRich: (opts: Record<string, unknown>, richBody: unknown, threadId: number | undefined) => Promise<{ message_id: number }>
  /** robustApiCall-wrapped literal send. Adapter: `sendMessage(chunk)`. */
  sendLiteral: (opts: Record<string, unknown>, text: string, threadId: number | undefined) => Promise<{ message_id: number }>
  /** UNwrapped literal send (last-resort fallbacks that must NOT re-enter the
   *  retry policy that just rejected the payload). Adapter: raw `sendMessage`. */
  sendLiteralRaw: (opts: Record<string, unknown>, text: string) => Promise<{ message_id: number }>
  /** UNwrapped rich send (length-error re-split last resort). Adapter: raw
   *  `sendRichMessage(richMessage(piece))`. */
  sendRichRaw: (opts: Record<string, unknown>, richBody: unknown) => Promise<{ message_id: number }>
  /** robustApiCall-wrapped preview edit-in-place. */
  editPreview: (messageId: number, body: unknown, opts: Record<string, unknown>, threadId: number | undefined) => Promise<unknown>
  /** rich-markdown wrapper (`richMessage`). Applied to a chunk/piece string. */
  richMessage: (s: string) => unknown
  /** outbound logger (`logOutbound`). */
  logOutbound: (path: 'reply', chatId: string, messageId: number, chars: number, extra?: string) => void
  /** delete a stale preview message (`deleteStalePreview`). */
  deleteStalePreview: (id: number) => Promise<void>
  /** stderr sink (`process.stderr.write`). */
  stderr: (s: string) => void
}

/** Mutable send state + per-chunk option builders for {@link sendReplyChunks}.
 *  The caller owns option shape (byte-identical to the inline site). */
export interface ReplyChunkSendState {
  chatId: string
  chunks: string[]
  literalText: boolean
  /** voice-only mode with a full synthesis skips the text body entirely. */
  suppressText: boolean
  /** current thread id; re-split/fallbacks may drop it (THREAD_NOT_FOUND). */
  threadId: number | undefined
  /** a stale draft-stream preview to edit-in-place on the first chunk, or null. */
  previewMessageId: number | null
  /** shared results array — appended in place (voice/file sends push too). */
  sentIds: number[]
  /** build the send-options object for chunk `i` (last-chunk flag + live thread). */
  buildSendOpts: (i: number, isLastChunk: boolean, threadId: number | undefined) => Record<string, unknown>
  /** build the preview edit-in-place options for the first chunk. */
  buildPreviewEditOpts: (isLastChunk: boolean) => Record<string, unknown>
}

export interface ReplyChunkSendResult {
  /** thread id after any THREAD_NOT_FOUND fallback (used by later file sends). */
  threadId: number | undefined
  /** preview id after consumption (null once edited/deleted). */
  previewMessageId: number | null
}

/**
 * Send the pre-computed reply chunks. Relocated verbatim from executeReply's
 * chunk loop. Appends message ids to `state.sentIds` in order. On an
 * unrecoverable send error it throws the raw error — the caller wraps it into
 * the `reply failed after N of M chunk(s) sent` partial-failure contract and
 * runs the typing-loop `finally`, exactly as before.
 */
export async function sendReplyChunks(
  deps: ReplyChunkSendDeps,
  state: ReplyChunkSendState,
): Promise<ReplyChunkSendResult> {
  const { chatId, chunks, literalText, suppressText, sentIds } = state
  let threadId = state.threadId
  let previewMessageId = state.previewMessageId

  for (let i = 0; i < chunks.length; i++) {
    // PR-C2: voice-only mode with a successful synthesis suppresses the
    // text body — the spoken voice note IS the reply. Bail before the
    // first chunk send (sentIds stays empty for text); the voice send
    // below lands the answer. Any other mode (voice+text, or voice-only
    // that fell back) sends the text chunks as normal.
    if (suppressText) break
    const isLastChunk = i === chunks.length - 1
    const sendOpts = state.buildSendOpts(i, isLastChunk, threadId)

    if (i === 0 && previewMessageId != null) {
      const editOpts = state.buildPreviewEditOpts(isLastChunk)
      try {
        await deps.editPreview(previewMessageId!, literalText ? chunks[i] : deps.richMessage(chunks[i]), editOpts, threadId)
        sentIds.push(previewMessageId!)
        previewMessageId = null
        continue
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/not modified/i.test(msg)) {
          sentIds.push(previewMessageId!)
          previewMessageId = null
          continue
        }
        deps.stderr(`telegram gateway: preview edit-in-place failed (${msg}), sending fresh\n`)
        await deps.deleteStalePreview(previewMessageId!)
        previewMessageId = null
      }
    }

    // Last-resort: resend this chunk as plain text (no rich wrapper, so
    // the markdown parser never runs). Keeps thread / reply / markup
    // params; only the formatting is sacrificed. Used when Telegram
    // rejects our markdown — better an unformatted answer than a
    // vanished one. The raw markdown source is itself readable prose, so
    // we send it verbatim rather than strip anything.
    const sendChunkPlainText = async (opts: Record<string, unknown>): Promise<void> => {
      const plain =
        chunks[i].length > 0
          ? chunks[i]
          : '⚠️ (a fragment could not be rendered for Telegram)'
      const sent = await deps.sendLiteralRaw(opts, plain)
      sentIds.push(sent.message_id)
      deps.logOutbound('reply', chatId, sent.message_id, plain.length, `chunk=${i + 1}/${chunks.length} plaintext-fallback`)
      deps.stderr(
        `telegram gateway: markdown parse-reject — resent chunk ${i + 1}/${chunks.length} as plain text\n`,
      )
    }

    // Literal `format:'text'` sends bypass the rich parser entirely
    // (plain sendMessage, no markdown). The default path ships rich
    // markdown via sendRichMessage. Both resolve to a Message with a
    // message_id, which is all the caller reads.
    //
    // `wrapped` selects the retry-wrapped adapter (first attempt) vs the
    // UNwrapped adapter (THREAD_NOT_FOUND retry). The inline site wrapped only
    // the first attempt in robustApiCall; the retry called the raw send
    // deliberately, so re-attempting after a dropped thread never re-enters the
    // retry policy. Preserving that split keeps behavior byte-identical.
    const sendChunk = (opts: Record<string, unknown>, wrapped: boolean): Promise<{ message_id: number }> => {
      if (literalText) {
        return wrapped ? deps.sendLiteral(opts, chunks[i], threadId) : deps.sendLiteralRaw(opts, chunks[i])
      }
      // sendRichMessage does NOT accept link_preview_options (rich messages
      // control previews via entity detection) — drop it for the rich path.
      const richOpts = { ...opts }
      delete (richOpts as { link_preview_options?: unknown }).link_preview_options
      const richBody = deps.richMessage(chunks[i])
      return wrapped ? deps.sendRich(richOpts, richBody, threadId) : deps.sendRichRaw(richOpts, richBody)
    }

    // Length-error recovery: a single pre-computed chunk can still exceed the
    // wire cap when splitMarkdownChunks hit an indivisible region and emitted
    // it whole (a giant fenced block, a no-boundary blob). Telegram answers
    // with RICH_MESSAGE_TEXT_TOO_LONG / MESSAGE_TOO_LONG. Re-split this chunk
    // at a harder boundary and send each piece, rather than misclassifying it
    // as a parse-reject (which would resend the same oversized payload as
    // plain text) or surfacing the raw 400.
    const sendChunkResplit = async (opts: Record<string, unknown>): Promise<void> => {
      // Re-split at the same cap; for a truly indivisible block this still
      // yields one oversized piece, but a hard character-cut on the rendered
      // markdown at least keeps each delivered piece under the wire cap.
      const pieces = resplitOversizeChunk(chunks[i])
      for (let p = 0; p < pieces.length; p++) {
        let sent: { message_id: number }
        if (literalText) {
          sent = await deps.sendLiteralRaw(opts, pieces[p])
        } else {
          const ro = { ...opts }
          delete (ro as { link_preview_options?: unknown }).link_preview_options
          sent = await deps.sendRichRaw(ro, deps.richMessage(pieces[p]))
        }
        sentIds.push(sent.message_id)
        deps.logOutbound('reply', chatId, sent.message_id, pieces[p].length, `chunk=${i + 1}/${chunks.length} resplit=${p + 1}/${pieces.length}`)
      }
      deps.stderr(
        `telegram gateway: rich body too long — re-split chunk ${i + 1}/${chunks.length} into ${pieces.length} piece(s)\n`,
      )
    }

    try {
      const sent = await sendChunk(sendOpts, true)
      sentIds.push(sent.message_id)
      deps.logOutbound('reply', chatId, sent.message_id, chunks[i].length, `chunk=${i + 1}/${chunks.length}`)
    } catch (err) {
      if (err instanceof Error && err.message === 'THREAD_NOT_FOUND') {
        threadId = undefined
        const retryOpts = { ...sendOpts }
        delete (retryOpts as Record<string, unknown>).message_thread_id
        try {
          const sent = await sendChunk(retryOpts, false)
          sentIds.push(sent.message_id)
        } catch (retryErr) {
          // Thread dropped, AND another failure: length → re-split,
          // parse-reject → plain text, else propagate.
          if (isMessageTooLongError(retryErr)) await sendChunkResplit(retryOpts)
          else if (isHtmlParseRejectError(retryErr)) await sendChunkPlainText(retryOpts)
          else throw retryErr
        }
      } else if (isMessageTooLongError(err)) {
        await sendChunkResplit(sendOpts)
      } else if (isHtmlParseRejectError(err)) {
        await sendChunkPlainText(sendOpts)
      } else {
        throw err
      }
    }
  }

  return { threadId, previewMessageId }
}
