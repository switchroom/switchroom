/**
 * Outcome pins for the metadata-only attachment inbound handlers extracted
 * from gateway.ts (switchroom#2996 P6 cluster C). Each handler is driven with
 * a fake grammy ctx + a mock coalescing dispatch dep; the assertions pin the
 * EXACT text envelope and AttachmentMeta slot forwarded to
 * handleInboundCoalesced — the behaviour the gateway previously produced inline.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleDocumentMessage,
  handleAudioMessage,
  handleVideoMessage,
  handleVideoNoteMessage,
  handleStickerMessage,
  handleAnimationMessage,
  type AttachmentHandlerDeps,
} from '../gateway/attachment-message-handlers.js'

function makeDeps() {
  const handleInboundCoalesced = vi.fn(async () => {})
  const deps: AttachmentHandlerDeps = { handleInboundCoalesced }
  return { deps, handleInboundCoalesced }
}

// Build a fake ctx whose `message` carries the given content key (+ caption).
function ctxWith(content: Record<string, unknown>): any {
  return { message: content, chat: { id: 42 } }
}

describe('handleDocumentMessage', () => {
  it('renders the document envelope with a sanitized name', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ document: { file_id: 'd1', file_name: 'a<b>.pdf', file_size: 10, mime_type: 'application/pdf' } })
    await handleDocumentMessage(ctx, deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      ctx,
      '(document: a_b_.pdf)',
      undefined,
      { kind: 'document', file_id: 'd1', size: 10, mime: 'application/pdf', name: 'a_b_.pdf' },
    )
  })
  it('prefers the caption and falls back to "file" when unnamed', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ document: { file_id: 'd2' }, caption: 'see this' })
    await handleDocumentMessage(ctx, deps)
    const [, text, , meta] = (handleInboundCoalesced as any).mock.calls[0]
    expect(text).toBe('see this')
    expect(meta).toEqual({ kind: 'document', file_id: 'd2', size: undefined, mime: undefined, name: undefined })
  })
})

describe('handleAudioMessage', () => {
  it('renders title, then name, then "audio" fallback', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ audio: { file_id: 'a1', title: 'Song', file_name: 'x.mp3', file_size: 5, mime_type: 'audio/mpeg' } })
    await handleAudioMessage(ctx, deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      ctx,
      '(audio: Song)',
      undefined,
      { kind: 'audio', file_id: 'a1', size: 5, mime: 'audio/mpeg', name: 'x.mp3' },
    )
  })
})

describe('handleVideoMessage', () => {
  it('renders the video envelope, caption-or-fallback', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ video: { file_id: 'v1', file_size: 9, mime_type: 'video/mp4', file_name: 'clip.mp4' } })
    await handleVideoMessage(ctx, deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      ctx,
      '(video)',
      undefined,
      { kind: 'video', file_id: 'v1', size: 9, mime: 'video/mp4', name: 'clip.mp4' },
    )
  })
})

describe('handleVideoNoteMessage', () => {
  it('renders the fixed video-note envelope', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ video_note: { file_id: 'vn1', file_size: 3 } })
    await handleVideoNoteMessage(ctx, deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      ctx,
      '(video note)',
      undefined,
      { kind: 'video_note', file_id: 'vn1', size: 3 },
    )
  })
})

describe('handleStickerMessage', () => {
  it('includes emoji and set name when present', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ sticker: { file_id: 's1', emoji: '🎉', set_name: 'Party', file_size: 2 } })
    await handleStickerMessage(ctx, deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      ctx,
      '(sticker — 🎉 from "Party")',
      undefined,
      { kind: 'sticker', file_id: 's1', size: 2 },
    )
  })
  it('falls back to bare "(sticker)" with no emoji/set', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ sticker: { file_id: 's2' } })
    await handleStickerMessage(ctx, deps)
    const [, text] = (handleInboundCoalesced as any).mock.calls[0]
    expect(text).toBe('(sticker)')
  })
})

describe('handleAnimationMessage', () => {
  it('prefixes the caption to the gif envelope', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ animation: { file_id: 'g1', file_size: 7, mime_type: 'video/mp4', file_name: 'a.gif' }, caption: 'perfect' })
    await handleAnimationMessage(ctx, deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      ctx,
      '(gif) perfect',
      undefined,
      { kind: 'animation', file_id: 'g1', size: 7, mime: 'video/mp4', name: 'a.gif' },
    )
  })
  it('renders bare "(gif)" when uncaptioned', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    const ctx = ctxWith({ animation: { file_id: 'g2' } })
    await handleAnimationMessage(ctx, deps)
    const [, text] = (handleInboundCoalesced as any).mock.calls[0]
    expect(text).toBe('(gif)')
  })
})
