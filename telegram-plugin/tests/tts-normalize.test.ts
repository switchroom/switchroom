/**
 * Tests for tts-normalize.ts — deterministic L1 TTS normalization
 * (issue #2760, Phase 1). Bun test (this dir uses bun test, not vitest).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { normalizeForTts, ttsNormalizeEnabled } from '../tts-normalize.js'
import { normalizeForSpeech } from '../voice-normalize-text.js'

const KILL = 'SWITCHROOM_DISABLE_TTS_NORMALIZE'

let savedKill: string | undefined

beforeEach(() => {
  savedKill = process.env[KILL]
  delete process.env[KILL]
})

afterEach(() => {
  if (savedKill === undefined) delete process.env[KILL]
  else process.env[KILL] = savedKill
})

describe('gating', () => {
  test('ON by default — normalizes with no env vars set', () => {
    expect(ttsNormalizeEnabled()).toBe(true)
    expect(normalizeForTts('**bold** $5.20')).toBe('bold five dollars twenty')
  })

  test('kill switch → byte-identical pass-through', () => {
    process.env[KILL] = '1'
    const input = '**bold** and $5.20 🚀 https://github.com/x'
    expect(normalizeForTts(input)).toBe(input)
    expect(ttsNormalizeEnabled()).toBe(false)
  })

  test('kill switch accepts "true"', () => {
    process.env[KILL] = 'true'
    expect(ttsNormalizeEnabled()).toBe(false)
  })

  test('empty input stays empty', () => {
    expect(normalizeForTts('')).toBe('')
  })
})

describe('markdown', () => {
  test('bold/italic/strike markers removed', () => {
    expect(normalizeForTts('**bold** and *italic* and ~~gone~~')).toBe(
      'bold and italic and gone',
    )
  })

  test('headings become plain text', () => {
    expect(normalizeForTts('## Status report\nAll good')).toBe(
      'Status report All good',
    )
  })

  test('links become link text', () => {
    expect(normalizeForTts('see [the docs](https://example.com/a/b) now')).toBe(
      'see the docs now',
    )
  })

  test('list markers dropped', () => {
    expect(normalizeForTts('- first\n- second')).toBe('first second')
  })

  test('blockquote markers dropped', () => {
    expect(normalizeForTts('> quoted line')).toBe('quoted line')
  })

  test('code fences become spoken placeholder', () => {
    const out = normalizeForTts('before\n```ts\nconst x = 1\n```\nafter')
    expect(out).toContain('code block omitted')
    expect(out).not.toContain('const x')
  })

  test('inline code read as-is without backticks, content untouched', () => {
    expect(normalizeForTts('run `deploy_5km_run` now')).toBe(
      'run deploy_5km_run now',
    )
  })

  test('unterminated fence swallows to end-of-input (deliberate)', () => {
    // An opening ``` with no close drops everything after it — reading
    // half a code block aloud is worse than omitting it. Pinned as the
    // intended trade-off.
    const out = normalizeForTts('before\n```ts\nconst secret = 1\nmore code')
    expect(out).toBe('before code block omitted.')
  })

  test('tables summarized as table omitted', () => {
    const out = normalizeForTts('| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(out).toContain('table omitted')
    expect(out).not.toContain('|')
  })
})

describe('numbers', () => {
  test('currency $5.20 → five dollars twenty', () => {
    expect(normalizeForTts('that costs $5.20 today')).toBe(
      'that costs five dollars twenty today',
    )
  })

  test('whole-dollar and singular', () => {
    expect(normalizeForTts('$1 fee')).toBe('one dollar fee')
    expect(normalizeForTts('$300 total')).toBe('three hundred dollars total')
  })

  test('percent 12% → twelve percent', () => {
    expect(normalizeForTts('up 12% overnight')).toBe('up twelve percent overnight')
  })

  test('ordinal 3rd → third', () => {
    expect(normalizeForTts('the 3rd item and the 21st day')).toBe(
      'the third item and the twenty-first day',
    )
  })

  test('time 14:30 spoken', () => {
    expect(normalizeForTts('meet at 14:30 sharp')).toBe(
      'meet at fourteen thirty sharp',
    )
  })

  test('ISO date spoken', () => {
    expect(normalizeForTts('due 2026-07-04 ok')).toBe(
      'due July fourth two thousand twenty-six ok',
    )
  })

  test('phone-like digit run read as digits', () => {
    expect(normalizeForTts('call 0412 345 678 now')).toBe(
      'call zero four one two three four five six seven eight now',
    )
  })

  test('international +-prefixed number read as digits', () => {
    expect(normalizeForTts('call +61 412 345 678')).toBe(
      'call plus six one four one two three four five six seven eight',
    )
  })

  test('ordinary space-separated numbers stay untouched', () => {
    expect(normalizeForTts('scores were 1024 2048 4096 today')).toBe(
      'scores were 1024 2048 4096 today',
    )
  })

  test('short digit groups without phone prefix stay untouched', () => {
    // The unit pass may expand a trailing unit, but the digit groups
    // themselves must never be read digit-by-digit.
    const out = normalizeForTts('12 34 56 78 items')
    expect(out).toBe('12 34 56 78 items')
  })

  test('currency with thousands separator: $1,000 → one thousand dollars', () => {
    expect(normalizeForTts('paid $1,000 up front')).toBe(
      'paid one thousand dollars up front',
    )
    expect(normalizeForTts('$12,345.67 total')).toBe(
      'twelve thousand three hundred forty-five dollars sixty-seven total',
    )
  })

  test('odd cents ($5.203) left unchanged rather than half-read', () => {
    expect(normalizeForTts('value $5.203 today')).toBe('value $5.203 today')
  })

  test('HH:MM:SS left unchanged (no dangling seconds)', () => {
    expect(normalizeForTts('at 12:34:56 sharp')).toBe('at 12:34:56 sharp')
  })

  test('units expand: 5km, 10GB, 500ms', () => {
    expect(normalizeForTts('ran 5km')).toBe('ran five kilometres')
    expect(normalizeForTts('used 10GB')).toBe('used ten gigabytes')
    expect(normalizeForTts('took 500ms')).toBe('took five hundred milliseconds')
  })

  test('identifiers with digits are never touched', () => {
    expect(normalizeForTts('rename class5 and my5thing')).toBe(
      'rename class5 and my5thing',
    )
  })

  // Regression: unit-suffix lookbehind + case sensitivity (prod corpus,
  // ~250/1679 samples). A decimal seconds value like "0.17s" was matched by
  // \b re-anchoring between the "." and the following digits, so "17s" alone
  // got read as "seventeen seconds" and split the decimal apart; and the /i
  // flag let a bare capital "M" (money shorthand, "$5M") match the "m"
  // (metre/minute) unit alternative.
  test('decimal seconds survive intact — no mid-decimal unit match', () => {
    expect(normalizeForTts('latency was 0.17s')).toBe('latency was 0.17s')
    expect(normalizeForTts('took 1.5s to load')).toBe('took 1.5s to load')
    expect(normalizeForTts('waited 2.25s')).toBe('waited 2.25s')
    expect(normalizeForTts('under 0.9s')).toBe('under 0.9s')
  })

  test('whole-number seconds still expand: 90s → ninety seconds', () => {
    expect(normalizeForTts('done in 90s')).toBe('done in ninety seconds')
  })

  test('units unaffected by the case-sensitivity fix: 500ms, 5MB, 2GB, 16 m', () => {
    expect(normalizeForTts('took 500ms')).toBe('took five hundred milliseconds')
    expect(normalizeForTts('file is 5MB')).toBe('file is five megabytes')
    expect(normalizeForTts('disk has 2GB')).toBe('disk has two gigabytes')
    expect(normalizeForTts('ran 16 m')).toBe('ran sixteen metres')
  })

  test('bare capital M never reads as minutes/metres (money shorthand, corpus)', () => {
    expect(normalizeForTts('Revenue was 5M this year')).toBe(
      'Revenue was 5M this year',
    )
    expect(normalizeForTts('raised $5M in the round')).not.toContain('minutes')
    expect(normalizeForTts('raised $5M in the round')).not.toContain('metres')
  })

  test('HTTP-status-shaped input adjacent to a capital letter is not read as a duration', () => {
    expect(normalizeForTts('a 503M error occurred')).toBe(
      'a 503M error occurred',
    )
    expect(normalizeForTts('status 503M')).toBe('status 503M')
  })
})

describe('URLs', () => {
  test('bare URL → spoken domain', () => {
    expect(normalizeForTts('see https://github.com/switchroom/switchroom for code')).toBe(
      'see github dot com link for code',
    )
  })

  test('www prefix dropped from spoken domain', () => {
    expect(normalizeForTts('at https://www.example.org/x')).toBe(
      'at example dot org link',
    )
  })

  test('IP-host URL degrades to a link', () => {
    expect(normalizeForTts('at http://127.0.0.1:8080/x ok')).toBe('at a link ok')
  })
})

describe('emoji', () => {
  test('common emoji spoken via map', () => {
    expect(normalizeForTts('great work 👍')).toBe('great work thumbs up')
  })

  test('other emoji stripped', () => {
    expect(normalizeForTts('launch 🚀 now 🎉')).toBe('launch now')
  })
})

describe('symbols', () => {
  test('& → and, @ → at, # → hash', () => {
    expect(normalizeForTts('cats & dogs')).toBe('cats and dogs')
    expect(normalizeForTts('ping @ken')).toBe('ping at ken')
    expect(normalizeForTts('see #general')).toBe('see hash general')
  })

  test('prose slash spoken', () => {
    expect(normalizeForTts('yes/no answer')).toBe('yes slash no answer')
  })

  test('~ before a number → about', () => {
    expect(normalizeForTts('~5 minutes left')).toBe('about 5 minutes left')
  })
})

describe('conservatism', () => {
  test('plain prose passes through unchanged', () => {
    const input = 'The build finished and everything looks good.'
    expect(normalizeForTts(input)).toBe(input)
  })

  test('deterministic: same input, same output', () => {
    const input = '## Hi\n**bold** $5.20 at 14:30 👍 https://github.com/a'
    expect(normalizeForTts(input)).toBe(normalizeForTts(input))
  })
})

describe('normalizeForTts — backslash escapes & HTML entities (last-line defence)', () => {
  test('strips a literal \\b so the engine never speaks "backslash b"', () => {
    const out = normalizeForTts('the regex \\b boundary')
    expect(out).toBe('the regex b boundary')
    expect(out).not.toContain('\\')
  })

  test('unescapes MarkdownV2 punctuation escapes (\\. \\! \\-)', () => {
    expect(normalizeForTts('done\\. next\\! wait\\-')).toBe('done. next! wait-')
  })

  test('decodes HTML entities (&amp; &lt; &#39;)', () => {
    expect(normalizeForTts('Tom &amp; Jerry')).toBe('Tom and Jerry')
    expect(normalizeForTts('5 &lt; 10')).toBe('5 < 10')
    expect(normalizeForTts("it&#39;s here")).toBe("it's here")
  })

  test('rich mixed reply → clean spoken text (no backslash/backtick/entity)', () => {
    const reply =
      '**Bold** and `code\\b` and a [label](https://example.com/x) ' +
      'with Tom &amp; Jerry and a regex \\b\\.'
    const out = normalizeForTts(reply)
    expect(out).not.toContain('\\')
    expect(out).not.toContain('`')
    expect(out).not.toContain('&amp;')
    expect(out).toContain('label')
    expect(out).toContain('Tom and Jerry')
  })

  test('kill switch still returns byte-identical input (escapes preserved)', () => {
    process.env[KILL] = '1'
    expect(normalizeForTts('a \\b &amp; b')).toBe('a \\b &amp; b')
    delete process.env[KILL]
  })

  test('idempotent after normalizeForSpeech already unescaped', () => {
    const reply = 'a \\b and Tom &amp; Jerry \\. end'
    const once = normalizeForTts(reply)
    expect(normalizeForTts(once)).toBe(once)
  })
})

describe('normalizeForTts — review findings (fixpoint decode, metachar, nits)', () => {
  test('L2 parity: immediate (speech+tts) and single-tts agree on a double-encoded entity', () => {
    const x = '&amp;amp;lt;'
    const immediate = normalizeForTts(normalizeForSpeech(x))
    const singleTts = normalizeForTts(x)
    expect(immediate).toBe('<')
    expect(singleTts).toBe('<')
    expect(immediate).toBe(singleTts)
    expect(normalizeForTts('&amp;amp;amp;')).toBe('&')
  })

  test('L1: entity → line-leading metachar keeps a spoken form (hash/asterisk)', () => {
    expect(normalizeForTts('&#35; Heading')).toBe('hash Heading')
    expect(normalizeForTts('2 &#42; 3')).toBe('2 asterisk 3')
  })

  test('nit: dangling trailing backslash dropped; &#92; decodes then strips', () => {
    expect(normalizeForTts('ends here\\')).toBe('ends here')
    expect(normalizeForTts('X&#92;Y')).toBe('XY')
    expect(normalizeForTts('X&#92;Y')).not.toContain('\\')
  })
})

describe('voice-out pipeline: normalizeForSpeech → normalizeForTts', () => {
  const speak = (s: string) => normalizeForTts(normalizeForSpeech(s))

  test('a mixed markdown list survives both passes as paced sentences', () => {
    expect(
      speak(
        '- Check /var/log/syslog\n' +
          '- Cost was $1,000\n' +
          '- Ran at 14:30:46\n' +
          '- Use HTTPS and/or SSH',
      ),
    ).toBe(
      'Check syslog. Cost was one thousand dollars. Ran at 14:30:46. ' +
        'Use H T T P S and slash or S S H.',
    )
  })

  test('the HH:MM:SS guard holds in both normalizers', () => {
    expect(normalizeForTts('Done at 14:30:46 today')).toBe('Done at 14:30:46 today')
    expect(normalizeForSpeech('Done at 14:30:46 today')).toBe(
      'Done at 14:30:46 today',
    )
  })

  // `14:30:46` survives even an unguarded scan because `30` is not a legal
  // HH — so on its own it certifies nothing. These are the timestamps whose
  // TAIL is itself a legal HH:MM, i.e. the ones a missing lookbehind
  // actually half-reads ("09:zero o'clock").
  test('an on-the-hour timestamp is not half-read (lookbehind guard)', () => {
    for (const t of ['09:00:00', '12:00:15', '01:02:03']) {
      expect(normalizeForTts(`ran at ${t} ok`)).toBe(`ran at ${t} ok`)
      expect(normalizeForSpeech(`ran at ${t} ok`)).toBe(`ran at ${t} ok`)
    }
  })

  test('thousands separators are spoken identically by both normalizers', () => {
    expect(normalizeForTts('It costs $1,000')).toBe('It costs one thousand dollars')
    expect(normalizeForSpeech('It costs $1,000')).toBe(
      'It costs one thousand dollars',
    )
  })
})
