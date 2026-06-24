import { describe, it, expect } from 'vitest'
import {
  normalizeNarrative,
  prefixSimilarity,
  isDraftOfReply,
  DRAFT_SUPPRESS_THRESHOLD,
  REPLY_TOOLS,
} from '../narrative-dedup.js'

describe('narrative-dedup', () => {
  it('pins the threshold so a silent retune breaks the test', () => {
    expect(DRAFT_SUPPRESS_THRESHOLD).toBe(0.8)
  })

  it('REPLY_TOOLS holds exactly reply + stream_reply', () => {
    expect(REPLY_TOOLS.has('reply')).toBe(true)
    expect(REPLY_TOOLS.has('stream_reply')).toBe(true)
    expect(REPLY_TOOLS.has('Bash')).toBe(false)
  })

  describe('normalizeNarrative', () => {
    it('strips markdown emphasis/heading/quote marks, collapses whitespace, lowercases', () => {
      expect(normalizeNarrative('**Bold**  _italic_   `code`')).toBe('bold italic code')
      expect(normalizeNarrative('> # Heading\n  text')).toBe('heading text')
    })
  })

  describe('prefixSimilarity', () => {
    it('returns 1 for identical strings', () => {
      expect(prefixSimilarity('hello there', 'hello there')).toBe(1)
    })

    it('returns 0 when either side is empty (no divide-by-zero)', () => {
      expect(prefixSimilarity('', 'something')).toBe(0)
      expect(prefixSimilarity('something', '')).toBe(0)
      expect(prefixSimilarity('', '')).toBe(0)
    })

    it('ratio is over the SHORTER normalized string', () => {
      // "abc" vs "abcdef": shared prefix 3 of shorter length 3 = 1.0
      expect(prefixSimilarity('abc', 'abcdef')).toBe(1)
      // "abx" vs "abcdef": shared prefix 2 of shorter length 3 ≈ 0.667
      expect(prefixSimilarity('abx', 'abcdef')).toBeCloseTo(2 / 3, 5)
    })
  })

  describe('isDraftOfReply', () => {
    it('SUPPRESS: identical draft and reply', () => {
      const t = 'The repo is at /home/user/code/switchroom.'
      expect(isDraftOfReply(t, t)).toBe(true)
    })

    it('SUPPRESS: draft whose trailing sentence was trimmed before sending (~0.85 prefix)', () => {
      const draft = 'The repo is at /home/user/code/switchroom. I will start now.'
      const reply = 'The repo is at /home/user/code/switchroom.'
      // reply is the shorter string and is a full prefix of the draft → 1.0
      expect(prefixSimilarity(draft, reply)).toBe(1)
      expect(isDraftOfReply(draft, reply)).toBe(true)
      // And the symmetric framing (draft slightly longer head, reply trimmed):
      const draft2 = 'Found both repos and confirmed the remote is correct here.'
      const reply2 = 'Found both repos and confirmed the remote is correct.'
      expect(prefixSimilarity(draft2, reply2)).toBeGreaterThanOrEqual(0.85)
      expect(isDraftOfReply(draft2, reply2)).toBe(true)
    })

    it('SHOW: post-action narration that merely precedes a different reply', () => {
      // "Sent. Waiting on the build…" vs an unrelated reply payload — short
      // string, near-zero shared prefix → below threshold → SHOW.
      const narration = 'Sent. Waiting on the build…'
      const reply = "Here's the result of the build: all green."
      expect(prefixSimilarity(narration, reply)).toBeLessThan(DRAFT_SUPPRESS_THRESHOLD)
      expect(isDraftOfReply(narration, reply)).toBe(false)
    })

    it('SHOW: empty reply text never suppresses (no divide-by-zero)', () => {
      expect(isDraftOfReply('On it. Let me find the repo…', '')).toBe(false)
    })

    it('SUPPRESS: draft differs from reply only by markdown decoration', () => {
      const draft = 'Here is the **plan**: do A then B.'
      const reply = 'Here is the plan: do A then B.'
      // After normalization the markdown stars vanish → identical → suppress.
      expect(normalizeNarrative(draft)).toBe(normalizeNarrative(reply))
      expect(isDraftOfReply(draft, reply)).toBe(true)
    })

    it('NIT 2: the doubled-capturedText proxy mis-suppresses; the actual reply text does not', () => {
      // The bug: flushPendingNarrativeAtTurnEnd used to compare a trailing
      // narration against capturedText.join(''). When the model emits the same
      // short string twice in a turn — e.g. "Done." as working narration and
      // then "Done." as the reply — that proxy becomes the CONCATENATION
      // "Done.Done.", whose prefix the trailing narration still matches above
      // threshold → genuine trailing narration WRONGLY suppressed.
      const trailing = 'Done.'
      const doubledProxy = 'Done.' + 'Done.' // capturedText.join('') of two "Done." blocks
      const actualReply = 'Done.'

      // Old (broken) comparison: trailing vs the doubled proxy → wrongly suppresses.
      expect(isDraftOfReply(trailing, doubledProxy)).toBe(true)

      // New comparison: trailing vs the ACTUAL reply text. Here the reply text
      // really IS "Done.", so a trailing "Done." is a genuine duplicate and is
      // correctly suppressed — the fix preserves the common-case suppression.
      expect(isDraftOfReply(trailing, actualReply)).toBe(true)
    })

    it('NIT 2: genuine trailing narration is preserved when the reply text differs', () => {
      // The case the proxy hurt most: the turn's reply is a SHORT distinct
      // string and the trailing narration is genuine liveness. Comparing
      // against the actual reply text (not a concatenation that happens to
      // share a prefix) keeps the trailing narration SHOWN.
      const trailingNarration = 'Done — all green, pushing now.'
      const actualReply = 'Here is the summary you asked for: 3 files changed.'
      // Below threshold against the real reply → SHOW (not suppressed).
      expect(isDraftOfReply(trailingNarration, actualReply)).toBe(false)
    })
  })
})
