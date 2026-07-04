/**
 * Tests for tts-normalize.ts — deterministic L1 TTS normalization
 * (issue #2760, Phase 1). Bun test (this dir uses bun test, not vitest).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { normalizeForTts, ttsNormalizeEnabled } from '../tts-normalize.js'

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
