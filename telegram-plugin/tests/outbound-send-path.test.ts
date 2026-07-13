import { describe, it, expect } from 'vitest'
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
import { redact } from '../secret-detect/redact.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import {
  normalizeOutboundBody,
  computeEffectiveText,
  computeReplyChunks,
  resplitOversizeChunk,
  chunkText,
} from '../gateway/outbound-send-path.js'

/**
 * Golden-transcript harness for the outbound send-path extraction (#2996,
 * plan §3B).
 *
 * `executeReply` is not exported (same constraint the sibling
 * gateway-outbound-redact.test.ts documents), so the golden reference is a
 * VERBATIM inline copy of the pre-extraction pipeline transforms (below).
 * Every fixture is run through BOTH the inline reference and the extracted
 * `outbound-send-path.ts` module; the test asserts byte-identical output.
 * If the extraction ever drifts from the inline pipeline, these diverge.
 *
 * The reference below is copied line-for-line from the executeReply entry
 * (normalize → redact → punctuation/bold → voice scrub), the effective-text
 * spacing decision, the chunk decision, and the oversize re-split. The
 * `redact` injected here is the same `redact()` the gateway's
 * `redactOutboundText` wraps.
 */

// ── Verbatim inline reference (the code as it lived in gateway.ts) ──────────

function referenceNormalize(rawText: string): { text: string; voiceReplaced: number } {
  let text = normalizeParagraphBreaks(repairEscapedWhitespace(rawText))
  // redactOutboundText(text, 'reply') → redact(text) (the stderr log is a
  // side effect the pure module leaves to the injected redactor).
  text = redact(text)
  text = stripExcessBold(normalizePunctuation(text))
  let voiceReplaced = 0
  const scrub = scrubVoice(text)
  if (scrub.replaced > 0) {
    text = scrub.scrubbed
    voiceReplaced = scrub.replaced
  }
  return { text, voiceReplaced }
}

function referenceEffectiveText(text: string, _literalText: boolean): string {
  // The NBSP paragraph-spacer pass was removed in the #2669 follow-up; both
  // paths now pass the normalized text through unchanged.
  return text
}

function referenceChunks(
  effectiveText: string,
  literalText: boolean,
  limit: number,
  chunkMode: 'length' | 'newline',
): string[] {
  return literalText
    ? chunkText(effectiveText, limit, chunkMode)
    : splitMarkdownChunks(effectiveText, limit)
}

function referenceResplit(chunk: string): string[] {
  const subPieces = splitMarkdownChunks(chunk, RICH_MESSAGE_MAX_CHARS)
  return subPieces.length > 1 ? subPieces : hardSliceToCap(chunk, RICH_MESSAGE_MAX_CHARS)
}

const injectedRedact = (text: string, _site: string): string => redact(text)

// ── Representative outbound fixtures ────────────────────────────────────────

const FIXTURES: Record<string, string> = {
  plain: 'Hello there, this is a normal reply.',
  multiParagraph: 'First paragraph here.\n\nSecond paragraph here.\n\nThird one.',
  codeFence:
    'Here is code:\n\n```ts\nconst x = 1 // a comment — with an em-dash\nconst y = 2\n```\n\nDone.',
  emDashes: 'This — that — and the other thing. En–dash here too.',
  excessBold: '**bold one** and **bold two** and **bold three** and **bold four**.',
  // Assembled at runtime so the source holds no contiguous token literal
  // (scripts/check-no-pii-secrets.mjs rejects contiguous sk-ant-… literals).
  secretApiKey: `Your key is ${'sk-ant-' + 'api03-' + 'ABCD'.repeat(12)} and more text.`,
  jsonEscaped: 'Line one\\nLine two\\n\\nParagraph two with a \\t tab.',
  bullets: '- item one\n- item two\n- item three with a — dash',
  oversize: 'x'.repeat(RICH_MESSAGE_MAX_CHARS + 5000),
  multiChunkProse: Array.from({ length: 60 }, (_, i) => `Paragraph number ${i} with some filler text to grow length.`).join('\n\n'),
}

describe('outbound-send-path — normalizeOutboundBody parity with inline pipeline', () => {
  for (const [name, raw] of Object.entries(FIXTURES)) {
    it(`normalize byte-identical: ${name}`, () => {
      const ref = referenceNormalize(raw)
      const got = normalizeOutboundBody(raw, 'reply', injectedRedact)
      expect(got.text).toBe(ref.text)
      expect(got.voiceReplaced).toBe(ref.voiceReplaced)
    })
  }

  it('secret fixture is actually redacted (mask fired)', () => {
    const got = normalizeOutboundBody(FIXTURES.secretApiKey, 'reply', injectedRedact)
    expect(got.text).not.toContain('sk-ant-' + 'api03-' + 'ABCD'.repeat(12))
  })

  it('em/en dashes are removed by the normalize pipeline', () => {
    const got = normalizeOutboundBody(FIXTURES.emDashes, 'reply', injectedRedact)
    // normalizePunctuation + scrubVoice between them strip em/en dashes from
    // prose; the exact stage that fires is an implementation detail, but no
    // raw em-dash survives the pipeline.
    expect(got.text).not.toContain('—')
  })
})

