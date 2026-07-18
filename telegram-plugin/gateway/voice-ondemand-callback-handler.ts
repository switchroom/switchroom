/**
 * On-demand voice ('🔊 Listen') callback family (`voice:<token>`) extracted
 * verbatim from the gateway's `callback_query:data` dispatcher
 * (switchroom#2996 P6 dispatcher drain).
 *
 * Handles the tap INTERNALLY — synthesizes the cached reply text and sends it
 * as a native voice note. MUST run before the agent-callback routing in the
 * dispatcher so a tap never reaches the agent as an inbound message.
 *
 * Returns true when the callback was a voice-on-demand tap (handled —
 * dispatcher must `return`), false otherwise (dispatcher falls through).
 *
 * DI note (check-bot-api-wrapping, cluster-F pattern): the raw
 * `bot.api.sendVoice` / `bot.api.editMessageReplyMarkup` calls are NOT made
 * here — they are injected as `sendVoiceByFileId` / `sendVoiceByUpload` /
 * `stripListenKeyboard`, bound in gateway.ts inside `robustApiCall(...)` with
 * their existing allow-raw-bot-api markers. This module has no raw Bot API
 * site.
 */

import { readFileSync } from 'node:fs'
import type { Context } from 'grammy'
import {
  isVoiceOnDemandCallback,
  parseVoiceOnDemandToken,
  type VoiceOnDemandPayload,
} from '../voice-ondemand.js'
import { sendVoiceReusingFileId, type SentVoiceMessage } from '../voice-send.js'
import { synthesizeViaSidecar } from '../voice-synthesize-sidecar.js'
import { normalizeForTts } from '../tts-normalize.js'
import { materializeSidecarToken } from '../../src/telegram/materialize-sidecar-token.js'

export interface VoiceSendOpts {
  reply_parameters?: { message_id: number }
  message_thread_id?: number
}

export interface VoiceOnDemandCallbackDeps {
  loadAccess: () => { allowFrom: string[] }
  voiceOnDemandCache: {
    get: (token: string) => VoiceOnDemandPayload | null
    setTelegramFileId: (token: string, fileId: string) => void
  }
  /** robustApiCall(() => bot.api.sendVoice(chatId, fileId, opts), verbOpts) — bound in gateway.ts. */
  sendVoiceByFileId: (
    chatId: string,
    fileId: string,
    sendOpts: VoiceSendOpts,
    threadId: number | undefined,
  ) => Promise<SentVoiceMessage>
  /** robustApiCall(() => bot.api.sendVoice(chatId, new InputFile(audio), opts), verbOpts) — bound in gateway.ts. */
  sendVoiceByUpload: (
    chatId: string,
    audio: Uint8Array,
    sendOpts: VoiceSendOpts,
    threadId: number | undefined,
  ) => Promise<SentVoiceMessage>
  /** robustApiCall(() => bot.api.editMessageReplyMarkup(...)) — bound in gateway.ts; swallows failure. */
  stripListenKeyboard: (
    chatId: string,
    messageId: number,
    threadId: number | undefined,
  ) => Promise<void>
  /** stderr log sink. */
  log: (line: string) => void
}

