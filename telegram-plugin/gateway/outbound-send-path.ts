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
  addParagraphSpacers,
  splitMarkdownChunks,
  splitPlainTextToCap,
  hardSliceToCap,
  RICH_MESSAGE_MAX_CHARS,
} from '../format.js'
import { scrubVoice } from '../text-voice-scrub.js'
import { normalizeTemporal } from '../temporal-normalize.js'
import { resolveEnvTimezone } from '../shared/local-time.js'
import { isMessageTooLongError, isHtmlParseRejectError } from '../retry-api-call.js'
import {
  buildReplyParameters,
  dropQuoteFromSendOpts,
  isQuoteRejectionError,
  sendOptsHaveQuote,
} from '../reply-quote.js'
import { captureSpeechText } from './speech-capture.js'

// ── send-orchestration façade imports (#2996 P2) ──
// Pure/deterministic helpers are imported; stateful or side-effecting gateway
// surfaces are injected via SendReplyGatewayDeps (see the DI contract below).
import { statSync } from 'fs'
import { extname } from 'path'
import { GrammyError, InputFile, type Bot, type Context } from 'grammy'
import {
  combineReadBackResults,
  type ReadBackResult,
} from './backstop-delivery.js'
import {
  escapeMarkdown,
} from '../format.js'
import { richMessage } from '../rich-send.js'
import { journalExternalDelivery } from './outbox-sweep.js'
import { sha256Hex } from '../outbox.js'
// #4141: the ONE shared framing implementation, also used by the outbox sweep
// and (for the classifier half) the unbundled Stop hooks.
//
// #4490: previously this import only pulled the reply-throw half. The
// captured-prose bridge below is the ELECTED path's deliverer — it never
// writes an outbox record, so without the audience gate / self-improvement
// framing wired in here too, a review-turn's raw, unlabelled reasoning could
// reach the operator whenever the single-writer election (in
// `silent-end-interrupt-stop.mjs`) routes a 'trailing-text-after-reply' case
// here instead of to the outbox sweep. Wiring the SAME shared predicates in
// both places (rather than re-deriving a third, parallel implementation)
// restores the #4141-style symmetry #4485 left one-sided.
import {
  applyReplyThrowFraming,
  formatReplyThrowFraming,
  shouldFrameReplyThrow,
  decideCaptureAudience,
  isSelfImprovementCard,
  shouldFrameSelfImprovement,
  applySelfImprovementFraming,
  formatSelfImprovementFraming,
  formatInternalSuppression,
  AUDIENCE_INTERNAL,
} from '../hooks/audience-classify.mjs'
import { queueFloodBlockedReply } from './flood-reply-queue.js'
import { resolveChatIdFallback } from './chat-id-fallback.js'
import { getBuzzMirror } from './buzz-mirror.js'
import { isFinalAnswerReply, isSubstantiveFinalReply, shouldJournalReplySiteDelivery } from '../final-answer-detect.js'
import { decideOverPing, type OverPingDecision } from '../over-ping-safety-net.js'
import { decideSilentReplyAnchor } from '../silent-reply-anchor.js'
import { parseSourceMessageId } from './source-message-id.js'
import {
  decideSupersedeCorrection,
  flushedAnswerMatchesReply,
  type FlushedTurnSupersedeRegistry,
} from '../flushed-turn-supersede.js'
import { HANDBACK_RECENCY_WINDOW_MS } from './subagent-handback-marker.js'
import type { SubagentReplyAuthorityView } from './subagent-reply-authority.js'
import {
  decideAnswerLatchSuppression,
  decideContentGateBypass,
  type ReplyOwnerTier,
  type ReplyOwnerCandidates,
} from '../reply-owner-resolve.js'
import { deriveTelegraphTitle } from '../telegraph.js'
import {
  mayInjectListenButton,
  planListenButton,
  type VoiceOnDemandCache,
} from '../voice-ondemand.js'
import { eagerVoiceEnabled, type PreSynthQueue } from '../voice-presynth.js'
import { validateInlineKeyboard, type AnyButton } from '../telegram-button-constraints.js'
import {
  wrapAgentCallbacks,
  redactAgentKeyboard,
  extractAgentButtonMeta,
  type AgentButtonMeta,
} from '../inline-keyboard-callbacks.js'
import { classifyPhotoFile, rerouteResultSuffix } from '../photo-precheck.js'
import { retryWithThreadFallback, isPhotoDimensionRejectError, type RetryCallOpts } from '../retry-api-call.js'
import { logStreamingEvent } from '../streaming-metrics.js'
import type { RuntimeMetricEvent } from '../runtime-metrics.js'
import {
  settleCapturedProseDelivery,
  silentEndFallbackText,
  type SilentEndDeps,
  type CapturedProseSendOutcome,
} from '../silent-end.js'
import type { OutboundDedupCache } from '../recent-outbound-dedup.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import type { EmissionAuthority } from './emission-authority.js'
import type { ChatKey as _ChatKey } from './inbound-delivery-machine.js'
// Type-only import from the gateway (erased at compile — no runtime cycle):
// CurrentTurn/Access are the gateway's own turn + access.json shapes, so the
// injected closures type EXACTLY as their gateway definitions.
import type { CurrentTurn, Access } from './gateway.js'

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
 * Per-site shape knobs for {@link normalizeOutboundBody}. The reply path (the
 * canonical caller) passes none — the defaults reproduce its exact pre-#3501
 * byte output. The edit_message and turn-flush sites, which used to hand-mirror
 * this pipeline inline, pass these to reproduce their two small deviations:
 *
 *   - `literalText` (edit_message `format:'text'`): a literal edit must land
 *     byte-for-byte as authored, so it SKIPS paragraph-break promotion and the
 *     punctuation/bold/spacer formatting entirely — only the whitespace repair,
 *     the secret redact, and the voice scrub still run (they are safety
 *     transforms that must apply even to literal edits, matching the former
 *     inline `executeEditMessage` order).
 *   - `addSpacers` (edit_message non-literal): the edit path folds the
 *     idempotent U+00A0 paragraph spacer INTO this transform
 *     (`addParagraphSpacers(stripExcessBold(normalizePunctuation(…)))`),
 *     whereas the reply/turn-flush paths add spacers separately downstream (or
 *     not at all). Setting this reproduces that inline behaviour exactly.
 */
export interface NormalizeOutboundOptions {
  /** Literal edit: skip paragraph-break + punctuation/bold/spacer formatting. */
  literalText?: boolean
  /** Fold `addParagraphSpacers` into the formatting step (edit_message path). */
  addSpacers?: boolean
  /**
   * Agent-configured IANA timezone for the temporal-normalization pass (#3501).
   * When BOTH `tz` and `nowMs` are supplied (callers pass `resolveEnvTimezone()`
   * and `Date.now()`), the seam rewrites UTC/Zulu datetimes to local wall clock
   * and corrects relative-day words against the current date in `tz`. Omitted →
   * the temporal pass is a no-op (keeps the module pure/clock-free by default).
   * NEVER fires on a literal edit (`literalText`) — a literal edit lands
   * byte-for-byte as authored.
   */
  tz?: string
  /** Epoch-ms "now" for the temporal pass. Required alongside `tz` to fire. */
  nowMs?: number
}

/**
 * Stage 1 — the deterministic outbound text transform. This is the SINGLE
 * shared seam for every outbound prose send (#3501): the reply path, the
 * edit_message path, and the turn-flush backstop all route through it instead
 * of hand-mirroring the pipeline inline, so a new outbound transform is added
 * in exactly one place.
 *
 *   1. repairEscapedWhitespace  — undo LLM JSON-escape bungles
 *   2. normalizeParagraphBreaks — promote lone prose breaks to GFM hard breaks
 *                                 (skipped for a literal edit)
 *   3. redact (injected)        — outbound secret scrub (#2044), BEFORE the
 *                                 punctuation/bold normalizers so a secret with
 *                                 an em-dash or `**` is matched literally
 *   4. stripExcessBold∘normalizePunctuation — fleet-consistent formatting
 *                                 (optionally wrapped in addParagraphSpacers for
 *                                 the edit path; skipped entirely for a literal
 *                                 edit)
 *   5. scrubVoice               — em/en dash → comma/period (#1683)
 *
 * The order is load-bearing and MUST NOT change (each step's comment in the
 * former inline site documents why). Pure over its arguments.
 */
export function normalizeOutboundBody(
  rawText: string,
  site: string,
  redact: RedactFn,
  opts: NormalizeOutboundOptions = {},
): NormalizeOutboundResult {
  const { literalText = false, addSpacers = false, tz, nowMs } = opts
  let text = repairEscapedWhitespace(rawText)
  if (!literalText) text = normalizeParagraphBreaks(text)
  text = redact(text, site)
  if (!literalText) {
    let formatted = stripExcessBold(normalizePunctuation(text), (d) => {
      // Observability: the over-bold tripwire silently flattened formatting.
      // Emit one diagnostic line naming the rule + measured ratio so a lost
      // reply is traceable (it previously vanished with no signal).
      try {
        process.stderr.write(
          `telegram gateway: strip-excess-bold: fired site=${site} rule=${d.rule} ratio=${d.ratio.toFixed(3)}\n`,
        )
      } catch {
        // stderr write must never break the send path. Swallow.
      }
    })
    if (addSpacers) formatted = addParagraphSpacers(formatted)
    text = formatted
    // Temporal normalization (#3501): UTC/Zulu → local wall clock, then
    // relative-day accuracy, resolved in the agent's configured tz. Runs AFTER
    // punctuation/bold (so masking sees final markdown) and BEFORE the voice
    // scrub (so a freshly-rewritten "Thu 23 Jul 7:15 pm AEST" is never mangled
    // by the em/en-dash scrub). Never on a literal edit. Pure / never-throws.
    if (tz != null && nowMs != null) {
      text = normalizeTemporal(text, tz, nowMs)
    }
  }
  let voiceReplaced = 0
  const scrub = scrubVoice(text)
  if (scrub.replaced > 0) {
    text = scrub.scrubbed
    voiceReplaced = scrub.replaced
  }
  return { text, voiceReplaced }
}

/**
 * Effective-text spacing (#2669 rich-message regression fix, restored after the
 * #3208 F1 misfire). The Bot API 10.1 rich GFM renderer (and the in-repo IR
 * renderer that feeds it) renders a prose `\n\n` gap TIGHT, so paragraphs render
 * jammed together. Inject a visible U+00A0 blank-line spacer into each block
 * gap on the rich path only (idempotent — see addParagraphSpacers); the literal
 * (`format:'text'`) path stays byte-exact. Pure.
 */
