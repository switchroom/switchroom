/**
 * Pins the #3033 layer-2 pre-send photo validation:
 *   1. header-only dimension probes for PNG / JPEG / GIF / WebP
 *   2. the photo-path bounds (width+height cap, aspect-ratio cap, size cap)
 *   3. classifyPhotoFile routing (violation → document; probe miss → photo)
 *
 * Incident anchor: clerk 2026-07-11 sent a 600x8717 newsletter screenshot
 * in a media group — ratio 14.5:1, WITHIN the documented 20:1 Bot API
 * limit — and Telegram rejected it with PHOTO_INVALID_DIMENSIONS, failing
 * the whole album. The bounds here must classify that image as a document.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  probeImageDimensions,
  probeImageFile,
  photoSendViolation,
  classifyPhotoFile,
  PHOTO_MAX_BYTES,
} from '../photo-precheck.js'

function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8) // IHDR length
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function jpegBuffer(width: number, height: number): Buffer {
  // SOI, APP0 (JFIF stub), SOF0 with dimensions.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof0 = Buffer.alloc(2 + 2 + 5 + 3)
  sof0[0] = 0xff; sof0[1] = 0xc0
  sof0.writeUInt16BE(10, 2) // segment length
  sof0[4] = 8 // precision
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  sof0[9] = 1
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0])
}

function gifBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function webpVp8xBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUInt32LE(10, 16)
  const w = width - 1
  const h = height - 1
  buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff
  return buf
}

describe('probeImageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(probeImageDimensions(pngBuffer(600, 8717))).toEqual({ width: 600, height: 8717 })
  })

  it('reads JPEG SOF0 dimensions past an APP0 segment', () => {
    expect(probeImageDimensions(jpegBuffer(1179, 2556))).toEqual({ width: 1179, height: 2556 })
  })

  it('reads GIF logical screen dimensions', () => {
    expect(probeImageDimensions(gifBuffer(320, 240))).toEqual({ width: 320, height: 240 })
  })

  it('reads WebP VP8X canvas dimensions', () => {
    expect(probeImageDimensions(webpVp8xBuffer(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('returns null for unknown formats and truncated buffers', () => {
    expect(probeImageDimensions(Buffer.from('not an image at all, sorry'))).toBeNull()
    expect(probeImageDimensions(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(probeImageDimensions(Buffer.alloc(0))).toBeNull()
  })
})

describe('photoSendViolation bounds', () => {
  it('accepts a normal phone screenshot (1179x2556)', () => {
    expect(photoSendViolation({ width: 1179, height: 2556, bytes: 500_000 })).toBeNull()
  })

  it('rejects the clerk incident image 600x8717 (ratio 14.5:1, within documented 20:1)', () => {
    const v = photoSendViolation({ width: 600, height: 8717, bytes: 400_000 })
    expect(v).toMatch(/aspect ratio/)
  })

  it('rejects width+height over 10000', () => {
    const v = photoSendViolation({ width: 6000, height: 5000, bytes: 400_000 })
    expect(v).toMatch(/width\+height/)
  })

  it('rejects files over the 10MB photo ceiling', () => {
    const v = photoSendViolation({ width: 1000, height: 1000, bytes: PHOTO_MAX_BYTES + 1 })
    expect(v).toMatch(/exceeds 10MB/)
  })

  it('accepts exactly-at-bound values', () => {
    expect(photoSendViolation({ width: 5000, height: 5000, bytes: PHOTO_MAX_BYTES })).toBeNull()
    expect(photoSendViolation({ width: 800, height: 8800, bytes: 1 })).toMatch(/aspect ratio/) // 11:1
    expect(photoSendViolation({ width: 900, height: 9000, bytes: 1 })).toBeNull() // exactly 10:1
  })
})

describe('probeImageFile + classifyPhotoFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'photo-precheck-'))

  it('probes a PNG file on disk', () => {
    const p = join(dir, 'tall.png')
    writeFileSync(p, pngBuffer(600, 8717))
    expect(probeImageFile(p)).toEqual({ width: 600, height: 8717, bytes: 33 })
  })

  it('routes an out-of-bounds photo to document with a reason', () => {
    const p = join(dir, 'tall2.png')
    writeFileSync(p, pngBuffer(600, 8717))
    const cls = classifyPhotoFile(p)
    expect(cls.route).toBe('document')
    if (cls.route === 'document') expect(cls.reason).toMatch(/aspect ratio 14\.5:1/)
  })

  it('keeps an in-bounds photo on the photo route', () => {
    const p = join(dir, 'ok.png')
    writeFileSync(p, pngBuffer(1179, 2556))
    expect(classifyPhotoFile(p)).toEqual({ route: 'photo' })
  })

  it('keeps the photo route when the file is unreadable or unrecognized (reactive fallback backstops)', () => {
    expect(classifyPhotoFile(join(dir, 'missing.png'))).toEqual({ route: 'photo' })
    const junk = join(dir, 'junk.png')
    writeFileSync(junk, Buffer.from('definitely not a png'))
    expect(classifyPhotoFile(junk)).toEqual({ route: 'photo' })
  })
})
