/**
 * photo-precheck.ts — pre-send validation for images attached via the
 * reply tool's `files` param (#3033, layer 2 of the media-dimension
 * defense-in-depth).
 *
 * Telegram's photo path (sendPhoto / sendMediaGroup type:photo) rejects
 * images it can't store as photos with a 400 PHOTO_INVALID_DIMENSIONS /
 * PHOTO_SAVE_FILE_INVALID. One bad photo fails a WHOLE sendMediaGroup
 * album. The reactive fallback (#3022) re-sends as documents after the
 * 400 bounces back — this module catches the offenders BEFORE the wire
 * so good photos still ship as an album and the bad one goes out as a
 * document on the first attempt.
 *
 * Bounds (deterministic, documented):
 *   - width + height ≤ 10000 px      (Bot API documented cap)
 *   - aspect ratio   ≤ 10 : 1        (docs say 20:1, but the 2026-07-11
 *     clerk incident had 600x8717 — ratio 14.5:1, sum 9317 — rejected
 *     with PHOTO_INVALID_DIMENSIONS, so the documented limit is not what
 *     the server enforces for uploads. 10:1 is conservative: real phone
 *     screenshots are ≤ ~2.5:1; only page-length capture strips exceed
 *     10:1 territory, and those are better as documents anyway.)
 *   - file size      ≤ 10 MB         (photo-path ceiling; documents 50MB)
 *
 * Probe failures (unknown/truncated format) return null and the caller
 * keeps the photo path — the reactive #3022 fallback still backstops.
 * No image decoding, no deps: header-only parsers for PNG / JPEG / GIF /
 * WebP, the formats behind the gateway's PHOTO_EXTS set.
 */

import { readFileSync, statSync } from 'node:fs'

export interface ImageProbe {
  width: number
  height: number
  bytes: number
}

/** Photo-path bounds — see module header for provenance. */
export const PHOTO_MAX_DIMENSION_SUM = 10000
export const PHOTO_MAX_ASPECT_RATIO = 10
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024

/** Parse PNG dimensions: 8-byte signature then IHDR (width/height BE at 16/20). */
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** Parse JPEG dimensions: walk markers to the first SOFn frame header. */
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let off = 2
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue }
    const marker = buf[off + 1]!
    // Standalone markers without a length segment.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      off += 2
      continue
    }
    const len = buf.readUInt16BE(off + 2)
    // SOF0-SOF15 (excluding DHT 0xc4, JPG 0xc8, DAC 0xcc) carry dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
    }
    if (len < 2) return null
    off += 2 + len
  }
  return null
}

/** Parse GIF dimensions (logical screen descriptor, LE at offset 6/8). */
function gifDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null
  const sig = buf.toString('ascii', 0, 6)
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/** Parse WebP dimensions (VP8 / VP8L / VP8X chunk variants). */
function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    // 24-bit LE minus-one canvas dimensions at 24/27.
    const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
    const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
    return { width, height }
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null
    const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    // Lossy: frame tag at 20; sync code 9d 01 2a then 14-bit LE dims.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return { width, height }
  }
  return null
}

/** Header-only dimension probe. Returns null when the format is unrecognized. */
export function probeImageDimensions(buf: Buffer): { width: number; height: number } | null {
  return pngDimensions(buf) ?? jpegDimensions(buf) ?? gifDimensions(buf) ?? webpDimensions(buf)
}

/** Probe an image file on disk. Returns null on read failure or unknown format. */
export function probeImageFile(path: string): ImageProbe | null {
  try {
    const bytes = statSync(path).size
    const dims = probeImageDimensions(readFileSync(path))
    if (!dims || dims.width <= 0 || dims.height <= 0) return null
    return { ...dims, bytes }
  } catch {
    return null
  }
}

/**
 * Why this image cannot go down Telegram's photo path — or null when it
 * fits the bounds. The reason string is operator/agent-legible (it lands
 * in the gateway log and, via the reactive path, in tool errors).
 */
export function photoSendViolation(probe: ImageProbe): string | null {
  const { width, height, bytes } = probe
  if (width + height > PHOTO_MAX_DIMENSION_SUM) {
    return `dimensions ${width}x${height} exceed width+height<=${PHOTO_MAX_DIMENSION_SUM}`
  }
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (ratio > PHOTO_MAX_ASPECT_RATIO) {
    return `aspect ratio ${ratio.toFixed(1)}:1 (${width}x${height}) exceeds ${PHOTO_MAX_ASPECT_RATIO}:1 photo bound`
  }
  if (bytes > PHOTO_MAX_BYTES) {
    return `file size ${(bytes / (1024 * 1024)).toFixed(1)}MB exceeds ${PHOTO_MAX_BYTES / (1024 * 1024)}MB photo ceiling`
  }
  return null
}

/**
 * Decide the send route for a photo-extension file. `photo` = safe for
 * sendPhoto/sendMediaGroup; `document` = pre-route as document (reason
 * says why); probe failure = `photo` (reactive #3022 fallback backstops).
 */
export function classifyPhotoFile(path: string): { route: 'photo' } | { route: 'document'; reason: string } {
  const probe = probeImageFile(path)
  if (!probe) return { route: 'photo' }
  const violation = photoSendViolation(probe)
  return violation ? { route: 'document', reason: violation } : { route: 'photo' }
}