export function computeEffectiveText(text: string, literalText: boolean): string {
  return literalText ? text : addParagraphSpacers(text)
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
    //
    // #4043: chunks were split for the RICH cap (up to RICH_MESSAGE_MAX_CHARS =
    // 32768), but this fallback ships them through the PLAIN `sendMessage`
    // endpoint, which caps at 4096. Without a re-cap, the rescue send itself
    // 400s with `message is too long` and the answer vanishes — the exact
    // failure the fallback exists to prevent. Re-cap at safe boundaries first.
    //
    // Per-piece trailers: `opts` was built for ONE message, so shipping it
    // verbatim to every piece duplicates the MESSAGE-scoped params.
    //   - `reply_markup` (an inline keyboard) would render a LIVE button on
    //     every piece. `single_use` only strips the keyboard from the message
    //     that was tapped, so the user can fire the same action N times. It
    //     rides the FINAL piece only — the same treatment the sweep's own
    //     fallback applies (`outbox-sweep.ts` `sendChunkRich`/`withoutMarkup`),
    //     and the same message the caller attached it to (the last chunk).
    //   - `reply_parameters` would quote-reply from every piece. Only the
    //     FIRST piece quotes, matching the caller's `replyMode !== 'all'`
    //     rule that quotes chunk 0 only.
    // Thread / link-preview / protect_content / disable_notification are
    // per-message policy and correctly ride every piece, unchanged.
    const sendChunkPlainText = async (opts: Record<string, unknown>): Promise<void> => {
      const plain =
        chunks[i].length > 0
          ? chunks[i]
          : '⚠️ (a fragment could not be rendered for Telegram)'
      const pieces = splitPlainTextToCap(plain)
      const pieceOpts = (p: number): Record<string, unknown> => {
        // Single piece ⇒ it is both first and final; pass `opts` through
        // byte-identically so the non-split path stays exactly as it was.
        if (pieces.length === 1) return opts
        const o = { ...opts }
        if (p !== pieces.length - 1) delete o.reply_markup
        if (p !== 0) delete o.reply_parameters
        return o
      }
      for (let p = 0; p < pieces.length; p++) {
        const sent = await deps.sendLiteralRaw(pieceOpts(p), pieces[p])
        sentIds.push(sent.message_id)
        deps.logOutbound(
          'reply',
          chatId,
          sent.message_id,
          pieces[p].length,
          pieces.length > 1
            ? `chunk=${i + 1}/${chunks.length} plaintext-fallback piece=${p + 1}/${pieces.length}`
            : `chunk=${i + 1}/${chunks.length} plaintext-fallback`,
        )
      }
      deps.stderr(
        `telegram gateway: markdown parse-reject — resent chunk ${i + 1}/${chunks.length} as plain text` +
          (pieces.length > 1 ? ` in ${pieces.length} piece(s) (4096-char plain cap)` : '') +
          `\n`,
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
      } else if (isQuoteRejectionError(err) && sendOptsHaveQuote(sendOpts)) {
        // Surgical-quote rejection: the quote must be an EXACT substring of the
        // message being replied to, and Telegram 400s when it isn't found (a
        // model paraphrase, a re-rendered fragment, an emoji/entity mismatch).
        // That is a failure of the HIGHLIGHT, not of the answer — so drop the
        // quote and land the reply as an ordinary reply to the same message,
        // rather than throwing the composed answer away.
        const retryOpts = dropQuoteFromSendOpts(sendOpts)
        const sent = await sendChunk(retryOpts, false)
        sentIds.push(sent.message_id)
        deps.logOutbound('reply', chatId, sent.message_id, chunks[i].length, `chunk=${i + 1}/${chunks.length} quote-dropped`)
        deps.stderr(
          `telegram gateway: quote not found in the replied-to message — resent chunk ${i + 1}/${chunks.length} without the quote\n`,
        )
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

// ─── Read-back confirmation probe (#3278) ─────────────────────────────────
//
// A returned message_id proves Telegram ACCEPTED a send, not that the message
// is VISIBLE: a server-side accept-then-silently-discard (flood/anti-spam)
// returns a fresh id yet the user sees nothing. The only echo primitive the Bot
// API offers (there is no getMessage) is a no-op `editMessageText` against the
// returned id — a `400 message to edit not found` proves absence, an edit-ok /
// `message is not modified` proves presence. This primitive classifies that
// probe per id and combines a chunk's ids into one verdict; the backstop
// delivery orchestrator (`runBackstopDelivery`) consumes the verdict to decide
// confirm / demote-and-re-send / leave-unconfirmed. Scoped to the RARE backstop
// path only — the hot reply-tool send path issues ZERO probes (#3278 §1.3/§1.5).

/**
 * Classify a single-id read-back `editMessageText` FAILURE into a
 * {@link ReadBackResult}. Pure over the thrown error:
 *  - `400 message to edit not found` ⇒ `absent`   (positive drop → safe re-send)
 *  - `400 message is not modified`   ⇒ `exists`   (a no-op edit → message present)
 *  - anything else (429 / 5xx / network / thread-not-found / parse) ⇒ `ambiguous`
 *    (never re-send — a re-send would risk a duplicate).
 *
 * A read-back that RESOLVES (the edit applied) means the message existed and is
 * classified `exists` by the caller — this helper only maps the error branch.
 */
export function classifyReadBackError(err: unknown): ReadBackResult {
  if (err instanceof GrammyError && err.error_code === 400) {
    const d = (err.description || '').toLowerCase()
    if (d.includes('message to edit not found')) return 'absent'
    if (d.includes('not modified')) return 'exists'
  }
  return 'ambiguous'
}

/** Injected per-id probe for {@link createBackstopReadBackProbe}. Resolves to the
 *  chunk-id's {@link ReadBackResult} — the gateway wires this to a no-op
 *  `editMessageText` paced through the send gate (cosmetic priority, so it sheds
 *  under a flood window and never storms); a test supplies a scripted fake. */
export interface BackstopReadBackDeps {
  /** Probe ONE landed message id (edit it to `body`, its identical rich render). */
  probeId: (messageId: number, body: unknown) => Promise<ReadBackResult>
  /** rich-markdown wrapper (`richMessage`) — the probe edits to the SAME body the
   *  chunk was sent with, so an existing message returns "not modified" (no
   *  visible mutation) rather than actually changing the delivered answer. */
  richMessage: (s: string) => unknown
}

/**
 * Build the `readBack` dep injected into `runBackstopDelivery` (#3278). For each
 * landed chunk it probes EVERY message id (a length-resplit chunk lands >1) and
 * combines them (guard A7 — the chunk is confirmed only if ALL ids exist; ANY
 * positive absence ⇒ re-send the whole chunk). An empty id set is `ambiguous`
 * (nothing to probe → fabricate neither a confirmation nor a demotion).
 */
export function createBackstopReadBackProbe(
  deps: BackstopReadBackDeps,
): (chunkIndex: number, messageIds: readonly number[], text: string) => Promise<ReadBackResult> {
  return async (_chunkIndex, messageIds, text) => {
    if (messageIds.length === 0) return 'ambiguous'
    const body = deps.richMessage(text)
    const perId: ReadBackResult[] = []
    for (const id of messageIds) {
      perId.push(await deps.probeId(id, body))
    }
    return combineReadBackResults(perId)
  }
}

/** Injected wiring for {@link createBackstopReadBack}. The gateway supplies its
 *  raw send primitives; a test can drive the whole probe with fakes. */
export interface BackstopReadBackWiring {
  /** Raw `editMessageText` with the chat_id baked in by the caller — edits the
   *  message to `body` with `apiOpts`; resolves grammy's result or throws the
   *  raw grammy error (NOT swallowed, so not-found/not-modified stay
   *  distinguishable via {@link classifyReadBackError}). */
  editMessageText: (messageId: number, body: unknown, apiOpts: unknown) => Promise<unknown>
  /** Send-gate wrapper — the probe routes through it at COSMETIC priority so it
   *  sheds under a flood window (never storms) and paces like every other send. */
  gate: <T>(fn: () => Promise<T>, opts: RetryCallOpts) => Promise<T>
  /** `SEND_GATE_SHED` sentinel detector: a shed probe is `ambiguous` (never a
   *  re-send), NOT a false `exists`. */
  isShed: (r: unknown) => boolean
  /** rich-markdown wrapper (`richMessage`). */
  richMessage: (s: string) => unknown
  chatId: string
  threadId: number | undefined
}

/**
 * Build the complete #3278 `readBack` dep for `runBackstopDelivery`, owning the
 * per-id probe: a no-op `editMessageText` to the message's IDENTICAL body,
 * paced cosmetic through the send gate. A resolved edit (or a `not modified`
 * 400) ⇒ `exists`; a `message to edit not found` 400 ⇒ `absent`; a gate shed,
 * 429/5xx/network, or any other throw ⇒ `ambiguous` (never re-send). Per-chunk
 * ids are combined by {@link createBackstopReadBackProbe} (guard A7).
 */
export function createBackstopReadBack(
  w: BackstopReadBackWiring,
): (chunkIndex: number, messageIds: readonly number[], text: string) => Promise<ReadBackResult> {
  const probeId = async (messageId: number, body: unknown): Promise<ReadBackResult> => {
    // Match the SEND's link_preview_options so editing to the identical body is
    // a genuine no-op ("message is not modified") and never visibly mutates the
    // delivered answer. editMessageText targets a globally-unique message_id, so
    // no message_thread_id is needed on the edit itself.
    const editApiOpts = { link_preview_options: { is_disabled: true } }
    // Retry/gate metadata (RetryCallOpts) — keys the gate's per-message edit
    // floor + cosmetic shedding; NOT sent to Telegram as API params.
    const gateOpts: RetryCallOpts = {
      chat_id: w.chatId,
      verb: 'backstop.readback',
      priorityClass: 'cosmetic',
      messageId,
      editPayload: body,
      ...(w.threadId != null ? { threadId: w.threadId } : {}),
    }
    try {
      const r = await w.gate(() => w.editMessageText(messageId, body, editApiOpts), gateOpts)
      // A shed resolves the SEND_GATE_SHED sentinel; a gate no-op drop (the
      // identical payload is already the last one sent for this message id) or
      // an expired queue entry resolves `undefined`. In BOTH cases the edit
      // never reached Telegram, so there is no evidence of existence —
      // `ambiguous`, never a fabricated `exists`. Only a real API result
      // (grammy resolves `true` or the edited Message) proves presence.
      if (w.isShed(r) || r === undefined) return 'ambiguous'
      return 'exists'
    } catch (err) {
      return classifyReadBackError(err)
    }
  }
  return createBackstopReadBackProbe({ probeId, richMessage: w.richMessage })
}

// ─── Send-orchestration façade (#2996 P2, Amendments 9/10) ────────────────
//
// `executeReply`'s full orchestration body and the `deliverCapturedProse`
// silent-end-recovery send path, relocated VERBATIM from gateway.ts so the
// send path is one invocable, testable primitive (see
// send-reply-golden.test.ts). gateway.ts keeps thin wrappers that pin the
// turn at entry and inject the live singletons + closures.
//
// DI contract (plan Amendment 9 — supersedes the original P2 contract):
//   - `outboundDedup` is THE one live instance (#546 dedup cache). A re-`new`
//     anywhere in this module is a hard review-fail: the stream-render (P4)
//     surface records into the SAME cache, and a second instance reinstates
//     the duplicate-reply class (Amendment 1).
//   - BOTH the entry-pinned turn (`req.turn`, #1664 attribution) AND a live
//     `getCurrentTurn()` accessor are provided. Each call site keeps its
//     original pin-vs-live choice VERBATIM — the live re-reads (over-ping
//     block, card-finalize, silent-anchor, dedup registry keys) are
//     load-bearing: a turn that ends mid-send must skip card-finalize.
//     Collapsing to pin-everywhere is a forbidden behavior change.
//   - `backstopDeliveryLedger` and `sendGate` are deliberately NOT injected:
//     0 references in this body (the ledger is the P4 stream surface's dep;
//     the send gate lives inside the injected `robustApiCall`).
//   - Pure helpers are IMPORTED; anything stateful, side-effecting, or
//     gateway-configured is INJECTED (so the golden harness can fake it).
//
// The bodies below are byte-identical to the pre-move gateway.ts inline
// bodies except for the 8 enumerated pin-vs-live spellings
// (`currentTurn` -> `getCurrentTurn()` / `req.turn` /
// `getLastActiveTurnChatId()`) and the deps destructure preamble. Do not
// "clean up" while moving — bugfixes ship as separate PRs.

/** The subset of the gateway's voice-out plan the send path consumes. */
export interface VoiceOutPlan {
  engine: 'kokoro' | 'openai'
  voice?: string
  speed: number
  apiKeyRef?: string
  replyMode: 'voice+text' | 'voice-only' | 'on-demand'
  ttsChunks: string[]
}

/**
 * Resolve the Buzz-mirror NIP-10 antecedent key for an outbound answer, or
 * `undefined` to mirror FLAT. Pure + deterministic so the gating is testable
 * without the full send harness. Returns `${chatId}:${replyTo}` only when a
 * genuine, renderable reply antecedent exists; `undefined` when:
 *  - there is no antecedent (`replyTo == null`), or
 *  - `replyTo` is not a finite number (a non-numeric model `reply_to` coerces to
 *    `NaN`; #4301 — never build a bogus `chat:NaN` key the mirror logs as a
 *    real miss), or
 *  - `replyMode === 'off'` (#4300 — the Telegram copy renders NO reply, so the
 *    Buzz mirror must stay flat too; without this the Buzz copy visibly threads
 *    while the Telegram copy does not — a surface divergence).
 */
export function resolveMirrorAntecedentKey(
  chatId: string,
  replyTo: number | undefined,
  replyMode: string,
): string | undefined {
  if (replyTo == null || !Number.isFinite(replyTo) || replyMode === 'off') {
    return undefined
  }
  return `${chatId}:${replyTo}`
}

export interface SendReplyRequest {
  /** Raw `reply` tool args, exactly as the MCP dispatch received them. */
  args: Record<string, unknown>
  /** #1664 — the turn pinned at executeReply entry by the gateway wrapper.
   *  Late writes (finalAnswerDelivered) attribute to THIS turn even if the
   *  module-scope turn rolls over mid-call. */
  turn: CurrentTurn | null
  /** #4172 — true when the calling IPC client is NOT the main agent bridge
   *  (`replyCallerIsForeignSession`, cron-session.ts): a Tier-1 cheap-cron
   *  session or an unregistered client. A foreign-session reply can never be
   *  the main session's own late answer, so the flushed-turn
   *  supersede/bypass/latch block is skipped wholesale — it always sends
   *  FRESH (never edits/deletes a flushed answer, never gets latch-
   *  suppressed). Omitted/false ⇒ main-bridge caller (the gateway's
   *  `executeReply` always passes the computed value; the default only
   *  affects test harnesses). */
  callerIsForeignSession?: boolean
}

/** Gateway dependencies for {@link sendReply}. Function members use method
 *  syntax deliberately (bivariant) so the gateway's more-precisely-typed
 *  closures are assignable without adapter noise. */
export interface SendReplyGatewayDeps {
  // ── shared singletons — the ONE live instance each (Amendment 1/9) ──
  outboundDedup: OutboundDedupCache
  flushedTurnSupersede: FlushedTurnSupersedeRegistry
  firstTextReplyLogged: Set<string>
  suppressPtyPreview: Set<string>
  activeDraftStreams: Map<string, DraftStreamHandle>
  lastPtyPreviewByChat: Map<string, string>
  voiceOnDemandCache: VoiceOnDemandCache
  voicePreSynthQueue: PreSynthQueue
  /** cross-turn pending-async ambient ticker (module-singleton namespace). */
  pendingProgress: {
    clearPending(key: string, reason: string): void
    noteOutbound(key: string, anchor: { messageId: number; text: string; literalText: boolean }): void
  }
  /** outbound-gap / TTFO KPI tracker (module-singleton namespace). */
  signalTracker: {
    noteOutbound(key: string, at: number): void
    noteSignal(key: string, at: number): void
  }
  /** silence-poke clock (module-singleton namespace). */
  silencePoke: { noteOutbound(key: string, at: number): void }

  // ── turn identity (Amendment 9: pin-vs-live preserved per call site) ──
  getCurrentTurn(): CurrentTurn | null
  getLastActiveTurnChatId(): string | undefined

  // ── gateway config values ──
  HISTORY_ENABLED: boolean
  TURN_ORIGIN_ROUTING_ENABLED: boolean
  AUTOCLASSIFY_MIDTURN_SHADOW: boolean
  MAX_ATTACHMENT_BYTES: number
  MAX_CHUNK_LIMIT: number
  PHOTO_EXTS: Set<string>

  // ── bot + retry policy (the send gate lives inside robustApiCall) ──
  lockedBot: Bot<Context>
  robustApiCall<T>(fn: () => Promise<T>, opts?: RetryCallOpts): Promise<T>
  swallowingApiCall(fn: () => Promise<unknown>, meta: RetryCallOpts): Promise<unknown>

  // ── gateway closures ──
  loadAccess(): Access
  redactOutboundText(text: string, site: string): string
  assertAllowedChat(chatId: string | number): void
  assertSendable(f: string): void
  statusKey(chatId: string, threadId?: number | null): string
  streamKey(chatId: string, threadId?: number | null): string
  /** Resolves the owner turn AND returns the CANDIDATE SET it was derived from.
   *  The candidates are load-bearing, not diagnostics: `decideContentGateBypass`
   *  corroborates a model-steerable `origin`/`quoted` attribution against the
   *  framework-derived `latestEndedTurnId` inside them before allowing a
   *  content-gate bypass — an anchor that is an ENDED turn within the supersede
   *  TTL, never one still running (#3725). */
  resolveReplyOwnerTurn(liveTurn: CurrentTurn | null, chatId: string, args: Record<string, unknown>): { turn: CurrentTurn | null; tier: ReplyOwnerTier; candidates: ReplyOwnerCandidates }
  findTurnByOriginId(originTurnId: string | null | undefined): CurrentTurn | null
  findTurnByQuotedMessageId(chatId: string, replyTo: unknown): CurrentTurn | null
  /** Buzz co-channel Phase 2b (S1) — the same chat-wide latest-ended lookup the
   *  owner-resolution wiring uses. Read here ONLY to compute the S1 owner-guard
   *  input `hasRecentDifferentOriginTurn`; a no-op when Buzz mirroring is off. */
  findLatestTurnForChat(chatId: string, opts: { endedOnly: boolean }): CurrentTurn | null
  resolveAnswerThreadWithLog(
    chatId: string,
    explicitThreadId: number | undefined,
    originTurn: CurrentTurn | null,
    originVia: 'echo' | 'quoted' | null,
    liveTurn: CurrentTurn | null,
    surface: 'reply' | 'stream_reply',
  ): number | undefined
  resolveThreadId(chatId: string, explicit?: string | number | null): number | undefined
  getLatestInboundMessageId(chatId: string, threadId: number | null): number | null | undefined
  getLastSubagentHandbackAt(chatId: string): number | null
  /** #4176 — gateway-observed sub-agent liveness (`subagentReplyAuthority`,
   *  subagent-reply-authority.ts). A background `Task` sub-agent replies over
   *  THIS bridge, so neither the #4172 caller-identity gate nor the handback
   *  marker can see it; while one is live the content-gate bypass is refused so
   *  a sub-agent's reply can never edit over a flushed answer. */
  subagentReplyAuthority: SubagentReplyAuthorityView
  recordOutbound(rec: {
    chat_id: string
    thread_id: number | null
    message_ids: number[]
    texts: string[]
    attachment_kinds?: (string | null)[]
  }): void
  emissionAuthorityFor(turn: CurrentTurn): EmissionAuthority
  clearActivitySummary(turn: CurrentTurn, finalHtmlOverride?: string | null): void
  startTypingLoop(chatId: string, threadId?: number | null): void
  stopTypingLoop(chatId: string, threadId?: number | null): void
  logOutbound(
    path: 'reply' | 'edit',
    chatId: string,
    messageId: number | null,
    chars: number,
    extra?: string,
  ): void
  closeObligationOnSubstantiveReply(
    args: Record<string, unknown>,
    liveTurn: CurrentTurn | null | undefined,
    routedOriginTurn?: CurrentTurn | null,
  ): void
  finalizeStatusReaction(chatId: string, threadId: number | undefined, outcome: 'done'): void
  releaseTurnBufferGate(key: string, endingTurn?: CurrentTurn): void
  reapQueuedStatus(chatId: string, thread: number | undefined): void
  noteAgentOutputAt(key: string, ts: number): void
  rememberAgentButtonMeta(chatId: string | number, messageId: number, meta: Map<string, AgentButtonMeta>): void
  resolveVoiceOutPlan(voiceOut: Access['voice_out'], replyText: string): VoiceOutPlan | null
  synthesizeVoiceOut(plan: {
    engine: 'kokoro' | 'openai'
    voice?: string
    speed?: number
    apiKeyRef?: string
    ttsText: string
  }): Promise<Uint8Array | null>
  publishToTelegraph(text: string, shortName: string, authorName?: string): Promise<string | null>
  clearSilentEndState(key: string): void
  emitRuntimeMetric(m: RuntimeMetricEvent): void
  shadowEmit(ev: { kind: 'modelOutbound'; key: _ChatKey; at: number }): void
  progressDriver: { recordOutboundDelivered(chatId: string, threadId?: string): void } | null
}

/**
 * The reply send orchestration — `executeReply`'s body, verbatim.
 * See the section comment above for the DI contract and the enumerated
 * verbatim deviations.
 */
export async function sendReply(
  deps: SendReplyGatewayDeps,
  req: SendReplyRequest,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    outboundDedup, flushedTurnSupersede, firstTextReplyLogged, suppressPtyPreview,
    activeDraftStreams, lastPtyPreviewByChat, voiceOnDemandCache, voicePreSynthQueue,
    pendingProgress, signalTracker, silencePoke,
    getCurrentTurn, getLastActiveTurnChatId, progressDriver,
    HISTORY_ENABLED, TURN_ORIGIN_ROUTING_ENABLED, AUTOCLASSIFY_MIDTURN_SHADOW,
    MAX_ATTACHMENT_BYTES, MAX_CHUNK_LIMIT, PHOTO_EXTS,
    lockedBot, robustApiCall, swallowingApiCall,
    loadAccess, redactOutboundText, assertAllowedChat, assertSendable,
    statusKey, streamKey,
    resolveReplyOwnerTurn, findTurnByOriginId, findTurnByQuotedMessageId, findLatestTurnForChat,
    resolveAnswerThreadWithLog, resolveThreadId,
    getLatestInboundMessageId, getLastSubagentHandbackAt, subagentReplyAuthority, recordOutbound,
    emissionAuthorityFor, clearActivitySummary,
    startTypingLoop, stopTypingLoop, logOutbound,
    closeObligationOnSubstantiveReply, finalizeStatusReaction,
    releaseTurnBufferGate, reapQueuedStatus, noteAgentOutputAt,
    rememberAgentButtonMeta, resolveVoiceOutPlan, synthesizeVoiceOut,
    publishToTelegraph, clearSilentEndState, emitRuntimeMetric, shadowEmit,
  } = deps
  const args = req.args
  // #1664 — pin the turn this reply belongs to at entry. The
  // finalAnswerDelivered write near the end of this function runs after
  // several awaits; turn-pinning (the #1067 pattern used across the
  // gateway) keeps the write attributed to THIS turn rather than reading
  // module-scope currentTurn, which a future refactor could let roll over
  // mid-call. (#2996 P2: the pin is taken by the gateway wrapper at call
  // entry and passed in `req.turn` — same read, same position.)
  const turn = req.turn
  const _rawChatId = String(args.chat_id ?? '')
  if (!_rawChatId) throw new Error('reply: chat_id is required')
  // Non-Claude models (e.g. Gemini via LiteLLM sr-* routing) sometimes pass a
  // chat_id that is not in the allowlist — either an int/string mismatch, or
  // the model echoing the wrong identifier from context. When the raw value
  // fails the allowlist check, fall back to the active (or last-known) turn's
  // validated sessionChatId so the reply still lands correctly.
  // Tier 1: live turn (currentTurn was non-null at reply entry).
  // Tier 2: last-known turn (survives silence poke — Bug D fix; currentTurn is
  //   null because clearTurnStarted fired ≥5 min of model silence, but the model
  //   finally called reply after the poke).
  const chat_id = (() => {
    const resolved = resolveChatIdFallback(
      _rawChatId,
      loadAccess(),
      turn?.sessionChatId,
      getLastActiveTurnChatId(),
      turn != null,
    )
    if (resolved.tier !== 'raw') {
      process.stderr.write(
        `telegram gateway: reply: model passed chat_id "${_rawChatId}" (not allowlisted) — ` +
          `routing to ${resolved.tier} turn chat "${resolved.chatId}"\n`,
      )
    }
    return resolved.chatId // raw tier → let assertAllowedChat throw the human-readable error
  })()
  const rawText = args.text as string | undefined
  if (rawText == null || rawText === '') throw new Error('reply: text is required and cannot be empty')
  // Repair LLM JSON-escape bungles, then promote lone prose paragraph breaks
  // into GFM hard breaks so the rich path doesn't collapse them (lists/tables/
  // code are left untouched — see normalizeParagraphBreaks).
  // Outbound text pipeline (#2996 §3B): normalize → redact → punctuation/bold
  // → voice-scrub, extracted verbatim into outbound-send-path.ts. The order is
  // load-bearing (secret scrub BEFORE the punctuation/bold normalizers so a
  // secret with an em-dash or `**` is matched literally; voice scrub last so
  // retries see the scrubbed dedup key). The metric side effect (fired on a
  // non-zero voice-scrub replacement) stays here — the pure module returns the
  // replacement count and the gateway emits.
  const _normalized = normalizeOutboundBody(rawText, 'reply', redactOutboundText, {
    tz: resolveEnvTimezone(),
    nowMs: Date.now(),
  })
  let text = _normalized.text
  if (_normalized.voiceReplaced > 0) {
    emitRuntimeMetric({
      kind: 'voice_scrub_applied',
      chatKey: statusKey(chat_id, args.message_thread_id != null
        ? Number(args.message_thread_id) : undefined),
      replaced: _normalized.voiceReplaced,
      site: 'reply',
    })
  }
  process.stderr.write(`telegram channel: reply: invoked chatId=${chat_id} charCount=${text.length} preview=${JSON.stringify(text.slice(0, 80))}\n`)
  // #2527: emit time_to_first_text_reply_ms on the FIRST text reply of each
  // turn so operators can see how long users waited for any visible output.
  // Only fires once per turn (firstTextReplyLogged guards the repeat).
  if (turn != null) {
    const threadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
    const replyKey = statusKey(chat_id, threadId)
    if (!firstTextReplyLogged.has(replyKey)) {
      firstTextReplyLogged.add(replyKey)
      logStreamingEvent({
        kind: 'turn_reply_timing',
        chatId: chat_id,
        threadId,
        turnId: turn.turnId,
        timeToFirstTextReplyMs: Date.now() - turn.gatewayReceiveAt,
      })
    }
  }

  // #546 dedup check: was this content just sent via turn-flush or
  // a sibling reply path? Skip the actual send and return a
  // plausible tool result so claude-code's retry loop closes
  // cleanly. NOTE: only fires when content matches; legitimate
  // late-replies with different content sail through.
  {
    const replyThreadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
    const dup = outboundDedup.check(chat_id, replyThreadId, text, Date.now(), getCurrentTurn()?.registryKey ?? null)
    if (dup != null) {
      process.stderr.write(
        `telegram gateway: reply: deduped (#546) chatId=${chat_id} ` +
        `ageMs=${dup.ageMs} preview=${JSON.stringify(dup.preview)}\n`,
      )
      return { content: [{ type: 'text', text: 'sent (deduped — same content sent via earlier path)' }] }
    }
  }

  // 2026-07 duplicate-reply fix — turnId-keyed supersede (consumption side).
  // If an earlier turn-flush (answer-ready quiescence OR the turn-end backstop)
  // already posted THIS turn's terminal text and the model's REAL `reply` for
  // the same turn is landing now (it was still composing the tool call when the
  // flush fired, or claude-code replayed the tool_call after a bridge
  // reconnect), delete the flushed message(s) so the canonical reply below
  // delivers exactly one clean message instead of a second one. Keyed on the
  // per-turn `turnId` nonce, so it fires even when the flushed narration+answer
  // blob differs from the clean answer-only reply — the containment case the
  // exact-text `outboundDedup` above structurally cannot catch. A reply for a
  // DIFFERENT newer live turn never supersedes (decideSupersede → different-turn),
  // so a fresh turn's answer is never clobbered.
  //
  // Reply-flicker fix: rather than delete the flushed message(s) HERE (which
  // makes the user see delete+replace when the canonical reply sends fresh
  // below), we DEFER the correction to the send site. Once chunk count / files /
  // preview are known, `decideSupersedeCorrection` picks edit-in-place (edit the
  // single flushed message into the canonical reply — no flicker, no re-ping)
  // when the reply fits one plain-text message, and falls back to the legacy
  // delete+resend otherwise. `supersedeFlushIds` carries the ids forward.
  let supersedeFlushIds: number[] = []
  // #4172 — caller-identity gate, BEFORE any owner attribution. A reply from a
  // foreign session (a Tier-1 cheap-cron bridge, or an unregistered client)
  // can never be the main session's own late/reworded answer, so it gets NO
  // supersede authority (it must never edit/delete a flushed answer — the
  // measured #4172 double loss), NO content-gate bypass, and NO exposure to
  // the answer-delivered latch (which could otherwise silently swallow a cron
  // digest landing in the flush's pre-record race window). It simply sends
  // fresh below, leaving any flush record intact for the genuine own-replay.
  if (req.callerIsForeignSession === true) {
    process.stderr.write(
      `telegram gateway: reply: foreign-session caller — supersede/latch skipped (#4172) ` +
      `chatId=${chat_id}\n`,
    )
  } else {
    const replyThreadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
    // 2026-07 double-reply-on-DM fix (Part 1) — resolve the turn this reply
    // belongs to by IDENTITY, via the SAME full chain the thread-router uses
    // (`resolveReplyOwnerTurn`): live `currentTurn`, then the model-echoed
    // `origin_turn_id`, then the framework-owned quoted message id, then the
    // chat's most-recently-ended turn. The prior chain stopped at
    // `currentTurn ?? findTurnByOriginId`, so a DM late reply — `currentTurn`
    // nulled by the flush's synthetic turn_end AND no `origin_turn_id` (a
    // supergroup-only field) — resolved to a null owner. `decideSupersede`
    // deliberately never lets a null live turn supersede a turnId-bearing flush
    // record, so message A survived AND the reply shipped message B (the exact
    // double-send). The quoted / latest-ended recoveries are precisely what the
    // router already did for the same reply, so unifying here makes the two
    // resolvers agree and the late-reply supersede fires by identity.
    const {
      turn: ownerTurn,
      tier: ownerTier,
      candidates: ownerCandidates,
    } = resolveReplyOwnerTurn(turn, chat_id, args)
    const resolvedTurnId = ownerTurn?.turnId ?? null
    // #3429 — pass the (normalized) reply text so the registry CAN apply the
    // new-content gate: identity match + TTL alone also fits a background
    // sub-agent handback that merely resolved this flush-delivered ENDED turn as
    // its owner via the latest-ended tier. Editing/deleting the flushed message
    // for that handback's unrelated text is the #3429 silent client-side drop
    // (msgs 10482/10486). But that gate ALSO declines the turn's OWN reworded
    // late reply (model narrated → flushed → fired `reply` with a paraphrase),
    // which is the dominant real duplicate (agent:marko 2026-07-20: 11/11
    // declines were own-replies, turns #1177/#1182/#1201 double-sent). So we
    // BYPASS the content gate ONLY when the reply is confidently the flushed
    // turn's OWN answer. The primary, deterministic signal is the absence of a
    // background sub-agent handback that could own this reply: the gateway
    // records when it synthesizes a `subagent_handback` inbound per chat, and if
    // NONE was enqueued for this chat AFTER the flushed turn ended within the
    // supersede TTL, the reply is that turn's own answer → supersede regardless
    // of a model rewording (closes the DM default-reply duplicate, where every
    // own-reply resolves via the latest-ended tier).
    //
    // MUST-FIX 1 (silent-data-loss): the owner-resolution `quoted` / `origin`
    // tiers are derived from MODEL-SUPPLIED args (`args.reply_to` /
    // `args.origin_turn_id`), so a reply can STEER itself — pass
    // `reply_to = <another ended turn's source msg>` and it resolves THAT turn via
    // `quoted`. Marker-absence proves "own answer" ONLY for the framework-derived
    // `latest-ended` tier; a model-steered `quoted`/`origin` attribution with no
    // marker is NOT evidence of ownership, so bypassing the content gate there
    // silently edits over a different ended turn's delivered answer (the #3429
    // double-loss, executed by Fable 2026-07-21). The `replyIsOwnAnswer`
    // computation below therefore restricts the bypass to `live` + `latest-ended`;
    // `quoted`/`origin` ALWAYS traverse the content gate. See that comment.
    //
    // The content gate is therefore kept whenever a decoupled completion WAS
    // enqueued in the window (on the latest-ended tier) OR the reply resolved via
    // a model-steerable tier: the late reply might carry foreign content, so it
    // sends fresh (two messages, #3429 preserved). Concurrency note: a case-A own
    // reply coinciding with an unrelated background handback in the same ≤TTL
    // window degrades to two messages — safe (never a silent drop/edit).
    const ownerEndedAt = ownerTurn?.endedAt ?? null
    // MUST-FIX 2 (dup-audit / Fable 2026-07-21) — key BOTH the supersede lane and
    // the marker-gate read on the FRAMEWORK-resolved thread (the owner turn's
    // `sessionThreadId` — the lane the flush recorded on), NOT the raw model arg
    // `args.message_thread_id` (`replyThreadId`). The flush records on
    // `turn.sessionThreadId`; the owner turn resolved here IS that turn, so its
    // thread is where its record and its handback marker live. Reading the gate on
    // the raw arg let a reply carry `message_thread_id=<other topic>` to dodge a
    // handback marker stamped on the real topic → silent edit-over (the regression
    // F2's raw-arg keying introduced). The owner turn's thread is not model-
    // derived, so it cannot be steered. Falls back to the raw arg only when no
    // owner turn resolved (no record to clobber on the collapse path).
    const gateThreadId = ownerTurn?.sessionThreadId ?? replyThreadId
    // MUST-FIX 2 (dup-audit / Fable) — the content-gate READ is CHAT-WIDE, not
    // lane-specific: `findLatestTurnForChat` resolves owners chat-wide, so a
    // handback in topic A can supersede topic B's ended turn; a thread-keyed gate
    // read (the F2 regression) let a reply dodge that handback by carrying a
    // different `message_thread_id`. Chat-wide makes the gate un-steerable — any
    // in-window handback in the chat keeps the content gate (accepting the F2
    // visible-dup in the overlap window; a self-healing dup beats a silent loss).
    // The supersede `take()` LANE below stays thread-resolved (`gateThreadId` =
    // the owner turn's framework thread, not the raw arg), so a handback's
    // correction only ever touches ITS OWN topic's record.
    const handbackAt = getLastSubagentHandbackAt(chat_id)
    const now = Date.now()
    // #4174 — the handback gate-hold keeps its OWN ~60 s bound
    // (`HANDBACK_RECENCY_WINDOW_MS`), deliberately NOT the supersede window's:
    // this read is CHAT-WIDE, so a longer bound would hold the content gate —
    // and re-open the reworded-own-answer visible-dup class — for every topic
    // in a delegation-heavy chat, near-continuously. Rationale on the constant.
    const handbackCouldOwnReply =
      handbackAt != null &&
      ownerEndedAt != null &&
      handbackAt > ownerEndedAt &&
      now - handbackAt <= HANDBACK_RECENCY_WINDOW_MS
    // MUST-FIX 1 (silent-data-loss, PROVEN by Fable 2026-07-21) + the 2026-07-27
    // corroboration widening — decided by the pure `decideContentGateBypass` so
    // the gateway runs the exact code the unit tests exercise. The rule, in
    // brief (full rationale on that function):
    //   - `live`   — framework-owned live `currentTurn`; bypasses unconditionally
    //                (`decideSupersede`'s same-turnId check already bars it from
    //                a DIFFERENT ended turn's record).
    //   - `latest-ended` — the ambiguous DM/late-reply fallback the marko fix
    //                needs; bypass ONLY when no decoupled completion is in the
    //                window (marker-absence ⇒ own answer).
    //   - `origin` / `quoted` — MODEL-SUPPLIED attributions, so they bypass ONLY
    //                when CORROBORATED: the turn they resolve must be the same
    //                turn the framework-derived, TTL-bounded `latestEndedTurnId`
    //                resolves (#3725 — that anchor is a genuinely ENDED turn
    //                within the TTL; a turn still RUNNING in this chat is not a
    //                candidate and corroborates nothing), and no handback may be
    //                in the window. A reply that
    //                steers itself onto a DIFFERENT ended turn fails
    //                corroboration and keeps the content gate, so the Fable
    //                silent-edit-over stays closed; a reply that merely echoes
    //                its OWN turn no longer loses the collapse it would have got
    //                by omitting the echo entirely (the observed 2026-07-27
    //                `via=origin` duplicate).
    //
    // #4176 — the SECOND ambiguity, which the marker structurally cannot see. A
    // background `Task` sub-agent (the `researcher`/`reviewer` types hold the
    // full tool set) calls `reply` over THIS bridge, mid-run: the #4172
    // caller-identity gate sees the MAIN agent identity, and a direct tool call
    // never traverses `pendingInboundBuffer.push`, so no handback marker is
    // stamped either. Under the #4173 OPEN window that reply resolves the
    // flush-ended turn at ANY age, so an unguarded bypass supersedes REGARDLESS
    // of content and silently edits the sub-agent's message over the user's
    // flushed answer (the review MAJOR on #4167; pre-existing on main at the
    // 60 s TTL, extended by #4173 to the OPEN cap). Gateway-observed sub-agent
    // liveness is the deterministic discriminator: while one is live the content
    // gate is KEPT, so a reply that IS the flushed answer still collapses and a
    // sub-agent's foreign content ships FRESH (visible, notifying).
    const subagentCouldOwnReply = subagentReplyAuthority.subagentCouldOwnReply()
    const replyIsOwnAnswer = decideContentGateBypass({
      tier: ownerTier,
      resolvedTurnId,
      candidates: ownerCandidates,
      handbackCouldOwnReply,
      subagentCouldOwnReply,
    })
    const decision = flushedTurnSupersede.take(
      chat_id,
      gateThreadId,
      { liveTurnId: resolvedTurnId, replyText: text, positiveAttribution: replyIsOwnAnswer, now },
    )
    if (decision.supersede) {
      process.stderr.write(
        `telegram gateway: reply: superseding flushed turn message(s) ` +
        `chatId=${chat_id} ids=${JSON.stringify(decision.deleteMessageIds)}\n`,
      )
      // Deferred: the correction (edit-in-place vs delete+resend) is decided at
      // the send site once chunk count / files / preview are known.
      supersedeFlushIds = decision.deleteMessageIds
      // Set the answer-delivered latch NOW, at record consumption — BEFORE the
      // arg-validation throws between here and the correction site (file
      // too-large ~L13699, inline_keyboard invalid ~L13782). Without this, a
      // late reply that supersedes a flush AND carries an oversized file /
      // invalid keyboard would throw before the correction runs (message A
      // neither deleted nor edited), the model would retry `reply`, and — the
      // supersede record already consumed by `take()` above — the retry would
      // fall into the else/no-record branch below with no latch set, so
      // suppression wouldn't fire and a fresh B would ship alongside the stale
      // narration A (both visible). Latching here mirrors the else-branch's own
      // `answerDelivered = true` and closes that resurrection window: the retry
      // resolves the same ended owner turn, sees the latch, and is suppressed —
      // exactly one message ever ships. The latch is idempotent and the normal
      // (no-throw) path is unaffected: the correction below still ships B once.
      // Tagged 'flush' (#3426): a flush record existed for this turn (take()
      // just consumed it), so the flushed message A is what the suppression
      // protects against duplicating. #3429: stash the record's flushed text
      // alongside, so the retry's latch check can discriminate by content —
      // the retry of THIS superseding reply matches and stays suppressed, while
      // a later genuinely-new handback does not and delivers.
      if (ownerTurn != null) {
        ownerTurn.answerDelivered = 'flush'
        if (decision.recordText != null) ownerTurn.flushedAnswerText = decision.recordText
      }
    } else {
      // 2026-07 double-reply-on-DM fix (Part 2) — answer-delivered race latch.
      // Supersede found no record. Either there was no flush (normal reply), or
      // the flush FIRED but has not yet recorded its message ids (the residual
      // pre-record race Part 1's supersede cannot reach). The flush sets
      // `answerDelivered = 'flush'` synchronously at fire time (before its
      // async send AND before `record`), and it persists on the ended turn — so
      // when this LATE, substantive reply resolves its owner turn and sees the
      // FLUSH-armed latch, the flush's message A is already on its way out and
      // this reply would ship a duplicate. Suppress it. Scoped to the
      // substantive ≥`FLUSH_SUBSTANTIVE_MIN_CHARS` floor, the late-reply case,
      // AND the 'flush' latch source (#3426) so an interim sub-floor ack, a
      // chunked multi-part answer, a legitimate second in-turn substantive
      // reply (live `currentTurn`), or an async sub-agent handback landing
      // after a reply-delivered turn ended (latch = 'reply') is never
      // suppressed. `isSubstantiveFinalReply` reduces to the ≥200-char test on
      // the `reply` path (no `done`); pass the model's original notification
      // intent to mirror the #2533 decoupling call shape.
      const replySubstantive = isSubstantiveFinalReply({
        text: rawText,
        disableNotification: args.disable_notification === true,
      })
      // #3429 — content evidence for the latch. `'new-content'` is the
      // registry's POSITIVE determination that this reply differs from the
      // flushed answer (record present, identity matched, text did not);
      // otherwise compare against the owner turn's stashed `flushedAnswerText`
      // (covers the post-fire pre-record race window, where no record exists
      // yet but the fire site already stamped what it is delivering). Null —
      // no flushed text to compare — keeps the conservative pre-#3429
      // flush-armed suppression.
      const replyMatchesFlushedAnswer: boolean | null =
        decision.reason === 'new-content'
          ? false
          : ownerTurn?.flushedAnswerText != null
            ? flushedAnswerMatchesReply(ownerTurn.flushedAnswerText, text)
            : null
      const suppressByLatch = decideAnswerLatchSuppression({
        superseded: false,
        replySubstantive,
        isLateReply: turn == null,
        ownerAnswerDelivered: ownerTurn?.answerDelivered ?? false,
        replyMatchesFlushedAnswer,
      })
      if (decision.reason === 'new-content') {
        process.stderr.write(
          `telegram gateway: reply: flush supersede declined — new content (#3429) ` +
          `chatId=${chat_id} ownerTurnId=${JSON.stringify(resolvedTurnId)} ` +
          // WHY the bypass didn't apply — without these two fields the
          // 2026-07-27 duplicate looked like a pure text-matcher failure and
          // took a log-archive dig to attribute to the tier restriction.
          `tier=${ownerTier} latestEnded=${JSON.stringify(ownerCandidates.latestEndedTurnId)} ` +
          `handbackInWindow=${handbackCouldOwnReply} subagentLive=${subagentCouldOwnReply}; sending fresh\n`,
        )
      }
      if (suppressByLatch) {
        process.stderr.write(
          `telegram gateway: reply: suppressed by answer-delivered latch ` +
          `(flush already delivered this turn's answer) chatId=${chat_id} ` +
          `ownerTurnId=${JSON.stringify(resolvedTurnId)}\n`,
        )
        return { content: [{ type: 'text', text: 'sent (deduped — answer already delivered via turn-flush)' }] }
      }
      // A substantive answer is going out via this reply — record it on the
      // owner turn, tagged 'reply' (#3426). The 'reply' tag does NOT trip the
      // late-reply suppression above: a later reply attributed to this turn
      // after it ends (the async sub-agent handback pattern — dispatch, interim
      // ack, turn_end, handback with no live gateway turn) is genuinely new
      // content and must deliver. Byte-identical replays of THIS answer are
      // deduped by the content-keyed #546 cache at the top of this function.
      // Honest bound: the dedup TTL (60 s) is anchored at reply RECORD time,
      // while the latest-ended owner tier's bound is the turn-completion
      // window (#4173), anchored at the turn's OBSERVED real end — later by
      // the reply→turn_end gap. A byte-identical replay landing >60 s after
      // record but still inside that window is evicted from dedup yet still
      // resolves this ended turn, so it now DELIVERS as a duplicate message.
      // Conscious trade: a rare duplicate beats the silent handback drop the
      // boolean latch caused (#3426).
      if (replySubstantive && ownerTurn != null) {
        ownerTurn.answerDelivered = 'reply'
      }
    }
  }

  const files = (args.files as string[] | undefined) ?? []
  const quoteOptIn = args.quote !== false
  // #4368 — the model's reply tool can quote a synthetic inbound (a boot-
  // resume/handback/cron fabricated id at `Date.now()` scale). Route it through
  // the canonical guard so an out-of-int32 anchor is DROPPED (send lands
  // unanchored) rather than 400ing every chunk on `reply_parameters.message_id`.
  // A later `reply_to = latest` (quote-opt-in default) is a Telegram-returned
  // id and needs no re-check. Also closes the pre-existing NaN hole: a non-
  // numeric `reply_to` used to coerce to NaN and still build the anchor.
  let reply_to = parseSourceMessageId(args.reply_to as string | number | null | undefined) ?? undefined
  const protectContent = args.protect_content === true
  const quoteText = args.quote_text as string | undefined
  const access = loadAccess()
  // Outbound TTS plan (PR-C2). Resolved once here (engine gating + mode +
  // plain-text TTS input); synthesis happens just before the send so a
  // voice-only reply can suppress the text chunk loop on success. Voice is
  // fully best-effort — every failure below falls back to the text reply.
  // Raw-corpus capture (TTS redesign PR-0, flag-gated, off by default): `text`
  // here IS Stage A's future input — capture it byte-for-byte BEFORE the
  // resolve call, ahead of any TTS normalisation, so the redesign's property
  // tests can validate against real markdown instead of synthetic fixtures
  // only. See telegram-plugin/gateway/speech-capture.ts.
  captureSpeechText(text)
  const voiceOutPlan = resolveVoiceOutPlan(access.voice_out, text)
  const configParseMode = access.parseMode ?? 'html'
  const format = (args.format as string | undefined) ?? configParseMode
  const disableLinkPreview = args.disable_web_page_preview != null
    ? Boolean(args.disable_web_page_preview)
    : (access.disableLinkPreview ?? true)
  // #1122 conversational pacing: mid-turn updates pass disable_notification:true
  // so only the final answer pings the device. Default false (pings) so
  // existing call-sites and the typical "final answer" reply keep their
  // current behaviour without an explicit flag.
  let disableNotification = args.disable_notification === true
  // #2527/#1664 — the over-ping safety net below may downgrade
  // `disableNotification` ping→silent for ANTI-SPAM (one ping per turn). That
  // delivery-channel decision must NOT pollute final-answer CLASSIFICATION: a
  // final answer the model intended to ping is STILL the final answer even when
  // the framework silences the actual ping. Classify on the model's original
  // intent (what executeReply already does), so an over-ping-silenced
  // final answer sets finalAnswerDelivered=true — fixing both a spurious
  // silent-end re-prompt and a false 'undelivered' (😐) terminal reaction.
  const modelDisableNotification = args.disable_notification === true

  // #1675 over-ping safety net. The conversational-pacing contract
  // (`reference/rfcs/conversational-pacing.md` beat 5) says EXACTLY ONE
  // device ping per turn — the final answer. The model sometimes
  // violates this by sending a substantive answer pinged + a wrap-up
  // ("Delivered all three steps…", "Sent.", or meta-narration) ALSO
  // pinged. Both messages then fire notifications. The fleet UAT on
  // 2026-05-23 reproduced this (Step 3 + Delivered both pinged, two
  // beeps for a turn that should have produced one). Framework owns
  // the safety net: once the turn has emitted ONE pinged reply, every
  // subsequent reply call in the same turn auto-downgrades to silent
  // (disable_notification: true). Model intent ("I want this loud")
  // is honoured for the first ping; subsequent pings are demoted with
  // a stderr log so operators can see the safety net engage.
  //
  // The slot is claimed BEFORE the actual send to keep the logic
  // sequential — a send that fails part-way leaves firstPingAt set
  // and subsequent pings would be silenced. Acceptable trade-off (a
  // failed first ping is an edge case; the alternative — claim after
  // send — races concurrent reply calls).
  // Tracks whether the over-ping safety net coerced this reply
  // from ping→silent. Threaded into the silent-anchor predicate
  // below: a demoted final-answer reply must NOT merge into the
  // silent preamble bubble; it lands as a fresh silent bubble so
  // the user can still find it (see #1674 / silent-anchor follow-up).
  let wasOverPingSuppressed = false
  {
    const turn = getCurrentTurn()
    if (turn != null) {
      const now = Date.now()
      // Notification ownership (R8 / PR-2): on the `reply` path,
      // substantiveness is purely the ≥200-char (or `done`) backstop —
      // `isSubstantiveFinalReply` is `done === true || text.length >= 200`
      // and ignores the notification flag entirely. `reply` carries no
      // `done`, so it reduces to the ≥200-char length test. We still pass
      // `modelDisableNotification` (the MODEL's original intent, not the
      // possibly-downgraded `disableNotification`) to mirror the #2533
      // final-answer decoupling call shape, but that arg does NOT
      // participate in classification here — it is inert on this path.
      const replySubstantive = isSubstantiveFinalReply({
        text: rawText,
        disableNotification: modelDisableNotification,
      })
      // PR-4c: the over-ping DECISION relocates into the emission-authority
      // façade, behind the kill-switch (default OFF), the same structural way
      // PR-4b moved the OPEN gate. `decideOverPing` is already pure, so PR-4c
      // extracts NOTHING new — it relocates the *call* into the façade's enabled
      // branch and keeps the *effects* (stderr, metric, the atomic
      // `firstPingAt`/`firstPingWasSubstantive` pair-set, the
      // `disableNotification`/`wasOverPingSuppressed` outer-scope writes) HERE,
      // parameterized by the decision the façade hands back via `applyDecision`.
      //
      //  - Disabled branch runs `disabledOverPing()` — its own LITERAL
      //    `decideOverPing(...)` call + the full effects block, VERBATIM from
      //    PR-4b-base (the disabled-path-is-byte-identical proof).
      //  - Enabled branch: the façade computes the decision and hands it to
      //    `applyOverPingDecision(decision)`, which performs the IDENTICAL
      //    effects. Same pure inputs ⇒ same decision ⇒ flag-ON ≡ flag-OFF ≡ base.
      //
      // The effects block is shared between both thunks by closing over `decision`
      // — but the disabled thunk computes it via its OWN literal `decideOverPing(`
      // first, so the disabled path never depends on the façade for the decision.
      const applyOverPingDecision = (decision: OverPingDecision): void => {
        if (decision.suppress) {
          process.stderr.write(
            `telegram gateway: reply over-ping safety net — ` +
            `downgrading disable_notification:false → true ` +
            `(chat=${chat_id} thread=${args.message_thread_id ?? '-'} ` +
            `firstPingAt=${turn.firstPingAt} sinceFirstPing_ms=${decision.sinceFirstPingMs})\n`,
          )
          // Observability: surface to the unified runtime-metrics
          // fan-out so the cadence dashboard can track fleet-wide
          // over-ping rate (leading indicator of model pacing drift).
          emitRuntimeMetric({
            kind: 'over_ping_suppressed',
            key: statusKey(chat_id, args.message_thread_id != null
              ? Number(args.message_thread_id) : undefined),
            sinceFirstPingMs: decision.sinceFirstPingMs ?? 0,
          })
          disableNotification = true
          wasOverPingSuppressed = true
        } else if (decision.claimSlot) {
          // Claim (first ping) OR upgrade (substantive answer pinging over an
          // ack's slot). Set firstPingAt AND firstPingWasSubstantive ATOMICALLY
          // (no await between) so a racing second reply reads a consistent pair.
          turn.firstPingAt = now
          turn.firstPingWasSubstantive = replySubstantive
          if (decision.upgrade) {
            process.stderr.write(
              `telegram gateway: reply over-ping safety net — ` +
              `UPGRADE: substantive answer pings over an ack's slot ` +
              `(chat=${chat_id} thread=${args.message_thread_id ?? '-'})\n`,
            )
          }
        }
      }
      emissionAuthorityFor(turn).claimOrDowngradePing(
        { modelRequestedPing: !disableNotification, substantive: replySubstantive },
        {
          firstPingAt: turn.firstPingAt,
          firstPingWasSubstantive: turn.firstPingWasSubstantive,
          nowMs: now,
        },
        applyOverPingDecision,
        () => {
          // Disabled-path: literal `decideOverPing(` + effects, VERBATIM base.
          const decision = decideOverPing({
            modelRequestedPing: !disableNotification,
            firstPingAt: turn.firstPingAt,
            substantive: replySubstantive,
            firstPingWasSubstantive: turn.firstPingWasSubstantive,
            nowMs: now,
          })
          applyOverPingDecision(decision)
        },
      )
    }
  }

  // Telegraph publish (#579). When the reply text is long enough AND
  // the agent has telegraph enabled in access.json, publish to
  // Telegraph + replace the local text with a single-message link.
  // Telegram renders the link as a native Instant View card.
  // Failure paths fall through to normal HTML chunking, so a flaky
  // Telegraph backend never breaks the reply path.
  const tg = access.telegraph
  const tgThreshold = tg?.threshold ?? 3000
  if (tg?.enabled && files.length === 0 && text.length > tgThreshold) {
    const agentSlug = process.env.SWITCHROOM_AGENT_NAME ?? 'switchroom-agent'
    const shortName = tg.short_name ?? agentSlug
    const url = await publishToTelegraph(text, shortName, tg.author_name)
    if (url != null) {
      const title = deriveTelegraphTitle(text)
      // Replace the local text with a one-line link. The first line
      // is the chosen title (so the user sees the topic at a glance);
      // the second line is the URL Telegram will Instant-View.
      text = `**${escapeMarkdown(title)}**\n${url}`
    }
    // url null → fall through and chunk; the user still gets the
    // long reply, just split across messages.
  }

  // Single rich-markdown path (#2669). The only fork is `format:'text'`,
  // a literal/no-markdown send: the body bypasses the rich parser entirely
  // (plain `sendMessage`, no rich wrapper). Everything else — the default —
  // ships the raw GFM markdown via `sendRichMessage`. `effectiveText` is the
  // raw text either way (no HTML/MarkdownV2 rendering happens here anymore).
  const literalText = format === 'text'
  // Paragraph-spacing fix (rich-message regression after #2669). The rich GFM
  // renderer collapses a `\n\n` gap TIGHT, so multi-paragraph replies render
  // jammed together — unlike the old HTML path. Inject a visible blank-line
  // spacer into prose `\n\n` gaps on the rich path only. The literal
  // (`format:'text'`) path must stay byte-exact, so it is left untouched.
  const effectiveText: string = computeEffectiveText(text, literalText)

  assertAllowedChat(chat_id)

  // Thread resolution precedence (ANSWER path, component 3 — turn-origin
  // routing): (1) explicit message_thread_id the model passed; else
  // (2) the ORIGIN turn's thread — the turn that OWNS this reply, matched
  // by origin_turn_id (the meta field the model echoes back). This is
  // authoritative even after `currentTurn` has flipped to a successor (the
  // Brevo→Meta late-reply bug). Else (3) the live turn's thread (legacy
  // #1664 fallback when no origin turn is resolvable). Answer paths
  // DELIBERATELY do NOT fall through to chatThreadMap last-seen — that
  // heuristic is what mis-routed a late reply to whichever topic most
  // recently received a message. DM: every tier is undefined → unchanged.
  // Kill switch off → exact legacy resolveThreadId precedence.
  // Hoist the resolved origin turn so the obligation-close path (below) can
  // pass it into resolveCloseTarget as routedOriginId, closing re-presented
  // obligations even when the model omitted origin_turn_id (Fix 1/2).
  let replyRoutedOriginTurn: CurrentTurn | null = null
  let threadId: number | undefined
  if (TURN_ORIGIN_ROUTING_ENABLED) {
    const explicit = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
    // Origin precedence: model echo first (authoritative), then the
    // framework-owned quoted message_id (deterministic, no model thread
    // assertion) as a fallback when the model omitted the echo.
    const echoedTurn = findTurnByOriginId(args.origin_turn_id as string | undefined)
    const quotedTurn = echoedTurn == null ? findTurnByQuotedMessageId(chat_id, args.reply_to) : null
    const originTurn = echoedTurn ?? quotedTurn
    replyRoutedOriginTurn = originTurn ?? null
    threadId = resolveAnswerThreadWithLog(
      chat_id,
      Number.isFinite(explicit as number) ? (explicit as number) : undefined,
      originTurn,
      originTurn == null ? null : echoedTurn != null ? 'echo' : 'quoted',
      turn,
      'reply',
    )
  } else {
    threadId = resolveThreadId(
      chat_id,
      (args.message_thread_id as string | undefined) ??
        (turn?.sessionThreadId != null ? turn.sessionThreadId : undefined),
    )
  }

  // #4301: track whether `reply_to` came from the quote-opt-in DEFAULT (the
  // latest inbound user message) rather than an explicit/model-supplied value.
  // The default antecedent is never in the Buzz correlation store, so its mirror
  // lookup always misses — passing this flag lets the mirror log that expected
  // flat fallback quietly instead of as an eviction "MISS".
  let antecedentFromQuoteOptInDefault = false
  if (reply_to == null && quoteOptIn && HISTORY_ENABLED) {
    try {
      const latest = getLatestInboundMessageId(chat_id, threadId ?? null)
      if (latest != null) {
        reply_to = latest
        antecedentFromQuoteOptInDefault = true
      }
    } catch (err) {
      process.stderr.write(`telegram gateway: quote-reply lookup failed: ${(err as Error).message}\n`)
    }
  }

  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const limit = Math.max(1, Math.min(access.textChunkLimit ?? RICH_MESSAGE_MAX_CHARS, MAX_CHUNK_LIMIT))
  const replyMode = access.replyToMode ?? 'first'
  const chunks = computeReplyChunks({
    effectiveText,
    literalText,
    limit,
    chunkMode: access.chunkMode ?? 'length',
  })
  const sentIds: number[] = []

  // Outbound TTS synthesis (PR-C2). Done BEFORE the text send so a
  // voice-only reply can suppress the text chunks on success. ONE voice note
  // per response for the kokoro path (ttsChunks is a single element — the
  // whole normalized reply — synthesized in one /tts call). The OpenAI path
  // may still produce several ordered notes (one per chunk) because of its
  // input cap. Ken is often on a bike/driving and can't read the screen, so
  // the full answer must be SPOKEN. Best-effort: a chunk that fails to
  // synthesize is skipped; if NOTHING synthesizes the text path proceeds
  // unchanged so the answer is never dropped.
  // on-demand is a LOCAL-engine (kokoro) feature only: the tap handler
  // synthesizes via the local sidecar, so a Listen button is only meaningful
  // when the resolved engine is kokoro. resolveVoiceOutPlan already gated the
  // local host verdict for kokoro, so engine==='kokoro' here implies the
  // sidecar is available. For engine==='openai' + reply_mode='on-demand' we do
  // NOT inject a button (its taps would dead-end on the local sidecar) — we
  // fall through to the normal immediate-synth path so the openai reply behaves
  // exactly like a normal openai voice reply.
  const useOnDemandButton =
    voiceOutPlan != null &&
    voiceOutPlan.replyMode === 'on-demand' &&
    voiceOutPlan.engine === 'kokoro'

  const voiceOggs: Uint8Array[] = []
  // Skip reply-time synthesis ONLY when we're actually deferring to a Listen
  // button (kokoro on-demand). An openai on-demand config still synthesizes
  // immediately below.
  if (voiceOutPlan != null && !useOnDemandButton) {
    for (const chunkText of voiceOutPlan.ttsChunks) {
      const ogg = await synthesizeVoiceOut({
        engine: voiceOutPlan.engine,
        voice: voiceOutPlan.voice,
        speed: voiceOutPlan.speed,
        apiKeyRef: voiceOutPlan.apiKeyRef,
        ttsText: chunkText,
      })
      // Skip a failed chunk but keep going — a partial spoken answer still
      // beats silence; full-fail (no oggs at all) falls back to text below.
      if (ogg != null) voiceOggs.push(ogg)
    }
    if (voiceOggs.length < voiceOutPlan.ttsChunks.length) {
      process.stderr.write(
        `telegram gateway: voice-out: synthesized ${voiceOggs.length}/${voiceOutPlan.ttsChunks.length} voice-note chunk(s)\n`,
      )
    }
  }
  // Suppress the text body ONLY when voice-only AND we synthesized the FULL
  // set of chunks (every part of the answer is spoken). A partial or total
  // synthesis failure leaves the text path running so the answer still
  // lands in full — never drop the user's answer silently.
  const suppressText =
    voiceOutPlan?.replyMode === 'voice-only' &&
    voiceOutPlan.ttsChunks.length > 0 &&
    voiceOggs.length === voiceOutPlan.ttsChunks.length

  // #271: validate inline_keyboard and namespace any callback_data with
  // the `agent:` prefix so the gateway's callback_query dispatcher can
  // round-trip taps back to this agent without colliding with
  // infrastructure prefixes (auth:/op:/vd:/vg:/aq:/perm:). URL buttons
  // pass through unchanged. Attached to the LAST chunk only so buttons
  // appear on the final visible message.
  let replyMarkup: { inline_keyboard: AnyButton[][] } | undefined
  let replyButtonMeta: Map<string, AgentButtonMeta> | undefined
  const rawKeyboard = args.inline_keyboard as AnyButton[][] | undefined
  if (rawKeyboard != null) {
    const validationErrors = validateInlineKeyboard(rawKeyboard)
    if (validationErrors.length > 0) {
      const summary = validationErrors
        .map((e) => `${e.path}.${e.field}: ${e.reason}`)
        .join('; ')
      throw new Error(`inline_keyboard validation failed: ${summary}`)
    }
    // #3148 fast-follow: mask any secret an agent put in a visible button
    // `text` label, its `ack_text` toast, or a `copy_text.text` clipboard
    // payload BEFORE the keyboard is sent — the same outbound scrub the reply
    // `text` body uses. `callback_data` (the routing key) is left exact.
    // Feeding BOTH the meta extraction and the callback wrap from the redacted
    // copy means the stashed toast, the tap echo (`button_text`), and the
    // "✅ You chose: <label>" annotation (#789) all read already-masked bytes.
    const redactedKeyboard = redactAgentKeyboard(rawKeyboard, (s) =>
      redactOutboundText(s, 'reply_inline_keyboard'),
    )
    replyButtonMeta = extractAgentButtonMeta(redactedKeyboard)
    replyMarkup = { inline_keyboard: wrapAgentCallbacks(redactedKeyboard) }
  }

  // on-demand voice: append a single '🔊 Listen' button that synthesizes the
  // spoken reply only when tapped. The button carries a RAW `voice:<token>`
  // callback_data (NOT wrapped with the agent: prefix) so the dispatcher
  // handles it internally and never routes it to the agent as an inbound.
  //
  // Collision gate: inject ONLY when the reply carries no agent-authored
  // buttons. If the agent supplied its own keyboard, the callback dispatcher's
  // single_use strip (keyboardIsSingleUse) governs that whole message; adding
  // a foreign single_use:false button would flip that message to a mixed
  // keyboard and defeat the agent's double-fire protection. Keep it simple —
  // agent buttons present → skip the Listen button for this message.
  //
  // useOnDemandButton already gates on engine==='kokoro': an openai on-demand
  // config never reaches here (it synthesized immediately above), so a Listen
  // button is never minted for an engine whose taps would dead-end on the
  // local sidecar.
  if (useOnDemandButton) {
    // planListenButton is the SHARED decision (also used by the durable-outbox
    // safety net, outbox-sweep.ts) — it enforces the empty-TTS guard and the
    // agent-keyboard collision gate. Null = don't inject.
    const listenPlan = planListenButton({ voiceOutPlan, rawKeyboard })
    if (listenPlan == null) {
      // Log the collision gate ONLY when the agent keyboard is the ACTUAL
      // reason we skipped — i.e. there IS speakable text. When ttsChunks is
      // empty the empty-TTS guard is what returned null (there was nothing to
      // speak), so a "skipping — agent supplied inline_keyboard" line would
      // misattribute the reason.
      const hasSpeakableText =
        voiceOutPlan!.ttsChunks.length > 0 && voiceOutPlan!.ttsChunks[0]!.length > 0
      if (hasSpeakableText && !mayInjectListenButton(rawKeyboard)) {
        process.stderr.write(
          'telegram gateway: voice-out on-demand: agent supplied inline_keyboard — skipping Listen button (single_use collision gate)\n',
        )
      }
    } else {
      // Token is intentionally GLOBAL (not chat-keyed): under the single-tenant
      // invariant the operator is the only authorized sender across all chats,
      // and the tap handler re-checks access.allowFrom before synthesizing, so
      // a token needs no per-chat scoping to be safe.
      voiceOnDemandCache.put(listenPlan.token, listenPlan.payload)
      // The keyboard stays after the tap (never stripped) so it can be
      // replayed. The gate above guarantees this is the ONLY button on the
      // message, so keeping it is safe (no agent buttons to protect).
      replyMarkup = listenPlan.replyMarkup
      // #2763 eager pre-synthesis: kick a background synth of the same
      // payload so the Listen tap attaches the pre-made file instantly.
      // Local-engine only (useOnDemandButton already gates engine==='kokoro'
      // — the cloud engine never eager-synthesizes). enqueue() is a
      // synchronous array push; the drain is deferred + async and never
      // awaited here, so the text sends below are never delayed and a synth
      // failure can never affect message delivery (the tap just falls back
      // to the lazy path).
      if (eagerVoiceEnabled()) {
        voicePreSynthQueue.enqueue({
          token: listenPlan.token,
          text: listenPlan.payload.text,
          ...(listenPlan.payload.voice != null ? { voice: listenPlan.payload.voice } : {}),
          speed: listenPlan.payload.speed,
        })
      }
    }
  }

  const replySKey = streamKey(chat_id, threadId)
  suppressPtyPreview.add(replySKey)
  let previewMessageId: number | null = null
  const openStream = activeDraftStreams.get(replySKey)
  if (openStream && !openStream.isFinal()) {
    await openStream.finalize().catch(() => {})
    previewMessageId = openStream.getMessageId()
    activeDraftStreams.delete(replySKey)
    lastPtyPreviewByChat.delete(replySKey)
  }

  // Pre-alloc placeholder consumption removed in #553 PR 5 — the
  // gateway no longer pre-allocates a draft on inbound, so reply tools
  // simply render fresh. The 👀 reaction (#568) and typing indicator
  // (#585) provide the visual gap that the placeholder used to fill.

  const deleteStalePreview = async (id: number): Promise<void> => {
    // #1075: operates on a message in a (possibly-deleted) thread. The
    // "delete not found" case is already swallowed by robustApiCall; on
    // THREAD_NOT_FOUND, swallowingApiCall logs + returns undefined so the
    // reply flow continues with a fresh send.
    await swallowingApiCall(
      () => lockedBot.api.deleteMessage(chat_id, id),
      { chat_id, verb: 'reply.deleteStalePreview' },
    )
  }

  logStreamingEvent({
    kind: 'reply_called',
    chatId: chat_id,
    charCount: effectiveText.length,
    replacedPreview: previewMessageId != null,
    previewMessageId,
  })
  // #1122 KPI: a `reply` always produces a fresh user-visible outbound
  // message — count it for the outbound-gap / TTFO KPI AND reset the
  // silence-poke clock so the next poke is measured from this send.
  signalTracker.noteOutbound(statusKey(chat_id, threadId), Date.now())
  silencePoke.noteOutbound(statusKey(chat_id, threadId), Date.now())
  // Mid-turn auto-classify recency clock: the agent just produced visible output
  // in this chat/thread (cross-turn, unlike silencePoke's per-turn lastOutboundAt).
  // Only maintained when the shadow flag is on → truly zero overhead by default.
  if (AUTOCLASSIFY_MIDTURN_SHADOW) noteAgentOutputAt(statusKey(chat_id, threadId), Date.now())
  // PR3b-cutover: feed lastOutboundAt to the delivery machine so its
  // TTL `tick` suppresses the fallback for a long-but-active turn
  // (model streaming past 5 min) — parity with silencePoke's own
  // suppression, so the cutover gate doesn't clear a live turn.
  shadowEmit({ kind: 'modelOutbound', key: statusKey(chat_id, threadId) as _ChatKey, at: Date.now() })
  // #1741 — only clear silent-end state on a plausibly-final reply.
  // An interim ack (disable_notification:true, short text, no done)
  // must NOT clear the state file; otherwise a turn that ends with
  // ack-only + answer-as-transcript leaves no state for the Stop
  // hook to act on if `turn_end` never lands (the `turn_duration`
  // system event is unreliable for trivial-prompt turns — see the
  // executeReply finalize comments). Final-answer replies still
  // clear; the main turn-end path also re-writes the state when
  // finalAnswerDelivered=false, so this is a belt-and-braces gate
  // for the turn_end-missing case (#1741).
  if (isFinalAnswerReply({ text: rawText, disableNotification: modelDisableNotification })) {
    clearSilentEndState(statusKey(chat_id, threadId))
  }

  // Lever 2 (design §9 lever 2): finalize the activity card BEFORE the reply
  // chunks send, so the card keeps its (lower) message_id and the reply is
  // structurally last on screen. ONLY for a *substantive* final — for an ack
  // (non-substantive) do NOTHING: finalizing an ack early would
  // close → reopen → emit MORE messages (the #2141 ack-then-work feed, R3).
  // `clearActivitySummary` edits the existing card in place (no new send) and
  // nulls `activityMessageId`; combined with the sticky latch set here it
  // prevents any post-reply re-OPEN below the answer. Idempotent with the
  // tool_use-event clear at the first-reply handoff (the existing backstop).
  {
    const finalizeTurn = getCurrentTurn()
    if (
      finalizeTurn != null
      && isSubstantiveFinalReply({ text: rawText, disableNotification: modelDisableNotification })
    ) {
      // PR-4a: routed through the emission-authority façade (no-op delegates —
      // the latch-set and the finalize run exactly as before).
      const ea = emissionAuthorityFor(finalizeTurn)
      ea.markSubstantiveFinalDelivered(() => {
        finalizeTurn.finalAnswerEverDelivered = true
        finalizeTurn.finalAnswerDeliveredAt = Date.now()
      })
      ea.finalizeCard(() => {
        clearActivitySummary(finalizeTurn)
      })
    }
  }

  // Reply-flicker fix — apply the deferred flushed-turn correction now that
  // chunk count / files / preview are all resolved. `edit-in-place` reuses the
  // single-message edit lane below (`previewMessageId`): it edits the flushed
  // message A into the canonical reply B with the SAME rich rendering a fresh
  // reply uses, and `sendReplyChunks` falls back to delete+resend on any edit
  // 400 (message too old / uneditable / gone) — so exactly one message with the
  // canonical content always survives. We also forgo the quote (an edit can't
  // carry a reply_parameters quote) by clearing `reply_to`, so the quote-delete
  // guard just below does NOT delete our edit target. `delete-resend` keeps the
  // legacy behaviour (delete the flushed message(s), then send fresh below).
  if (supersedeFlushIds.length > 0) {
    const correction = decideSupersedeCorrection({
      flushMessageIds: supersedeFlushIds,
      chunkCount: chunks.length,
      hasFiles: files.length > 0,
      suppressText,
      hasOpenPreview: previewMessageId != null,
    })
    if (correction.mode === 'edit-in-place') {
      previewMessageId = correction.editMessageId
      reply_to = undefined
      process.stderr.write(
        `telegram gateway: reply: superseding flushed message via edit-in-place ` +
        `chatId=${chat_id} id=${correction.editMessageId}\n`,
      )
    } else {
      for (const id of correction.deleteMessageIds) {
        await swallowingApiCall(
          () => lockedBot.api.deleteMessage(chat_id, id),
          { chat_id, verb: 'reply.supersedeFlushed' },
        )
      }
    }
  }

  if (previewMessageId != null && reply_to != null && replyMode !== 'off') {
    await deleteStalePreview(previewMessageId)
    previewMessageId = null
  }

  startTypingLoop(chat_id, threadId ?? null)

  // #1677 silent-reply auto-edit. Consecutive silent replies within
  // a turn edit a single anchor message instead of stacking new
  // bubbles. We branch BEFORE the chunk loop so the single-chunk
  // common case takes an editMessageText path; everything else
  // (multi-chunk, ping, files, buttons) falls through to fresh send
  // and either captures a new anchor or doesn't, per the predicate.
  let silentAnchorEditDone = false
  {
    const turn = getCurrentTurn()
    // Skip the silent-anchor merge when a flushed-turn supersede is active: an
    // edit-in-place correction has re-pointed `previewMessageId` at the flushed
    // message (the chunk loop below edits it), and merging into a prior silent
    // anchor instead would orphan the flushed message A (leaving BOTH A and the
    // anchor visible — the exact duplicate this supersede exists to prevent).
    if (turn != null && chunks.length === 1 && supersedeFlushIds.length === 0) {
      const decision = decideSilentReplyAnchor({
        effectivelySilent: disableNotification,
        anchorMessageId: turn.silentAnchorMessageId,
        anchorText: turn.silentAnchorText,
        newReplyText: effectiveText,
        hasFiles: files.length > 0,
        hasButtons: replyMarkup != null,
        wasOverPingSuppressed,
      })
      if (decision.kind === 'edit-anchor') {
        const editParams: {
          message_thread_id?: number
          link_preview_options?: { is_disabled: boolean }
        } = {
          link_preview_options: { is_disabled: disableLinkPreview },
        }
        if (threadId != null) editParams.message_thread_id = threadId
        try {
          await robustApiCall(
            () =>
              lockedBot.api.editMessageText(
                chat_id,
                decision.messageId,
                literalText ? decision.mergedText : richMessage(decision.mergedText),
                editParams,
              ),
            {
              chat_id,
              verb: 'reply.silent-anchor-edit',
              ...(threadId != null ? { threadId } : {}),
            },
          )
          turn.silentAnchorText = decision.mergedText
          sentIds.push(decision.messageId)
          logOutbound(
            'edit',
            chat_id,
            decision.messageId,
            decision.mergedText.length,
            'silent-anchor-merge',
          )
          process.stderr.write(
            `telegram gateway: silent-reply auto-edit — ` +
            `chat=${chat_id} anchor=${decision.messageId} ` +
            `merged_len=${decision.mergedText.length}\n`,
          )

          // #1679 — side effects the chunk-loop completion path runs.
          // The edit-anchor branch returns early below, so these must
          // be wired here too. Skipping them silently causes:
          //   - cross-turn ambient (`pending-work-progress.ts`) holds
          //     a stale anchor text and OVERWRITES the model's
          //     accumulated silent content with `still working (Nm)`
          //     when async work is in flight (this is the load-bearing
          //     fix);
          //   - SQLite history (`get_recent_messages`) misses the
          //     silent-anchor content;
          //   - #1664 silent-end re-prompt fires even when the
          //     accumulated silent content qualifies as substantive;
          //   - retries within the dedup window may double-send.
          // #1760 primary fix — clear any stale prior-turn ticker
          // before re-anchoring on this silent-reply edit. See the
          // matching comment at the executeReply finalize site below.
          pendingProgress.clearPending(statusKey(chat_id, threadId), 'reply_finalize')
          pendingProgress.noteOutbound(statusKey(chat_id, threadId), {
            messageId: decision.messageId,
            text: decision.mergedText,
            literalText,
          })
          if (HISTORY_ENABLED) {
            try {
              recordOutbound({
                chat_id,
                thread_id: threadId ?? null,
                message_ids: [decision.messageId],
                texts: [decision.mergedText],
                attachment_kinds: [null],
              })
            } catch (histErr) {
              process.stderr.write(
                `telegram gateway: history recordOutbound (silent-anchor-edit) failed: ${histErr instanceof Error ? histErr.message : String(histErr)}\n`,
              )
            }
          }
          if (
            turn != null
            && isFinalAnswerReply({
              text: decision.mergedText,
              disableNotification: modelDisableNotification,
            })
          ) {
            turn.finalAnswerDelivered = true
            // Feed-reopen refinement: a substantive merged silent-anchor
            // answer must NOT re-open the feed on post-answer housekeeping.
            turn.finalAnswerSubstantive = isSubstantiveFinalReply({
              text: decision.mergedText,
              disableNotification: modelDisableNotification,
            })
            // Sticky ordering latch (lever 1): a substantive final closes the
            // card OPEN gate for the rest of the turn. NEVER cleared by reopen.
            if (turn.finalAnswerSubstantive) turn.finalAnswerEverDelivered = true
            if (turn.finalAnswerSubstantive && turn.finalAnswerDeliveredAt == null) turn.finalAnswerDeliveredAt = Date.now()
            if (turn.finalAnswerSubstantive) closeObligationOnSubstantiveReply(args, turn, replyRoutedOriginTurn)
          }
          outboundDedup.record(
            chat_id,
            threadId,
            decision.mergedText,
            Date.now(),
            turn?.registryKey ?? null,
          )
          // F1: a FINAL-answer silent-anchor edit journals this legacy delivery
          // under the shared nonce (turn.turnId === deriveTurnId === the hook's
          // deriveTurnNonce `${chatKey}#${messageId}` for a gateway-visible turn)
          // and drops any hook-captured record, so the sweep never re-sends after
          // the in-memory dedup TTL evicts / a restart clears it / the captured
          // text differs. Gated so an interim-ack edit never journals the turn
          // nonce (which would suppress a later genuine answer for the turn).
          if (isFinalAnswerReply({ text: decision.mergedText, disableNotification: modelDisableNotification })) {
            journalExternalDelivery({ turnNonce: turn?.turnId ?? null, text: decision.mergedText, tgMessageId: decision.messageId, replyAlreadyDeliveredThisTurn: true })
          }

          silentAnchorEditDone = true
        } catch (err) {
          // Edit failed (e.g. message deleted, rate limit exhausted,
          // parse error). Fall through to fresh-send below — the
          // anchor will be overwritten by whatever lands.
          process.stderr.write(
            `telegram gateway: silent-reply auto-edit failed, ` +
            `falling back to fresh send: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    }
  }

  if (silentAnchorEditDone) {
    // Skip the chunk loop entirely — the anchor edit IS the send.
    // Match the normal exit path: stop typing, then return.
    stopTypingLoop(chat_id, threadId ?? null)
    return {
      content: [
        {
          type: 'text',
          text: `edited (id: ${sentIds[0]})`,
        },
      ],
    }
  }

  // #2996 step 1 — the chunk-send loop (with its THREAD_NOT_FOUND / oversize
  // re-split / parse-reject fallback ladder and partial-failure contract) is
  // relocated verbatim to outbound-send-path.ts's `sendReplyChunks` so it is
  // unit-testable against a fake bot API (gateway.ts is not importable —
  // Bun.listen + boot logic run at import). The raw `bot.api.*` calls stay HERE
  // as thin injected adapters (retry wrapping + allow-raw-bot-api markers
  // preserved), so the module is bot-agnostic and the check-bot-api-wrapping
  // allowlist is unchanged. The caller still builds the per-chunk option shape
  // (byte-identical). `sentIds` is threaded by reference; `threadId` /
  // `previewMessageId` come back for the file-send + history code below.
  const chunkSendDeps: ReplyChunkSendDeps = {
    sendRich: (opts, body, tid) =>
      robustApiCall(
        // allow-raw-bot-api: injected chunk-loop adapter — sendRichMessage routed through robustApiCall; THREAD_NOT_FOUND handled by sendReplyChunks' fallback ladder
        () => lockedBot.api.sendRichMessage(chat_id, body as never, opts as never),
        // #3084 PR 2: the final reply is CRITICAL — never shed; degraded mode
        // fails fast (structured flood_wait) instead of blocking the MCP reply.
        { threadId: tid, chat_id, priorityClass: 'critical' },
      ),
    sendLiteral: (opts, txt, tid) =>
      robustApiCall(
        // allow-raw-bot-api: injected chunk-loop adapter — literal format:'text' send routed through robustApiCall; THREAD_NOT_FOUND handled by sendReplyChunks
        () => lockedBot.api.sendMessage(chat_id, txt, opts as never),
        { threadId: tid, chat_id, priorityClass: 'critical' },
      ),
    sendLiteralRaw: (opts, txt) =>
      // allow-raw-bot-api: literal last-resort fallback (plaintext parse-reject / length re-split); wrapping would re-enter the parse/length policy that just rejected the payload
      lockedBot.api.sendMessage(chat_id, txt, opts as never),
    sendRichRaw: (opts, body) =>
      // allow-raw-bot-api: rich length-error re-split last resort; wrapping would re-enter the chunk-loop's own classification on an already-classified length failure
      lockedBot.api.sendRichMessage(chat_id, body as never, opts as never),
    editPreview: (mid, body, opts, tid) =>
      robustApiCall(
        // allow-raw-bot-api: preview edit-in-place routed through robustApiCall; thread fallback handled by sendReplyChunks
        () => lockedBot.api.editMessageText(chat_id, mid, body as never, opts as never),
        // Finalizing the reply into the preview message — still CRITICAL (this
        // IS the answer). Pass messageId/editPayload so the gate's per-message
        // floor + no-op skip engage on the edit (part3-design §4/§5, PR1 L1).
        { threadId: tid, chat_id, priorityClass: 'critical', messageId: mid, editPayload: body },
      ),
    richMessage,
    logOutbound,
    deleteStalePreview,
    stderr: (s: string) => { process.stderr.write(s) },
  }
  try {
    const _sendResult = await sendReplyChunks(chunkSendDeps, {
      chatId: chat_id,
      chunks,
      literalText,
      suppressText,
      threadId,
      previewMessageId,
      sentIds,
      buildSendOpts: (i, isLastChunk, tid) => {
        const shouldReplyTo =
          reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
        return {
          ...(shouldReplyTo
            ? {
                // `quote` is a Bot API String and `quote_position` a separate
                // sibling Integer — see reply-quote.ts. Emitting an object here
                // 400'd every quoted reply the fleet ever sent.
                reply_parameters: buildReplyParameters(reply_to!, quoteText),
              }
            : {}),
          ...(tid != null ? { message_thread_id: tid } : {}),
          ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
          ...(replyMarkup != null && isLastChunk ? { reply_markup: replyMarkup } : {}),
          ...(protectContent ? { protect_content: true } : {}),
          ...(disableNotification ? { disable_notification: true } : {}),
        }
      },
      buildPreviewEditOpts: (isLastChunk) => {
        const editOpts: Record<string, unknown> = {}
        if (disableLinkPreview) editOpts.link_preview_options = { is_disabled: true }
        if (replyMarkup != null && isLastChunk) editOpts.reply_markup = replyMarkup
        return editOpts
      },
    })
    threadId = _sendResult.threadId
    previewMessageId = _sendResult.previewMessageId
  } catch (err) {
    // #3861 — a flood-blocked reply is QUEUED, never discarded. Pre-fix this
    // catch re-wrapped `FLOOD_WAIT_ACTIVE` into a string and threw the answer
    // away: `retryApiCall` fails fast BEFORE the wire while a long window is
    // open, so during a multi-hour ban EVERY answer the agent composed for the
    // operator was lost — the one content class the durable outbox did not
    // cover. The undelivered text goes into the same outbox the sweep drains
    // (it defers while the window is open, #3854) under a content-derived
    // nonce, so a caller retry cannot double-deliver. `cosmetic` sends are
    // still dropped by `queueFloodBlockedReply`; this site is `critical`.
    const queued = queueFloodBlockedReply({
      err,
      chatId: chat_id,
      threadId: threadId ?? null,
      // Partial failure: queue only the chunks that never landed, so the user
      // does not receive the already-delivered prefix a second time.
      text: sentIds.length === 0 ? text : chunks.slice(sentIds.length).join('\n\n'),
      priorityClass: 'critical',
      originChatId: turn?.sessionChatId ?? null,
      originThreadId: turn?.sessionThreadId ?? null,
    })
    if (queued != null) {
      process.stderr.write(
        `telegram gateway: reply flood-deferred — queued to outbox nonce=${queued.turnNonce} ` +
          `chat=${chat_id} chars=${text.length} sent=${sentIds.length}/${chunks.length}\n`,
      )
      // The obligation is DISCHARGED by the durable enqueue. Without this the
      // obligation tracker keeps re-prompting the agent to reply every few
      // minutes for the whole ban — dozens of forced turns it physically
      // cannot satisfy (and pre-#3861 each attempt destroyed its own answer).
      if (turn != null && isSubstantiveFinalReply({ text, disableNotification: modelDisableNotification })) {
        closeObligationOnSubstantiveReply(args, turn, replyRoutedOriginTurn)
      }
      // (the `finally` below stops the typing loop on this return path too)
      return { content: [{ type: 'text', text: queued.notice }] }
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
  } finally {
    stopTypingLoop(chat_id, threadId ?? null)
  }

  // Outbound voice notes (PR-C2). Sent IN ORDER, AFTER the text body
  // (voice+text) or INSTEAD of it (voice-only, where suppressText skipped
  // the chunk loop). A long reply produces SEVERAL notes — each spoken in
  // sequence so the whole answer is heard, never truncated. Best-effort and
  // fully non-fatal: a sendVoice failure must NEVER break the text reply
  // path. In voice-only mode a failure would leave the user with an
  // incomplete spoken answer, so on the FIRST send failure we recover by
  // sending the full text once and stop sending further notes.
  for (let v = 0; v < voiceOggs.length; v++) {
    const oggBytes = voiceOggs[v]!
    const voiceOpts: Record<string, unknown> = {
      // Quote the user's message only on the FIRST voice note (mirrors the
      // text chunk loop's first-chunk reply behaviour).
      ...(v === 0 && reply_to != null && replyMode !== 'off'
        ? { reply_parameters: { message_id: reply_to } }
        : {}),
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      ...(disableNotification ? { disable_notification: true } : {}),
    }
    try {
      const sentVoice = await retryWithThreadFallback<{ message_id: number; message_thread_id?: number }>(
        robustApiCall,
        (tid) => {
          const opts = { ...voiceOpts }
          if (tid != null) opts.message_thread_id = tid
          else delete opts.message_thread_id
          // allow-raw-bot-api: adapter callback INSIDE retryWithThreadFallback→robustApiCall; the THREAD_NOT_FOUND fallback is handled by the wrapper.
          return lockedBot.api.sendVoice(chat_id, new InputFile(Buffer.from(oggBytes)), opts as never)
        },
        { threadId, chat_id, verb: 'sendVoice' },
      )
      sentIds.push(sentVoice.message_id)
      logOutbound(
        'reply',
        chat_id,
        sentVoice.message_id,
        voiceOutPlan?.ttsChunks[v]?.length ?? 0,
        `voice-note=${v + 1}/${voiceOggs.length}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `telegram gateway: voice-out: sendVoice ${v + 1}/${voiceOggs.length} failed (non-fatal): ${msg}\n`,
      )
      // voice-only fell over mid-stream with text suppressed → recover by
      // sending the FULL text body once so the answer still lands, then
      // stop sending further notes (the text now carries everything).
      if (suppressText) {
        try {
          const opts: Record<string, unknown> = {
            ...(reply_to != null && replyMode !== 'off'
              ? { reply_parameters: { message_id: reply_to } }
              : {}),
            ...(threadId != null ? { message_thread_id: threadId } : {}),
            ...(disableNotification ? { disable_notification: true } : {}),
          }
          // allow-raw-bot-api: voice-only recovery fallback — the rich path already ran/was skipped; send the source text plainly so the answer is never lost.
          const sent = await lockedBot.api.sendMessage(chat_id, effectiveText, opts as never)
          sentIds.push(sent.message_id)
          logOutbound('reply', chat_id, sent.message_id, effectiveText.length, 'voice-only-text-recovery')
        } catch (textErr) {
          process.stderr.write(
            `telegram gateway: voice-out: voice-only text recovery ALSO failed: ${textErr instanceof Error ? textErr.message : String(textErr)}\n`,
          )
        }
        break
      }
    }
  }

  // #710: remember per-button agent meta (ack_text / single_use) keyed
  // by the message that actually carries the keyboard — that's the last
  // text chunk, since the keyboard is attached only on isLastChunk.
  if (replyButtonMeta != null && replyButtonMeta.size > 0 && sentIds.length >= chunks.length) {
    const keyboardMsgId = sentIds[chunks.length - 1]
    if (typeof keyboardMsgId === 'number') {
      rememberAgentButtonMeta(chat_id, keyboardMsgId, replyButtonMeta)
    }
  }

  // #1445 cross-turn pending-async ambient. Capture the last text
  // chunk as the anchor — if this turn ends with a pending async
  // dispatch, the framework edits THIS message in place every 60s
  // with a `— still working (Nm)` suffix until the user re-engages.
  // Multi-chunk replies: anchor is the LAST chunk (edits append to
  // the visually-trailing message; earlier chunks are left intact).
  if (sentIds.length === chunks.length && chunks.length > 0) {
    const anchorMsgId = sentIds[chunks.length - 1]
    if (typeof anchorMsgId === 'number') {
      // #1760 primary fix — clear any stale prior-turn ticker BEFORE
      // re-anchoring. The canonical teardown wires (turn_end,
      // subagent_handback, inbound) can be missed (e.g. SDK turn_end
      // event dropped, as in the #1760 live evidence). Tearing down on
      // every reply-finalize is idempotent and resilient: it's a no-op
      // when nothing is active, and drops a stale ambient before the
      // new turn captures its anchor.
      pendingProgress.clearPending(statusKey(chat_id, threadId), 'reply_finalize')
      pendingProgress.noteOutbound(statusKey(chat_id, threadId), {
        messageId: anchorMsgId,
        text: chunks[chunks.length - 1],
        literalText,
      })
    }
  }

  // #1677 silent-reply auto-edit — anchor capture for the FIRST
  // silent reply of a turn (or the silent reply that replaced the
  // anchor on overflow). Only captures for the single-chunk,
  // silent, no-files, no-buttons happy path; the edit-anchor path
  // earlier in this function handles SUBSEQUENT silent replies by
  // editing. The next silent reply this turn will see the captured
  // anchor and edit it in place.
  if (
    chunks.length === 1
    && disableNotification
    && files.length === 0
    && replyMarkup == null
    && sentIds.length === 1
  ) {
    const turn = getCurrentTurn()
    if (turn != null) {
      turn.silentAnchorMessageId = sentIds[0]!
      turn.silentAnchorText = effectiveText
    }
  }

  // #3033 layer-2 (pre-send validation): probe each photo-extension file
  // BEFORE it hits the wire and pre-route any that Telegram's photo path
  // would reject (extreme aspect ratio, width+height over cap, >10MB) as
  // documents. One bad photo fails a WHOLE sendMediaGroup album with an
  // opaque 400 — catching it here keeps the good files deliverable and
  // sends the offender as a document on the first attempt. Probe
  // failures keep the photo route; the reactive #3022 fallback backstops.
  const photoPrecheck = new Map<string, ReturnType<typeof classifyPhotoFile>>()
  // #3038 polish: files that ultimately went out as documents despite a
  // photo extension (precheck reroute or reactive fallback). Feeds two
  // honesty surfaces: the reply tool result suffix (so the agent doesn't
  // claim an inline image rendered) and attachment_kinds history (record
  // what was actually sent).
  const documentReroutes: Array<{ path: string; reason: string }> = []
  const sentAsDocument = new Set<string>()
  for (const f of files) {
    if (!PHOTO_EXTS.has(extname(f).toLowerCase())) continue
    const cls = classifyPhotoFile(f)
    photoPrecheck.set(f, cls)
    if (cls.route === 'document') {
      documentReroutes.push({ path: f, reason: cls.reason })
      sentAsDocument.add(f)
      process.stderr.write(
        `telegram gateway: photo-precheck rerouting ${f} as document (${cls.reason})\n`,
      )
    }
  }
  const sendableAsPhoto = (f: string) =>
    PHOTO_EXTS.has(extname(f).toLowerCase()) && photoPrecheck.get(f)?.route !== 'document'

  // #273: when files is 2-10 photos, batch them into a single
  // sendMediaGroup album rather than N separate sendPhoto calls. The
  // user's device fires one notification for the album instead of N
  // (notification-budget protection per the issue's JTBD note). Falls
  // back to the per-file path for any non-all-photo set.
  //
  // #3038 known tradeoff: ONE precheck-rerouted photo in the set drops
  // the WHOLE album to per-file sends — the user gets N notifications
  // instead of 1. Deliberate: sendMediaGroup can't mix photo and
  // document media, and a partial album plus a stray document is more
  // confusing than N files. Revisit only if mixed albums become common.
  const allPhotos = files.length >= 2 && files.length <= 10
    && files.every(sendableAsPhoto)
  // #1075: thread-id-bearing file sends. Mirror the chunk-loop's
  // THREAD_NOT_FOUND fallback (deleted topic → drop the thread and
  // resend on the main chat) so an attachment-bearing reply doesn't
  // crash when the user deletes the topic mid-flight.
  const replyParams =
    reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}
  // Send one file as a document, routed through the same thread-fallback
  // policy as the photo path. `InputFile` streams are single-use, so a
  // document retry after a failed sendPhoto must build a FRESH InputFile
  // from the path. Returns the sent message (with its echoed thread id).
  const sendAsDocument = (f: string) =>
    retryWithThreadFallback<{ message_id: number; message_thread_id?: number }>(
      robustApiCall,
      (tid) => {
        const baseOpts = {
          ...replyParams,
          ...(tid != null ? { message_thread_id: tid } : {}),
        }
        // allow-raw-bot-api: wrapped in retryWithThreadFallback (retry policy); topic-aware document fallback
        return lockedBot.api.sendDocument(chat_id, new InputFile(f), baseOpts)
      },
      { threadId, chat_id, verb: 'sendDocument' },
    )

  if (allPhotos) {
    const media = files.map((f) => ({
      type: 'photo' as const,
      media: new InputFile(f),
    }))
    let sent: Array<{ message_id: number; message_thread_id?: number }>
    try {
      sent = await retryWithThreadFallback(
        robustApiCall,
        (tid) => {
          const baseOpts = {
            ...replyParams,
            ...(tid != null ? { message_thread_id: tid } : {}),
          }
          return lockedBot.api.sendMediaGroup(chat_id, media, baseOpts)
        },
        { threadId, chat_id, verb: 'sendMediaGroup' },
      )
    } catch (err) {
      // Graceful fallback: one bad photo in the album (e.g. a tall phone
      // screenshot → PHOTO_INVALID_DIMENSIONS) fails the WHOLE media group.
      // Rather than surface an error, re-send each file individually as a
      // document so the user still receives all of them. See #klanker
      // 2026-07-10 incident + isPhotoDimensionRejectError.
      if (!isPhotoDimensionRejectError(err)) throw err
      process.stderr.write(
        `telegram gateway: sendMediaGroup rejected the photo album ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to per-file sendDocument\n`,
      )
      sent = []
      const albumReason = 'Telegram rejected the photo album; whole album re-sent as documents'
      for (const f of files) {
        sent.push(await sendAsDocument(f))
        sentAsDocument.add(f)
        documentReroutes.push({ path: f, reason: albumReason })
      }
    }
    if (threadId != null) {
      // If the fallback dropped the thread id, propagate that decision
      // to subsequent calls in this reply (no further retries needed).
      // We can't observe which branch resolved cleanly, so peek at the
      // first sent message: Telegram echoes message_thread_id only when
      // present in the request. Absent → fallback fired.
      const first = sent[0] as { message_thread_id?: number } | undefined
      if (first && first.message_thread_id == null) threadId = undefined
    }
    for (const m of sent) sentIds.push(m.message_id)
  } else {
    for (const f of files) {
      const input = new InputFile(f)
      // Photo-ext files that failed the pre-send probe route straight to
      // sendDocument (see photoPrecheck above) instead of bouncing a 400.
      const isPhoto = sendableAsPhoto(f)
      let sent: { message_id: number; message_thread_id?: number }
      try {
        sent = await retryWithThreadFallback<{ message_id: number; message_thread_id?: number }>(
          robustApiCall,
          (tid) => {
            const baseOpts = {
              ...replyParams,
              ...(tid != null ? { message_thread_id: tid } : {}),
            }
            return isPhoto
              ? lockedBot.api.sendPhoto(chat_id, input, baseOpts)
              : lockedBot.api.sendDocument(chat_id, input, baseOpts)
          },
          { threadId, chat_id, verb: isPhoto ? 'sendPhoto' : 'sendDocument' },
        )
      } catch (err) {
        // Graceful fallback: an image Telegram won't accept as a photo
        // (dimensions out of range / too large — a tall phone screenshot
        // is the canonical trigger, PHOTO_INVALID_DIMENSIONS) is re-sent
        // as a document so the user still receives the file instead of
        // getting nothing. Non-photo-dimension errors propagate as before.
        if (!(isPhoto && isPhotoDimensionRejectError(err))) throw err
        process.stderr.write(
          `telegram gateway: sendPhoto rejected ${f} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to sendDocument\n`,
        )
        sent = await sendAsDocument(f)
        sentAsDocument.add(f)
        documentReroutes.push({ path: f, reason: 'Telegram rejected it as a photo; re-sent as document' })
      }
      // Mirror the threadId-clear above so the *next* file in the
      // loop skips the doomed thread without paying for another
      // round trip + retry.
      if (threadId != null && sent.message_thread_id == null) {
        threadId = undefined
      }
      sentIds.push(sent.message_id)
    }
  }

  // #3038: surface photo→document reroutes in the tool result — the
  // agent otherwise only "sees" success and may tell the user an inline
  // image rendered when it went out as a file attachment.
  const result = (sentIds.length === 1
    ? `sent (id: ${sentIds[0]})`
    : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`)
    + rerouteResultSuffix(documentReroutes)

  if (HISTORY_ENABLED && sentIds.length > 0) {
    try {
      const fileCount = files.length
      const textCount = sentIds.length - fileCount
      const texts: string[] = []
      const attachKinds: (string | null)[] = []
      for (let i = 0; i < textCount; i++) { texts.push(chunks[i] ?? ''); attachKinds.push(null) }
      for (let i = 0; i < fileCount; i++) {
        const f = files[i] ?? ''
        const ext = extname(f).toLowerCase()
        // #3038: record what was ACTUALLY sent — a photo-extension file
        // rerouted to sendDocument (precheck or reactive fallback) is a
        // 'document' in history, not a 'photo' from its raw extension.
        const kind = PHOTO_EXTS.has(ext) && !sentAsDocument.has(f) ? 'photo' : 'document'
        texts.push(`(${kind}: ${f})`)
        attachKinds.push(kind)
      }
      recordOutbound({ chat_id, thread_id: threadId ?? null, message_ids: sentIds, texts, attachment_kinds: attachKinds })
    } catch (err) {
      process.stderr.write(`telegram gateway: history recordOutbound (reply) failed: ${err}\n`)
    }
  }

  // Issue #137: signal to the progress driver that an actual outbound
  // landed, so a turn-end with replyToolCalled=true but zero deliveries
  // can render the "⚠️ Reply attempted but not delivered" variant.
  if (sentIds.length > 0) {
    try {
      progressDriver?.recordOutboundDelivered(
        chat_id,
        threadId != null ? String(threadId) : undefined,
      )
    } catch { /* best-effort signal */ }
    // #203: fresh sendMessage from reply tool is a user-visible signal.
    signalTracker.noteSignal(statusKey(chat_id, threadId), Date.now())
    // #1713: the reply tool is a NON-EVENT for the status reaction
    // WHEN IT'S AN INTERIM ACK. The reaction reflects current turn
    // activity, not delivery state — interim acks must not collapse
    // the working-state ladder to 👍.
    //
    // #1728 carve-out (2026-05-24): when this reply IS the final
    // answer (`isFinalAnswerReply` returns true — same classifier
    // #1664 uses for silent-end re-prompt gating), it IS effectively
    // turn-end and we MUST finalize here. Rationale: Claude Code's
    // `turn_duration` system event is unreliable for the trivial-
    // prompt happy path (driver sends "what's 2+2", model replies
    // "4", no `turn_duration` ever lands in the JSONL session tail).
    // Pre-#1718 this wedge was masked by the legacy
    // `endStatusReaction` shim running unconditionally on every
    // reply (outcome='done'); #1718 removed that call site
    // intending `turn_end` to be the sole terminal trigger. The
    // contract was right in spirit but `turn_end` doesn't fire 100%
    // of the time, so the buffer gate (activeTurnStartedAt) stays
    // set forever and every subsequent inbound gets `held mid-turn`
    // and never delivered. v0.13.27 shipped + reverted on this
    // failure mode (#1728).
    //
    // Net contract:
    //   - interim ack reply (isFinalAnswerReply === false)
    //         → non-event, no reaction finalize, buffer gate stays
    //   - final-answer reply (isFinalAnswerReply === true)
    //         → finalize reaction (debounced 👍) + release buffer
    //           gate via purgeReactionTracking (called inside
    //           finalizeStatusReaction). currentTurn stays alive so
    //           a subsequent `turn_end` still cleans up its share
    //           idempotently.
    //
    // #1664 — `turn.finalAnswerDelivered = true` keeps the silent-
    // end re-prompt from spuriously firing on a delivered final.
    if (turn != null && isFinalAnswerReply({ text: rawText, disableNotification: modelDisableNotification })) {
      turn.finalAnswerDelivered = true
      // Feed-reopen refinement: track whether this final was substantive
      // (≥200 chars or stream-done — not a short pinging ack) so post-answer
      // housekeeping tool work does NOT re-open the feed / trip silent-end.
      turn.finalAnswerSubstantive = isSubstantiveFinalReply({ text: rawText, disableNotification: modelDisableNotification })
      // Sticky ordering latch (lever 1): set once a SUBSTANTIVE final lands;
      // never cleared by reopen. The card OPEN gate keys on this, not the
      // mutable finalAnswerDelivered above (which reopen toggles).
      if (turn.finalAnswerSubstantive) turn.finalAnswerEverDelivered = true
      if (turn.finalAnswerSubstantive && turn.finalAnswerDeliveredAt == null) turn.finalAnswerDeliveredAt = Date.now()
      // #1728: release the buffer gate + emit terminal 👍. Mid-turn
      // acks bypass this branch and remain non-events for the
      // reaction (preserves #1713). The full turn-state teardown
      // (nulling `currentTurn`, the per-turn cleanup) still runs in
      // the `turn_end` handler when it lands; this only fires the
      // observable side effects that #1718 deferred unconditionally.
      finalizeStatusReaction(chat_id, threadId, 'done')
      // PR2: close this origin's obligation on a SUBSTANTIVE final answer
      // (after finalize so the reaction guard test's anchor window is stable).
      if (turn.finalAnswerSubstantive) closeObligationOnSubstantiveReply(args, turn, replyRoutedOriginTurn)
    }
    // v0.13.30 follow-up — release the buffer gate on EVERY reply
    // finalize, not just on `isFinalAnswerReply`. The narrow
    // `finalizeStatusReaction` path above misses short replies that
    // set `disable_notification: true` (the model mis-classifies a
    // genuine answer as an interim ack — e.g. "4" for "what's
    // 2+2"). Pre-fix the gate stayed set forever and every later
    // inbound logged `held mid-turn ... will flush on turn-
    // complete` — but turn-complete never came because Claude
    // Code's `turn_duration` system event doesn't reliably land
    // for trivial-prompt turns. v0.13.30 UAT showed the regression
    // (msg 1873 reply at 13:02:46, msg 1874 held at 13:03:04, gate
    // never released).
    //
    // The reaction controller stays alive (preserves #1713
    // bidirectional ladder + the steer-vs-queue logic at
    // gateway.ts:8322 which reads `activeStatusReactions`). Only
    // the buffer gate flips.
    //
    // Component 1: pass the turn so the serialize gate sees this turn's
    // `finalAnswerDelivered` (set just above for final-answer replies).
    // An interim ack leaves it false → the cross-topic buffer does NOT
    // drain yet; the real answer's reply releases it.
    releaseTurnBufferGate(statusKey(chat_id, threadId), turn ?? undefined)
    // Component 5: the final answer landed — reap the queued-status
    // placeholder for THIS turn's topic. Key on the turn's own session
    // thread (where the placeholder was posted / promoted), not the
    // answer's possibly-overridden threadId.
    if (turn?.finalAnswerDelivered === true) {
      reapQueuedStatus(turn.sessionChatId, turn.sessionThreadId)
    }
  }

  process.stderr.write(`telegram channel: reply: finalized chatId=${chat_id} messageIds=[${sentIds.join(',')}] chunks=${chunks.length}\n`)
  // #546 dedup record: future reply / stream_reply / turn-flush
  // calls with this same content within DEFAULT_DEDUP_TTL_MS will
  // be suppressed.
  if (sentIds.length > 0) {
    const t = getCurrentTurn()
    outboundDedup.record(chat_id, threadId, text, Date.now(), t?.registryKey ?? null)
    // F1: a SUBSTANTIVE-final reply journals + clears under the shared nonce
    // (turn.turnId === deriveTurnId, the hook's deriveTurnNonce), so the sweep
    // never re-posts this turn's answer.
    //
    // F3: gate on `isSubstantiveFinalReply`, NOT `isFinalAnswerReply`. Unlike
    // the flush site (~1741) and the captured-prose bridge (~2407) — where the
    // journaled text IS this turn's trailing content, so a loose gate is
    // loss-safe — here the journaled text is the REPLY text, a DIFFERENT string
    // from the trailing prose the hook captures under the same turn nonce.
    // `isFinalAnswerReply`'s ping clause (`disableNotification` falsy — the
    // tool's default, routinely omitted by models) classifies a short pinging
    // interim ack ("On it — digging in") as final. Journaling on that ack would
    // poison the turn nonce: the model then ends the turn with gateway-invisible
    // trailing prose (the real answer), the Stop hook captures it under the SAME
    // nonce, and the sweep hits `skip-journaled` → `clearOutboxRecord` → the
    // real answer is silently destroyed — the exact incident class this outbox
    // exists to prevent. `isSubstantiveFinalReply` (`done === true ||
    // length ≥ 200`, no ping path) still journals a genuine answer (so the sweep
    // won't double-post it) while an interim ack never journals (so a later
    // genuinely-undelivered final answer is delivered by the sweep).
    if (shouldJournalReplySiteDelivery({ text: rawText, disableNotification: modelDisableNotification })) {
      journalExternalDelivery({ turnNonce: t?.turnId ?? null, text, tgMessageId: sentIds[sentIds.length - 1], replyAlreadyDeliveredThisTurn: true })
    }
    // ── Buzz co-channel Phase 2b mirror hook (S1/S4) ─────────────────────────
    // STRICTLY downstream of the guaranteed Telegram delivery above: this runs
    // only inside `sentIds.length > 0` (a Telegram copy landed) and is a
    // byte-identical no-op when Buzz is disabled (`getBuzzMirror()` is null).
    // Never throws — the hub swallows its own errors — so a Buzz mirror can
    // never fail, delay, or alter the Telegram answer (the core invariant), and
    // the tool result the model sees reflects the Telegram copy only (S4).
    const buzzMirror = getBuzzMirror()
    if (buzzMirror !== null) {
      const { turn: mOwnerTurn, tier: mOwnerTier } = resolveReplyOwnerTurn(turn, chat_id, args)
      const ownerOrigin = mOwnerTurn?.originChannel ?? 'telegram'
      const ownerTurnId = mOwnerTurn?.turnId ?? null
      // S1 inputs. ownerEchoed: the reply positively echoed the owner turn's id
      // (the `origin` tier is the only one that binds by `origin_turn_id`).
      const ownerEchoed = mOwnerTier === 'origin'
      // hasRecentDifferentOriginTurn: is there a recent turn of a DIFFERENT
      // origin than the resolved owner (the live turn, or the chat's latest
      // ended turn) that this reply could otherwise have belonged to? Deterministic.
      const latestEnded = findLatestTurnForChat(chat_id, { endedOnly: true })
      const hasRecentDifferentOriginTurn = [turn, latestEnded].some(
        (c) => c != null && c.turnId !== ownerTurnId && c.originChannel !== ownerOrigin,
      )
      buzzMirror.mirrorReplyDelivered({
        scrubbedText: text,
        ownerOriginChannel: ownerOrigin,
        ownerBuzzCoords: mOwnerTurn?.buzzCoords,
        ownerEchoed,
        hasRecentDifferentOriginTurn,
        telegramMessageKeys: sentIds.map((id) => `${chat_id}:${id}`),
        // NIP-10 outbound thread continuity: the Telegram message THIS answer
        // replied to (its finalized `reply_to`, whether model-supplied or the
        // quote-opt-in default). The mirror resolves it against the durable
        // correlation store and threads under it only on a HIT (a previously-
        // mirrored answer); a user inbound / evicted key misses → flat.
        //
        // Guards:
        //  - #4300: when `replyMode === 'off'` the Telegram copy renders NO
        //    reply, so DON'T stamp the antecedent — keep the Buzz copy flat too
        //    (surface parity; no threading the Buzz copy visibly threads on).
        //  - #4301: `Number.isFinite` drops a non-numeric `reply_to` (→ `NaN`)
        //    so it never becomes a bogus `chat:NaN` key that logs as a real miss.
        antecedentTelegramMessageKey: resolveMirrorAntecedentKey(chat_id, reply_to, replyMode),
        antecedentIsQuoteOptInDefault: antecedentFromQuoteOptInDefault,
      })
    }
  }
  return { content: [{ type: 'text', text: result }] }
}

/** Gateway dependencies for {@link deliverCapturedProse}. */
export interface DeliverCapturedProseDeps {
  /** THE one live dedup instance — shared with {@link sendReply} and the
   *  stream-render surface (Amendment 1/9). */
  outboundDedup: OutboundDedupCache
  bot: Bot<Context>
  robustApiCall<T>(fn: () => Promise<T>, opts?: RetryCallOpts): Promise<T>
  redactOutboundText(text: string, site: string): string
  recordOutbound(rec: {
    chat_id: string
    thread_id: number | null
    message_ids: number[]
    texts: string[]
  }): void
  HISTORY_ENABLED: boolean
  OBLIGATION_LEDGER_ENABLED: boolean
  obligationLedger: { close(originTurnId: string): void }
  clearSilentEndState(key: string): void
  recordUndeliveredTurnEnd(
    args: { chatId: string; threadId: number | null; turnKey: string },
    deps?: SilentEndDeps,
  ): { exhausted: boolean }
  hasOutboundDeliveredSince(
    chatId: string,
    sinceMs: number,
    threadId: number | null | undefined,
    minCount?: number,
  ): boolean
}

/**
 * Silent-end recovery delivery (#3228) — `deliverCapturedProse`'s body,
 * verbatim. A separate inline send path from the reply orchestration (it
 * delivers the model's terminal prose recovered from the transcript scan when
 * the turn ended silently); routed into this module so it shares the ONE
 * injected `outboundDedup` instance and the golden harness (Amendment 2).
 */
export async function deliverCapturedProse(
  deps: DeliverCapturedProseDeps,
  args: {
  chatId: string
  threadId: number | undefined
  statusKeyStr: string
  registryKey: string | null
  originTurnId: string
  text: string
  /** Turn elapsed for the honest "(waited Ns)" apology clause; optional. */
  turnDurationMs?: number
  /**
   * #4141 — this turn's reply tool threw, so `text` is prose the model wrote
   * AFTER its delivery attempt failed, not text it chose to send as the answer.
   * When `true` the send is prefixed with a one-line provenance banner. This is
   * the ELECTED-path counterpart of the outbox sweep's framing: on this path
   * the Stop hook defers to the single-writer election and writes NO outbox
   * record, so the sweep's framing can never reach the message.
   */
  replyToolThrewThisTurn?: boolean
  /**
   * #4490 — this turn originated from a self-improvement review inbound
   * (`source="self_improve_review"`). Stamped by the Stop hook's
   * single-writer election onto the `SilentEndState` file (the ONLY way this
   * path — which never writes an outbox record — can learn a review turn's
   * provenance) and threaded through `decideCapturedProseDelivery`. Gates the
   * SAME audience-suppression / title-framing rules the outbox sweep applies
   * to a review record, restoring the #4141-style symmetry #4485 left
   * one-sided (card gate + title framing applied at the sweep only).
   */
  reviewOriginated?: boolean
  },
): Promise<void> {
  const {
    outboundDedup, bot, robustApiCall, redactOutboundText, recordOutbound,
    HISTORY_ENABLED, OBLIGATION_LEDGER_ENABLED, obligationLedger,
    clearSilentEndState, recordUndeliveredTurnEnd, hasOutboundDeliveredSince,
  } = deps
  const { chatId, threadId, statusKeyStr, registryKey, originTurnId, text, turnDurationMs } = args
  const now = Date.now()
  // #4141 — framing is a rendering concern, decided ONCE here and applied only
  // to the bytes handed to Telegram. Everything keyed on identity (the dedup
  // check + record below, and the journal's `textSha256`) deliberately keeps
  // using the RAW `text`, so the label cannot change what counts as "the same
  // answer" — a later reply-tool retry of the same prose still dedups, and the
  // exactly-once-among-backstops journal key is unchanged. Same
  // additive-by-construction property the sweep path has, re-established here
  // because this path has its own send ladder and its own dedup.
  const framed = shouldFrameReplyThrow(
    { replyToolThrewThisTurn: args.replyToolThrewThisTurn },
    { frameEnabled: process.env.SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING !== '0' },
  )
  // #4490 — CARD GATE, primary: same two-layer design the outbox sweep uses
  // (`audience-classify.mjs`'s module doc). `decideCaptureAudience` checks
  // `reviewOriginated` independent of the reply-throw path above: a review
  // turn's prose classifies `internal` UNLESS the text itself is the one
  // sanctioned card (`isSelfImprovementCard`), in which case it's `user` and
  // delivered normally. A non-review turn's `reviewOriginated` is `false`/
  // `undefined`, which never enters this branch — so this can only ever
  // ADD suppression to a review turn, never touch a normal answer.
  const audienceGateEnabled = process.env.SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE !== '0'
  const audience = decideCaptureAudience({
    reviewOriginated: args.reviewOriginated === true,
    reviewTextIsCard: isSelfImprovementCard(text),
  })
  const suppressed = audienceGateEnabled && audience === AUDIENCE_INTERNAL
  // #4490 — TITLE FRAMING, residual belt-and-braces: applied OUTERMOST, after
  // the reply-throw banner, exactly mirroring `decideOutboxSweep`'s ordering
  // (`outbox.ts`). Only reachable when the card gate is disabled (or a
  // legacy/`user`-audience route) — a review record that IS delivered here
  // must still carry the title so it can never appear as raw, unlabelled
  // agent reasoning even in a degraded config. `!isSelfImprovementCard(text)`
  // keeps this idempotent against a text that already opens with the title
  // (#4489's fix, same discipline).
  const selfImproveFramed =
    !suppressed &&
    shouldFrameSelfImprovement(
      { reviewOriginated: args.reviewOriginated },
      { frameEnabled: process.env.SWITCHROOM_TG_OUTBOX_SELF_IMPROVE_FRAMING !== '0' },
    ) &&
    !isSelfImprovementCard(text)
  // #3228 Finding 1 — the settlement points (sent / skipped-dedup / failed /
  // suppressed-internal) all funnel through the pure
  // `settleCapturedProseDelivery` core so the failure posture is
  // deterministic and unit-tested. `outcome` is set on each branch and
  // applied ONCE at the bottom.
  let outcome: CapturedProseSendOutcome
  if (suppressed) {
    // #4490 — the gap this closes: previously this path had NO audience gate
    // at all, so a non-card review turn's raw reasoning would be sent below
    // exactly like any other captured prose. Suppress before the dedup check
    // and before any send attempt — nothing is delivered, so there is nothing
    // to dedup against.
    journalExternalDelivery({
      turnNonce: originTurnId,
      text,
      replyAlreadyDeliveredThisTurn: false,
      audience,
      suppressedAudience: AUDIENCE_INTERNAL,
    })
    process.stderr.write(
      formatInternalSuppression({
        turnNonce: originTurnId,
        turnId: originTurnId,
        chatId,
        textSha256: sha256Hex(text),
        source: 'captured-prose-bridge',
      }),
    )
    outcome = 'suppressed-internal'
  } else {
  const already = outboundDedup.check(chatId, threadId, text, now, registryKey)
  if (already == null) {
    let out = normalizeParagraphBreaks(repairEscapedWhitespace(framed ? applyReplyThrowFraming(text) : text))
    out = selfImproveFramed ? applySelfImprovementFraming(out) : out
    out = redactOutboundText(out, 'captured_prose')
    const chunks = splitMarkdownChunks(out, RICH_MESSAGE_MAX_CHARS)
    const sentIds: number[] = []
    try {
      let liveThreadId: number | undefined = threadId
      for (const c of chunks) {
        const sent = await retryWithThreadFallback(
          robustApiCall,
          (tid) => {
            // Built as a variable (not an inline literal) so excess-property
            // checks don't reject `link_preview_options` on sendRichMessage's
            // narrow Other<> type — mirrors the turn-flush send site.
            const opts = {
              link_preview_options: { is_disabled: true },
              ...(tid != null ? { message_thread_id: tid } : {}),
            }
            return bot.api.sendRichMessage(chatId, richMessage(c), opts)
          },
          { threadId: liveThreadId, chat_id: chatId, verb: 'captured-prose.sendMessage' },
        )
        if (liveThreadId != null && (sent as { message_thread_id?: number }).message_thread_id == null) {
          liveThreadId = undefined
        }
        sentIds.push(sent.message_id)
      }
      if (HISTORY_ENABLED && sentIds.length > 0) {
        try {
          recordOutbound({
            chat_id: chatId,
            thread_id: threadId ?? null,
            message_ids: sentIds,
            texts: chunks,
          })
        } catch {}
      }
      // Record what we just sent so a late reply / stream_reply retry with the
      // same content is deduped at its send site (the #546 dedup cache).
      outboundDedup.record(chatId, threadId, text, now, registryKey)
      // F1: captured-prose delivery journals + clears under the shared nonce
      // (`originTurnId` === turn.turnId === deriveTurnId, the hook's nonce).
      // #3510/#3511: the bridge only runs when NO genuine final answer was
      // delivered this turn (`decideTurnEndGate` → 'reprompt' requires
      // `finalAnswerDelivered === false`), so stamp `false` explicitly. A
      // journal line from this site following a reply-tool line under the same
      // nonce (replyAlreadyDeliveredThisTurn:true) is direct, journal-only
      // proof of a bridge double-send.
      journalExternalDelivery({
        turnNonce: originTurnId,
        text,
        tgMessageId: sentIds[sentIds.length - 1],
        replyAlreadyDeliveredThisTurn: false,
        // #4141 durable terminal stamp — parity with the sweep's
        // `DeliveredEntry.framedProvenance`, so "was this labelled?" is
        // answerable from the journal alone, hours later.
        ...(framed ? { framedProvenance: 'reply-throw' as const } : {}),
        // #4490 durable terminal stamp — parity with the sweep's
        // `DeliveredEntry.framedSelfImprovement`.
        ...(selfImproveFramed ? { framedSelfImprovement: 'self-improve' as const } : {}),
        // #4490 — stamp the audience decision on every journal line from this
        // site, not only the suppressed one, so "what audience did this
        // classify as" is answerable from the journal alone even for a
        // successful send (parity with the outbox sweep's journal rows).
        audience,
      })
      process.stderr.write(
        `telegram gateway: captured-prose delivery — sent ${out.length} chars recovered from ` +
          `transcript scan (chat=${chatId} origin=${originTurnId})\n`,
      )
      if (framed) {
        process.stderr.write(
          formatReplyThrowFraming({
            turnNonce: originTurnId,
            turnId: originTurnId,
            chatId,
            textSha256: sha256Hex(text),
            source: 'captured-prose-bridge',
          }),
        )
      }
      if (selfImproveFramed) {
        process.stderr.write(
          formatSelfImprovementFraming({
            turnNonce: originTurnId,
            turnId: originTurnId,
            chatId,
            textSha256: sha256Hex(text),
            source: 'captured-prose-bridge',
          }),
        )
      }
      outcome = 'sent'
    } catch (err) {
      // #3228 Finding 1 — the send threw, so the answer did NOT reach the user.
      // The `failed` outcome routes to `settleCapturedProseDelivery`'s recovery
      // path (recordUndelivered), NOT the close/clear path. This is load-bearing:
      // the shared turn-end teardown (endCurrentTurnAtomic →
      // decideObligationTurnEnd) already closes the obligation whenever
      // `replyCalled === true` — exactly the interim-ack case that routes here —
      // so "leaving the obligation open" is not a real net. Arming the Stop-hook
      // re-prompt makes the failed send recoverable instead of silently lost.
      process.stderr.write(
        `telegram gateway: captured-prose delivery failed: ${(err as Error).message} — ` +
          `arming the silent-end re-prompt net (recordUndeliveredTurnEnd) so the ` +
          `answer is recoverable (chat=${chatId} origin=${originTurnId})\n`,
      )
      outcome = 'failed'
    }
  } else {
    process.stderr.write(
      `telegram gateway: captured-prose delivery skipped — this answer already went out ` +
        `(dedup age=${already.ageMs}ms chat=${chatId} origin=${originTurnId}); settling bookkeeping\n`,
    )
    outcome = 'skipped-dedup'
  }
  }
  // Apply the settlement bookkeeping through the pure core (#3228 Finding 1):
  //   sent / skipped-dedup / suppressed-internal → close obligation + clear
  //                          state (either the answer is with the user, or it
  //                          was never meant to reach them — either way the
  //                          represent + exhausted fallback must not fire).
  //   failed               → arm the Stop-hook re-prompt net (recordUndelivered),
  //                          do NOT close/clear.
  const settlement = settleCapturedProseDelivery(outcome, {
    closeObligation: () => {
      if (OBLIGATION_LEDGER_ENABLED) {
        try { obligationLedger.close(originTurnId) } catch {}
      }
    },
    clearState: () => clearSilentEndState(statusKeyStr),
    recordUndelivered: () => {
      try {
        const silentEndDeps: SilentEndDeps | undefined = HISTORY_ENABLED
          ? {
              hasOutboundDeliveredSince: (cid, sinceMs, tid) =>
                hasOutboundDeliveredSince(cid, sinceMs, tid, 1),
            }
          : undefined
        return recordUndeliveredTurnEnd(
          { chatId, threadId: threadId ?? null, turnKey: statusKeyStr },
          silentEndDeps,
        )
      } catch (netErr) {
        process.stderr.write(
          `telegram gateway: captured-prose recovery-net arm failed: ${
            (netErr as Error).message
          } (chat=${chatId} origin=${originTurnId})\n`,
        )
        // Could not even record the undelivered turn — do NOT claim exhaustion
        // (firing a fallback we can't justify). Fail safe: leave recovery to
        // the obligation represent / next Stop hook.
        return { exhausted: false }
      }
    },
  })

  // Exhaustion-boundary gap (#3228): the send FAILED on the attempt where the
  // Stop-hook re-prompt budget was already spent, so recordUndeliveredTurnEnd
  // cleared the state and the re-prompt can no longer recover the answer — and
  // the obligation was already closed by the interim-ack teardown. Without this
  // the user gets NEITHER the answer NOR the apology. Deliver a user-facing
  // fallback, preferring the REAL answer as plain text (a non-rich send often
  // survives the markdown/parse error the rich send threw on) before the
  // generic apology.
  if (outcome === 'failed' && settlement.exhausted) {
    process.stderr.write(
      `telegram gateway: WARN captured-prose exhausted-boundary fallback — rich send ` +
        `failed with the re-prompt budget already spent; attempting a plain-text ` +
        `delivery of the recovered answer before the generic apology ` +
        `(chat=${chatId} origin=${originTurnId})\n`,
    )
    const plain = redactOutboundText(text, 'captured_prose')
    // #4043: these pieces go through the PLAIN `sendMessage` endpoint (4096
    // cap), not the rich one — splitting at RICH_MESSAGE_MAX_CHARS produced
    // pieces Telegram rejects with `message is too long`, so a long recovered
    // answer fell through to the generic apology and was lost.
    const plainChunks = splitPlainTextToCap(plain)
    try {
      let liveThreadId: number | undefined = threadId
      const plainSentIds: number[] = []
      const plainSentTexts: string[] = []
      for (const c of plainChunks) {
        // Plain sendMessage — NO parse_mode / rich rendering — so a markdown
        // construct that made sendRichMessage 400 is sent verbatim instead.
        const sent = await retryWithThreadFallback(
          robustApiCall,
          (tid) =>
            bot.api.sendMessage(
              chatId,
              c,
              tid != null ? { message_thread_id: tid } : {},
            ),
          { threadId: liveThreadId, chat_id: chatId, verb: 'captured-prose-plain-fallback.sendMessage' },
        )
        const sentId = (sent as { message_id?: number }).message_id
        if (sentId != null) { plainSentIds.push(sentId); plainSentTexts.push(c) }
        if (liveThreadId != null && (sent as { message_thread_id?: number }).message_thread_id == null) {
          liveThreadId = undefined
        }
      }
      // The real answer reached the user via plain text — record it so a late
      // reply-tool retry with the same content is deduped at its send site.
      outboundDedup.record(chatId, threadId, text, Date.now(), registryKey)
      // Persist parity: the recovered answer reached the user, so it must land in
      // history.db too (mirrors the canonical persist above at the recordOutbound
      // reply site). Without this the plain-text-recovered answer is silently
      // absent from get_recent_messages / handoff briefings / the represent
      // guard's outbound counting. Best-effort — the delivery already succeeded.
      if (HISTORY_ENABLED && plainSentIds.length > 0) {
        try {
          recordOutbound({ chat_id: chatId, thread_id: threadId ?? null, message_ids: plainSentIds, texts: plainSentTexts })
        } catch (histErr) {
          process.stderr.write(
            `telegram gateway: history recordOutbound (captured-prose plain fallback) failed: ${
              histErr instanceof Error ? histErr.message : String(histErr)
            }\n`,
          )
        }
      }
      process.stderr.write(
        `telegram gateway: captured-prose recovered via plain-text fallback ` +
          `(chat=${chatId} origin=${originTurnId})\n`,
      )
    } catch (plainErr) {
      // Plain text ALSO failed — post the generic apology so the turn is never
      // silent (mirrors the non-captured exhausted path, gateway turn_end #1161).
      process.stderr.write(
        `telegram gateway: captured-prose plain-text fallback ALSO failed: ${
          (plainErr as Error).message
        } — posting the generic silent-end apology (chat=${chatId} origin=${originTurnId})\n`,
      )
      void retryWithThreadFallback(
        robustApiCall,
        (tid) =>
          bot.api.sendMessage(
            chatId,
            silentEndFallbackText(turnDurationMs),
            tid != null ? { message_thread_id: tid } : {},
          ),
        { threadId, chat_id: chatId, verb: 'captured-prose-apology-fallback.sendMessage' },
      ).catch((err) => {
        process.stderr.write(
          `telegram gateway: captured-prose apology fallback send failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
      })
    }
  }
}
