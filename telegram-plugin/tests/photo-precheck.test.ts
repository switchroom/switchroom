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
  rerouteResultSuffix,
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

  // #3038 item 3 — probeImageFile now does fixed-size header reads
  // (openSync + 32 bytes; 64KB window for JPEG) instead of readFileSync.
  // Pin correctness on the same fixture set across every format.
  it('probes JPEG / GIF / WebP files on disk (fixed-size read path)', () => {
    const j = join(dir, 'shot.jpg')
    writeFileSync(j, jpegBuffer(1179, 2556))
    expect(probeImageFile(j)).toMatchObject({ width: 1179, height: 2556 })

    const g = join(dir, 'anim.gif')
    writeFileSync(g, gifBuffer(320, 240))
    expect(probeImageFile(g)).toMatchObject({ width: 320, height: 240 })

    const w = join(dir, 'pic.webp')
    writeFileSync(w, webpVp8xBuffer(1920, 1080))
    expect(probeImageFile(w)).toMatchObject({ width: 1920, height: 1080 })
  })

  it('probes the 600x8717 incident image without reading the whole multi-MB file', () => {
    // Header + 5MB of body: the probe must report full file size but
    // still read dimensions from the fixed-size header window.
    const p = join(dir, 'incident.png')
    const body = Buffer.alloc(5 * 1024 * 1024)
    writeFileSync(p, Buffer.concat([pngBuffer(600, 8717), body]))
    const probe = probeImageFile(p)
    expect(probe).toEqual({ width: 600, height: 8717, bytes: 33 + body.length })
    expect(classifyPhotoFile(p).route).toBe('document')
  })

  it('finds JPEG SOFn past a large metadata segment (within the 64KB window)', () => {
    // SOI + a 40KB APP1 (EXIF-sized) segment, then SOF0. The 32-byte
    // sniff alone cannot see SOF0; the JPEG re-read must.
    const segLen = 40 * 1024
    const app1 = Buffer.alloc(2 + 2 + segLen)
    app1[0] = 0xff; app1[1] = 0xe1
    app1.writeUInt16BE(2 + segLen, 2)
    const sof0 = Buffer.alloc(10)
    sof0[0] = 0xff; sof0[1] = 0xc0
    sof0.writeUInt16BE(8, 2)
    sof0[4] = 8
    sof0.writeUInt16BE(2556, 5)
    sof0.writeUInt16BE(1179, 7)
    const p = join(dir, 'exif.jpg')
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof0]))
    expect(probeImageFile(p)).toMatchObject({ width: 1179, height: 2556 })
  })

  it('returns null (photo route kept) when JPEG SOFn is beyond the 64KB window', () => {
    // Two 40KB APPn segments push SOF0 past the 64KB probe window
    // (a single segment length is 16-bit capped at 65535).
    const segLen = 40 * 1024
    const app1 = Buffer.alloc(2 + 2 + segLen)
    app1[0] = 0xff; app1[1] = 0xe1
    app1.writeUInt16BE(2 + segLen, 2)
    const sof0 = Buffer.alloc(10)
    sof0[0] = 0xff; sof0[1] = 0xc0
    sof0.writeUInt16BE(8, 2)
    sof0[4] = 8
    sof0.writeUInt16BE(8717, 5)
    sof0.writeUInt16BE(600, 7)
    const p = join(dir, 'deep-exif.jpg')
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app1, sof0]))
    expect(probeImageFile(p)).toBeNull()
    // Probe miss → photo route → #3022 reactive fallback backstops.
    expect(classifyPhotoFile(p)).toEqual({ route: 'photo' })
  })

  it('keeps the photo route when the file is unreadable or unrecognized (reactive fallback backstops)', () => {
    expect(classifyPhotoFile(join(dir, 'missing.png'))).toEqual({ route: 'photo' })
    const junk = join(dir, 'junk.png')
    writeFileSync(junk, Buffer.from('definitely not a png'))
    expect(classifyPhotoFile(junk)).toEqual({ route: 'photo' })
  })
})

describe('rerouteResultSuffix (#3038 — reply result tells the agent about reroutes)', () => {
  it('returns empty string when nothing was rerouted', () => {
    expect(rerouteResultSuffix([])).toBe('')
  })

  it('formats a single reroute with basename and reason', () => {
    const s = rerouteResultSuffix([
      { path: '/tmp/x/tall.png', reason: 'aspect ratio 14.5:1 (600x8717) exceeds 10:1 photo bound' },
    ])
    expect(s).toBe(' (1 file(s) sent as document, not inline photo: tall.png: aspect ratio 14.5:1 (600x8717) exceeds 10:1 photo bound)')
  })

  it('joins multiple reroutes and counts them', () => {
    const s = rerouteResultSuffix([
      { path: '/a/one.png', reason: 'r1' },
      { path: '/b/two.jpg', reason: 'r2' },
    ])
    expect(s).toMatch(/^ \(2 file\(s\) sent as document/)
    expect(s).toContain('one.png: r1; two.jpg: r2')
  })
})
