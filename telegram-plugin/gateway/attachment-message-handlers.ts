/**
 * Metadata-only attachment inbound handlers (switchroom#2996 P6 cluster C).
 *
 * The `message:*` attachment content types that carry a downloadable file the
 * agent references by `file_id` and whose gateway handling is a pure metadata
 * render — document, audio, video, video_note, sticker, animation. Each builds
 * a compact text envelope (caption-or-fallback) plus an `AttachmentMeta` slot
 * and hands both to the coalescing inbound pipeline; none of them download the
 * file inline.
 *
 * Deliberately NOT here: `message:photo` (inline bounded CDN download +
 * inbox write) and `message:voice` (Whisper transcription branch) stay inline
 * in gateway.ts — they carry side-effecting IO / host-capability logic and get
 * their own later clusters. The registration lines for all six handlers below
 * stay in gateway.ts (their order is a load-bearing invariant pinned by
 * gateway-handler-registration-wiring.test.ts); each delegates here.
 *
 * The coalescing dispatch surface is injected via `AttachmentHandlerDeps` — no
 * gateway module-scope globals are read here (switchroom#2996 Amendment 9).
 * `safeName` is imported from the cluster-A module (its single owner).
 */

import type { Context, Filter } from 'grammy'
import { safeName } from './media-message-handlers.js'

/** Structural mirror of gateway.ts's `AttachmentMeta` — one attachment slot. */
export interface AttachmentMeta {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

/**
 * Injected dispatch surface. `handleInboundCoalesced` is the normal coalescing
 * inbound pipeline (same access gating / forward-origin parsing as every
 * content handler); these handlers always pass `undefined` for the image
 * downloader — the file flows through the `attachment` slot by `file_id`.
 */
export interface AttachmentHandlerDeps {
  handleInboundCoalesced: (
    ctx: Context,
    text: string,
    downloadImage: undefined,
    attachment?: AttachmentMeta,
  ) => Promise<void>
}

export async function handleDocumentMessage(
  ctx: Filter<Context, 'message:document'>,
  deps: AttachmentHandlerDeps,
): Promise<void> {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await deps.handleInboundCoalesced(
    ctx,
    ctx.message.caption ?? `(document: ${name ?? 'file'})`,
    undefined,
    { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name },
  )
}

export async function handleAudioMessage(
  ctx: Filter<Context, 'message:audio'>,
  deps: AttachmentHandlerDeps,
): Promise<void> {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await deps.handleInboundCoalesced(
    ctx,
    ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`,
    undefined,
    { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name },
  )
}

export async function handleVideoMessage(
  ctx: Filter<Context, 'message:video'>,
  deps: AttachmentHandlerDeps,
): Promise<void> {
  const video = ctx.message.video
  await deps.handleInboundCoalesced(
    ctx,
    ctx.message.caption ?? '(video)',
    undefined,
    { kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name) },
  )
}

export async function handleVideoNoteMessage(
  ctx: Filter<Context, 'message:video_note'>,
  deps: AttachmentHandlerDeps,
): Promise<void> {
  const vn = ctx.message.video_note
  await deps.handleInboundCoalesced(
    ctx,
    '(video note)',
    undefined,
    { kind: 'video_note', file_id: vn.file_id, size: vn.file_size },
  )
}

export async function handleStickerMessage(
  ctx: Filter<Context, 'message:sticker'>,
  deps: AttachmentHandlerDeps,
): Promise<void> {
  const sticker = ctx.message.sticker
  // Render to a clearer text envelope so the agent has signal to
  // respond to. Includes the emoji (semantic anchor — what mood the
  // sticker maps to) and the set name (so the agent can say "that's
  // from your <set>" if relevant). Both optional. The file_id flows
  // through the attachment field as before, so the agent can echo it
  // back via send_sticker if it wants to mirror the sticker.
  const parts: string[] = []
  if (sticker.emoji) parts.push(sticker.emoji)
  if (sticker.set_name) parts.push(`from "${sticker.set_name}"`)
  const text = parts.length > 0 ? `(sticker — ${parts.join(' ')})` : '(sticker)'
  await deps.handleInboundCoalesced(
    ctx,
    text,
    undefined,
    { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size },
  )
}

export async function handleAnimationMessage(
  ctx: Filter<Context, 'message:animation'>,
  deps: AttachmentHandlerDeps,
): Promise<void> {
  // Animation = Telegram's GIF type (MP4-encoded looping clips).
  // Caption is optional; if present it carries the user's intent
  // (e.g. "perfect 👌"); if absent, the GIF itself is the message.
  // Surfaces to the agent so it can respond in kind via send_gif —
  // mirroring is fine for assistant-style personas, less so for
  // coding ones.
  const animation = ctx.message.animation
  const caption = ctx.message.caption
  const text = caption ? `(gif) ${caption}` : '(gif)'
  await deps.handleInboundCoalesced(
    ctx,
    text,
    undefined,
    {
      kind: 'animation',
      file_id: animation.file_id,
      size: animation.file_size,
      mime: animation.mime_type,
      name: safeName(animation.file_name),
    },
  )
}