/** Handle a `voice:` callback. Returns false if `data` is not one. */
export async function handleVoiceOnDemandCallback(
  ctx: Context,
  data: string,
  deps: VoiceOnDemandCallbackDeps,
): Promise<boolean> {
  if (!isVoiceOnDemandCallback(data)) return false
  const access = deps.loadAccess()
  const senderId = String(ctx.from!.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return true
  }
  const token = parseVoiceOnDemandToken(data)
  const entry = token != null ? deps.voiceOnDemandCache.get(token) : null
  if (entry == null) {
    await ctx
      .answerCallbackQuery({ text: 'Voice expired — send again to hear it.' })
      .catch(() => {})
    return true
  }
  const cbChatId = String(ctx.chat?.id ?? ctx.from!.id)
  const cbMessageId = ctx.callbackQuery?.message?.message_id
  const cbThreadId = (() => {
    const msg = ctx.callbackQuery?.message
    if (msg && 'is_topic_message' in msg && msg.is_topic_message && 'message_thread_id' in msg) {
      const tid = (msg as { message_thread_id?: number }).message_thread_id
      return typeof tid === 'number' ? tid : undefined
    }
    return undefined
  })()
  const tok = token as string
  const sendOpts: VoiceSendOpts = {
    ...(cbMessageId != null ? { reply_parameters: { message_id: cbMessageId } } : {}),
    ...(cbThreadId != null ? { message_thread_id: cbThreadId } : {}),
  }

  // #2763 attach-on-tap: prefer the eagerly pre-synthesized file (written by
  // the pre-synth queue at reply time). If it's on disk, attach it
  // immediately — no GPU wait. Missing/unreadable file (expired + swept,
  // crash, pre-feature entry, kill-switched gateway) falls back transparently
  // to the lazy synth path. Only invoked when there's no reusable file_id (or
  // a stored id was rejected as stale) — see sendVoiceReusingFileId.
  const loadAudio = async (): Promise<Uint8Array | null> => {
    let audio: Uint8Array | null = null
    if (entry.filePath != null) {
      try {
        audio = readFileSync(entry.filePath)
      } catch {
        audio = null // swept/missing — lazy fallback
      }
    }
    if (audio != null) {
      await ctx.answerCallbackQuery({ text: '🔊' }).catch(() => {})
      return audio
    }
    await ctx.answerCallbackQuery({ text: '🔊 Synthesizing…' }).catch(() => {})
    // Local sidecar (kokoro) synthesis — same helper the immediate voice-out
    // path uses. On-demand is a local-engine feature; the cache is only
    // populated when resolveVoiceOutPlan gated the local verdict.
    const sidecarToken = await materializeSidecarToken()
    if (!sidecarToken) {
      await ctx
        .answerCallbackQuery({ text: 'Voice sidecar unavailable — try again later.' })
        .catch(() => {})
      return null
    }
    const result = await synthesizeViaSidecar({
      token: sidecarToken,
      // #2760 Phase 1: same deterministic normalization as the immediate
      // voice-out path — the Listen lazy path builds its own /tts body from
      // the persisted cache, so it must normalize independently (cache
      // entries may predate the flag flip).
      text: normalizeForTts(entry.text),
      voice: entry.voice,
      speed: entry.speed,
    })
    if (!result.ok) {
      deps.log(
        `telegram gateway: voice-out on-demand: synthesis failed reason=${result.reason}\n`,
      )
      await ctx
        .answerCallbackQuery({ text: `Voice failed: ${result.reason}` })
        .catch(() => {})
      return null
    }
    return result.audio
  }

  // Fast path: if we already captured a reusable file_id, ack instantly and
  // send BY the id — no disk read, no re-upload. First tap (no id yet) and a
  // stale-id fallback both go through loadAudio + InputFile below and refresh
  // the stored id from the returned message.
  if (entry.telegramFileId != null) {
    await ctx.answerCallbackQuery({ text: '🔊' }).catch(() => {})
  }
  const sendResult = await sendVoiceReusingFileId({
    fileId: entry.telegramFileId ?? null,
    sendByFileId: (fid) => deps.sendVoiceByFileId(cbChatId, fid, sendOpts, cbThreadId),
    loadAudio,
    sendByUpload: (audioOut) => deps.sendVoiceByUpload(cbChatId, audioOut, sendOpts, cbThreadId),
    onFileId: (fid) => deps.voiceOnDemandCache.setTelegramFileId(tok, fid),
    log: (line) => deps.log(line),
  })

  if (!sendResult.ok) {
    // no-audio already surfaced a toast inside loadAudio; send-failed is
    // logged non-fatally — the '🔊 Listen' keyboard is left intact so the
    // user can retry (only a successful send strips it below).
    if (sendResult.reason === 'send-failed') {
      const err = sendResult.error
      const msg = err instanceof Error ? err.message : String(err)
      deps.log(
        `telegram gateway: voice-out on-demand: sendVoice failed (non-fatal): ${msg}\n`,
      )
    }
    return true
  }
  try {
    // Single-use on SUCCESS: strip the '🔊 Listen' keyboard so the button
    // can't be re-tapped now that the audio has been delivered. Mirrors the
    // agent-button single_use strip (keyboardIsSingleUse) house style.
    // Best-effort + non-fatal — a failed strip only leaves a replayable
    // button, never drops the delivered audio. Only reached on a successful
    // sendVoice; expiry / synth-failure / sidecar-unavailable all return
    // earlier WITHOUT stripping, so the user can retry those.
    if (cbMessageId != null) {
      await deps.stripListenKeyboard(cbChatId, cbMessageId, cbThreadId).catch(() => {})
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.log(
      `telegram gateway: voice-out on-demand: strip-listen-keyboard failed (non-fatal): ${msg}\n`,
    )
  }
  return true
}
