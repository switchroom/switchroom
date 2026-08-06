/**
 * Unit coverage for the gateway-side turn-end flush safety net.
 *
 * The fix restores a deterministic "if the model produced assistant text
 * but never called reply/stream_reply, send that text to Telegram at
 * turn_end" rule, after it was silently gated off in the gateway by an
 * earlier `progressDriver == null` condition. Ken hit this live three
 * times in a row — turns ended with visible reasoning in the transcript
 * but no Telegram bubble.
 *
 * These tests pin the pure decision function. The actual send path in
 * gateway.ts is the same one used by the `reply` tool, so if this policy
 * returns `{kind: 'flush', text}` we know the message will reach the chat.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  decideTurnFlush,
  isSilentFlushMarker,
  isCompositeSilentNoise,
  endsWithSilentMarker,
  isSilentSentinelCardOutcome,
  isHollowGhostCardOutcome,
  isTurnFlushSafetyEnabled,
  selectFlushDeliveryText,
  FLUSH_SUBSTANTIVE_MIN_CHARS,
} from '../turn-flush-safety.js'
// Rich-message send-path primitives (Bot API 10.1, #2669/#2692). The #2798
// regression suite below reconstructs the exact gateway turn-flush render
// pipeline from these so it pins end-to-end behaviour, not just the pure
// decision function.
import {
  repairEscapedWhitespace,
  normalizeParagraphBreaks,
  normalizePunctuation,
  stripExcessBold,
  addParagraphSpacers,
  splitMarkdownChunks,
  PARAGRAPH_SPACER,
  RICH_MESSAGE_MAX_CHARS,
} from '../format.js'

describe('isCompositeSilentNoise — Stop-hook re-prompt leak backstop', () => {
  it('suppresses the observed leak "Sent.\\nNO_REPLY\\nNO_REPLY"', () => {
    expect(isCompositeSilentNoise('Sent.\nNO_REPLY\nNO_REPLY')).toBe(true)
  })
  it('suppresses repeated bare markers and marker+confirmation variants', () => {
    expect(isCompositeSilentNoise('NO_REPLY\nNO_REPLY')).toBe(true)
    expect(isCompositeSilentNoise('Done\nNO_REPLY')).toBe(true)
    expect(isCompositeSilentNoise('NO_REPLY\nHEARTBEAT_OK')).toBe(true)
  })
  it('requires at least one real marker — standalone confirmations still flush', () => {
    // Conservative: no NO_REPLY/HEARTBEAT_OK present → NOT suppressed here,
    // so we never silently drop a turn that wasn\'t already signalling silence.
    expect(isCompositeSilentNoise('Sent.')).toBe(false)
    expect(isCompositeSilentNoise('Done.\nOK')).toBe(false)
  })
  it('does NOT suppress real content glued to a marker', () => {
    expect(
      isCompositeSilentNoise('Here is the summary of the page.\nNO_REPLY'),
    ).toBe(false)
    expect(isCompositeSilentNoise('NO_REPLY\nThe answer is 42.')).toBe(false)
  })
  it('handles non-strings / empty safely', () => {
    expect(isCompositeSilentNoise(undefined)).toBe(false)
    expect(isCompositeSilentNoise('')).toBe(false)
    expect(isCompositeSilentNoise('   \n  ')).toBe(false)
  })
})

describe('decideTurnFlush — composite silent noise is skipped, not leaked', () => {
  it('skips "Sent.\\nNO_REPLY\\nNO_REPLY" (the live clerk/test-harness leak)', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Sent.', 'NO_REPLY', 'NO_REPLY'],
    })
    expect(d).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })
  it('still flushes genuine trailing answer text', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['The page summarises three news stories.'],
    })
    expect(d.kind).toBe('flush')
  })
})

describe('endsWithSilentMarker — prose+trailing-sentinel recognition (#2053)', () => {
  it('recognises prose followed by a trailing bare NO_REPLY line', () => {
    expect(endsWithSilentMarker('Nothing actionable in the digest.\nNO_REPLY')).toBe(true)
    expect(endsWithSilentMarker('Build is green.\nHEARTBEAT_OK')).toBe(true)
  })
  it('tolerates a single trailing punctuation on the marker', () => {
    expect(endsWithSilentMarker('done.\nNO_REPLY.')).toBe(true)
  })
  it('does NOT match when real content follows the marker', () => {
    expect(endsWithSilentMarker('NO_REPLY\nThe answer is 42.')).toBe(false)
  })
  it('does NOT match a marker mentioned inside genuine prose', () => {
    expect(endsWithSilentMarker('reply with exactly NO_REPLY when nothing to add')).toBe(false)
  })
  it('handles non-strings / empty safely', () => {
    expect(endsWithSilentMarker(undefined)).toBe(false)
    expect(endsWithSilentMarker('')).toBe(false)
    expect(endsWithSilentMarker('  \n  ')).toBe(false)
  })
})

describe('decideTurnFlush — prose+trailing-sentinel is suppressed, not leaked (#2053)', () => {
  it('skips a cron-style "prose\\nNO_REPLY" blob (the #2053 leak)', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Reviewed the overnight digest — nothing needs your attention.', 'NO_REPLY'],
    })
    expect(d).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })
  it('still flushes a real answer whose last line is NOT a sentinel', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Here is the summary.', 'Three stories, all low priority.'],
    })
    expect(d.kind).toBe('flush')
  })
})

// ---------------------------------------------------------------------------
// #2798 — turn-flush must render multiple WHOLE assistant text blocks with
// paragraph separation, not a collapsed wall-of-text. This suite reconstructs
// the real gateway turn-flush render pipeline (post-#2669 rich-markdown path):
//   decideTurnFlush -> join('\n\n')
//   -> repairEscapedWhitespace -> normalizeParagraphBreaks
//   -> addParagraphSpacers -> splitMarkdownChunks -> sendRichMessage
// so it pins the end-to-end fix, not just the pure decision. The corpus is a
// REAL captured-transcript shape (three separate content[i].text blocks, one
// stored UNTRIMMED with a trailing '\n' exactly as session-tail.ts pushes
// them), NOT a hand-authored ['para A','para B'] that would pass by
// construction regardless of the join separator.
// ---------------------------------------------------------------------------
describe('#2798 turn-flush block separation — real multi-block transcript shape', () => {
  const realBlocks = [
    "I've finished reviewing the three files you flagged.",
    // Untrimmed: a real assistant text block keeps its trailing newline
    // (session-tail.ts drops only empty/whitespace-only blocks). This is the
    // "join('\\n\\n') on a block already ending in '\\n' stacks 3 newlines"
    // case the design note calls out.
    'The `auth` handler looks correct. The token-refresh path has a race, ' +
      'though: two concurrent requests can both trigger a refresh and the ' +
      'second clobbers the first.\n',
    'Want me to open a PR with the mutex fix, or would you rather patch it ' +
      'inline first?',
  ]

  // Mirror the gateway turn-flush send pipeline exactly.
  function renderLikeTurnFlush(blocks: string[]): string {
    const d = decideTurnFlush({ chatId: '12345', replyCalled: false, capturedText: blocks })
    expect(d.kind).toBe('flush')
    const joined = (d as { kind: 'flush'; text: string }).text
    const normalized = normalizeParagraphBreaks(repairEscapedWhitespace(joined))
    return addParagraphSpacers(normalized)
  }

  it('separates whole blocks with a visible paragraph gap, not a wall-of-text', () => {
    const out = renderLikeTurnFlush(realBlocks)
    // Every block's content survives.
    expect(out).toContain("I've finished reviewing")
    expect(out).toContain('The `auth` handler looks correct')
    expect(out).toContain('Want me to open a PR')
    // The wall-of-text failure mode glues two blocks one '\n' apart. Assert the
    // boundary carries a real paragraph break with the injected visible spacer
    // line (#2692 rich-path spacer), and NOT a single-newline join.
    expect(out).toContain(`\n\n${PARAGRAPH_SPACER}\n\n`)
    expect(out).not.toContain('flagged.\nThe `auth`')
    // A spacer sits specifically between block 1 and block 2.
    const b1 = out.indexOf('flagged.')
    const b2 = out.indexOf('The `auth` handler')
    expect(out.slice(b1, b2)).toContain(PARAGRAPH_SPACER)
  })

  it('collapses the untrimmed-trailing-newline stack — no 3+ newline run reaches the wire', () => {
    const out = renderLikeTurnFlush(realBlocks)
    // Block 2's trailing '\n' + the '\n\n' join = 3 newlines; normalize
    // collapses 3+ runs to '\n\n' and addParagraphSpacers wedges exactly one
    // spacer, so no doubled/stacked blank run survives.
    expect(out).not.toMatch(/\n{3,}/)
    // One spacer per block transition: 3 blocks → 2 gaps → 2 spacers.
    const spacerCount = out.split(PARAGRAPH_SPACER).length - 1
    expect(spacerCount).toBe(2)
  })

  it('the whole separated answer stays in one rich chunk here (well under 32768)', () => {
    const out = renderLikeTurnFlush(realBlocks)
    const chunks = splitMarkdownChunks(out, RICH_MESSAGE_MAX_CHARS)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain(PARAGRAPH_SPACER)
  })

  it('still SUPPRESSES a real transcript that deliberately terminates with a bare NO_REPLY (#2053 guard intact)', () => {
    // Same real prose shape, but the model closed with NO_REPLY as its final
    // block (intentional silence). The '\n\n' join must NOT defeat the
    // trailing-marker guard.
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: [
        'Reviewed the overnight digest. Nothing needs your attention: all ' +
          'three checks are green and the backup completed at 04:12.',
        'NO_REPLY',
      ],
    })
    expect(d).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('still SUPPRESSES the composite silent-noise blob under the new join', () => {
    const d = decideTurnFlush({
      chatId: '12345',
      replyCalled: false,
      capturedText: ['Sent.', 'NO_REPLY', 'NO_REPLY'],
    })
    expect(d).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })
})

// ---------------------------------------------------------------------------
// #2798 reply-parity follow-up — the turn-flush normalization chain must apply
// the SAME steps in the SAME order as executeReply, so a backstop-delivered
// answer renders byte-for-byte like the identical text sent via `reply`. Reply
// runs (gateway executeReply):
//   repairEscapedWhitespace -> normalizeParagraphBreaks -> redactOutboundText
//   -> stripExcessBold(normalizePunctuation) -> scrubVoice
//   -> addParagraphSpacers (send side)
// The original #2798 change gave turn-flush the paragraph steps + redact +
// scrub + spacers but OMITTED `stripExcessBold(normalizePunctuation(...))`.
// This suite reconstructs the deterministic format chain of BOTH paths (the
// runtime-only redact + voice-scrub steps are literally the same calls on both
// paths and are out of scope here) and pins that turn-flush now matches reply
// on an input that exercises the two added steps: unicode bullets + a spaced
// en-/em-dash (normalizePunctuation) and an over-bolded prose block
// (stripExcessBold).
// ---------------------------------------------------------------------------
describe('#2798 turn-flush punctuation/bold parity with reply', () => {
  // SOURCE-STRUCTURAL guard (house pattern: gateway-outbound-redact.test.ts
  // reads gateway.ts source and asserts the relative position of calls).
  //
  // The reply-parity contract is that the turn_flush backstop applies the SAME
  // `stripExcessBold(normalizePunctuation(...))` normalization the reply path
  // applies, in the SAME slot — after redactOutboundText, before scrubVoice.
  //
  // A prior version of this suite "guarded" that contract by defining two
  // BYTE-IDENTICAL local functions (replyFormatChain / turnFlushFormatChain)
  // and asserting `toBe` between them. That was tautological: the two locals
  // were equal by construction regardless of what gateway.ts did, so deleting
  // the normalization line from the turn_flush branch reddened NO test. The
  // assertions below instead read the gateway source and pin the actual call
  // ordering, so removing the `stripExcessBold(normalizePunctuation(capturedText))`
  // line from the turn_flush branch REDS this suite — which is the exact
  // regression #2798/#2813 shipped to prevent.
  const gatewaySrc = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )
  // #2996 P4-A: the turn_flush backstop (redact → normalize → scrub on
  // `capturedText`) moved VERBATIM into stream-render.ts with
  // handleSessionEvent. The reply path's identical `...(text))` wrapper lives
  // in outbound-send-path.ts (`normalizeOutboundBody`, #2996 P2). Parity is
  // pinned across the two extracted homes.
  const streamSrc = readFileSync(
    new URL('../gateway/stream-render.ts', import.meta.url),
    'utf8',
  )
  const replyModuleSrc = readFileSync(
    new URL('../gateway/outbound-send-path.ts', import.meta.url),
    'utf8',
  )

  it('reply path: normalizes AFTER redact and BEFORE the voice scrub', () => {
    // #2996: the reply-path entry pipeline moved into outbound-send-path.ts
    // (`normalizeOutboundBody`). The reply path delegates to it via
    // `normalizeOutboundBody(rawText, 'reply', redactOutboundText)`; the
    // redact→normalize→scrub ordering is now pinned in the module source.
    const moduleSrc = readFileSync(
      new URL('../gateway/outbound-send-path.ts', import.meta.url),
      'utf8',
    )
    // #2996 P2: the reply orchestration itself now lives in the module
    // (`sendReply`); the delegation line is pinned there.
    const replyDelegates = moduleSrc.indexOf(
      `normalizeOutboundBody(rawText, 'reply', redactOutboundText`,
      moduleSrc.indexOf('export async function sendReply('),
    )
    expect(replyDelegates).toBeGreaterThan(0)

    const start = moduleSrc.indexOf('export function normalizeOutboundBody(')
    const redactIdx = moduleSrc.indexOf('redact(text, site)', start)
    const normIdx = moduleSrc.indexOf('stripExcessBold(normalizePunctuation(text),', start)
    const scrubIdx = moduleSrc.indexOf('scrubVoice(text)', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(normIdx).toBeGreaterThan(redactIdx) // normalize AFTER the reply redact
    expect(scrubIdx).toBeGreaterThan(normIdx) // ...and BEFORE the voice scrub
  })

  it('turn-flush backstop: routes through the shared normalizeOutboundBody seam (#3501)', () => {
    // #3501 consolidation: the turn_flush branch no longer hand-mirrors the
    // reply pipeline inline — it calls the SINGLE shared seam
    // `normalizeOutboundBody(flushDecision.text, 'turn_flush', redactOutboundText)`.
    // That call IS the redact→normalize→scrub pipeline (pinned above in the
    // module source), so the same-slot ordering guarantee now lives in ONE
    // place. This indexOf returns -1 (→ assertion fails) if the seam call is
    // deleted from the turn_flush branch.
    const seamIdx = streamSrc.indexOf(`normalizeOutboundBody(`)
    const siteIdx = streamSrc.indexOf(`'turn_flush',`, seamIdx)
    expect(seamIdx).toBeGreaterThan(0)
    expect(siteIdx).toBeGreaterThan(seamIdx) // the seam is invoked with the turn_flush site
    // The former inline mirror must be GONE — no hand-rolled copy left to drift.
    expect(streamSrc).not.toContain('stripExcessBold(normalizePunctuation(capturedText))')
  })

  it('both send sites share the identical normalizeOutboundBody seam (#3501)', () => {
    // Parity, structurally: after consolidation the reply and turn_flush sites
    // share ONE normalization implementation — the punctuation/bold wrapper
    // lives only inside normalizeOutboundBody, and both sites invoke it.
    expect(replyModuleSrc).toContain('stripExcessBold(normalizePunctuation(text),')
    expect(streamSrc).toContain('normalizeOutboundBody(')
    expect(streamSrc).toContain(`'turn_flush',`)
  })

  // Behavioural coverage (kept from the original suite): reconstruct the
  // deterministic format chain both sites apply and assert the REAL
  // strip/normalize behaviour the added step provides — the over-bold block is
  // stripped, unicode bullets become GFM list items, dashes are normalized.
  function formatChain(text: string): string {
    let t = normalizeParagraphBreaks(repairEscapedWhitespace(text))
    t = stripExcessBold(normalizePunctuation(t))
    return addParagraphSpacers(t)
  }

  const input =
    '**This whole paragraph is bolded and is deliberately long enough to ' +
    'exceed the hundred non-code character floor so the over-bold tripwire ' +
    'fires on it every time.**\n\n' +
    '• first bullet\n• second bullet\n\n' +
    'A range like 2019 – 2024 and a spaced em-dash a — b for good measure.'

  it('strips the over-bold block and normalizes bullets/dashes exactly as reply does', () => {
    const out = formatChain(input)
    // stripExcessBold removed the ** markers from the over-bolded paragraph
    // (the step turn-flush was missing) — the text survives, the markers do not.
    expect(out).not.toContain('**This whole paragraph')
    expect(out).toContain('This whole paragraph is bolded')
    // normalizePunctuation turned unicode bullets into GFM '- ' list items.
    expect(out).toContain('- first bullet')
    expect(out).toContain('- second bullet')
    expect(out).not.toContain('• first bullet')
    // and normalized the dashes: spaced en-dash numeric range -> hyphen,
    // spaced em-dash between words -> comma. Same treatment reply applies.
    expect(out).toContain('2019-2024')
    expect(out).toContain('a, b')
    expect(out).not.toContain('2019 – 2024')
    expect(out).not.toContain('a — b')
  })
})

describe('decideTurnFlush', () => {
  it('(a) does NOT flush when the reply tool was called', () => {
    const decision = decideTurnFlush({
      chatId: '100',
      replyCalled: true,
      capturedText: ['here is the answer'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
  })

  it('(b) flushes when the turn produced text but the reply tool was never called', () => {
    const decision = decideTurnFlush({
      chatId: '200',
      replyCalled: false,
      capturedText: ['here is the answer', 'more detail'],
    })
    // #2798 — whole authored text blocks are joined with a PARAGRAPH break
    // ('\n\n'), not a lone '\n', so adjacent blocks don't collapse into a
    // single run on the rich-markdown path.
    expect(decision).toEqual({
      kind: 'flush',
      text: 'here is the answer\n\nmore detail',
    })
  })

  it('(c) HEARTBEAT_OK is a silent marker — flush suppressed', () => {
    const decision = decideTurnFlush({
      chatId: '300',
      replyCalled: false,
      capturedText: ['HEARTBEAT_OK'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('NO_REPLY is a silent marker — flush suppressed', () => {
    const decision = decideTurnFlush({
      chatId: '301',
      replyCalled: false,
      capturedText: ['NO_REPLY'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('silent markers match case-insensitively with whitespace trim', () => {
    expect(
      decideTurnFlush({
        chatId: '302',
        replyCalled: false,
        capturedText: ['  heartbeat_ok  '],
      }),
    ).toEqual({ kind: 'skip', reason: 'silent-marker' })
  })

  it('(d) background sub-agent turn (chatId == null) is NOT flushed', () => {
    // Sub-agent turns never populate `currentSessionChatId` — we surface
    // that here as `chatId: null` and the decision must be skip.
    const decision = decideTurnFlush({
      chatId: null,
      replyCalled: false,
      capturedText: ['child agent result'],
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'no-inbound-chat' })
  })

  it('empty captured text is NOT flushed', () => {
    expect(
      decideTurnFlush({
        chatId: '400',
        replyCalled: false,
        capturedText: [],
      }),
    ).toEqual({ kind: 'skip', reason: 'empty-text' })
    expect(
      decideTurnFlush({
        chatId: '400',
        replyCalled: false,
        capturedText: ['', '   ', '\n'],
      }),
    ).toEqual({ kind: 'skip', reason: 'empty-text' })
  })

  it('feature flag off disables flush even on a legitimate orphan', () => {
    const decision = decideTurnFlush({
      chatId: '500',
      replyCalled: false,
      capturedText: ['an answer'],
      flushEnabled: false,
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'flag-disabled' })
  })

  it('flushEnabled defaults to true when omitted', () => {
    const decision = decideTurnFlush({
      chatId: '600',
      replyCalled: false,
      capturedText: ['some answer'],
    })
    expect(decision.kind).toBe('flush')
  })

  it('prioritises flag-disabled over every other skip reason', () => {
    expect(
      decideTurnFlush({
        chatId: null,
        replyCalled: true,
        capturedText: [],
        flushEnabled: false,
      }),
    ).toEqual({ kind: 'skip', reason: 'flag-disabled' })
  })

  it('prioritises reply-called over chatId/empty checks', () => {
    expect(
      decideTurnFlush({
        chatId: null,
        replyCalled: true,
        capturedText: [],
      }),
    ).toEqual({ kind: 'skip', reason: 'reply-called' })
  })

  // The turn-flush safety net covers exactly one failure mode: a turn that
  // ended with the model never having said anything. Once the model has
  // called reply / stream_reply the turn is served — any assistant text it
  // emits afterwards is its own end-of-turn wrap-up (a closing summary,
  // narration to itself), NOT a message it chose to send. The framework
  // must never promote that terminal text into a second Telegram bubble.
  //
  // Regression guard for the redundant-follow-up-message fix: this reverts
  // the #1291 post-reply-tail flush, which posted a duplicate recap on
  // essentially every turn because the model habitually writes a closing
  // summary after its final reply. See reference/rfcs/conversational-pacing.md
  // — "the framework owns the beat; the model authors the words".
  describe('reply-called turns never flush trailing terminal text', () => {
    it('skips even when a long substantive tail follows the reply', () => {
      const decision = decideTurnFlush({
        chatId: '700',
        replyCalled: true,
        capturedText: [
          'thinking out loud before the reply',
          'Answered the Playwright question and acked the calendar ' +
            'diagnosis is still in flight. Will surface the root cause ' +
            'when the worker returns.',
        ],
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
    })

    it('skips regardless of how many text blocks trail the reply', () => {
      const decision = decideTurnFlush({
        chatId: '701',
        replyCalled: true,
        capturedText: [
          'a substantive paragraph the model wrote as terminal text',
          'and another one, each well over any old length threshold',
          'and a third closing summary block for good measure',
        ],
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
    })

    it('skips with reply-called when capturedText is empty', () => {
      const decision = decideTurnFlush({
        chatId: '702',
        replyCalled: true,
        capturedText: [],
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'reply-called' })
    })

    it('feature flag off still wins over a reply-called turn', () => {
      const decision = decideTurnFlush({
        chatId: '703',
        replyCalled: true,
        capturedText: ['a long substantive tail that pre-fix would flush'],
        flushEnabled: false,
      })
      expect(decision).toEqual({ kind: 'skip', reason: 'flag-disabled' })
    })
  })
})

describe('isSilentFlushMarker', () => {
  it('recognises NO_REPLY and HEARTBEAT_OK exactly', () => {
    expect(isSilentFlushMarker('NO_REPLY')).toBe(true)
    expect(isSilentFlushMarker('HEARTBEAT_OK')).toBe(true)
    expect(isSilentFlushMarker('no_reply')).toBe(true)
    expect(isSilentFlushMarker('  HEARTBEAT_OK  ')).toBe(true)
  })

  it('does NOT match prose containing the marker', () => {
    expect(isSilentFlushMarker('the model said NO_REPLY earlier')).toBe(false)
    expect(isSilentFlushMarker('HEARTBEAT_OK; shutting down')).toBe(false)
  })

  it('does not match undefined/empty', () => {
    expect(isSilentFlushMarker(undefined)).toBe(false)
    expect(isSilentFlushMarker('')).toBe(false)
    expect(isSilentFlushMarker('   ')).toBe(false)
  })

  it('tolerates a single trailing non-word character (#299 review feedback)', () => {
    expect(isSilentFlushMarker('NO_REPLY.')).toBe(true)
    expect(isSilentFlushMarker('NO_REPLY!')).toBe(true)
    expect(isSilentFlushMarker('HEARTBEAT_OK,')).toBe(true)
    expect(isSilentFlushMarker('  HEARTBEAT_OK.  ')).toBe(true)
    // Two trailing punctuation chars → not stripped, no match
    expect(isSilentFlushMarker('NO_REPLY!!')).toBe(false)
  })
})

describe('isTurnFlushSafetyEnabled', () => {
  it('defaults to true when the env var is absent', () => {
    expect(isTurnFlushSafetyEnabled({})).toBe(true)
  })

  it('disables on explicit false-y values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' OFF ']) {
      expect(isTurnFlushSafetyEnabled({ SWITCHROOM_TG_TURN_FLUSH_SAFETY: v }))
        .toBe(false)
    }
  })

  it('stays enabled for anything else (including "1", "true", unknown)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      expect(isTurnFlushSafetyEnabled({ SWITCHROOM_TG_TURN_FLUSH_SAFETY: v }))
        .toBe(true)
    }
  })
})

describe('selectFlushDeliveryText — deliver the terminal answer, strip only narration', () => {
  const answer = 'A'.repeat(FLUSH_SUBSTANTIVE_MIN_CHARS + 20)

  it('delivers ONLY the terminal answer when narration precedes the answer', () => {
    // The duplicate-reply root cause: the flush fired while the model was still
    // composing its reply, so capturedText held intent-narration blocks THEN
    // the composed answer. Pre-fix the flush dumped the whole blob; post-fix it
    // delivers only the answer. This test FAILS on the pre-fix `join('\n\n')`.
    const blocks = ["Let me check that.", "I'll look it up now.", answer]
    const out = selectFlushDeliveryText(blocks)
    expect(out).toBe(answer)
    expect(out).not.toContain('Let me check')
    expect(out).not.toContain("I'll look it up")
  })

  // MEDIUM finding (adversarial review): a LONG (>=200) narration block FOLLOWED
  // by a SHORT (<200) real answer. The pre-fix `find last block >= 200` returned
  // the narration and DROPPED the short real answer. The terminal block is the
  // answer regardless of length. FAILS on the pre-fix threshold scan.
  it('delivers a SHORT real answer that follows a LONG (>=200) narration block', () => {
    const verboseNarration =
      'Let me pull the numbers together before I answer — ' +
      'X'.repeat(FLUSH_SUBSTANTIVE_MIN_CHARS)
    const realAnswer = 'Revenue was 4.2M, up 12% year over year.' // < 200 chars
    expect(verboseNarration.length).toBeGreaterThanOrEqual(FLUSH_SUBSTANTIVE_MIN_CHARS)
    expect(realAnswer.length).toBeLessThan(FLUSH_SUBSTANTIVE_MIN_CHARS)
    const out = selectFlushDeliveryText([verboseNarration, realAnswer])
    expect(out).toBe(realAnswer)
    expect(out).not.toContain('Let me pull the numbers')
  })

  it('keeps the FULL joined text when an earlier block is real content, never truncating to the last paragraph', () => {
    // Two substantive blocks, neither an intent-narration opener: this is a
    // genuine multi-paragraph answer written as several blocks. Delivering only
    // the last paragraph would drop real content — keep the whole thing.
    const first = 'B'.repeat(FLUSH_SUBSTANTIVE_MIN_CHARS + 5)
    const last = 'C'.repeat(FLUSH_SUBSTANTIVE_MIN_CHARS + 5)
    expect(selectFlushDeliveryText([first, last])).toBe(`${first}\n\n${last}`)
  })

  it('keeps short two-paragraph answers joined (short legit answer preserved)', () => {
    const blocks = ['First short paragraph.', 'Second short paragraph.']
    expect(selectFlushDeliveryText(blocks)).toBe('First short paragraph.\n\nSecond short paragraph.')
  })

  it('a single block is delivered verbatim regardless of length', () => {
    expect(selectFlushDeliveryText(['short answer'])).toBe('short answer')
    expect(selectFlushDeliveryText([answer])).toBe(answer)
  })

  it('trims and drops empty blocks', () => {
    expect(selectFlushDeliveryText(['  ', '', '  hi  '])).toBe('hi')
    expect(selectFlushDeliveryText([])).toBe('')
  })

  // #3276 guard 8 — the NARRATION_OPENER regex alone misses progress narration
  // that does NOT open with "Let me…/I'll…" but trails off into an ellipsis or
  // colon ("Checking now…"). Pre-fix, `isNarrationBlock` returned false for it,
  // so the whole `narration\n\nanswer` blob was delivered. FAILS pre-fix.
  it('strips a non-opener progress narration ("Checking now…") that precedes the answer', () => {
    const out = selectFlushDeliveryText(['Checking now…', 'The build is green.'])
    expect(out).toBe('The build is green.')
    expect(out).not.toContain('Checking now')
  })

  it('strips a colon-terminated progress narration ("Pulling the numbers:")', () => {
    const out = selectFlushDeliveryText(['Pulling the numbers:', 'Revenue was 4.2M.'])
    expect(out).toBe('Revenue was 4.2M.')
  })

  it('still delivers a SHORT terminal answer after progress narration (no min-char re-gate)', () => {
    // "yes, done" is well under FLUSH_SUBSTANTIVE_MIN_CHARS and MUST still deliver.
    const out = selectFlushDeliveryText(['Looking into that...', 'yes, done'])
    expect(out).toBe('yes, done')
  })

  // #3276 finding 7 — the narration heuristic only ever strips PRECEDING blocks;
  // the terminal answer block is always preserved. A colon-terminated line that
  // IS the whole answer (e.g. a lead-in the model never continued) must NOT be
  // dropped, whether it stands alone or is the terminal block after narration.
  it('never drops a colon-terminated line that IS the whole answer (single block)', () => {
    expect(selectFlushDeliveryText(['Here are the results:'])).toBe('Here are the results:')
  })

  it('keeps a colon-terminated TERMINAL block (it is the answer, not narration)', () => {
    const out = selectFlushDeliveryText(['Checking now…', 'Here are the results:'])
    expect(out).toBe('Here are the results:')
  })

  // #3513 follow-up — decideTurnFlush now routes through the deterministic
  // `selectBackstopDelivery` coalescer, NOT the wording heuristic. With NO
  // structural provenance (no `capturedBlockMeta`, so no block was followed by a
  // turn-continuing tool_use) EVERY block is part of the terminal run and is
  // delivered joined — fail OPEN, never drop. The wording-based narration strip
  // is gone on the backstop path (it was provably incomplete; #3513). When the
  // structural signal IS present it, and only it, suppresses.
  it('decideTurnFlush delivers the full terminal run when NO tool-follow provenance is present (fail-open)', () => {
    const decision = decideTurnFlush({
      chatId: 'chat1',
      replyCalled: false,
      capturedText: ['Let me check.', 'Now let me compose the reply.', answer],
    })
    expect(decision.kind).toBe('flush')
    if (decision.kind === 'flush') {
      expect(decision.text).toBe(`Let me check.\n\nNow let me compose the reply.\n\n${answer}`)
    }
  })

  it('decideTurnFlush suppresses tool-followed blocks UNCONDITIONALLY (structural provenance drives the coalescer)', () => {
    // The first two blocks were each followed by a turn-continuing tool_use →
    // intra-turn narration → suppressed with NO length/wording gate. Only the
    // terminal answer (not tool-followed) survives.
    const decision = decideTurnFlush({
      chatId: 'chat1',
      replyCalled: false,
      capturedText: ['Let me check.', 'Now let me compose the reply.', answer],
      capturedBlockMeta: [true, true, false],
    })
    expect(decision.kind).toBe('flush')
    if (decision.kind === 'flush') {
      expect(decision.text).toBe(answer)
      expect(decision.text).not.toContain('Let me check')
    }
  })
})

// ── #3237: STRUCTURAL block-provenance discriminator ───────────────────────
// The opener heuristic cannot tell a narration preamble from a real answer
// paragraph that merely opens with "Let me explain…". The structural flag
// (`followedByToolUse`, = `!lastInMessage`) can: a narration preamble is
// followed by a tool_use in its message; a terminal answer paragraph is not.
describe('selectFlushDeliveryText — structural provenance (followedByToolUse) #3237', () => {
  // The exact real-answer shape from #3237: a genuine two-paragraph answer
  // whose FIRST block opens with a narration phrase, written as plain text with
  // NO tool calls (the model forgot the reply tool → flush path). Structure
  // says neither block was followed by a tool_use, so nothing is narration.
  const p1 =
    'Let me explain how the flush path works: it fires at turn_end when the ' +
    'model never called the reply tool, joining the captured assistant text ' +
    'blocks with a paragraph break so the answer renders with real separation.'
  const p2 =
    'The terminal block is always delivered, so the answer is never fully ' +
    'lost — but the opening paragraph could be dropped by the opener-only strip.'

  it('#3237 regression: a real 2-paragraph answer opening with "Let me explain…" is NOT truncated when structure says neither block was followed by a tool_use', () => {
    // With NO structural signal (legacy string[]) the opener strip DROPS p1.
    expect(selectFlushDeliveryText([p1, p2])).toBe(p2) // documents the bug
    // With structure present ([false,false]) the full answer is delivered.
    const out = selectFlushDeliveryText([p1, p2], [false, false])
    expect(out).toBe(`${p1}\n\n${p2}`)
    expect(out).toContain('Let me explain how the flush path works')
  })

  it('duplicate-reply fix preserved: a narration block FOLLOWED by a tool_use is stripped, terminal answer delivered', () => {
    const narration = 'Let me pull the numbers together before I answer.'
    const realAnswer = 'Revenue was 4.2M, up 12% year over year.'
    // followedByToolUse[0]=true (the model drafted then acted), [1]=false (terminal).
    const out = selectFlushDeliveryText([narration, realAnswer], [true, false])
    expect(out).toBe(realAnswer)
    expect(out).not.toContain('Let me pull the numbers')
  })

  it('structure alone drives the strip — a preamble the opener regex would MISS is still stripped when it was followed by a tool_use', () => {
    // "Here are the figures" matches no NARRATION_OPENER, but a tool_use
    // followed it → structural narration → stripped.
    const preamble = 'Here are the figures you asked about.'
    const realAnswer = 'The three services are all green.'
    const out = selectFlushDeliveryText([preamble, realAnswer], [true, false])
    expect(out).toBe(realAnswer)
    expect(out).not.toContain('Here are the figures')
  })

  it('structure WINS over the opener heuristic — a "Let me…" opener NOT followed by a tool_use is kept (never truncated)', () => {
    const first = 'Let me walk you through the three steps in order.'
    const second = 'Step one is to branch off fresh main.'
    // Opener-only would strip `first`; structure ([false,false]) keeps it.
    expect(selectFlushDeliveryText([first, second], [false, false])).toBe(
      `${first}\n\n${second}`,
    )
  })

  it('per-block fallback: an UNDEFINED entry falls back to the opener heuristic for that block only', () => {
    const narration = 'Let me check that.'
    const realAnswer = 'Done — all green.'
    // meta[0] undefined → fall back to isNarrationBlock("Let me check that.") = true → stripped.
    const out = selectFlushDeliveryText([narration, realAnswer], [undefined, false])
    expect(out).toBe(realAnswer)
  })

  it('flag-absent back-compat: omitting the meta array reproduces today\'s opener-strip EXACTLY', () => {
    // Every legacy case behaves identically with no meta argument.
    expect(selectFlushDeliveryText(['Let me check.', 'the answer'])).toBe('the answer')
    expect(selectFlushDeliveryText(['Checking now…', 'The build is green.'])).toBe(
      'The build is green.',
    )
    expect(selectFlushDeliveryText([p1, p2])).toBe(p2) // opener strip drops p1
    const first = 'B'.repeat(FLUSH_SUBSTANTIVE_MIN_CHARS + 5)
    const last = 'C'.repeat(FLUSH_SUBSTANTIVE_MIN_CHARS + 5)
    expect(selectFlushDeliveryText([first, last])).toBe(`${first}\n\n${last}`)
  })

  it('meta stays ALIGNED across the empty-block filter (zip-before-filter)', () => {
    // An empty block between narration and answer must not shift the meta index.
    const narration = 'Let me look that up.'
    const realAnswer = 'The value is 42.'
    // blocks[1] is empty (dropped); meta must still map [narration→true, ''→_, answer→false].
    const out = selectFlushDeliveryText([narration, '   ', realAnswer], [true, false, false])
    expect(out).toBe(realAnswer)
    expect(out).not.toContain('Let me look that up')
  })

  it('cross-message shape: narration (msg1, tool_use after) + answer (msg2, terminal) → narration stripped', () => {
    // lastInMessage semantics are per-message; a narration that is the last text
    // of msg1 but has a tool_use after it in msg1 is followedByToolUse=true.
    const narration = 'Let me search the codebase for the symbol.'
    const realAnswer = 'It is defined in session-tail.ts.'
    const out = selectFlushDeliveryText([narration, realAnswer], [true, false])
    expect(out).toBe(realAnswer)
  })

  it('decideTurnFlush plumbs capturedBlockMeta through to the strip (#3237 end-to-end)', () => {
    // Real-answer case: structure keeps both paragraphs.
    const keep = decideTurnFlush({
      chatId: 'chat1',
      replyCalled: false,
      capturedText: [p1, p2],
      capturedBlockMeta: [false, false],
    })
    expect(keep.kind).toBe('flush')
    if (keep.kind === 'flush') expect(keep.text).toBe(`${p1}\n\n${p2}`)

    // Narration case: structure strips the preamble.
    const strip = decideTurnFlush({
      chatId: 'chat1',
      replyCalled: false,
      capturedText: ['Let me pull the numbers.', 'Revenue was 4.2M.'],
      capturedBlockMeta: [true, false],
    })
    expect(strip.kind).toBe('flush')
    if (strip.kind === 'flush') expect(strip.text).toBe('Revenue was 4.2M.')
  })

  // Regression for the post-#3338 review finding: a SUBSTANTIAL real-content
  // block (≥ FLUSH_SUBSTANTIVE_MIN_CHARS, NOT narration-shaped) that happens to
  // be followed by a tool_use must be KEPT — the model can write a real answer
  // paragraph, then call a memory/verify tool, then a short wrap-up. Trusting
  // followedByToolUse ALONE (the pre-fix behaviour) dropped the real answer and
  // delivered only the wrap-up. The structural strip is gated by the substantive
  // floor, so the substantial block survives.
  it('substantial real-content block followed by a tool_use is KEPT (structural flag gated by the substantive floor)', () => {
    const realAnswer =
      'The migration completed cleanly across all five shards: each shard was ' +
      'drained, the schema applied under an advisory lock, and traffic cut back ' +
      'over with zero dropped requests. The new index brought the p99 query time ' +
      'down from 840ms to 60ms, and the old columns are now safe to remove in ' +
      'the next release once the read path is confirmed off them entirely.'
    expect(realAnswer.length).toBeGreaterThanOrEqual(FLUSH_SUBSTANTIVE_MIN_CHARS)
    // Not narration-shaped: no first-person "about to do X" opener, no
    // trailing ellipsis/colon — so only the structural flag could strip it.
    const wrapUp = 'Saved that to memory.'
    // meta[0]=true (a memory tool_use followed the real answer), [1]=false.
    // The STANDALONE `selectFlushDeliveryText` (the old #3237 substance-gated
    // function, unchanged and still exported) keeps the substantial block.
    const out = selectFlushDeliveryText([realAnswer, wrapUp], [true, false])
    expect(out).toBe(`${realAnswer}\n\n${wrapUp}`)
    expect(out).toContain('The migration completed cleanly')

    // #3513 follow-up — decideTurnFlush now routes through
    // `selectBackstopDelivery`, which suppresses a tool-followed block
    // UNCONDITIONALLY (no substantive-floor carve-out). This DELIBERATELY
    // overturns #3237's substance-gate ON THE BACKSTOP PATH: a real answer the
    // model followed with a turn-continuing tool_use is treated as intra-turn
    // and excluded; only the terminal (non-tool-followed) block is delivered.
    // The deterministic contract is "the terminal run wins" — the model keeps
    // its answer by ending on it or calling the reply tool.
    const decision = decideTurnFlush({
      chatId: 'chat1',
      replyCalled: false,
      capturedText: [realAnswer, wrapUp],
      capturedBlockMeta: [true, false],
    })
    expect(decision.kind).toBe('flush')
    if (decision.kind === 'flush') {
      expect(decision.text).toBe(wrapUp)
    }
  })

  // A SHORT block followed by a tool_use is still stripped via the length floor
  // (the pre-#3237 "short preamble the opener misses" behaviour is preserved):
  // it is below FLUSH_SUBSTANTIVE_MIN_CHARS, so the gated strip still fires.
  it('short block followed by a tool_use is still stripped (length-floor branch of the gate)', () => {
    const shortPreamble = 'Here are the figures you asked about.'
    expect(shortPreamble.length).toBeLessThan(FLUSH_SUBSTANTIVE_MIN_CHARS)
    const realAnswer = 'The three services are all green.'
    const out = selectFlushDeliveryText([shortPreamble, realAnswer], [true, false])
    expect(out).toBe(realAnswer)
    expect(out).not.toContain('Here are the figures')
  })
})

// #4348 — the pure gate that suppresses the per-turn activity/telemetry card
// when the turn's whole user-facing outcome was an intentional silent sentinel.
describe('isSilentSentinelCardOutcome (#4348)', () => {
  const base = { replyCalled: false, lastReplyText: '', capturedText: [] as string[], finalAnswerEverDelivered: false }

  it('reply("NO_REPLY") — the blocked sentinel-only reply is a silent outcome', () => {
    expect(isSilentSentinelCardOutcome({ ...base, replyCalled: true, lastReplyText: 'NO_REPLY' })).toBe(true)
  })

  it('trailing punctuation and case variants still count as silent', () => {
    for (const t of ['NO_REPLY.', 'no_reply', 'HEARTBEAT_OK', 'heartbeat_ok!', ' NO_REPLY ']) {
      expect(isSilentSentinelCardOutcome({ ...base, replyCalled: true, lastReplyText: t })).toBe(true)
    }
  })

  it('composite silent noise ("Sent.\\nNO_REPLY\\nNO_REPLY") via the reply payload is silent', () => {
    expect(
      isSilentSentinelCardOutcome({ ...base, replyCalled: true, lastReplyText: 'Sent.\nNO_REPLY\nNO_REPLY' }),
    ).toBe(true)
  })

  it('flush path (no reply): prose + trailing NO_REPLY (H6/#2053) is silent', () => {
    expect(
      isSilentSentinelCardOutcome({
        ...base,
        replyCalled: false,
        capturedText: ["Nothing actionable in today's digest.", 'NO_REPLY'],
      }),
    ).toBe(true)
  })

  it('a real reply is NOT silent — the card is a legitimate record', () => {
    expect(
      isSilentSentinelCardOutcome({
        ...base,
        replyCalled: true,
        lastReplyText: 'The three services are all green.',
        finalAnswerEverDelivered: true,
      }),
    ).toBe(false)
  })

  it('finalAnswerEverDelivered short-circuits even when a stray NO_REPLY is the last reply text', () => {
    // An interim answer landed, then a trailing sentinel — the delivered answer wins.
    expect(
      isSilentSentinelCardOutcome({
        ...base,
        replyCalled: true,
        lastReplyText: 'NO_REPLY',
        finalAnswerEverDelivered: true,
      }),
    ).toBe(false)
  })

  it('a delivered reply that merely mentions the sentinel in prose is NOT silent', () => {
    // Non-marker content ⇒ the sentinel-reply-guard would not drop it ⇒ delivered.
    expect(
      isSilentSentinelCardOutcome({
        ...base,
        replyCalled: true,
        lastReplyText: 'Reply with exactly NO_REPLY if there is nothing to add.',
      }),
    ).toBe(false)
  })

  it('endsWithSilentMarker does NOT suppress a DELIVERED reply of "prose\\nNO_REPLY"', () => {
    // The guard lets prose+trailing-NO_REPLY through the reply tool, so its
    // prose reached chat; the card must stay even though it ends with a marker.
    expect(
      isSilentSentinelCardOutcome({
        ...base,
        replyCalled: true,
        lastReplyText: 'Here is the full answer.\nNO_REPLY',
      }),
    ).toBe(false)
  })

  it('a genuinely empty dark turn (no reply, no text) is NOT a sentinel', () => {
    expect(isSilentSentinelCardOutcome({ ...base })).toBe(false)
  })
})

describe('isHollowGhostCardOutcome (#45)', () => {
  const base = {
    replyCalled: false,
    labeledToolCount: 0,
    mirrorLines: [] as string[],
    capturedText: [] as string[],
    lastReplyText: '',
    finalAnswerEverDelivered: false,
  }

  it('the ghost-reply signature — zero tools, no reply, no text, no narration — IS hollow', () => {
    // The exact #45 condition the sentinel gate misses (no NO_REPLY text to
    // match): the card adopted at turn start (liveness timer) never got any
    // content — mirrorLines empty, no tool, no reply, no text.
    expect(isHollowGhostCardOutcome({ ...base })).toBe(true)
  })

  it('a narration-only turn (a rendered mirror line, zero tools/reply/text) is NOT hollow', () => {
    // The blocker this fix closes: a turn that surfaced a `showNarrativeStep`
    // ("Doing the work now") but did no labeled tool work, never replied, and
    // emitted no captured/reply text pushes a line into `mirrorLines`. That is
    // real content the user saw in the card — the card must be KEPT, not deleted.
    // This is the exact scenario the pre-existing edit-flood-fuse pin
    // (activity-drain-fuse-drop-not-failure.test.ts "a terminal card render is
    // never shed") protects.
    expect(
      isHollowGhostCardOutcome({ ...base, mirrorLines: ['Doing the work now'] }),
    ).toBe(false)
  })

  it('whitespace-only mirror lines do NOT rescue the card — still hollow', () => {
    // Symmetric with the capturedText/lastReplyText blank guards: a mirrorLines
    // array of only blank strings surfaced nothing visible, so it stays hollow.
    expect(isHollowGhostCardOutcome({ ...base, mirrorLines: ['   ', '\n'] })).toBe(true)
  })

  it('whitespace-only captured / reply text still counts as hollow', () => {
    expect(isHollowGhostCardOutcome({ ...base, capturedText: ['   ', '\n'] })).toBe(true)
    expect(isHollowGhostCardOutcome({ ...base, lastReplyText: '   ' })).toBe(true)
  })

  it('a delivered final answer keeps the card — never hollow', () => {
    expect(isHollowGhostCardOutcome({ ...base, finalAnswerEverDelivered: true })).toBe(false)
  })

  it('any surfaced tool work keeps the card — the ✓ N steps body is real', () => {
    expect(isHollowGhostCardOutcome({ ...base, labeledToolCount: 1 })).toBe(false)
  })

  it('a reply-called turn is never hollow (sentinel gate owns dropped sentinels)', () => {
    expect(isHollowGhostCardOutcome({ ...base, replyCalled: true })).toBe(false)
  })

  it('captured terminal text keeps the card (not hollow)', () => {
    expect(
      isHollowGhostCardOutcome({ ...base, capturedText: ['Here is the answer.'] }),
    ).toBe(false)
  })

  it('non-blank last reply text keeps the card (not hollow)', () => {
    expect(
      isHollowGhostCardOutcome({ ...base, lastReplyText: 'The three services are green.' }),
    ).toBe(false)
  })
})