describe('outbound-send-path — effective text + chunk parity', () => {
  for (const [name, raw] of Object.entries(FIXTURES)) {
    for (const literalText of [true, false]) {
      it(`effectiveText + chunks byte-identical: ${name} literal=${literalText}`, () => {
        const { text } = normalizeOutboundBody(raw, 'reply', injectedRedact)
        const refEff = referenceEffectiveText(text, literalText)
        const gotEff = computeEffectiveText(text, literalText)
        expect(gotEff).toBe(refEff)

        const limit = RICH_MESSAGE_MAX_CHARS
        const chunkMode: 'length' | 'newline' = 'length'
        const refChunks = referenceChunks(refEff, literalText, limit, chunkMode)
        const gotChunks = computeReplyChunks({ effectiveText: gotEff, literalText, limit, chunkMode })
        expect(gotChunks).toEqual(refChunks)
      })
    }
  }

  it('literal newline-mode chunking parity on a large body', () => {
    const body = FIXTURES.multiChunkProse
    const limit = 400
    expect(computeReplyChunks({ effectiveText: body, literalText: true, limit, chunkMode: 'newline' }))
      .toEqual(chunkText(body, limit, 'newline'))
  })

  it('oversize chunk re-split parity + every piece under the wire cap', () => {
    const oversize = FIXTURES.oversize
    const ref = referenceResplit(oversize)
    const got = resplitOversizeChunk(oversize)
    expect(got).toEqual(ref)
    for (const piece of got) expect(piece.length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS)
  })
})

describe('outbound-send-path — chunkText golden snapshots', () => {
  it('length mode hard-cuts at the limit', () => {
    expect(chunkText('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij'])
  })
  it('newline mode prefers a paragraph break past halfway', () => {
    expect(chunkText('aaaa\n\nbbbbbbbb', 8, 'newline')).toEqual(['aaaa\n', 'bbbbbbbb'])
  })
  it('short text is returned whole', () => {
    expect(chunkText('short', 100, 'length')).toEqual(['short'])
  })
})

// ── Cross-surface dedup suppression (the load-bearing singleton contract) ────
//
// The plan calls out that `outboundDedup` MUST be the SAME injected instance
// across executeReply / answer-stream / turn-flush — a hoist-once bug (the
// gateway landmine comment) broke all three. The dedup KEY on every surface is
// the post-`normalizeOutboundBody` text, so a stream-path record must suppress
// a reply-path check for the same normalized content on the same singleton.

describe('outbound-send-path — cross-surface dedup suppression', () => {
  it('stream-path record suppresses reply-path check on the shared singleton', () => {
    const dedup = new OutboundDedupCache()
    const chatId = '12345'
    const threadId = undefined
    const turnKey = 'turn-abc'
    const t0 = 1_000_000

    // Both surfaces normalize the same raw model text identically.
    const rawFromModel = 'The answer is 42 — computed carefully across the whole set of inputs.'
    const streamText = normalizeOutboundBody(rawFromModel, 'stream_reply', injectedRedact).text
    const replyText = normalizeOutboundBody(rawFromModel, 'reply', injectedRedact).text
    expect(replyText).toBe(streamText) // same key on every surface

    // Miss before anything recorded.
    expect(dedup.check(chatId, threadId, replyText, t0, turnKey)).toBeNull()

    // Answer-stream records first (same singleton, same turnKey).
    dedup.record(chatId, threadId, streamText, t0, turnKey)

    // Reply path now sees the within-turn duplicate and is suppressed.
    const hit = dedup.check(chatId, threadId, replyText, t0 + 500, turnKey)
    expect(hit).not.toBeNull()
    expect(hit!.matched).toBe(true)
  })

  it('a DISTINCT normalized reply is NOT suppressed (no false dedup)', () => {
    const dedup = new OutboundDedupCache()
    const chatId = '12345'
    const turnKey = 'turn-abc'
    const t0 = 2_000_000
    const a = normalizeOutboundBody('First distinct answer with enough length to record.', 'stream_reply', injectedRedact).text
    const b = normalizeOutboundBody('Second completely different answer, also long enough.', 'reply', injectedRedact).text
    dedup.record(chatId, undefined, a, t0, turnKey)
    expect(dedup.check(chatId, undefined, b, t0 + 500, turnKey)).toBeNull()
  })

  it('cross-turn identical content is NOT suppressed (distinct turnKeys)', () => {
    const dedup = new OutboundDedupCache()
    const chatId = '12345'
    const t0 = 3_000_000
    const text = normalizeOutboundBody('Same content typed twice across two turns, long enough to record.', 'reply', injectedRedact).text
    dedup.record(chatId, undefined, text, t0, 'turn-1')
    // A later, separate turn with the same content still delivers.
    expect(dedup.check(chatId, undefined, text, t0 + 500, 'turn-2')).toBeNull()
  })
})
