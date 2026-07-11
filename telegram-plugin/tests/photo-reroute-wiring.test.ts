/**
 * #3038 polish — pins the gateway wiring for the photo→document reroute
 * honesty surfaces added after PR #3037:
 *
 *   1. executeReply's tool result appends `rerouteResultSuffix(...)` so
 *      the agent learns files went out as documents, not inline photos
 *      (it otherwise only sees "sent (id: N)" and may tell the user an
 *      inline screenshot rendered).
 *   2. attachment_kinds history records what was ACTUALLY sent: a
 *      photo-extension file in the `sentAsDocument` set is recorded as
 *      'document', covering both the precheck reroute and the #3022
 *      reactive fallback paths.
 *
 * The gateway IIFE is too entangled to instantiate in-process; source-
 * level assertions follow the `buffer-gate-broadened.test.ts` pattern.
 * The pure formatting/probe logic is unit-tested in
 * `photo-precheck.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

// Slice executeReply's file-send + result + history block: from the
// photo-precheck anchor to the recordOutbound call for replies.
const sliceStart = gatewaySrc.indexOf('const photoPrecheck = new Map')
const sliceEnd = gatewaySrc.indexOf('history recordOutbound (reply) failed')
const slice = gatewaySrc.slice(sliceStart, sliceEnd)

describe('reroute signal reaches the reply tool result (#3038 item 1)', () => {
  it('slices resolve (anchors present in executeReply)', () => {
    expect(sliceStart).toBeGreaterThan(-1)
    expect(sliceEnd).toBeGreaterThan(sliceStart)
  })

  it('imports rerouteResultSuffix from photo-precheck', () => {
    expect(gatewaySrc).toMatch(/import \{ classifyPhotoFile, rerouteResultSuffix \} from '\.\.\/photo-precheck\.js'/)
  })

  it('appends rerouteResultSuffix(documentReroutes) to the result text', () => {
    // The suffix must be part of the `result` expression the tool returns.
    const resultIdx = slice.indexOf('const result =')
    expect(resultIdx).toBeGreaterThan(-1)
    const resultExpr = slice.slice(resultIdx, slice.indexOf('\n\n', resultIdx))
    expect(resultExpr).toContain('rerouteResultSuffix(documentReroutes)')
  })

  it('precheck reroutes populate documentReroutes AND sentAsDocument', () => {
    const precheckBlock = slice.slice(0, slice.indexOf('sendableAsPhoto ='))
    expect(precheckBlock).toContain("if (cls.route === 'document')")
    expect(precheckBlock).toContain('documentReroutes.push({ path: f, reason: cls.reason })')
    expect(precheckBlock).toContain('sentAsDocument.add(f)')
  })

  it('reactive fallbacks (album + per-file, #3022) also record the reroute', () => {
    // Album-wide fallback loop.
    const albumIdx = slice.indexOf('albumReason')
    expect(albumIdx).toBeGreaterThan(-1)
    // Per-file sendPhoto→sendDocument fallback: sendAsDocument followed by
    // both bookkeeping calls.
    const perFile = slice.indexOf('sent = await sendAsDocument(f)')
    expect(perFile).toBeGreaterThan(-1)
    const afterPerFile = slice.slice(perFile, perFile + 400)
    expect(afterPerFile).toContain('sentAsDocument.add(f)')
    expect(afterPerFile).toContain('documentReroutes.push')
  })
})

describe('attachment_kinds records what was actually sent (#3038 item 2)', () => {
  it('history kind consults sentAsDocument, not just the raw extension', () => {
    const historyIdx = slice.indexOf('const attachKinds')
    expect(historyIdx).toBeGreaterThan(-1)
    const historyBlock = slice.slice(historyIdx)
    expect(historyBlock).toContain("PHOTO_EXTS.has(ext) && !sentAsDocument.has(f) ? 'photo' : 'document'")
    // Both the human-readable text label and the kinds array use the
    // resolved kind.
    expect(historyBlock).toMatch(/texts\.push\(`\(\$\{kind\}/)
    expect(historyBlock).toContain('attachKinds.push(kind)')
  })
})
